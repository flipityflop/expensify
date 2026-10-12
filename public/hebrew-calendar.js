// Rosh Hashanah - 1 Tishrei - for any Hebrew year, so a goal can run on the
// Jewish year rather than January to December.
//
// Plain arithmetic from the molad and the postponement rules, as laid out in
// Reingold & Dershowitz, Calendrical Calculations, rather than Intl's Hebrew
// calendar: it does not depend on how the browser's ICU was built, and
// scripts/test-hebrew-calendar.js pins it to known dates.
//
// Classic script, like categories.js: pages load it before their own script,
// and the tests require() it.

// Day numbers count from 1 January of year 1 (R.D. 1), as the book does.
const HEBREW_EPOCH = -1373427; // R.D. of 1 Tishrei, year 1
const UNIX_EPOCH = 719163;     // R.D. of 1970-01-01

// Days from the epoch to the new year of `year`: the molad of Tishrei, moved
// to the next day when it falls at or after noon (molad zaken), and off a
// Sunday, Wednesday or Friday (lo ADU rosh).
function hebrewElapsedDays(year) {
    const months = Math.floor((235 * year - 234) / 19);
    const parts = 12084 + 13753 * months;
    const days = 29 * months + Math.floor(parts / 25920);
    return (3 * (days + 1)) % 7 < 3 ? days + 1 : days;
}

// The other two postponements (GaTaRaD and BeTUTaKPaT), which exist only to
// keep every year a legal length: neither 356 nor 382 days is one.
function hebrewYearCorrection(year) {
    const prev = hebrewElapsedDays(year - 1);
    const here = hebrewElapsedDays(year);
    const next = hebrewElapsedDays(year + 1);
    if (next - here === 356) return 2;
    if (here - prev === 382) return 1;
    return 0;
}

// YYYY-MM-DD of 1 Tishrei. The holiday starts the evening before, but expense
// dates carry no time of day, so the year turns on this date.
function roshHashanah(year) {
    const day = HEBREW_EPOCH + hebrewElapsedDays(year) + hebrewYearCorrection(year);
    return new Date((day - UNIX_EPOCH) * 86400000).toISOString().slice(0, 10);
}

// The Hebrew year a YYYY-MM-DD date falls in. 1 Tishrei of Hebrew year
// G + 3761 always falls in September or October of Gregorian year G.
function hebrewYear(isoDate) {
    const year = Number(isoDate.slice(0, 4)) + 3761;
    return isoDate >= roshHashanah(year) ? year : year - 1;
}

if (typeof module !== 'undefined') {
    module.exports = { roshHashanah, hebrewYear };
}
