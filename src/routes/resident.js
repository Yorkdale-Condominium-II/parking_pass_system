'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./../db');
const regions = require('./../regions');
const { normalizePlate } = require('./../services/passService');

const router = express.Router();

// Short, unambiguous reference code (Crockford base32, no I/L/O/U). 6 chars ~
// 1e9 space — plenty for a building, short enough to read over the phone.
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeRef() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[b[i] % 32];
  return s;
}

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
    unitNumber, requesterName, requesterContact, requesterEmail,
    visitorFirstName, visitorLastName, visitorCountry, visitorRegion,
    visitorPlate, durationPreset, note,
  } = req.body || {};

  if (!unitNumber || !requesterName || !visitorPlate) {
    return res.status(400).json({ error: 'unit_name_and_plate_required' });
  }
  const email = (requesterEmail || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
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

  // Insert with a unique short ref code, retrying on the rare collision.
  let row;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await db.query(
        `INSERT INTO pass_requests
           (unit_id, requester_name, requester_contact, requester_email,
            visitor_first_name, visitor_last_name, visitor_plate, visitor_region,
            duration_preset, note, ref_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ref_code, created_at`,
        [unit.rows[0].id, requesterName.trim(), (requesterContact || '').trim() || null,
         email || null, (visitorFirstName || '').trim() || null, (visitorLastName || '').trim() || null,
         plate, region ? `${country}-${region}` : null, preset, (note || '').trim() || null, makeRef()]
      );
      row = r.rows[0];
      break;
    } catch (err) {
      if (err.code === '23505') continue; // ref_code collision — try another
      throw err;
    }
  }
  if (!row) return res.status(500).json({ error: 'could_not_allocate_reference' });

  res.status(201).json({
    ok: true,
    reference: row.ref_code,
    message: 'Your request has been submitted and is pending approval by building staff.',
  });
});

// Public status check by short reference. Rate-limited to slow enumeration.
const statusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
router.get('/status/:ref', statusLimiter, async (req, res) => {
  const ref = String(req.params.ref || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const r = await db.query(
    `SELECT pr.ref_code, pr.status, pr.created_at, pr.decided_at, pr.decision_note,
            pr.visitor_plate, u.unit_number
       FROM pass_requests pr JOIN units u ON u.id = pr.unit_id
      WHERE pr.ref_code = $1`,
    [ref]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const x = r.rows[0];
  res.json({
    reference: x.ref_code,
    status: x.status,               // pending | approved | denied
    unit: x.unit_number,
    visitorPlate: x.visitor_plate,
    submittedAt: x.created_at,
    decidedAt: x.decided_at,
    note: x.decision_note,
  });
});

module.exports = router;
