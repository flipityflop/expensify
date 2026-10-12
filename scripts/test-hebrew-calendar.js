// Pins the Rosh Hashanah arithmetic to published dates, and the Hebrew year a
// date falls in to the day either side of the turn.
//
//   node scripts/test-hebrew-calendar.js
//
// No database, no Intl.
const assert = require('assert');
const { roshHashanah, hebrewYear } = require('../public/hebrew-calendar.js');

// 1 Tishrei, from the published calendar. Covers years of every length, the
// earliest (early September) and latest (early October) the day can fall,
// and each of the four days it is allowed on.
const KNOWN = {
    5780: '2019-09-30',
    5781: '2020-09-19',
    5782: '2021-09-07',
    5783: '2022-09-26',
    5784: '2023-09-16',
    5785: '2024-10-03',
    5786: '2025-09-23',
    5787: '2026-09-12',
    5788: '2027-10-02',
    5789: '2028-09-21',
    5790: '2029-09-10',
    5791: '2030-09-28',
    5792: '2031-09-18',
    5793: '2032-09-06',
    5794: '2033-09-24',
    5795: '2034-09-14',
    5796: '2035-10-04',
    5797: '2036-09-22',
    5798: '2037-09-10',
    5799: '2038-09-30',
    5800: '2039-09-19'
};

for (const [year, date] of Object.entries(KNOWN)) {
    assert.strictEqual(roshHashanah(Number(year)), date, `1 Tishrei ${year}`);
}

// Lo ADU rosh: never a Sunday, Wednesday or Friday.
for (let year = 5700; year <= 5900; year++) {
    const day = new Date(roshHashanah(year) + 'T00:00:00Z').getUTCDay();
    assert.ok(![0, 3, 5].includes(day), `1 Tishrei ${year} fell on day ${day}`);
}

// Every year a legal length: 353-355 days, or 383-385 in a leap year.
const LEGAL = [353, 354, 355, 383, 384, 385];
for (let year = 5700; year <= 5900; year++) {
    const days = (Date.parse(roshHashanah(year + 1)) - Date.parse(roshHashanah(year))) / 86400000;
    assert.ok(LEGAL.includes(days), `${year} is ${days} days long`);
}

// The year turns on 1 Tishrei, not on 1 January.
assert.strictEqual(hebrewYear('2026-09-11'), 5786);   // 29 Elul
assert.strictEqual(hebrewYear('2026-09-12'), 5787);   // 1 Tishrei
assert.strictEqual(hebrewYear('2026-12-31'), 5787);
assert.strictEqual(hebrewYear('2027-01-01'), 5787);   // same year across January
assert.strictEqual(hebrewYear('2027-10-01'), 5787);
assert.strictEqual(hebrewYear('2027-10-02'), 5788);

console.log('hebrew calendar: all assertions pass');
