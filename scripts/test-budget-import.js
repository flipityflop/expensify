// Checks the budget page's target import: the CSV parse, that a target is
// never set below a category's fixed expenses, and that the sample file reads
// back in as it went out.
//
//   node scripts/test-budget-import.js
//
// Loads every budget-page script into one vm, in page order, so a name clash
// fails here. Stub DOM, no database.
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

for (const file of ['categories.js', 'hebrew-calendar.js', 'auth.js', 'helpers.js', 'budget.js',
    'budget-import.js', 'fixed-expenses.js', 'cash-flow.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

const json = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
const parse = (text, month = '2026-04') =>
    json(`parseTargetsCsv(${JSON.stringify(text)}, ${JSON.stringify(month)})`);

// ---- parsing ---------------------------------------------------------------

// Header in any order and case; a blank month is the selected one; categories
// match regardless of case; a quoted name with a comma; $ and thousands commas.
let out = parse([
    'Amount,Category,Month',
    '450,groceries,',
    '"$1,200.50","Debt, Fees & Taxes",2026-05',
    ',Gifts,'            // blank amount: left alone
].join('\r\n'));
assert.deepStrictEqual(out.errors, []);
assert.deepStrictEqual(out.rows, [
    { month: '2026-04', category: 'Groceries', amount: 450 },
    { month: '2026-05', category: 'Debt, Fees & Taxes', amount: 1200.5 }
]);

// No month column at all: everything is the selected month.
out = parse('category,amount\nRent,2000');
assert.deepStrictEqual(out.rows, [{ month: '2026-04', category: 'Rent', amount: 2000 }]);

// Bad rows are reported by line and skipped; the good ones still come through.
out = parse([
    'category,amount,month',
    'Groceries,300,',
    'Nonsense,10,',
    'Travel,500,',          // yearly: no target
    'Health,-5,',
    'Health,abc,',
    'Fitness,40,2026-13'
].join('\n'));
assert.deepStrictEqual(out.rows, [{ month: '2026-04', category: 'Groceries', amount: 300 }]);
assert.strictEqual(out.errors.length, 5);
assert.ok(out.errors[0].startsWith('Line 3'));
assert.ok(out.errors[1].includes('yearly'));

// A category twice in one month keeps the last row.
out = parse('category,amount\nGroceries,100\nGroceries,200');
assert.deepStrictEqual(out.rows, [{ month: '2026-04', category: 'Groceries', amount: 200 }]);

// Missing columns, and an empty file.
assert.strictEqual(parse('name,value\nGroceries,1').rows.length, 0);
assert.strictEqual(parse('name,value\nGroceries,1').errors.length, 1);
assert.deepStrictEqual(parse('').errors, ['The file is empty.']);

// ---- fixed expenses stay covered --------------------------------------------

// Bills & Insurance has $150 fixed a month ($120 monthly + $360 a year / 12).
vm.runInContext(`fixedItems = ${JSON.stringify([
    { id: 1, category: 'Bills & Insurance', name: 'Phone', amount: 120, frequency: 'monthly' },
    { id: 2, category: 'Bills & Insurance', name: 'Renters', amount: 360, frequency: 'yearly' }
])};`, ctx);

vm.runInContext(`importRows = ${JSON.stringify([
    { month: '2026-04', category: 'Bills & Insurance', amount: 100 },  // under: lifted to 150
    { month: '2026-04', category: 'Bills & Insurance', amount: 0 },    // 0 too
    { month: '2026-05', category: 'Bills & Insurance', amount: 400 },  // over: kept
    { month: '2026-04', category: 'Groceries', amount: 0 }             // no fixed: 0 is fine
])}; liftedCount = coverFixedExpenses(importRows);`, ctx);
assert.strictEqual(json('liftedCount'), 2);
assert.deepStrictEqual(json('importRows').map(r => r.amount), [150, 150, 400, 0]);
// The fixed expenses themselves are untouched.
assert.strictEqual(json('fixedItems').length, 2);
assert.strictEqual(json('fixedItems')[0].amount, 120);

// ---- the sample file -------------------------------------------------------

// Every monthly category, none of the yearly ones, each with its budget for
// the month - and it parses straight back in without an error.
const sample = vm.runInContext(`targetsSampleCsv('2026-04')`, ctx);
const lines = sample.trim().split('\n');
assert.strictEqual(lines[0], 'month,category,amount');
const monthlyCount = json(`CATEGORIES.filter(c => goalPeriod(c) !== 'yearly').length`);
assert.strictEqual(lines.length - 1, monthlyCount);
assert.ok(!sample.includes('Travel') && !sample.includes('Tzedakah'));
assert.ok(lines.includes('2026-04,Bills & Insurance,150.00'));

out = parse(sample);
assert.deepStrictEqual(out.errors, []);
assert.strictEqual(out.rows.length, monthlyCount);
assert.ok(out.rows.some(r => r.category === 'Debt, Fees & Taxes'));

console.log('budget import: all checks passed');
