'use strict';
// ============================================================================
//  End-to-end integration test for the parking pass system.
//
//  Boots the real Express app in-process against the database pointed to by
//  DATABASE_URL, resets the relevant tables, seeds one account per role, and
//  exercises the full workflow: auth + RBAC, plate lookup, quota enforcement,
//  Management override, barcode issue/verify (genuine / forged / expired /
//  revoked), and the print sheet.
//
//  Run with:  npm test
//  Requires a reachable PostgreSQL (see .env). Uses a DEDICATED test DB when
//  TEST_DATABASE_URL is set, otherwise falls back to DATABASE_URL.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Point the app at the test database BEFORE requiring any app module, and make
// sure required secrets exist so config.js does not throw.
process.env.NODE_ENV = 'test'; // disables rate limiters so the suite isn't throttled
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-integration-tests';
process.env.BARCODE_SECRET = process.env.BARCODE_SECRET || 'test-barcode-secret-different-value-xyz';
process.env.ANNUAL_PASS_QUOTA = process.env.ANNUAL_PASS_QUOTA || '10';

const app = require('../src/server');
const db = require('../src/db');
const password = require('../src/auth/password');
const barcode = require('../src/crypto/barcode');
const sso = require('../src/auth/sso');

let base;      // http://127.0.0.1:<port>
let server;

// --- tiny fetch helper that threads cookies per role ---
function makeClient() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setC = res.headers.get('set-cookie');
    if (setC) cookie = setC.split(';')[0];
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
    return { status: res.status, body: json, text, contentType: res.headers.get('content-type') };
  };
}

