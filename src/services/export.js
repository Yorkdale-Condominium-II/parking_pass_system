'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('./../db');

// ============================================================================
//  Data export for Management — CSV, Excel (.xlsx), and PDF.
//  Each dataset is a { columns:[{key,header}], rows:[{...}] } shape so all three
//  formatters share one definition.
// ============================================================================

const DATASETS = {
  passes: {
    label: 'Visitor passes',
    sql: `SELECT vp.id, u.unit_number, u.kind, vp.visitor_name, vp.visitor_plate,
                 vp.visitor_region, vp.status, vp.was_override,
                 vp.issued_at, vp.expires_at, usr.full_name AS issued_by
            FROM visitor_passes vp
            JOIN units u ON u.id = vp.unit_id
            JOIN users usr ON usr.id = vp.issued_by
           ORDER BY vp.issued_at DESC`,
    columns: [
      ['unit_number', 'Unit'], ['kind', 'Type'], ['visitor_name', 'Visitor'],
      ['visitor_plate', 'Plate'], ['visitor_region', 'Region'], ['status', 'Status'],
      ['was_override', 'Override'], ['issued_at', 'Issued'], ['expires_at', 'Expires'],
      ['issued_by', 'Issued by'],
    ],
  },
  units: {
    label: 'Units',
    sql: `SELECT unit_number, kind, floor, business_name, business_contact, created_at
            FROM units ORDER BY kind, unit_number`,
    columns: [
      ['unit_number', 'Unit'], ['kind', 'Type'], ['floor', 'Floor'],
      ['business_name', 'Business'], ['business_contact', 'Business contact'], ['created_at', 'Created'],
    ],
  },
  residents: {
    label: 'Residents',
    sql: `SELECT u.unit_number, r.full_name, r.email, r.phone, r.is_primary
            FROM residents r JOIN units u ON u.id = r.unit_id
           ORDER BY u.unit_number`,
    columns: [
      ['unit_number', 'Unit'], ['full_name', 'Name'], ['email', 'Email'],
      ['phone', 'Phone'], ['is_primary', 'Primary'],
    ],
  },
  vehicles: {
    label: 'Registered vehicles',
    sql: `SELECT u.unit_number, rv.licence_plate, rv.province, rv.make, rv.model,
                 rv.color, r.full_name AS resident_name
            FROM registered_vehicles rv
            JOIN units u ON u.id = rv.unit_id
            LEFT JOIN residents r ON r.id = rv.resident_id
           ORDER BY u.unit_number`,
    columns: [
      ['unit_number', 'Unit'], ['licence_plate', 'Plate'], ['province', 'Prov/State'],
      ['make', 'Make'], ['model', 'Model'], ['color', 'Colour'], ['resident_name', 'Resident'],
    ],
  },
  pass_audit: {
    label: 'Pass audit log',
    sql: `SELECT al.created_at, al.action, u.full_name AS actor, u.role AS actor_role,
                 un.unit_number, vp.visitor_plate
            FROM pass_audit_log al
            LEFT JOIN users u ON u.id = al.actor_id
            LEFT JOIN visitor_passes vp ON vp.id = al.pass_id
            LEFT JOIN units un ON un.id = vp.unit_id
           ORDER BY al.created_at DESC`,
    columns: [
      ['created_at', 'Time'], ['action', 'Action'], ['actor', 'Actor'],
      ['actor_role', 'Role'], ['unit_number', 'Unit'], ['visitor_plate', 'Plate'],
    ],
  },
  auth_audit: {
    label: 'Sign-in audit log',
    sql: `SELECT aa.created_at, aa.event, aa.success, aa.username,
                 u.full_name AS actor, u.role AS actor_role, aa.ip
            FROM auth_audit_log aa
            LEFT JOIN users u ON u.id = aa.user_id
           ORDER BY aa.created_at DESC`,
    columns: [
      ['created_at', 'Time'], ['event', 'Event'], ['success', 'Success'],
      ['username', 'Username'], ['actor', 'Name'], ['actor_role', 'Role'], ['ip', 'IP'],
    ],
  },
  requests: {
    label: 'Pass requests',
    sql: `SELECT pr.created_at, pr.status, u.unit_number, pr.requester_name,
                 pr.requester_contact, pr.visitor_plate,
                 concat_ws(' ', pr.visitor_first_name, pr.visitor_last_name) AS visitor_name,
                 usr.full_name AS decided_by, pr.decided_at
            FROM pass_requests pr
            JOIN units u ON u.id = pr.unit_id
            LEFT JOIN users usr ON usr.id = pr.decided_by
           ORDER BY pr.created_at DESC`,
    columns: [
      ['created_at', 'Submitted'], ['status', 'Status'], ['unit_number', 'Unit'],
      ['requester_name', 'Requester'], ['requester_contact', 'Contact'],
      ['visitor_name', 'Visitor'], ['visitor_plate', 'Plate'],
      ['decided_by', 'Decided by'], ['decided_at', 'Decided'],
    ],
  },
};

function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

async function fetchDataset(name) {
  const def = DATASETS[name];
  if (!def) { const e = new Error('Unknown dataset'); e.code = 'unknown_dataset'; throw e; }
  const { rows } = await db.query(def.sql);
  return { def, rows };
}

function toCsv(def, rows) {
  const esc = (s) => {
    const str = cell(s);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const head = def.columns.map(([, h]) => esc(h)).join(',');
  const body = rows.map((r) => def.columns.map(([k]) => esc(r[k])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

async function toXlsx(def, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Parking Pass System';
  wb.created = new Date();
  const ws = wb.addWorksheet(def.label.slice(0, 31));
  ws.columns = def.columns.map(([k, h]) => ({ header: h, key: k, width: Math.max(12, h.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10151C' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rows.forEach((r) => {
    const obj = {};
    def.columns.forEach(([k]) => { obj[k] = cell(r[k]); });
    ws.addRow(obj);
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: def.columns.length } };
  return wb.xlsx.writeBuffer();
}

// Simple landscape table renderer (pdfkit has no native tables).
function toPdf(def, rows, res) {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36 });
  doc.pipe(res);
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colW = pageW / def.columns.length;
  const left = doc.page.margins.left;

  doc.fontSize(16).text(def.label, { align: 'left' });
  doc.fontSize(9).fillColor('#666')
     .text(`Generated ${new Date().toLocaleString()} — ${rows.length} rows`);
  doc.moveDown(0.5);

  const drawHeader = (y) => {
    doc.fontSize(8).fillColor('#fff');
    doc.rect(left, y, pageW, 16).fill('#10151c');
    def.columns.forEach(([, h], i) => {
      doc.fillColor('#fff').text(h, left + i * colW + 3, y + 4, { width: colW - 6, ellipsis: true });
    });
    return y + 16;
  };

  let y = drawHeader(doc.y);
  doc.fontSize(8);
  rows.forEach((r, idx) => {
    if (y > doc.page.height - doc.page.margins.bottom - 16) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    if (idx % 2 === 0) doc.rect(left, y, pageW, 14).fill('#f2f4f7');
    def.columns.forEach(([k], i) => {
      doc.fillColor('#111').text(cell(r[k]), left + i * colW + 3, y + 3, { width: colW - 6, ellipsis: true, lineBreak: false });
    });
    y += 14;
  });
  doc.end();
}

module.exports = { DATASETS, fetchDataset, toCsv, toXlsx, toPdf };
