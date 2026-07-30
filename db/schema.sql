-- ============================================================================
--  Condominium Parking Pass System — Relational Schema (PostgreSQL)
-- ============================================================================
--  Entities:
--    users              -> application accounts (Security / Management / Board)
--    units              -> physical condo units
--    residents          -> people who live in a unit
--    registered_vehicles-> resident-owned vehicles (permanent plates)
--    visitor_passes     -> time-limited visitor parking passes (quota-controlled)
--    pass_audit_log     -> immutable audit trail of pass lifecycle events
--    override_grants    -> Management authorizations to exceed the annual quota
-- ============================================================================

BEGIN;

-- Enable UUID generation.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
--  Enums
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('security', 'management', 'board');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pass_status') THEN
    CREATE TYPE pass_status AS ENUM ('active', 'expired', 'revoked');
  END IF;
END$$;

-- ---------------------------------------------------------------------------
--  Users  (RBAC principals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username       TEXT        NOT NULL UNIQUE,
    full_name      TEXT        NOT NULL,
    role           user_role   NOT NULL,
    password_hash  TEXT        NOT NULL,
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  Units
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_number  TEXT        NOT NULL UNIQUE,       -- e.g. "1204", "PH-3"
    floor        INTEGER,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  Residents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS residents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id     UUID        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    full_name   TEXT        NOT NULL,
    email       TEXT,
    phone       TEXT,
    is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,  -- primary contact for the unit
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_residents_unit ON residents(unit_id);

-- ---------------------------------------------------------------------------
--  Registered vehicles  (resident-owned, permanent plates)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registered_vehicles (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id        UUID        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    resident_id    UUID        REFERENCES residents(id) ON DELETE SET NULL,
    licence_plate  TEXT        NOT NULL,             -- normalized (upper, no spaces)
    province       TEXT,
    make           TEXT,
    model          TEXT,
    color          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (licence_plate)
);
CREATE INDEX IF NOT EXISTS idx_regveh_plate ON registered_vehicles(licence_plate);
CREATE INDEX IF NOT EXISTS idx_regveh_unit  ON registered_vehicles(unit_id);

-- ---------------------------------------------------------------------------
--  Override grants  (Management-authorized quota exceptions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS override_grants (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id        UUID        NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    calendar_year  INTEGER     NOT NULL,
    extra_passes   INTEGER     NOT NULL CHECK (extra_passes > 0),
    reason         TEXT        NOT NULL,
    granted_by     UUID        NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_override_unit_year ON override_grants(unit_id, calendar_year);

-- ---------------------------------------------------------------------------
--  Visitor passes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visitor_passes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id         UUID        NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    visitor_plate   TEXT        NOT NULL,            -- visitor vehicle plate
    visitor_name    TEXT,
    issued_by       UUID        NOT NULL REFERENCES users(id),
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    calendar_year   INTEGER     NOT NULL,            -- year the pass counts against
    status          pass_status NOT NULL DEFAULT 'active',
    was_override    BOOLEAN     NOT NULL DEFAULT FALSE,
    -- HMAC signature embedded in the printed barcode (hex). Used for O(1)
    -- integrity checks and to detect tampering / forgery.
    barcode_sig     TEXT        NOT NULL,
    revoked_at      TIMESTAMPTZ,
    revoked_by      UUID        REFERENCES users(id),
    CONSTRAINT chk_expiry_after_issue CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS idx_pass_unit_year ON visitor_passes(unit_id, calendar_year);
CREATE INDEX IF NOT EXISTS idx_pass_plate     ON visitor_passes(visitor_plate);
CREATE INDEX IF NOT EXISTS idx_pass_status    ON visitor_passes(status);

-- ---------------------------------------------------------------------------
--  Pass audit log  (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pass_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    pass_id     UUID        REFERENCES visitor_passes(id) ON DELETE SET NULL,
    action      TEXT        NOT NULL,   -- issued | verified | revoked | override_used | denied
    actor_id    UUID        REFERENCES users(id),
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_pass  ON pass_audit_log(pass_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON pass_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_time  ON pass_audit_log(created_at);

-- ---------------------------------------------------------------------------
--  View: passes issued per unit per calendar year (excludes revoked)
-- ---------------------------------------------------------------------------
-- Dropped first because a later migration changes this view's column set, and
-- CREATE OR REPLACE cannot add/drop/reorder view columns.
DROP VIEW IF EXISTS unit_year_usage;
CREATE VIEW unit_year_usage AS
SELECT
    u.id            AS unit_id,
    u.unit_number   AS unit_number,
    vp.calendar_year,
    COUNT(*) FILTER (WHERE vp.status <> 'revoked') AS passes_used
FROM units u
JOIN visitor_passes vp ON vp.unit_id = u.id
GROUP BY u.id, u.unit_number, vp.calendar_year;

COMMIT;

-- ============================================================================
--  v2 migration — additive, idempotent. Safe to re-run on existing databases.
--    * unit kind (residential / commercial) + business tracing
--    * split visitor name, visitor plate province/state, printed short code
--    * sign-in (authentication) audit log
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'unit_kind') THEN
    CREATE TYPE unit_kind AS ENUM ('residential', 'commercial');
  END IF;
END$$;

ALTER TABLE units ADD COLUMN IF NOT EXISTS kind unit_kind NOT NULL DEFAULT 'residential';
ALTER TABLE units ADD COLUMN IF NOT EXISTS business_name    TEXT;   -- commercial only
ALTER TABLE units ADD COLUMN IF NOT EXISTS business_contact TEXT;   -- commercial only
CREATE INDEX IF NOT EXISTS idx_units_kind ON units(kind);

ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS visitor_first_name TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS visitor_last_name  TEXT;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS visitor_region     TEXT; -- province/state code
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS short_code         TEXT; -- human-typable code on printout
CREATE UNIQUE INDEX IF NOT EXISTS idx_pass_shortcode ON visitor_passes(short_code);

-- Authentication (sign-in) audit trail — separate from pass_audit_log.
CREATE TABLE IF NOT EXISTS auth_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    username    TEXT        NOT NULL,          -- recorded even for unknown users
    event       TEXT        NOT NULL,          -- login_success | login_failed | logout
    success     BOOLEAN     NOT NULL DEFAULT FALSE,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_authaudit_user ON auth_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_authaudit_time ON auth_audit_log(created_at);

-- Rebuild the usage view to expose unit kind (used for quota + reporting).
-- Dropped first because CREATE OR REPLACE cannot change column ordering.
DROP VIEW IF EXISTS unit_year_usage;
CREATE VIEW unit_year_usage AS
SELECT
    u.id            AS unit_id,
    u.unit_number   AS unit_number,
    u.kind          AS kind,
    vp.calendar_year,
    COUNT(*) FILTER (WHERE vp.status <> 'revoked') AS passes_used
FROM units u
JOIN visitor_passes vp ON vp.unit_id = u.id
GROUP BY u.id, u.unit_number, u.kind, vp.calendar_year;

COMMIT;

-- ============================================================================
--  v3 migration — resident-portal pass requests. Additive, idempotent.
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_status') THEN
    CREATE TYPE request_status AS ENUM ('pending', 'approved', 'denied');
  END IF;
END$$;

-- Visitor-pass requests submitted by residents via the public portal. A request
-- is a proposal only; a pass is created (and the quota consumed) when Security/
-- Management approves it.
CREATE TABLE IF NOT EXISTS pass_requests (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id            UUID           NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    requester_name     TEXT           NOT NULL,
    requester_contact  TEXT,                       -- phone or email
    visitor_first_name TEXT,
    visitor_last_name  TEXT,
    visitor_plate      TEXT           NOT NULL,
    visitor_region     TEXT,                        -- e.g. 'CA-ON'
    duration_preset    TEXT           NOT NULL DEFAULT 'today',
    note               TEXT,
    status             request_status NOT NULL DEFAULT 'pending',
    pass_id            UUID           REFERENCES visitor_passes(id) ON DELETE SET NULL,
    decided_by         UUID           REFERENCES users(id),
    decided_at         TIMESTAMPTZ,
    decision_note      TEXT,
    created_at         TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON pass_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_unit   ON pass_requests(unit_id);

COMMIT;

-- ============================================================================
--  v4 migration — resident email + short public reference code for requests.
-- ============================================================================
BEGIN;
ALTER TABLE pass_requests ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE pass_requests ADD COLUMN IF NOT EXISTS ref_code        TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_refcode ON pass_requests(ref_code);
COMMIT;

-- ============================================================================
--  v5 migration — scheduled passes + physical-spot occupancy tracking.
-- ============================================================================
BEGIN;

-- When the pass's spot occupancy begins (defaults to issuance = "now").
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS starts_at  TIMESTAMPTZ;
UPDATE visitor_passes SET starts_at = issued_at WHERE starts_at IS NULL;
ALTER TABLE visitor_passes ALTER COLUMN starts_at SET DEFAULT now();

-- Early check-out: when set, the vehicle has vacated and the spot is freed
-- before expiry.
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS vacated_at TIMESTAMPTZ;
ALTER TABLE visitor_passes ADD COLUMN IF NOT EXISTS vacated_by UUID REFERENCES users(id);

-- Speeds up occupancy/overlap queries over active passes.
CREATE INDEX IF NOT EXISTS idx_pass_window
  ON visitor_passes(starts_at, expires_at)
  WHERE status = 'active' AND vacated_at IS NULL;

-- Scheduled start time requested by a resident (NULL = as soon as possible).
ALTER TABLE pass_requests ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;

COMMIT;

-- ============================================================================
--  v6 migration — split user names into first/last.
-- ============================================================================
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT;
-- Backfill from the existing full_name (first token = first name, rest = last).
UPDATE users
   SET first_name = split_part(full_name, ' ', 1),
       last_name  = NULLIF(regexp_replace(full_name, '^\S+\s*', ''), '')
 WHERE first_name IS NULL;
COMMIT;

-- ============================================================================
--  v7 migration — key/value app settings (e.g. company / condo name).
-- ============================================================================
BEGIN;
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('org_name', 'Yorkdale Condominium II')
  ON CONFLICT (key) DO NOTHING;
COMMIT;

-- ============================================================================
--  v8 migration — email + SSO identity on users (for Google/Microsoft login).
-- ============================================================================
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider TEXT;  -- 'google' | 'microsoft'
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_subject  TEXT;  -- provider 'sub' claim
-- Email is matched case-insensitively during SSO, so enforce uniqueness on lower().
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (lower(email)) WHERE email IS NOT NULL;
COMMIT;

-- ============================================================================
--  v9 migration — force a password change after a manager-set temporary one.
-- ============================================================================
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;

-- ============================================================================
--  v10 migration — superuser flag. Superusers are the only accounts allowed to
--  change a user's role (their own on the Account screen, or others' in the
--  Manager console). Bootstrap: if no superuser exists yet, promote all current
--  Management accounts. The NOT EXISTS guard makes this a one-time bootstrap so
--  re-running migrations never fights a later manual grant/revoke — but it still
--  self-heals (re-promotes Management) if every superuser is ever removed, so
--  the building can't get permanently locked out of role management.
-- ============================================================================
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superuser BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET is_superuser = TRUE
 WHERE role = 'management'
   AND NOT EXISTS (SELECT 1 FROM users WHERE is_superuser = TRUE);
COMMIT;
