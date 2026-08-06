'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('./../db');
const { requireAuth, requireRole } = require('./../auth/middleware');
const passService = require('./../services/passService');
const { renderPassSheet } = require('./../services/printTemplate');
const { saveUnitOwner } = require('./../services/unitOwner');
const passEmail = require('./../services/passEmail');
const config = require('./../config');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Multi-criteria lookup (Security + Management).
//    by = plate | unit | name | phone
//  Returns matching registered resident vehicles AND visitor passes.
// ---------------------------------------------------------------------------
router.get('/lookup', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const by = String(req.query.by || 'plate').toLowerCase();
  const raw = String(req.query.q || req.query.plate || '').trim();
  if (!raw) return res.status(400).json({ error: 'query_required' });

  let regWhere, regParam, passWhere, passParam;
  switch (by) {
    case 'unit':
      regWhere = `u.unit_number ILIKE $1`;
      passWhere = `u.unit_number ILIKE $1`;
      regParam = passParam = raw + '%';
      break;
    case 'name':
      // Resident name for registered vehicles; visitor name for passes.
      regWhere = `r.full_name ILIKE $1`;
      passWhere = `vp.visitor_name ILIKE $1`;
      regParam = passParam = '%' + raw + '%';
      break;
    case 'phone': {
      const digits = raw.replace(/\D/g, '');
      regWhere = `regexp_replace(coalesce(r.phone,''), '\\D', '', 'g') LIKE $1`;
      passWhere = `FALSE`; // passes have no phone
      regParam = '%' + digits + '%';
      passParam = null;
      break;
    }
    case 'plate':
    default: {
      const plate = passService.normalizePlate(raw);
      regWhere = `rv.licence_plate = $1`;
      passWhere = `vp.visitor_plate = $1`;
      regParam = passParam = plate;
      break;
    }
  }

  const registered = await db.query(
    `SELECT rv.licence_plate, rv.make, rv.model, rv.color, rv.province,
            u.unit_number, u.kind, u.business_name, r.full_name AS resident_name, r.phone
       FROM registered_vehicles rv
       JOIN units u ON u.id = rv.unit_id
       LEFT JOIN residents r ON r.id = rv.resident_id
      WHERE ${regWhere}
      ORDER BY u.unit_number
      LIMIT 25`,
    [regParam]
  );

  let passes = { rows: [] };
  if (passWhere !== 'FALSE') {
    passes = await db.query(
      `SELECT vp.id, vp.visitor_plate, vp.visitor_name, vp.visitor_region, vp.status,
              vp.issued_at, vp.expires_at, vp.short_code, u.unit_number, u.kind, u.business_name
         FROM visitor_passes vp
         JOIN units u ON u.id = vp.unit_id
        WHERE ${passWhere}
        ORDER BY vp.issued_at DESC
        LIMIT 25`,
      [passParam]
    );
  }

  res.json({
    by,
    query: raw,
    registeredVehicles: registered.rows,
    visitorPasses: passes.rows,
  });
});

