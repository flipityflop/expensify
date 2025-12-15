const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Read password from password.txt file
const passwordPath = path.join(__dirname, 'password.txt');
let APP_PASSWORD;
try {
    APP_PASSWORD = fs.readFileSync(passwordPath, 'utf8').trim();
    console.log('Password loaded from password.txt');
} catch (error) {
    console.error('Error reading password.txt:', error.message);
    console.error('Please ensure password.txt exists in the project root directory');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Simple authentication middleware
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${APP_PASSWORD}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Ensure database directory exists
const dbDir = path.join(__dirname, 'database');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Database setup
const dbPath = path.join(dbDir, 'expenses.db');
const db = new Database(dbPath);

// Initialize database
db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    is_positive INTEGER DEFAULT 0,
    expense_date TEXT NOT NULL,
    category TEXT NOT NULL,
    what TEXT NOT NULL,
    notes TEXT,
    event TEXT,
    is_taxable INTEGER DEFAULT 0,
    submission_date TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Add event column if it doesn't exist (for existing databases)
try {
    db.exec(`ALTER TABLE expenses ADD COLUMN event TEXT`);
} catch (e) {
    // Column already exists, ignore error
}

// API Routes

// Login endpoint
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    
    if (password === APP_PASSWORD) {
        res.json({ 
            success: true, 
            token: APP_PASSWORD // In production, use a proper JWT token
        });
    } else {
        res.status(401).json({ 
            success: false, 
            error: 'Invalid password' 
        });
    }
});

// Get all expenses (protected)
app.get('/api/expenses', requireAuth, (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add new expense (protected)
app.post('/api/expenses', requireAuth, (req, res) => {
    const { amount, is_positive, expense_date, category, what, notes, event, is_taxable } = req.body;

    if (!amount || !expense_date || !category || !what) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    const finalAmount = is_positive ? Math.abs(amount) : -Math.abs(amount);
    const currentTimestamp = new Date().toISOString();

    try {
        const stmt = db.prepare('INSERT INTO expenses (amount, is_positive, expense_date, category, what, notes, event, is_taxable, submission_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const info = stmt.run(finalAmount, is_positive ? 1 : 0, expense_date, category, what, notes || '', event || '', is_taxable ? 1 : 0, currentTimestamp);
        res.json({ id: info.lastInsertRowid, message: 'Expense added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get autocomplete suggestions for "what" field (protected)
app.get('/api/autocomplete/what', requireAuth, (req, res) => {
    const query = req.query.q || '';
    try {
        const rows = db.prepare(`
            SELECT what, COUNT(*) as count
            FROM expenses
            WHERE what LIKE ?
            GROUP BY what
            ORDER BY count DESC
            LIMIT 10
        `).all(`%${query}%`);
        res.json(rows.map(row => row.what));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get autocomplete suggestions for "notes" field (protected)
app.get('/api/autocomplete/notes', requireAuth, (req, res) => {
    const query = req.query.q || '';
    try {
        const rows = db.prepare(`
            SELECT notes, COUNT(*) as count
            FROM expenses
            WHERE notes LIKE ? AND notes != ''
            GROUP BY notes
            ORDER BY count DESC
            LIMIT 10
        `).all(`%${query}%`);
        res.json(rows.map(row => row.notes));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get autocomplete suggestions for "event" field (protected)
app.get('/api/autocomplete/event', requireAuth, (req, res) => {
    const query = req.query.q || '';
    try {
        const rows = db.prepare(`
            SELECT event, COUNT(*) as count
            FROM expenses
            WHERE event LIKE ? AND event != ''
            GROUP BY event
            ORDER BY count DESC
            LIMIT 10
        `).all(`%${query}%`);
        res.json(rows.map(row => row.event));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get suggested notes based on "what" field (protected)
app.get('/api/suggestions/notes-by-what', requireAuth, (req, res) => {
    const what = req.query.what || '';
    if (!what) {
        return res.json([]);
    }
    try {
        // Get most common notes for this "what" value, ordered by frequency
        const rows = db.prepare(`
            SELECT notes, COUNT(*) as count
            FROM expenses
            WHERE LOWER(what) = LOWER(?) AND notes != ''
            GROUP BY notes
            ORDER BY count DESC
            LIMIT 5
        `).all(what);
        res.json(rows.map(row => row.notes));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete expense (protected)
app.delete('/api/expenses/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    try {
        const stmt = db.prepare('DELETE FROM expenses WHERE id = ?');
        stmt.run(id);
        res.json({ message: 'Expense deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close();
    console.log('Database connection closed.');
    process.exit(0);
});
