'use strict';
// Debt payoff calculator — browser UI. The math lives in
// public/debt-calculator.core.js (window.DebtCalc); this file only wires up the
// form, renders results, and never talks to any backend — every figure is
// computed locally so no financial details leave the page.
const $ = (s) => document.querySelector(s);
const DebtCalc = window.DebtCalc;

const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const money0 = (n) => '$' + Math.round(n).toLocaleString();

// Human-friendly "3 years, 2 months" from a whole number of months.
function fmtDuration(months) {
  if (months <= 0) return '0 months';
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [];
  if (y) parts.push(y + (y === 1 ? ' year' : ' years'));
  if (m) parts.push(m + (m === 1 ? ' month' : ' months'));
  return parts.join(', ');
}

const STRATEGY_HINTS = {
  avalanche: 'Extra money targets the highest-interest debt first. This clears your debt for the least total interest.',
  snowball: 'Extra money targets the smallest balance first. You pay a little more interest, but knock out whole debts sooner for motivation.',
  none: 'Every debt is paid only its minimum, with no extra. This is the slowest and most expensive path — shown here as a baseline to compare against.',
};

// --- Debt rows ---------------------------------------------------------------
let rowSeq = 0;
function addDebtRow(preset) {
  preset = preset || {};
  const id = 'debt' + (rowSeq += 1);
  const wrap = document.createElement('div');
  wrap.className = 'debt-row';
  wrap.dataset.id = id;
  wrap.innerHTML = `
    <div class="cols debt-grid">
      <label>Debt name <input class="d-name" placeholder="e.g. Visa" value="${preset.name || ''}"></label>
      <label>Balance owed <input class="d-balance" type="number" min="0" step="1" inputmode="decimal" value="${preset.balance != null ? preset.balance : ''}"></label>
      <label>Interest rate (APR %) <input class="d-apr" type="number" min="0" step="0.01" inputmode="decimal" value="${preset.apr != null ? preset.apr : ''}"></label>
      <label>Minimum monthly payment <input class="d-min" type="number" min="0" step="1" inputmode="decimal" value="${preset.minPayment != null ? preset.minPayment : ''}"></label>
    </div>
    <button type="button" class="removeDebt danger" aria-label="Remove this debt">Remove</button>`;
  wrap.querySelector('.removeDebt').onclick = () => {
    wrap.remove();
    if (!$('#debtRows').children.length) addDebtRow();
  };
  $('#debtRows').appendChild(wrap);
}

function readDebts() {
  return Array.from(document.querySelectorAll('.debt-row')).map((row) => ({
    name: row.querySelector('.d-name').value.trim(),
    balance: parseFloat(row.querySelector('.d-balance').value),
    apr: parseFloat(row.querySelector('.d-apr').value),
    minPayment: parseFloat(row.querySelector('.d-min').value),
  }));
}

// --- Validation --------------------------------------------------------------
function validate(debts, extra) {
  const clean = [];
  for (const d of debts) {
    // Skip fully blank rows so a stray empty row doesn't block the calculation.
    if (!d.balance && !d.apr && !d.minPayment && !d.name) continue;
    if (!(d.balance > 0)) return { error: `Enter a balance greater than 0 for "${d.name || 'each debt'}".` };
    if (!(d.apr >= 0)) return { error: `Enter a valid interest rate for "${d.name || 'each debt'}".` };
    if (!(d.minPayment >= 0)) return { error: `Enter a valid minimum payment for "${d.name || 'each debt'}".` };
    clean.push(d);
  }
  if (!clean.length) return { error: 'Add at least one debt with a balance to calculate.' };

  // The combined budget must at least chip away at the total starting interest,
  // otherwise the balances only ever grow.
  const budget = clean.reduce((s, d) => s + d.minPayment, 0) + Math.max(0, extra || 0);
  const firstInterest = clean.reduce((s, d) => s + d.balance * (d.apr / 100 / 12), 0);
  if (budget <= firstInterest + 0.005) {
    return { error: 'Your total monthly payment doesn’t cover the monthly interest, so the balance never goes down. Increase a minimum payment or add an extra payment.' };
  }
  return { debts: clean };
}

