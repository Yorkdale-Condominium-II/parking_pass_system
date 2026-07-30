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
CREATE OR REPLACE VIEW unit_year_usage AS
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
