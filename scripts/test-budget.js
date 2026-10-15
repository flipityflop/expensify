// Checks the budget-page sums that are easy to get quietly wrong: the monthly
// average, the worked-out budgets - fixed expenses plus the average above
// them - and how targets squeeze everything else into what is left for
// spending, the progress bar's mixed monthly/yearly total, and Tzedakah's
// year running from Rosh Hashanah.
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
// no Gifts spending is still a month the budget had to cover.
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

// ---- monthly budgets ------------------------------------------------------
// Runs the real monthlyBudgets() for April against the Jan-Mar history:
// Groceries averages 200, Gifts 20, every other monthly group 0.
const reset = () => vm.runInContext(`goals = {}; targets = {}; fixedItems = [];`, ctx);
const budgets = (setup = '', month = '2026-04') => {
    reset();
    return JSON.parse(call(`(() => { ${setup}; return JSON.stringify(monthlyBudgets('${month}')); })()`));
};
const item = (category, amount, frequency = 'monthly') => ({ category, name: 'x', amount, frequency });
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.015, `${what}: ${actual}, expected ${expected}`);

// Nothing fixed, no income, no targets: each budget is the group's average.
let b = budgets();
assert.deepStrictEqual(b.rows.Groceries, { fixed: 0, flexible: 200, budget: 200, spent: 50 });
assert.strictEqual(b.rows.Gifts.budget, 20);
assert.strictEqual(b.rows.Rent.budget, 0);
assert.strictEqual(b.scale, 1);
assert.deepStrictEqual(b.totals, { fixed: 0, flexible: 220, budget: 220, spent: 50 });
assert.ok(!('Travel' in b.rows) && !('Tzedakah' in b.rows), 'a yearly goal was worked out');

// No earlier month to average: the budget is just the fixed part.
b = budgets(`fixedItems = [${JSON.stringify(item('Groceries', 80))}]`, '2026-01');
assert.deepStrictEqual(b.rows.Groceries, { fixed: 80, flexible: 0, budget: 80, spent: 100 });

// ---- fixed expenses inside a group -----------------------------------------
// A yearly bill in a monthly group counts at a twelfth; a monthly one in a
// yearly group at twelve times.
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Groceries', 50))})`), 50);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Groceries', 120, 'yearly'))})`), 10);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Tzedakah', 100))})`), 1200);
assert.strictEqual(call(`fixedItemAmount(${JSON.stringify(item('Tzedakah', 500, 'yearly'))})`), 500);

// Groceries: a 50/month CSA and a 120/year membership = 60/month fixed. Its
// 200 average already paid them, so 140 is flexible and the budget stays 200.
const items = JSON.stringify([item('Groceries', 50), item('Groceries', 120, 'yearly')]);
b = budgets(`fixedItems = ${items}`);
assert.deepStrictEqual(b.rows.Groceries, { fixed: 60, flexible: 140, budget: 200, spent: 50 });

// Fixed bills above anything spent before: nothing is flexible, and the
// budget is exactly the bills.
b = budgets(`fixedItems = [${JSON.stringify(item('Groceries', 300))}]`);
assert.deepStrictEqual(b.rows.Groceries, { fixed: 300, flexible: 0, budget: 300, spent: 50 });

// ---- fitting into what is left for spending ----------------------------------
reset();
assert.strictEqual(call(`leftForSpending()`), null);                  // no income, no plan
vm.runInContext(`goals = { [INCOME_KEY]: 1500, [DEBT_PAYMENT_KEY]: 200, [SAVINGS_KEY]: 100 };`, ctx);
assert.strictEqual(call(`leftForSpending()`), 1200);

// Plenty of room: budgets stay at their averages, never grow past them.
b = budgets(`goals[INCOME_KEY] = 1100`);
assert.strictEqual(b.scale, 1);
assert.strictEqual(b.rows.Groceries.budget, 200);
assert.strictEqual(b.totals.budget, 220);

// Too little: the flexible parts shrink by one proportion; fixed bills do not.
// 160 - Groceries' 60 fixed = 100 for 140 + 20 = 160 of flexible: 0.625x.
b = budgets(`fixedItems = ${items}; goals[INCOME_KEY] = 160`);
assert.strictEqual(b.scale, 0.625);
assert.deepStrictEqual(b.rows.Groceries, { fixed: 60, flexible: 87.5, budget: 147.5, spent: 50 });
assert.strictEqual(b.rows.Gifts.budget, 12.5);
near(b.totals.budget, 160, 'squeezed total');

