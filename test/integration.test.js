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
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-integration-tests';
process.env.BARCODE_SECRET = process.env.BARCODE_SECRET || 'test-barcode-secret-different-value-xyz';
process.env.ANNUAL_PASS_QUOTA = process.env.ANNUAL_PASS_QUOTA || '10';

const app = require('../src/server');
const db = require('../src/db');
const password = require('../src/auth/password');
const barcode = require('../src/crypto/barcode');

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
    return { status: res.status, body: json, text };
  };
}

test.before(async () => {
  // Apply schema (idempotent) then reset the tables this suite touches.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(schema);
  await db.query(
    `TRUNCATE pass_audit_log, override_grants, visitor_passes,
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
  for (const un of ['1204', '0805']) {
    await db.query(`INSERT INTO units (unit_number) VALUES ($1)`, [un]);
  }
  const unit = await db.query(`SELECT id FROM units WHERE unit_number = '1204'`);
  await db.query(
    `INSERT INTO registered_vehicles (unit_id, licence_plate, province, make, model, color)
     VALUES ($1, 'ABCD123', 'ON', 'Toyota', 'Corolla', 'Silver')`,
    [unit.rows[0].id]
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

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

  const look = await c('GET', '/api/passes/lookup?plate=abcd123'); // lower-case on purpose
  assert.equal(look.status, 200);
  assert.equal(look.body.registeredVehicles.length, 1);
  assert.equal(look.body.registeredVehicles[0].unit_number, '1204');
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
  for (let i = 0; i < 10; i++) {
    const r = await c('POST', '/api/passes', { unitNumber: '0805', visitorPlate: 'Q' + i });
    assert.equal(r.status, 201, `pass #${i + 1} should succeed`);
  }
  const blocked = await c('POST', '/api/passes', { unitNumber: '0805', visitorPlate: 'Q10' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'quota_exceeded');
  assert.equal(blocked.body.quota.used, 10);
});

test('security cannot override, management can', async () => {
  const sec = makeClient();
  await sec('POST', '/api/auth/login', { username: 'security1', password: 'changeme123' });
  const denied = await sec('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR1', override: true, overrideReason: 'nope',
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'override_not_authorized');

  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'manager1', password: 'changeme123' });
  const ok = await mgr('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR1', override: true, overrideReason: 'Board-approved overflow',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.usedOverride, true);

  // Management override without a reason is rejected.
  const noReason = await mgr('POST', '/api/passes', {
    unitNumber: '0805', visitorPlate: 'OVR2', override: true,
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error, 'override_reason_required');
});

test('board sees aggregates but is denied resident/plate data', async () => {
  const board = makeClient();
  await board('POST', '/api/auth/login', { username: 'board1', password: 'changeme123' });

  const summary = await board('GET', '/api/board/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.body.totals.total_passes >= 11);
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
    username: 'security2', fullName: 'Sky Security', role: 'security', password: 'pw12345678',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'security');

  const audit = await mgr('GET', '/api/admin/audit?limit=50');
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.body));
  assert.ok(audit.body.some((r) => r.action === 'issued'));
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
