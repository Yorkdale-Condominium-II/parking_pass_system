# Yorkdale Condominium II — Parking Pass System

An all-in-one property-management web application that centralizes **visitor
parking administration**, **resident vehicle registration**, and
**operational oversight** across three roles: **Security**, **Management**, and
the **Board of Directors**.

---

## 1. Recommended tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Front-end | Vanilla SPA (served static) | Zero build step; swap for **React/Next.js** as the UI grows |
| Back-end API | **Node.js + Express** | Fast to build, huge ecosystem, easy to containerize |
| Database | **PostgreSQL** | Strong relational integrity, `FOR UPDATE` locking for quota races, JSONB audit detail |
| Auth | **JWT** (httpOnly cookie) + **bcrypt** | Stateless sessions, hashed passwords |
| Barcode | **QR (Code-128 capable)** + **HMAC-SHA256** | Signed, tamper-evident payload |

This repo ships the vanilla SPA to stay dependency-light and instantly runnable.
The API is a clean JSON boundary, so migrating the front-end to Next.js later
requires no back-end changes.

---

## 2. Cryptographic barcode strategy

The barcode is **not plain text**. Each pass encodes a signed token:

```
PPV1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
payload = { v, pid, unit, plate, iat, exp }
```

* The HMAC is computed with a **server-only secret** (`BARCODE_SECRET`). A
  resident cannot forge or edit a pass because they cannot produce a valid
  signature.
* Verification is **constant-time** (`crypto.timingSafeEqual`) to avoid timing
  attacks.
* Signature authenticity is only half the check — verification also reconciles
  against live DB state to detect **expired** and **revoked** passes.

Verdicts returned to Security: `VALID`, `EXPIRED`, `REVOKED`, `FORGED`,
`INVALID`. See `src/crypto/barcode.js` and `src/services/passService.js`.

---

## 3. Database schema

Full DDL in [`db/schema.sql`](db/schema.sql). Core relationships:

```
units 1─* residents
units 1─* registered_vehicles ─? residents
units 1─* visitor_passes ─* pass_audit_log
units 1─* override_grants
users  ─* (issued_by / granted_by / actor)
```

Key rule enforced in SQL + service layer: **max 10 visitor passes per unit per
calendar year** (`ANNUAL_PASS_QUOTA`), raised only by a Management
`override_grant`. Revoked passes do not count.

---

## 4. Quota + override logic

`src/services/quota.js` and `src/services/passService.js`:

* Issuance runs inside a transaction; `SELECT ... FOR UPDATE` locks the unit's
  yearly pass rows so two simultaneous requests can't both slip past the 10th.
* At the limit, issuance is **blocked** — unless the issuer is **Management**
  and supplies `override: true` with a reason, which records an `override_grant`
  and an audit entry.

---

## 5. Print-ready 8.5 × 11 pass

`GET /api/passes/:id/print` returns a self-contained HTML sheet
(`src/services/printTemplate.js`) with an `@page { size: 8.5in 11in }` rule and:

* Prominent **expiry date/time** (highlighted red) and **issuance date/time**
* **Issuer name + role**
* **Unit number** and **visitor licence plate**
* Embedded **signed QR code** (data-URI, no external requests)

Open it in a browser and hit **Print**.

---

## 6. Running locally

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   -> set JWT_SECRET and BARCODE_SECRET (openssl rand -hex 32)
#   -> point DATABASE_URL at a running PostgreSQL

# 3. Create schema + demo data
npm run migrate
npm run seed        # creates security1 / manager1 / board1  (pw: changeme123)

# 4. Start
npm start           # http://localhost:3000
```

### One-click launch on Windows

After the one-time setup (install deps, create the database, `.env`, migrate,
seed), you can start the app by **double-clicking `start.bat`**. It changes into
the project folder, starts the server, and opens `http://localhost:3000` in your
browser. Close the window or press `Ctrl+C` to stop.

### Access from other machines on the LAN

