'use strict';
const crypto = require('crypto');
const config = require('./../config');

// ============================================================================
//  Barcode / QR payload signing & verification (HMAC-SHA256)
// ----------------------------------------------------------------------------
//  A pass barcode encodes a compact, tamper-evident token, NOT plain text.
//
//  Wire format (single line, safe for Code128 / QR):
//      PPV1.<base64url(payloadJson)>.<base64url(hmac)>
//
//  The HMAC is computed over the exact encoded payload segment using a
//  server-only secret (BARCODE_SECRET). A resident cannot forge or mutate a
//  pass because they cannot produce a valid signature without the secret.
//  Verification is constant-time to avoid timing side channels.
// ============================================================================

const PREFIX = 'PPV1';

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function hmac(encodedPayload) {
  return crypto
    .createHmac('sha256', config.barcodeSecret)
    .update(encodedPayload)
    .digest();
}

/**
 * Build a signed barcode token for a pass.
 * @param {object} claims - { passId, unitNumber, visitorPlate, issuedAt, expiresAt }
 *        Timestamps are ISO-8601 strings (or epoch ms numbers).
 * @returns {string} the token to render into the barcode/QR image.
 */
function signPass(claims) {
  const payload = {
    v: 1,
    pid: claims.passId,
    unit: claims.unitNumber,
    plate: claims.visitorPlate,
    iat: toEpoch(claims.issuedAt),
    exp: toEpoch(claims.expiresAt),
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(hmac(encoded));
  return `${PREFIX}.${encoded}.${sig}`;
}

/**
 * Return only the raw HMAC signature (hex) for a given token — persisted on the
 * pass row so integrity can be re-checked without re-deriving the payload.
 */
function signatureHex(token) {
  const parts = token.split('.');
  return b64urlDecode(parts[2]).toString('hex');
}

/**
 * Verify a scanned/typed token.
 * @returns {{ valid: boolean, reason?: string, payload?: object, expired?: boolean }}
 *   - valid=false, reason='malformed'  -> not our format
 *   - valid=false, reason='forged'     -> signature mismatch (tampered/fake)
 *   - valid=true, expired=true         -> genuine but past expiry
 *   - valid=true, expired=false        -> genuine and within validity window
 *
 *  NOTE: "valid" means cryptographically authentic. Callers must still check
 *  DB status (revoked?) — signature verification alone cannot know that.
 */
function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return { valid: false, reason: 'malformed' };
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { valid: false, reason: 'malformed' };
  }
  const [, encoded, providedSig] = parts;

  const expectedSig = hmac(encoded);
  let provided;
  try {
    provided = b64urlDecode(providedSig);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // Constant-time comparison; lengths must match first.
  if (
    provided.length !== expectedSig.length ||
    !crypto.timingSafeEqual(provided, expectedSig)
  ) {
    return { valid: false, reason: 'forged' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const expired = typeof payload.exp === 'number' && now > payload.exp;
  return { valid: true, expired, payload };
}

function toEpoch(t) {
  if (typeof t === 'number') return t;
  return new Date(t).getTime();
}

// ============================================================================
//  Short code (human-typable) printed alongside the QR.
//  Security can key this in when a camera scan isn't available. It is a
//  deterministic, unforgeable function of the pass id (Crockford base32,
//  grouped for readability, e.g. "K7Q4-9M2X"). Not secret on its own — it maps
//  to a pass, and the pass's real status is always re-checked server-side.
// ============================================================================
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I L O U

function shortCodeForPass(passId) {
  const digest = crypto
    .createHmac('sha256', config.barcodeSecret)
    .update('shortcode:' + passId)
    .digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[digest[i] % 32];
  return out.slice(0, 4) + '-' + out.slice(4); // e.g. K7Q4-9M2X
}

function normalizeShortCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0'); // forgive lookalikes
}

// ============================================================================
//  Weekly override code. Rotates every ISO week; anyone with the current code
//  (distributed to Management / Board) can authorize a quota override. Derived
//  from a server secret so it cannot be predicted or reused across weeks.
// ============================================================================
function isoWeekKey(date = new Date()) {
  // ISO-8601 week number, UTC-based, stable for a given calendar week.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function overrideCodeForWeek(date = new Date()) {
  const key = isoWeekKey(date);
  const digest = crypto
    .createHmac('sha256', config.overrideSecret)
    .update('override:' + key)
    .digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[digest[i] % 32];
  return { week: key, code: out.slice(0, 4) + '-' + out.slice(4) };
}

function verifyOverrideCode(input, now = new Date()) {
  const norm = normalizeShortCode(input);
  if (!norm) return false;
  // Accept the current week's code (constant-time compare).
  const current = normalizeShortCode(overrideCodeForWeek(now).code);
  const a = Buffer.from(norm);
  const b = Buffer.from(current);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  signPass, verifyToken, signatureHex, PREFIX,
  shortCodeForPass, normalizeShortCode,
  overrideCodeForWeek, verifyOverrideCode,
};
