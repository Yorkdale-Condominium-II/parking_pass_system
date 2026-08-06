'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const db = require('./../db');
const regions = require('./../regions');
const password = require('./../auth/password');
const passService = require('./../services/passService');
const barcode = require('./../crypto/barcode');
const { renderPassSheet } = require('./../services/printTemplate');
const { verifyDeskSession } = require('./../auth/middleware');

const router = express.Router();

// Current Google/Microsoft-started desk session, if any.
router.get('/session', (req, res) => {
  const s = verifyDeskSession(req.cookies?.desk_session || '');
  res.json(s ? { active: true, name: s.name, role: s.role, expiresAt: s.exp * 1000 } : { active: false });
});
router.post('/logout', (req, res) => { res.clearCookie('desk_session'); res.json({ ok: true }); });

// Public desk kiosk: no session. The operator picks an officer and enters that
// officer's password on each submission, which authenticates the issuance.
const deskLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// Officers available to issue at the desk (active security + management).
router.get('/officers', async (req, res) => {
  const r = await db.query(
    `SELECT username, first_name, last_name, full_name, role
       FROM users
      WHERE is_active = TRUE AND role IN ('security','management')
      ORDER BY full_name`
  );
  res.json(r.rows.map((u) => ({
    username: u.username,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.full_name,
    role: u.role,
  })));
});

// Province/state options and known units, so the desk form validates like the
// in-app one (public, non-sensitive).
router.get('/regions', (req, res) => res.json({ CA: regions.CA, US: regions.US }));
router.get('/units', async (req, res) => {
  const r = await db.query(`SELECT unit_number, kind, business_name FROM units ORDER BY kind, unit_number LIMIT 2000`);
  res.json(r.rows);
});

// Issue a pass after verifying the selected officer's password.
router.post('/issue', deskLimiter, async (req, res) => {
  const b = req.body || {};
  const { officerUsername, officerPassword } = b;

  // Authenticate the issuing officer either by an active desk session
  // (started via Google/Microsoft) or by username + password per pass.
  let user;
  const desk = verifyDeskSession(req.cookies?.desk_session || '');
  if (desk) {
    const u = await db.query(
      `SELECT * FROM users WHERE id = $1 AND is_active = TRUE AND role IN ('security','management')`,
      [desk.sub]
    );
    user = u.rows[0];
    if (!user) return res.status(401).json({ error: 'desk_session_invalid' });
  } else {
    if (!officerUsername || !officerPassword) {
      return res.status(400).json({ error: 'officer_and_password_required' });
    }
    const u = await db.query(
      `SELECT * FROM users WHERE username = $1 AND is_active = TRUE AND role IN ('security','management')`,
      [officerUsername]
    );
    user = u.rows[0];
    const ok = user
      ? await password.verify(officerPassword, user.password_hash)
      : await password.verify(officerPassword, '$2a$12$0000000000000000000000000000000000000000000000000000');
    if (!user || !ok) {
      await db.query(
        `INSERT INTO auth_audit_log (username, event, success, ip, user_agent)
         VALUES ($1,'desk_issue_failed',FALSE,$2,$3)`,
        [officerUsername, req.ip || null, (req.headers['user-agent'] || '').slice(0, 300)]
      );
      return res.status(401).json({ error: 'invalid_officer_credentials' });
    }
  }
  try {
    const result = await passService.issuePass({
      unitNumber: b.unitNumber,
      visitorPlate: b.visitorPlate,
      visitorFirstName: b.visitorFirstName,
      visitorLastName: b.visitorLastName,
      visitorCountry: b.visitorCountry,
      visitorRegion: b.visitorRegion,
      durationPreset: b.durationPreset,
      startsAt: b.startsAt || undefined,
      issuer: { id: user.id, role: user.role, name: user.full_name },
      override: Boolean(b.override),
      overrideCode: b.overrideCode,
      overrideReason: b.overrideReason,
      spotOverride: Boolean(b.spotOverride),
    });
    await db.query(
      `INSERT INTO auth_audit_log (user_id, username, event, success, ip, user_agent)
       VALUES ($1,$2,'desk_issue',TRUE,$3,$4)`,
      [user.id, user.username, req.ip || null, (req.headers['user-agent'] || '').slice(0, 300)]
    );
    res.status(201).json({
      passId: result.pass.id,
      unitNumber: result.pass.unit_number,
      visitorPlate: result.pass.visitor_plate,
      shortCode: result.shortCode,
      startsAt: result.pass.starts_at,
      expiresAt: result.pass.expires_at,
      usedOverride: result.usedOverride,
      usedSpotOverride: result.usedSpotOverride,
      issuedBy: user.full_name,
      printUrl: `/api/desk/print/${result.pass.id}?code=${encodeURIComponent(result.shortCode)}`,
    });
  } catch (err) {
    const codeMap = {
      unit_not_found: 404, quota_exceeded: 409, spot_full: 409, no_tags_available: 409,
      unit_already_has_active_pass: 409, day_duplicate: 409, override_code_invalid: 403,
      override_reason_required: 400, invalid_plate: 400, invalid_region: 400,
      invalid_start: 400, invalid_duration: 400,
    };
    if (codeMap[err.code]) {
      return res.status(codeMap[err.code]).json({ error: err.code, message: err.message, quota: err.quota, spots: err.spots });
    }
    throw err;
  }
});

// Public printable sheet, authorized by the pass's own short code (which the
// desk operator has after issuing). No session required.
router.get('/print/:id', async (req, res) => {
  const code = barcode.normalizeShortCode(req.query.code || '');
  const r = await db.query(
    `SELECT vp.*, u.unit_number, usr.full_name AS issuer_name, usr.role AS issuer_role
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
       JOIN users usr ON usr.id = vp.issued_by
      WHERE vp.id = $1`,
    [req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).send('Pass not found');
  const pass = r.rows[0];
  if (!code || barcode.normalizeShortCode(pass.short_code) !== code) {
    return res.status(403).send('Invalid or missing verification code');
  }
  const token = barcode.signPass({
    passId: pass.id, unitNumber: pass.unit_number,
    visitorPlate: pass.visitor_plate, issuedAt: pass.issued_at, expiresAt: pass.expires_at,
  });
  const qrDataUrl = await QRCode.toDataURL(token, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });
  res.type('html').send(renderPassSheet({ pass, token, qrDataUrl, shortCode: pass.short_code }));
});

module.exports = router;
