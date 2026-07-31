'use strict';
const config = require('./../config');

// ============================================================================
//  Mirror pass events to a Google Sheet via a Google Apps Script web-app
//  webhook. Configured entirely by env vars (SHEETS_WEBHOOK_URL, optional
//  SHEETS_WEBHOOK_TOKEN). If nothing is configured, logEvent is a no-op — the
//  app keeps working, events just aren't mirrored. Never throws: a logging
//  failure must never break pass issuance.
//
//  The paired Apps Script appends one row per POST. See docs/GOOGLE_SHEETS.md.
// ============================================================================

function isConfigured() {
  return Boolean(config.sheetsWebhookUrl);
}

// Fire-and-forget: callers should NOT await this on the request path. Resolves
// { sent } / { skipped } / { error } and swallows all errors internally.
async function logEvent(event, fields = {}) {
  if (!config.sheetsWebhookUrl) return { sent: false, skipped: true };
  const payload = { event, at: new Date().toISOString(), ...fields };
  if (config.sheetsWebhookToken) payload.token = config.sheetsWebhookToken;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(config.sheetsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'follow', // Apps Script exec URLs 302 to script.googleusercontent.com
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[sheetsLog] webhook returned HTTP ${res.status}`);
      return { sent: false, error: `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sheetsLog] post failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { isConfigured, logEvent };
