require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const path = require('path');
const { CATEGORIES } = require('./public/categories.js');

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
        fixed INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    // Rent does not shrink because there is less to spend. A fixed goal is set
    // by hand and autofill works around it, never over it. Orthogonal to
    // `period` - a goal can be fixed and yearly.
    try { await db.execute('ALTER TABLE budget_goals ADD COLUMN fixed INTEGER DEFAULT 0'); } catch (_) {}

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
    // Bills & Insurance - so part of a category can be fixed without pinning
    // the whole of it. `amount` is per `frequency`. `due_day` is the day of the
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
        const result = await db.execute('SELECT * FROM expenses ORDER BY id DESC');
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

// Upsert one goal. There is no other update route in this app - if you add one,
// this is the shape to copy.
app.put('/api/budget-goals', requireAuth, async (req, res) => {
    await initPromise;
    const { category, amount, period, fixed } = req.body;
    if (!category || amount === undefined || amount === null || isNaN(Number(amount))) {
        return res.status(400).json({ error: 'category and a numeric amount are required' });
    }
    try {
        await db.execute({
            sql: `INSERT INTO budget_goals (category, amount, period, fixed, updated_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(category) DO UPDATE SET
                      amount = excluded.amount,
                      period = excluded.period,
                      fixed = excluded.fixed,
                      updated_at = excluded.updated_at`,
            args: [category, Number(amount), period === 'yearly' ? 'yearly' : 'monthly', fixed ? 1 : 0, new Date().toISOString()]
        });
        res.json({ message: 'Budget goal saved' });
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

// Delete expense
app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
    await initPromise;
    try {
        await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [req.params.id] });
        res.json({ message: 'Expense deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
