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
  // Secret used to derive the rotating weekly override code. Falls back to the
  // barcode secret if unset so existing installs keep working.
  overrideSecret: process.env.OVERRIDE_SECRET || process.env.BARCODE_SECRET,
  annualPassQuota: parseInt(process.env.ANNUAL_PASS_QUOTA || '10', 10),
  // Commercial units get their own annual quota. -1 means unlimited.
  commercialPassQuota: parseInt(process.env.COMMERCIAL_PASS_QUOTA || '20', 10),
  // Hard ceiling on residential units (building has 1520). Commercial units are
  // tracked separately and do not count against this.
  residentialUnitCap: parseInt(process.env.RESIDENTIAL_UNIT_CAP || '1520', 10),
  // Number of physical visitor parking spaces. At most this many passes may be
  // "live" (occupying a spot) at any instant, building-wide.
  spotCapacity: parseInt(process.env.SPOT_CAPACITY || '5', 10),
  defaultPassDurationHours: parseInt(process.env.DEFAULT_PASS_DURATION_HOURS || '24', 10),
  // Barcode payloads older than the pass expiry are always rejected; this is an
  // additional hard ceiling in case a very long-lived pass is ever created.
  jwtIssuer: 'condo-parking-pass',
};
