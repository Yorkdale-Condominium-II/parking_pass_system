'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./../db');
const config = require('./../config');
const password = require('./../auth/password');
const mailer = require('./../services/mailer');
const { issueSession, requireAuth } = require('./../auth/middleware');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test', // don't throttle the test suite
});

// A separate, tighter limiter for the public "forgot password" endpoint.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

const RESET_TTL_MINUTES = 60;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Record a sign-in event. Never throws into the request path.
async function logAuth({ userId, username, event, success, req }) {
  try {
    await db.query(
      `INSERT INTO auth_audit_log (user_id, username, event, success, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, username || '(unknown)', event, Boolean(success),
       req.ip || req.socket?.remoteAddress || null,
       (req.headers['user-agent'] || '').slice(0, 300)]
    );
  } catch { /* auditing must not break authentication */ }
}

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password: pw } = req.body || {};
  if (!username || !pw) {
    return res.status(400).json({ error: 'username_and_password_required' });
  }
  const result = await db.query(
    `SELECT * FROM users WHERE username = $1 AND is_active = TRUE`,
    [username]
  );
  const user = result.rows[0];
  // Always run a compare to keep timing uniform whether or not the user exists.
  const ok = user
    ? await password.verify(pw, user.password_hash)
    : await password.verify(pw, '$2a$12$0000000000000000000000000000000000000000000000000000');
  if (!user || !ok) {
    await logAuth({ userId: user?.id, username, event: 'login_failed', success: false, req });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  await logAuth({ userId: user.id, username: user.username, event: 'login_success', success: true, req });
  const token = issueSession(user);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 3600 * 1000,
  });
  res.json({
    token,
    user: { id: user.id, username: user.username, name: user.full_name, role: user.role,
            mustReset: Boolean(user.must_reset_password) },
  });
});

// Change own password (also used to satisfy a forced reset). Clears the flag
// and re-issues the session so the user proceeds immediately.
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'password_too_short' });
  const r = await db.query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  if (!(await password.verify(currentPassword || '', user.password_hash))) {
    return res.status(401).json({ error: 'wrong_current_password' });
  }
  const hash = await password.hash(newPassword);
  await db.query(
    `UPDATE users SET password_hash = $1, must_reset_password = FALSE, updated_at = now() WHERE id = $2`,
    [hash, user.id]
  );
  const token = issueSession({ ...user, must_reset_password: false });
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000,
  });
  res.json({ ok: true });
});

// --- Self-service password reset -------------------------------------------
// Step 1: request a reset link. Accepts a username or email. Always responds
// the same way whether or not a match exists, so the endpoint can't be used to
// probe which usernames/emails are registered. Only ACTIVE accounts with an
// email on file can actually receive a link; a disabled account must be
// restored locally with recover-admin (a reset would be pointless — login
// rejects inactive accounts).
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const identifier = String((req.body || {}).identifier || '').trim();
  const generic = { ok: true, message: 'If that account exists, a reset link has been emailed.' };
  if (!identifier) return res.status(400).json({ error: 'identifier_required' });

  const r = await db.query(
    `SELECT id, email, full_name FROM users
      WHERE is_active = TRUE AND (lower(username) = lower($1) OR lower(email) = lower($1))
      LIMIT 1`,
    [identifier]
  );
  const user = r.rows[0];
  if (user && user.email) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
    // Invalidate any outstanding tokens for this user, then store the new hash.
    await db.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [user.id, sha256(rawToken), expires]
    );
    const link = `${config.oauthBaseUrl}/?reset=${rawToken}`;
    const subject = 'Reset your parking management password';
    const text = `Hello ${user.full_name},\n\n`
      + `A password reset was requested for your account. Use the link below to set a new password. `
      + `It expires in ${RESET_TTL_MINUTES} minutes.\n\n${link}\n\n`
      + `If you didn't request this, you can ignore this email — your password won't change.`;
    const html = `<p>Hello ${user.full_name},</p>`
      + `<p>A password reset was requested for your account. Click the link below to set a new password. `
      + `It expires in ${RESET_TTL_MINUTES} minutes.</p>`
      + `<p><a href="${link}">Reset my password</a></p>`
      + `<p>If you didn't request this, you can ignore this email — your password won't change.</p>`;
    await mailer.sendMail({ to: user.email, subject, text, html });
  }
  // Always the same response, regardless of match/email/send outcome.
  res.json(generic);
});

// Step 2: consume the token and set a new password.
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_required' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'password_too_short' });

  const r = await db.query(
    `SELECT pr.id, pr.user_id FROM password_resets pr
       JOIN users u ON u.id = pr.user_id AND u.is_active = TRUE
      WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
      LIMIT 1`,
    [sha256(String(token))]
  );
  const reset = r.rows[0];
  if (!reset) return res.status(400).json({ error: 'invalid_or_expired_token' });

  const hash = await password.hash(newPassword);
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $1, must_reset_password = FALSE, updated_at = now() WHERE id = $2`,
      [hash, reset.user_id]
    );
    await client.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [reset.id]);
  });
  res.json({ ok: true });
});

