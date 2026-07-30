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
    user: { id: user.id, username: user.username, name: user.full_name, role: user.role },
  });
});

router.post('/logout', requireAuth, async (req, res) => {
  await logAuth({ userId: req.user.id, username: req.user.username, event: 'logout', success: true, req });
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
