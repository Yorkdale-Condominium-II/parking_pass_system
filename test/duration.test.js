'use strict';
// ============================================================================
//  Unit tests for computeExpiry (the Short Stay / Overnight duration model).
//  Pure function — no server or database, so this file is safe to run in
//  parallel with the DB-backed suites.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');

// Pin the clock zone to the property TZ BEFORE requiring the app config, so the
// "11 PM" / "8 AM" local anchors resolve the same way they do in production.
process.env.TZ = 'America/Toronto';
process.env.PROPERTY_TZ = 'America/Toronto';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-integration-tests';
process.env.BARCODE_SECRET = process.env.BARCODE_SECRET || 'test-barcode-secret-different-value-xyz';

const { computeExpiry } = require('../src/services/passService');

const iso = (d) => new Date(d).toISOString();

const cases = [
  // Short Stay: 6h from the start when that lands before the 11 PM cutoff.
  { input: '2026-08-06T10:00:00-04:00', preset: 'short_stay', expect: '2026-08-06T16:00:00-04:00', why: '6 hours' },
  // Short Stay: exactly at the cutoff (start + 6h would be 01:00 next day).
  { input: '2026-08-06T19:00:00-04:00', preset: 'short_stay', expect: '2026-08-06T23:00:00-04:00', why: '11 PM cutoff' },
  // Short Stay: cutoff beats 6h (start + 6h = 02:30 next day, cutoff is 11 PM).
  { input: '2026-08-06T20:30:00-04:00', preset: 'short_stay', expect: '2026-08-06T23:00:00-04:00', why: 'cutoff beats 6h' },
  // Overnight: expires at 8 AM the following local day.
  { input: '2026-08-06T22:00:00-04:00', preset: 'overnight', expect: '2026-08-07T08:00:00-04:00', why: '8 AM next day' },
  // Overnight issued in the evening still lands on next-day 8 AM.
  { input: '2026-08-06T21:00:00-04:00', preset: 'overnight', expect: '2026-08-07T08:00:00-04:00', why: '8 AM next day' },
];

for (const c of cases) {
  test(`computeExpiry(${c.preset}) @ ${c.input} → ${c.expect} (${c.why})`, () => {
    const got = computeExpiry(new Date(c.input), c.preset);
    assert.equal(iso(got), iso(c.expect),
      `${c.preset} from ${c.input}: expected ${c.expect}, got ${iso(got)}`);
  });
}

test('short_stay never runs past the 11 PM local cutoff', () => {
  // A start late in the evening is clamped to 23:00 the same local day.
  const got = computeExpiry(new Date('2026-08-06T22:45:00-04:00'), 'short_stay');
  assert.equal(iso(got), iso('2026-08-06T23:00:00-04:00'));
});

test('legacy presets still resolve (today / tomorrow_noon)', () => {
  const today = computeExpiry(new Date('2026-08-06T10:00:00-04:00'), 'today');
  assert.equal(new Date(today).getHours(), 23); // end of local day
  const noon = computeExpiry(new Date('2026-08-06T10:00:00-04:00'), 'tomorrow_noon');
  assert.equal(new Date(noon).getHours(), 12);
  assert.equal(new Date(noon).getDate(), 7);
});

test('overnight always yields a stay longer than the short-stay window', () => {
  // Whatever the issue time, next-day 8 AM is > 6h away, so the issuePass guard
  // never rejects a genuine overnight request.
  for (const h of [0, 6, 12, 18, 23]) {
    const base = new Date(`2026-08-06T${String(h).padStart(2, '0')}:30:00-04:00`);
    const exp = computeExpiry(base, 'overnight');
    const hours = (exp.getTime() - base.getTime()) / 3600 / 1000;
    assert.ok(hours >= 6, `overnight @ ${h}:30 gave only ${hours}h`);
  }
});
