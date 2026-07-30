'use strict';
const express = require('express');
const db = require('./../db');
const password = require('./../auth/password');
const { requireAuth, requireRole } = require('./../auth/middleware');
const { normalizePlate } = require('./../services/passService');
const config = require('./../config');
const barcode = require('./../crypto/barcode');

const router = express.Router();

// The weekly override code is viewable by Management AND Board (they distribute
// it), so that one route is mounted before the management-only gate below.
router.get('/override-code', requireAuth, requireRole('management', 'board'), (req, res) => {
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  res.json({
    current: barcode.overrideCodeForWeek(now),
    next: barcode.overrideCodeForWeek(nextWeek),
    note: 'Distribute the current code to authorize quota overrides this week. It rotates automatically.',
  });
});

// Everything below here is Management-only.
router.use(requireAuth, requireRole('management'));

// --- User account creation -------------------------------------------------
router.post('/users', async (req, res) => {
  const { username, fullName, role, password: pw } = req.body || {};
  if (!username || !fullName || !role || !pw) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (!['security', 'management', 'board'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  const hash = await password.hash(pw);
  try {
    const r = await db.query(
      `INSERT INTO users (username, full_name, role, password_hash)
       VALUES ($1,$2,$3,$4) RETURNING id, username, full_name, role`,
      [username, fullName, role, hash]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username_taken' });
    throw err;
  }
});

router.get('/users', async (req, res) => {
  const r = await db.query(
    `SELECT id, username, full_name, role, is_active, created_at
       FROM users ORDER BY created_at DESC`
  );
  res.json(r.rows);
});

// --- Units & unit mapping --------------------------------------------------
router.post('/units', async (req, res) => {
  const { unitNumber, floor, notes, kind, businessName, businessContact } = req.body || {};
  if (!unitNumber) return res.status(400).json({ error: 'unit_number_required' });
  const unitKind = kind === 'commercial' ? 'commercial' : 'residential';
  if (unitKind === 'commercial' && !businessName) {
    return res.status(400).json({ error: 'business_name_required' });
  }
  // Enforce the residential-unit cap (commercial units are not counted).
  if (unitKind === 'residential') {
    const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM units WHERE kind = 'residential'`);
    if (countRes.rows[0].n >= config.residentialUnitCap) {
      return res.status(409).json({
        error: 'residential_cap_reached',
        message: `The building's ${config.residentialUnitCap}-unit residential cap has been reached.`,
      });
    }
  }
  try {
    const r = await db.query(
      `INSERT INTO units (unit_number, floor, notes, kind, business_name, business_contact)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [unitNumber, floor || null, notes || null, unitKind,
       unitKind === 'commercial' ? businessName : null,
       unitKind === 'commercial' ? (businessContact || null) : null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'unit_exists' });
    throw err;
  }
});

router.post('/units/:unitNumber/residents', async (req, res) => {
  const { fullName, email, phone, isPrimary } = req.body || {};
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = $1`, [req.params.unitNumber]);
  if (unit.rowCount === 0) return res.status(404).json({ error: 'unit_not_found' });
  const r = await db.query(
    `INSERT INTO residents (unit_id, full_name, email, phone, is_primary)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [unit.rows[0].id, fullName, email || null, phone || null, Boolean(isPrimary)]
  );
  res.status(201).json(r.rows[0]);
});

router.post('/units/:unitNumber/vehicles', async (req, res) => {
  const { licencePlate, residentId, province, make, model, color } = req.body || {};
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = $1`, [req.params.unitNumber]);
  if (unit.rowCount === 0) return res.status(404).json({ error: 'unit_not_found' });
  try {
    const r = await db.query(
      `INSERT INTO registered_vehicles (unit_id, resident_id, licence_plate, province, make, model, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [unit.rows[0].id, residentId || null, normalizePlate(licencePlate), province || null,
       make || null, model || null, color || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'plate_already_registered' });
    throw err;
  }
});

// --- Manual override grant (raise a unit's ceiling ahead of time) -----------
router.post('/overrides', async (req, res) => {
  const { unitNumber, year, extraPasses, reason } = req.body || {};
  if (!unitNumber || !extraPasses || !reason) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = $1`, [unitNumber]);
  if (unit.rowCount === 0) return res.status(404).json({ error: 'unit_not_found' });
  const r = await db.query(
    `INSERT INTO override_grants (unit_id, calendar_year, extra_passes, reason, granted_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [unit.rows[0].id, year || new Date().getUTCFullYear(), parseInt(extraPasses, 10), reason, req.user.id]
  );
  res.status(201).json(r.rows[0]);
});

// --- Audit log -------------------------------------------------------------
router.get('/audit', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const r = await db.query(
    `SELECT al.id, al.action, al.detail, al.created_at,
            u.full_name AS actor_name, u.role AS actor_role,
            vp.visitor_plate, un.unit_number
       FROM pass_audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       LEFT JOIN visitor_passes vp ON vp.id = al.pass_id
       LEFT JOIN units un ON un.id = vp.unit_id
      ORDER BY al.created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json(r.rows);
});

// --- Sign-in (authentication) audit log ------------------------------------
router.get('/auth-audit', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const r = await db.query(
    `SELECT aa.id, aa.username, aa.event, aa.success, aa.ip, aa.user_agent, aa.created_at,
            u.full_name AS actor_name, u.role AS actor_role
       FROM auth_audit_log aa
       LEFT JOIN users u ON u.id = aa.user_id
      ORDER BY aa.created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json(r.rows);
});

module.exports = router;