// Debt payment and savings come off before anything is fitted.
// 1500 - 1300 - 90 = 110 for 220 of flexible: 0.5x.
b = budgets(`goals = { [INCOME_KEY]: 1500, [DEBT_PAYMENT_KEY]: 1300, [SAVINGS_KEY]: 90 }`);
assert.strictEqual(b.scale, 0.5);
assert.strictEqual(b.rows.Groceries.budget, 100);
assert.strictEqual(b.rows.Gifts.budget, 10);

// ---- targets ----------------------------------------------------------------
const clothes = amount => `targets = { '2026-04': { 'Clothing & Accessories': ${amount} } }`;

// "$150 on clothes this month": Clothing takes its target and everything
// else fits around it. 300 - 150 = 150 for the others' 220 of flexible.
b = budgets(`goals[INCOME_KEY] = 300; ${clothes(150)}`);
assert.deepStrictEqual(b.rows['Clothing & Accessories'], { fixed: 0, flexible: 150, budget: 150, spent: 0, target: 150 });
assert.strictEqual(b.rows.Groceries.budget, 136.36);   // 200 * 150/220
assert.strictEqual(b.rows.Gifts.budget, 13.63);        //  20 * 150/220, rounded down
near(b.totals.budget, 300, 'total with a target');
assert.ok(b.totals.budget <= 300, `shrunk budgets add up past what is left: ${b.totals.budget}`);

// Fixed bills elsewhere come out before the squeeze, untouched.
// 300 - 150 (clothes) - 60 (Groceries' bills) = 90 for 160 of flexible.
b = budgets(`fixedItems = ${items}; goals[INCOME_KEY] = 300; ${clothes(150)}`);
assert.strictEqual(b.scale, 0.5625);
assert.deepStrictEqual(b.rows.Groceries, { fixed: 60, flexible: 78.75, budget: 138.75, spent: 50 });
assert.strictEqual(b.rows.Gifts.budget, 11.25);
near(b.totals.budget, 300, 'total with a target and fixed bills');

// A target is for its own month only: March's does not touch April.
b = budgets(`goals[INCOME_KEY] = 300; targets = { '2026-03': { 'Clothing & Accessories': 150 } }`);
assert.strictEqual(b.rows['Clothing & Accessories'].budget, 0);
assert.strictEqual(b.scale, 1);

// Targets beyond what is left: the others fall back to their fixed bills and
// the total runs over, for the plan to show by how much.
b = budgets(`fixedItems = ${items}; goals[INCOME_KEY] = 100; ${clothes(150)}`);
assert.strictEqual(b.scale, 0);
assert.strictEqual(b.rows.Groceries.budget, 60);
assert.strictEqual(b.rows.Gifts.budget, 0);
assert.strictEqual(b.totals.budget, 210);

// A target under a group's fixed bills is kept as typed; Flexible goes below
// zero, which the row shows in red.
b = budgets(`fixedItems = ${items}; targets = { '2026-04': { Groceries: 40 } }`);
assert.deepStrictEqual(b.rows.Groceries, { fixed: 60, flexible: -20, budget: 40, spent: 50, target: 40 });

// No income set: a target still sets its budget, and nothing else shrinks.
b = budgets(clothes(500));
assert.strictEqual(b.rows['Clothing & Accessories'].budget, 500);
assert.strictEqual(b.rows.Groceries.budget, 200);
assert.strictEqual(b.scale, 1);

// ---- progress bar ------------------------------------------------------------
// April's monthly budgets (220) + Travel's 1200 a year at a twelfth = 320.
reset();
vm.runInContext(`goals = { Travel: 1200 };`, ctx);
assert.strictEqual(call(`progressBudget(monthlyBudgets('2026-04'))`), 320);

// April spend across every category, income excluded: 50 + 120 = 170.
const spend = call(`expenses.filter(e => !e.is_positive && e.expense_date.startsWith('2026-04'))
    .reduce((s, e) => s + Math.abs(e.amount), 0)`);
assert.strictEqual(spend, 170);

// The reserved keys must never be rendered or budgeted as a category.
assert.ok(!call(`PLAN_KEYS.some(k => CATEGORIES.includes(k))`), 'a plan key leaked into CATEGORIES');

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
