require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const { AwsClient } = require('aws4fetch');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { CATEGORIES, INVESTMENT_KINDS, RETIREMENT_KINDS, goalPeriod } = require('./public/categories.js');

const app = express();
const PORT = process.env.PORT || 3000;

const APP_PASSWORD = process.env.APP_PASSWORD;
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!APP_PASSWORD || !TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    console.error('Missing required environment variables: APP_PASSWORD, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN');
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
}

const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// Receipt photos live in a Cloudflare R2 bucket, reached through its S3 API.
// Optional: without these the rest of the app runs and the receipt routes
// answer 503. R2_ENDPOINT points at another S3-compatible store instead, for
// trying receipts out locally.
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const r2 = R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    && (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID)
    ? new AwsClient({
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        service: 's3',
        region: 'auto'
    })
    : null;

// Runs once on cold start; every handler awaits this before touching the DB
const initPromise = (async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        is_positive INTEGER DEFAULT 0,
        expense_date TEXT NOT NULL,
        category TEXT NOT NULL,
        what TEXT NOT NULL,
        notes TEXT,
        merchant TEXT,
        event TEXT,
        is_taxable INTEGER DEFAULT 0,
        submission_date TEXT DEFAULT CURRENT_TIMESTAMP,
        version INTEGER DEFAULT 1
    )`);
    try { await db.execute('ALTER TABLE expenses ADD COLUMN event TEXT'); } catch (_) {}
    try { await db.execute('ALTER TABLE expenses ADD COLUMN version INTEGER DEFAULT 1'); } catch (_) {}
    // `notes` used to hold merchant, event and description all at once. It is
    // kept, unwritten, as the in-place backup for the v3 split.
    try { await db.execute('ALTER TABLE expenses ADD COLUMN merchant TEXT'); } catch (_) {}

    await db.execute(`CREATE TABLE IF NOT EXISTS budget_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL UNIQUE,
        amount REAL NOT NULL,
        period TEXT NOT NULL DEFAULT 'monthly',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // A monthly group's budget set by hand for one month - "$500 on clothes
    // this October". Every other monthly group fits around it on the budget
    // page. No row means the worked-out budget.
    await db.execute(`CREATE TABLE IF NOT EXISTS budget_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        month TEXT NOT NULL,
        amount REAL NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (category, month)
    )`);

    // `total` is what was originally owed and `paid` is how much of it has been
    // cleared, so remaining is total - paid. Storing the running total rather
    // than a row per payment keeps this to one table; `as_of` is the date the
    // balance is current as of, moved by every payoff.
    await db.execute(`CREATE TABLE IF NOT EXISTS debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        total REAL NOT NULL,
        paid REAL NOT NULL DEFAULT 0,
        notes TEXT,
        as_of TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // A named recurring cost inside a category - Phone and Internet inside
    // Bills & Insurance. `amount` is per `frequency`. `due_day` is the day of the
    // month it falls due, and a yearly one also has `due_month`; both are null
    // when it has no due date.
    await db.execute(`CREATE TABLE IF NOT EXISTS fixed_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        amount REAL NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'monthly',
        due_day INTEGER,
        due_month INTEGER,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // One row per credit card, its figures as of the last edit. `balance` is
    // what is owed now and `balance_as_of` the day it was read. `apr` is a
    // percentage (24.99), null when not known. `fee_renewal` is a date the
    // annual fee posts on; the page rolls it forward a year at a time once it
    // has passed.
    await db.execute(`CREATE TABLE IF NOT EXISTS credit_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        balance_as_of TEXT,
        apr REAL,
        annual_fee REAL NOT NULL DEFAULT 0,
        fee_renewal TEXT,
        notes TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // An investment account is only tracked: `balance` is what it is worth and
    // `contribution` what goes into it each month. `kind` is one of
    // INVESTMENT_KINDS.
    await db.execute(`CREATE TABLE IF NOT EXISTS investment_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'Brokerage',
        balance REAL NOT NULL DEFAULT 0,
        balance_as_of TEXT,
        contribution REAL NOT NULL DEFAULT 0,
        notes TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // A retirement account is the same, plus the rate it is expected to grow
    // at: `annual_return` is a percentage (7 for 7%), null when not set, and
    // the page compounds it monthly to project the balance forward.
    await db.execute(`CREATE TABLE IF NOT EXISTS retirement_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT '401(k)',
        balance REAL NOT NULL DEFAULT 0,
        balance_as_of TEXT,
        annual_return REAL,
        contribution REAL NOT NULL DEFAULT 0,
        notes TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // A savings goal: `target` by `target_date`, with `saved` put by so far.
    // The monthly amount needed is worked out on the Goals page rather than
    // stored, so it follows the date closing in.
    await db.execute(`CREATE TABLE IF NOT EXISTS savings_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        target REAL NOT NULL,
        target_date TEXT NOT NULL,
        saved REAL NOT NULL DEFAULT 0,
        notes TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // A photo of a receipt, kept against one expense. It is two objects in R2:
    // the original exactly as uploaded, which is the proof, and a JPEG copy
    // `view_key` for looking at. `sha256` is of the original as R2 holds it,
    // worked out by the server, so it vouches for the stored file rather than
    // for what the browser said it sent. The same photo can go on two
    // expenses - one receipt split across two categories.
    await db.execute(`CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        original_key TEXT NOT NULL,
        view_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime TEXT,
        bytes INTEGER,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (expense_id, sha256)
    )`);
})();

// Convert libsql Row objects to plain JS objects for JSON serialization
function toRows(result) {
    return result.rows.map(row =>
        Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
    );
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
    if (req.headers.authorization === `Bearer ${APP_PASSWORD}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Login
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
        res.json({ success: true, token: APP_PASSWORD });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

// Get all expenses
app.get('/api/expenses', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute(`SELECT e.*,
            (SELECT COUNT(*) FROM receipts r WHERE r.expense_id = e.id) AS receipt_count
            FROM expenses e ORDER BY e.id DESC`);
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add expense
app.post('/api/expenses', requireAuth, async (req, res) => {
    await initPromise;
    const { amount, is_positive, expense_date, category, what, notes, merchant, event, is_taxable } = req.body;
    if (!amount || !expense_date || !category || !what) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const finalAmount = is_positive ? Math.abs(amount) : -Math.abs(amount);
    const currentTimestamp = new Date().toISOString();
    // New rows write `merchant`, never `notes`. `notes` is accepted as a
    // fallback so a CSV with the old header still lands somewhere sensible.
    const finalMerchant = (merchant || notes || '').trim();
    try {
        const result = await db.execute({
            sql: 'INSERT INTO expenses (amount, is_positive, expense_date, category, what, merchant, event, is_taxable, submission_date, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [finalAmount, is_positive ? 1 : 0, expense_date, category, what, finalMerchant, event || '', is_taxable ? 1 : 0, currentTimestamp, 2]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Expense added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Autocomplete: what
app.get('/api/autocomplete/what', requireAuth, async (req, res) => {
    await initPromise;
    const query = req.query.q || '';
    try {
        const result = await db.execute({
            sql: 'SELECT what, COUNT(*) as count FROM expenses WHERE what LIKE ? GROUP BY what ORDER BY count DESC LIMIT 10',
            args: [`%${query}%`]
        });
        res.json(toRows(result).map(r => r.what));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Autocomplete: merchant (replaces the old notes autocomplete)
app.get('/api/autocomplete/merchant', requireAuth, async (req, res) => {
    await initPromise;
    const query = req.query.q || '';
    try {
        const result = await db.execute({
            sql: "SELECT merchant, COUNT(*) as count FROM expenses WHERE merchant LIKE ? AND IFNULL(merchant, '') != '' GROUP BY merchant ORDER BY count DESC LIMIT 10",
            args: [`%${query}%`]
        });
        res.json(toRows(result).map(r => r.merchant));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Autocomplete: event
app.get('/api/autocomplete/event', requireAuth, async (req, res) => {
    await initPromise;
    const query = req.query.q || '';
    try {
        const result = await db.execute({
            sql: "SELECT event, COUNT(*) as count FROM expenses WHERE event LIKE ? AND event != '' GROUP BY event ORDER BY count DESC LIMIT 10",
            args: [`%${query}%`]
        });
        res.json(toRows(result).map(r => r.event));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The merchants most often used in a category, for the tappable chips on the
// entry form. Replaces the old notes-by-what suggestions.
app.get('/api/merchants-by-category', requireAuth, async (req, res) => {
    await initPromise;
    const category = req.query.category || '';
    if (!category) return res.json([]);
    try {
        const result = await db.execute({
            sql: "SELECT merchant, COUNT(*) as count FROM expenses WHERE category = ? AND IFNULL(merchant, '') != '' GROUP BY merchant ORDER BY count DESC LIMIT 6",
            args: [category]
        });
        res.json(toRows(result).map(r => r.merchant));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Budget goals
app.get('/api/budget-goals', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM budget_goals ORDER BY category');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upsert one goal: a yearly goal, or one of the plan's reserved rows.
app.put('/api/budget-goals', requireAuth, async (req, res) => {
    await initPromise;
    const { category, amount, period } = req.body;
    if (!category || amount === undefined || amount === null || isNaN(Number(amount))) {
        return res.status(400).json({ error: 'category and a numeric amount are required' });
    }
    try {
        await db.execute({
            sql: `INSERT INTO budget_goals (category, amount, period, updated_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(category) DO UPDATE SET
                      amount = excluded.amount,
                      period = excluded.period,
                      updated_at = excluded.updated_at`,
            args: [category, Number(amount), period === 'yearly' ? 'yearly' : 'monthly', new Date().toISOString()]
        });
        res.json({ message: 'Budget goal saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Budget targets
//
// Only a monthly group takes a target; a yearly goal is already typed by hand.
function targetKey({ category, month }) {
    if (!CATEGORIES.includes(category) || goalPeriod(category) === 'yearly') {
        return { error: 'category must be one of the monthly expense categories' };
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return { error: 'month must be YYYY-MM' };
    return { args: [category, month] };
}

app.get('/api/budget-targets', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM budget_targets ORDER BY month, category');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/budget-targets', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = targetKey(req.body);
    if (error) return res.status(400).json({ error });
    const amount = req.body.amount;
    if (isBlank(amount) || !(Number(amount) >= 0)) return res.status(400).json({ error: 'amount must be 0 or more' });
    try {
        await db.execute({
            sql: `INSERT INTO budget_targets (category, month, amount, updated_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(category, month) DO UPDATE SET
                      amount = excluded.amount,
                      updated_at = excluded.updated_at`,
            args: [...args, Number(amount), new Date().toISOString()]
        });
        res.json({ message: 'Target saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clearing a target that is not there is not an error: either way there is
// none afterwards.
app.delete('/api/budget-targets', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = targetKey(req.query);
    if (error) return res.status(400).json({ error });
    try {
        await db.execute({ sql: 'DELETE FROM budget_targets WHERE category = ? AND month = ?', args });
        res.json({ message: 'Target cleared' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debts
//
// UTC, but only ever a fallback: the page sends the date it means. A payoff
// entered on the last evening of a month would otherwise land in the next one.
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

// Shared validation for the create and update routes, which take the same body.
// Returns { error } or the argument list in column order.
function debtFields({ name, total, paid, notes, as_of }) {
    const cleanName = (name || '').trim();
    if (!cleanName) return { error: 'name is required' };
    if (total === undefined || total === null || isNaN(Number(total)) || Number(total) <= 0) {
        return { error: 'total must be a positive number' };
    }
    const paidAmount = paid === undefined || paid === null || paid === '' ? 0 : Number(paid);
    if (isNaN(paidAmount) || paidAmount < 0) return { error: 'paid must be 0 or more' };
    return { args: [cleanName, Number(total), Math.min(paidAmount, Number(total)), (notes || '').trim(), as_of || todayISO()] };
}

app.get('/api/debts', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM debts ORDER BY id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/debts', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = debtFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO debts (name, total, paid, notes, as_of, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Debt added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/debts/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = debtFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE debts SET name = ?, total = ?, paid = ?, notes = ?, as_of = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Debt not found' });
        res.json({ message: 'Debt saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// A payoff adds to what has been cleared and moves the as-of date to the day of
// the payment. Added in the statement itself rather than read-then-write, and
// capped at the total so an overpayment cannot drive the remaining balance
// below zero.
app.post('/api/debts/:id/payoff', requireAuth, async (req, res) => {
    await initPromise;
    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'a positive amount is required' });
    }
    try {
        const result = await db.execute({
            sql: 'UPDATE debts SET paid = MIN(total, paid + ?), as_of = ?, updated_at = ? WHERE id = ?',
            args: [amount, req.body.date || todayISO(), new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Debt not found' });
        res.json({ message: 'Payoff recorded' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/debts/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM debts WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Debt not found' });
        res.json({ message: 'Debt deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fixed expenses
//
// Shared validation for the create and update routes, as with debts. A
// category outside the list would never be shown on the budget page, so it
// is refused rather than stored out of sight.
function isBlank(value) {
    return value === undefined || value === null || value === '';
}

function fixedExpenseFields({ category, name, amount, frequency, due_day, due_month }) {
    if (!CATEGORIES.includes(category)) return { error: 'category must be one of the expense categories' };
    const cleanName = (name || '').trim();
    if (!cleanName) return { error: 'name is required' };
    if (isBlank(amount) || isNaN(Number(amount)) || Number(amount) <= 0) {
        return { error: 'amount must be a positive number' };
    }
    const period = frequency === 'yearly' ? 'yearly' : 'monthly';
    const day = isBlank(due_day) ? null : Number(due_day);
    if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 31)) {
        return { error: 'due_day must be a day of the month, 1-31' };
    }
    // Only a yearly expense with a due date has a month to be due in.
    const month = period === 'yearly' && day !== null ? Number(due_month) : null;
    if (month !== null && !(Number.isInteger(month) && month >= 1 && month <= 12)) {
        return { error: 'a yearly due date needs due_month, 1-12' };
    }
    return { args: [category, cleanName, Number(amount), period, day, month] };
}

app.get('/api/fixed-expenses', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM fixed_expenses ORDER BY category, id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/fixed-expenses', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = fixedExpenseFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO fixed_expenses (category, name, amount, frequency, due_day, due_month, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Fixed expense added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/fixed-expenses/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = fixedExpenseFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE fixed_expenses SET category = ?, name = ?, amount = ?, frequency = ?, due_day = ?, due_month = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Fixed expense not found' });
        res.json({ message: 'Fixed expense saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/fixed-expenses/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM fixed_expenses WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Fixed expense not found' });
        res.json({ message: 'Fixed expense deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Credit cards
//
// Shared validation for the create and update routes, as with debts. A
// balance may be below zero - a card in credit after a refund.
// Round-tripped rather than just parsed: Date.parse('2026-02-30') is happily
// 2 March.
function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !isNaN(parsed) && parsed.toISOString().slice(0, 10) === value;
}

function cardFields({ name, balance, balance_as_of, apr, annual_fee, fee_renewal, notes }) {
    const cleanName = (name || '').trim();
    if (!cleanName) return { error: 'name is required' };
    const owed = isBlank(balance) ? 0 : Number(balance);
    if (!Number.isFinite(owed)) return { error: 'balance must be a number' };
    const rate = isBlank(apr) ? null : Number(apr);
    if (rate !== null && !(rate >= 0 && rate <= 100)) return { error: 'apr must be a percentage, 0-100' };
    const fee = isBlank(annual_fee) ? 0 : Number(annual_fee);
    if (!(fee >= 0)) return { error: 'annual_fee must be 0 or more' };
    const renewal = isBlank(fee_renewal) ? null : fee_renewal;
    if (renewal !== null && !isDate(renewal)) return { error: 'fee_renewal must be a YYYY-MM-DD date' };
    const asOf = isBlank(balance_as_of) ? todayISO() : balance_as_of;
    if (!isDate(asOf)) return { error: 'balance_as_of must be a YYYY-MM-DD date' };
    return { args: [cleanName, owed, asOf, rate, fee, renewal, (notes || '').trim()] };
}

app.get('/api/credit-cards', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM credit_cards ORDER BY id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/credit-cards', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = cardFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO credit_cards (name, balance, balance_as_of, apr, annual_fee, fee_renewal, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Card added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/credit-cards/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = cardFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE credit_cards SET name = ?, balance = ?, balance_as_of = ?, apr = ?, annual_fee = ?, fee_renewal = ?, notes = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Card not found' });
        res.json({ message: 'Card saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/credit-cards/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM credit_cards WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Card not found' });
        res.json({ message: 'Card deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Investment and retirement accounts
//
// Both take the same fields bar the rate of return, so one validation function
// serves both and the retirement one adds to it. `kind` is checked against the
// list the selects are filled from, so a kind that could never be chosen again
// is refused rather than stored out of sight.
function accountFields({ name, kind, balance, balance_as_of, contribution, notes }, kinds) {
    const cleanName = (name || '').trim();
    if (!cleanName) return { error: 'name is required' };
    if (!kinds.includes(kind)) return { error: `kind must be one of: ${kinds.join(', ')}` };
    const worth = isBlank(balance) ? 0 : Number(balance);
    if (!(worth >= 0)) return { error: 'balance must be 0 or more' };
    const monthly = isBlank(contribution) ? 0 : Number(contribution);
    if (!(monthly >= 0)) return { error: 'contribution must be 0 or more' };
    const asOf = isBlank(balance_as_of) ? todayISO() : balance_as_of;
    if (!isDate(asOf)) return { error: 'balance_as_of must be a YYYY-MM-DD date' };
    return { args: [cleanName, kind, worth, asOf, monthly, (notes || '').trim()] };
}

function investmentFields(body) {
    return accountFields(body, INVESTMENT_KINDS);
}

// A negative return is allowed: a pessimistic projection is still a projection.
function retirementFields(body) {
    const base = accountFields(body, RETIREMENT_KINDS);
    if (base.error) return base;
    const [name, kind, worth, asOf, monthly, notes] = base.args;
    const rate = isBlank(body.annual_return) ? null : Number(body.annual_return);
    if (rate !== null && !(rate >= -100 && rate <= 100)) {
        return { error: 'annual_return must be a percentage, -100-100' };
    }
    return { args: [name, kind, worth, asOf, rate, monthly, notes] };
}

app.get('/api/investment-accounts', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM investment_accounts ORDER BY id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/investment-accounts', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = investmentFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO investment_accounts (name, kind, balance, balance_as_of, contribution, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Investment account added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/investment-accounts/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = investmentFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE investment_accounts SET name = ?, kind = ?, balance = ?, balance_as_of = ?, contribution = ?, notes = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Investment account not found' });
        res.json({ message: 'Investment account saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/investment-accounts/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM investment_accounts WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Investment account not found' });
        res.json({ message: 'Investment account deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/retirement-accounts', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM retirement_accounts ORDER BY id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/retirement-accounts', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = retirementFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO retirement_accounts (name, kind, balance, balance_as_of, annual_return, contribution, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Retirement account added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/retirement-accounts/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = retirementFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE retirement_accounts SET name = ?, kind = ?, balance = ?, balance_as_of = ?, annual_return = ?, contribution = ?, notes = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Retirement account not found' });
        res.json({ message: 'Retirement account saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/retirement-accounts/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM retirement_accounts WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Retirement account not found' });
        res.json({ message: 'Retirement account deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Savings goals
//
// Shared validation for the create and update routes, as with debts. `saved` is
// capped at the target: a goal cannot be more than met.
function goalFields({ name, target, target_date, saved, notes }) {
    const cleanName = (name || '').trim();
    if (!cleanName) return { error: 'name is required' };
    if (isBlank(target) || isNaN(Number(target)) || Number(target) <= 0) {
        return { error: 'target must be a positive number' };
    }
    if (!isDate(target_date)) return { error: 'target_date must be a YYYY-MM-DD date' };
    const put_by = isBlank(saved) ? 0 : Number(saved);
    if (!(put_by >= 0)) return { error: 'saved must be 0 or more' };
    return { args: [cleanName, Number(target), target_date, Math.min(put_by, Number(target)), (notes || '').trim()] };
}

app.get('/api/savings-goals', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute('SELECT * FROM savings_goals ORDER BY target_date, id');
        res.json(toRows(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/savings-goals', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = goalFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'INSERT INTO savings_goals (name, target, target_date, saved, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            args: [...args, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Goal added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/savings-goals/:id', requireAuth, async (req, res) => {
    await initPromise;
    const { error, args } = goalFields(req.body);
    if (error) return res.status(400).json({ error });
    try {
        const result = await db.execute({
            sql: 'UPDATE savings_goals SET name = ?, target = ?, target_date = ?, saved = ?, notes = ?, updated_at = ? WHERE id = ?',
            args: [...args, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Goal not found' });
        res.json({ message: 'Goal saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Putting money by adds to what is saved and is capped at the target, as a debt
// payoff is capped at its total.
app.post('/api/savings-goals/:id/save', requireAuth, async (req, res) => {
    await initPromise;
    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'a positive amount is required' });
    }
    try {
        const result = await db.execute({
            sql: 'UPDATE savings_goals SET saved = MIN(target, saved + ?), updated_at = ? WHERE id = ?',
            args: [amount, new Date().toISOString(), req.params.id]
        });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Goal not found' });
        res.json({ message: 'Saving recorded' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/savings-goals/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'DELETE FROM savings_goals WHERE id = ?', args: [req.params.id] });
        if (!result.rowsAffected) return res.status(404).json({ error: 'Goal not found' });
        res.json({ message: 'Goal deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Receipts
//
// The browser uploads straight to R2 through short-lived signed URLs, which
// keeps photos out of the Vercel function and its 4.5 MB request limit, then
// asks for the upload to be recorded. Nothing is recorded that is not in the
// bucket. The bucket stays private: the page is handed signed URLs to look at
// a receipt, since an <img> cannot send the login token.
const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;
// receipts/<expense id>/<uuid>.<ext>, the only shape of key the upload route
// hands out.
const RECEIPT_KEY = /^receipts\/(\d+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/;
// The types a phone or a screenshot hands over, and the extension each is
// stored under.
const RECEIPT_EXTENSIONS = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic',
    'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif'
};

function requireR2(req, res, next) {
    if (r2) next();
    else res.status(503).json({ error: 'Receipt storage is not set up' });
}

function r2Url(key) {
    return `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
}

async function r2Signed(key, method, seconds) {
    const url = new URL(r2Url(key));
    url.searchParams.set('X-Amz-Expires', String(seconds));
    return (await r2.sign(url, { method, aws: { signQuery: true } })).url;
}

// The copy sits beside its original: <uuid>-view.jpg next to <uuid>.heic.
function receiptViewKey(originalKey) {
    return originalKey.replace(/\.[a-z]+$/, '-view.jpg');
}

// Deleting a key that is already gone succeeds, so a delete that failed half
// way can simply be tried again.
async function removeReceiptObjects(keys) {
    for (const key of keys) {
        const response = await r2.fetch(r2Url(key), { method: 'DELETE' });
        if (!response.ok && response.status !== 404) throw new Error(`Receipt storage answered ${response.status}`);
    }
}

async function expenseExists(id) {
    const result = await db.execute({ sql: 'SELECT 1 FROM expenses WHERE id = ?', args: [id] });
    return result.rows.length > 0;
}

function receiptUploadFields({ mime }) {
    const extension = RECEIPT_EXTENSIONS[String(mime || '').toLowerCase()];
    if (!extension) return { error: 'Not a photo' };
    return { args: [extension] };
}

app.post('/api/expenses/:id/receipts/upload', requireAuth, requireR2, async (req, res) => {
    await initPromise;
    const { error, args } = receiptUploadFields(req.body);
    if (error) return res.status(400).json({ error });
    const expenseId = Number(req.params.id);
    try {
        if (!Number.isInteger(expenseId) || !(await expenseExists(expenseId))) {
            return res.status(404).json({ error: 'Expense not found' });
        }
        const key = `receipts/${expenseId}/${crypto.randomUUID()}.${args[0]}`;
        res.json({
            key,
            original_url: await r2Signed(key, 'PUT', 600),
            view_url: await r2Signed(receiptViewKey(key), 'PUT', 600)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Records an upload once both files are in the bucket. The original is read
// back to hash it. A photo already on this expense is not stored twice: the
// new copy is removed and the one there kept.
app.post('/api/expenses/:id/receipts', requireAuth, requireR2, async (req, res) => {
    await initPromise;
    const key = String(req.body.key || '');
    const expenseId = Number(req.params.id);
    const match = RECEIPT_KEY.exec(key);
    if (!match || Number(match[1]) !== expenseId) {
        return res.status(400).json({ error: 'key is not an upload for this expense' });
    }
    const viewKey = receiptViewKey(key);
    try {
        if (!(await expenseExists(expenseId))) {
            await removeReceiptObjects([key, viewKey]);
            return res.status(404).json({ error: 'Expense not found' });
        }
        const original = await r2.fetch(r2Url(key));
        if (original.status === 404) {
            await removeReceiptObjects([viewKey]);
            return res.status(400).json({ error: 'Photo did not upload' });
        }
        if (!original.ok) throw new Error(`Receipt storage answered ${original.status}`);
        const bytes = Buffer.from(await original.arrayBuffer());
        const view = await r2.fetch(r2Url(viewKey), { method: 'HEAD' });
        if (!view.ok) {
            await removeReceiptObjects([key, viewKey]);
            return res.status(400).json({ error: 'Photo did not upload' });
        }
        if (bytes.length > RECEIPT_MAX_BYTES) {
            await removeReceiptObjects([key, viewKey]);
            return res.status(400).json({ error: 'Photo is over 25 MB' });
        }
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const existing = await db.execute({
            sql: 'SELECT id FROM receipts WHERE expense_id = ? AND sha256 = ?',
            args: [expenseId, sha256]
        });
        if (existing.rows.length) {
            await removeReceiptObjects([key, viewKey]);
            return res.json({ id: Number(toRows(existing)[0].id), message: 'Receipt already attached' });
        }
        const result = await db.execute({
            sql: 'INSERT INTO receipts (expense_id, original_key, view_key, sha256, mime, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [expenseId, key, viewKey, sha256, original.headers.get('content-type') || '', bytes.length, new Date().toISOString()]
        });
        res.json({ id: Number(result.lastInsertRowid), message: 'Receipt saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// An expense's receipts, oldest first, each with signed URLs good for an hour.
app.get('/api/expenses/:id/receipts', requireAuth, requireR2, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({
            sql: 'SELECT id, expense_id, original_key, view_key, sha256, mime, bytes, uploaded_at FROM receipts WHERE expense_id = ? ORDER BY id',
            args: [req.params.id]
        });
        const receipts = await Promise.all(toRows(result).map(async receipt => ({
            ...receipt,
            original_url: await r2Signed(receipt.original_key, 'GET', 3600),
            view_url: await r2Signed(receipt.view_key, 'GET', 3600)
        })));
        res.json(receipts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Files first, then the row: if the files cannot be removed, the row stays to
// say they are there.
app.delete('/api/receipts/:id', requireAuth, requireR2, async (req, res) => {
    await initPromise;
    try {
        const result = await db.execute({ sql: 'SELECT original_key, view_key FROM receipts WHERE id = ?', args: [req.params.id] });
        if (!result.rows.length) return res.status(404).json({ error: 'Receipt not found' });
        const { original_key, view_key } = toRows(result)[0];
        await removeReceiptObjects([original_key, view_key]);
        await db.execute({ sql: 'DELETE FROM receipts WHERE id = ?', args: [req.params.id] });
        res.json({ message: 'Receipt deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete expense
//
// Its receipts go with it, files first, as above.
app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        const receipts = toRows(await db.execute({
            sql: 'SELECT original_key, view_key FROM receipts WHERE expense_id = ?',
            args: [req.params.id]
        }));
        if (receipts.length) {
            if (!r2) return res.status(503).json({ error: 'Receipt storage is not set up' });
            await removeReceiptObjects(receipts.flatMap(r => [r.original_key, r.view_key]));
            await db.execute({ sql: 'DELETE FROM receipts WHERE expense_id = ?', args: [req.params.id] });
        }
        await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [req.params.id] });
        res.json({ message: 'Expense deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The cards page became the accounts page; a phone shortcut saved to the old
// address still lands somewhere.
app.get('/cards.html', (req, res) => res.redirect(301, '/accounts.html'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
