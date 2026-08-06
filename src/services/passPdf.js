'use strict';
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// Build a one-page PDF of a visitor pass (QR + details + short code) as a
// Buffer, suitable for emailing to a resident. Mirrors the on-screen sheet.
async function buildPassPdf({ pass, token, shortCode, issuerName, issuerRole }) {
  const qrPng = await QRCode.toBuffer(token, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - doc.page.margins.left * 2;

    doc.rect(doc.page.margins.left, doc.y, W, 4).fill('#10151c');
    doc.moveDown(0.5);
    doc.fillColor('#10151c').fontSize(26).font('Helvetica-Bold')
       .text('VISITOR PARKING PASS', { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#55606c')
       .text('Yorkdale Condominium II', { align: 'center' });
    doc.moveDown(1);

    // Unit banner
    doc.fillColor('#10151c').fontSize(14).text(`Authorized for Unit ${pass.unit_number}`, { align: 'center' });
    doc.moveDown(1);

    const region = pass.visitor_region ? ` (${String(pass.visitor_region).replace('-', ' ')})` : '';
    const scheduled = pass.starts_at &&
      (new Date(pass.starts_at).getTime() - new Date(pass.issued_at).getTime() > 60000);
    const rows = [
      ['Visitor licence plate', `${pass.visitor_plate}${region}`],
      ['Visitor name', pass.visitor_name || '—'],
      ['Issued', new Date(pass.issued_at).toLocaleString()],
      ...(scheduled ? [['Valid from', new Date(pass.starts_at).toLocaleString()]] : []),
      ['Issued by', `${issuerName} (${issuerRole})`],
    ];
    doc.fontSize(12);
    rows.forEach(([k, v]) => {
      doc.font('Helvetica-Bold').fillColor('#55606c').text(k + ':', { continued: true });
      doc.font('Helvetica').fillColor('#10151c').text(' ' + v);
      doc.moveDown(0.3);
    });

    // Expiry — highlighted like the printable sheet so it can't be missed.
    doc.moveDown(0.6);
    const boxY = doc.y;
    const boxH = 56;
    doc.save();
    doc.rect(doc.page.margins.left, boxY, W, boxH).fillAndStroke('#fdecea', '#b3261e');
    doc.lineWidth(2).rect(doc.page.margins.left + 1, boxY + 1, W - 2, boxH - 2).stroke('#b3261e');
    doc.fillColor('#b3261e').font('Helvetica-Bold').fontSize(11)
       .text('EXPIRES — PASS INVALID AFTER', doc.page.margins.left, boxY + 10, { width: W, align: 'center' });
    doc.fontSize(19)
       .text(new Date(pass.expires_at).toLocaleString(), doc.page.margins.left, boxY + 28, { width: W, align: 'center' });
    doc.restore();
    doc.y = boxY + boxH;

    doc.moveDown(1);
    const qrSize = 180;
    doc.image(qrPng, (doc.page.width - qrSize) / 2, doc.y, { width: qrSize });
    doc.moveDown(0.5);
    doc.y += qrSize + 6;
    doc.fontSize(16).font('Courier-Bold').fillColor('#10151c')
       .text(`Verification code: ${shortCode}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica').fillColor('#8b95a1')
       .text('Security: scan the QR or key in the verification code. This pass is cryptographically signed and cannot be altered. Display it on the vehicle dashboard with the plate visible. If the vehicle vacates the spot, the Corporation reserves the right to offer the vacated space to the next guest.', { align: 'center' });

    doc.end();
  });
}

module.exports = { buildPassPdf };
