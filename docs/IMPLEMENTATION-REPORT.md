# Implementation Report — Security Hardening + New Pass Durations

**Date:** 2026-08-06 · **Version:** 1.24.0 · **Branch:** `claude/parking-pass-security-hardening-9wio8x`

Two deliverables, kept as separate commits: security fixes first (Tasks 1–3),
then the new duration/issuance features (Tasks 4–7), then wrap-up.

**Test result:** `npm test` → **67/67 passing** (52 integration · 3 auth-sessions
· 8 duration · 4 issuance). `npm audit --omit=dev` → **0 vulnerabilities**.

> Environment note: the prompt referenced `docs/claude-implementation-prompt.md`;
> that file does not exist in this repo (only `docs/HANDOFF.md` and
> `docs/GOOGLE_SHEETS.md`). The pasted prompt was used as the spec. Work was done
> in the Linux clone at `/home/user/parking_pass_system`, not the Windows path.

---

## Task status

| Task | Status | Notes |
|------|--------|-------|
| 1 — Rotate secrets & remove `.env` | ✅ done (with deviation) | `.env` was **never tracked** in this repo, so no `git rm --cached` was possible/needed. `.gitignore` hardened, pre-commit guard added, `.env.example` placeholders → `<GENERATE-NEW>`. Fresh secrets generated and handed to you in chat (not committed). |
| 2 — JWT revocation via session table | ✅ done | v16 `auth_sessions`; `issueSession` async; logout/revoke-all/admin-revoke; tests. |
| 3 — CSP, trust proxy, escaping, live role | ✅ done | Helmet CSP tightened; `TRUST_PROXY` (default 0); `esc()` across all three SPA scripts; `requireAuth` re-reads role/active. Verified: 0 CSP violations in headless Chromium. |
| 4 — Duration DB model (v17) | ✅ done (with fixes) | `duration_mode`, generated `start_date`, partial unique day-index; config rules. Omitted the prompt's invalid `ALTER TYPE pass_status IS NOT NULL` line and the `now()`-in-predicate index (both are invalid SQL). |
| 5 — `computeExpiry` rules | ✅ done | Short Stay / Overnight implemented + overnight guard; `test/duration.test.js`. |
| 6 — Quota + one-active-pass-per-unit | ✅ done (with deviation) | One-active-pass rule + error maps + audit `durationMode`. Quota left configurable (already 10) rather than hard-coded. `byMode` analytics (optional) not added. |
| 7 — Frontend duration modes | ✅ done | Buttons + hints on staff / desk / resident; resident route validates the new+legacy set. |
| Wrap-up | ✅ done | README §8 + duration section, `CHANGELOG.md` v1.24.0, version bump, this report. |

---

## New / changed files

**New**

- `.githooks/pre-commit` — refuses to stage `.env` / log files.
- `CHANGELOG.md` — v1.24.0 entry.
- `docs/IMPLEMENTATION-REPORT.md` — this file.
- `test/auth-sessions.test.js`, `test/duration.test.js`, `test/issuance.test.js`.

**Changed**

- `db/schema.sql` — v16 (`auth_sessions`), v17 (`duration_mode`, `start_date`,
  `idx_pass_one_per_unit_per_day`).
- `src/auth/middleware.js` — async `issueSession`, `revokeSession`, session +
  live-role checks in `requireAuth`.
- `src/routes/auth.js`, `src/routes/admin.js`, `src/routes/sso.js` — await
  `issueSession`; revoke-all / admin-revoke; revoke on deactivate.
- `src/server.js`, `src/config.js` — CSP, `trustProxy`, duration-mode config.
- `src/services/passService.js` — new `computeExpiry`, overnight guard,
  one-active-pass check, `day_duplicate` mapping, `duration_mode` persisted.
- `src/routes/passes.js` / `desk.js` / `requests.js` — error-code maps.
- `src/routes/resident.js` — duration preset validation.
- `public/index.html` · `desk.html` · `resident.html` · `app.js` · `desk.js` ·
  `resident.js` — duration UI + `esc()` escaping.
- `.gitignore`, `.env.example`, `package.json` (version + serial tests), `README.md`.

---

## Suggested commit messages (one per task — already committed on the branch)

