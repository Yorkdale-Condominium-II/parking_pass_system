'use strict';
const jwt = require('jsonwebtoken');
const config = require('./../config');

// ============================================================================
//  Authentication + Role-Based Access Control middleware
// ============================================================================

/**
 * Issue a signed session JWT for a user record.
 */
function issueSession(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name, username: user.username,
      mr: Boolean(user.must_reset_password) },
    config.jwtSecret,
    { issuer: config.jwtIssuer, expiresIn: '8h' }
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
 * `Authorization: Bearer <token>` header. Populates req.user.
 */
function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.session || bearer;
  if (!token) return res.status(401).json({ error: 'authentication_required' });

  try {
    const claims = jwt.verify(token, config.jwtSecret, { issuer: config.jwtIssuer });
    req.user = { id: claims.sub, role: claims.role, name: claims.name, username: claims.username, mustReset: Boolean(claims.mr) };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_session' });
  }
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

module.exports = { issueSession, issueDeskSession, verifyDeskSession, requireAuth, requireRole };
