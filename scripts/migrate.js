'use strict';
// Apply db/schema.sql to the configured database.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
  // eslint-disable-next-line no-console
  console.log('✓ Schema applied.');
  await db.pool.end();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err.message);
  process.exit(1);
});
