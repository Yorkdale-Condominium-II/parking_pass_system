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
app.use('/api/passes', require('./routes/passes'));
app.use('/api/verify', require('./routes/verify'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/board', require('./routes/board'));

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
