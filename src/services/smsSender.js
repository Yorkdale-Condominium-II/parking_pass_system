'use strict';

// ============================================================================
//  Send a text message (SMS) — used to text a visitor/owner the link to their
//  parking pass. Configured entirely by env vars; if nothing is configured,
//  send() is a logged no-op (the app keeps working, texts just aren't sent).
//
//  Supports Twilio's HTTP API (no SDK dependency):
//    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a Twilio number)
//  Never throws — a send failure must not break pass issuance.
// ============================================================================

function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

async function send({ to, body }) {
  if (!isConfigured()) {
    // eslint-disable-next-line no-console
    console.log(`[sms] not configured — would text "${body}" to ${to}`);
    return { sent: false, skipped: true };
  }
  if (!to) return { sent: false, skipped: true };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`[sms] send failed HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return { sent: false, error: `HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sms] send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { isConfigured, send };
