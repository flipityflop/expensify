// Checks that a CSV exported from the Expenses page imports back correctly.
//
//   node scripts/test-csv-roundtrip.js
//
// The two sides live far apart in all-expenses.js (exportToCSV writes the
// header, parseCSV reads it) and have drifted before: the export said
// "Description" while the import demanded "What", and the export's Income/
// Expense "Type" column was ignored entirely, so re-importing an export turned
// every paycheck into a purchase. Both were silent.
//
// Runs the real shipped file in a vm with a stub DOM. Touches no database.
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
        if (prop === 'value' || prop === 'innerHTML' || prop === 'textContent') return '';
        if (prop === 'checked') return false;
        return () => stubEl();
    },
    set: () => true
});

const ctx = vm.createContext({
    document: { getElementById: stubEl, addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    localStorage: { getItem: () => 'x', removeItem() {} },
    alert: msg => { ctx.lastAlert = msg; },
    console,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
});
ctx.window.location = { href: '' };

vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'categories.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'all-expenses.js'), 'utf8'), ctx);
// showImportPreview touches DOM nodes the stub cannot fake convincingly.
vm.runInContext('showImportPreview = function () {};', ctx);

function importCsv(csv) {
    ctx.lastAlert = null;
    vm.runInContext(`parseCSV(${JSON.stringify(csv)}); out = parsedImportData;`, ctx);
    return { rows: ctx.out, alert: ctx.lastAlert };
}

// ---- what exportToCSV actually emits -------------------------------------
const exported = [
    '"Date","Amount","Type","Category","Description","Merchant","Event"',
    '"2025-01-15","50.25","Expense","Groceries","Grocery shopping","trader joes",""',
    '"2025-01-20","2500.00","Income","work","Paycheck","",""',
    '"2025-01-17","75.00","Expense","Car","Gas","shell","florida trip"'
].join('\n');

const { rows, alert } = importCsv(exported);
assert.strictEqual(alert, null, `export rejected by import: ${alert}`);
assert.strictEqual(rows.length, 3, 'all three exported rows should import');

assert.strictEqual(rows[0].category, 'Groceries');
assert.strictEqual(rows[0].what, 'Grocery shopping');
assert.strictEqual(rows[0].merchant, 'trader joes');   // Merchant column survives
assert.strictEqual(rows[0].is_positive, false);

assert.strictEqual(rows[1].is_positive, true, 'Type=Income must import as income');
assert.strictEqual(rows[1].category, 'work');

assert.strictEqual(rows[2].event, 'florida trip');     // Event column survives
assert.strictEqual(rows[2].merchant, 'shell');

// ---- older files, headed "What" / "Notes", still import -------------------
const legacy = [
    '"Date","Amount","Category","What","Notes","Is Income","Is Taxable"',
    '"2025-01-16","12.50","Restaurants & Takeout","Lunch","chocolatte","false","false"'
].join('\n');

const old = importCsv(legacy);
assert.strictEqual(old.alert, null, `legacy header rejected: ${old.alert}`);
assert.strictEqual(old.rows[0].merchant, 'chocolatte', 'legacy Notes column maps to merchant');
assert.strictEqual(old.rows[0].is_positive, false);

// ---- a category outside the 21 is rejected, not silently stored ----------
const bad = importCsv([
    '"Date","Amount","Category","Description"',
    '"2025-01-15","10.00","kitchen / home","Something"'
].join('\n'));
assert.ok(/Unknown category/.test(bad.alert || ''), 'retired category must be rejected');

// ---- a missing required column is still caught --------------------------
const missing = importCsv('"Date","Amount","Category"\n"2025-01-15","10.00","Groceries"');
assert.ok(/Missing required columns/.test(missing.alert || ''), 'missing description not caught');

console.log('csv round-trip: all assertions pass');
