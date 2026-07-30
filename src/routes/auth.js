'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./../db');
const password = require('./../auth/password');
const { issueSession, requireAuth } = require('./../auth/middleware');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test', // don't throttle the test suite
});

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
  const r = await db.query(
    `SELECT username, first_name, last_name, full_name, role, email, sso_provider
       FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json(r.rows[0]);
});

module.exports = router;
