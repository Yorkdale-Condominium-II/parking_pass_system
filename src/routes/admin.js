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
  const { username, firstName, lastName, role, email, password: pw } = req.body || {};
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
      `INSERT INTO users (username, first_name, last_name, full_name, role, email, password_hash, must_reset_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id, username, first_name, last_name, full_name, role, email`,
      [username, firstName.trim(), lastName.trim(), fullName, role, (email || '').trim() || null, hash]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // Could be username OR email uniqueness.
      return res.status(409).json({ error: 'username_or_email_taken' });
    }
    throw err;
  }
});

router.get('/users', async (req, res) => {
  const r = await db.query(
    `SELECT id, username, first_name, last_name, full_name, role, email, is_active, is_superuser, created_at
       FROM users ORDER BY role, full_name`
  );
  res.json(r.rows);
});

// Update a user: names, role, active state, or superuser flag.
router.patch('/users/:id', async (req, res) => {
  const { firstName, lastName, role, email, isActive, isSuperuser } = req.body || {};
  if (role && !['security', 'management', 'board'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  // Changing a role or the superuser flag is reserved for superusers.
  if (role !== undefined || typeof isSuperuser === 'boolean') {
    const me = await db.query(`SELECT is_superuser FROM users WHERE id = $1`, [req.user.id]);
    if (!me.rows[0]?.is_superuser) return res.status(403).json({ error: 'superuser_required' });
  }
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (firstName !== undefined) add('first_name', firstName.trim());
  if (lastName !== undefined) add('last_name', lastName.trim());
  if (role !== undefined) add('role', role);
  if (email !== undefined) add('email', (email || '').trim() || null);
  if (typeof isActive === 'boolean') add('is_active', isActive);
  if (typeof isSuperuser === 'boolean') add('is_superuser', isSuperuser);
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.params.id);
  let r;
  try {
    r = await db.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
      params
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw err;
  }
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  // Keep full_name derived from first/last.
  const out = await db.query(
    `UPDATE users SET full_name = trim(concat_ws(' ', first_name, last_name)) WHERE id = $1
      RETURNING id, username, first_name, last_name, full_name, role, is_active, is_superuser`,
    [req.params.id]
  );
  res.json(out.rows[0]);
});

// Reset a user's password.
router.post('/users/:id/reset-password', async (req, res) => {
  const { password: pw } = req.body || {};
  if (!pw || pw.length < 8) return res.status(400).json({ error: 'password_too_short' });
  const hash = await password.hash(pw);
  // A manager-set password is temporary — force the user to change it at next login.
  const r = await db.query(
    `UPDATE users SET password_hash = $1, must_reset_password = TRUE, updated_at = now() WHERE id = $2 RETURNING id`,
    [hash, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json({ ok: true });
});

// Permanently delete a user account. Destructive, so it's superuser-only and
// you can't delete your own account. Accounts that have activity history
// (issued passes, audit entries, overrides) are protected by foreign keys —
// those return 409 so the operator disables them instead of losing the trail.
router.delete('/users/:id', async (req, res) => {
  const me = await db.query(`SELECT is_superuser FROM users WHERE id = $1`, [req.user.id]);
  if (!me.rows[0]?.is_superuser) return res.status(403).json({ error: 'superuser_required' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    const r = await db.query(`DELETE FROM users WHERE id = $1 RETURNING username`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    res.json({ ok: true, deleted: r.rows[0].username });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'user_has_history' });
    throw err;
  }
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

// --- Bulk unit import ------------------------------------------------------
// Idempotent bulk load of the building's real unit registry (~1520 residential
// + commercial tenants). Accepts a JSON array of unit objects under `units`,
// raw CSV text under `csv`, or a base64-encoded Excel workbook under
// `xlsxBase64` — all with a header row whose columns map to
// unitNumber/unit_number, floor, kind, businessName, businessContact, notes.
// Existing units are updated in place (matched on unit_number) so re-running the
// same import is safe. The residential cap is enforced against the combined
// existing + newly-inserted residential count; rows that would breach it, or are
// otherwise invalid, are reported per-row without aborting the whole import.

const normCell = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

// Grid / floor-plan layout: row 1 is "Floor Level" then a floor number per
// column; column A is a repeated "Unit Number" label; every other cell holds an
// actual unit number for that column's floor. Blank cells are skipped, so only
// the unit numbers actually present are imported (no gaps are filled in). This
// matches how an operator naturally lays the building out in a spreadsheet.
function gridToObjects(matrix) {
  const floors = matrix[0] || [];
  const out = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    for (let c = 1; c < row.length; c++) { // column 0 is the "Unit Number" label
      const unitNumber = String(row[c] ?? '').trim();
      if (!unitNumber) continue;           // only import cells that exist
      const floor = String(floors[c] ?? '').trim();
      out.push({ unitNumber, floor });
    }
  }
  return out;
}

// Detect the grid layout: top-left cell mentions "floor" and the first data
// row's first cell is a "unit number" label.
function looksLikeGrid(matrix) {
  return matrix.length > 1
    && normCell(matrix[0][0]).includes('floor')
    && normCell(matrix[1][0]) === 'unitnumber';
}

// Map a header row + data rows (a matrix of cell values) into unit objects,
// resolving flexible/aliased column names. Shared by the CSV and Excel parsers.
function matrixToObjects(matrix) {
  if (!matrix.length) return [];
  if (looksLikeGrid(matrix)) return gridToObjects(matrix);
  const header = matrix[0].map(normCell);
  const alias = {
    unitnumber: 'unitNumber', unit: 'unitNumber', number: 'unitNumber',
    floor: 'floor', kind: 'kind', type: 'kind',
    businessname: 'businessName', business: 'businessName',
    businesscontact: 'businessContact', contact: 'businessContact',
    notes: 'notes', note: 'notes',
  };
  return matrix.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      const key = alias[h];
      if (key) obj[key] = String(r[idx] ?? '').trim();
    });
    return obj;
  }).filter((o) => Object.keys(o).length); // drop wholly-blank rows
}

