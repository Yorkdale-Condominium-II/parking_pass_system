'use strict';
const config = require('./../config');

// ============================================================================
//  Annual visitor-pass quota evaluation
// ----------------------------------------------------------------------------
//  Business rule: a unit may be issued at most N visitor passes per CALENDAR
//  YEAR — N = ANNUAL_PASS_QUOTA (10) for residential units, COMMERCIAL_PASS_QUOTA
//  (20) for commercial units, or unlimited if that value is < 0. Revoked passes
//  do NOT count. A valid weekly override code adds per-unit, per-year headroom.
// ============================================================================

/**
 * Compute the quota picture for a unit in a given calendar year, using a
 * transaction-scoped client so the read is consistent with a subsequent insert.
 *
 * @param client pg client (inside a transaction, ideally SERIALIZABLE-safe)
 * @returns {{
 *   used:number, base:number, extra:number, limit:number,
 *   remaining:number, atLimit:boolean
 * }}
 */
async function evaluateQuota(client, unitId, year) {
  // Serialize concurrent issuance for this unit by taking a row lock on the
  // unit itself. (FOR UPDATE cannot be combined with an aggregate query, so we
  // lock the parent row instead of the counted pass rows — this still forces
  // two simultaneous issue requests for the same unit to run one-at-a-time.)
  const unitRes = await client.query(
    `SELECT kind FROM units WHERE id = $1 FOR UPDATE`, [unitId]
  );
  const kind = unitRes.rows[0]?.kind || 'residential';
  const usedRes = await client.query(
    `SELECT COUNT(*)::int AS used
       FROM visitor_passes
      WHERE unit_id = $1 AND calendar_year = $2 AND status <> 'revoked'`,
    [unitId, year]
  );
  const used = usedRes.rows[0].used;

  const extraRes = await client.query(
    `SELECT COALESCE(SUM(extra_passes), 0)::int AS extra
       FROM override_grants
      WHERE unit_id = $1 AND calendar_year = $2`,
    [unitId, year]
  );
  const extra = extraRes.rows[0].extra;

  const rawBase = kind === 'commercial' ? config.commercialPassQuota : config.annualPassQuota;
  const unlimited = rawBase < 0;
  if (unlimited) {
    return { kind, used, base: null, extra, limit: null, remaining: null, atLimit: false, unlimited: true };
  }
  const base = rawBase;
  const limit = base + extra;
  const remaining = Math.max(0, limit - used);
  return { kind, used, base, extra, limit, remaining, atLimit: used >= limit, unlimited: false };
}

module.exports = { evaluateQuota };
