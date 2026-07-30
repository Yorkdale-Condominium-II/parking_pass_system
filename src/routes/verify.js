'use strict';
const express = require('express');
const { requireAuth, requireRole } = require('./../auth/middleware');
const passService = require('./../services/passService');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Verification endpoint for Security. Accepts a scanned/typed barcode token
//  and returns an authenticity + status verdict.
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const { token, shortCode } = req.body || {};
  if (!token && !shortCode) return res.status(400).json({ error: 'token_or_short_code_required' });
  // A scanned QR carries the full signed token; a keyed-in printout code is the
  // short code. Prefer the token when both are somehow present.
  const verdict = token
    ? await passService.verifyPass(token, req.user.id)
    : await passService.verifyByShortCode(shortCode, req.user.id);
  res.json(verdict);
});

module.exports = router;
