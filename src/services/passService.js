'use strict';
const db = require('./../db');
const config = require('./../config');
const { evaluateQuota } = require('./quota');
const barcode = require('./../crypto/barcode');

function normalizePlate(plate) {
  return String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function audit(client, { passId, action, actorId, detail }) {
  await client.query(
    `INSERT INTO pass_audit_log (pass_id, action, actor_id, detail)
     VALUES ($1, $2, $3, $4)`,
    [passId || null, action, actorId || null, detail || {}]
  );
}

/**
 * Issue a visitor pass, enforcing the annual quota atomically.
 *
 * @param {object} opts
 * @param {string} opts.unitNumber
 * @param {string} opts.visitorPlate
 * @param {string} [opts.visitorName]
 * @param {number} [opts.durationHours]
 * @param {object} opts.issuer            - { id, role, name }
 * @param {boolean} [opts.override]       - request to bypass quota (management only)
 * @param {string}  [opts.overrideReason]
 *
 * @throws Error with .code: 'unit_not_found' | 'quota_exceeded' |
 *         'override_not_authorized'
 * @returns full pass row + signed barcode token.
 */
async function issuePass(opts) {
  const plate = normalizePlate(opts.visitorPlate);
  if (!plate) {
    const e = new Error('A visitor licence plate is required.');
    e.code = 'invalid_plate';
    throw e;
  }
  const durationHours = opts.durationHours || config.defaultPassDurationHours;

  return db.withTransaction(async (client) => {
    const unitRes = await client.query(
      `SELECT id, unit_number FROM units WHERE unit_number = $1`,
      [opts.unitNumber]
    );
    if (unitRes.rowCount === 0) {
      const e = new Error(`Unit ${opts.unitNumber} does not exist.`);
      e.code = 'unit_not_found';
      throw e;
    }
    const unit = unitRes.rows[0];

    const now = new Date();
    const year = now.getUTCFullYear();
    const quota = await evaluateQuota(client, unit.id, year);

    let usedOverride = false;
    if (quota.atLimit) {
      // Only Management may override, and only with an explicit request+reason.
      if (!opts.override) {
        await audit(client, {
          action: 'denied',
          actorId: opts.issuer.id,
          detail: { unit: unit.unit_number, year, ...quota, reason: 'quota_exceeded' },
        });
        const e = new Error(
          `Unit ${unit.unit_number} has reached its ${quota.limit}-pass limit for ${year}.`
        );
        e.code = 'quota_exceeded';
        e.quota = quota;
        throw e;
      }
      if (opts.issuer.role !== 'management') {
        const e = new Error('Only Management may override the annual pass quota.');
        e.code = 'override_not_authorized';
        throw e;
      }
      if (!opts.overrideReason || !opts.overrideReason.trim()) {
        const e = new Error('An override reason is required.');
        e.code = 'override_reason_required';
        throw e;
      }
      // Record a one-pass override grant so the ceiling and audit stay in sync.
      await client.query(
        `INSERT INTO override_grants (unit_id, calendar_year, extra_passes, reason, granted_by)
         VALUES ($1, $2, 1, $3, $4)`,
        [unit.id, year, opts.overrideReason.trim(), opts.issuer.id]
      );
      usedOverride = true;
    }

    const expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000);

    // Insert the pass first (without signature) to obtain the server-generated
    // pass id, then sign a token that binds that id, unit, plate and expiry.
    const insertRes = await client.query(
      `INSERT INTO visitor_passes
         (unit_id, visitor_plate, visitor_name, issued_by, issued_at,
          expires_at, calendar_year, status, was_override, barcode_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,'')
       RETURNING *`,
      [unit.id, plate, opts.visitorName || null, opts.issuer.id, now,
       expiresAt, year, usedOverride]
    );
    const pass = insertRes.rows[0];

    const token = barcode.signPass({
      passId: pass.id,
      unitNumber: unit.unit_number,
      visitorPlate: plate,
      issuedAt: pass.issued_at,
      expiresAt: pass.expires_at,
    });

    await client.query(
      `UPDATE visitor_passes SET barcode_sig = $1 WHERE id = $2`,
      [barcode.signatureHex(token), pass.id]
    );

    await audit(client, {
      passId: pass.id,
      action: usedOverride ? 'override_used' : 'issued',
      actorId: opts.issuer.id,
      detail: { unit: unit.unit_number, plate, year, override: usedOverride },
    });

    return {
      pass: { ...pass, unit_number: unit.unit_number },
      token,
      quota,
      usedOverride,
    };
  });
}

/**
 * Verify a scanned/typed barcode token against both cryptographic signature
 * AND live database state (expiry + revocation).
 *
 * @returns a rich verdict object suitable for the Security verification screen.
 */
async function verifyPass(token, actorId) {
  const crypto = barcode.verifyToken(token);
  if (!crypto.valid) {
    await db.query(
      `INSERT INTO pass_audit_log (action, actor_id, detail) VALUES ($1,$2,$3)`,
      ['verified', actorId || null, { result: crypto.reason }]
    );
    return {
      verdict: crypto.reason === 'forged' ? 'FORGED' : 'INVALID',
      authentic: false,
      reason: crypto.reason,
    };
  }

  // Signature authentic — reconcile with the database of record.
  const res = await db.query(
    `SELECT vp.*, u.unit_number
       FROM visitor_passes vp JOIN units u ON u.id = vp.unit_id
      WHERE vp.id = $1`,
    [crypto.payload.pid]
  );

  if (res.rowCount === 0) {
    // Authentic signature but no such pass — treat as forged/stale.
    return { verdict: 'FORGED', authentic: true, reason: 'unknown_pass' };
  }
  const pass = res.rows[0];
  const now = Date.now();

  let verdict;
  if (pass.status === 'revoked') verdict = 'REVOKED';
  else if (now > new Date(pass.expires_at).getTime()) verdict = 'EXPIRED';
  else verdict = 'VALID';

  await db.query(
    `INSERT INTO pass_audit_log (pass_id, action, actor_id, detail)
     VALUES ($1,'verified',$2,$3)`,
    [pass.id, actorId || null, { verdict }]
  );

  return {
    verdict,
    authentic: true,
    pass: {
      id: pass.id,
      unit_number: pass.unit_number,
      visitor_plate: pass.visitor_plate,
      visitor_name: pass.visitor_name,
      issued_at: pass.issued_at,
      expires_at: pass.expires_at,
      status: pass.status,
    },
  };
}

/**
 * Revoke an active pass (Security or Management).
 */
async function revokePass(passId, actorId) {
  return db.withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE visitor_passes
          SET status = 'revoked', revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND status <> 'revoked'
        RETURNING *`,
      [passId, actorId]
    );
    if (res.rowCount === 0) {
      const e = new Error('Pass not found or already revoked.');
      e.code = 'not_revokable';
      throw e;
    }
    await audit(client, { passId, action: 'revoked', actorId, detail: {} });
    return res.rows[0];
  });
}

module.exports = { issuePass, verifyPass, revokePass, normalizePlate };
