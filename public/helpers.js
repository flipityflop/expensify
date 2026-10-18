// Small helpers shared by the budget, accounts and goals pages: money,
// escaping, local dates, and closing modals.
//
// Classic script: load it after auth.js and before the page's own scripts,
// which share its top-level scope. The tests load it into their vm the same
// way.

// Rounded to the cent before the sign is taken, so float dust such as
// -0.0000001 does not print as "-$0.00".
function money(amount) {
    const cents = Math.round(amount * 100) / 100;
    return `${cents < 0 ? '-' : ''}$${Math.abs(cents).toFixed(2)}`;
}

// Names and notes are free text going into innerHTML.
function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// YYYY-MM-DD from a Date's local parts. toISOString() is UTC, which is already
// tomorrow by the evening west of Greenwich.
function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A stored YYYY-MM-DD for reading: "12 Oct 2026" in the browser's locale.
// Built from local parts rather than parsed as a date, which would be read as
// UTC and show the day before west of Greenwich.
function shortDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Every modal closes from its × and Cancel, which carry the id of the modal
// they close in data-close, or from a click on the dimmed backdrop around it.
document.addEventListener('click', e => {
    const closes = e.target.dataset && e.target.dataset.close;
    if (closes) document.getElementById(closes).style.display = 'none';
    else if (e.target.classList && e.target.classList.contains('modal')) e.target.style.display = 'none';
});
