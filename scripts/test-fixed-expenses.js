// Checks the due dates of fixed expenses - the next one, pulled back in short
// months - and what an opened category row and the schedule show.
//
//   node scripts/test-fixed-expenses.js
//
// Loads every budget-page script into one vm, in page order, the way the page
// shares their top-level scope: a name declared twice fails here first. Stub
// DOM, no database.
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

for (const file of ['categories.js', 'hebrew-calendar.js', 'auth.js', 'budget.js', 'debts.js', 'fixed-expenses.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);

// ---- next due date -------------------------------------------------------
const monthly = day => JSON.stringify({ frequency: 'monthly', due_day: day });
const yearly = (month, day) => JSON.stringify({ frequency: 'yearly', due_month: month, due_day: day });
// `today` as y, m (1-based), d; the answer as YYYY-MM-DD.
const next = (item, y, m, d) => call(`(() => {
    const due = nextDue(${item}, new Date(${y}, ${m - 1}, ${d}));
    return due && isoDate(due);
})()`);

assert.strictEqual(next(monthly(15), 2026, 10, 12), '2026-10-15');   // later this month
assert.strictEqual(next(monthly(12), 2026, 10, 12), '2026-10-12');   // today counts
assert.strictEqual(next(monthly(10), 2026, 10, 12), '2026-11-10');   // passed: next month
assert.strictEqual(next(monthly(5), 2026, 12, 31), '2027-01-05');    // across the new year

// Due on the 31st: the 30th in a 30-day month, the 28th or 29th in February.
assert.strictEqual(next(monthly(31), 2026, 11, 5), '2026-11-30');
assert.strictEqual(next(monthly(30), 2027, 1, 31), '2027-02-28');
assert.strictEqual(next(monthly(31), 2028, 2, 1), '2028-02-29');

assert.strictEqual(next(yearly(3, 15), 2026, 10, 12), '2027-03-15');  // passed this year
assert.strictEqual(next(yearly(12, 1), 2026, 10, 12), '2026-12-01');  // still to come
assert.strictEqual(next(yearly(10, 12), 2026, 10, 12), '2026-10-12'); // today

// 29 February falls on the 28th outside a leap year.
assert.strictEqual(next(yearly(2, 29), 2027, 1, 1), '2027-02-28');
assert.strictEqual(next(yearly(2, 29), 2027, 3, 1), '2028-02-29');

assert.strictEqual(next(JSON.stringify({ frequency: 'monthly', due_day: null }), 2026, 10, 12), null);

// ---- labels --------------------------------------------------------------
assert.deepStrictEqual(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(n => call(`ordinal(${n})`)),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']
);
assert.strictEqual(call(`dueLabel(${monthly(15)})`), 'due the 15th');
assert.strictEqual(call(`dueLabel(${JSON.stringify({ frequency: 'monthly', due_day: null })})`), 'no due date');
assert.ok(call(`dueLabel(${yearly(2, 29)})`).startsWith('due '));

// ---- under an opened category row ----------------------------------------
vm.runInContext(`fixedItems = ${JSON.stringify([
    { id: 1, category: 'Bills & Insurance', name: 'Phone <5G>', amount: 80, frequency: 'monthly', due_day: 15 },
    { id: 2, category: 'Bills & Insurance', name: 'Car insurance', amount: 1200, frequency: 'yearly', due_month: 3, due_day: 1 }
])}; goals = { 'Bills & Insurance': 400 };`, ctx);

// 80 a month + 1200 a year at a twelfth = 180 of the 400 goal fixed.
const detail = call(`fixedDetailHtml('Bills & Insurance')`);
assert.ok(detail.includes('Fixed $180.00 of the $400.00 goal · $220.00 flexible'), detail);
assert.ok(detail.includes('Phone &lt;5G&gt;'), 'item name not escaped');
assert.ok(detail.includes('$1200.00 a year'));
assert.ok(detail.includes('data-item-add="Bills & Insurance"'));

// Fixed expenses above the goal are called out rather than shown as negative.
vm.runInContext(`goals = { 'Bills & Insurance': 100 };`, ctx);
assert.ok(call(`fixedDetailHtml('Bills & Insurance')`).includes('more than the $100.00 goal'));

assert.ok(call(`fixedDetailHtml('Groceries')`).includes('No fixed expenses in Groceries yet.'));

// ---- the schedule --------------------------------------------------------
// Today is 12 October 2026 throughout.
const row = (y, m, d) => call(`scheduleRowHtml(fixedItems[0], new Date(${y}, ${m - 1}, ${d}), new Date(2026, 9, 12))`);
assert.ok(row(2026, 10, 15).includes('in 3 days'));
assert.ok(row(2026, 10, 15).includes('class="due-soon"'));
assert.ok(row(2026, 10, 12).includes('today'));
assert.ok(row(2026, 10, 13).includes('tomorrow'));
assert.ok(!row(2026, 11, 1).includes('due-soon'));
assert.ok(call(`scheduleRowHtml(fixedItems[0], null, new Date(2026, 9, 12))`).includes('no due date'));

vm.runInContext(`fixedItems = []; goals = {};`, ctx);

console.log('fixed expenses: all assertions pass');
