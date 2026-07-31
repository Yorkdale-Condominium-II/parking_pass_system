# Project Handoff — Parking Pass System

A continuation guide for picking this project back up in a new session.

- **Repo:** `Yorkdale-Condominium-II/parking_pass_system`
- **Working branch:** `claude/condo-property-management-8f0seo`
- **Latest commit at handoff:** `ae68cd9`
- **Tests:** `npm test` → 42 integration cases, all passing (needs a Postgres test DB).

---

## Versioning

`package.json`'s `version` is the single source of truth. `src/config.js` reads
it, `GET /api/settings` returns it (public), and the SPA shows it as a `vX.Y.Z`
badge in the top-bar header and in the browser tab title. **Bump `package.json`
with every committed change** so the running build is identifiable at a glance
(semver: patch for fixes, minor for features). Current: **1.14.0**.

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

- **Email (approval emails):** SMTP via Gmail App Password or a service like
  Brevo. Set `SMTP_*` + `MAIL_FROM`. NOTE: the condo's Google **Workspace**
  account cannot create App Passwords (policy) — use a personal Gmail with
  2-Step on, or a free SMTP service (Brevo/SMTP2GO).
- **Google/Microsoft SSO:** register OAuth apps; set `GOOGLE_CLIENT_*` /
  `MICROSOFT_CLIENT_*` + `OAUTH_BASE_URL`. Redirect URI:
  `<OAUTH_BASE_URL>/api/auth/sso/<google|microsoft>/callback`.
  Never end-to-end tested (no real provider creds yet) — first real login is
  the test.

## 3. Run it on the user's PC (Windows)

Double-click **`start.bat`** (auto: git pull → npm install → migrate → launch
the server **hidden in the background** → wait until it responds → open the
browser → **the launcher window closes itself**). The server keeps running after
the window closes; its output goes to `server.log` / `server.err.log`. To stop
it, double-click **`stop.bat`** (frees whatever is listening on port 3000).
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
npm test          # expect 42 passing
```
The schema is one idempotent file (`db/schema.sql`) with additive v2–v9
migration blocks; `npm run migrate` re-applies safely.

## 5. Code map

```
src/server.js            route wiring + helmet CSP
src/config.js            env-driven config (quota, spots, sso, etc.)
src/db.js                pg pool + withTransaction
src/auth/                password (bcrypt), middleware (JWT, desk session), sso helpers
src/crypto/barcode.js    HMAC token, short code, weekly override code
src/services/            quota, spots, passService, printTemplate, passPdf, export, mailer
src/routes/              auth, sso, meta, settings, passes, verify, admin, board,
                         resident, requests, spots, desk
public/                  index.html + app.js (SPA), desk.html/js, resident.html/js, styles.css
db/schema.sql            schema + v2..v9 idempotent migrations
test/integration.test.js 42 end-to-end cases (node:test)
```

## 6. Deferred ideas / possible next steps
- Configure + prove real Google (and Microsoft) SSO end-to-end.
- Configure email (Brevo recommended) and verify an approval email.
- Per-unit access code for the resident portal (anti-spam) if needed.
- HTTPS + always-on host so desk/resident pages are reachable on the LAN and
  SSO works on a non-localhost URL.
- Bulk-import the real 1520 residential units + commercial tenants.

## 7. Paste this into the new session to resume

> Continue work on the parking_pass_system repo, branch
> `claude/condo-property-management-8f0seo`. Read `docs/HANDOFF.md` first for
> full context. It's a Node/Express + PostgreSQL condo visitor-parking app;
> 32 integration tests currently pass. I want to work on: <YOUR NEXT TASK>.
> Follow the existing patterns (idempotent `db/schema.sql` migrations,
> integration tests in `test/integration.test.js`, commit + push to the branch).
