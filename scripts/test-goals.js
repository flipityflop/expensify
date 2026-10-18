// Checks the Goals page's one piece of arithmetic worth getting wrong: the
// amount that has to go by each month, which depends on how many months are
// left, and the bar, which fills as the money goes by.
//
//   node scripts/test-goals.js
//
// Runs the real shipped helpers.js and goals.js in a vm with a stub DOM, as the
// page loads them. No database.
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

for (const file of ['auth.js', 'helpers.js', 'goals.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

// Arrays and objects built inside the vm have its own prototypes, so they come
// out as JSON to compare.
const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);
const goal = fields => JSON.stringify({
    id: 1, name: 'Car', target: 1200, target_date: '2027-10-18', saved: 0, notes: '', ...fields
});

// Today is 18 October 2026 throughout.
const TODAY = 'new Date(2026, 9, 18)';

// ---- what is left --------------------------------------------------------
assert.strictEqual(call(`goalLeft(${goal({ saved: 0 })})`), 1200);
assert.strictEqual(call(`goalLeft(${goal({ saved: 450 })})`), 750);
assert.strictEqual(call(`goalLeft(${goal({ saved: 1200 })})`), 0);
// A target edited down below what is already saved reads as met, not negative.
assert.strictEqual(call(`goalLeft(${goal({ target: 500, saved: 900 })})`), 0);

// ---- months left ---------------------------------------------------------
const months = date => call(`monthsLeft(${goal({ target_date: date })}, ${TODAY})`);

assert.strictEqual(months('2027-10-18'), 12);   // the same day a year out
assert.strictEqual(months('2026-12-20'), 2);    // later in its month: that month counts
assert.strictEqual(months('2026-11-01'), 0);    // earlier in its month: under a month to go
assert.strictEqual(months('2026-10-31'), 0);    // later this month
assert.strictEqual(months('2026-10-18'), 0);    // today
assert.strictEqual(months('2026-09-01'), -2);   // passed

// ---- the monthly amount --------------------------------------------------
const needed = fields => call(`monthlyNeeded(${goal(fields)}, ${TODAY})`);

assert.strictEqual(needed({ target: 1200, target_date: '2027-10-18' }), 100);
assert.strictEqual(needed({ target: 1200, saved: 600, target_date: '2027-10-18' }), 50);
assert.strictEqual(needed({ target: 1200, target_date: '2026-12-20' }), 600);

// Under a month to go, or a date already passed: all of it, not a division by
// zero or a negative number of months.
assert.strictEqual(needed({ target: 1200, target_date: '2026-11-01' }), 1200);
assert.strictEqual(needed({ target: 1200, target_date: '2026-09-01' }), 1200);

// A goal already met needs nothing.
assert.strictEqual(needed({ target: 1200, saved: 1200 }), 0);
assert.strictEqual(needed({ target: 1200, saved: 1200, target_date: '2026-09-01' }), 0);

// ---- the date, and how far off it is -------------------------------------
const when = fields => call(`goalWhenHtml(${goal(fields)}, ${TODAY})`);
const dateOf = iso => call(`shortDate('${iso}')`);

assert.strictEqual(when({ target_date: '2027-10-18' }), `by ${dateOf('2027-10-18')} · in 12 months`);
assert.strictEqual(when({ target_date: '2026-12-20' }), `by ${dateOf('2026-12-20')} · in 2 months`);
assert.strictEqual(when({ target_date: '2026-11-20' }), `by ${dateOf('2026-11-20')} · in 1 month`);
assert.strictEqual(when({ target_date: '2026-10-31' }), `by ${dateOf('2026-10-31')} · this month`);

// A date gone by with money still to find is called out in red.
assert.strictEqual(when({ target_date: '2026-09-01' }), `<span class="over">past ${dateOf('2026-09-01')}</span>`);
// One that is met is not, whatever its date.
assert.ok(!when({ target_date: '2026-09-01', saved: 1200 }).includes('over'));

// ---- what a row says -----------------------------------------------------
const widthOf = html => html.match(/width: ([0-9.]+)%/)[1];
const row = fields => call(`goalRowHtml(${goal(fields)}, ${TODAY})`);

// The bar fills as the money goes by - the opposite way round to a debt bar.
assert.strictEqual(widthOf(row({ saved: 0 })), '0');
assert.strictEqual(widthOf(row({ saved: 300 })), '25');
assert.strictEqual(widthOf(row({ saved: 1200 })), '100');
assert.strictEqual(widthOf(row({ target: 500, saved: 900 })), '100');   // never past the end

assert.ok(row({ saved: 300 }).includes('$300.00 of $1200.00'));
assert.ok(row({ saved: 300 }).includes('$75.00/mo'));          // 900 over 12 months
assert.ok(row({ saved: 1200 }).includes('Met'), 'a met goal asks for nothing a month');

// Free text going into innerHTML.
assert.ok(row({ name: '<b>Car</b> & "fund"' }).includes('&lt;b&gt;Car&lt;/b&gt; &amp; &quot;fund&quot;'));

// Nothing says a value is missing: a goal with no notes just has none.
assert.ok(!/not set|no notes/i.test(row({})), 'a missing value is spoken of');
assert.ok(row({ notes: 'ask Dad' }).includes('· ask Dad'));

// ---- totals and the plan -------------------------------------------------
const list = JSON.stringify([
    { id: 1, name: 'Car', target: 1200, target_date: '2027-10-18', saved: 0, notes: '' },
    { id: 2, name: 'Sheitel', target: 2400, target_date: '2026-12-20', saved: 400, notes: '' },
    { id: 3, name: 'Done', target: 500, target_date: '2026-11-01', saved: 500, notes: '' }
]);

// Soonest first, so a date already passed comes top.
assert.deepStrictEqual(JSON.parse(call(`JSON.stringify(sortGoals(${list}).map(g => g.name))`)),
    ['Done', 'Sheitel', 'Car']);

const totals = JSON.parse(call(`JSON.stringify(goalTotalsOf(${list}, ${TODAY}))`));
assert.strictEqual(totals.target, 4100);
assert.strictEqual(totals.saved, 900);
// 100 for the car, 1000 for the sheitel over its two months, nothing for the
// one already met.
assert.strictEqual(totals.monthly, 1100);

// The plan's savings row is only mentioned when the goals ask for more than it.
vm.runInContext('planSavings = 0;', ctx);
assert.strictEqual(call('planLineHtml(1100)'), '');
vm.runInContext('planSavings = 1500;', ctx);
assert.strictEqual(call('planLineHtml(1100)'), '');
vm.runInContext('planSavings = 800;', ctx);
assert.strictEqual(call('planLineHtml(1100)'), `<span class="over">$300.00/mo over the plan's savings</span>`);

console.log('goals: all assertions pass');
