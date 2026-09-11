// Checks the debt tracker's one piece of arithmetic worth getting wrong: the
// bar is the balance still owed, so it has to empty as the debt is paid down,
// and it must never go negative.
//
//   node scripts/test-debt.js
//
// Runs the real shipped debts.js in a vm with a stub DOM. No database.
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
    // debts.js is loaded after budget.js in the page and shares its scope.
    money: amount => `$${amount.toFixed(2)}`,
    console
});

vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'debts.js'), 'utf8'), ctx);

const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);
const debt = (total, paid) => JSON.stringify({ id: 1, name: 'Car', total, paid, as_of: '2026-03-04', notes: '' });

// ---- debtLeft ------------------------------------------------------------
assert.strictEqual(call(`debtLeft(${debt(1000, 0)})`), 1000);
assert.strictEqual(call(`debtLeft(${debt(1000, 250)})`), 750);
assert.strictEqual(call(`debtLeft(${debt(1000, 1000)})`), 0);

// A total edited down below what has already been paid still reads as cleared,
// not as a negative balance the bar would render backwards.
assert.strictEqual(call(`debtLeft(${debt(500, 900)})`), 0);

// ---- the bar -------------------------------------------------------------
const widthOf = html => html.match(/width: ([0-9.]+)%/)[1];

// Three quarters paid off leaves a quarter of the bar, not three quarters.
assert.strictEqual(widthOf(call(`debtRowHtml(${debt(1000, 750)})`)), '25');
assert.strictEqual(widthOf(call(`debtRowHtml(${debt(1000, 0)})`)), '100');
assert.strictEqual(widthOf(call(`debtRowHtml(${debt(1000, 1000)})`)), '0');

// The figures alongside it are the remaining balance against the original.
assert.ok(call(`debtRowHtml(${debt(1000, 750)})`).includes('$250.00 left of $1000.00'));

// ---- names ---------------------------------------------------------------
// Free text going into innerHTML.
assert.ok(call(`escapeHtml('<b>Car</b> & "loan"')`) === '&lt;b&gt;Car&lt;/b&gt; &amp; &quot;loan&quot;');

// ---- as-of date ----------------------------------------------------------
// Parsed from local parts: a stored date must display as the same day, not the
// one before it west of Greenwich.
assert.strictEqual(call(`debtDate('2026-03-04')`), new Date(2026, 2, 4).toLocaleDateString());
assert.strictEqual(call(`debtDate('')`), '—');

console.log('test-debt: all assertions passed');
