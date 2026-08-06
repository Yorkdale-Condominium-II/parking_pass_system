'use strict';
const express = require('express');
const db = require('./../db');
const config = require('./../config');

const router = express.Router();

// Public read of display settings (org/condo name is not sensitive) so the
// login screen, desk, and resident pages can show it too. Also carries the app
// version so the UI can show which build is running.
router.get('/', async (req, res) => {
  const r = await db.query(`SELECT value FROM settings WHERE key = 'org_name'`);
  res.json({
    orgName: r.rows[0]?.value || 'Yorkdale Condominium II',
    version: config.version,
    tagMode: config.tagMode,
  });
});

module.exports = router;
