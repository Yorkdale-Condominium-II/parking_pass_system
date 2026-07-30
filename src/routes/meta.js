'use strict';
const express = require('express');
const db = require('./../db');
const regions = require('./../regions');
const { requireAuth, requireRole } = require('./../auth/middleware');

const router = express.Router();

// Province/state options for the Issue-Pass dropdown.
router.get('/regions', requireAuth, (req, res) => {
  res.json({ CA: regions.CA, US: regions.US });
});

// Known units, for the Issue-Pass unit picker (datalist) so passes can only be
// issued against real units. Optional ?q= prefix filter and ?kind= filter.
router.get('/units', requireAuth, requireRole('security', 'management'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kind = String(req.query.kind || '').trim();
  const clauses = [];
  const params = [];
  if (q) { params.push(q + '%'); clauses.push(`unit_number ILIKE $${params.length}`); }
  if (kind === 'residential' || kind === 'commercial') {
    params.push(kind); clauses.push(`kind = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT unit_number, kind, business_name FROM units ${where}
      ORDER BY kind, unit_number LIMIT 2000`,
    params
  );
  res.json(r.rows);
});

module.exports = router;
