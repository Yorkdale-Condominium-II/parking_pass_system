'use strict';
const path = require('path');
require('express-async-errors'); // route async throws to the error handler (Express 4)
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');

const app = express();

// Trust exactly as many reverse proxies as configured (default 0 = trust none),
// so req.ip and the Secure-cookie decision reflect the real client only when a
// proxy is actually in front. Trusting a hop that does NOT strip a
// client-supplied X-Forwarded-For would let clients spoof their IP.
app.set('trust proxy', config.trustProxy);
if (config.trustProxy > 0 && config.env === 'production') {
  // eslint-disable-next-line no-console
  console.warn('[security] trust proxy = ' + config.trustProxy
    + ': ensure the reverse proxy strips X-Forwarded-For from clients');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],           // QR codes are embedded as data URIs
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],             // blocks inline on*="…" handlers
      styleSrc: ["'self'", "'unsafe-inline'"], // styles still inline; revisit later
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
// Allow sizeable payloads: bulk unit imports can carry a whole Excel workbook
// (sent base64-encoded) or a large pasted CSV.
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// --- API routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/sso', require('./routes/sso')); // Google / Microsoft sign-in
app.use('/api', require('./routes/meta'));   // /api/units, /api/regions
app.use('/api/settings', require('./routes/settings')); // public display settings
app.use('/api/passes', require('./routes/passes'));
app.use('/api/verify', require('./routes/verify'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/board', require('./routes/board'));
app.use('/api/resident', require('./routes/resident')); // public request form
app.use('/api/requests', require('./routes/requests'));  // staff review
app.use('/api/spots', require('./routes/spots'));         // live occupancy board
app.use('/api/tags', require('./routes/tags'));           // physical numbered tags (TAG_MODE)
app.use('/api/desk', require('./routes/desk'));           // public officer-authenticated kiosk

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Static single-page frontend ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Centralized error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

// Apply the idempotent schema on boot so the running app is always migrated —
// even if the separate `npm run migrate` step was skipped or failed (e.g. the
// DB wasn't ready yet during a one-click launch). Tolerant of failure: a
// transient DB hiccup logs a warning rather than blocking startup.
async function ensureSchema() {
  const fs = require('fs');
  const db = require('./db');
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await db.query(sql);
    // eslint-disable-next-line no-console
    console.log('✓ Database schema is up to date.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[warning] Could not apply schema on boot:', err.message);
  }
}

if (require.main === module) {
  ensureSchema().finally(() => {
    app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`Parking pass system listening on http://localhost:${config.port} (${config.env})`);
    });
  });
}

module.exports = app;
