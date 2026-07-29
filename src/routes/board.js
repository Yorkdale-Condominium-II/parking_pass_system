'use strict';
const express = require('express');
const db = require('./../db');
const { requireAuth, requireRole } = require('./../auth/middleware');

const router = express.Router();

// Board dashboards: aggregate analytics ONLY. No resident PII, no plates.
router.use(requireAuth, requireRole('board', 'management'));

router.get('/summary', async (req, res) => {
  const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);

  const totals = await db.query(
    `SELECT
        COUNT(*)::int AS total_passes,
        COUNT(*) FILTER (WHERE status = 'active')::int  AS active_passes,
        COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked_passes,
        COUNT(*) FILTER (WHERE was_override)::int        AS override_passes,
        COUNT(DISTINCT unit_id)::int                     AS units_with_passes
       FROM visitor_passes
      WHERE calendar_year = $1`,
    [year]
  );

  const byMonth = await db.query(
    `SELECT to_char(date_trunc('month', issued_at), 'YYYY-MM') AS month,
            COUNT(*)::int AS passes
       FROM visitor_passes
      WHERE calendar_year = $1
      GROUP BY 1 ORDER BY 1`,
    [year]
  );

  // Units approaching / at their quota — reported by unit number only.
  const nearLimit = await db.query(
    `SELECT unit_number, passes_used
       FROM unit_year_usage
      WHERE calendar_year = $1
      ORDER BY passes_used DESC
      LIMIT 10`,
    [year]
  );

  const registeredVehicles = await db.query(`SELECT COUNT(*)::int AS n FROM registered_vehicles`);
  const totalUnits = await db.query(`SELECT COUNT(*)::int AS n FROM units`);

  res.json({
    year,
    totals: totals.rows[0],
    passesByMonth: byMonth.rows,
    busiestUnits: nearLimit.rows,
    registeredVehicles: registeredVehicles.rows[0].n,
    totalUnits: totalUnits.rows[0].n,
  });
});

module.exports = router;
