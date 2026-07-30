'use strict';
const express = require('express');
const db = require('./../db');

const router = express.Router();

// Public read of display settings (org/condo name is not sensitive) so the
// login screen, desk, and resident pages can show it too.
router.get('/', async (req, res) => {
  const r = await db.query(`SELECT value FROM settings WHERE key = 'org_name'`);
  res.json({ orgName: r.rows[0]?.value || 'Yorkdale Condominium II' });
});

module.exports = router;
