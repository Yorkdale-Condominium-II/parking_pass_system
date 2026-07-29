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
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_required' });
  const verdict = await passService.verifyPass(token, req.user.id);
  res.json(verdict);
});

module.exports = router;
