'use strict';
const express = require('express');
const db = require('./../db');
const passService = require('./../services/passService');
const { requireAuth, requireRole } = require('./../auth/middleware');

const router = express.Router();
router.use(requireAuth, requireRole('security', 'management'));

// Board of physical tags: each tag with its status and, when issued, the car it
// is on right now.
router.get('/', async (req, res) => {
  const r = await db.query(
    `SELECT t.tag_number, t.status,
            vp.id AS pass_id, vp.visitor_plate, vp.visitor_name, vp.expires_at,
            u.unit_number
       FROM parking_tags t
       LEFT JOIN visitor_passes vp
              ON vp.tag_id = t.id AND vp.status = 'active' AND vp.vacated_at IS NULL
       LEFT JOIN units u ON u.id = vp.unit_id
      ORDER BY t.tag_number`
  );
  res.json(r.rows);
});

// Per-tag audit trail: every pass this physical tag has ever carried, newest
// first. Derived entirely from visitor_passes (a pass keeps its tag_id after
// vacate/revoke), so no separate log table is needed. Answers "who had Tag #N
// and when?" for the concierge.
router.get('/:number/history', async (req, res) => {
  const num = parseInt(req.params.number, 10);
  const t = await db.query(
    `SELECT id, tag_number, status FROM parking_tags WHERE tag_number = $1`,
    [num]
  );
  if (t.rowCount === 0) return res.status(404).json({ error: 'tag_not_found' });
  const tag = t.rows[0];
  const h = await db.query(
    `SELECT vp.id AS pass_id, vp.visitor_plate, vp.visitor_name, vp.status,
            vp.issued_at, vp.starts_at, vp.expires_at, vp.vacated_at, vp.revoked_at,
            u.unit_number, iss.full_name AS issuer_name
       FROM visitor_passes vp
       JOIN units u ON u.id = vp.unit_id
       LEFT JOIN users iss ON iss.id = vp.issued_by
      WHERE vp.tag_id = $1
      ORDER BY vp.issued_at DESC`,
    [tag.id]
  );
  res.json({ tagNumber: tag.tag_number, status: tag.status, history: h.rows });
});

// Return a tag: vacate the pass it's bound to (which frees the tag + spot). If
// the tag has no live pass, just release it back to the pool.
router.post('/:number/return', async (req, res) => {
  const num = parseInt(req.params.number, 10);
  const t = await db.query(`SELECT id FROM parking_tags WHERE tag_number = $1`, [num]);
  if (t.rowCount === 0) return res.status(404).json({ error: 'tag_not_found' });
  const tagId = t.rows[0].id;
  const live = await db.query(
    `SELECT id FROM visitor_passes WHERE tag_id = $1 AND status = 'active' AND vacated_at IS NULL LIMIT 1`,
    [tagId]
  );
  if (live.rowCount > 0) {
    await passService.vacatePass(live.rows[0].id, req.user.id); // frees the tag
  } else {
    await db.query(`UPDATE parking_tags SET status = 'available' WHERE id = $1`, [tagId]);
  }
  res.json({ ok: true, tagNumber: num });
});

module.exports = router;
