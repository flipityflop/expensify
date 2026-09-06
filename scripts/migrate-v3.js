// Migrates the expenses table onto the v3 taxonomy.
//
//   node scripts/migrate-v3.js            # dry run - prints everything, writes nothing
//   node scripts/migrate-v3.js --apply    # writes
//
// Three things change, all additive or reversible against the Phase 0 JSON dump:
//   category  - remapped onto the 21-item list in public/categories.js
//   merchant  - NEW column, derived from `notes`
//   event     - filled in where `notes` names one of the confirmed events
//
// `notes` is never written to. It stays as the in-place backup; the frontend
// simply stops showing it.
//
// Income rows (is_positive = 1) are left alone entirely - their category is a
// separate dimension reached through the income toggle, not the expense list.
const { db, toRows } = require('./db');
const { CATEGORIES } = require('../public/categories');

const CHUNK = 100;

// ------------------------------------------------------------ the mapping ---
// Ported from finance-overview/taxonomy.py (FROM_APP / BY_DESCRIPTION / map_app).

const FROM_APP = {
    'food': 'Groceries',                       // refined by description below
    'restaurant': 'Restaurants & Takeout',
    'rent+bills': 'Bills & Insurance',         // refined: rent vs bills
    'kitchen / home': 'Home & Furnishing',     // refined: cleaners -> Household Help
    'clothes + accessories': 'Clothing & Accessories',
    'clothes + accesories': 'Clothing & Accessories',   // spelling variant in the data
    'beauty': 'Beauty & Wigs',
    'health': 'Health',
    'tzedakah': 'Tzedakah',
    'gifts': 'Gifts',
    'fun': 'Fun & Entertainment',              // refined: travel/food bits move out
    'travel': 'Travel',                        // refined: same
    'office work': 'Work Expenses',            // refined: commuting -> Transportation
    'subscriptions': 'Subscriptions & Software',
    'electronics personal': 'Shopping & Other',
    'investments': 'Debt, Fees & Taxes',
    'various/ debt repayment': 'Shopping & Other'    // a junk drawer, refined below
};

// The categories that mix "what I bought" with "why I was spending". For these
// the description decides; the other nine map on name alone.
const MIXED = new Set([
    'travel', 'fun', 'office work', 'various/ debt repayment',
    'food', 'rent+bills', 'kitchen / home'
]);

// Checked in order, first match wins.
const BY_DESCRIPTION = [
    [/\buber\b|\blyft\b|taxi|train|subway|metrocard|bus\b/i, 'Transportation'],
    [/\bgas\b(?! bill)|parking|toll|car rental|car service|mechanic|car wash/i, 'Car'],
    [/flight|airfare|hotel|airbnb|lodging|baggage|tsa|precheck/i, 'Travel'],
    [/grocer|shabbos food|wine|salmon|challah|produce|supermarket/i, 'Groceries'],
    [/takeout|restaurant|coffee|cafe|pizza|dinner out|lunch/i, 'Restaurants & Takeout'],
    [/cleaner|cleaning lady|laundry|dry clean/i, 'Household Help'],
    [/toiletr|toothbrush|soap|shampoo|candle|tissue|paper towel|swiffer|detergent|diaper|batter|light bulb|cleaning suppl|amazon|walmart|target\b/i, 'Household Supplies'],
    [/^rent$|rent for|monthly rent/i, 'Rent'],
    [/electric|wifi|internet|coned|gas bill|water bill|phone line/i, 'Bills & Insurance'],
    [/insurance/i, 'Bills & Insurance'],
    [/movie|comedy|show|concert|museum|day pass|tickets/i, 'Fun & Entertainment'],
    [/wig|sheitel|shaitel/i, 'Beauty & Wigs'],
    [/tzedakah|maaser|shul|chabad|yeshiva|mikvah/i, 'Tzedakah'],
    [/google workspace|claude|domain|instantly|connects|books/i, 'Work Expenses'],
    [/amex fee|interest|late fee|bank fee/i, 'Debt, Fees & Taxes']
];

// Fitness is checked before everything else: it is a small, cuttable line that
// would otherwise scatter across Health, Fun and Subscriptions.
const FITNESS = /gym|classpass|yoga|pilates|workout|trainer|bootcamp|fitness|peloton|barry/i;

function mapCategory(category, description) {
    const cat = String(category || '').toLowerCase().trim().replace('accesories', 'accessories');
    const desc = String(description || '');

    if (FITNESS.test(desc)) return 'Fitness';
    if (MIXED.has(cat)) {
        for (const [rx, target] of BY_DESCRIPTION) {
            if (rx.test(desc)) return target;
        }
    }
    return FROM_APP[cat] || 'Shopping & Other';
}

