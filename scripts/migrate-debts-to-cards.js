// One-time: moves credit cards that were entered in the debt tracker, before
// the Cards tab existed, over to `credit_cards`, and removes them from `debts`.
//
//   node scripts/migrate-debts-to-cards.js                  # lists every debt; * marks names that look like cards
//   node scripts/migrate-debts-to-cards.js 2 4 5 7          # dry run - shows what those debts become, writes nothing
//   node scripts/migrate-debts-to-cards.js 2 4 5 7 --apply  # backs them up to backups/, then moves them
//
// Nothing moves unless its id is passed; the * is only a hint.
//
// A debt becomes a card with:
//   balance        what was still owed: total - paid, never below 0
//   balance_as_of  the debt's as-of date
//   notes          the debt's notes
// APR, annual fee and renewal date are not in the debt tracker, so they start
// empty - fill them in on the Cards page. The debt's original total and
// paid-off amount have no place on a card; they are kept in the backup file.
//
// Every insert and delete runs in one batch, so a failure leaves both tables
// as they were. Refuses to run if a card with the same name already exists,
// rather than doubling it. Delete this file once it has been run.
const fs = require('fs');
const path = require('path');
const { db, toRows } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

const LOOKS_LIKE_CARD = /card|credit|visa|master|amex|american express|discover|chase|citi|capital one|barclay|sapphire|freedom|venture|quicksilver|synchrony|wells fargo|bank of america|\bboa\b/i;

function money(n) {
    return `$${Number(n).toFixed(2)}`;
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Rounded to the cent: 1000.1 - 200.05 is 800.0500000000001.
function toCard(debt) {
    return {
        name: debt.name,
        balance: Math.max(0, Math.round((debt.total - debt.paid) * 100) / 100),
        balance_as_of: debt.as_of || today(),
        notes: debt.notes || ''
    };
}

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const rest = argv.filter(a => a !== '--apply');
    const bad = rest.filter(a => !/^\d+$/.test(a));
    if (bad.length) throw new Error(`Unknown argument(s): ${bad.join(' ')}. Pass debt ids, and --apply to write.`);
    return { apply, ids: [...new Set(rest.map(Number))] };
}

async function main() {
    const { apply, ids } = parseArgs(process.argv.slice(2));

    const tables = toRows(await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('debts', 'credit_cards')"
    )).map(r => r.name);
    if (!tables.includes('debts')) throw new Error('No debts table, so nothing to move.');
    if (!tables.includes('credit_cards')) {
        throw new Error('No credit_cards table yet. Open the Cards page once so the server creates it, then run this again.');
    }

    const debts = toRows(await db.execute('SELECT * FROM debts ORDER BY id'));

    if (!ids.length) {
        console.log('Debts (* = looks like a card):');
        for (const d of debts) {
            const mark = LOOKS_LIKE_CARD.test(d.name) ? '*' : ' ';
            console.log(`  ${mark} ${String(d.id).padStart(3)}  ${d.name} - ${money(toCard(d).balance)} left of ${money(d.total)}`);
        }
        if (!debts.length) console.log('  (none)');
        const likely = debts.filter(d => LOOKS_LIKE_CARD.test(d.name)).map(d => d.id);
        console.log(likely.length
            ? `\nTo see what the starred ones would become:\n  node scripts/migrate-debts-to-cards.js ${likely.join(' ')}`
            : '\nPass the ids of the debts that are credit cards.');
        if (apply) console.log('\n--apply does nothing without ids.');
        return;
    }

    const missing = ids.filter(id => !debts.some(d => d.id === id));
    if (missing.length) throw new Error(`No debt with id ${missing.join(', ')}. Run with no ids to list them.`);
    const moving = debts.filter(d => ids.includes(d.id));

    console.log(`Moving ${moving.length} debt(s) to credit cards:`);
    for (const d of moving) {
        const c = toCard(d);
        console.log(`  #${d.id} ${d.name}: ${money(d.total)} total, ${money(d.paid)} paid`);
        console.log(`      -> card "${c.name}", balance ${money(c.balance)} as of ${c.balance_as_of}${c.notes ? `, notes "${c.notes}"` : ''}`);
    }

    // Case-insensitive, so "Chase" added by hand on the Cards page and a
    // "chase" debt are caught as the same card.
    const existing = new Set(toRows(await db.execute('SELECT name FROM credit_cards'))
        .map(c => c.name.trim().toLowerCase()));
    const clashes = moving.filter(d => existing.has(d.name.trim().toLowerCase()));
    if (clashes.length) {
        throw new Error(`Already on the Cards page: ${clashes.map(d => `"${d.name}"`).join(', ')}. `
            + 'Delete that card or this debt first, so the card is not doubled. Nothing was written.');
    }

    if (!apply) {
        console.log('\nDRY RUN - nothing written. Re-run with --apply once the above looks right.');
        return;
    }

    // The only undo: the debts exactly as they were.
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `debts-to-cards-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ taken_at: new Date().toISOString(), table: 'debts', rows: moving }, null, 2));
    if (JSON.parse(fs.readFileSync(file, 'utf8')).rows.length !== moving.length) {
        throw new Error(`Backup verify failed for ${file}. Nothing was written.`);
    }
    console.log(`\nBacked up ${moving.length} debt(s) to ${path.relative(process.cwd(), file)}`);

    const now = new Date().toISOString();
    await db.batch(moving.flatMap(d => {
        const c = toCard(d);
        return [
            {
                sql: 'INSERT INTO credit_cards (name, balance, balance_as_of, apr, annual_fee, fee_renewal, notes, updated_at) VALUES (?, ?, ?, NULL, 0, NULL, ?, ?)',
                args: [c.name, c.balance, c.balance_as_of, c.notes, now]
            },
            { sql: 'DELETE FROM debts WHERE id = ?', args: [d.id] }
        ];
    }), 'write');

    // Read back rather than trust the batch.
    const left = toRows(await db.execute('SELECT id FROM debts')).map(r => r.id);
    const stillThere = ids.filter(id => left.includes(id));
    if (stillThere.length) throw new Error(`Debts ${stillThere.join(', ')} are still there - check both tables.`);
    const cards = toRows(await db.execute('SELECT name, balance FROM credit_cards'));
    const added = moving.filter(d => cards.some(c => c.name === d.name));
    if (added.length !== moving.length) throw new Error('Not every card was found after the move - check both tables.');

    console.log(`Moved ${moving.length} debt(s) to credit cards. Set their APR, annual fee and renewal date on the Cards page.`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
