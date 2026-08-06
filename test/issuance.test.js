'use strict';
// ============================================================================
//  Issuance-rule tests: one active pass per unit at a time, the 10/year cap,
//  and the new duration modes end-to-end through the API.
//
//  Shares the database with the other suites; test files run serially
//  (--test-concurrency=1) so this before()'s truncate/seed doesn't race them.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-integration-tests';
process.env.BARCODE_SECRET = process.env.BARCODE_SECRET || 'test-barcode-secret-different-value-xyz';
process.env.ANNUAL_PASS_QUOTA = process.env.ANNUAL_PASS_QUOTA || '10';

const app = require('../src/server');
const db = require('../src/db');
const password = require('../src/auth/password');

let base;
let server;

function makeClient() {
  let cookie = '';
  return async function call(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setC = res.headers.get('set-cookie');
    if (setC) cookie = setC.split(';')[0];
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
    return { status: res.status, body: json };
  };
}

test.before(async () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(schema);
  await db.query(
    `TRUNCATE pass_requests, auth_audit_log, pass_audit_log, override_grants, visitor_passes,
              registered_vehicles, residents, units, users RESTART IDENTITY CASCADE`
  );
  const pw = await password.hash('changeme123');
  await db.query(
    `INSERT INTO users (username, full_name, role, password_hash) VALUES ('officer1','Ivy Officer','security',$1)`,
    [pw]
  );
  for (const un of ['IU-1', 'IU-2', 'IU-3']) {
    await db.query(`INSERT INTO units (unit_number) VALUES ($1)`, [un]);
  }
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.beforeEach(async () => {
  await db.query(`TRUNCATE pass_audit_log, override_grants, visitor_passes RESTART IDENTITY CASCADE`);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

test('a unit may hold only one active pass at a time', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'officer1', password: 'changeme123' });

  const a = await c('POST', '/api/passes', { unitNumber: 'IU-1', visitorPlate: 'AAA111', durationPreset: 'short_stay' });
  assert.equal(a.status, 201, JSON.stringify(a.body));

  // Second pass for the same unit is refused while A is live.
  const b = await c('POST', '/api/passes', { unitNumber: 'IU-1', visitorPlate: 'BBB222', durationPreset: 'short_stay' });
  assert.equal(b.status, 409);
  assert.equal(b.body.error, 'unit_already_has_active_pass');

  // Revoking A frees the unit; B can then be issued.
  const rev = await c('POST', `/api/passes/${a.body.passId}/revoke`, {});
  assert.equal(rev.status, 200);
  const b2 = await c('POST', '/api/passes', { unitNumber: 'IU-1', visitorPlate: 'BBB222', durationPreset: 'short_stay' });
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
});

test('vacating (not just revoking) also frees the unit for a new pass', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'officer1', password: 'changeme123' });
  const a = await c('POST', '/api/passes', { unitNumber: 'IU-3', visitorPlate: 'VAC100' });
  assert.equal(a.status, 201);
  await c('POST', `/api/passes/${a.body.passId}/vacate`, {});
  const b = await c('POST', '/api/passes', { unitNumber: 'IU-3', visitorPlate: 'VAC200' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
});

test('the 10-per-year cap blocks the 11th pass for a unit', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'officer1', password: 'changeme123' });
  // Issue then vacate 10 passes so the unit never holds two at once (the cap,
  // not the one-active rule, is what we're exercising).
  for (let i = 0; i < 10; i++) {
    const r = await c('POST', '/api/passes', { unitNumber: 'IU-2', visitorPlate: 'Y' + i });
    assert.equal(r.status, 201, `pass ${i}: ${JSON.stringify(r.body)}`);
    await c('POST', `/api/passes/${r.body.passId}/vacate`, {});
  }
  const blocked = await c('POST', '/api/passes', { unitNumber: 'IU-2', visitorPlate: 'Y10' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'quota_exceeded');
  assert.equal(blocked.body.quota.used, 10);
});

test('the new duration modes flow through the API (expiry + stored mode)', async () => {
  const c = makeClient();
  await c('POST', '/api/auth/login', { username: 'officer1', password: 'changeme123' });

  const overnight = await c('POST', '/api/passes', { unitNumber: 'IU-1', visitorPlate: 'OVN100', durationPreset: 'overnight' });
  assert.equal(overnight.status, 201, JSON.stringify(overnight.body));
  assert.equal(new Date(overnight.body.expiresAt).getHours(), 8); // 8 AM local next day
  const mode = await db.query('SELECT duration_mode FROM visitor_passes WHERE id = $1', [overnight.body.passId]);
  assert.equal(mode.rows[0].duration_mode, 'overnight');

  const shortStay = await c('POST', '/api/passes', { unitNumber: 'IU-2', visitorPlate: 'SHT100', durationPreset: 'short_stay' });
  assert.equal(shortStay.status, 201);
  const stored = await db.query('SELECT duration_mode FROM visitor_passes WHERE id = $1', [shortStay.body.passId]);
  assert.equal(stored.rows[0].duration_mode, 'short_stay');
});
