'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./../config');
const db = require('./../db');
const sso = require('./../auth/sso');
const { issueSession, issueDeskSession, requireAuth } = require('./../auth/middleware');

const router = express.Router();
const TX_COOKIE = 'sso_tx';
const secure = config.oauthBaseUrl.startsWith('https://');

async function logAuth({ userId, username, event, success, req }) {
  try {
    await db.query(
      `INSERT INTO auth_audit_log (user_id, username, event, success, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, username || '(sso)', event, Boolean(success),
       req.ip || null, (req.headers['user-agent'] || '').slice(0, 300)]
    );
  } catch { /* never break auth on audit failure */ }
}

// Kick off an OAuth flow in a given mode: 'login' | 'link' | 'desk'.
async function begin(req, res, provider, mode, userId) {
  if (!sso.isEnabled(provider)) return res.status(404).send('SSO provider not enabled');
  const client = await sso.getClient(provider);
  const { code_verifier, code_challenge, state } = sso.makeAuthRequest(client);
  const tx = jwt.sign({ provider, state, code_verifier, mode, userId }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie(TX_COOKIE, tx, { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60 * 1000 });
  res.redirect(client.authorizationUrl({
    scope: 'openid email profile', code_challenge, code_challenge_method: 'S256', state,
  }));
}

// Login with SSO (public). Matches a provisioned, active user.
router.get('/:provider/start', (req, res) => begin(req, res, req.params.provider, 'login'));

// Link the signed-in user's account to their Google/Microsoft (requires session).
router.get('/:provider/link', requireAuth, (req, res) => begin(req, res, req.params.provider, 'link', req.user.id));

// Start a short desk session at the kiosk (public).
router.get('/:provider/desk', (req, res) => begin(req, res, req.params.provider, 'desk'));

// Single callback for all modes.
router.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const back = (mode) => (mode === 'desk' ? '/desk.html' : '/');
  const fail = (mode, reason) => res.redirect(`${back(mode)}?sso_error=${encodeURIComponent(reason)}`);

  let tx;
  try { tx = jwt.verify(req.cookies?.[TX_COOKIE] || '', config.jwtSecret); }
  catch { return fail('login', 'expired'); }
  res.clearCookie(TX_COOKIE);
  if (tx.provider !== provider) return fail(tx.mode, 'mismatch');

  let claims;
  try {
    const client = await sso.getClient(provider);
    const tokenSet = await client.callback(sso.redirectUri(provider), client.callbackParams(req),
      { state: tx.state, code_verifier: tx.code_verifier });
    claims = tokenSet.claims();
  } catch {
    await logAuth({ event: 'sso_error', success: false, req });
    return fail(tx.mode, 'exchange_failed');
  }

  const email = claims.email;
  if (!email || (provider === 'google' && claims.email_verified === false)) {
    return fail(tx.mode, 'email_unverified');
  }

  // --- Link mode: attach this identity to the already-signed-in user. -------
  if (tx.mode === 'link') {
    try {
      await db.query(
        `UPDATE users SET email = $1, sso_provider = $2, sso_subject = $3, updated_at = now() WHERE id = $4`,
        [email, provider, claims.sub, tx.userId]
      );
    } catch (err) {
      // Unique-email violation → this email is already linked elsewhere.
      if (err.code === '23505') return fail('link', 'email_taken');
      throw err;
    }
    await logAuth({ userId: tx.userId, username: email, event: 'sso_linked', success: true, req });
    return res.redirect('/?linked=1');
  }

  // --- Login / desk modes: resolve to a provisioned, active user. -----------
  const user = await sso.findUserForLogin(provider, claims.sub, email);
  if (!user) {
    await logAuth({ username: email, event: 'sso_not_provisioned', success: false, req });
    return fail(tx.mode, 'not_provisioned');
  }

  if (tx.mode === 'desk') {
    if (!['security', 'management'].includes(user.role)) return fail('desk', 'not_desk_role');
    await logAuth({ userId: user.id, username: user.username, event: 'desk_session', success: true, req });
    res.cookie('desk_session', issueDeskSession(user), {
      httpOnly: true, sameSite: 'lax', secure, maxAge: config.deskSessionMinutes * 60 * 1000,
    });
    return res.redirect('/desk.html');
  }

  // login
  await logAuth({ userId: user.id, username: user.username, event: 'login_success', success: true, req });
  res.cookie('session', await issueSession(user), {
    httpOnly: true, sameSite: 'strict', secure, maxAge: 8 * 3600 * 1000,
  });
  res.redirect('/');
});

module.exports = router;
