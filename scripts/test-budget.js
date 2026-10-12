// Checks the budget-page sums that are easy to get quietly wrong: the
// autofill average and split, the progress bar's mixed monthly/yearly total,
// the plan's income less debt payment and savings, fixed expenses inside a
// category, and Tzedakah's year running from Rosh Hashanah.
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
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'hebrew-calendar.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'helpers.js'), 'utf8'), ctx);
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
// Runs the real planAutofill(), which is everything autofill() does short of
// the confirm and the saves.
const plan = (setup = '') => JSON.parse(call(`(() => {
    ${setup}
    const p = planAutofill('2026-04');
    return JSON.stringify({ ...p, goals: Object.fromEntries(p.goals) });
})()`));
const reset = () => vm.runInContext(`goals = {}; fixed = {}; fixedItems = [];`, ctx);
const scaled = income => { reset(); return plan(`goals[INCOME_KEY] = ${income};`).goals; };

// No income set: raw averages, untouched.
const raw = scaled(0);
assert.strictEqual(raw.Groceries, 200);
assert.strictEqual(raw.Gifts, 20);

// 1100 to spend against a 220 history = 5x. Proportions hold, total matches.
const split = scaled(1100);
assert.strictEqual(split.Groceries, 1000);
assert.strictEqual(split.Gifts, 100);
assert.strictEqual(split.Rent, 0);
const sum = Object.values(split).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(sum - 1100) < 0.05, `split totals ${sum}, expected ~1100`);

// Scaling down works the same way.
const tight = scaled(110);
assert.strictEqual(tight.Groceries, 100);
assert.strictEqual(tight.Gifts, 10);

// Yearly goals are never written - a twelve-month total is not an average.
assert.ok(!('Tzedakah' in split) && !('Travel' in split), 'autofill wrote a yearly goal');

// The reserved keys must never be rendered or budgeted as a category.
assert.ok(!call(`PLAN_KEYS.some(k => CATEGORIES.includes(k))`), 'a plan key leaked into CATEGORIES');

// The income is still read from the key it was saved under before it was
// called income, so the amount already stored carries over.
assert.strictEqual(call(`INCOME_KEY`), '__spending_budget__');

// ---- pinned categories ---------------------------------------------------
// Fixed costs come off the income, the rest is split proportionally across
// what is left.
const withFixed = income => { reset(); return plan(`goals = { Rent: 500, [INCOME_KEY]: ${income} }; fixed = { Rent: true };`); };

// Rent pinned at 500. Income 1500 -> 1000 left, split over Groceries 200 +
// Gifts 20 = 220 of history, so 4.5454x.
const f = withFixed(1500);
assert.strictEqual(f.reserved, 500);
assert.strictEqual(f.available, 1000);

// Rent must not be rewritten, and must not be scaled.
assert.ok(!Object.keys(f.goals).includes('Rent'), 'autofill rewrote a fixed category');
assert.strictEqual(call(`goals.Rent`), 500, 'fixed amount changed');

assert.strictEqual(f.goals.Groceries, 909.09);   // 200/220 * 1000
assert.strictEqual(f.goals.Gifts, 90.91);        //  20/220 * 1000
const flexSum = Object.values(f.goals).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(flexSum + f.reserved - 1500) < 0.05,
    `fixed ${f.reserved} + flexible ${flexSum} should equal the 1500 income`);

// Lowering the income squeezes only the flexible half; Rent holds at 500.
const tightF = withFixed(1000);
assert.strictEqual(tightF.available, 500);
assert.strictEqual(tightF.goals.Groceries, 454.55);
assert.strictEqual(call(`goals.Rent`), 500, 'fixed amount moved when income fell');

// Fixed costs exceeding the income must be refused, not turned negative.
reset();
assert.ok(plan(`goals = { Rent: 2000, [INCOME_KEY]: 1500 }; fixed = { Rent: true };`).available <= 0,
    'over-committed case should be refused');

// Editing an amount must not silently clear the fixed flag: putGoal defaults
// isFixed to whatever is already stored.
vm.runInContext(`goals = { Rent: 500 }; fixed = { Rent: true };`, ctx);
assert.ok(call(`(function () { return putGoal.length; })()`) <= 3, 'putGoal signature changed');
assert.ok(call(`!!fixed['Rent']`), 'fixed flag lost');

// ---- debt payment and savings --------------------------------------------
// Both come off the income before anything is split.
reset();
assert.strictEqual(call(`leftForSpending()`), null);                  // no income, no plan
vm.runInContext(`goals = { [INCOME_KEY]: 1500, [DEBT_PAYMENT_KEY]: 200, [SAVINGS_KEY]: 100 };`, ctx);
assert.strictEqual(call(`leftForSpending()`), 1200);

// With Rent pinned at 500 as well: 1500 - 200 - 100 - 500 = 700 to split.
const p = plan(`goals.Rent = 500; fixed = { Rent: true };`);
assert.strictEqual(p.toSpend, 1200);
assert.strictEqual(p.available, 700);
assert.strictEqual(p.goals.Groceries, 636.36);   // 200/220 * 700
assert.strictEqual(p.goals.Gifts, 63.64);        //  20/220 * 700
const planned = Object.values(p.goals).reduce((s, v) => s + v, 0) + p.reserved + 200 + 100;
assert.ok(Math.abs(planned - 1500) < 0.05, `goals + fixed + debt + savings = ${planned}, expected 1500`);

// Debt payment and savings that swallow the income leave nothing to split.
reset();
assert.ok(plan(`goals = { [INCOME_KEY]: 1000, [DEBT_PAYMENT_KEY]: 600, [SAVINGS_KEY]: 400 };`).available <= 0,
    'income fully spoken for should be refused');