// -------------------------------------------------------- notes -> merchant ---

// The confirmed event list. Matched case-insensitively against the whole
// trimmed `notes` value - never as a substring. `nyc` is deliberately absent.
const EVENTS = [
    'israel trip', 'vietnam trip', 'anniversary', "rochelle's wedding", 'shavuos',
    "sonya's birthday", 'sukkos', 'florida trip', '4th of july trip', 'shabbos in wayne',
    'yom kippur', 'trip to delaware', 'mets game', 'minnewaska day',
    "mendy's bar mitzvah", 'yossi friedman wedding registry'
];
const EVENT_SET = new Set(EVENTS);

// Hand-entered event spellings that mean the same thing as a list entry but do
// not match case-insensitively. Confirmed one at a time - never fuzzy-matched.
// The other pre-existing events are genuinely distinct and are left alone.
const EVENT_ALIASES = {
    'sonyas birthday': "sonya's birthday"
};

// Descriptions that ended up in the notes field. They name no merchant, so the
// merchant is left empty rather than inventing a store called "gas".
const NOT_MERCHANTS = new Set([
    'food and takeout', 'restaurants and takeout', 'flights',
    'parking and transportation', 'gas'
]);

// Exact-value merges only. Prefix merging would corrupt real distinctions -
// `trade` vs `trader joes`, `uber` vs `uber eats`, `food` vs `fooderie`.
const MERGES = {
    'market place': 'marketplace',
    'sylvias': "sylvia's",
    'kosher town': 'koshertown',
    'esti': 'esti skin',
    'esti skin care': 'esti skin',
    'lighthouse': 'lighthouse cafe',
    'bravo': 'bravo pizza',
    'shabbos fish': 'shabbos fish store',
    'coffee': 'coffee shops'
};

// -> { merchant, event }  (event '' means "leave whatever is already there")
function splitNotes(notes) {
    const raw = String(notes || '').toLowerCase().trim();
    if (!raw) return { merchant: '', event: '' };
    if (EVENT_SET.has(raw)) return { merchant: '', event: raw };

    const merged = MERGES[raw] || raw;
    if (NOT_MERCHANTS.has(merged)) return { merchant: '', event: '' };
    return { merchant: merged, event: '' };
}

// ------------------------------------------------------------------ report ---

