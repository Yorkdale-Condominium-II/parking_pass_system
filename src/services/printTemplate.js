'use strict';

// ============================================================================
//  Print-ready 8.5 x 11 visitor parking pass (single self-contained HTML doc).
//  Designed to fill one US-Letter portrait sheet with an @page rule so it
//  prints edge-to-edge from a browser's Print dialog.
// ============================================================================

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(dt) {
  const d = new Date(dt);
  return d.toLocaleString('en-CA', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function renderPassSheet({ pass, token, qrDataUrl }) {
  const roleLabel = { security: 'Security', management: 'Management', board: 'Board' }[pass.issuer_role]
    || pass.issuer_role;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Visitor Parking Pass — Unit ${esc(pass.unit_number)}</title>
<style>
  @page { size: 8.5in 11in; margin: 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #10151c;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    width: 7.5in;             /* 8.5in minus 0.5in margins each side */
    min-height: 10in;
    margin: 0 auto;
    border: 4px solid #10151c;
    border-radius: 10px;
    padding: 0.35in;
    display: flex;
    flex-direction: column;
  }
  .brand {
    text-align: center;
    border-bottom: 3px solid #10151c;
    padding-bottom: 14px;
    margin-bottom: 18px;
  }
  .brand h1 { font-size: 34px; margin: 0; letter-spacing: 1px; }
  .brand .sub { font-size: 15px; color: #55606c; margin-top: 4px; text-transform: uppercase; letter-spacing: 3px; }

  .unit-banner {
    background: #10151c; color: #fff; text-align: center;
    border-radius: 8px; padding: 16px; margin-bottom: 20px;
  }
  .unit-banner .lbl { font-size: 13px; letter-spacing: 4px; text-transform: uppercase; opacity: .8; }
  .unit-banner .val { font-size: 52px; font-weight: 800; line-height: 1.05; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
  .field { border: 2px solid #d3dae2; border-radius: 8px; padding: 12px 14px; }
  .field .lbl { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #6a7581; }
  .field .val { font-size: 20px; font-weight: 700; margin-top: 4px; }

  .expiry { grid-column: 1 / -1; border: 3px solid #b3261e; background: #fdecea; }
  .expiry .lbl { color: #b3261e; }
  .expiry .val { color: #b3261e; font-size: 24px; }

  .barcode { text-align: center; margin-top: auto; padding-top: 18px; border-top: 2px dashed #b7c0ca; }
  .barcode img { width: 2.4in; height: 2.4in; }
  .barcode .token { font-family: "Courier New", monospace; font-size: 9px; color: #8b95a1; word-break: break-all; margin-top: 8px; max-width: 6in; margin-left: auto; margin-right: auto; }
  .barcode .note { font-size: 12px; color: #55606c; margin-top: 6px; }

  .foot { text-align: center; font-size: 11px; color: #8b95a1; margin-top: 14px; }

  @media screen {
    body { background: #eef1f4; padding: 24px 0; }
    .toolbar { text-align: center; margin-bottom: 16px; }
    .toolbar button { font-size: 15px; padding: 10px 22px; border: 0; border-radius: 6px; background: #10151c; color: #fff; cursor: pointer; }
  }
  @media print { .toolbar { display: none; } body { background: #fff; padding: 0; } }
</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">🖨 Print this pass</button></div>
  <div class="sheet">
    <div class="brand">
      <h1>VISITOR PARKING PASS</h1>
      <div class="sub">Yorkdale Condominium II</div>
    </div>

    <div class="unit-banner">
      <div class="lbl">Authorized for Unit</div>
      <div class="val">${esc(pass.unit_number)}</div>
    </div>

    <div class="grid">
      <div class="field">
        <div class="lbl">Visitor Licence Plate</div>
        <div class="val">${esc(pass.visitor_plate)}</div>
      </div>
      <div class="field">
        <div class="lbl">Visitor Name</div>
        <div class="val">${esc(pass.visitor_name || '—')}</div>
      </div>
      <div class="field">
        <div class="lbl">Date &amp; Time Issued</div>
        <div class="val">${esc(fmt(pass.issued_at))}</div>
      </div>
      <div class="field">
        <div class="lbl">Issued By</div>
        <div class="val">${esc(pass.issuer_name)} <span style="font-size:13px;color:#6a7581">(${esc(roleLabel)})</span></div>
      </div>
      <div class="field expiry">
        <div class="lbl">⚠ Expires — Pass Invalid After</div>
        <div class="val">${esc(fmt(pass.expires_at))}</div>
      </div>
    </div>

    <div class="barcode">
      <img src="${qrDataUrl}" alt="Verification QR code">
      <div class="note">Security: scan to verify authenticity. This code is cryptographically signed and cannot be duplicated or altered.</div>
      <div class="token">${esc(token)}</div>
    </div>

    <div class="foot">
      Pass ID: ${esc(pass.id)} &nbsp;•&nbsp; Display this pass on the vehicle dashboard, plate visible.
      Tampering voids the pass and may result in towing at the owner's expense.
    </div>
  </div>
</body>
</html>`;
}

module.exports = { renderPassSheet };
