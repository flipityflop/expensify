// One-time: brings budget_goals in line with how the budget page reads it.
//
//   node scripts/cleanup-budget-goals.js           # dry run - shows what would change, writes nothing
//   node scripts/cleanup-budget-goals.js --apply   # backs the table up to backups/, then changes it
//
// The page reads only the yearly goals and the plan's three rows (__income__,
// __debt_payment__, __savings__). This:
//   - renames the income row from __spending_budget__ to __income__ (if an
//     __income__ row exists already, that one is kept and the old one deleted)
//   - deletes every other row
//   - drops the `fixed` column
//
// All in one batch, so a failure leaves the table as it was. Delete this file
// once it has been run.
const fs = require('fs');
const path = require('path');
const { db, toRows } = require('./db');
const { YEARLY_CATEGORIES } = require('../public/categories');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const OLD_INCOME = '__spending_budget__';
const PLAN_KEYS = ['__income__', '__debt_payment__', '__savings__'];
const KEEP = [...YEARLY_CATEGORIES, ...PLAN_KEYS];

async function main() {
    const apply = process.argv.includes('--apply');

    const rows = toRows(await db.execute('SELECT * FROM budget_goals ORDER BY category'));
    const columns = toRows(await db.execute('PRAGMA table_info(budget_goals)')).map(c => c.name);
    const hasIncome = rows.some(r => r.category === '__income__');
    const oldIncome = rows.find(r => r.category === OLD_INCOME);
    const drop = rows.filter(r => !KEEP.includes(r.category) && !(r.category === OLD_INCOME && !hasIncome));
    const dropColumn = columns.includes('fixed');

    const statements = [];
    if (oldIncome && !hasIncome) {
        console.log(`Rename ${OLD_INCOME} -> __income__ (${oldIncome.amount})`);
        statements.push({ sql: "UPDATE budget_goals SET category = '__income__' WHERE category = ?", args: [OLD_INCOME] });
    }
    if (drop.length) {
        console.log(`Delete ${drop.length} row(s):`);
        drop.forEach(r => console.log(`  ${r.category}: ${r.amount}`));
        statements.push({ sql: `DELETE FROM budget_goals WHERE category IN (${drop.map(() => '?').join(', ')})`, args: drop.map(r => r.category) });
    }
    if (dropColumn) {
        console.log('Drop column fixed');
        statements.push('ALTER TABLE budget_goals DROP COLUMN fixed');
    }

    const kept = rows.filter(r => !drop.includes(r));
    console.log(`Keep ${kept.length} row(s): ${kept.map(r => r.category === OLD_INCOME ? '__income__' : r.category).join(', ') || '(none)'}`);

    if (!statements.length) {
        console.log('\nNothing to change.');
        return;
    }
    if (!apply) {
        console.log('\nDRY RUN - nothing written. Re-run with --apply once the above looks right.');
        return;
    }

    // The only undo: the table exactly as it was.
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `budget-goals-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ taken_at: new Date().toISOString(), table: 'budget_goals', columns, rows }, null, 2));
    if (JSON.parse(fs.readFileSync(file, 'utf8')).rows.length !== rows.length) {
        throw new Error(`Backup verify failed for ${file}. Nothing was written.`);
    }
    console.log(`\nBacked up ${rows.length} row(s) to ${path.relative(process.cwd(), file)}`);

    await db.batch(statements, 'write');

    // Read back rather than trust the batch.
    const after = toRows(await db.execute('SELECT category FROM budget_goals')).map(r => r.category);
    const afterColumns = toRows(await db.execute('PRAGMA table_info(budget_goals)')).map(c => c.name);
    const stray = after.filter(c => !KEEP.includes(c));
    if (stray.length || afterColumns.includes('fixed')) {
        throw new Error(`Not clean afterwards: rows ${stray.join(', ') || 'none'}, columns ${afterColumns.join(', ')}`);
    }
    console.log(`Done. budget_goals now holds ${after.length} row(s): ${after.join(', ')}`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
