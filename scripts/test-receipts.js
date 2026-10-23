// Checks the receipt pieces that run in the browser: the size of the viewing
// copy, the type of a file the phone hands over without one, the row button,
// the delete question and the viewer's list.
//
//   node scripts/test-receipts.js
//
// Loads each page's scripts into one vm, in page order - the entry page and
// the Expenses page both load receipts.js - so a name declared twice fails
// here first. Stub DOM, no database, no bucket.
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
        if (prop === 'checked') return false;
        return () => stubEl();
    },
    set: () => true
});

function pageContext(files) {
    const ctx = vm.createContext({
        document: { getElementById: stubEl, addEventListener() {}, querySelectorAll: () => [] },
        window: { location: {}, addEventListener() {} },
        localStorage: { getItem: () => 'x' },
        console
    });
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), ctx);
    return ctx;
}

const home = pageContext(['categories.js', 'auth.js', 'helpers.js', 'receipts.js', 'script.js']);
const expenses = pageContext(['categories.js', 'auth.js', 'helpers.js', 'receipts.js', 'all-expenses.js']);
const call = (ctx, expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));

// ---- the viewing copy ------------------------------------------------------
// The long edge comes down to 3000 and the shape is kept.
assert.deepStrictEqual(call(home, 'receiptViewSize(4000, 3000)'), { width: 3000, height: 2250 });
assert.deepStrictEqual(call(home, 'receiptViewSize(3024, 4032)'), { width: 2250, height: 3000 });
// A long receipt photographed whole keeps its full height up to the limit.
assert.deepStrictEqual(call(home, 'receiptViewSize(1000, 3000)'), { width: 1000, height: 3000 });
// Never enlarged: a small screenshot stays as it is.
assert.deepStrictEqual(call(home, 'receiptViewSize(600, 900)'), { width: 600, height: 900 });

// ---- file type -------------------------------------------------------------
assert.strictEqual(call(home, `receiptMime({ type: 'image/heic', name: 'IMG_0001.HEIC' })`), 'image/heic');
// No type from the phone: the name says.
assert.strictEqual(call(home, `receiptMime({ type: '', name: 'IMG_0001.HEIC' })`), 'image/heic');
assert.strictEqual(call(home, `receiptMime({ type: '', name: 'scan.jpeg' })`), 'image/jpeg');
// Not a photo: left blank, which the server refuses.
assert.strictEqual(call(home, `receiptMime({ type: '', name: 'statement.pdf' })`), '');

// ---- the row button --------------------------------------------------------
const button = (expense, ctx = home) => call(ctx, `receiptButtonHtml(${JSON.stringify(expense)}, 'receipt-btn')`);

assert.ok(button({ id: 5, receipt_count: 0 }).includes('>📎<'));
assert.ok(button({ id: 5, receipt_count: 0 }).includes('onclick="attachReceipt(5)"'));
assert.ok(button({ id: 5 }).includes('>📎<'), 'a row from before receipts reads as none');
assert.ok(button({ id: 5, receipt_count: 1 }).includes('>🧾<'));
assert.ok(button({ id: 5, receipt_count: 1 }).includes('onclick="openReceipts(5)"'));
assert.ok(button({ id: 5, receipt_count: 3 }).includes('>🧾3<'));
// A consolidated row stands for several expenses: no button.
assert.strictEqual(button({ id: -1729000000000.5, receipt_count: 2 }, expenses), '');

// ---- deleting an expense ---------------------------------------------------
assert.strictEqual(call(home, 'deleteExpenseQuestion(0)'), 'Are you sure you want to delete this expense?');
assert.strictEqual(call(home, 'deleteExpenseQuestion(1)'), 'Delete this expense and its receipt?');
assert.strictEqual(call(home, 'deleteExpenseQuestion(2)'), 'Delete this expense and its receipts?');

// ---- the viewer ------------------------------------------------------------
assert.ok(call(home, 'receiptListHtml([])').includes('No receipts yet.'));
const listed = call(home, `receiptListHtml([{ id: 9, view_url: 'https://r2/x-view.jpg?a=1&b="2"', original_url: 'https://r2/x.heic?a=1', uploaded_at: '2026-10-23T13:00:00.000Z' }])`);
// Signed URLs carry & and could carry quotes: escaped into the attributes.
assert.ok(listed.includes('src="https://r2/x-view.jpg?a=1&amp;b=&quot;2&quot;"'));
assert.ok(listed.includes('href="https://r2/x.heic?a=1"'));
assert.ok(listed.includes('data-remove-receipt="9"'));

// ---- a row redraws after a change ------------------------------------------
vm.runInContext(`recentExpenses = [{ id: 7, receipt_count: 0, amount: -5, what: 'Milk', category: 'Groceries', expense_date: '2026-10-23' }]`, home);
vm.runInContext('receiptsChanged(7, 2)', home);
assert.strictEqual(call(home, 'recentExpenses[0].receipt_count'), 2);

vm.runInContext(`allExpenses = [{ id: 7, receipt_count: 0, amount: -5, is_positive: 0, version: 2, what: 'Milk', category: 'Groceries', expense_date: '2026-10-23' }]`, expenses);
vm.runInContext('receiptsChanged(7, 1)', expenses);
assert.strictEqual(call(expenses, 'allExpenses[0].receipt_count'), 1);

// ---- the phone's own picker ------------------------------------------------
// No capture attribute anywhere: with one, the phone goes straight to the
// camera and hides the photo library.
for (const file of ['index.html', 'receipts.js']) {
    const source = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const inputs = source.match(/<input type="file"[^>]*>/g) || [];
    assert.ok(inputs.length, `${file} has a file input`);
    for (const input of inputs) {
        assert.ok(input.includes('accept="image/*"'), `${file}: ${input}`);
        assert.ok(input.includes('multiple'), `${file}: ${input}`);
        assert.ok(!/capture=/.test(input), `${file}: ${input}`);
    }
}

console.log('test-receipts: all assertions passed');
