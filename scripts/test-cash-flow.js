// Checks the cash flow on the budget page: the dates each item falls on, what
// it comes to a month, and the balance run forward from the cash on hand -
// what is there now and the lowest it gets.
//
//   node scripts/test-cash-flow.js
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

for (const file of ['categories.js', 'hebrew-calendar.js', 'auth.js', 'helpers.js', 'budget.js', 'fixed-expenses.js', 'cash-flow.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);
const item = fields => JSON.stringify({ id: 1, name: 'Rent', amount: 100, direction: 'out', frequency: 'monthly', days: '1', start_date: null, ...fields });

// The dates an item falls on from `start` to `end`, as YYYY-MM-DD.
const dates = (fields, start, end) => JSON.parse(call(`JSON.stringify(
    cashOccurrences(${item(fields)}, dateFromIso('${start}'), dateFromIso('${end}')).map(isoDate))`));

// ---- monthly ----------------------------------------------------------------
assert.deepStrictEqual(dates({ days: '1,15' }, '2026-11-13', '2026-12-31'), ['2026-11-15', '2026-12-01', '2026-12-15']);
// Both ends count.
assert.deepStrictEqual(dates({ days: '13' }, '2026-11-13', '2026-12-13'), ['2026-11-13', '2026-12-13']);
// Across the new year.
assert.deepStrictEqual(dates({ days: '5' }, '2026-12-10', '2027-02-28'), ['2027-01-05', '2027-02-05']);
// A day past the end of a short month falls on its last day, and two days
// landing on one date are still two payments.
assert.deepStrictEqual(dates({ days: '30,31' }, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-02-28', '2027-03-30', '2027-03-31']);

// ---- weekly -----------------------------------------------------------------
// 13 Nov 2026 is a Friday.
assert.deepStrictEqual(dates({ frequency: 'weekly', days: '5' }, '2026-11-13', '2026-11-30'), ['2026-11-13', '2026-11-20', '2026-11-27']);
assert.deepStrictEqual(dates({ frequency: 'weekly', days: '1,4' }, '2026-11-13', '2026-11-23'), ['2026-11-16', '2026-11-19', '2026-11-23']);

// ---- every two weeks --------------------------------------------------------
// From a date in the future, the past, or the window's own first day.
assert.deepStrictEqual(dates({ frequency: 'biweekly', start_date: '2026-11-20' }, '2026-11-13', '2026-12-31'), ['2026-11-20', '2026-12-04', '2026-12-18']);
assert.deepStrictEqual(dates({ frequency: 'biweekly', start_date: '2026-01-09' }, '2026-11-13', '2026-12-31'), ['2026-11-13', '2026-11-27', '2026-12-11', '2026-12-25']);
// Across the clock change at the start of November in the US.
assert.deepStrictEqual(dates({ frequency: 'biweekly', start_date: '2026-10-23' }, '2026-11-01', '2026-11-30'), ['2026-11-06', '2026-11-20']);

// ---- a month ----------------------------------------------------------------
const perMonth = fields => Math.round(call(`cashPerMonth(${item(fields)})`) * 100) / 100;
assert.strictEqual(perMonth({ amount: 100, days: '1' }), 100);
assert.strictEqual(perMonth({ amount: 100, days: '1,15' }), 200);
assert.strictEqual(perMonth({ amount: 120, frequency: 'weekly', days: '5' }), 520);       // 52 a year over 12
assert.strictEqual(perMonth({ amount: 60, frequency: 'weekly', days: '1,4' }), 520);
assert.strictEqual(perMonth({ amount: 1200, frequency: 'biweekly', start_date: '2026-11-20' }), 2600);  // 26 a year

assert.strictEqual(call(`cashWhenLabel(${item({ days: '1,15' })})`), '1st & 15th');
assert.strictEqual(call(`cashWhenLabel(${item({ frequency: 'biweekly', start_date: '2026-11-20' })})`), 'every 2 weeks');

const totals = JSON.parse(call(`JSON.stringify(cashTotalsOf([
    ${item({ name: 'Pay', direction: 'in', amount: 1000, days: '1,15' })},
    ${item({ name: 'Rent', amount: 1500, days: '1' })},
    ${item({ name: 'Cleaner', amount: 50, frequency: 'weekly', days: '3' })}
]))`));
assert.strictEqual(totals.inflow, 2000);
assert.strictEqual(Math.round(totals.outflow * 100) / 100, 1716.67);
assert.strictEqual(Math.round(totals.net * 100) / 100, 283.33);

// ---- the projection ---------------------------------------------------------
// Today is Friday 13 November 2026 throughout; the window runs to 31 December.
const TODAY = "dateFromIso('2026-11-13')";
const project = (items, balance) => JSON.parse(call(`(() => {
    const p = cashProjection([${items.join(',')}], ${JSON.stringify(balance)}, ${TODAY});
    return JSON.stringify({
        now: p.now,
        low: { amount: p.low.amount, date: p.low.date && isoDate(p.low.date) },
        end: isoDate(p.end),
        upcoming: p.upcoming.map(e => [isoDate(e.date), e.item.name, e.amount, e.balance])
    });
})()`));

const pay = item({ name: 'Pay', direction: 'in', amount: 1000, days: '1,15' });
const rent = item({ name: 'Rent', amount: 1500, days: '1' });

// Counted today: nothing has happened since, so now is what was typed.
let p = project([pay, rent], { amount: 800, as_of: '2026-11-13' });
assert.strictEqual(p.end, '2026-12-31');
assert.strictEqual(p.now, 800);
// On 1 December rent goes before pay, so the low point is not flattered.
assert.deepStrictEqual(p.upcoming, [
    ['2026-11-15', 'Pay', 1000, 1800],
    ['2026-12-01', 'Rent', -1500, 300],
    ['2026-12-01', 'Pay', 1000, 1300],
    ['2026-12-15', 'Pay', 1000, 2300]
]);
assert.deepStrictEqual(p.low, { amount: 300, date: '2026-12-01' });

// Counted on 31 October: the pay and rent of 1 November have happened since,
// and the typed amount already had 31 October's in it.
p = project([pay, rent], { amount: 800, as_of: '2026-10-31' });
assert.strictEqual(p.now, 300);
assert.deepStrictEqual(p.upcoming[0], ['2026-11-15', 'Pay', 1000, 1300]);
// Rent on 1 December comes before that day's pay and takes it below nothing.
assert.deepStrictEqual(p.low, { amount: -200, date: '2026-12-01' });

// With only money coming in, the lowest it gets is what is there now.
p = project([pay], { amount: 100, as_of: '2026-11-13' });
assert.deepStrictEqual(p.low, { amount: 100, date: null });

// Counted on the 1st: that day's rent and pay were already in it.
p = project([pay, rent], { amount: 800, as_of: '2026-11-01' });
assert.strictEqual(p.now, 800);

// Something due today is coming up, not done, when the cash was counted before.
const today = item({ name: 'Phone', amount: 40, days: '13' });
p = project([today], { amount: 100, as_of: '2026-11-12' });
assert.strictEqual(p.now, 100);
assert.deepStrictEqual(p.upcoming[0], ['2026-11-13', 'Phone', -40, 60]);

// Running short shows as a negative low.
p = project([rent], { amount: 1000, as_of: '2026-11-13' });
assert.deepStrictEqual(p.low, { amount: -500, date: '2026-12-01' });

// No cash typed yet: runs from nothing, from tomorrow.
p = project([pay], null);
assert.strictEqual(p.now, 0);
assert.deepStrictEqual(p.upcoming[0], ['2026-11-15', 'Pay', 1000, 1000]);

// No items: now is the cash, and so is the low point.
p = project([], { amount: 250, as_of: '2026-11-13' });
assert.deepStrictEqual(p.low, { amount: 250, date: null });
assert.deepStrictEqual(p.upcoming, []);

// ---- the form ---------------------------------------------------------------
const formDays = (frequency, text, ticked) => JSON.parse(call(`JSON.stringify(cashDaysFromForm('${frequency}', '${text}', ${JSON.stringify(ticked)}))`));
assert.deepStrictEqual(formDays('monthly', '1, 15', []), { days: [1, 15] });
assert.deepStrictEqual(formDays('monthly', '1 & 15', []), { days: [1, 15] });
assert.ok(formDays('monthly', '', []).error);
assert.ok(formDays('monthly', '32', []).error);
assert.deepStrictEqual(formDays('weekly', '', [5]), { days: [5] });
assert.ok(formDays('weekly', '', []).error);

// ---- what a row says --------------------------------------------------------
const row = call(`cashItemRowHtml(${item({ name: '<b>Rent</b>' })})`);
assert.ok(row.includes('&lt;b&gt;Rent&lt;/b&gt;'), 'names are escaped');
assert.ok(row.includes('-$100.00'));
assert.ok(call(`cashItemRowHtml(${pay})`).includes('+$1000.00'));

console.log('cash flow: all assertions pass');
