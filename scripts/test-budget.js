// Checks the two budget-page sums that are easy to get quietly wrong:
// the autofill average, and the progress bar's mixed monthly/yearly total.
//
//   node scripts/test-budget.js
//
// Runs the real shipped budget.js in a vm with a stub DOM. No database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

const stubEl = () => new Proxy({}, {
    get: (_, prop) => {
        if (prop === 'style') return {};
        if (prop === 'classList') return { add() {}, remove() {}, toggle() {} };
        if (prop === 'dataset') return {};
        if (['value', 'innerHTML', 'textContent'].includes(prop)) return '';
        return () => stubEl();
    },
    set: () => true
});

const ctx = vm.createContext({
    document: { getElementById: stubEl, addEventListener() {}, querySelectorAll: () => [] },
    window: { location: {} },
    localStorage: { getItem: () => 'x' },
    console
});

vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'categories.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'budget.js'), 'utf8'), ctx);

const ex = (date, category, amount, is_positive = 0) =>
    ({ expense_date: date, category, amount: is_positive ? amount : -amount, is_positive });

// Three months of data: Jan, Feb, Mar. April is the month being budgeted.
vm.runInContext(`expenses = ${JSON.stringify([
    ex('2026-01-10', 'Groceries', 100),
    ex('2026-02-10', 'Groceries', 200),
    ex('2026-03-10', 'Groceries', 300),
    ex('2026-02-05', 'Gifts', 60),          // one month out of three
    ex('2026-03-01', 'Travel', 900),        // yearly category
    ex('2026-04-02', 'Groceries', 50),      // the budgeted month itself
    ex('2026-04-03', 'Travel', 120),
    ex('2026-03-15', 'work', 5000, 1)       // income must never count as spend
])};`, ctx);

const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);

// ---- averageMonthly ------------------------------------------------------
// 600 over Jan/Feb/Mar = 200. April's own 50 must be excluded.
assert.strictEqual(call(`averageMonthly('Groceries', '2026-04')`), 200);

// 60 spent in one month, but three months elapsed -> 20, not 60. A month with
// no Gifts spending is still a month the goal had to cover.
assert.strictEqual(call(`averageMonthly('Gifts', '2026-04')`), 20);

// A category with no history averages to 0, not null - null means "no history
// at all to average against".
assert.strictEqual(call(`averageMonthly('Rent', '2026-04')`), 0);
assert.strictEqual(call(`averageMonthly('Groceries', '2026-01')`), null);

// Only Jan and Feb precede March: 300 over 2 = 150.
assert.strictEqual(call(`averageMonthly('Groceries', '2026-03')`), 150);

// ---- actual: monthly vs yearly ------------------------------------------
assert.strictEqual(call(`actual('Groceries', '2026-04')`), 50);      // that month
assert.strictEqual(call(`actual('Travel', '2026-04')`), 1020);       // whole year
assert.strictEqual(call(`spentIn('Travel', '2026-04')`), 120);       // that month

// ---- progress bar totals -------------------------------------------------
// Monthly goal 400 + yearly goal 1200 counted at a twelfth = 500 budget.
vm.runInContext(`goals = { Groceries: 400, Travel: 1200 };`, ctx);
const budget = call(`CATEGORIES.reduce((s, c) => goals[c] === undefined ? s
    : s + (goalPeriod(c) === 'yearly' ? goals[c] / 12 : goals[c]), 0)`);
assert.strictEqual(budget, 500);

// April spend across every category, income excluded: 50 + 120 = 170.
const spend = call(`expenses.filter(e => !e.is_positive && e.expense_date.startsWith('2026-04'))
    .reduce((s, e) => s + Math.abs(e.amount), 0)`);
assert.strictEqual(spend, 170);
assert.strictEqual(Math.min(100, (spend / budget) * 100), 34);

console.log('budget: all assertions pass');
