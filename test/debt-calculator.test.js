'use strict';
// ============================================================================
//  Unit tests for the debt payoff calculator's core math
//  (public/debt-calculator.core.js). Pure functions, no DB or server needed —
//  runs standalone under `node --test`.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DebtCalc = require(path.join(__dirname, '..', 'public', 'debt-calculator.core.js'));

// Closed-form number of months to pay off a single loan with fixed payment:
//   n = -ln(1 - r*B/P) / ln(1 + r)
function analyticMonths(balance, apr, payment) {
  const r = apr / 100 / 12;
  if (r === 0) return Math.ceil(balance / payment);
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

test('single debt matches the closed-form amortization term', () => {
  const balance = 6000;
  const apr = 19.99;
  const payment = 200;
  const plan = DebtCalc.computePlan({
    debts: [{ name: 'Visa', balance, apr, minPayment: payment }],
    strategy: 'none',
  });
  assert.equal(plan.paidOff, true);
  // Within one month of the analytic term (rounding of the final partial payment).
  assert.ok(Math.abs(plan.months - analyticMonths(balance, apr, payment)) <= 1,
    `months ${plan.months} vs analytic ${analyticMonths(balance, apr, payment)}`);
});

test('zero-interest debt is pure division', () => {
  const plan = DebtCalc.computePlan({
    debts: [{ name: 'IOU', balance: 1000, apr: 0, minPayment: 100 }],
    strategy: 'none',
  });
  assert.equal(plan.months, 10);
  assert.ok(Math.abs(plan.totalInterest) < 1e-6);
  assert.ok(Math.abs(plan.totalPaid - 1000) < 1e-6);
});

test('avalanche pays less total interest than snowball when APR and size disagree', () => {
  // The two strategies must disagree on the target: the large balance carries
  // the high rate (avalanche attacks it), while the small balance is cheap
  // (snowball attacks it instead). Avalanche should pay less total interest.
  const debts = [
    { name: 'Small cheap loan', balance: 2000, apr: 5, minPayment: 50 },
    { name: 'Big pricey card', balance: 10000, apr: 25, minPayment: 300 },
  ];
  const avalanche = DebtCalc.computePlan({ debts, extra: 300, strategy: 'avalanche' });
  const snowball = DebtCalc.computePlan({ debts, extra: 300, strategy: 'snowball' });
  assert.equal(avalanche.paidOff, true);
  assert.equal(snowball.paidOff, true);
  assert.ok(avalanche.totalInterest < snowball.totalInterest,
    `avalanche ${avalanche.totalInterest} should be < snowball ${snowball.totalInterest}`);
});

test('extra payments reduce both time and interest versus minimums only', () => {
  const debts = [
    { name: 'Card A', balance: 5000, apr: 22, minPayment: 120 },
    { name: 'Card B', balance: 3000, apr: 18, minPayment: 80 },
  ];
  const cmp = DebtCalc.compareToMinimum({ debts, extra: 400, strategy: 'avalanche' });
  assert.equal(cmp.plan.paidOff, true);
  assert.equal(cmp.baseline.paidOff, true);
  assert.ok(cmp.interestSaved > 0, 'should save interest');
  assert.ok(cmp.monthsSaved > 0, 'should save months');
  assert.ok(cmp.plan.months < cmp.baseline.months);
});

test('rollover redirects a cleared debt\'s minimum to the next target', () => {
  // Two debts, same rate. Snowball clears the small one first, then its freed
  // minimum accelerates the large one — so total months beat independent minimums.
  const debts = [
    { name: 'Small', balance: 1000, apr: 15, minPayment: 50 },
    { name: 'Large', balance: 8000, apr: 15, minPayment: 200 },
  ];
  const roll = DebtCalc.computePlan({ debts, extra: 0, strategy: 'snowball' });
  const indep = DebtCalc.computePlan({ debts, extra: 0, strategy: 'none' });
  assert.equal(roll.paidOff, true);
  assert.ok(roll.months < indep.months,
    `rollover ${roll.months} should beat independent ${indep.months}`);
});

test('a minimum below the monthly interest never amortizes (flagged as stuck)', () => {
  // 24% APR on 10,000 = $200/mo interest; a $150 minimum can never catch up.
  const plan = DebtCalc.computePlan({
    debts: [{ name: 'Underwater', balance: 10000, apr: 24, minPayment: 150 }],
    strategy: 'none',
    maxMonths: 60,
  });
  assert.equal(plan.paidOff, false);
  assert.deepEqual(plan.stuckDebts, ['Underwater']);
});

test('payoff order is sorted by when each debt clears', () => {
  const debts = [
    { name: 'A', balance: 4000, apr: 10, minPayment: 100 },
    { name: 'B', balance: 1500, apr: 30, minPayment: 50 },
  ];
  const plan = DebtCalc.computePlan({ debts, extra: 200, strategy: 'avalanche' });
  const b = plan.debts.find((d) => d.name === 'B');
  const a = plan.debts.find((d) => d.name === 'A');
  // Avalanche targets B (30% APR) first, so it clears no later than A.
  assert.ok(b.payoffMonth <= a.payoffMonth);
});

test('addMonths advances the calendar correctly across a year boundary', () => {
  const d = DebtCalc.addMonths(new Date('2026-08-08T00:00:00'), 6);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 1); // February (0-indexed)
});
