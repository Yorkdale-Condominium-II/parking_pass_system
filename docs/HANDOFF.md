# Project Handoff — Parking Pass System

A continuation guide for picking this project back up in a new session.

- **Repo:** `Yorkdale-Condominium-II/parking_pass_system`
- **Working branch:** `claude/condo-property-management-8f0seo`
- **Latest commit at handoff:** `8d324ca`
- **Tests:** `npm test` → 55 integration cases, all passing (needs a Postgres test DB).

---

## Versioning

`package.json`'s `version` is the single source of truth. `src/config.js` reads
it, `GET /api/settings` returns it (public), and the SPA shows it as a `vX.Y.Z`
badge in the top-bar header and in the browser tab title. **Bump `package.json`
with every committed change** so the running build is identifiable at a glance
(semver: patch for fixes, minor for features). Current: **1.24.0**.

---

## 0. Two editions — standard vs. physical-tag (TAG_MODE)

There are now **two ways to run the same codebase**, so the board can compare
them side by side. Everything below §1 describes the shared system; this section
is the only behavioural difference.

- **Standard edition** — `start.bat`, port **3000**. Printable/QR passes only.
  Unchanged; this is the baseline.
- **Physical-tag edition** — `start-tags.bat`, port **3100**, launched with
  `TAG_MODE=true`; stop with `stop-tags.bat`. Models the change-room-tag idea:
  the concierge hands the visitor a **numbered hard-plastic tag** from a finite
  pool (5, matching the spot capacity).

**What TAG_MODE changes (all gated behind the flag — off = standard system):**
- Schema **v14**: `parking_tags` pool (5 tags) + `visitor_passes.tag_id`.
- Issuing a pass claims the **lowest available** tag (`FOR UPDATE SKIP LOCKED`);
  the issue screen says "Give the visitor **Tag #N**". A **"Next tag: #N"**
  banner on the Issue form (fed by `GET /api/tags`) previews which tag the next
  pass will claim, or warns when none are free; it refreshes after each issue.
  The pool is a **hard cap** — a 6th concurrent car returns `no_tags_available`
  (409), even with a spot override. Vacate/revoke/return frees the tag.
- **Tags board** on the Spots page (`GET /api/tags`) with a per-tag **Return**
  button (`POST /api/tags/:number/return`) that frees the tag *and* its spot,
  and a per-tag **History** button (`GET /api/tags/:number/history`) showing
  every pass that tag has carried — visitor, unit, plate, issuer, and outcome
  (Active / Returned / Revoked), newest first. Derived from `visitor_passes`
  (passes retain `tag_id` after vacate/revoke), so no separate log table.
- **Auto-email on issue** (v15): the Issue form asks for a **visitor email**
  (required in TAG_MODE) — or the officer ticks **"Visitor has no email — print
  the pass instead"**, which skips the email and auto-opens the printable sheet.
  On submit the pass PDF is emailed to the **visitor** *and* the **unit owner on
  file** (`units.owner_email`). Best-effort via `src/services/passEmail.js`
  (builds the PDF once, sends to each recipient, never blocks issuance); inert
  until SMTP is set, in which case the response reports `emailDelivery:
  {configured:false,...}` and the UI says so. Server stores the address in
  `visitor_passes.visitor_email` and enforces the requirement **before** claiming
  a tag. The emailed PDF (`passPdf.js`) now shows the **expiry in a bold red box**
  like the printable sheet.
- **Email / Text the printable QR pass** from the issue screen
  (`POST /api/passes/:id/email` and `/text`). Email uses the existing mailer
  (now via `passEmail`); texting is **Twilio** plumbing
  (`src/services/smsSender.js`) that stays inert until `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` are set — both return
  **409 (`email_not_configured` / `sms_not_configured`)** until then.
  **No NFC** (deliberately deferred).
- **Isolation:** set `TAGS_DATABASE_URL` in `.env` to give the tag edition its
  own database (fully separate demo data); unset, it shares `DATABASE_URL`.

---

## 1. What the system does today

A Node.js/Express + PostgreSQL app (vanilla JS front-end) for condo visitor
parking. Two roles: **Security** (limited access) and **Management**
("Yorkdale Manager", bootstrapped as superuser). The former **Board** role was
retired (v12 migration converts any board accounts to Security); the aggregate
**Dashboard** it used is now a management-only view. Nav is organised into
pages: **Issue Pass** (primary), **Lookup & Verify**, **Spots & Dashboard**,
**Requests**, and a **System Management** group (Yorkdale Manager, Account).

Implemented and tested:
- Auth: username/password (bcrypt, JWT httpOnly session), rate-limited logins,
  sign-in audit log.
- **Temporary password → forced reset** on first login; users **self-link**
  Google/Microsoft on the **Account** screen; SSO login matched by provider
  subject then email (SSO authenticates; the users table authorizes).