test.before(async () => {
  // Apply schema (idempotent) then reset the tables this suite touches.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(schema);
  await db.query(
    `TRUNCATE pass_requests, auth_audit_log, pass_audit_log, override_grants, visitor_passes,
              registered_vehicles, residents, units, users RESTART IDENTITY CASCADE`
  );

  // Seed one account per role + a unit and a registered vehicle.
  const pw = await password.hash('changeme123');
  for (const [u, n, r] of [
    ['security1', 'Sam Security', 'security'],
    ['manager1', 'Morgan Manager', 'management'],
    ['board1', 'Blair Board', 'board'],
  ]) {
    await db.query(
      `INSERT INTO users (username, full_name, role, password_hash) VALUES ($1,$2,$3,$4)`,
      [u, n, r, pw]
    );
  }
  // Mirror the v10 bootstrap: Management accounts start as superusers.
  await db.query(`UPDATE users SET is_superuser = TRUE WHERE role = 'management'`);
  for (const un of ['1204', '0805']) {
    await db.query(`INSERT INTO units (unit_number) VALUES ($1)`, [un]);
  }
  await db.query(
    `INSERT INTO units (unit_number, kind, business_name) VALUES ('C-101','commercial','Corner Cafe Ltd.')`
  );
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = '1204'`);
  const resident = await db.query(
    `INSERT INTO residents (unit_id, full_name, email, phone, is_primary)
     VALUES ($1, 'Dana Resident', 'dana@example.com', '416-555-0142', TRUE) RETURNING id`,
    [unit.rows[0].id]
  );
  await db.query(
    `INSERT INTO registered_vehicles (unit_id, resident_id, licence_plate, province, make, model, color)
     VALUES ($1, $2, 'ABCD123', 'ON', 'Toyota', 'Corolla', 'Silver')`,
    [unit.rows[0].id, resident.rows[0].id]
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

// Isolate each test: clear the transactional tables (keep users/units/
// residents/vehicles from before()). Prevents live passes from one test
// consuming the 5-spot capacity in the next.
test.beforeEach(async () => {
  await db.query(
    `TRUNCATE pass_requests, pass_audit_log, auth_audit_log, override_grants,
              visitor_passes RESTART IDENTITY CASCADE`
  );
});

// Issue a pass through the API then immediately vacate it, so it counts against
// the annual quota without holding a physical spot (used to test quota alone).
async function issueAndFree(client, unitNumber, plate) {
  const iss = await client('POST', '/api/passes', { unitNumber, visitorPlate: plate });
  assert.equal(iss.status, 201, `issue ${plate}: ${JSON.stringify(iss.body)}`);
  await client('POST', `/api/passes/${iss.body.passId}/vacate`, {});
  return iss;
}

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

// ---------------------------------------------------------------------------

test('rejects invalid credentials', async () => {
  const c = makeClient();
  const res = await c('POST', '/api/auth/login', { username: 'security1', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('security can log in and look up a registered plate', async () => {
  const c = makeClient();
  const login = await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'security');

  const look = await c('GET', '/api/passes/lookup?by=plate&q=abcd123'); // lower-case on purpose
  assert.equal(look.status, 200);
  assert.equal(look.body.registeredVehicles.length, 1);
  assert.equal(look.body.registeredVehicles[0].unit_number, '1204');
});

test('lookup by name and by phone finds the resident vehicle', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });

  const byName = await c('GET', '/api/passes/lookup?by=name&q=dana');
  assert.equal(byName.status, 200);
  assert.ok(byName.body.registeredVehicles.some((v) => v.resident_name === 'Dana Resident'));

  const byPhone = await c('GET', '/api/passes/lookup?by=phone&q=5550142');
  assert.equal(byPhone.status, 200);
  assert.ok(byPhone.body.registeredVehicles.some((v) => v.licence_plate === 'ABCD123'));
});

test('the units endpoint lists known units and rejects unknown ones at issue', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const units = await c('GET', '/api/units');
  assert.ok(units.body.some((u) => u.unit_number === '1204'));

  const bad = await c('POST', '/api/passes', { unitNumber: 'NOPE-999', visitorPlate: 'ZZ1' });
  assert.equal(bad.status, 404);
  assert.equal(bad.body.error, 'unit_not_found');
});

test('issuing normalizes the plate and returns a signed token', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const res = await c('POST', '/api/passes', {
    unitNumber: '1204', visitorPlate: 'vis-999', visitorName: 'Alex Guest',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.visitorPlate, 'VIS999');           // normalized
  assert.ok(res.body.token.startsWith('PPV1.'));           // signed token shape
  assert.equal(barcode.verifyToken(res.body.token).valid, true);
  assert.match(res.body.shortCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/); // printed short code
});

test('issue accepts split name + region and rejects an invalid region', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });

  const ok = await c('POST', '/api/passes', {
    unitNumber: '1204', visitorPlate: 'RGN100', visitorFirstName: 'Pat', visitorLastName: 'Lee',
    visitorCountry: 'CA', visitorRegion: 'ON',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.visitorName, 'Pat Lee');

  const bad = await c('POST', '/api/passes', {
    unitNumber: '1204', visitorPlate: 'RGN101', visitorCountry: 'CA', visitorRegion: 'ZZ',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_region');
});

test('duration presets set the right expiry (today vs tomorrow noon)', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });

  const today = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'DUR1', durationPreset: 'today' });
  const exp = new Date(today.body.expiresAt);
  assert.equal(exp.getHours(), 23); // end of the current local day

  const noon = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'DUR2', durationPreset: 'tomorrow_noon' });
  assert.equal(new Date(noon.body.expiresAt).getHours(), 12);
});

test('a pass verifies by its printed short code', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const issued = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'SHRT1' });
  const byCode = await c('POST', '/api/verify', { shortCode: issued.body.shortCode });
  assert.equal(byCode.body.verdict, 'VALID');
  assert.equal(byCode.body.pass.visitor_plate, 'SHRT1');

  const bogus = await c('POST', '/api/verify', { shortCode: 'ZZZZ-ZZZZ' });
  assert.equal(bogus.body.verdict, 'INVALID');
});

test('verify distinguishes genuine, forged, and revoked passes', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const issued = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'VER111' });
  const token = issued.body.token;

  const good = await c('POST', '/api/verify', { token });
  assert.equal(good.body.verdict, 'VALID');
  assert.equal(good.body.authentic, true);

  // Tamper with the signature segment.
  const parts = token.split('.');
  parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'BB' : 'AA');
  const forged = await c('POST', '/api/verify', { token: parts.join('.') });
  assert.equal(forged.body.verdict, 'FORGED');
  assert.equal(forged.body.authentic, false);

  // Revoke then re-verify.
  const rev = await c('POST', `/api/passes/${issued.body.passId}/revoke`);
  assert.equal(rev.status, 200);
  const after = await c('POST', '/api/verify', { token });
  assert.equal(after.body.verdict, 'REVOKED');
});

test('a genuine-but-expired token verifies as EXPIRED', async () => {
  // Craft a signed token whose expiry is in the past for an existing pass.
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const issued = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'EXP222' });
  // Force the DB row into the past (keeping expires_at > issued_at so the row
  // stays valid), then re-sign with the matching past expiry.
  await db.query(
    `UPDATE visitor_passes
        SET issued_at = now() - interval '3 hours',
            expires_at = now() - interval '1 hour'
      WHERE id = $1`,
    [issued.body.passId]);
  const past = barcode.signPass({
    passId: issued.body.passId, unitNumber: '1204', visitorPlate: 'EXP222',
    issuedAt: Date.now() - 7200000, expiresAt: Date.now() - 3600000,
  });
  const res = await c('POST', '/api/verify', { token: past });
  assert.equal(res.body.verdict, 'EXPIRED');
});

test('enforces the 10-pass annual quota and blocks the 11th', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  // Free each spot after issuing so the annual quota (not the 5-spot cap) is
  // what we're exercising here.
  for (let i = 0; i < 10; i++) await issueAndFree(c, '0805', 'Q' + i);
  const blocked = await c('POST', '/api/passes', { unitNumber: '0805', visitorPlate: 'Q10' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'quota_exceeded');
  assert.equal(blocked.body.quota.used, 10);
});

test('override requires the current weekly code and a reason', async () => {
  const sec = makeClient();
  await sec('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  // Bring 0805 to its 10-pass limit (freeing spots as we go).
  for (let i = 0; i < 10; i++) await issueAndFree(sec, '0805', 'F' + i);

  // Wrong/absent code is rejected even though we are at the limit.
  const denied = await sec('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR1', override: true,
    overrideCode: 'WRNG-CODE', overrideReason: 'nope',
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'override_code_invalid');

  // The real weekly code (derived the same way the server does) works.
  const code = barcode.overrideCodeForWeek().code;
  const ok = await sec('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR1', override: true,
    overrideCode: code, overrideReason: 'Board-approved overflow',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.usedOverride, true);

  // Valid code but no reason is rejected.
  const noReason = await sec('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR2', override: true, overrideCode: code,
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error, 'override_reason_required');
});

test('commercial units get the higher (20) annual quota', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  for (let i = 0; i < 20; i++) {
    const r = await issueAndFree(c, 'C-101', 'K' + i);
    assert.equal(r.body.kind, 'commercial');
  }
  const blocked = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'K20' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.quota.limit, 20);
});

test('caps concurrent live passes at the 5-space limit, security can override', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  // Commercial unit has quota 20, so only the 5-space cap is in play here.
  for (let i = 0; i < 5; i++) {
    const r = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'S' + i });
    assert.equal(r.status, 201, `spot ${i + 1}`);
  }
  const full = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'S5' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'spot_full');
  assert.equal(full.body.spots.capacity, 5);

  // Security override (spot confirmed free) succeeds.
  const over = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'S5', spotOverride: true });
  assert.equal(over.status, 201);
  assert.equal(over.body.usedSpotOverride, true);
});

test('scheduling a non-overlapping window avoids the live cap', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  for (let i = 0; i < 5; i++) {
    await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'N' + i });
  }
  // A pass scheduled after the live ones expire doesn't overlap them (and stays
  // inside the 48h upcoming window so the scheduled list can be asserted below).
  const future = new Date(Date.now() + 30 * 3600 * 1000).toISOString();
  const sched = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'SCHED1', startsAt: future });
  assert.equal(sched.status, 201, JSON.stringify(sched.body));

  // The scheduled list names who authorized (issued) each upcoming pass.
  const spots = await c('GET', '/api/spots');
  const row = spots.body.upcoming.find((p) => p.visitor_plate === 'SCHED1');
  assert.ok(row, 'scheduled pass should appear in the upcoming list');
  assert.equal(row.authorized_by, 'Sam Security');

  // A scheduled pass can be cancelled (revoked) and then drops off the list.
  const cancel = await c('POST', `/api/passes/${row.id}/revoke`);
  assert.equal(cancel.status, 200);
  const after = await c('GET', '/api/spots');
  assert.ok(!after.body.upcoming.some((p) => p.visitor_plate === 'SCHED1'),
    'cancelled scheduled pass should no longer be listed');
});

test('vacating a spot frees capacity for the next guest', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'V' + i });
    ids.push(r.body.passId);
  }
  assert.equal((await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'V5' })).status, 409);

  const vac = await c('POST', `/api/passes/${ids[0]}/vacate`, {});
  assert.equal(vac.status, 200);

  const now201 = await c('POST', '/api/passes', { unitNumber: 'C-101', visitorPlate: 'V5' });
  assert.equal(now201.status, 201, 'a freed spot should allow a new pass');

  const spots = await c('GET', '/api/spots');
  assert.equal(spots.body.capacity, 5);
  assert.equal(spots.body.used, 5);
});

test('the current weekly override code is viewable by management', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const r = await mgr('GET', '/api/admin/override-code');
  assert.equal(r.status, 200);
  assert.match(r.body.current.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(r.body.current.code, barcode.overrideCodeForWeek().code);
});

test('sign-ins are recorded in the auth audit log', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  // Generate a failed attempt too.
  const anon = makeClient();
  await anon('POST', '/api/auth/login', { username: 'security1', password: 'WRONG' });

  const log = await mgr('GET', '/api/admin/auth-audit?limit=100');
  assert.equal(log.status, 200);
  assert.ok(log.body.some((r) => r.event === 'login_success'));
  assert.ok(log.body.some((r) => r.event === 'login_failed' && r.success === false));
});

test('board sees aggregates but is denied resident/plate data', async () => {
  const board = makeClient();
  await board('POST', '/api/auth/login', { username: 'board1', password: 'changeme123' });

  // Seed a couple of passes so the aggregates are non-zero.
  const staff = makeClient();
  await staff('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  await issueAndFree(staff, '1204', 'BRD1');
  await issueAndFree(staff, 'C-101', 'BRD2');

  const summary = await board('GET', '/api/board/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.body.totals.total_passes >= 2);
  // No PII fields leak into the board payload.
  assert.equal(JSON.stringify(summary.body).includes('visitor_name'), false);

  const lookup = await board('GET', '/api/passes/lookup?plate=ABCD123');
  assert.equal(lookup.status, 403);
  const admin = await board('GET', '/api/admin/audit');
  assert.equal(admin.status, 403);
});

test('management admin can create a user and read the audit log', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  const created = await mgr('POST', '/api/admin/users', {
    username: 'security2', firstName: 'Sky', lastName: 'Security', role: 'security', password: 'pw12345678',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'security');
  assert.equal(created.body.full_name, 'Sky Security');

  // Issue a pass so the audit log has an 'issued' entry to read back.
  await mgr('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'AUD1' });
  const audit = await mgr('GET', '/api/admin/audit?limit=50');
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.body));
  assert.ok(audit.body.some((r) => r.action === 'issued'));
});

test('resident portal: submit request, staff approve issues a pass', async () => {
  const anon = makeClient(); // no login — public portal

  const bad = await anon('POST', '/api/resident/requests', {
    unitNumber: 'NOPE', requesterName: 'Sam', visitorPlate: 'REQ1',
  });
  assert.equal(bad.status, 404);

  const submit = await anon('POST', '/api/resident/requests', {
    unitNumber: '1204', requesterName: 'Dana Resident', requesterContact: '416-555-0142',
    visitorFirstName: 'Guest', visitorLastName: 'One', visitorCountry: 'CA', visitorRegion: 'ON',
    visitorPlate: 'req-77', durationPreset: 'tomorrow_noon', note: 'evening',
  });
  assert.equal(submit.status, 201);
  assert.match(submit.body.reference, /^[0-9A-Z]{6}$/); // short public reference

  const staff = makeClient();
  await staff('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });

  const pending = await staff('GET', '/api/requests?status=pending');
  const row = pending.body.find((r) => r.visitor_plate === 'REQ77');
  assert.ok(row, 'pending request should be listed');

  const count = await staff('GET', '/api/requests/pending-count');
  assert.ok(count.body.pending >= 1);

  const approve = await staff('POST', `/api/requests/${row.id}/approve`, {});
  assert.equal(approve.status, 201);
  assert.match(approve.body.shortCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // A now-approved request cannot be approved again.
  const again = await staff('POST', `/api/requests/${row.id}/approve`, {});
  assert.equal(again.status, 409);

  // Public status lookup by the short reference reflects approval.
  const anon2 = makeClient();
  const status = await anon2('GET', `/api/resident/status/${submit.body.reference}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'approved');
  assert.equal(status.body.unit, '1204');
});