The server already listens on all network interfaces, so other devices on the
same network (e.g. the security desk) can reach it once the firewall allows the
port:

```powershell
# Run once, in an Administrator PowerShell:
New-NetFirewallRule -DisplayName "Parking Pass System (3000)" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow

# Find this machine's LAN address:
ipconfig   # look for "IPv4 Address", e.g. 192.168.1.42
```

Other machines then browse to `http://<that-ip>:3000`. This runs over plain
HTTP on the local network — fine for a trusted LAN, but put it behind HTTPS (a
reverse proxy such as Caddy or nginx) before exposing it beyond that.

### Resident portal (public request page)

`public/resident.html` (served at `/resident.html`) is a login-free page where
residents submit a **visitor-pass request** — unit, their contact, visitor
name/plate/region, and when it's needed. A request creates a `pending` record
only; **no pass exists and no quota is consumed until staff approve it**.
Security/Management review requests under the **Requests** tab: *Approve & issue*
creates the real pass (enforcing quota, with the weekly-code override available
when a unit is at its limit), *Deny* records a reason. Submissions are
rate-limited.

Each request gets a short **6-character reference code** (e.g. `7VHW9S`). The
resident can check status any time at the bottom of the portal by entering it
(`GET /api/resident/status/:ref`). If they provide an **email**, approving the
request emails them the pass with a **printable PDF attached** (requires SMTP —
see `.env.example`; without it, approval still works and the email is skipped).

### Year-end archive & clear (Management)

When passes/requests/audit rows exist from a previous calendar year, the
Management console shows a **"Year-end archive due"** banner prompting a full
download. After exporting, **Clear prior-year data** (double-confirmed)
permanently deletes passes, requests, and audit rows from years *before* the
current one — units, residents, and vehicles are always kept. The action itself
is recorded in the retained audit log.

### Data export (Management)

The Management console can download any core dataset — passes, units, residents,
vehicles, pass audit, sign-in audit, requests — as **CSV**, **Excel (.xlsx)**, or
**PDF** (`GET /api/admin/export?dataset=…&format=…`). CSV and XLSX open directly
in Excel and Google Sheets (File → Import). A native push into Google Sheets
would use the Google API and is deferred alongside SSO.

### Running the test suite

`npm test` runs an end-to-end integration suite (`test/integration.test.js`,
Node's built-in test runner) that boots the app in-process and exercises auth +
RBAC, plate lookup, the 10-pass quota + Management override, barcode
issue/verify (genuine / forged / expired / revoked), the audit log, and the
print sheet.

The suite **truncates tables**, so point it at a dedicated database:

```bash
createdb parking_pass_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/parking_pass_test npm test
```

If `TEST_DATABASE_URL` is unset it falls back to `DATABASE_URL` — don't do that
against a database whose data you want to keep. The suite applies the schema
itself, so no separate migrate step is needed.

---

## 7. API surface (summary)

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| POST | `/api/auth/login` | any | Sign in |
| GET  | `/api/passes/lookup?plate=` | security, management | Plate lookup |
| POST | `/api/passes` | security, management | Issue pass (override = mgmt) |
| GET  | `/api/passes/:id/print` | security, management | Printable sheet |
| POST | `/api/passes/:id/revoke` | security, management | Revoke |
| POST | `/api/verify` | security, management | Verify barcode token |
| POST | `/api/admin/users` · `/units` · `/overrides` | management | Admin |
| GET  | `/api/admin/audit` | management | Audit log |
| GET  | `/api/board/summary` | board, management | Aggregate analytics (no PII) |

---

## 8. Security notes

* Passwords hashed with bcrypt (cost 12); login is rate-limited and
  timing-uniform.
* Sessions are httpOnly, `SameSite=strict`, `Secure` in production.
* Board role is structurally denied resident PII and plate data — its endpoint
  only returns aggregates.
* Barcode secret is distinct from the JWT secret so rotating one doesn't
  invalidate the other.
