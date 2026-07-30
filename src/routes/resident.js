'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./../db');
const regions = require('./../regions');
const { normalizePlate } = require('./../services/passService');

const router = express.Router();

// Province/state options for the public portal (no auth; not sensitive).
router.get('/regions', (req, res) => res.json({ CA: regions.CA, US: regions.US }));

// Public endpoint — no auth. Rate-limited to blunt spam/abuse.
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// Resident submits a visitor-pass request. Creates a PENDING record only; no
// pass exists and no quota is consumed until staff approve it.
router.post('/requests', submitLimiter, async (req, res) => {
  const {
    unitNumber, requesterName, requesterContact,
    visitorFirstName, visitorLastName, visitorCountry, visitorRegion,
    visitorPlate, durationPreset, note,
  } = req.body || {};

  if (!unitNumber || !requesterName || !visitorPlate) {
    return res.status(400).json({ error: 'unit_name_and_plate_required' });
  }
  const plate = normalizePlate(visitorPlate);
  if (!plate) return res.status(400).json({ error: 'invalid_plate' });

  const country = String(visitorCountry || '').toUpperCase();
  const region = String(visitorRegion || '').toUpperCase();
  if (region && !regions.isValidRegion(country, region)) {
    return res.status(400).json({ error: 'invalid_region' });
  }
  const preset = durationPreset === 'tomorrow_noon' ? 'tomorrow_noon' : 'today';

  const unit = await db.query(`SELECT id FROM units WHERE unit_number = $1`, [unitNumber]);
  if (unit.rowCount === 0) {
    // Don't confirm/deny which units exist beyond this direct check.
    return res.status(404).json({ error: 'unit_not_found', message: 'That unit number was not found.' });
  }

  const r = await db.query(
    `INSERT INTO pass_requests
       (unit_id, requester_name, requester_contact, visitor_first_name, visitor_last_name,
        visitor_plate, visitor_region, duration_preset, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, created_at`,
    [unit.rows[0].id, requesterName.trim(), (requesterContact || '').trim() || null,
     (visitorFirstName || '').trim() || null, (visitorLastName || '').trim() || null,
     plate, region ? `${country}-${region}` : null, preset, (note || '').trim() || null]
  );

  res.status(201).json({
    ok: true,
    requestId: r.rows[0].id,
    message: 'Your request has been submitted and is pending approval by building staff.',
  });
});

module.exports = router;