function parseCsv(text) {
  // Minimal RFC-4180-ish parser: handles quoted fields, embedded commas/quotes,
  // and CRLF/LF line endings. Good enough for an operator-provided unit list.
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') rows.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) { record.push(field); if (record.length > 1 || record[0] !== '') rows.push(record); }
  return matrixToObjects(rows);
}

async function parseXlsx(base64) {
  // Read the first worksheet of an Excel workbook into the same row objects.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const matrix = [];
  ws.eachRow((row) => {
    const cells = [];
    // row.values is 1-indexed (index 0 is unused); flatten to plain cell text.
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).value;
      cells.push(v == null ? '' : (typeof v === 'object' && 'text' in v ? v.text : v));
    }
    matrix.push(cells);
  });
  return matrixToObjects(matrix);
}

router.post('/units/import', async (req, res) => {
  const body = req.body || {};
  let rows;
  if (Array.isArray(body.units)) {
    rows = body.units;
  } else if (typeof body.xlsxBase64 === 'string') {
    try {
      rows = await parseXlsx(body.xlsxBase64);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_xlsx', message: err.message });
    }
  } else if (typeof body.csv === 'string') {
    rows = parseCsv(body.csv);
  } else {
    return res.status(400).json({ error: 'units_csv_or_xlsx_required' });
  }
  if (!rows.length) return res.status(400).json({ error: 'no_rows' });
  if (rows.length > 5000) return res.status(413).json({ error: 'too_many_rows' });

  // Establish how much residential headroom remains before the cap.
  const existing = await db.query(
    `SELECT COUNT(*)::int AS n FROM units WHERE kind = 'residential'`
  );
  const existingNumbers = await db.query(`SELECT unit_number FROM units`);
  const known = new Set(existingNumbers.rows.map((r) => r.unit_number));
  let residentialRoom = config.residentialUnitCap - existing.rows[0].n;

  const result = { inserted: 0, updated: 0, failed: 0, errors: [] };
  const seen = new Set();

  await db.withTransaction(async (client) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const line = i + 1; // 1-based row index within the supplied data
      const unitNumber = String(row.unitNumber ?? '').trim();
      if (!unitNumber) {
        result.failed++; result.errors.push({ line, unitNumber: null, error: 'unit_number_required' });
        continue;
      }
      if (seen.has(unitNumber)) {
        result.failed++; result.errors.push({ line, unitNumber, error: 'duplicate_in_import' });
        continue;
      }
      seen.add(unitNumber);
      const kind = row.kind === 'commercial' ? 'commercial' : 'residential';
      const businessName = (row.businessName ?? '').trim();
      if (kind === 'commercial' && !businessName) {
        result.failed++; result.errors.push({ line, unitNumber, error: 'business_name_required' });
        continue;
      }
      const isNew = !known.has(unitNumber);
      // Only brand-new residential units consume cap headroom.
      if (isNew && kind === 'residential') {
        if (residentialRoom <= 0) {
          result.failed++;
          result.errors.push({ line, unitNumber, error: 'residential_cap_reached' });
          continue;
        }
        residentialRoom--;
      }
      const floorVal = row.floor === '' || row.floor === undefined || row.floor === null
        ? null : parseInt(row.floor, 10);
      const floor = Number.isFinite(floorVal) ? floorVal : null;
      const notes = (row.notes ?? '').trim() || null;
      const bContact = kind === 'commercial' ? ((row.businessContact ?? '').trim() || null) : null;
      const bName = kind === 'commercial' ? businessName : null;
      // Upsert keeps the import idempotent: a re-run updates in place. We can't
      // rely on the RETURNING xmax trick to tell insert from update because
      // ON CONFLICT uses speculative insertion (xmax is non-zero even on a
      // successful insert), so classify from the pre-fetched `known` set.
      await client.query(
        `INSERT INTO units (unit_number, floor, notes, kind, business_name, business_contact)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (unit_number) DO UPDATE SET
           floor = EXCLUDED.floor, notes = EXCLUDED.notes, kind = EXCLUDED.kind,
           business_name = EXCLUDED.business_name, business_contact = EXCLUDED.business_contact`,
        [unitNumber, floor, notes, kind, bName, bContact]
      );
      if (isNew) result.inserted++; else result.updated++;
      known.add(unitNumber);
    }
  });

  res.status(200).json({ ok: true, ...result });
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
