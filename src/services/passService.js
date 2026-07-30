'use strict';
const db = require('./../db');
const config = require('./../config');
const { evaluateQuota } = require('./quota');
const barcode = require('./../crypto/barcode');
const regions = require('./../regions');

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
 * Compute a pass expiry from a preset button (or explicit hours).
 *   'today'        -> end of the current local day (23:59:59)
 *   'tomorrow_noon'-> 12:00 local the following day
 * Falls back to durationHours, then the configured default.
 */
function computeExpiry(now, preset, durationHours) {
  if (preset === 'today') {
    const d = new Date(now);
    d.setHours(23, 59, 59, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // safety near midnight
    return d;
  }
  if (preset === 'tomorrow_noon') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  const hours = durationHours || config.defaultPassDurationHours;
  return new Date(now.getTime() + hours * 3600 * 1000);
}

/**
 * Issue a visitor pass, enforcing the annual quota atomically.
 *
 * @param {object} opts
 * @param {string} opts.unitNumber
 * @param {string} opts.visitorPlate
 * @param {string} [opts.visitorFirstName]
 * @param {string} [opts.visitorLastName]
 * @param {string} [opts.visitorCountry]   - 'CA' | 'US'
 * @param {string} [opts.visitorRegion]    - province/state code, e.g. 'ON'
 * @param {string} [opts.durationPreset]   - 'today' | 'tomorrow_noon'
 * @param {number} [opts.durationHours]
 * @param {object} opts.issuer             - { id, role, name }
 * @param {boolean} [opts.override]        - request to bypass quota
 * @param {string}  [opts.overrideCode]    - current weekly override code
 * @param {string}  [opts.overrideReason]
 *
 * @throws Error with .code: 'unit_not_found' | 'quota_exceeded' |
 *         'override_code_invalid' | 'override_reason_required' |
 *         'invalid_plate' | 'invalid_region'
 * @returns full pass row + signed barcode token + short code.
 */
async function issuePass(opts) {
  const plate = normalizePlate(opts.visitorPlate);
  if (!plate) {
    const e = new Error('A visitor licence plate is required.');
    e.code = 'invalid_plate';
    throw e;
  }
  const country = String(opts.visitorCountry || '').toUpperCase();
  const region = String(opts.visitorRegion || '').toUpperCase();
  if (region && !regions.isValidRegion(country, region)) {
    const e = new Error('Unknown province/state for the selected country.');
    e.code = 'invalid_region';
    throw e;
  }

  return db.withTransaction(async (client) => {
    const unitRes = await client.query(
      `SELECT id, unit_number, kind FROM units WHERE unit_number = $1`,
      [opts.unitNumber]
    );
    if (unitRes.rowCount === 0) {
      // Referential guard: passes can only be issued against known units, so a
      // made-up unit number can't be used to sneak past a real unit's quota.
      const e = new Error(`Unit ${opts.unitNumber} is not in the building registry.`);
      e.code = 'unit_not_found';
      throw e;
    }
    const unit = unitRes.rows[0];

    const now = new Date();
    const year = now.getFullYear();
    const quota = await evaluateQuota(client, unit.id, year);

    let usedOverride = false;
    if (quota.atLimit) {
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
      // Override is now gated by the rotating weekly code (not a role), so it
      // can't be abused: the desk must obtain the current code from Management/
      // Board. We still record who used it and require a reason.
      if (!barcode.verifyOverrideCode(opts.overrideCode)) {
        await audit(client, {
          action: 'denied',
          actorId: opts.issuer.id,
          detail: { unit: unit.unit_number, year, reason: 'override_code_invalid' },
        });
        const e = new Error('The override code is missing or not valid for this week.');
        e.code = 'override_code_invalid';
        throw e;
      }
      if (!opts.overrideReason || !opts.overrideReason.trim()) {
        const e = new Error('An override reason is required.');
        e.code = 'override_reason_required';
        throw e;
      }
      await client.query(
        `INSERT INTO override_grants (unit_id, calendar_year, extra_passes, reason, granted_by)
         VALUES ($1, $2, 1, $3, $4)`,
        [unit.id, year, opts.overrideReason.trim(), opts.issuer.id]
      );
      usedOverride = true;
    }

    const expiresAt = computeExpiry(now, opts.durationPreset, opts.durationHours);

    const first = (opts.visitorFirstName || '').trim();
    const last = (opts.visitorLastName || '').trim();
    const fullName = [first, last].filter(Boolean).join(' ') || null;
    const regionStored = region ? `${country}-${region}` : null;

    // Insert first to obtain the server-generated id, then derive the signed
    // token and short code that bind to it, and persist them.
    const insertRes = await client.query(
      `INSERT INTO visitor_passes
         (unit_id, visitor_plate, visitor_name, visitor_first_name, visitor_last_name,
          visitor_region, issued_by, issued_at, expires_at, calendar_year,
          status, was_override, barcode_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,'')
       RETURNING *`,
      [unit.id, plate, fullName, first || null, last || null, regionStored,
       opts.issuer.id, now, expiresAt, year, usedOverride]
    );
    const pass = insertRes.rows[0];

    const token = barcode.signPass({
      passId: pass.id,
      unitNumber: unit.unit_number,
      visitorPlate: plate,
      issuedAt: pass.issued_at,
      expiresAt: pass.expires_at,
    });
    const shortCode = barcode.shortCodeForPass(pass.id);

    await client.query(
      `UPDATE visitor_passes SET barcode_sig = $1, short_code = $2 WHERE id = $3`,
      [barcode.signatureHex(token), shortCode, pass.id]
    );

    await audit(client, {
      passId: pass.id,
      action: usedOverride ? 'override_used' : 'issued',
      actorId: opts.issuer.id,
      detail: { unit: unit.unit_number, kind: unit.kind, plate, year, override: usedOverride },
    });

    return {
      pass: { ...pass, unit_number: unit.unit_number, kind: unit.kind, short_code: shortCode },
      token,
      shortCode,
      quota,
      usedOverride,
    };
  });
}

// Shared post-crypto reconciliation used by both token and short-code verify.
async function reconcilePass(row, actorId, actorDetail) {
  const now = Date.now();
  let verdict;
  if (row.status === 'revoked') verdict = 'REVOKED';
  else if (now > new Date(row.expires_at).getTime()) verdict = 'EXPIRED';
  else verdict = 'VALID';

  await db.query(
    `INSERT INTO pass_audit_log (pass_id, action, actor_id, detail)
     VALUES ($1,'verified',$2,$3)`,
    [row.id, actorId || null, { verdict, ...actorDetail }]
  );

  return {
    verdict,
    authentic: true,
    pass: {
      id: row.id,
      unit_number: row.unit_number,
      kind: row.kind,
      visitor_plate: row.visitor_plate,
      visitor_name: row.visitor_name,
      visitor_region: row.visitor_region,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      status: row.status,
    },
  };
}

/**
 * Verify a scanned/typed barcode token against signature AND live DB state.
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
  const res = await db.query(
    `SELECT vp.*, u.unit_number, u.kind
       FROM visitor_passes vp JOIN units u ON u.id = vp.unit_id
      WHERE vp.id = $1`,
    [crypto.payload.pid]
  );
  if (res.rowCount === 0) return { verdict: 'FORGED', authentic: true, reason: 'unknown_pass' };
  return reconcilePass(res.rows[0], actorId, { via: 'qr' });
}

/**
 * Verify by the short human-typed code printed on the pass. The code maps to a
 * pass; the pass's real status is authoritative and always re-checked.
 */
async function verifyByShortCode(input, actorId) {
  const code = barcode.normalizeShortCode(input);
  if (!code) return { verdict: 'INVALID', authentic: false, reason: 'malformed' };
  // Stored form includes a dash; compare on the normalized (dashless) value.
  const res = await db.query(
    `SELECT vp.*, u.unit_number, u.kind
       FROM visitor_passes vp JOIN units u ON u.id = vp.unit_id
      WHERE replace(vp.short_code, '-', '') = $1`,
    [code]
  );
  if (res.rowCount === 0) {
    await db.query(
      `INSERT INTO pass_audit_log (action, actor_id, detail) VALUES ($1,$2,$3)`,
      ['verified', actorId || null, { result: 'unknown_short_code', via: 'short_code' }]
    );
    return { verdict: 'INVALID', authentic: false, reason: 'unknown_short_code' };
  }
  return reconcilePass(res.rows[0], actorId, { via: 'short_code' });
}

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

module.exports = {
  issuePass, verifyPass, verifyByShortCode, revokePass, normalizePlate, computeExpiry,
};