1. `security: harden secret hygiene and add pre-commit .env guard`
2. `security: add revocable login sessions (JWT jti + auth_sessions)`
3. `security: harden CSP + trust proxy, and escape all HTML interpolation`
4. `feat(duration): add v17 duration-mode model + one-pass-per-unit-per-day index`
5. `feat(duration): implement Short Stay / Overnight computeExpiry + guard`
6. `feat(issuance): enforce one active pass per unit; map new error codes`
7. `feat(duration): surface Short Stay / Overnight in the staff, desk & resident UIs`
8. `docs: v1.24.0 security notes, changelog, and implementation report` (this wrap-up)

---

## Deliberate deviations from the prompt (and why)

1. **`.env` removal (Task 1).** `.env` is not tracked and not present in this
   clone, so `git rm --cached .env` would error. Nothing was leaked *in the repo*.
   The hygiene controls were still added. **You must still rotate the secrets**
   if the `.env` was ever exposed elsewhere.
2. **Invalid v16/v17 SQL corrected (Tasks 2, 4).** The prompt's index predicate
   `WHERE ... expires_at > now()` and the `ALTER TYPE pass_status IS NOT NULL`
   line are both rejected by PostgreSQL. I used `WHERE revoked_at IS NULL` and a
   plain `duration_mode` column. Verified against live PG 16.
3. **`start_date` generated column** uses a literal `'America/Toronto'` (required
   for immutability); it therefore always reflects the property TZ, not a
   configurable one. Verified correct across the EDT midnight boundary.
4. **One-active-pass-per-unit changed existing behavior** (see risk below).
   Seven integration tests that filled the 5-space / 5-tag capacity from a single
   unit were updated to use distinct units (six `SP-*` units seeded) — they still
   validate the building-wide caps.
5. **Quota kept configurable (Task 6a).** The 10/year cap is already enforced via
   `config.annualPassQuota` (default 10). I did **not** hard-code
   `RESIDENTIAL_ANNUAL_CAP = 10`, to avoid silently ignoring the documented
   `ANNUAL_PASS_QUOTA` env var. The optional per-`duration_mode` count in
   `evaluateQuota` was **not** added (analytics-only, out of the critical path).
6. **Resident portal (Task 7c)** uses a single `durationPreset` field (Short
   Stay / Overnight, legacy still accepted) rather than a parallel `durationMode`
   hidden field. The prompt's parallel field would not have flowed into the
   issued pass's expiry on approval; one coherent field does.
7. **Test runner serialized** (`--test-concurrency=1`) because all suites share
   one database and truncate shared tables — parallel files would race.

---

## ⚠ Open questions for you

1. **One active pass per unit — confirm this is the intended policy.** It removes
   the ability for a single unit to host multiple simultaneous visitors (e.g.
   two guest cars at once), which the spot/tag capacity model previously allowed.
   It is easy to revert (remove the check + the unique index) if that's too
   strict. **This is the one behavioral change worth your explicit sign-off.**
2. **Applying v17 to your live database.** The `idx_pass_one_per_unit_per_day`
   unique index is created *defensively* — if your production data already has
   two active passes for the same unit on the same day, the index is skipped with
   a NOTICE (the app-level check still enforces the rule going forward). To get
   the DB-level guarantee, resolve any existing same-day duplicates and re-run
   the migration.
3. **Secret rotation is on you.** I generated fresh `JWT_SECRET`,
   `BARCODE_SECRET`, and `OVERRIDE_SECRET` and provided them in chat. Rotating
   `BARCODE_SECRET` invalidates every issued pass barcode — confirm you want that
   before applying it (the prompt's `UPDATE visitor_passes SET barcode_sig=''`
   step was intentionally **not** run).
4. **Overnight guard is effectively inert.** Because Overnight always resolves to
   next-day 8 AM, it is always > 6 h from any issue time, so the
   `invalid_duration` guard never actually fires. It's kept as a forward-looking
   safety net; remove it if you'd rather not carry dead code.
5. **`.githooks` activation.** The pre-commit guard is committed but only active
   after `git config core.hooksPath .githooks` in each clone (done in this one).
   Consider documenting it in your onboarding, or move to CI enforcement.