// ---- fixed expenses inside a category ------------------------------------
const item = (category, amount, frequency = 'monthly') => ({ category, name: 'x', amount, frequency });

// A yearly bill in a monthly category counts at a twelfth; a monthly one in a
// yearly category at twelve times.
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Groceries', 50))})`), 50);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Groceries', 120, 'yearly'))})`), 10);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Tzedakah', 100))})`), 1200);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Tzedakah', 500, 'yearly'))})`), 500);

// Groceries: a 50/month CSA and a 120/year membership = 60/month fixed. Its
// 200 average leaves 140 flexible; with Gifts' 20 that is 160 of history.
const items = JSON.stringify([item('Groceries', 50), item('Groceries', 120, 'yearly')]);
reset();
vm.runInContext(`fixedItems = ${items};`, ctx);
assert.strictEqual(call(`fixedItemsTotal('Groceries')`), 60);

// No income: each category gets its fixed part plus its flexible average,
// which is just the average again when the history covers the fixed part.
const noIncome = plan(`fixedItems = ${items};`);
assert.strictEqual(noIncome.goals.Groceries, 200);
assert.strictEqual(noIncome.goals.Gifts, 20);

// 1000 income: the 60 is held back, the other 940 split over 160 = 5.875x.
// Only the flexible 140 of Groceries scales; the 60 does not.
const items1000 = plan(`fixedItems = ${items}; goals[INCOME_KEY] = 1000;`);
assert.strictEqual(items1000.reserved, 60);
assert.strictEqual(items1000.available, 940);
assert.strictEqual(items1000.goals.Groceries, 882.5);   // 60 + 140 * 5.875
assert.strictEqual(items1000.goals.Gifts, 117.5);       //      20 * 5.875
const itemsSum = Object.values(items1000.goals).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(itemsSum - 1000) < 0.05, `split totals ${itemsSum}, expected 1000`);

// Fixed expenses above anything spent before: nothing flexible, the goal is
// exactly the fixed part, whatever the income.
reset();
const big = plan(`fixedItems = ${JSON.stringify([item('Groceries', 300)])}; goals[INCOME_KEY] = 1000;`);
assert.strictEqual(big.goals.Groceries, 300);
assert.strictEqual(big.goals.Gifts, 700);               // all of the 700 left

// A pinned category reserves its goal, not its fixed expenses.
reset();
const pinned = plan(`fixedItems = ${items}; goals = { Groceries: 400, [INCOME_KEY]: 1000 }; fixed = { Groceries: true };`);
assert.strictEqual(pinned.reserved, 400);
assert.ok(!('Groceries' in pinned.goals), 'autofill rewrote a pinned category');

// ---- money ---------------------------------------------------------------
assert.strictEqual(call(`money(1234.5)`), '$1234.50');
assert.strictEqual(call(`money(-50)`), '-$50.00');
assert.strictEqual(call(`money(-0.0000001)`), '$0.00');   // float dust is not negative

// ---- Tzedakah runs from Rosh Hashanah ------------------------------------
// 1 Tishrei 5786 = 2025-09-23, 5787 = 2026-09-12, 5788 = 2027-10-02.
reset();
vm.runInContext(`expenses = ${JSON.stringify([
    ex('2025-09-22', 'Tzedakah', 100),      // 29 Elul 5785
    ex('2025-09-23', 'Tzedakah', 200),      // 1 Tishrei 5786
    ex('2026-01-15', 'Tzedakah', 300),
    ex('2026-09-11', 'Tzedakah', 400),      // 29 Elul 5786
    ex('2026-09-12', 'Tzedakah', 500),      // 1 Tishrei 5787
    ex('2026-03-01', 'Travel', 900)
])};`, ctx);
const win = (category, month, today) => JSON.parse(call(`JSON.stringify(yearWindow('${category}', '${month}', '${today}'))`));

// A past month reads its year off its last day.
assert.strictEqual(call(`referenceDate('2026-02', '2026-10-12')`), '2026-02-28');
assert.strictEqual(call(`referenceDate('2026-10', '2026-10-12')`), '2026-10-12');   // the current month: today

assert.deepStrictEqual(win('Tzedakah', '2026-03', '2026-10-12'), { start: '2025-09-23', end: '2026-09-12', label: '5786' });
assert.deepStrictEqual(win('Tzedakah', '2026-10', '2026-10-12'), { start: '2026-09-12', end: '2027-10-02', label: '5787' });

// The month Rosh Hashanah falls in: before it while that month is the current
// one, the new year once it has passed.
assert.strictEqual(win('Tzedakah', '2026-09', '2026-09-05').label, '5786');
assert.strictEqual(win('Tzedakah', '2026-09', '2026-09-12').label, '5787');
assert.strictEqual(win('Tzedakah', '2026-09', '2026-10-12').label, '5787');

// Into January it is still the same Jewish year.
assert.strictEqual(win('Tzedakah', '2027-01', '2026-10-12').label, '5787');

// Travel stays on the calendar year.
assert.deepStrictEqual(win('Travel', '2026-10', '2026-10-12'), { start: '2026-01-01', end: '2027-01-01', label: '2026' });

// 5786 holds 200 + 300 + 400: not the 100 the day before it began, not the
// 500 on the day the next one did. January to December would have been 1200.
assert.strictEqual(call(`actual('Tzedakah', '2026-03')`), 900);
assert.strictEqual(call(`spentIn('Tzedakah', '2026')`), 1200);
assert.strictEqual(call(`actual('Travel', '2026-03')`), 900);

reset();

console.log('budget: all assertions pass');
