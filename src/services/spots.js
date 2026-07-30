'use strict';
const config = require('./../config');

// ============================================================================
//  Physical parking-spot occupancy.
//  The building has config.spotCapacity (5) visitor spaces. A pass "occupies" a
//  spot during [starts_at, expires_at) while active and not yet vacated. We cap
//  the number of passes whose windows overlap at any instant to the capacity.
// ============================================================================

// Peak simultaneous occupancy across a set of [start, end) intervals (ms epoch).
function peakConcurrency(intervals) {
  const events = [];
  for (const [s, e] of intervals) {
    events.push([s, 1]);
    events.push([e, -1]);
  }
  // Ends before starts at the same timestamp (a vacated/expiring spot frees up
  // for a start at the same instant).
  events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  let cur = 0, peak = 0;
  for (const [, delta] of events) { cur += delta; if (cur > peak) peak = cur; }
  return peak;
}

/**
 * Evaluate whether a new pass occupying [startsAt, expiresAt] would exceed the
 * spot capacity at any point in its window. Must run inside a transaction; it
 * takes a building-wide advisory lock so concurrent issues can't both slip in.
 *
 * @returns {{ capacity, peak, wouldExceed, liveNow }}
 */
async function evaluateSpots(client, startsAt, expiresAt, excludePassId = null) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [915027]); // serialize spot checks

  const s = new Date(startsAt).getTime();
  const e = new Date(expiresAt).getTime();

  const rows = await client.query(
    `SELECT starts_at, expires_at
       FROM visitor_passes
      WHERE status = 'active' AND vacated_at IS NULL
        AND expires_at > $1 AND starts_at < $2
        AND ($3::uuid IS NULL OR id <> $3)`,
    [new Date(s), new Date(e), excludePassId]
  );

  const intervals = rows.rows.map((r) => [
    new Date(r.starts_at).getTime(),
    new Date(r.expires_at).getTime(),
  ]);
  intervals.push([s, e]); // include the candidate

  const peak = peakConcurrency(intervals);
  const now = Date.now();
  const liveNow = rows.rows.filter(
    (r) => new Date(r.starts_at).getTime() <= now && new Date(r.expires_at).getTime() > now
  ).length;

  return { capacity: config.spotCapacity, peak, wouldExceed: peak > config.spotCapacity, liveNow };
}

module.exports = { evaluateSpots, peakConcurrency };
