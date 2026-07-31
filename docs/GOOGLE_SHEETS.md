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

3. **Paste this script** (replace the whole default `Code.gs`):

   ```javascript
   // Optional: set this to the same value as SHEETS_WEBHOOK_TOKEN in .env.
   // Leave '' to accept any post.
   const SHARED_TOKEN = '';

   function doPost(e) {
     try {
       const data = JSON.parse(e.postData.contents || '{}');
       if (SHARED_TOKEN && data.token !== SHARED_TOKEN) {
         return ContentService.createTextOutput('forbidden');
       }
       const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
       const headers = ['at', 'event', 'unit', 'kind', 'plate', 'visitor',
                        'issuer', 'issuedAt', 'startsAt', 'expiresAt',
                        'shortCode', 'override', 'spotOverride', 'passId'];
       // Write the header row once.
       if (sheet.getLastRow() === 0) sheet.appendRow(headers);
       sheet.appendRow(headers.map(function (h) {
         return data[h] === undefined || data[h] === null ? '' : data[h];
       }));
       return ContentService.createTextOutput('ok');
     } catch (err) {
       return ContentService.createTextOutput('error: ' + err);
     }
   }
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
