// One-time migration script: copies local SQLite data to Turso.
// Run BEFORE deploying to Vercel:
//   node migrate-to-turso.js
// (Requires .env to be set up with TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)

require('dotenv').config();
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');
const path = require('path');

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your .env file first.');
    process.exit(1);
}

async function migrate() {
    const localDb = new Database(path.join(__dirname, 'database', 'expenses.db'), { readonly: true });
    const turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

    console.log('Setting up schema in Turso...');
    await turso.execute(`CREATE TABLE IF NOT EXISTS expenses (
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

    const rows = localDb.prepare('SELECT * FROM expenses ORDER BY id ASC').all();
    console.log(`Found ${rows.length} expenses to migrate...`);

    if (rows.length === 0) {
        console.log('Nothing to migrate.');
        localDb.close();
        return;
    }

    // Batch in chunks of 100 to stay well within Turso request limits
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const statements = chunk.map(row => ({
            sql: `INSERT OR REPLACE INTO expenses
                  (id, amount, is_positive, expense_date, category, what, notes, event, is_taxable, submission_date, version)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                row.id,
                row.amount,
                row.is_positive,
                row.expense_date,
                row.category,
                row.what,
                row.notes || '',
                row.event || '',
                row.is_taxable,
                row.submission_date,
                row.version ?? 1
            ]
        }));
        await turso.batch(statements, 'write');
        console.log(`  Migrated ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
    }

    console.log('Migration complete!');
    localDb.close();
}

migrate().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