test('resident portal: staff can deny a request', async () => {
  const anon = makeClient();
  const submit = await anon('POST', '/api/resident/requests', {
    unitNumber: '1204', requesterName: 'Pat', visitorPlate: 'DENY1',
  });
  const staff = makeClient();
  await staff('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const pending = await staff('GET', '/api/requests?status=pending');
  const row = pending.body.find((r) => r.visitor_plate === 'DENY1');
  const deny = await staff('POST', `/api/requests/${row.id}/deny`, { note: 'not this week' });
  assert.equal(deny.status, 200);

  const after = await staff('GET', `/api/resident/status/${submit.body.reference}`);
  assert.equal(after.body.status, 'denied');
  assert.equal(after.body.note, 'not this week');
});

test('export returns CSV, XLSX, and PDF with correct content types', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  const sets = await mgr('GET', '/api/admin/export/datasets');
  assert.ok(sets.body.some((s) => s.id === 'passes'));

  const csv = await mgr('GET', '/api/admin/export?dataset=units&format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.contentType, /text\/csv/);
  assert.match(csv.text.split('\n')[0], /Unit/); // header row

  const xlsx = await mgr('GET', '/api/admin/export?dataset=units&format=xlsx');
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.contentType, /spreadsheetml/);

  const pdf = await mgr('GET', '/api/admin/export?dataset=units&format=pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.contentType, /application\/pdf/);

  const bad = await mgr('GET', '/api/admin/export?dataset=nope&format=csv');
  assert.equal(bad.status, 404);
});

test('year-end status reports prior-year data and clear purges it', async () => {
  // Seed one pass dated to last year directly.
  const lastYear = new Date().getFullYear() - 1;
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = '1204'`);
  const user = await db.query(`SELECT id FROM users WHERE username = 'security1'`);
  await db.query(
    `INSERT INTO visitor_passes
       (unit_id, visitor_plate, issued_by, issued_at, expires_at, calendar_year, barcode_sig)
     VALUES ($1,'OLDYR1',$2, make_timestamptz($3,6,15,10,0,0), make_timestamptz($3,6,16,10,0,0), $3, 'x')`,
    [unit.rows[0].id, user.rows[0].id, lastYear]
  );

  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  const before = await mgr('GET', '/api/admin/year-end/status');
  assert.equal(before.body.hasPriorData, true);
  assert.ok(before.body.priorYears.includes(lastYear));

  // Confirmation is mandatory.
  const noConfirm = await mgr('POST', '/api/admin/year-end/clear', {});
  assert.equal(noConfirm.status, 400);

  const cleared = await mgr('POST', '/api/admin/year-end/clear', { confirm: true });
  assert.equal(cleared.status, 200);
  assert.ok(cleared.body.deleted.passes >= 1);

  const after = await mgr('GET', '/api/admin/year-end/status');
  assert.equal(after.body.hasPriorData, false);
});

test('desk kiosk issues a pass only with a valid officer password', async () => {
  const anon = makeClient(); // public — no session

  const officers = await anon('GET', '/api/desk/officers');
  assert.ok(officers.body.some((o) => o.username === 'security1'));

  const bad = await anon('POST', '/api/desk/issue', {
    officerUsername: 'security1', officerPassword: 'WRONG',
    unitNumber: '1204', visitorPlate: 'DESK1',
  });
  assert.equal(bad.status, 401);

  const ok = await anon('POST', '/api/desk/issue', {
    officerUsername: 'security1', officerPassword: 'changeme123',
    unitNumber: '1204', visitorPlate: 'desk-1', visitorFirstName: 'Des', visitorLastName: 'Kie',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.visitorPlate, 'DESK1');
  assert.equal(ok.body.issuedBy, 'Sam Security');

  // The desk print link works without a session (short-code gated).
  const print = await anon('GET', ok.body.printUrl);
  assert.equal(print.status, 200);
  assert.ok(print.text.includes('VISITOR PARKING PASS'));
});

test('manage users: update, deactivate, reset password, history', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  const created = await mgr('POST', '/api/admin/users', {
    username: 'guard9', firstName: 'Gwen', lastName: 'Guard', role: 'security', password: 'initialpw1',
  });
  const id = created.body.id;

  // Rename + role stays; full_name re-derives.
  const patched = await mgr('PATCH', `/api/admin/users/${id}`, { lastName: 'Guardian' });
  assert.equal(patched.body.full_name, 'Gwen Guardian');

  // Deactivate → that user can no longer log in.
  await mgr('PATCH', `/api/admin/users/${id}`, { isActive: false });
  const gate = makeClient();
  const denied = await gate('POST', '/api/auth/login', { username: 'guard9', password: 'initialpw1' });
  assert.equal(denied.status, 401);

  // Reset password (and reactivate) → can log in with the new one.
  await mgr('PATCH', `/api/admin/users/${id}`, { isActive: true });
  await mgr('POST', `/api/admin/users/${id}/reset-password`, { password: 'newpass123' });
  const ok = await gate('POST', '/api/auth/login', { username: 'guard9', password: 'newpass123' });
  assert.equal(ok.status, 200);

  // History: guard9 issues then cancels a pass; summary reflects it.
  const iss = await gate('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'HIST1' });
  await gate('POST', `/api/passes/${iss.body.passId}/revoke`, {});
  const hist = await mgr('GET', `/api/admin/users/${id}/history`);
  assert.equal(hist.body.summary.issued, 1);
  assert.equal(hist.body.summary.cancelled, 1);
});

test('clear-logs wipes audit history but keeps live passes', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  // One live pass (kept) and some audit noise (cleared).
  const live = await mgr('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'LIVEKEEP' });

  const noConfirm = await mgr('POST', '/api/admin/clear-logs', {});
  assert.equal(noConfirm.status, 400);

  const cleared = await mgr('POST', '/api/admin/clear-logs', { confirm: true });
  assert.equal(cleared.status, 200);

  // Audit log is emptied except the 'logs_cleared' marker itself.
  const audit = await mgr('GET', '/api/admin/audit');
  assert.ok(audit.body.every((r) => r.action === 'logs_cleared'));

  // The live pass still verifies.
  const v = await mgr('POST', '/api/verify', { token: live.body.token });
  assert.equal(v.body.verdict, 'VALID');
});

test('org/condo name is readable and management can change it', async () => {
  const anon = makeClient();
  const def = await anon('GET', '/api/settings');
  assert.equal(def.status, 200);
  assert.ok(def.body.orgName);
  // The public settings payload carries the app version (for the header/tab).
  assert.equal(def.body.version, require('../package.json').version);

  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const set = await mgr('PATCH', '/api/admin/settings', { orgName: 'Maple Grove Towers' });
  assert.equal(set.status, 200);
  assert.equal(set.body.orgName, 'Maple Grove Towers');

  const after = await anon('GET', '/api/settings');
  assert.equal(after.body.orgName, 'Maple Grove Towers');

  // Security cannot change it.
  const sec = makeClient();
  await sec('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const denied = await sec('PATCH', '/api/admin/settings', { orgName: 'Nope' });
  assert.equal(denied.status, 403);
});

test('temporary password forces a reset, then self-service change clears it', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  await mgr('POST', '/api/admin/users', {
    username: 'tmpuser', firstName: 'Tem', lastName: 'Porary', role: 'security', password: 'temppass1',
  });

  const u = makeClient();
  const login = await u('POST', '/api/auth/login', { username: 'tmpuser', password: 'temppass1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.mustReset, true);

  // Account has no linked email yet.
  const acct = await u('GET', '/api/auth/account');
  assert.equal(acct.body.email, null);

  // Wrong current password is rejected.
  const wrong = await u('POST', '/api/auth/change-password', { currentPassword: 'nope', newPassword: 'brandnew1' });
  assert.equal(wrong.status, 401);

  const changed = await u('POST', '/api/auth/change-password', { currentPassword: 'temppass1', newPassword: 'brandnew1' });
  assert.equal(changed.status, 200);

  // The flag is cleared now.
  const me = await u('GET', '/api/auth/me');
  assert.equal(me.body.user.mustReset, false);

  // Old password no longer works; the new one does (and no longer forces reset).
  const old = makeClient();
  assert.equal((await old('POST', '/api/auth/login', { username: 'tmpuser', password: 'temppass1' })).status, 401);
  const fresh = makeClient();
  const relog = await fresh('POST', '/api/auth/login', { username: 'tmpuser', password: 'brandnew1' });
  assert.equal(relog.body.user.mustReset, false);
});

test('the desk reports no active SSO session by default', async () => {
  const anon = makeClient();
  const s = await anon('GET', '/api/desk/session');
  assert.equal(s.body.active, false);
});

test('SSO: providers list reflects config; email maps to a provisioned user', async () => {
  const anon = makeClient();
  const prov = await anon('GET', '/api/auth/providers');
  assert.equal(prov.status, 200);
  // No SSO env vars are set in the test environment.
  assert.deepEqual(prov.body.sso, []);
  assert.equal(sso.isEnabled('google'), false);

  // A user with an email is resolvable; an unknown email is not.
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  await mgr('POST', '/api/admin/users', {
    username: 'ssouser', firstName: 'Essa', lastName: 'Oh', role: 'management',
    email: 'Essa.Oh@Example.com', password: 'pw12345678',
  });

  const found = await sso.findUserByEmail('essa.oh@example.com'); // case-insensitive
  assert.ok(found && found.username === 'ssouser');
  const missing = await sso.findUserByEmail('nobody@example.com');
  assert.equal(missing, null);

  // Duplicate email is rejected.
  const dup = await mgr('POST', '/api/admin/users', {
    username: 'ssouser2', firstName: 'Dup', lastName: 'Licate', role: 'security',
    email: 'essa.oh@example.com', password: 'pw12345678',
  });
  assert.equal(dup.status, 409);

  // A deactivated user no longer resolves for SSO.
  await mgr('PATCH', `/api/admin/users/${found.id}`, { isActive: false });
  assert.equal(await sso.findUserByEmail('essa.oh@example.com'), null);
});

test('the print sheet is Letter-sized and embeds a signed QR', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const issued = await c('POST', '/api/passes', { unitNumber: '1204', visitorPlate: 'PRN333' });
  const printed = await c('GET', `/api/passes/${issued.body.passId}/print`);
  assert.equal(printed.status, 200);
  assert.ok(printed.text.includes('8.5in 11in'));
  assert.ok(printed.text.includes('data:image/png;base64,'));
  assert.ok(printed.text.includes('PRN333'));
  assert.ok(printed.text.includes('Expires'));
});

test('bulk unit import: JSON array, CSV, idempotent re-run, and per-row errors', async () => {
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  // 1) JSON array: two new residential units + one new commercial tenant.
  const first = await mgr('POST', '/api/admin/units/import', {
    units: [
      { unitNumber: 'B-201', floor: 2, kind: 'residential' },
      { unitNumber: 'B-202', floor: 2 }, // kind defaults to residential
      { unitNumber: 'C-301', kind: 'commercial', businessName: 'Nook Books', businessContact: 'x@y.z' },
    ],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.inserted, 3);
  assert.equal(first.body.updated, 0);
  assert.equal(first.body.failed, 0);

  // The commercial unit is queryable and carries its business name.
  const look = await mgr('GET', '/api/units?q=C-301');
  assert.ok(look.body.some((u) => u.unit_number === 'C-301' && u.business_name === 'Nook Books'));

  // 2) Re-running the same rows updates in place (idempotent), not duplicates.
  const rerun = await mgr('POST', '/api/admin/units/import', {
    units: [{ unitNumber: 'B-201', floor: 9, kind: 'residential' }],
  });
  assert.equal(rerun.body.inserted, 0);
  assert.equal(rerun.body.updated, 1);

  // 3) CSV import with a header row, aliased column names, and error rows.
  const csv = [
    'unit_number,floor,type,business name',
    'B-203,3,residential,',
    ',4,residential,',                       // missing unit number -> error
    'C-302,1,commercial,',                   // commercial without business name -> error
    'B-203,5,residential,',                  // duplicate within the same import -> error
    'C-303,1,commercial,Deli Corner',        // valid commercial
  ].join('\n');
  const viaCsv = await mgr('POST', '/api/admin/units/import', { csv });
  assert.equal(viaCsv.status, 200);
  assert.equal(viaCsv.body.inserted, 2); // B-203 and C-303
  assert.equal(viaCsv.body.failed, 3);
  const errKinds = viaCsv.body.errors.map((e) => e.error).sort();
  assert.deepEqual(errKinds, ['business_name_required', 'duplicate_in_import', 'unit_number_required']);

  // 4) A missing body is rejected; non-management is forbidden.
  const empty = await mgr('POST', '/api/admin/units/import', {});
  assert.equal(empty.status, 400);
  const sec = makeClient();
  await sec('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const denied = await sec('POST', '/api/admin/units/import', { units: [{ unitNumber: 'Z-1' }] });
  assert.equal(denied.status, 403);
});

test('bulk unit import: accepts an Excel (.xlsx) workbook', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Units');
  ws.addRow(['unit_number', 'floor', 'type', 'business name']);
  ws.addRow(['X-900', 9, 'residential', '']);
  ws.addRow(['X-901', 9, 'residential', '']);
  ws.addRow(['C-950', 1, 'commercial', 'Test Bakery']);
  ws.addRow(['', 3, 'residential', '']); // blank unit number -> error row
  const xlsxBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const imp = await mgr('POST', '/api/admin/units/import', { xlsxBase64 });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.inserted, 3);
  assert.equal(imp.body.failed, 1);
  assert.equal(imp.body.errors[0].error, 'unit_number_required');

  // Idempotent: re-importing the same workbook updates in place.
  const again = await mgr('POST', '/api/admin/units/import', { xlsxBase64 });
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.updated, 3);

  // Garbage base64 is rejected cleanly (not a 500).
  const bad = await mgr('POST', '/api/admin/units/import', { xlsxBase64: 'bm90LWFuLXhsc3g=' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_xlsx');
});

test('account self-edit: details editable by all; role only by a superuser', async () => {
  // Management (a bootstrapped superuser) can edit details AND change role.
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const acct = await mgr('GET', '/api/auth/account');
  assert.equal(acct.status, 200);
  assert.equal(acct.body.is_superuser, true);

  const edit = await mgr('PATCH', '/api/auth/account', {
    firstName: 'Morgan', lastName: 'Manager-Smith', email: 'morgan@example.com',
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.full_name, 'Morgan Manager-Smith');
  assert.equal(edit.body.email, 'morgan@example.com');

  // Security (not a superuser) may edit their own details...
  const sec = makeClient();
  await sec('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const secAcct = await sec('GET', '/api/auth/account');
  assert.equal(secAcct.body.is_superuser, false);
  const secEdit = await sec('PATCH', '/api/auth/account', { firstName: 'Samuel', email: 'sam@example.com' });
  assert.equal(secEdit.status, 200);
  assert.equal(secEdit.body.email, 'sam@example.com');

  // ...but NOT change their own role.
  const secRole = await sec('PATCH', '/api/auth/account', { role: 'management' });
  assert.equal(secRole.status, 403);
  assert.equal(secRole.body.error, 'role_change_forbidden');

  // A superuser changing their own role succeeds and re-scopes their nav/views.
  const mgrRole = await mgr('PATCH', '/api/auth/account', { role: 'board' });
  assert.equal(mgrRole.status, 200);
  assert.equal(mgrRole.body.role, 'board');
  // Superuser status is independent of role — still a superuser after the change.
  assert.equal(mgrRole.body.is_superuser, true);
  // Restore manager1 to management so later tests (which share this DB) still
  // have a management/superuser account to log in with.
  const restore = await mgr('PATCH', '/api/auth/account', { role: 'management' });
  assert.equal(restore.body.role, 'management');

  // Duplicate username is rejected.
  const dup = await sec('PATCH', '/api/auth/account', { username: 'board1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'username_taken');
});

test('admin: only a superuser can change another user\'s role or superuser flag', async () => {
  // Seed a second, non-superuser management account.
  const pw = await password.hash('changeme123');
  await db.query(
    `INSERT INTO users (username, full_name, role, password_hash, is_superuser)
     VALUES ('manager2','Max Manager','management',$1,FALSE)
     ON CONFLICT (username) DO UPDATE SET is_superuser = FALSE, role = 'management'`,
    [pw]
  );

  const sup = makeClient();
  await sup('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const target = await sup('GET', '/api/admin/users');
  const secUser = target.body.find((u) => u.username === 'security1');

  // Non-superuser manager: can edit names, but not role or the superuser flag.
  const plain = makeClient();
  await plain('POST', '/api/auth/login', { username: 'manager2', password: 'changeme123' });
  const nameOnly = await plain('PATCH', `/api/admin/users/${secUser.id}`, { firstName: 'Renamed' });
  assert.equal(nameOnly.status, 200);
  const roleTry = await plain('PATCH', `/api/admin/users/${secUser.id}`, { role: 'board' });
  assert.equal(roleTry.status, 403);
  assert.equal(roleTry.body.error, 'superuser_required');
  const supTry = await plain('PATCH', `/api/admin/users/${secUser.id}`, { isSuperuser: true });
  assert.equal(supTry.status, 403);

  // Superuser manager: can grant the superuser flag and change roles.
  const grant = await sup('PATCH', `/api/admin/users/${secUser.id}`, { isSuperuser: true });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.is_superuser, true);
});

test('manage users: delete removes a clean account but protects one with history', async () => {
  const sup = makeClient();
  await sup('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });

  // A freshly-created account with no activity can be deleted.
  const created = await sup('POST', '/api/admin/users', {
    username: 'temp_delete', firstName: 'Temp', lastName: 'Delete', role: 'security', password: 'pw12345678',
  });
  assert.equal(created.status, 201);
  const del = await sup('DELETE', `/api/admin/users/${created.body.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 'temp_delete');
  const list = await sup('GET', '/api/admin/users');
  assert.ok(!list.body.some((u) => u.username === 'temp_delete'));

  // You cannot delete your own account.
  const me = list.body.find((u) => u.username === 'manager1');
  const self = await sup('DELETE', `/api/admin/users/${me.id}`);
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'cannot_delete_self');

  // An account with activity history is protected by foreign keys. Create one
  // and give it an audit entry so the check is deterministic regardless of what
  // earlier tests cleared.
  const pw = await password.hash('changeme123');
  const hist = await db.query(
    `INSERT INTO users (username, full_name, role, password_hash) VALUES ('hist_user','Hist User','security',$1) RETURNING id`,
    [pw]
  );
  await db.query(`INSERT INTO pass_audit_log (action, actor_id) VALUES ('issued', $1)`, [hist.rows[0].id]);
  const protectedDel = await sup('DELETE', `/api/admin/users/${hist.rows[0].id}`);
  assert.equal(protectedDel.status, 409);
  assert.equal(protectedDel.body.error, 'user_has_history');

  // A non-superuser manager cannot delete accounts at all.
  await db.query(
    `INSERT INTO users (username, full_name, role, password_hash, is_superuser)
     VALUES ('plainmgr','Plain Mgr','management',$1,FALSE)
     ON CONFLICT (username) DO UPDATE SET is_superuser = FALSE`,
    [pw]
  );
  const plain = makeClient();
  await plain('POST', '/api/auth/login', { username: 'plainmgr', password: 'changeme123' });
  const forbidden = await plain('DELETE', `/api/admin/users/${hist.rows[0].id}`);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, 'superuser_required');
});