- Lookup by plate / unit / name / phone.
- Issue passes: unit validated against registry, split visitor name, province/
  state, duration presets (rest of today / noon tomorrow), **scheduling** a
  future start.
- Quotas: 10/yr residential, 20/yr commercial (config), weekly rotating
  **override code**.
- **5 physical spaces**: building-wide live-occupancy cap with peak-overlap
  check across scheduled windows; **security spot-override**; **Spots** live
  board; **vacate** to free a spot early.
- **Per-unit active-pass cap** (v16, both editions): each unit has an
  **occupancy** (`owner`|`tenant`, default `owner`) and **tenant_count**. An
  owner-occupied unit may hold **1** simultaneously-active visitor pass; a
  tenant-shared unit allows **one per tenant** (`tenant_count`). Enforced in
  `passService` via `spots.evaluateUnitConcurrency` (peak overlap of the unit's
  active, non-vacated passes over the new pass's window) as a **hard cap** — no
  override — returning **409 `unit_active_limit`**. Separate from the annual
  quota and the 5-space cap. Existing units default to owner (limit 1); staff
  set occupancy/tenant count in the Manager console unit editor (also shown as
  an "Occupancy" column in the units table). Bulk import doesn't set it yet.
- Verify: camera QR + printed short code + token; verdicts VALID / EXPIRED /
  REVOKED / SCHEDULED / VACATED. **Cancel** a pass from Lookup / Verify / Spots.
- Cryptographic barcode (HMAC-SHA256 signed token) + human short code.
- Print-ready 8.5×11 sheet (QR + short code + vacated-spot notice; no raw token).
- **Resident portal** (`/resident.html`): public request form → pending →
  staff approve/deny; short 6-char reference; public status lookup; approval
  emails the pass PDF when SMTP is configured.
- **Open Desk kiosk** (`/desk.html`): issue with officer dropdown + password,
  **or** start a ~30-min **desk session via Google/Microsoft** and skip
  per-pass passwords.
- **Bulk unit import** (`POST /api/admin/units/import`, management-only): load
  the real unit registry from an Excel workbook (`xlsxBase64`, parsed server-side
  with exceljs), a JSON array (`units`), or CSV text (`csv`; header row, aliased
  columns). Idempotent upsert on `unit_number`; enforces the
  residential cap against combined existing + new; reports per-row errors
  (missing number, duplicate-in-import, commercial-without-business-name,
  cap-reached) without aborting. UI on the Manager console ("Bulk import units").
- **Superuser flag** (`users.is_superuser`, v10 migration): only superusers may
  change a user's role — their own on the **Account** screen, or others' in the
  Manager console (`is_superuser` toggle + role change gated to superusers).
  Bootstrap promotes existing Management accounts when no superuser exists yet.
- **Self-service password reset by email** (`POST /api/auth/forgot-password` →
  emailed link → `POST /api/auth/reset-password`, v11 `password_resets` table):
  single-use SHA-256-hashed token, 60-min expiry, generic response (no account
  enumeration). Login link on the SPA; the emailed URL is `/?reset=<token>`.
  **Needs SMTP configured** (see §2) to actually send. Disabled accounts are
  never eligible — a lockout is fixed locally with the recovery tool below.
- **Emergency recovery** (locked out / account disabled / lost password): run
  **`recover-admin.bat`** (or `npm run recover -- <username> <newPassword>`) on
  the server PC. It re-enables the account, sets a temporary password, and
  grants superuser so you can fix things in the UI. No login/email required.
- **Self-service Account edit**: users edit their own username / name / email
  (and password); the role field is locked unless they're a superuser. The
  session token is re-issued on save so changes apply without re-login.
- **Nav grouping**: the top bar groups **Yorkdale Manager** + **Account** under
  a "System Management" label.
- **Yorkdale Manager** console: settings (company/condo name), manage users
  (create/activate/deactivate/reset pw/history/**delete**), pass + sign-in audit
  logs, — *delete* is superuser-only, needs a typed "Delete" confirmation, blocks
  self-deletion, and returns 409 for accounts with activity history (FK-protected;
  disable them instead),
  weekly override code, data export (CSV/XLSX/PDF), year-end archive & clear,
  clear-all-logs.
- Board dashboard: aggregates only (no PII).

## 2. Outstanding / optional configuration (needs YOUR credentials)

These are built but inert until configured in `.env` (see `.env.example`):

- **Email (approval + password-reset emails):** use the building Gmail
  **`yorkdalecondominiumii@gmail.com`** (a personal @gmail.com, so it *can*
  create an App Password — unlike the Workspace account). Turn on 2-Step, make
  an App Password, and set `SMTP_*` + `MAIL_FROM` (ready-to-uncomment block in
  `.env.example`).
- **Google/Microsoft SSO:** register OAuth apps; set `GOOGLE_CLIENT_*` /
  `MICROSOFT_CLIENT_*` + `OAUTH_BASE_URL`. Redirect URI:
  `<OAUTH_BASE_URL>/api/auth/sso/<google|microsoft>/callback`.
  Never end-to-end tested (no real provider creds yet) — first real login is
  the test.
- **Google Sheets mirror:** set `SHEETS_WEBHOOK_URL` (+ optional
  `SHEETS_WEBHOOK_TOKEN`) to copy every pass event (issued/revoked/vacated) into
  a Google Sheet via an Apps Script web app. Best-effort, off the critical path.
  Full 5-minute setup + the script to paste is in `docs/GOOGLE_SHEETS.md`.
  Status shows in Manager → Download data.
- **SMS / Text pass (TAG edition):** set `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` to enable the "💬 Text pass" button. Uses
  Twilio's HTTP API directly (no SDK); inert and returns 409 until configured.

## 3. Run it on the user's PC (Windows)

Double-click **`start.bat`** (auto: git pull → npm install → migrate → launch
the server **hidden in the background** → wait until it responds → open the
browser → **the launcher window closes itself**). The server keeps running after
the window closes; its output goes to `server.log` / `server.err.log`. To stop
it, double-click **`stop.bat`** (frees whatever is listening on port 3000).

To run the **physical-tag edition** instead (or alongside), double-click
**`start-tags.bat`** — same flow on port **3100** with `TAG_MODE=true`; stop it
with **`stop-tags.bat`**. Its output goes to `server-tags.log` /
`server-tags.err.log`. Both editions can run at once (3000 and 3100).

First time only, pull manually:
```
cd %USERPROFILE%\Desktop\parking_pass_system
git checkout -- package-lock.json
git pull
```
Optional: run `create-desktop-shortcut.bat` once for a Desktop icon.

Requirements: Node 18+, PostgreSQL 16 (service running), a `.env` with
`DATABASE_URL`, `JWT_SECRET`, `BARCODE_SECRET` (and optionally the items in §2).
Seeded demo logins (dev only): `security1` / `manager1`, pw
`changeme123`. URLs: app `/`, desk `/desk.html`, resident `/resident.html`.

## 4. Dev / test in a fresh cloud session

```
npm install
# point at a THROWAWAY test DB (the suite truncates tables):
export TEST_DATABASE_URL='postgres://.../parking_pass_test'
npm test          # expect 55 passing
```
The schema is one idempotent file (`db/schema.sql`) with additive v2–v16
migration blocks; `npm run migrate` re-applies safely. The tag tests flip
`config.tagMode` on/off in-process and reset `parking_tags` around themselves,
so the standard-mode tests are unaffected.

## 5. Code map

```
src/server.js            route wiring + helmet CSP
src/config.js            env-driven config (quota, spots, sso, etc.)
src/db.js                pg pool + withTransaction
src/auth/                password (bcrypt), middleware (JWT, desk session), sso helpers
src/crypto/barcode.js    HMAC token, short code, weekly override code
src/services/            quota, spots, passService, printTemplate, passPdf,
                         export, mailer, smsSender (Twilio), backupArchive, sheetsLog
src/routes/              auth, sso, meta, settings, passes, verify, admin, board,
                         resident, requests, spots, desk, tags (TAG_MODE)
public/                  index.html + app.js (SPA), desk.html/js, resident.html/js, styles.css
db/schema.sql            schema + v2..v16 idempotent migrations (v14 = parking_tags, v15 = visitor_email, v16 = unit occupancy cap)
start-tags.bat/stop-tags.bat  launch/stop the TAG_MODE edition on port 3100
test/integration.test.js 55 end-to-end cases (node:test); last 4 are tag/delivery
```

## 6. Deferred ideas / possible next steps
- **Tag edition:** wire real Twilio creds and send a test text; consider a
  "lost tag" workflow (mark a tag lost so it leaves the pool) and printing
  tag-number labels. NFC is intentionally out of scope for now.
- Configure + prove real Google (and Microsoft) SSO end-to-end.
- Configure email (Brevo recommended) and verify an approval email.
- Per-unit access code for the resident portal (anti-spam) if needed.
- HTTPS + always-on host so desk/resident pages are reachable on the LAN and
  SSO works on a non-localhost URL.
- Bulk-import the real 1520 residential units + commercial tenants.

## 7. Paste this into the new session to resume

> Continue work on the parking_pass_system repo, branch
> `claude/condo-property-management-8f0seo` (the repo's default branch — all
> history lives here, not the stale `cont-14z83q`). Read `docs/HANDOFF.md` first
> for full context — start with §0 (the two editions). It's a Node/Express +
> PostgreSQL condo visitor-parking app at **v1.20.0**; **50** integration tests
> currently pass. I'm working on the **physical hard-plastic tag edition**
> (`TAG_MODE`, `start-tags.bat`, port 3100). I want to work on: <YOUR NEXT TASK>.
> Follow the existing rhythm: build → run `npm test` (must stay green) → bump
> the version in `package.json` → commit + push to the branch. Keep `db/schema.sql`
> migrations idempotent and add cases to `test/integration.test.js`.
