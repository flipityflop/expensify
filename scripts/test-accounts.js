// Checks the accounts page's arithmetic worth getting wrong: the monthly
// interest estimate, the next annual-fee renewal rolled forward from a past
// date, the order accounts are listed in, the totals across them, and the
// balances projected forward from a rate of return.
//
//   node scripts/test-accounts.js
//
// Loads the page's scripts into one vm, in page order, so a name declared in
// two of them fails here first. Stub DOM, no database.
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

for (const file of ['categories.js', 'auth.js', 'helpers.js', 'cards.js', 'investments.js', 'retirement.js', 'debts.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
}

// Arrays and objects built inside the vm have its own prototypes, so they
// come out as JSON to compare.
const call = expr => vm.runInContext(`out = ${expr}; out`, ctx);
const card = fields => JSON.stringify({
    id: 1, name: 'Card', balance: 0, balance_as_of: '2026-10-12', apr: null,
    annual_fee: 0, fee_renewal: null, notes: '', ...fields
});

// ---- credit cards: interest ----------------------------------------------
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
assert.ok(!bare.includes('acct-facts') && !bare.includes('APR'), bare);

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

// ---- investment accounts -------------------------------------------------
const investments = JSON.stringify([
    { id: 1, name: 'Brokerage', kind: 'Brokerage', balance: 12000, balance_as_of: '2026-10-12', contribution: 500, notes: '' },
    { id: 2, name: 'Rainy day', kind: 'Savings', balance: 30000, balance_as_of: '2026-10-12', contribution: 0, notes: '' },
    { id: 3, name: 'Coins', kind: 'Crypto', balance: 800, balance_as_of: '2026-10-12', contribution: 25, notes: '' }
]);

assert.deepStrictEqual(JSON.parse(call(`JSON.stringify(sortInvestments(${investments}).map(a => a.name))`)),
    ['Rainy day', 'Brokerage', 'Coins']);

const invTotals = JSON.parse(call(`JSON.stringify(investmentTotalsOf(${investments}))`));
assert.strictEqual(invTotals.balance, 42800);
assert.strictEqual(invTotals.contribution, 525);

// The kind is always known, so it is always shown; nothing going in says so by
// saying nothing.
const invRow = call(`investmentRowHtml({ id: 1, name: 'Fidelity <IRA>', kind: 'Brokerage', balance: 12000, balance_as_of: '2026-10-12', contribution: 0, notes: '' })`);
assert.ok(invRow.includes('Fidelity &lt;IRA&gt;'), 'account name not escaped');
assert.ok(invRow.includes('<strong>Brokerage</strong>'), invRow);
assert.ok(!invRow.includes('/mo in'), invRow);

// ---- retirement: future value --------------------------------------------
const account = fields => JSON.stringify({
    id: 1, name: '401(k)', kind: '401(k)', balance: 0, balance_as_of: '2026-10-12',
    annual_return: null, contribution: 0, notes: '', ...fields
});
const fv = (fields, years) => call(`futureValue(${account(fields)}, ${years})`);

// A balance left alone at 12%/yr, compounded monthly, is 1% a month.
assert.ok(Math.abs(fv({ balance: 1000, annual_return: 12 }, 1) - 1000 * Math.pow(1.01, 12)) < 1e-9);

// With no rate set, nothing grows: the balance plus what is paid in.
assert.strictEqual(fv({ balance: 1000, contribution: 100 }, 2), 1000 + 100 * 24);
assert.strictEqual(fv({ balance: 1000, annual_return: 0, contribution: 100 }, 2), 1000 + 100 * 24);

// 100 a month for a year at 12%: the annuity formula, each month's payment
// compounding from the month it goes in.
const annuity = 100 * (Math.pow(1.01, 12) - 1) / 0.01;
assert.ok(Math.abs(fv({ contribution: 100, annual_return: 12 }, 1) - annuity) < 1e-9);

// A pessimistic rate still projects, downwards.
assert.ok(fv({ balance: 1000, annual_return: -6 }, 5) < 1000);

// ---- retirement: the projection table ------------------------------------
const retirement = JSON.stringify([
    { id: 1, name: 'Work 401(k)', kind: '401(k)', balance: 50000, balance_as_of: '2026-10-12', annual_return: 7, contribution: 1000, notes: '' },
    { id: 2, name: 'Roth', kind: 'Roth IRA', balance: 20000, balance_as_of: '2026-10-12', annual_return: 6, contribution: 500, notes: '' }
]);
const projected = JSON.parse(call(`JSON.stringify(projectRetirement(${retirement}, 2026))`));

assert.deepStrictEqual(projected.map(r => r.years), [1, 5, 10, 15, 20, 25, 30]);
assert.deepStrictEqual(projected.map(r => r.year), [2027, 2031, 2036, 2041, 2046, 2051, 2056]);

// Paid in is both contributions for every month of the horizon, and the three
// figures have to add up: balance now + paid in + growth.
assert.strictEqual(projected[1].paidIn, 1500 * 60);
const balanceNow = 70000;
projected.forEach(row => {
    assert.ok(Math.abs(row.balance - (balanceNow + row.paidIn + row.growth)) < 1e-9, `row ${row.years}`);
});

// It grows, and the growth is a larger share of it the further out it goes.
assert.ok(projected[0].balance < projected[6].balance);
assert.ok(projected[0].growth / projected[0].balance < projected[6].growth / projected[6].balance);

// An account with nothing in it and nothing going in projects to nothing,
// which is what hides the table.
assert.strictEqual(JSON.parse(call(`JSON.stringify(projectRetirement([], 2026))`))[0].balance, 0);

// The bars are each year's balance against the furthest year's, so the last
// one is full and the first is not.
const bars = JSON.parse(call(`JSON.stringify(projectRetirement(${retirement}, 2026).map(r =>
    projectionRowHtml(r, projectRetirement(${retirement}, 2026)[6].balance)))`));
assert.ok(bars[6].includes('width: 100%'), bars[6]);
assert.ok(/width: [0-9.]+%/.test(bars[0]) && !bars[0].includes('width: 100%'), bars[0]);
assert.ok(bars[0].includes('in 1 year') && bars[1].includes('in 5 years'), bars[0]);

const retTotals = JSON.parse(call(`JSON.stringify(retirementTotalsOf(${retirement}))`));
assert.strictEqual(retTotals.balance, 70000);
assert.strictEqual(retTotals.contribution, 1500);

// A rate that is not set shows no return at all, not a 0%.
const bareRetirement = call(`retirementRowHtml(${account({ balance: 500 })})`);
assert.ok(!bareRetirement.includes('return'), bareRetirement);
assert.ok(call(`retirementRowHtml(${account({ balance: 500, annual_return: 0 })})`).includes('0% return'));

console.log('accounts: all assertions pass');
