// Checks the credit card arithmetic worth getting wrong: the monthly interest
// estimate, the next annual-fee renewal rolled forward from a past date, the
// order cards are listed in, and the totals across them.
//
//   node scripts/test-cards.js
//
// Loads the cards page's scripts into one vm, in page order, so a name declared
// in both cards.js and debts.js fails here first. Stub DOM, no database.
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

for (const file of ['auth.js', 'helpers.js', 'cards.js', 'debts.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

// Arrays and objects built inside the vm have its own prototypes, so they
// come out as JSON to compare.
const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);
const card = fields => JSON.stringify({
    id: 1, name: 'Card', balance: 0, balance_as_of: '2026-10-12', apr: null,
    annual_fee: 0, fee_renewal: null, notes: '', ...fields
});

// ---- interest ------------------------------------------------------------
// 1200 at 24% is 288 a year, 24 a month.
assert.strictEqual(call(`monthlyInterest(${card({ balance: 1200, apr: 24 })})`), 24);
assert.strictEqual(call(`monthlyInterest(${card({ balance: 1200, apr: null })})`), 0);   // no APR, no estimate
assert.strictEqual(call(`monthlyInterest(${card({ balance: 0, apr: 24 })})`), 0);
assert.strictEqual(call(`monthlyInterest(${card({ balance: -50, apr: 24 })})`), 0);      // in credit costs nothing

// ---- next renewal --------------------------------------------------------
const renews = (date, today) => call(`nextRenewal(${card({ fee_renewal: date })}, '${today}')`);

assert.strictEqual(renews('2026-11-01', '2026-10-12'), '2026-11-01');   // still ahead
assert.strictEqual(renews('2026-10-12', '2026-10-12'), '2026-10-12');   // today
assert.strictEqual(renews('2026-03-15', '2026-10-12'), '2027-03-15');   // passed: next year
assert.strictEqual(renews('2023-11-20', '2026-10-12'), '2026-11-20');   // entered years ago
assert.strictEqual(renews('2028-03-15', '2026-10-12'), '2028-03-15');   // waived first year: left alone
assert.strictEqual(renews('2024-02-29', '2026-10-12'), '2027-02-28');   // no 29 February in 2027
assert.strictEqual(renews('2024-02-29', '2027-03-01'), '2028-02-29');   // back in a leap year
assert.strictEqual(renews(null, '2026-10-12'), null);

assert.strictEqual(call(`daysFrom('2026-10-12', '2026-11-01')`), 20);
assert.strictEqual(call(`daysFrom('2026-03-07', '2026-03-09')`), 2);    // across a clock change

// ---- what a row says ---------------------------------------------------
// renewalHtml reads the real date, so these use renewals relative to today.
const today = call(`isoDate(new Date())`);
const shift = days => { const d = new Date(); d.setDate(d.getDate() + days); return call(`isoDate(new Date(${d.getFullYear()}, ${d.getMonth()}, ${d.getDate()}))`); };

const soon = call(`renewalHtml(${card({ annual_fee: 95, fee_renewal: shift(10) })}, '${today}')`);
assert.ok(soon.includes('renews-soon') && soon.includes('in 10 days'), soon);
const later = call(`renewalHtml(${card({ annual_fee: 95, fee_renewal: shift(90) })}, '${today}')`);
assert.ok(!later.includes('renews-soon') && later.includes('$95.00/yr fee · renews'), later);
assert.strictEqual(call(`renewalHtml(${card({ annual_fee: 0, fee_renewal: shift(10) })}, '${today}')`), '');   // no fee, nothing said
assert.strictEqual(call(`renewalHtml(${card({ annual_fee: 95 })}, '${today}')`), '$95.00/yr fee');

const row = call(`cardRowHtml(${card({ name: 'Visa <Gold>', balance: 1200, apr: 24 })}, '${today}')`);
assert.ok(row.includes('Visa &lt;Gold&gt;'), 'card name not escaped');
assert.ok(row.includes('<strong>24%</strong> APR'));
assert.ok(row.includes('≈ $24.00/mo interest'));

// A card with nothing known beyond its balance shows no facts line at all.
const bare = call(`cardRowHtml(${card({ apr: null })}, '${today}')`);
assert.ok(!bare.includes('card-facts') && !bare.includes('APR'), bare);

// ---- order and totals ----------------------------------------------------
const list = JSON.stringify([
    { id: 1, name: 'Low', balance: 5000, apr: 9.99, annual_fee: 0 },
    { id: 2, name: 'Unknown', balance: 100, apr: null, annual_fee: 0 },
    { id: 3, name: 'High', balance: 300, apr: 29.99, annual_fee: 95 },
    { id: 4, name: 'Zero', balance: 800, apr: 0, annual_fee: 550 },
    { id: 5, name: 'High too', balance: 900, apr: 29.99, annual_fee: 0 }
]);

// Highest APR first, ties by balance, no APR last - a 0% card is still known.
assert.deepStrictEqual(JSON.parse(call(`JSON.stringify(sortCards(${list}).map(c => c.name))`)), ['High too', 'High', 'Low', 'Zero', 'Unknown']);

const totals = JSON.parse(call(`JSON.stringify(cardTotalsOf(${list}))`));
assert.strictEqual(totals.balance, 7100);
assert.strictEqual(totals.fees, 645);
// 5000 * 9.99% + 300 * 29.99% + 900 * 29.99%, a twelfth of each.
assert.ok(Math.abs(totals.interest - (5000 * 0.0999 + 1200 * 0.2999) / 12) < 1e-9, `interest ${totals.interest}`);

console.log('cards: all assertions pass');
