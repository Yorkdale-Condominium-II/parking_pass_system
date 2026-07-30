'use strict';
const path = require('path');
require('express-async-errors'); // route async throws to the error handler (Express 4)
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],       // QR codes are embedded as data URIs
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(express.json());
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

if (require.main === module) {
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Parking pass system listening on http://localhost:${config.port} (${config.env})`);
  });
}

module.exports = app;
