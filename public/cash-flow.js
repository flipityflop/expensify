// The cash flow section of the budget page: money that comes in or goes out on
// a schedule, run forward from the cash on hand to show what is there now, each
// coming date with the balance after it, and the lowest the balance gets.
//
// Loaded after fixed-expenses.js - classic scripts share one top-level scope,
// so `dueIn()` here is fixed-expenses.js's and `money()`, `escapeHtml()`,
// `isoDate()` and `shortDate()` are helpers.js's.

const cashBalanceInput = document.getElementById('cash-balance');
const cashAsOf = document.getElementById('cash-as-of');
const cashTotals = document.getElementById('cash-totals');
const cashItemsTbody = document.getElementById('cash-items-tbody');
const cashItemsTfoot = document.getElementById('cash-items-tfoot');
const cashUpcomingTbody = document.getElementById('cash-upcoming-tbody');
const cashModal = document.getElementById('cash-modal');
const cashModalTitle = document.getElementById('cash-modal-title');
const cashNameInput = document.getElementById('cash-name');
const cashDirectionSelect = document.getElementById('cash-direction');
const cashAmountInput = document.getElementById('cash-amount');
const cashFrequencySelect = document.getElementById('cash-frequency');
const cashMonthDaysField = document.getElementById('cash-month-days-field');
const cashMonthDaysInput = document.getElementById('cash-month-days');
const cashWeekdaysField = document.getElementById('cash-weekdays-field');
const cashWeekdaysBox = document.getElementById('cash-weekdays');
const cashStartField = document.getElementById('cash-start-field');
const cashStartInput = document.getElementById('cash-start');
const cashDeleteBtn = document.getElementById('cash-delete');

let cashItems = [];
let cashBalance = null; // { amount, as_of } or null before it is typed
let editingCashId = null; // null while the modal is adding rather than editing

// How many times a weekly or every-two-weeks item comes round in an average
// month.
const WEEKS_PER_MONTH = 52 / 12;

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    // 7 January 2001 was a Sunday, weekday 0.
    for (let d = 0; d < 7; d++) {
        const name = new Date(2001, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'short' });
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" value="${d}"> ${name}`;
        cashWeekdaysBox.appendChild(label);
    }

    cashFrequencySelect.addEventListener('change', showCashDayFields);
    cashBalanceInput.addEventListener('change', saveCashBalance);
    document.getElementById('add-cash-btn').addEventListener('click', () => openCashModal(null));
    document.getElementById('cash-save').addEventListener('click', saveCashItem);
    cashDeleteBtn.addEventListener('click', deleteCashItem);

    // Rows are rebuilt with every render, so their Edit buttons are caught here.
    document.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-cash-edit]');
        if (button) openCashModal(cashItems.find(item => item.id === Number(button.dataset.cashEdit)));
    });

    loadCashFlow();
});

async function loadCashFlow() {
    try {
        const [itemResponse, balanceResponse] = await Promise.all([
            fetch('/api/cash-flow', { headers: getAuthHeaders() }),
            fetch('/api/cash-balance', { headers: getAuthHeaders() })
        ]);
        if (itemResponse.status === 401 || balanceResponse.status === 401) return; // budget.js sends the page to login
        if (!itemResponse.ok || !balanceResponse.ok) throw new Error('Failed to load cash flow');

        cashItems = await itemResponse.json();
        cashBalance = await balanceResponse.json();
        renderCashFlow();
    } catch (error) {
        console.error('Error loading cash flow:', error);
        cashItemsTbody.innerHTML = '<tr><td colspan="5" class="empty-note" style="color: #ef4444;">Error loading cash flow.</td></tr>';
    }
}

// ---- dates ----------------------------------------------------------------

function cashDays(item) {
    return String(item.days || '').split(',').filter(Boolean).map(Number);
}

function dateFromIso(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day);
}

// Days are added through the Date constructor rather than as milliseconds,
// so a clock change does not knock a date off midnight.
function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// Every date from `start` to `end`, both included, that an item falls on, in
// order. A day past the end of a short month falls on its last day, as a fixed
// expense's due date does. Two days landing on the same date stay two
// payments: an item on the 30th and the 31st is paid twice on 28 February.
function cashOccurrences(item, start, end) {
    const dates = [];

    if (item.frequency === 'biweekly') {
        // Step from the item's date to the first fortnight on or after `start`,
        // which may be before or after it.
        const anchor = dateFromIso(item.start_date);
        const offset = Math.round((start - anchor) / 86400000);
        let date = addDays(anchor, Math.ceil(offset / 14) * 14);
        for (; date <= end; date = addDays(date, 14)) dates.push(date);
        return dates;
    }

    const days = cashDays(item);
    if (item.frequency === 'weekly') {
        for (let date = start; date <= end; date = addDays(date, 1)) {
            if (days.includes(date.getDay())) dates.push(date);
        }
        return dates;
    }

    for (let m = start.getMonth(), y = start.getFullYear(); new Date(y, m, 1) <= end; m++) {
        days.map(day => dueIn(y, m, day))
            .filter(date => date >= start && date <= end)
            .forEach(date => dates.push(date));
    }
    return dates.sort((a, b) => a - b);
}

