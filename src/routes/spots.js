'use strict';
const express = require('express');
const db = require('./../db');
const config = require('./../config');
const { requireAuth, requireRole } = require('./../auth/middleware');

const router = express.Router();
router.use(requireAuth, requireRole('security', 'management'));

// Live occupancy board: which of the N visitor spaces are taken right now, plus
// upcoming scheduled arrivals.
router.get('/', async (req, res) => {
  const live = await db.query(
    `SELECT vp.id, vp.visitor_plate, vp.visitor_name, vp.visitor_region,
            vp.starts_at, vp.expires_at, u.unit_number, u.kind
       FROM visitor_passes vp JOIN units u ON u.id = vp.unit_id
      WHERE vp.status = 'active' AND vp.vacated_at IS NULL
        AND vp.starts_at <= now() AND vp.expires_at > now()
      ORDER BY vp.starts_at`
  );
  const upcoming = await db.query(
    `SELECT vp.id, vp.visitor_plate, vp.visitor_name, vp.starts_at, vp.expires_at,
            u.unit_number
       FROM visitor_passes vp JOIN units u ON u.id = vp.unit_id
      WHERE vp.status = 'active' AND vp.vacated_at IS NULL
        AND vp.starts_at > now() AND vp.starts_at < now() + interval '48 hours'
      ORDER BY vp.starts_at
      LIMIT 50`
  );
  res.json({
    capacity: config.spotCapacity,
    used: live.rowCount,
    available: Math.max(0, config.spotCapacity - live.rowCount),
    live: live.rows,
    upcoming: upcoming.rows,
  });
});

module.exports = router;
