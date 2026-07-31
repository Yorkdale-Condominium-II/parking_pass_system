# Mirror visitor-pass data to a Google Sheet

The app can send a copy of every pass event to a Google Sheet, so you have a
running log outside the app (easy to share, filter, chart, or archive).

It uses a **Google Apps Script web app** as the bridge — no service-account key
files, and it works fine with a Google **Workspace** account. The app just
POSTs each event to a URL you paste into `.env`. Until that URL is set, the
feature is completely inert (nothing is sent).

Events mirrored: **issued**, **revoked**, **vacated**.

---

## One-time setup (about 5 minutes)

1. **Create the sheet.** In Google Drive, make a new Google Sheet (e.g.
   "Yorkdale Visitor Parking Log").

2. **Open the script editor.** In the sheet: **Extensions → Apps Script**.

3. **Paste this script** (replace the whole default `Code.gs`). It appends a row
   per event and keeps the sheet formatted (bold centered UPPER-CASE headers,
   column A shown as `DD MMM YYYY`, data columns C–N centered/bold, widths
   auto-fit).

   ```javascript
   // Optional: set this to the same value as SHEETS_WEBHOOK_TOKEN in .env.
   // Leave '' to accept any post.
   const SHARED_TOKEN = '';

   // Payload keys (order = column order) and the UPPER-CASE header labels.
   const KEYS = ['at', 'event', 'unit', 'kind', 'plate', 'visitor', 'issuer',
                 'issuedAt', 'startsAt', 'expiresAt', 'shortCode', 'override',
                 'spotOverride', 'passId'];
   const HEADERS = ['AT', 'EVENT', 'UNIT', 'KIND', 'PLATE', 'VISITOR', 'ISSUER',
                    'ISSUED AT', 'STARTS AT', 'EXPIRES AT', 'SHORT CODE',
                    'OVERRIDE', 'SPOT OVERRIDE', 'PASS ID'];

   function doPost(e) {
     try {
       const data = JSON.parse(e.postData.contents || '{}');
       if (SHARED_TOKEN && data.token !== SHARED_TOKEN) {
         return ContentService.createTextOutput('forbidden');
       }
       const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
       if (sheet.getLastRow() === 0) { sheet.appendRow(HEADERS); applyFormatting(sheet); }
       sheet.appendRow(KEYS.map(function (k) {
         var v = data[k];
         if (v === undefined || v === null) return '';
         if (k === 'at') { var d = new Date(v); return isNaN(d.getTime()) ? v : d; }
         return v;
       }));
       sheet.autoResizeColumns(1, KEYS.length); // keep widths fitting the data
       return ContentService.createTextOutput('ok');
     } catch (err) {
       return ContentService.createTextOutput('error: ' + err);
     }
   }

   // Apply all formatting to a sheet. Safe to run any time.
   function applyFormatting(sheet) {
     sheet = sheet || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
     const n = KEYS.length;
     const maxRows = sheet.getMaxRows();
     // Header row: UPPER-CASE, bold, centered, frozen.
     sheet.getRange(1, 1, 1, n).setValues([HEADERS])
          .setFontWeight('bold').setHorizontalAlignment('center');
     sheet.setFrozenRows(1);
     // Column A → real dates shown as DD MMM YYYY.
     const lastRow = sheet.getLastRow();
     if (lastRow > 1) {
       const a = sheet.getRange(2, 1, lastRow - 1, 1);
       const vals = a.getValues().map(function (r) {
         var d = new Date(r[0]); return [isNaN(d.getTime()) ? r[0] : d];
       });
       a.setValues(vals);
     }
     sheet.getRange('A:A').setNumberFormat('dd mmm yyyy');
     // Columns C..N: centered and bold.
     sheet.getRange(1, 3, maxRows, n - 2).setHorizontalAlignment('center').setFontWeight('bold');
     sheet.autoResizeColumns(1, n);
   }

   // Run this ONCE from the editor (Run ▸ formatNow) to reformat existing rows.
   function formatNow() { applyFormatting(); }
   ```

4. **Deploy as a web app.** Click **Deploy → New deployment** → gear icon →
   **Web app**. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone* (this only means "anyone with the secret URL";
     no one can read your sheet, they can only append via the script)

   Click **Deploy**, authorize when prompted, and **copy the Web app URL**
   (looks like `https://script.google.com/macros/s/AKfy…/exec`).

5. **Tell the app.** In your `.env` (next to `DATABASE_URL` etc.) add:

   ```
   SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfy…/exec
   ```

   If you set `SHARED_TOKEN` in the script, also add the matching
   `SHEETS_WEBHOOK_TOKEN=…` line.

6. **Restart** the app (`stop.bat` then `start.bat`). Issue a test pass — a new
   row should appear in the sheet within a couple of seconds.

---

## Notes

- **Best-effort, never blocking.** If Google is slow or the URL is wrong, pass
  issuance still succeeds instantly; the mirror just logs a warning to
  `server.err.log`. The app's own database remains the source of truth.
- **Updating the script later:** after editing the Apps Script you must
  **Deploy → Manage deployments → Edit → New version** for changes to take
  effect (the `/exec` URL stays the same).
- **Security:** set a `SHARED_TOKEN` so only your app can append. The URL should
  still be treated as a secret.
- This mirrors events going forward. To back-fill existing passes, use
  **Yorkdale Manager → Download data** to export and paste into the sheet.