// What an item comes to in an average month.
function cashPerMonth(item) {
    if (item.frequency === 'biweekly') return item.amount * WEEKS_PER_MONTH / 2;
    if (item.frequency === 'weekly') return item.amount * cashDays(item).length * WEEKS_PER_MONTH;
    return item.amount * cashDays(item).length;
}

function weekdayName(d) {
    return new Date(2001, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'short' });
}

// "1st & 15th", "Fri", "every 2 weeks".
function cashWhenLabel(item) {
    if (item.frequency === 'biweekly') return 'every 2 weeks';
    if (item.frequency === 'weekly') return cashDays(item).map(weekdayName).join(', ');
    return cashDays(item).map(ordinal).join(' & ');
}

// ---- the projection -------------------------------------------------------

// Runs the items forward from the cash on hand to the end of next month.
//
// The typed balance already counts what happened on the day it was typed, so
// items start the day after. Those between then and today have happened and
// make up `now`; from today on they are listed, each with the balance after
// it. On one day, money out goes before money in, so the low point is never
// flattered by which comes first. `low` is the least the balance gets to from
// today on - what could be spent without running out.
function cashProjection(items, balance, today) {
    const asOf = balance ? dateFromIso(balance.as_of) : today;
    const start = addDays(asOf, 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);

    const events = items
        .flatMap(item => cashOccurrences(item, start, end).map(date => ({
            date,
            item,
            amount: item.direction === 'in' ? item.amount : -item.amount
        })))
        .sort((a, b) => a.date - b.date || a.amount - b.amount || a.item.name.localeCompare(b.item.name));

    let running = balance ? balance.amount : 0;
    let now = running;
    const upcoming = [];
    let low = null;

    for (const event of events) {
        running += event.amount;
        if (event.date < today) {
            now = running;
        } else {
            upcoming.push({ ...event, balance: running });
            if (!low || running < low.amount) low = { amount: running, date: event.date };
        }
    }

    if (!low || now <= low.amount) low = { amount: now, date: null };
    return { now, low, upcoming, end };
}

// ---- rendering ------------------------------------------------------------

function signedMoney(amount) {
    return amount > 0 ? `+${money(amount)}` : money(amount);
}

function cashItemRowHtml(item) {
    return `
        <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${cashWhenLabel(item)}</td>
            <td class="${item.direction === 'in' ? 'under' : ''}">${signedMoney(item.direction === 'in' ? item.amount : -item.amount)}</td>
            <td>${money(cashPerMonth(item))}</td>
            <td><button type="button" class="small-btn" data-cash-edit="${item.id}">Edit</button></td>
        </tr>
    `;
}

function upcomingRowHtml(event, today) {
    const days = Math.round((event.date - today) / 86400000);
    const when = event.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const until = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `
        <tr>
            <td>${when}<span class="due-in">${until}</span></td>
            <td>${escapeHtml(event.item.name)}</td>
            <td class="${event.amount > 0 ? 'under' : ''}">${signedMoney(event.amount)}</td>
            <td class="${event.balance < 0 ? 'over' : ''}">${money(event.balance)}</td>
        </tr>
    `;
}

// In first, then out; the largest a month first within each.
function sortCashItems(items) {
    return [...items].sort((a, b) =>
        (a.direction === 'out') - (b.direction === 'out') || cashPerMonth(b) - cashPerMonth(a) || a.name.localeCompare(b.name));
}

function cashTotalsOf(items) {
    const sum = direction => items.filter(i => i.direction === direction).reduce((s, i) => s + cashPerMonth(i), 0);
    const inflow = sum('in');
    const outflow = sum('out');
    return { inflow, outflow, net: inflow - outflow };
}

function renderCashFlow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (document.activeElement !== cashBalanceInput) cashBalanceInput.value = cashBalance ? cashBalance.amount : '';
    cashAsOf.textContent = cashBalance ? shortDate(cashBalance.as_of) : '';

    const projection = cashProjection(cashItems, cashBalance, today);
    const totals = cashTotalsOf(cashItems);
    const lowWhen = projection.low.date
        ? projection.low.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : 'now';

    cashTotals.innerHTML = `
        <div class="summary-item">
            <span class="summary-label">Cash now</span>
            <span class="summary-value${projection.now < 0 ? ' negative' : ''}">${money(projection.now)}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Lowest</span>
            <span class="summary-value${projection.low.amount < 0 ? ' negative' : ''}">${money(projection.low.amount)}</span>
            <span class="due-in">${lowWhen}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Net / mo</span>
            <span class="summary-value${totals.net < 0 ? ' negative' : ''}">${signedMoney(totals.net)}</span>
        </div>
    `;

    if (!cashItems.length) {
        cashItemsTbody.innerHTML = '<tr><td colspan="5" class="empty-note">No cash items yet.</td></tr>';
        cashItemsTfoot.innerHTML = '';
        cashUpcomingTbody.innerHTML = '<tr><td colspan="4" class="empty-note">Nothing coming up.</td></tr>';
        return;
    }

    cashItemsTbody.innerHTML = sortCashItems(cashItems).map(cashItemRowHtml).join('');
    cashItemsTfoot.innerHTML = `
        <tr><td colspan="3">In / mo</td><td>${money(totals.inflow)}</td><td></td></tr>
        <tr><td colspan="3">Out / mo</td><td>${money(totals.outflow)}</td><td></td></tr>
    `;

    cashUpcomingTbody.innerHTML = projection.upcoming.length
        ? projection.upcoming.map(event => upcomingRowHtml(event, today)).join('')
        : '<tr><td colspan="4" class="empty-note">Nothing coming up.</td></tr>';
}