// --- Rendering ---------------------------------------------------------------
function render(debts, extra, strategy) {
  const { plan, baseline, interestSaved, monthsSaved } =
    DebtCalc.compareToMinimum({ debts, extra, strategy });

  const start = new Date();
  const payoffDate = DebtCalc.addMonths(start, plan.months);
  const dateStr = payoffDate.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  const stats = `
    <div class="stats">
      <div class="stat"><div class="n">${fmtDuration(plan.months)}</div><div class="l">Time to debt-free</div></div>
      <div class="stat"><div class="n">${dateStr}</div><div class="l">Payoff date</div></div>
      <div class="stat"><div class="n">${money0(plan.totalInterest)}</div><div class="l">Total interest</div></div>
      <div class="stat"><div class="n">${money0(plan.totalPaid)}</div><div class="l">Total paid</div></div>
      <div class="stat"><div class="n">${money0(plan.monthlyBudget)}</div><div class="l">Monthly budget</div></div>
    </div>`;

  // Savings callout — only when the chosen plan beats the minimum-only baseline.
  let savings = '';
  if (strategy !== 'none' && interestSaved != null && interestSaved > 1) {
    savings = `<div class="banner" style="background:#dcfce7;border-color:#15803d;color:#14532d">
      <b>You save ${money0(interestSaved)} in interest</b> and finish
      <b>${fmtDuration(monthsSaved)} sooner</b> than paying only the minimums.</div>`;
  } else if (strategy !== 'none' && baseline && !baseline.paidOff) {
    savings = `<div class="banner"><b>Paying only the minimums would never clear this debt</b> — some minimum payments don’t cover their interest. Your plan above does pay it off.</div>`;
  }

  // Per-debt payoff order.
  const ordered = plan.debts.slice().sort((a, b) => (a.payoffMonth || 1e9) - (b.payoffMonth || 1e9));
  const debtRows = ordered.map((d, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(d.name)}</td>
      <td>${money0(d.startBalance)}</td>
      <td>${d.apr.toFixed(2)}%</td>
      <td>${d.payoffMonth ? fmtDuration(d.payoffMonth) : '—'}</td>
      <td>${money0(d.interestPaid)}</td>
    </tr>`).join('');

  // Yearly balance snapshot (every 12 months, plus the final month).
  const snap = [];
  for (let m = 12; m < plan.months; m += 12) snap.push(plan.schedule[m - 1]);
  if (plan.schedule.length) snap.push(plan.schedule[plan.schedule.length - 1]);
  const scheduleRows = snap.map((row) => `
    <tr>
      <td>${fmtDuration(row.month)}</td>
      <td>${DebtCalc.addMonths(start, row.month).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}</td>
      <td>${money(row.balance)}</td>
    </tr>`).join('');

  $('#result').innerHTML = `
    ${savings}
    ${stats}
    <div class="result-card">
      <h3>Payoff order</h3>
      <p class="hint">The order in which each debt is cleared under the <b>${strategyLabel(strategy)}</b> plan.</p>
      <table>
        <thead><tr><th>#</th><th>Debt</th><th>Balance</th><th>APR</th><th>Paid off in</th><th>Interest paid</th></tr></thead>
        <tbody>${debtRows}</tbody>
      </table>
    </div>
    <div class="result-card">
      <h3>Balance over time</h3>
      <table>
        <thead><tr><th>After</th><th>Date</th><th>Remaining balance</th></tr></thead>
        <tbody>${scheduleRows}</tbody>
      </table>
    </div>
    <p class="hint">Estimates only. Assumes fixed rates and payments and interest compounded monthly; your lender’s terms, fees, and compounding may differ.</p>`;

  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function strategyLabel(s) {
  return { avalanche: 'Avalanche', snowball: 'Snowball', none: 'Standard (minimums only)' }[s] || s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Wire up -----------------------------------------------------------------
$('#addDebt').onclick = () => addDebtRow();

function syncHint() { $('#strategyHint').textContent = STRATEGY_HINTS[$('#strategy').value] || ''; }
$('#strategy').onchange = syncHint;

$('#debtForm').onsubmit = (e) => {
  e.preventDefault();
  $('#calcError').textContent = '';
  const extra = parseFloat($('#extra').value) || 0;
  const { error, debts } = validate(readDebts(), extra);
  if (error) { $('#calcError').textContent = error; $('#result').innerHTML = ''; return; }
  render(debts, extra, $('#strategy').value);
};

// Seed a couple of example rows so the form is self-explanatory on first load.
addDebtRow({ name: 'Credit card', balance: 6000, apr: 19.99, minPayment: 150 });
addDebtRow({ name: 'Car loan', balance: 12000, apr: 6.5, minPayment: 280 });
syncHint();

fetch('/api/settings').then((r) => r.json()).then((s) => {
  const org = $('#brandOrg');
  if (org && s.orgName) org.textContent = s.orgName;
}).catch(() => {});
