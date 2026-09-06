// Dumps every row of `expenses` to backups/expenses-<ISO timestamp>.json.
// This is the only undo for the category migration - run it before any write.
//
//   node scripts/backup.js
const fs = require('fs');
const path = require('path');
const { db, toRows } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

async function main() {
    const result = await db.execute('SELECT * FROM expenses ORDER BY id');
    const rows = toRows(result);

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `expenses-${stamp}.json`);

    const payload = {
        taken_at: new Date().toISOString(),
        table: 'expenses',
        columns: result.columns,
        row_count: rows.length,
        rows
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));

    // Read it straight back: a backup that will not parse is not a backup.
    const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (reread.rows.length !== rows.length) {
        throw new Error(`Verify failed: wrote ${rows.length} rows, read back ${reread.rows.length}`);
    }

    const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
    console.log(`Backed up ${rows.length} rows to ${path.relative(process.cwd(), file)}`);
    console.log(`  columns: ${result.columns.join(', ')}`);
    console.log(`  amount sum: ${sum.toFixed(2)}`);
    console.log(`  verified: file parses and row count matches`);
}

main().catch(err => { console.error(err); process.exit(1); });