router.post('/logout', requireAuth, async (req, res) => {
  await logAuth({ userId: req.user.id, username: req.user.username, event: 'logout', success: true, req });
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user }); // includes mustReset
});

// Which SSO providers are configured (drives the login-page buttons).
router.get('/providers', (req, res) => {
  const sso = require('./../auth/sso');
  res.json({ sso: sso.enabledProviders() });
});

// The signed-in user's own account details (for the Account screen).
router.get('/account', requireAuth, async (req, res) => {
  const core = 'username, first_name, last_name, full_name, role, email, sso_provider';
  let row;
  try {
    const r = await db.query(`SELECT ${core}, is_superuser FROM users WHERE id = $1`, [req.user.id]);
    row = r.rows[0];
  } catch (err) {
    // Tolerate a not-yet-migrated DB (is_superuser missing) so the account
    // screen still shows what's on file instead of failing to load entirely.
    if (err.code !== '42703') throw err;
    const r = await db.query(`SELECT ${core} FROM users WHERE id = $1`, [req.user.id]);
    row = r.rows[0] ? { ...r.rows[0], is_superuser: false } : undefined;
  }
  if (!row) return res.status(404).json({ error: 'user_not_found' });
  res.json(row);
});

// Self-service edit of the signed-in user's own account. Username, name, and
// email are always editable; role can only be changed by a superuser. Because
// username/name/role are embedded in the session token, we re-issue it so the
// change takes effect immediately without a re-login.
router.patch('/account', requireAuth, async (req, res) => {
  const { username, firstName, lastName, email, role } = req.body || {};
  const cur = await db.query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
  if (cur.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });

  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (username !== undefined) {
    if (!String(username).trim()) return res.status(400).json({ error: 'username_required' });
    add('username', String(username).trim());
  }
  if (firstName !== undefined) add('first_name', String(firstName).trim());
  if (lastName !== undefined) add('last_name', String(lastName).trim());
  if (email !== undefined) add('email', (String(email).trim() || null));
  if (role !== undefined && role !== cur.rows[0].role) {
    // Only superusers may change a role — including their own.
    if (!cur.rows[0].is_superuser) return res.status(403).json({ error: 'role_change_forbidden' });
    if (!['security', 'management', 'board'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }
    add('role', role);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });

  params.push(req.user.id);
  try {
    await db.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
  } catch (err) {
    if (err.code === '23505') {
      const which = /email/i.test(err.constraint || '') ? 'email_taken' : 'username_taken';
      return res.status(409).json({ error: which });
    }
    throw err;
  }
  // Keep full_name derived from the (now-updated) first/last name columns.
  const updated = await db.query(
    `UPDATE users SET full_name = trim(concat_ws(' ', first_name, last_name))
      WHERE id = $1 RETURNING *`,
    [req.user.id]
  );

  const u = updated.rows[0];
  const token = issueSession(u);
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000,
  });
  res.json({
    username: u.username, first_name: u.first_name, last_name: u.last_name,
    full_name: u.full_name, role: u.role, email: u.email,
    sso_provider: u.sso_provider, is_superuser: u.is_superuser,
  });
});

module.exports = router;
