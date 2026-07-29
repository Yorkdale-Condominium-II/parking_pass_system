'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('./../db');
const { requireAuth, requireRole } = require('./../auth/middleware');
const passService = require('./../services/passService');
const { renderPassSheet } = require('./../services/printTemplate');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Licence-plate lookup (Security + Management)
//  Searches BOTH registered resident vehicles and active visitor passes.
// ---------------------------------------------------------------------------
router.get('/lookup', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const plate = passService.normalizePlate(req.query.plate || '');
  if (!plate) return res.status(400).json({ error: 'plate_required' });

  const registered = await db.query(
    `SELECT rv.licence_plate, rv.make, rv.model, rv.color, rv.province,
            u.unit_number, r.full_name AS resident_name
       FROM registered_vehicles rv
       JOIN units u ON u.id = rv.unit_id
       LEFT JOIN residents r ON r.id = rv.resident_id
      WHERE rv.licence_plate = $1`,
    [plate]
  );

  const passes = await db.query(
    `SELECT vp.id, vp.visitor_plate, vp.visitor_name, vp.status,
            vp.issued_at, vp.expires_at, u.unit_number
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
      WHERE vp.visitor_plate = $1
      ORDER BY vp.issued_at DESC
      LIMIT 10`,
    [plate]
  );

  res.json({
    plate,
    registeredVehicles: registered.rows,
    visitorPasses: passes.rows,
  });
});

// ---------------------------------------------------------------------------
//  Issue a visitor pass (Security + Management). Override requires Management.
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const { unitNumber, visitorPlate, visitorName, durationHours, override, overrideReason } =
    req.body || {};
  if (!unitNumber || !visitorPlate) {
    return res.status(400).json({ error: 'unit_and_plate_required' });
  }
  try {
    const result = await passService.issuePass({
      unitNumber,
      visitorPlate,
      visitorName,
      durationHours: durationHours ? parseInt(durationHours, 10) : undefined,
      issuer: req.user,
      override: Boolean(override),
      overrideReason,
    });
    res.status(201).json({
      passId: result.pass.id,
      unitNumber: result.pass.unit_number,
      visitorPlate: result.pass.visitor_plate,
      issuedAt: result.pass.issued_at,
      expiresAt: result.pass.expires_at,
      token: result.token,
      usedOverride: result.usedOverride,
      quota: result.quota,
      printUrl: `/api/passes/${result.pass.id}/print`,
    });
  } catch (err) {
    const codeMap = {
      unit_not_found: 404,
      quota_exceeded: 409,
      override_not_authorized: 403,
      override_reason_required: 400,
      invalid_plate: 400,
    };
    if (codeMap[err.code]) {
      return res.status(codeMap[err.code]).json({ error: err.code, message: err.message, quota: err.quota });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
//  Print-ready 8.5 x 11 pass sheet (HTML with embedded QR)
// ---------------------------------------------------------------------------
router.get('/:id/print', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const result = await db.query(
    `SELECT vp.*, u.unit_number, usr.full_name AS issuer_name, usr.role AS issuer_role
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
       JOIN users usr ON usr.id = vp.issued_by
      WHERE vp.id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).send('Pass not found');
  const pass = result.rows[0];

  // Re-sign deterministically from stored fields to embed the token in the QR.
  const barcode = require('./../crypto/barcode');
  const token = barcode.signPass({
    passId: pass.id,
    unitNumber: pass.unit_number,
    visitorPlate: pass.visitor_plate,
    issuedAt: pass.issued_at,
    expiresAt: pass.expires_at,
  });
  const qrDataUrl = await QRCode.toDataURL(token, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });

  res.type('html').send(renderPassSheet({ pass, token, qrDataUrl }));
});

// ---------------------------------------------------------------------------
//  Revoke a pass (Security + Management)
// ---------------------------------------------------------------------------
router.post('/:id/revoke', requireAuth, requireRole('security', 'management'), async (req, res) => {
  try {
    const pass = await passService.revokePass(req.params.id, req.user.id);
    res.json({ ok: true, passId: pass.id, status: pass.status });
  } catch (err) {
    if (err.code === 'not_revokable') return res.status(409).json({ error: err.code, message: err.message });
    throw err;
  }
});

module.exports = router;