// ---- saving ---------------------------------------------------------------

// Typing the cash on hand dates it today. A cleared field puts the stored
// amount back, as the plan inputs do.
async function saveCashBalance() {
    if (cashBalanceInput.value === '') {
        cashBalanceInput.value = cashBalance ? cashBalance.amount : '';
        return;
    }
    const amount = parseFloat(cashBalanceInput.value);
    if (isNaN(amount)) return alert('Enter an amount.');

    try {
        const balance = { amount, as_of: isoDate(new Date()) };
        const response = await fetch('/api/cash-balance', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(balance)
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save cash on hand');
        cashBalance = balance;
        renderCashFlow();
    } catch (error) {
        console.error('Save cash on hand error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

// A monthly item takes days of the month, a weekly one weekdays, and an
// every-two-weeks one a date it falls on.
function showCashDayFields() {
    const frequency = cashFrequencySelect.value;
    cashMonthDaysField.style.display = frequency === 'monthly' ? '' : 'none';
    cashWeekdaysField.style.display = frequency === 'weekly' ? '' : 'none';
    cashStartField.style.display = frequency === 'biweekly' ? '' : 'none';
}

// One modal for both: `item` is the one being edited, or null to add one.
function openCashModal(item) {
    editingCashId = item ? item.id : null;
    cashModalTitle.textContent = item ? 'Edit cash item' : 'Add cash item';
    cashNameInput.value = item ? item.name : '';
    cashDirectionSelect.value = item ? item.direction : 'out';
    cashAmountInput.value = item ? item.amount : '';
    cashFrequencySelect.value = item ? item.frequency : 'monthly';
    cashMonthDaysInput.value = item && item.frequency === 'monthly' ? cashDays(item).join(', ') : '';
    const weekdays = item && item.frequency === 'weekly' ? cashDays(item) : [];
    cashWeekdaysBox.querySelectorAll('input').forEach(box => { box.checked = weekdays.includes(Number(box.value)); });
    cashStartInput.value = item && item.start_date ? item.start_date : isoDate(new Date());
    cashDeleteBtn.style.display = item ? 'block' : 'none';
    showCashDayFields();
    cashModal.style.display = 'block';
}

// The days typed or ticked for the chosen frequency, or an error to show.
function cashDaysFromForm(frequency, monthDaysText, weekdaysTicked) {
    if (frequency === 'weekly') {
        return weekdaysTicked.length ? { days: weekdaysTicked } : { error: 'Tick at least one day.' };
    }
    const days = monthDaysText.split(/[\s,&]+/).filter(Boolean).map(Number);
    if (!days.length || !days.every(d => Number.isInteger(d) && d >= 1 && d <= 31)) {
        return { error: 'Days must be 1–31.' };
    }
    return { days };
}

async function saveCashItem() {
    const name = cashNameInput.value.trim();
    const amount = parseFloat(cashAmountInput.value);
    const frequency = cashFrequencySelect.value;

    if (!name) return alert('Enter a name.');
    if (isNaN(amount) || amount <= 0) return alert('Enter an amount.');

    const body = { name, amount, direction: cashDirectionSelect.value, frequency };
    if (frequency === 'biweekly') {
        if (!cashStartInput.value) return alert('Enter a date.');
        body.start_date = cashStartInput.value;
    } else {
        const ticked = [...cashWeekdaysBox.querySelectorAll('input')].filter(b => b.checked).map(b => Number(b.value));
        const { days, error } = cashDaysFromForm(frequency, cashMonthDaysInput.value, ticked);
        if (error) return alert(error);
        body.days = days;
    }

    try {
        const response = await fetch(editingCashId ? `/api/cash-flow/${editingCashId}` : '/api/cash-flow', {
            method: editingCashId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save cash item');

        cashModal.style.display = 'none';
        await loadCashFlow();
    } catch (error) {
        console.error('Save cash item error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteCashItem() {
    if (!editingCashId || !confirm(`Delete ${cashNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/cash-flow/${editingCashId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete cash item');

        cashModal.style.display = 'none';
        await loadCashFlow();
    } catch (error) {
        console.error('Delete cash item error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
