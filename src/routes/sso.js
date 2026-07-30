'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./../config');
const db = require('./../db');
const sso = require('./../auth/sso');
const { issueSession } = require('./../auth/middleware');

const router = express.Router();

const TX_COOKIE = 'sso_tx';

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

// Begin SSO: redirect the browser to the provider's consent screen.
router.get('/:provider/start', async (req, res) => {
  const provider = req.params.provider;
  if (!sso.isEnabled(provider)) return res.status(404).send('SSO provider not enabled');
  const client = await sso.getClient(provider);
  const { code_verifier, code_challenge, state } = sso.makeAuthRequest(client);

  // Stash the PKCE verifier + state in a short-lived signed cookie.
  const tx = jwt.sign({ provider, state, code_verifier }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie(TX_COOKIE, tx, {
    httpOnly: true, sameSite: 'lax',
    secure: config.oauthBaseUrl.startsWith('https://'),
    maxAge: 10 * 60 * 1000,
  });

  const url = client.authorizationUrl({
    scope: 'openid email profile',
    code_challenge, code_challenge_method: 'S256', state,
  });
  res.redirect(url);
});

// Provider redirects back here with ?code&state.
router.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const fail = (reason) => res.redirect('/?sso_error=' + encodeURIComponent(reason));
  if (!sso.isEnabled(provider)) return fail('provider_disabled');

  let txData;
  try {
    txData = jwt.verify(req.cookies?.[TX_COOKIE] || '', config.jwtSecret);
  } catch { return fail('expired'); }
  res.clearCookie(TX_COOKIE);
  if (txData.provider !== provider) return fail('mismatch');

  let claims;
  try {
    const client = await sso.getClient(provider);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(sso.redirectUri(provider), params, {
      state: txData.state, code_verifier: txData.code_verifier,
    });
    claims = tokenSet.claims();
  } catch {
    await logAuth({ event: 'sso_error', success: false, req });
    return fail('exchange_failed');
  }

  // Require a verified email (Google sets email_verified; Microsoft emails are
  // considered verified for the tenant).
  const email = claims.email;
  if (!email || (provider === 'google' && claims.email_verified === false)) {
    await logAuth({ username: email || '(sso)', event: 'sso_login_failed', success: false, req });
    return fail('email_unverified');
  }

  const user = await sso.findUserByEmail(email);
  if (!user) {
    await logAuth({ username: email, event: 'sso_not_provisioned', success: false, req });
    return fail('not_provisioned');
  }

  // Remember the provider subject for reference (best-effort).
  db.query(`UPDATE users SET sso_provider = $1, sso_subject = $2 WHERE id = $3`,
    [provider, claims.sub, user.id]).catch(() => {});

  await logAuth({ userId: user.id, username: user.username, event: 'login_success', success: true, req });
  const token = issueSession(user);
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'strict',
    secure: config.oauthBaseUrl.startsWith('https://'),
    maxAge: 8 * 3600 * 1000,
  });
  res.redirect('/');
});

module.exports = router;
