'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./../config');
const db = require('./../db');

// ============================================================================
//  Authentication + Role-Based Access Control middleware
// ============================================================================

/**
 * Issue a signed session JWT for a user record AND record the session so it can
 * be revoked before its 8-hour expiry. The token embeds a random `jti`; the
 * matching auth_sessions row is written (awaited) before the token is returned.
 */
async function issueSession(user) {
  const jti = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const token = jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name, username: user.username,
      mr: Boolean(user.must_reset_password), jti },
    config.jwtSecret,
    { issuer: config.jwtIssuer, expiresIn: '8h' }
  );
  await db.query(
    `INSERT INTO auth_sessions (user_id, jti, expires_at)
     VALUES ($1, $2, now() + interval '8 hours')`,
    [user.id, jti]
  );
  return token;
}

/**
 * Revoke a single session by its jti (idempotent — a no-op if already revoked
 * or unknown). Used by logout and, indirectly, by the admin revoke endpoints.
 */
async function revokeSession(jti, reason) {
  if (!jti) return;
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE jti = $1 AND revoked_at IS NULL`,
    [jti, reason || null]
  );
}

// A short-lived desk session (started via Google/Microsoft at the kiosk).
function issueDeskSession(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name, username: user.username, desk: true },
    config.jwtSecret,
    { issuer: config.jwtIssuer, expiresIn: `${config.deskSessionMinutes}m` }
  );
}
function verifyDeskSession(token) {
  try {
    const c = jwt.verify(token, config.jwtSecret, { issuer: config.jwtIssuer });
    return c.desk ? c : null;
  } catch { return null; }
}

/**
 * Require a valid session. Token is read from the httpOnly cookie or the
 * `Authorization: Bearer <token>` header. Beyond verifying the JWT signature we
 * also (1) confirm the session's jti is still active — so logout / admin revoke
 * take effect before the 8-hour expiry — and (2) re-read the live role and
 * active flag from the DB, so a demoted or deactivated user is locked out
 * immediately rather than on their next login. Populates req.user.
 */
async function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.session || bearer;
  if (!token) return res.status(401).json({ error: 'authentication_required' });

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { issuer: config.jwtIssuer });
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_session' });
  }

  // Validate the session is still active (not revoked / not past expiry).
  const s = await db.query(
    `SELECT 1 FROM auth_sessions WHERE jti = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [claims.jti]
  );
  if (s.rowCount === 0) return res.status(401).json({ error: 'session_revoked' });

  // Re-read the live role / active flag so a demoted or disabled user is locked
  // out immediately (the JWT's copy of the role is no longer authoritative).
  const r = await db.query(
    `SELECT role, is_active, full_name FROM users WHERE id = $1`,
    [claims.sub]
  );
  if (r.rowCount === 0 || !r.rows[0].is_active) {
    return res.status(401).json({ error: 'session_invalid' });
  }

  req.user = {
    id: claims.sub, role: r.rows[0].role, name: r.rows[0].full_name,
    username: claims.username, mustReset: Boolean(claims.mr), jti: claims.jti,
  };
  return next();
}

/**
 * Restrict a route to one or more roles.
 *   router.post('/x', requireAuth, requireRole('management'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication_required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', requiredRoles: roles });
    }
    return next();
  };
}

module.exports = { issueSession, revokeSession, issueDeskSession, verifyDeskSession, requireAuth, requireRole };