// ---------------------------------------------------------------------------
//  Issue a visitor pass (Security + Management). A quota override requires the
//  current weekly override code (distributed to Management/Board).
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const {
    unitNumber, visitorPlate, visitorFirstName, visitorLastName,
    visitorCountry, visitorRegion, durationPreset, durationHours, startsAt,
    override, overrideCode, overrideReason, spotOverride,
    ownerName, ownerPhone, ownerEmail, visitorEmail, printInstead,
  } = req.body || {};
  if (!unitNumber || !visitorPlate) {
    return res.status(400).json({ error: 'unit_and_plate_required' });
  }
  const wantEmail = String(visitorEmail || '').trim();
  const willPrint = Boolean(printInstead);
  // TAG_MODE: the issued pass is emailed on submit, so a visitor email is
  // required — unless the officer chose to print the copy instead (visitor has
  // no email). Enforced before issuing so we don't claim a tag on a bad request.
  if (config.tagMode && !willPrint && !passEmail.looksLikeEmail(wantEmail)) {
    return res.status(400).json({ error: 'visitor_email_required' });
  }
  try {
    const result = await passService.issuePass({
      unitNumber,
      visitorPlate,
      visitorFirstName,
      visitorLastName,
      visitorCountry,
      visitorRegion,
      durationPreset,
      durationHours: durationHours ? parseInt(durationHours, 10) : undefined,
      startsAt: startsAt || undefined,
      issuer: req.user,
      override: Boolean(override),
      overrideCode,
      overrideReason,
      spotOverride: Boolean(spotOverride),
      visitorEmail: wantEmail || undefined,
    });
    // Capture/refresh the unit owner's contact if the officer entered any.
    await saveUnitOwner({ unitNumber: result.pass.unit_number },
      { name: ownerName, phone: ownerPhone, email: ownerEmail });

    // TAG_MODE: auto-email the printable pass to the visitor + the unit owner on
    // file. Best-effort — never blocks issuance; inert until SMTP is configured.
    let emailDelivery = null;
    if (config.tagMode && !willPrint) {
      let ownerOnFile = null;
      try {
        const ur = await db.query(`SELECT owner_email FROM units WHERE unit_number = $1`,
          [result.pass.unit_number]);
        if (ur.rowCount) ownerOnFile = ur.rows[0].owner_email;
      } catch { /* non-fatal */ }
      emailDelivery = await passEmail.emailPass(
        { ...result.pass, issuer_name: req.user.name, issuer_role: req.user.role },
        [wantEmail, ownerOnFile],
        { issuerName: req.user.name, issuerRole: req.user.role }
      );
    }

    res.status(201).json({
      passId: result.pass.id,
      unitNumber: result.pass.unit_number,
      kind: result.pass.kind,
      visitorPlate: result.pass.visitor_plate,
      visitorName: result.pass.visitor_name,
      shortCode: result.shortCode,
      token: result.token,
      issuedAt: result.pass.issued_at,
      startsAt: result.pass.starts_at,
      expiresAt: result.pass.expires_at,
      usedOverride: result.usedOverride,
      usedSpotOverride: result.usedSpotOverride,
      quota: result.quota,
      spots: result.spots,
      tagNumber: result.tagNumber,
      printUrl: `/api/passes/${result.pass.id}/print`,
      visitorEmail: wantEmail || null,
      printInstead: willPrint,
      emailDelivery,
    });
  } catch (err) {
    const codeMap = {
      unit_not_found: 404,
      quota_exceeded: 409,
      spot_full: 409,
      unit_active_limit: 409,
      no_tags_available: 409,
      override_code_invalid: 403,
      override_reason_required: 400,
      invalid_plate: 400,
      invalid_region: 400,
      invalid_start: 400,
    };
    if (codeMap[err.code]) {
      return res.status(codeMap[err.code]).json({ error: err.code, message: err.message, quota: err.quota, spots: err.spots, activeLimit: err.activeLimit });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
//  Print-ready 8.5 x 11 pass sheet (HTML with embedded QR)
// ---------------------------------------------------------------------------
router.get('/:id/print', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const result = await db.query(
    `SELECT vp.*, u.unit_number, usr.full_name AS issuer_name, usr.role AS issuer_role
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
       JOIN users usr ON usr.id = vp.issued_by
      WHERE vp.id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).send('Pass not found');
  const pass = result.rows[0];

  // Re-sign deterministically from stored fields to embed the token in the QR.
  const barcode = require('./../crypto/barcode');
  const token = barcode.signPass({
    passId: pass.id,
    unitNumber: pass.unit_number,
    visitorPlate: pass.visitor_plate,
    issuedAt: pass.issued_at,
    expiresAt: pass.expires_at,
  });
  const qrDataUrl = await QRCode.toDataURL(token, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });
  const shortCode = pass.short_code || barcode.shortCodeForPass(pass.id);

  res.type('html').send(renderPassSheet({ pass, token, qrDataUrl, shortCode }));
});

// Fetch a pass with the fields needed to (re)build its token/short code/PDF.
async function loadPassForDelivery(id) {
  const r = await db.query(
    `SELECT vp.*, u.unit_number, usr.full_name AS issuer_name, usr.role AS issuer_role
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
       JOIN users usr ON usr.id = vp.issued_by
      WHERE vp.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
//  Email the printable pass (PDF) to a visitor / unit owner.
// ---------------------------------------------------------------------------
router.post('/:id/email', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'email_required' });
  const mailer = require('./../services/mailer');
  if (!mailer.isConfigured()) return res.status(409).json({ error: 'email_not_configured' });
  const pass = await loadPassForDelivery(req.params.id);
  if (!pass) return res.status(404).json({ error: 'pass_not_found' });

  const result = await passEmail.emailPass(pass, [to],
    { issuerName: pass.issuer_name, issuerRole: pass.issuer_role });
  if (!result.recipients.length) return res.status(400).json({ error: 'email_required' });
  if (!result.sent.length) return res.status(502).json({ error: 'email_send_failed' });
  res.json({ ok: true, emailed: result.sent[0] });
});

// ---------------------------------------------------------------------------
//  Text (SMS) the visitor/owner a link to the printable pass.
// ---------------------------------------------------------------------------
router.post('/:id/text', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'phone_required' });
  const sms = require('./../services/smsSender');
  if (!sms.isConfigured()) return res.status(409).json({ error: 'sms_not_configured' });
  const pass = await loadPassForDelivery(req.params.id);
  if (!pass) return res.status(404).json({ error: 'pass_not_found' });
  const config = require('./../config');
  const link = `${config.oauthBaseUrl}/api/passes/${pass.id}/print`;
  const result = await sms.send({
    to,
    body: `Yorkdale visitor parking pass (unit ${pass.unit_number}, plate ${pass.visitor_plate}). `
      + `Show this at the gate: ${link}`,
  });
  if (!result.sent) return res.status(502).json({ error: 'sms_send_failed', message: result.error });
  res.json({ ok: true, texted: to });
});

// ---------------------------------------------------------------------------
//  Revoke a pass (Security + Management)
// ---------------------------------------------------------------------------
router.post('/:id/revoke', requireAuth, requireRole('security', 'management'), async (req, res) => {
  try {
    const pass = await passService.revokePass(req.params.id, req.user.id);
    res.json({ ok: true, passId: pass.id, status: pass.status });
  } catch (err) {
    if (err.code === 'not_revokable') return res.status(409).json({ error: err.code, message: err.message });
    throw err;
  }
});

// Vehicle vacated the spot — free it early for the next guest.
router.post('/:id/vacate', requireAuth, requireRole('security', 'management'), async (req, res) => {
  try {
    const pass = await passService.vacatePass(req.params.id, req.user.id);
    res.json({ ok: true, passId: pass.id, vacatedAt: pass.vacated_at });
  } catch (err) {
    if (err.code === 'not_vacatable') return res.status(409).json({ error: err.code, message: err.message });
    throw err;
  }
});

module.exports = router;
