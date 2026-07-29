'use strict';
const config = require('./../config');

// ============================================================================
//  Annual visitor-pass quota evaluation
// ----------------------------------------------------------------------------
//  Business rule: a unit may be issued at most ANNUAL_PASS_QUOTA (default 10)
//  visitor passes per CALENDAR YEAR. Revoked passes do NOT count against the
//  quota. Management may grant per-unit, per-year overrides that raise the
//  effective ceiling.
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
  await client.query(`SELECT id FROM units WHERE id = $1 FOR UPDATE`, [unitId]);
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

  const base = config.annualPassQuota;
  const limit = base + extra;
  const remaining = Math.max(0, limit - used);
  return { used, base, extra, limit, remaining, atLimit: used >= limit };
}

module.exports = { evaluateQuota };
