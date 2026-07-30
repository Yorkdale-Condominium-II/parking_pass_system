'use strict';
const express = require('express');
const db = require('./../db');
const password = require('./../auth/password');
const { requireAuth, requireRole } = require('./../auth/middleware');
const { normalizePlate } = require('./../services/passService');
const config = require('./../config');
const barcode = require('./../crypto/barcode');
const exporter = require('./../services/export');

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
  const { username, firstName, lastName, role, password: pw } = req.body || {};
  if (!username || !firstName || !lastName || !role || !pw) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (!['security', 'management', 'board'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const hash = await password.hash(pw);
  try {
    const r = await db.query(
      `INSERT INTO users (username, first_name, last_name, full_name, role, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, first_name, last_name, full_name, role`,
      [username, firstName.trim(), lastName.trim(), fullName, role, hash]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username_taken' });
    throw err;
  }
});

router.get('/users', async (req, res) => {
  const r = await db.query(
    `SELECT id, username, first_name, last_name, full_name, role, is_active, created_at
       FROM users ORDER BY role, full_name`
  );
  res.json(r.rows);
});

// Update a user: names, role, or active state.
router.patch('/users/:id', async (req, res) => {
  const { firstName, lastName, role, isActive } = req.body || {};
  if (role && !['security', 'management', 'board'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (firstName !== undefined) add('first_name', firstName.trim());
  if (lastName !== undefined) add('last_name', lastName.trim());
  if (role !== undefined) add('role', role);
  if (typeof isActive === 'boolean') add('is_active', isActive);
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.params.id);
  const r = await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  // Keep full_name derived from first/last.
  const out = await db.query(
    `UPDATE users SET full_name = trim(concat_ws(' ', first_name, last_name)) WHERE id = $1
      RETURNING id, username, first_name, last_name, full_name, role, is_active`,
    [req.params.id]
  );
  res.json(out.rows[0]);
});

// Reset a user's password.
router.post('/users/:id/reset-password', async (req, res) => {
  const { password: pw } = req.body || {};
  if (!pw || pw.length < 8) return res.status(400).json({ error: 'password_too_short' });
  const hash = await password.hash(pw);
  const r = await db.query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id`,
    [hash, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json({ ok: true });
});

// Per-user activity history: passes issued and cancelled, plus request decisions.
router.get('/users/:id/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const r = await db.query(
    `SELECT al.created_at, al.action, al.detail, un.unit_number, vp.visitor_plate
       FROM pass_audit_log al
       LEFT JOIN visitor_passes vp ON vp.id = al.pass_id
       LEFT JOIN units un ON un.id = vp.unit_id
      WHERE al.actor_id = $1
      ORDER BY al.created_at DESC
      LIMIT $2`,
    [req.params.id, limit]
  );
  const summary = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE action IN ('issued','override_used'))::int AS issued,
        COUNT(*) FILTER (WHERE action = 'revoked')::int                   AS cancelled,
        COUNT(*) FILTER (WHERE action = 'vacated')::int                   AS vacated,
        COUNT(*) FILTER (WHERE action = 'verified')::int                  AS verified
       FROM pass_audit_log WHERE actor_id = $1`,
    [req.params.id]
  );
  res.json({ summary: summary.rows[0], events: r.rows });
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

// --- Year-end archive & clear ----------------------------------------------
// Reports how much prior-year data exists (the annual "download then clear"
// prompt) and, on explicit confirmation, purges passes/requests/audit rows from
// years BEFORE the current one. Units, residents, and vehicles are never touched.
router.get('/year-end/status', async (req, res) => {
  const year = new Date().getFullYear();
  const q = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM visitor_passes WHERE calendar_year < $1)::int AS passes,
       (SELECT COUNT(*) FROM pass_requests WHERE EXTRACT(YEAR FROM created_at) < $1)::int AS requests,
       (SELECT COUNT(*) FROM pass_audit_log WHERE EXTRACT(YEAR FROM created_at) < $1)::int AS pass_audit,
       (SELECT COUNT(*) FROM auth_audit_log WHERE EXTRACT(YEAR FROM created_at) < $1)::int AS auth_audit`,
    [year]
  );
  const priorYears = await db.query(
    `SELECT DISTINCT calendar_year FROM visitor_passes WHERE calendar_year < $1 ORDER BY calendar_year`,
    [year]
  );
  const counts = q.rows[0];
  const total = counts.passes + counts.requests + counts.pass_audit + counts.auth_audit;
  res.json({ currentYear: year, counts, total, hasPriorData: total > 0,
             priorYears: priorYears.rows.map((r) => r.calendar_year) });
});

router.post('/year-end/clear', async (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'confirmation_required' });
  }
  const year = new Date().getFullYear();
  const deleted = await db.withTransaction(async (client) => {
    const a = await client.query(`DELETE FROM pass_audit_log WHERE EXTRACT(YEAR FROM created_at) < $1`, [year]);
    const b = await client.query(`DELETE FROM auth_audit_log WHERE EXTRACT(YEAR FROM created_at) < $1`, [year]);
    const c = await client.query(`DELETE FROM pass_requests WHERE EXTRACT(YEAR FROM created_at) < $1`, [year]);
    const d = await client.query(`DELETE FROM visitor_passes WHERE calendar_year < $1`, [year]);
    // Record the archive action in this year's (retained) audit log.
    await client.query(
      `INSERT INTO pass_audit_log (action, actor_id, detail) VALUES ('year_end_clear',$1,$2)`,
      [req.user.id, { before_year: year, deleted: {
        pass_audit: a.rowCount, auth_audit: b.rowCount, requests: c.rowCount, passes: d.rowCount } }]
    );
    return { passes: d.rowCount, requests: c.rowCount, pass_audit: a.rowCount, auth_audit: b.rowCount };
  });
  res.json({ ok: true, deleted });
});

// --- Display settings (company / condo name) -------------------------------
router.patch('/settings', async (req, res) => {
  const { orgName } = req.body || {};
  if (!orgName || !orgName.trim()) return res.status(400).json({ error: 'org_name_required' });
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('org_name', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [orgName.trim()]
  );
  res.json({ ok: true, orgName: orgName.trim() });
});

// --- Clear all logs (full archive & clear) ---------------------------------
// Deletes ALL audit logs plus completed/historical passes and decided requests.
// Currently-live and future-scheduled passes and still-pending requests are
// kept so day-to-day operations aren't disrupted. Export first — this is
// irreversible.
router.post('/clear-logs', async (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'confirmation_required' });
  }
  const deleted = await db.withTransaction(async (client) => {
    // Historical passes = revoked, vacated, or already expired (not live/scheduled).
    const passes = await client.query(
      `DELETE FROM visitor_passes
        WHERE status = 'revoked' OR vacated_at IS NOT NULL OR expires_at <= now()`
    );
    const requests = await client.query(`DELETE FROM pass_requests WHERE status <> 'pending'`);
    const passAudit = await client.query(`DELETE FROM pass_audit_log`);
    const authAudit = await client.query(`DELETE FROM auth_audit_log`);
    await client.query(
      `INSERT INTO pass_audit_log (action, actor_id, detail) VALUES ('logs_cleared',$1,$2)`,
      [req.user.id, { deleted: {
        passes: passes.rowCount, requests: requests.rowCount,
        pass_audit: passAudit.rowCount, auth_audit: authAudit.rowCount } }]
    );
    return { passes: passes.rowCount, requests: requests.rowCount,
             pass_audit: passAudit.rowCount, auth_audit: authAudit.rowCount };
  });
  res.json({ ok: true, deleted });
});

// --- Data export (CSV / XLSX / PDF) ----------------------------------------
router.get('/export/datasets', (req, res) => {
  res.json(Object.entries(exporter.DATASETS).map(([id, d]) => ({ id, label: d.label })));
});

router.get('/export', async (req, res) => {
  const dataset = String(req.query.dataset || 'passes');
  const format = String(req.query.format || 'csv').toLowerCase();
  let data;
  try {
    data = await exporter.fetchDataset(dataset);
  } catch (err) {
    if (err.code === 'unknown_dataset') return res.status(404).json({ error: 'unknown_dataset' });
    throw err;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${dataset}_${stamp}`;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(exporter.toCsv(data.def, data.rows));
  }
  if (format === 'xlsx') {
    const buf = await exporter.toXlsx(data.def, data.rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(Buffer.from(buf));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return exporter.toPdf(data.def, data.rows, res); // streams + ends the response
  }
  return res.status(400).json({ error: 'unknown_format' });
});

module.exports = router;