test('password reset by email: request is generic; token sets a new password', async () => {
  const crypto = require('node:crypto');
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  // Give manager1 an email so a reset can be issued.
  await db.query(`UPDATE users SET email = 'boss@example.com' WHERE username = 'manager1'`);
  const uid = (await db.query(`SELECT id FROM users WHERE username = 'manager1'`)).rows[0].id;

  const anon = makeClient();

  // A request for an unknown identifier still returns the same generic message
  // (no account enumeration) and creates no reset row.
  const unknown = await anon('POST', '/api/auth/forgot-password', { identifier: 'nobody@nowhere.com' });
  assert.equal(unknown.status, 200);
  assert.match(unknown.body.message, /reset link/i);
  assert.equal((await db.query(`SELECT count(*)::int n FROM password_resets`)).rows[0].n, 0);

  // A real, active account gets a reset row (the raw token is emailed, so the
  // test can't read it — it's only stored hashed).
  const req = await anon('POST', '/api/auth/forgot-password', { identifier: 'manager1' });
  assert.equal(req.status, 200);
  const rows = (await db.query(`SELECT token_hash, used_at FROM password_resets WHERE user_id = $1`, [uid])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].used_at, null);

  // Simulate clicking the emailed link: insert a known token and consume it.
  const raw = 'test-reset-token-abc123';
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [uid, sha256(raw)]
  );
  const bad = await anon('POST', '/api/auth/reset-password', { token: 'wrong', newPassword: 'brandNew123' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_or_expired_token');

  const ok = await anon('POST', '/api/auth/reset-password', { token: raw, newPassword: 'brandNew123' });
  assert.equal(ok.status, 200);

  // The token is single-use.
  const reuse = await anon('POST', '/api/auth/reset-password', { token: raw, newPassword: 'another123' });
  assert.equal(reuse.status, 400);

  // The new password now works for login.
  const login = await anon('POST', '/api/auth/login', { username: 'manager1', password: 'brandNew123' });
  assert.equal(login.status, 200);

  // Restore manager1's password so later shared-DB tests are unaffected.
  await db.query(
    `UPDATE users SET password_hash = $1 WHERE username = 'manager1'`,
    [await password.hash('changeme123')]
  );
});

test('password reset is refused for a disabled account', async () => {
  // Deactivate board1 and confirm no reset link is issued (must use recovery).
  await db.query(`UPDATE users SET email = 'b@example.com', is_active = FALSE WHERE username = 'board1'`);
  const uid = (await db.query(`SELECT id FROM users WHERE username = 'board1'`)).rows[0].id;
  const anon = makeClient();
  const req = await anon('POST', '/api/auth/forgot-password', { identifier: 'board1' });
  assert.equal(req.status, 200); // still generic
  const n = (await db.query(`SELECT count(*)::int n FROM password_resets WHERE user_id = $1`, [uid])).rows[0].n;
  assert.equal(n, 0);
  // Re-activate so we don't leave the shared DB in a surprising state.
  await db.query(`UPDATE users SET is_active = TRUE WHERE username = 'board1'`);
});
