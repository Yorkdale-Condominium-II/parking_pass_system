# Changelog

All notable changes to this project are documented here. Dates are in the
property's local time (America/Toronto).

## v1.24.0 — 2026-08-06

Security hardening + a new visitor-pass duration model.

### Security

- **Revocable login sessions.** Every login JWT now carries a random `jti`
  recorded in a new `auth_sessions` table (v16 migration, 8-hour expiry).
  Sessions can be invalidated before expiry via:
  - `POST /api/auth/logout` (revokes the caller's session),
  - `POST /api/auth/sessions/revoke-all` ("sign out all other devices"),
  - `POST /api/admin/users/:id/sessions/revoke` (management),
  - deactivating a user (auto-revokes their live sessions).
- **Live role/active check.** `requireAuth` re-reads `role` and `is_active`
  from the database on each request, so a demoted or disabled account is locked
  out immediately (`session_revoked` / `session_invalid`).
- **Content-Security-Policy tightened:** `script-src 'self'`,
  `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'` (styles remain inline pending a later pass).
- **Output escaping:** a shared `esc()` helper HTML-escapes every
  server-supplied value rendered into the SPA before it reaches `innerHTML`.
- **`trust proxy` is now configurable** via `TRUST_PROXY` (default `0` = trust
  no proxy), preventing `X-Forwarded-For` spoofing unless a proxy is declared;
  a boot warning fires when trusting a proxy in production.
- **Secret hygiene:** broadened `.gitignore` (`.env`, `.env.*`, `*.log`,
  `*.err.log`), a `.githooks/pre-commit` guard that refuses to stage a real
  `.env` or log file, and `<GENERATE-NEW>` placeholders in `.env.example`.

### Features

- **New pass durations:** **Short Stay** (expires after 6h or 11 PM local,
  whichever is first) and **Overnight** (expires 8 AM the next local day).
  The legacy `today` / `tomorrow_noon` presets are retained for compatibility.
  Surfaced on the staff, desk, and resident forms; recorded in
  `visitor_passes.duration_mode` (v17 migration).
- **One active pass per unit at a time** (`unit_already_has_active_pass`),
  alongside the existing 10-per-year residential cap. Backed by a partial
  unique index on `(unit_id, start_date)` for same-day races.

### Migrations

- **v16** — `auth_sessions` (revocable sessions).
- **v17** — `visitor_passes.duration_mode`, a generated `start_date` column,
  and the `idx_pass_one_per_unit_per_day` partial unique index (created
  defensively so an existing DB with same-day duplicates still migrates).

### Notes for operators

- Rotate `JWT_SECRET`, `BARCODE_SECRET`, `OVERRIDE_SECRET`, the database
  password, SMTP/Brevo credentials, the Google OAuth client, and the Sheets
  webhook token. **Rotating `BARCODE_SECRET` invalidates every issued pass
  barcode** — only do it deliberately.
- Test files now run serially (`--test-concurrency=1`) because they share one
  database.
