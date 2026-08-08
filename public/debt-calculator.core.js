'use strict';
// ============================================================================
//  Debt payoff calculator — core math (no DOM).
//
//  Pure functions shared by the browser UI (public/debt-calculator.js) and the
//  Node test suite (test/debt-calculator.test.js). Uses standard amortization:
//  interest accrues monthly on the remaining balance at APR / 12, minimum
//  payments are applied to every debt, and — for the snowball / avalanche
//  strategies — any spare budget (extra plus the minimums freed as debts clear)
//  rolls onto the current target debt.
//
//  Loaded as a UMD-ish module so the same file works in both environments.
// ============================================================================
(function (root, factory) {
  const api = factory();
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DebtCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const CENT = 0.005; // treat balances below half a cent as paid off

  // Order the still-active debts by the chosen payoff strategy.
  //   avalanche — highest APR first (mathematically cheapest)
  //   snowball  — smallest balance first (fastest first win)
  // Ties fall back to a stable original ordering so results are deterministic.
  function orderDebts(active, strategy) {
    const list = active.slice();
    if (strategy === 'snowball') {
      list.sort((a, b) => (a.balance - b.balance) || (a.id - b.id));
    } else if (strategy === 'avalanche') {
      list.sort((a, b) => (b.rate - a.rate) || (a.id - b.id));
    }
    return list;
  }

  // Run the month-by-month simulation.
  //
  //   debts    : [{ name, balance, apr, minPayment }]  (apr is an annual %)
  //   extra    : additional dollars applied every month beyond the minimums
  //   strategy : 'avalanche' | 'snowball' | 'none'
  //
  // 'none' is the plain minimum-only baseline: each debt amortizes on its own
  // minimum with no rollover and no extra, i.e. the standard schedule a lender
  // would quote if you never paid a penny more.
  function computePlan(opts) {
    const strategy = opts.strategy || 'avalanche';
    const rollover = strategy !== 'none';
    const extra = rollover ? Math.max(0, Number(opts.extra) || 0) : 0;
    const maxMonths = opts.maxMonths || 1200; // 100 years — a practical stop

    const debts = opts.debts.map((d, i) => ({
      id: i,
      name: d.name || `Debt ${i + 1}`,
      startBalance: Number(d.balance) || 0,
      balance: Number(d.balance) || 0,
      apr: Number(d.apr) || 0,
      rate: (Number(d.apr) || 0) / 100 / 12,
      minPayment: Math.max(0, Number(d.minPayment) || 0),
      interestPaid: 0,
      principalPaid: 0,
      payoffMonth: null,
    }));

    // Constant monthly budget: every minimum plus any extra. As debts clear,
    // their freed minimum stays in the budget and (with rollover) is redirected.
    const budget = debts.reduce((s, d) => s + d.minPayment, 0) + extra;

    const schedule = [];
    let month = 0;
    let totalInterest = 0;

    const anyOwing = () => debts.some((d) => d.balance > CENT);

    while (anyOwing() && month < maxMonths) {
      month += 1;

      // 1. Accrue this month's interest on every outstanding balance.
      for (const d of debts) {
        if (d.balance <= CENT) continue;
        const interest = d.balance * d.rate;
        d.balance += interest;
        d.interestPaid += interest;
        totalInterest += interest;
      }

      // 2. Pay each debt its minimum (capped at what it still owes / the budget).
      let available = budget;
      for (const d of debts) {
        if (d.balance <= CENT) continue;
        const pay = Math.min(d.minPayment, d.balance, available);
        d.balance -= pay;
        d.principalPaid += pay;
        available -= pay;
      }

      // 3. Rollover: pour whatever is left onto the target debt(s) in priority
      //    order. Skipped for the 'none' baseline.
      if (rollover) {
        for (const d of orderDebts(debts.filter((x) => x.balance > CENT), strategy)) {
          if (available <= CENT) break;
          const pay = Math.min(d.balance, available);
          d.balance -= pay;
          d.principalPaid += pay;
          available -= pay;
        }
      }

      // 4. Record payoff months and snap tiny residuals to zero.
      for (const d of debts) {
        if (d.payoffMonth === null && d.balance <= CENT) {
          d.balance = 0;
          d.payoffMonth = month;
        }
      }

      schedule.push({
        month,
        balance: debts.reduce((s, d) => s + Math.max(0, d.balance), 0),
      });
    }

    const paidOff = !anyOwing();

    return {
      strategy,
      paidOff,               // false => payments never retire the debt (see note)
      months: month,
      monthlyBudget: budget,
      totalInterest,
      totalPaid: debts.reduce((s, d) => s + d.startBalance, 0) + totalInterest,
      totalPrincipal: debts.reduce((s, d) => s + d.startBalance, 0),
      schedule,
      debts: debts.map((d) => ({
        name: d.name,
        startBalance: d.startBalance,
        apr: d.apr,
        minPayment: d.minPayment,
        interestPaid: d.interestPaid,
        payoffMonth: d.payoffMonth,
      })),
      // Debts whose minimum never covers their interest never amortize on their
      // own — useful to warn about in the minimum-only baseline.
      stuckDebts: debts
        .filter((d) => d.payoffMonth === null)
        .map((d) => d.name),
    };
  }

  // Convenience: the interest / time saved by a strategy versus paying only the
  // minimums. Returns null if the minimum-only baseline never pays off.
  function compareToMinimum(opts) {
    const plan = computePlan(opts);
    const baseline = computePlan(Object.assign({}, opts, { strategy: 'none', extra: 0 }));
    return {
      plan,
      baseline,
      interestSaved: baseline.paidOff ? baseline.totalInterest - plan.totalInterest : null,
      monthsSaved: baseline.paidOff ? baseline.months - plan.months : null,
    };
  }

  // Add `months` calendar months to a date, returning a new Date.
  function addMonths(date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  }

  return { computePlan, compareToMinimum, orderDebts, addMonths };
});
