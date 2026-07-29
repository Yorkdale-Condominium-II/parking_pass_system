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

module.exports = { signPass, verifyToken, signatureHex, PREFIX };
