// Restores rows from a backup file produced by scripts/backup.js.
// Every row is written back by its own id, so a partial restore is safe to
// re-run. Dry-run by default; --apply is required to touch the database.
//
//   node scripts/restore.js                          # dry run, newest backup
//   node scripts/restore.js --file=backups/x.json    # dry run, specific file
//   node scripts/restore.js --apply                  # write to `expenses`
//   node scripts/restore.js --apply --table=scratch  # write elsewhere (testing)
const fs = require('fs');
const path = require('path');
const { db, toRows } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const CHUNK = 100;

function arg(name) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
}

function newestBackup() {
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('expenses-') && f.endsWith('.json'))
        .sort();
    if (files.length === 0) throw new Error(`No backups found in ${BACKUP_DIR}`);
    return path.join(BACKUP_DIR, files[files.length - 1]);
}

async function main() {
    const apply = process.argv.includes('--apply');
    const table = arg('table') || 'expenses';
    const file = arg('file') ? path.resolve(arg('file')) : newestBackup();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Bad table name: ${table}`);

    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = backup.rows;
    const cols = backup.columns;
    console.log(`Backup:  ${path.relative(process.cwd(), file)}`);
    console.log(`  taken: ${backup.taken_at}`);
    console.log(`  rows:  ${rows.length}`);
    console.log(`Target:  ${table}`);

    const before = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`  currently holds ${toRows(before)[0].n} rows`);

    if (!apply) {
        console.log('\nDRY RUN - nothing written. Re-run with --apply to restore.');
        return;
    }

    // INSERT OR REPLACE keyed on the primary key: rows that still exist are
    // reverted in place, rows that were deleted come back with their old id.
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;

    let done = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK).map(r => ({
            sql,
            args: cols.map(c => (r[c] === undefined ? null : r[c]))
        }));
        await db.batch(batch, 'write');
        done += batch.length;
        process.stdout.write(`\r  restored ${done}/${rows.length}`);
    }
    console.log('');

    const after = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`Done. ${table} now holds ${toRows(after)[0].n} rows.`);
}

main().catch(err => { console.error(err); process.exit(1); });
