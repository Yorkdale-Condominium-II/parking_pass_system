'use strict';
const { Issuer, generators } = require('openid-client');
const config = require('./../config');
const db = require('./../db');

// ============================================================================
//  Google / Microsoft single sign-on (OpenID Connect, Authorization Code + PKCE).
//
//  SSO only AUTHENTICATES a person (proves who they are via a verified email).
//  AUTHORIZATION still comes from our own users table: the email must match an
//  active user, and that row's role is what they get. Unprovisioned emails are
//  refused — so signing in with Google/Microsoft never grants access on its own.
// ============================================================================

const DISCOVERY = {
  google: 'https://accounts.google.com',
  microsoft: () => `https://login.microsoftonline.com/${config.sso.microsoft.tenant}/v2.0`,
};

function isEnabled(provider) {
  const c = config.sso[provider];
  return Boolean(c && c.clientId && c.clientSecret);
}

function enabledProviders() {
  return ['google', 'microsoft'].filter(isEnabled);
}

function redirectUri(provider) {
  return `${config.oauthBaseUrl}/api/auth/sso/${provider}/callback`;
}

// Lazily discover + build a client per provider, cached for the process.
const clientCache = {};
async function getClient(provider) {
  if (!isEnabled(provider)) { const e = new Error('provider_disabled'); e.code = 'provider_disabled'; throw e; }
  if (clientCache[provider]) return clientCache[provider];
  const disc = typeof DISCOVERY[provider] === 'function' ? DISCOVERY[provider]() : DISCOVERY[provider];
  const issuer = await Issuer.discover(disc);
  const c = config.sso[provider];
  clientCache[provider] = new issuer.Client({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uris: [redirectUri(provider)],
    response_types: ['code'],
  });
  return clientCache[provider];
}

// PKCE + state helpers used by the start/callback routes.
function makeAuthRequest(client) {
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();
  return { code_verifier, code_challenge, state };
}

/**
 * Resolve an SSO-verified email to one of our active users. Returns the user
 * row or null if there is no active, provisioned account for that email.
 */
async function findUserByEmail(email) {
  if (!email) return null;
  const r = await db.query(
    `SELECT * FROM users WHERE lower(email) = lower($1) AND is_active = TRUE`,
    [email]
  );
  return r.rows[0] || null;
}

module.exports = {
  isEnabled, enabledProviders, redirectUri, getClient, makeAuthRequest, findUserByEmail,
};
