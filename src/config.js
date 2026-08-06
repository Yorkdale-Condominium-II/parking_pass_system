'use strict';
require('dotenv').config();

// Pin the property's timezone for all local-time math (pass expiry, "rest of
// today", calendar-year quota buckets) so behaviour is identical whether the
// server runs on the on-site Windows box or a UTC cloud host. Must be set
// before any Date is used. Override with PROPERTY_TZ (an IANA name).
const PROPERTY_TZ = process.env.PROPERTY_TZ || 'America/Toronto';
process.env.TZ = PROPERTY_TZ;

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    // Fail fast: missing secrets are a security problem, not a warning.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

module.exports = {
  propertyTz: PROPERTY_TZ,
  // Physical-tag mode: the concierge assigns a numbered hard-plastic tag from a
  // finite pool (the pool size is the spot capacity). Off by default so the
  // standard printable-pass system is unchanged; the separate start-tags.bat
  // launches an isolated instance with TAG_MODE=true.
  tagMode: process.env.TAG_MODE === 'true',
  // Send the session cookie only over HTTPS. Defaults on in production; set
  // COOKIE_SECURE=true when serving over TLS (directly or behind a proxy).
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  // App version, surfaced in the UI header/tab. Single source of truth is
  // package.json — bump it there with each committed change.
  version: require('./../package.json').version,
  // In tag mode, use a separate database if one is provided (TAGS_DATABASE_URL)
  // so the demo instance is fully isolated from the standard system; otherwise
  // fall back to the primary DATABASE_URL.
  databaseUrl: (process.env.TAG_MODE === 'true' && process.env.TAGS_DATABASE_URL)
    ? process.env.TAGS_DATABASE_URL
    : (process.env.DATABASE_URL || null),
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
  // Base URL the app is reached at, used to build OAuth redirect URIs.
  oauthBaseUrl: (process.env.OAUTH_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/$/, ''),
  // How long a Google/Microsoft-started desk session lasts (minutes).
  deskSessionMinutes: parseInt(process.env.DESK_SESSION_MINUTES || '30', 10),
  sso: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || null,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || null,
      tenant: process.env.MICROSOFT_TENANT || 'common',
    },
  },
  // Optional: mirror pass events (issued / revoked / vacated) to a Google Sheet
  // via a Google Apps Script web-app webhook. Inert until SHEETS_WEBHOOK_URL is
  // set. SHEETS_WEBHOOK_TOKEN is an optional shared secret the script can check.
  sheetsWebhookUrl: process.env.SHEETS_WEBHOOK_URL || null,
  sheetsWebhookToken: process.env.SHEETS_WEBHOOK_TOKEN || null,
  // Barcode payloads older than the pass expiry are always rejected; this is an
  // additional hard ceiling in case a very long-lived pass is ever created.
  jwtIssuer: 'condo-parking-pass',
};
