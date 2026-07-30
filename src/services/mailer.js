'use strict';
const nodemailer = require('nodemailer');

// ============================================================================
//  Email delivery. Configured entirely by environment variables so it works
//  with Gmail (app password) or any SMTP relay. If nothing is configured, send
//  becomes a logged no-op — the app keeps working, emails just aren't sent.
//
//  Configure via EITHER:
//    SMTP_URL=smtps://user:app-password@smtp.gmail.com:465
//  OR the discrete vars:
//    SMTP_HOST, SMTP_PORT, SMTP_SECURE(true|false), SMTP_USER, SMTP_PASS
//  Plus:
//    MAIL_FROM="Yorkdale Parking <parking@yourbuilding.com>"
// ============================================================================

let transporter = null;
let configured = false;

function init() {
  if (process.env.SMTP_URL) {
    transporter = nodemailer.createTransport(process.env.SMTP_URL);
    configured = true;
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    configured = true;
  }
}
init();

function isConfigured() {
  return configured;
}

/**
 * Send an email. Resolves { sent:boolean, skipped?:boolean, error?:string }.
 * Never throws — a mail failure must not break pass issuance.
 */
async function sendMail({ to, subject, text, html, attachments }) {
  if (!configured) {
    // eslint-disable-next-line no-console
    console.log(`[mailer] not configured — would email "${subject}" to ${to}`);
    return { sent: false, skipped: true };
  }
  if (!to) return { sent: false, skipped: true };
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, text, html, attachments,
    });
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailer] send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { isConfigured, sendMail };
