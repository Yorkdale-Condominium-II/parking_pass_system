'use strict';
// ============================================================================
//  Revocable-session tests (v16 auth_sessions).
//
//  Verifies that a login JWT can be invalidated server-side before its 8-hour
//  expiry: logout kills the caller's session, and "sign out other devices"
//  kills every OTHER active session for the user while sparing the caller's.
//
//  Shares the database with integration.test.js; test files are run serially
//  (see the --test-concurrency=1 flag in package.json's test script) so the
//  before() truncate/seed here does not race the other suite.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-integration-tests';
process.env.BARCODE_SECRET = process.env.BARCODE_SECRET || 'test-barcode-secret-different-value-xyz';

const app = require('../src/server');
const db = require('../src/db');
const password = require('../src/auth/password');

let base;
let server;

// A fetch client whose cookie jar we can freeze, so we can hold on to one login
// while starting another (simulating two devices / two sessions).
function makeClient() {
  let cookie = '';
  const call = async (method, p, body) => {
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
  call.cookie = () => cookie;
  call.setCookie = (c) => { cookie = c; };
  return call;
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
    `INSERT INTO users (username, full_name, role, password_hash) VALUES ('sessuser','Sess User','security',$1)`,
    [pw]
  );
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

test('logout revokes the session: the same cookie is rejected afterwards', async () => {
  const c = makeClient();
  const login = await c('POST', '/api/auth/login', { username: 'sessuser', password: 'changeme123' });
  assert.equal(login.status, 200);

  // The session works before logout.
  const meBefore = await c('GET', '/api/auth/me');
  assert.equal(meBefore.status, 200);
  assert.equal(meBefore.body.user.username, 'sessuser');

  const savedCookie = c.cookie(); // capture the token cookie before logout clears it
  const out = await c('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);

  // Replay the captured cookie — the session is revoked, so it must be rejected.
  const replay = makeClient();
  replay.setCookie(savedCookie);
  const meAfter = await replay('GET', '/api/auth/me');
  assert.equal(meAfter.status, 401);
  assert.equal(meAfter.body.error, 'session_revoked');
});

test('revoke-all kills other sessions but keeps the caller signed in', async () => {
  // Two independent logins for the same user = two sessions (A then B).
  const a = makeClient();
  await a('POST', '/api/auth/login', { username: 'sessuser', password: 'changeme123' });
  const b = makeClient();
  await b('POST', '/api/auth/login', { username: 'sessuser', password: 'changeme123' });

  // Both are valid to start.
  assert.equal((await a('GET', '/api/auth/me')).status, 200);
  assert.equal((await b('GET', '/api/auth/me')).status, 200);

  // B signs out all OTHER devices → A dies, B survives.
  const revoke = await b('POST', '/api/auth/sessions/revoke-all', {});
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.revoked, 1); // exactly session A

  const aAfter = await a('GET', '/api/auth/me');
  assert.equal(aAfter.status, 401);
  assert.equal(aAfter.body.error, 'session_revoked');

  const bAfter = await b('GET', '/api/auth/me');
  assert.equal(bAfter.status, 200); // caller's own session is spared
});

test('admin session revoke and deactivation both end a user\'s sessions', async () => {
  // A manager (superuser) to drive the admin endpoints.
  const pw = await password.hash('changeme123');
  await db.query(
    `INSERT INTO users (username, full_name, role, password_hash, is_superuser)
     VALUES ('sessmgr','Sess Manager','management',$1,TRUE)
     ON CONFLICT (username) DO UPDATE SET is_superuser = TRUE, is_active = TRUE`,
    [pw]
  );
  const mgr = makeClient();
  await mgr('POST', '/api/auth/login', { username: 'sessmgr', password: 'changeme123' });

  // Target user logs in.
  const victim = makeClient();
  await victim('POST', '/api/auth/login', { username: 'sessuser', password: 'changeme123' });
  assert.equal((await victim('GET', '/api/auth/me')).status, 200);

  const uid = (await db.query(`SELECT id FROM users WHERE username = 'sessuser'`)).rows[0].id;
  const revoked = await mgr('POST', `/api/admin/users/${uid}/sessions/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.revoked >= 1);

  // The victim is now signed out.
  assert.equal((await victim('GET', '/api/auth/me')).status, 401);

  // Deactivating a user also revokes their live sessions (belt and suspenders).
  const again = makeClient();
  await again('POST', '/api/auth/login', { username: 'sessuser', password: 'changeme123' });
  assert.equal((await again('GET', '/api/auth/me')).status, 200);
  await mgr('PATCH', `/api/admin/users/${uid}`, { isActive: false });
  const afterDeactivate = await again('GET', '/api/auth/me');
  assert.equal(afterDeactivate.status, 401);
  // Re-activate so the shared user is usable by any later-seeded state.
  await db.query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [uid]);
});
