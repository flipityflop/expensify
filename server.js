require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const path = require('path');

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
        event TEXT,
        is_taxable INTEGER DEFAULT 0,
        submission_date TEXT DEFAULT CURRENT_TIMESTAMP,
        version INTEGER DEFAULT 1
    )`);
    try { await db.execute('ALTER TABLE expenses ADD COLUMN event TEXT'); } catch (_) {}
    try { await db.execute('ALTER TABLE expenses ADD COLUMN version INTEGER DEFAULT 1'); } catch (_) {}
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
    const { amount, is_positive, expense_date, category, what, notes, event, is_taxable } = req.body;
    if (!amount || !expense_date || !category || !what) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const finalAmount = is_positive ? Math.abs(amount) : -Math.abs(amount);
    const currentTimestamp = new Date().toISOString();
    try {
        const result = await db.execute({
            sql: 'INSERT INTO expenses (amount, is_positive, expense_date, category, what, notes, event, is_taxable, submission_date, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [finalAmount, is_positive ? 1 : 0, expense_date, category, what, notes || '', event || '', is_taxable ? 1 : 0, currentTimestamp, 2]
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

// Autocomplete: notes
app.get('/api/autocomplete/notes', requireAuth, async (req, res) => {
    await initPromise;
    const query = req.query.q || '';
    try {
        const result = await db.execute({
            sql: "SELECT notes, COUNT(*) as count FROM expenses WHERE notes LIKE ? AND notes != '' GROUP BY notes ORDER BY count DESC LIMIT 10",
            args: [`%${query}%`]
        });
        res.json(toRows(result).map(r => r.notes));
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

// Suggestions: notes by what
app.get('/api/suggestions/notes-by-what', requireAuth, async (req, res) => {
    await initPromise;
    const what = req.query.what || '';
    if (!what) return res.json([]);
    try {
        const result = await db.execute({
            sql: "SELECT notes, COUNT(*) as count FROM expenses WHERE LOWER(what) = LOWER(?) AND notes != '' GROUP BY notes ORDER BY count DESC LIMIT 5",
            args: [what]
        });
        res.json(toRows(result).map(r => r.notes));
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
