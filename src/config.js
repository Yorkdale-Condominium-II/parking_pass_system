'use strict';
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    // Fail fast: missing secrets are a security problem, not a warning.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || null,
  jwtSecret: required('JWT_SECRET'),
  barcodeSecret: required('BARCODE_SECRET'),
  annualPassQuota: parseInt(process.env.ANNUAL_PASS_QUOTA || '10', 10),
  defaultPassDurationHours: parseInt(process.env.DEFAULT_PASS_DURATION_HOURS || '24', 10),
  // Barcode payloads older than the pass expiry are always rejected; this is an
  // additional hard ceiling in case a very long-lived pass is ever created.
  jwtIssuer: 'condo-parking-pass',
};
