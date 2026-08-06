'use strict';
const mailer = require('./mailer');
const barcode = require('./../crypto/barcode');
const { buildPassPdf } = require('./passPdf');

// Loose but practical email shape check — good enough to avoid emailing empty
// or obviously-broken strings; real validation is the mail server's job.
function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// Build the printable-pass PDF once and email it to each recipient. Best-effort
// and never throws — a mail failure must not break pass issuance. Recipients are
// trimmed, validated, and de-duplicated (visitor + unit owner often differ, but
// guard against them being the same address). Returns:
//   { configured, recipients:[valid...], sent:[...], failed:[...] }
async function emailPass(pass, recipients, { issuerName, issuerRole } = {}) {
  const to = [...new Set((recipients || [])
    .map((r) => (r || '').trim())
    .filter(looksLikeEmail))];
  if (!mailer.isConfigured()) return { configured: false, recipients: to, sent: [], failed: [] };
  if (to.length === 0) return { configured: true, recipients: [], sent: [], failed: [] };

  const token = barcode.signPass({
    passId: pass.id, unitNumber: pass.unit_number, visitorPlate: pass.visitor_plate,
    issuedAt: pass.issued_at, expiresAt: pass.expires_at,
  });
  const shortCode = pass.short_code || barcode.shortCodeForPass(pass.id);
  const pdf = await buildPassPdf({
    pass, token, shortCode,
    issuerName: issuerName || pass.issuer_name,
    issuerRole: issuerRole || pass.issuer_role,
  });
  const attachments = [{
    filename: `parking-pass-${shortCode}.pdf`,
    content: Buffer.from(pdf),
    contentType: 'application/pdf',
  }];

  const sent = [], failed = [];
  for (const addr of to) {
    const result = await mailer.sendMail({
      to: addr,
      subject: `Your visitor parking pass — unit ${pass.unit_number}`,
      text: `Your visitor parking pass is attached.\nUnit ${pass.unit_number} · plate ${pass.visitor_plate}`
        + `\nShort code: ${shortCode}\nValid until ${new Date(pass.expires_at).toLocaleString()}.`,
      attachments,
    });
    if (result.sent) sent.push(addr); else failed.push(addr);
  }
  return { configured: true, recipients: to, sent, failed };
}

module.exports = { emailPass, looksLikeEmail };
