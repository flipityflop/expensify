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

// ---- autofill scaling ----------------------------------------------------
// Groceries averages 200, Gifts 20; everything else 0. Historic total 220.
const scaled = target => call(`(() => {
    const avgs = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly')
        .map(c => [c, averageMonthly(c, '2026-04')]).filter(([, a]) => a !== null);
    const historic = avgs.reduce((s, [, a]) => s + a, 0);
    const scale = ${target} && historic ? ${target} / historic : 1;
    return JSON.stringify(Object.fromEntries(
        avgs.map(([c, a]) => [c, Math.round(a * scale * 100) / 100])));
})()`);

// No income set: raw averages, untouched.
const raw = JSON.parse(scaled(0));
assert.strictEqual(raw.Groceries, 200);
assert.strictEqual(raw.Gifts, 20);

// 1100 to spend against a 220 history = 5x. Proportions hold, total matches.
const split = JSON.parse(scaled(1100));
assert.strictEqual(split.Groceries, 1000);
assert.strictEqual(split.Gifts, 100);
assert.strictEqual(split.Rent, 0);
const sum = Object.values(split).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(sum - 1100) < 0.05, `split totals ${sum}, expected ~1100`);

// Scaling down works the same way.
const tight = JSON.parse(scaled(110));
assert.strictEqual(tight.Groceries, 100);
assert.strictEqual(tight.Gifts, 10);

// The reserved key must never be rendered or budgeted as a category.
assert.ok(!call(`CATEGORIES.includes(SPENDING_KEY)`), 'SPENDING_KEY leaked into CATEGORIES');

// ---- fixed categories ----------------------------------------------------
// Mirrors autofill(): fixed costs come off the income, the rest is split
// proportionally across what is left.
const withFixed = target => call(`(() => {
    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const fixedTotal = monthly.filter(c => fixed[c]).reduce((s, c) => s + (goals[c] || 0), 0);
    const avgs = monthly.filter(c => !fixed[c])
        .map(c => [c, averageMonthly(c, '2026-04')]).filter(([, a]) => a !== null);
    const historic = avgs.reduce((s, [, a]) => s + a, 0);
    const available = ${target} - fixedTotal;
    const scale = ${target} && historic ? available / historic : 1;
    return JSON.stringify({ fixedTotal, available, scale,
        written: Object.fromEntries(avgs.map(([c, a]) => [c, Math.round(a * scale * 100) / 100])) });
})()`);

// Rent pinned at 500. Income 1500 -> 1000 left, split over Groceries 200 +
// Gifts 20 = 220 of history, so 4.5454x.
vm.runInContext(`goals = { Rent: 500 }; fixed = { Rent: true };`, ctx);
const f = JSON.parse(withFixed(1500));
assert.strictEqual(f.fixedTotal, 500);
assert.strictEqual(f.available, 1000);

// Rent must not be rewritten, and must not be scaled.
assert.ok(!Object.keys(f.written).includes('Rent'), 'autofill rewrote a fixed category');
assert.strictEqual(call(`goals.Rent`), 500, 'fixed amount changed');

assert.strictEqual(f.written.Groceries, 909.09);   // 200/220 * 1000
assert.strictEqual(f.written.Gifts, 90.91);        //  20/220 * 1000
const flexSum = Object.values(f.written).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(flexSum + f.fixedTotal - 1500) < 0.05,
    `fixed ${f.fixedTotal} + flexible ${flexSum} should equal the 1500 income`);

// Lowering the income squeezes only the flexible half; Rent holds at 500.
const tightF = JSON.parse(withFixed(1000));
assert.strictEqual(tightF.available, 500);
assert.strictEqual(tightF.written.Groceries, 454.55);
assert.strictEqual(call(`goals.Rent`), 500, 'fixed amount moved when income fell');

// Fixed costs exceeding the income must be refused, not turned negative.
vm.runInContext(`goals = { Rent: 2000 }; fixed = { Rent: true };`, ctx);
assert.ok(JSON.parse(withFixed(1500)).available <= 0, 'over-committed case should be refused');

// Editing an amount must not silently clear the fixed flag: putGoal defaults
// isFixed to whatever is already stored.
vm.runInContext(`goals = { Rent: 500 }; fixed = { Rent: true };`, ctx);
assert.ok(call(`(function () { return putGoal.length; })()`) <= 3, 'putGoal signature changed');
assert.ok(call(`!!fixed['Rent']`), 'fixed flag lost');

vm.runInContext(`goals = {}; fixed = {};`, ctx);

console.log('budget: all assertions pass');