function distribution(rows, key) {
    const counts = {};
    for (const r of rows) counts[r[key] || '(empty)'] = (counts[r[key] || '(empty)'] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function printDistribution(title, entries) {
    console.log(`\n${title}`);
    for (const [name, n] of entries) console.log(`  ${String(n).padStart(5)}  ${name}`);
}

// The traps that would corrupt data silently. Runs without a database:
//   node scripts/migrate-v3.js --selftest
function selftest() {
    const assert = require('assert');
    const cat = (c, w) => mapCategory(c, w);

    // Case-inconsistent categories in the live data ("food" and "Food" both exist).
    assert.strictEqual(cat('Food', 'milk'), 'Groceries');
    assert.strictEqual(cat('food', 'milk'), 'Groceries');
    assert.strictEqual(cat('clothes + accesories', 'shirt'), 'Clothing & Accessories');

    // Mixed categories are decided by the description, not the name.
    assert.strictEqual(cat('travel', 'uber to airport'), 'Transportation');
    assert.strictEqual(cat('travel', 'flight to tlv'), 'Travel');
    assert.strictEqual(cat('fun', 'dinner out'), 'Restaurants & Takeout');
    assert.strictEqual(cat('rent+bills', 'rent'), 'Rent');
    assert.strictEqual(cat('rent+bills', 'coned'), 'Bills & Insurance');
    // Clean categories ignore the description.
    assert.strictEqual(cat('tzedakah', 'uber'), 'Tzedakah');

    // Fitness wins over the category mapping, or it scatters across three buckets.
    assert.strictEqual(cat('health', 'classpass'), 'Fitness');
    assert.strictEqual(cat('subscriptions', 'gym membership'), 'Fitness');

    // Merges are exact-value only. Prefix merging would corrupt these.
    assert.strictEqual(splitNotes('market place').merchant, 'marketplace');
    assert.strictEqual(splitNotes('trade').merchant, 'trade');
    assert.strictEqual(splitNotes('trader joes').merchant, 'trader joes');
    assert.strictEqual(splitNotes('trade coffee').merchant, 'trade coffee');
    assert.strictEqual(splitNotes('uber eats').merchant, 'uber eats');
    assert.strictEqual(splitNotes('coffee').merchant, 'coffee shops');

    // Events leave the merchant empty; descriptions-as-notes blank both.
    assert.deepStrictEqual(splitNotes('Israel Trip'), { merchant: '', event: 'israel trip' });
    assert.deepStrictEqual(splitNotes('gas'), { merchant: '', event: '' });
    assert.deepStrictEqual(splitNotes('  '), { merchant: '', event: '' });
    // `nyc` is deliberately not an event.
    assert.strictEqual(splitNotes('nyc').merchant, 'nyc');

    // Every alias must point at a real event, or it silently invents one.
    for (const target of Object.values(EVENT_ALIASES)) {
        assert.ok(EVENT_SET.has(target), `${target} is not a confirmed event`);
    }

    // Every mapping target has to exist on the shipped list.
    const targets = [...Object.values(FROM_APP), ...BY_DESCRIPTION.map(([, t]) => t), 'Fitness'];
    for (const t of targets) assert.ok(CATEGORIES.includes(t), `${t} is not a real category`);

    console.log('selftest: all assertions pass');
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const apply = process.argv.includes('--apply');

    // Additive, and only on a real run - a dry run must not touch production
    // schema. Same try/catch idiom as server.js, so re-running is a no-op.
    if (apply) {
        try { await db.execute('ALTER TABLE expenses ADD COLUMN merchant TEXT'); } catch (_) {}
    }

    const before = toRows(await db.execute('SELECT * FROM expenses ORDER BY id'));
    const expenses = before.filter(r => !r.is_positive);
    const income = before.filter(r => r.is_positive);

    const beforeSum = before.reduce((s, r) => s + Number(r.amount), 0);

    console.log(`Loaded ${before.length} rows (${expenses.length} expense, ${income.length} income)`);
    console.log(`  amount sum: ${beforeSum.toFixed(2)}`);

    // ---- compute -----------------------------------------------------------
    const updates = [];
    const disposition = { toEvent: 0, blanked: 0, toMerchant: 0, alreadyEmpty: 0 };
    const fitnessRows = [];
    const eventConflicts = [];
    const unmapped = new Set();
    const after = [];

    for (const row of expenses) {
        const category = mapCategory(row.category, row.what);
        const { merchant, event } = splitNotes(row.notes);

        const cat = String(row.category || '').toLowerCase().trim().replace('accesories', 'accessories');
        if (!(cat in FROM_APP)) unmapped.add(row.category);
        if (category === 'Fitness') fitnessRows.push(row);

        const rawNotes = String(row.notes || '').trim();
        if (!rawNotes) disposition.alreadyEmpty++;
        else if (event) disposition.toEvent++;
        else if (merchant) disposition.toMerchant++;
        else disposition.blanked++;

        // A hand-entered event that differs from a list entry only in case is
        // the same event - fold it onto the list spelling, or the filter shows
        // "Mendy's bar mitzvah" and "mendy's bar mitzvah" as two things.
        const existingEvent = String(row.event || '').trim();
        const lowerEvent = existingEvent.toLowerCase();
        let finalEvent = EVENT_SET.has(lowerEvent)
            ? lowerEvent
            : (EVENT_ALIASES[lowerEvent] || existingEvent);

        // An event derived from notes never silently overwrites a different one
        // that was entered by hand - those are reported instead.
        if (event) {
            if (existingEvent && existingEvent.toLowerCase() !== event) {
                eventConflicts.push({ id: row.id, notes: rawNotes, existing: existingEvent, derived: event });
            } else {
                finalEvent = event;
            }
        }

        after.push({ ...row, category, merchant, event: finalEvent });

        if (category !== row.category || merchant !== (row.merchant || '') || finalEvent !== (row.event || '')) {
            updates.push({ id: row.id, category, merchant, event: finalEvent, wasEvent: existingEvent });
        }
    }

    // ---- report ------------------------------------------------------------
    printDistribution('BEFORE - expense categories:', distribution(expenses, 'category'));
    printDistribution('AFTER  - expense categories:', distribution(after, 'category'));
    printDistribution('Income categories (untouched):', distribution(income, 'category'));

    console.log('\nNotes disposition:');
    console.log(`  ${String(disposition.toEvent).padStart(5)}  -> event`);
    console.log(`  ${String(disposition.blanked).padStart(5)}  -> blanked (description, not a merchant)`);
    console.log(`  ${String(disposition.toMerchant).padStart(5)}  -> merchant`);
    console.log(`  ${String(disposition.alreadyEmpty).padStart(5)}  already empty`);

    printDistribution(`Events written (${disposition.toEvent} rows):`,
        distribution(after.filter(r => EVENT_SET.has(r.event)), 'event'));

    // Events that were in the table before this ran and are not on the confirmed
    // list. Left exactly as they are - reported so they can be dealt with by hand.
    const preExisting = expenses.filter(r => {
        const v = String(r.event || '').trim().toLowerCase();
        return v && !EVENT_SET.has(v) && !EVENT_ALIASES[v];
    });
    if (preExisting.length) {
        printDistribution(`Pre-existing events NOT on the confirmed list (${preExisting.length} rows, untouched):`,
            distribution(preExisting, 'event'));
    }

    if (eventConflicts.length) {
        console.log(`\nEvent conflicts (${eventConflicts.length}) - existing value kept, notes ignored:`);
        for (const c of eventConflicts) {
            console.log(`  id ${c.id}: notes=${JSON.stringify(c.notes)} existing=${JSON.stringify(c.existing)} derived=${JSON.stringify(c.derived)}`);
        }
    }

    console.log(`\nFitness rows (${fitnessRows.length}) - matched on description keyword:`);
    for (const r of fitnessRows) {
        console.log(`  id ${r.id}: ${JSON.stringify(r.what)}  (was ${JSON.stringify(r.category)}, $${Math.abs(r.amount).toFixed(2)})`);
    }

    console.log(`\nApp categories with no mapping rule: ${[...unmapped].join(', ') || 'none'}`);

    const topMerchants = distribution(after.filter(r => r.merchant), 'merchant').slice(0, 15);
    printDistribution('Top merchants after split:', topMerchants);
    console.log(`  (${new Set(after.filter(r => r.merchant).map(r => r.merchant)).size} distinct merchants)`);

    // ---- assertions --------------------------------------------------------
    const VALID = new Set(CATEGORIES);
    const problems = [];

    // 1 + 2: nothing may be created, destroyed, or have its amount touched.
    if (after.length + income.length !== before.length) problems.push('row count changed');
    const afterSum = after.concat(income).reduce((s, r) => s + Number(r.amount), 0);
    if (Math.abs(afterSum - beforeSum) > 0.005) problems.push(`amount sum changed: ${beforeSum} -> ${afterSum}`);

    // 3: every category lands on the 21-item list.
    const stray = after.filter(r => !VALID.has(r.category));
    if (stray.length) problems.push(`${stray.length} rows outside the 21 categories: ${[...new Set(stray.map(r => r.category))].join(', ')}`);

    // 4: a non-empty note must end up somewhere, unless it was one of the 5
    // deliberate blanks.
    const lost = after.filter(r => {
        const raw = String(r.notes || '').toLowerCase().trim();
        if (!raw) return false;
        if (!r.merchant && !EVENT_SET.has(r.event)) {
            return !NOT_MERCHANTS.has(MERGES[raw] || raw);
        }
        return false;
    });
    if (lost.length) problems.push(`${lost.length} rows lost their notes: ${lost.slice(0, 5).map(r => r.id).join(', ')}`);

    // 5: every event this migration *changes* lands on the confirmed list.
    // Rows whose event is carried through untouched are not this migration's
    // doing - they are reported above and left for a human to sort out.
    const badEvent = updates.filter(u => u.event && u.event !== u.wasEvent && !EVENT_SET.has(u.event));
    if (badEvent.length) problems.push(`${badEvent.length} written events off-list: ${[...new Set(badEvent.map(u => u.event))].join(', ')}`);

    console.log('\nAssertions:');
    if (problems.length === 0) {
        console.log('  all pass (row count, amount sum, 21 categories, no lost notes, events on list)');
    } else {
        for (const p of problems) console.log(`  FAIL: ${p}`);
    }

    console.log(`\n${updates.length} rows would be updated.`);

    if (problems.length) {
        console.error('\nRefusing to write: fix the failures above first.');
        process.exit(1);
    }

    if (!apply) {
        console.log('\nDRY RUN - nothing written. Re-run with --apply once the above looks right.');
        return;
    }

    // ---- write -------------------------------------------------------------
    const sql = 'UPDATE expenses SET category = ?, merchant = ?, event = ? WHERE id = ?';
    let done = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
        const batch = updates.slice(i, i + CHUNK)
            .map(u => ({ sql, args: [u.category, u.merchant, u.event, u.id] }));
        await db.batch(batch, 'write');
        done += batch.length;
        process.stdout.write(`\r  updated ${done}/${updates.length}`);
    }
    console.log('');

    // Read back and re-check the two things that must never move.
    const verify = toRows(await db.execute('SELECT COUNT(*) n, SUM(amount) s FROM expenses'));
    console.log(`Done. ${verify[0].n} rows, amount sum ${Number(verify[0].s).toFixed(2)}`);
    if (verify[0].n !== before.length || Math.abs(Number(verify[0].s) - beforeSum) > 0.005) {
        throw new Error('POST-WRITE MISMATCH - restore from backups/ immediately');
    }
    console.log('Verified against the pre-migration count and sum.');
}

main().catch(err => { console.error(err); process.exit(1); });
