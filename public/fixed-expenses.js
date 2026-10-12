// Fixed expenses: named recurring costs inside a category - Phone and Internet
// inside Bills & Insurance - each with an optional due date.
//
// Loaded after budget.js and debts.js - classic scripts share one top-level
// scope. The list itself (`fixedItems`) and the sums autofill needs live in
// budget.js; this file is the add/edit modal, the list under an opened
// category row, and the schedule of when each one is due. budget.js calls
// fixedDetailHtml() and renderSchedule() from render(), which only runs once
// every script has loaded. `escapeHtml()` is debts.js's.

const fixedModal = document.getElementById('fixed-modal');
const fixedModalTitle = document.getElementById('fixed-modal-title');
const fixedNameInput = document.getElementById('fixed-name');
const fixedCategorySelect = document.getElementById('fixed-category');
const fixedAmountInput = document.getElementById('fixed-amount');
const fixedFrequencySelect = document.getElementById('fixed-frequency');
const fixedDueLabel = document.getElementById('fixed-due-label');
const fixedDueMonthSelect = document.getElementById('fixed-due-month');
const fixedDueDayInput = document.getElementById('fixed-due-day');
const fixedDeleteBtn = document.getElementById('fixed-delete');
const scheduleTbody = document.getElementById('schedule-tbody');
const scheduleTfoot = document.getElementById('schedule-tfoot');

let editingItemId = null; // null while the modal is adding rather than editing

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    fillCategorySelect(fixedCategorySelect, CATEGORIES, 'Choose a category');
    for (let m = 1; m <= 12; m++) {
        const name = new Date(2000, m - 1, 1).toLocaleDateString(undefined, { month: 'long' });
        fixedDueMonthSelect.appendChild(new Option(name, m));
    }

    fixedFrequencySelect.addEventListener('change', showDueFields);
    document.getElementById('add-fixed-btn').addEventListener('click', () => openFixedModal(null, ''));
    document.getElementById('fixed-save').addEventListener('click', saveFixedItem);
    fixedDeleteBtn.addEventListener('click', deleteFixedItem);

    // The Edit and Add buttons are rebuilt with every render, so they are
    // caught here rather than bound one at a time. The close and Cancel
    // controls carry data-close, which debts.js already handles.
    document.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-item-edit], [data-item-add]');
        if (button && button.dataset.itemEdit) {
            openFixedModal(fixedItems.find(item => item.id === Number(button.dataset.itemEdit)));
        } else if (button) {
            openFixedModal(null, button.dataset.itemAdd);
        } else if (e.target === fixedModal) {
            fixedModal.style.display = 'none';
        }
    });
});

// ---- due dates ------------------------------------------------------------

function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// The date `day` falls on in a month, pulled back to the month's last day when
// the month is shorter: a bill due on the 31st is due on 30 April. `monthIndex`
// is 0-based and may run past 11 into the next year, as Date allows.
function dueIn(year, monthIndex, day) {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return new Date(year, monthIndex, Math.min(day, lastDay));
}

// The next date, on or after `today` (a Date at local midnight), that an item
// is due. null when it has no due date.
function nextDue(item, today) {
    if (!item.due_day) return null;
    const year = today.getFullYear();
    if (item.frequency === 'yearly') {
        const thisYear = dueIn(year, item.due_month - 1, item.due_day);
        return thisYear >= today ? thisYear : dueIn(year + 1, item.due_month - 1, item.due_day);
    }
    const thisMonth = dueIn(year, today.getMonth(), item.due_day);
    return thisMonth >= today ? thisMonth : dueIn(year, today.getMonth() + 1, item.due_day);
}

// "due the 15th" for a monthly item, "due Mar 15" for a yearly one. 2000 is a
// leap year, so a yearly item due 29 February keeps its day.
function dueLabel(item) {
    if (!item.due_day) return 'no due date';
    if (item.frequency === 'yearly') {
        return `due ${dueIn(2000, item.due_month - 1, item.due_day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    return `due the ${ordinal(item.due_day)}`;
}

function perPeriod(item) {
    return `${money(item.amount)} ${item.frequency === 'yearly' ? 'a year' : 'a month'}`;
}

// ---- under an opened category row ------------------------------------------

function fixedDetailHtml(category) {
    const items = fixedItemsIn(category);
    const total = fixedItemsTotal(category);
    const goal = goals[category];
    const unit = goalPeriod(category) === 'yearly' ? 'a year' : 'a month';

    let summary;
    if (!items.length) summary = `No fixed expenses in ${category} yet.`;
    else if (goal === undefined) summary = `Fixed: ${money(total)} ${unit}.`;
    else if (total > goal + 0.005) summary = `<span class="over">Fixed expenses come to ${money(total)}, more than the ${money(goal)} goal.</span>`;
    else summary = `Fixed ${money(total)} of the ${money(goal)} goal · ${money(goal - total)} flexible`;

    const list = items.map(item => `
        <li class="fixed-item">
            <span class="fixed-item-name">${escapeHtml(item.name)}</span>
            <span class="fixed-item-amount">${perPeriod(item)}</span>
            <span class="fixed-item-due">${dueLabel(item)}</span>
            <button type="button" class="debt-btn" data-item-edit="${item.id}">Edit</button>
        </li>`).join('');

    return `
        <tr class="detail-row">
            <td colspan="6">
                ${items.length ? `<ul class="fixed-items">${list}</ul>` : ''}
                <div class="fixed-items-foot">
                    <span>${summary}</span>
                    <button type="button" class="debt-btn" data-item-add="${category}">+ Add fixed expense</button>
                </div>
            </td>
        </tr>
    `;
}

// ---- the schedule ---------------------------------------------------------

function scheduleRowHtml(item, due, today) {
    const days = due === null ? null : Math.round((due - today) / 86400000);
    const when = due === null ? '—' : due.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        ...(due.getFullYear() !== today.getFullYear() && { year: 'numeric' })
    });
    const until = days === null ? 'no due date'
        : days === 0 ? 'today'
        : days === 1 ? 'tomorrow'
        : `in ${days} days`;

    return `
        <tr${days !== null && days <= 7 ? ' class="due-soon"' : ''}>
            <td>${when}<span class="due-in">${until}</span></td>
            <td>${escapeHtml(item.name)}</td>
            <td>${item.category}</td>
            <td>${perPeriod(item)}</td>
            <td><button type="button" class="debt-btn" data-item-edit="${item.id}">Edit</button></td>
        </tr>
    `;
}

// Every fixed expense, soonest due first; the ones with no due date last.
function renderSchedule() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const rows = fixedItems
        .map(item => ({ item, due: nextDue(item, today) }))
        .sort((a, b) => (a.due === null) - (b.due === null) || a.due - b.due || a.item.name.localeCompare(b.item.name));

    if (!rows.length) {
        scheduleTbody.innerHTML = '<tr><td colspan="5" class="debt-empty">No fixed expenses yet. Open a category above, or use Add fixed expense.</td></tr>';
        scheduleTfoot.innerHTML = '';
        return;
    }

    scheduleTbody.innerHTML = rows.map(({ item, due }) => scheduleRowHtml(item, due, today)).join('');

    // Yearly ones at a twelfth, so the total is what fixed costs take a month.
    const perMonth = fixedItems.reduce((sum, item) => sum + (item.frequency === 'yearly' ? item.amount / 12 : item.amount), 0);
    scheduleTfoot.innerHTML = `
        <tr>
            <td colspan="3">Total a month <span class="due-in">yearly ones at a twelfth</span></td>
            <td>${money(perMonth)}</td>
            <td></td>
        </tr>
    `;
}

// ---- the modal ------------------------------------------------------------

// A monthly expense is due on a day of every month, a yearly one on a date.
function showDueFields() {
    const yearly = fixedFrequencySelect.value === 'yearly';
    fixedDueMonthSelect.style.display = yearly ? '' : 'none';
    fixedDueLabel.textContent = yearly ? 'Due date' : 'Due day of the month';
}

// One modal for both: `item` is the one being edited, or null to add a new one
// into `category` (blank to choose).
function openFixedModal(item, category) {
    editingItemId = item ? item.id : null;
    fixedModalTitle.textContent = item ? 'Edit fixed expense' : 'Add fixed expense';
    fixedNameInput.value = item ? item.name : '';
    fixedCategorySelect.value = item ? item.category : category;
    fixedAmountInput.value = item ? item.amount : '';
    fixedFrequencySelect.value = item ? item.frequency : 'monthly';
    fixedDueMonthSelect.value = item && item.due_month ? item.due_month : new Date().getMonth() + 1;
    fixedDueDayInput.value = item && item.due_day ? item.due_day : '';
    fixedDeleteBtn.style.display = item ? 'block' : 'none';
    showDueFields();
    fixedModal.style.display = 'block';
}

async function reloadFixedItems() {
    const response = await fetch('/api/fixed-expenses', { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to load fixed expenses');
    fixedItems = await response.json();
}

// A category's goal has to at least cover its fixed expenses, so one that is
// unset or below them is raised to match. Never lowered: whatever was above
// them is the flexible part.
async function coverFixedItems(category) {
    const total = Math.round(fixedItemsTotal(category) * 100) / 100;
    if (goals[category] === undefined || goals[category] < total) await putGoal(category, total);
}

async function saveFixedItem() {
    const name = fixedNameInput.value.trim();
    const category = fixedCategorySelect.value;
    const amount = parseFloat(fixedAmountInput.value);
    const frequency = fixedFrequencySelect.value;
    const dueDay = fixedDueDayInput.value === '' ? null : Number(fixedDueDayInput.value);

    if (!name) return alert('Enter a name.');
    if (!category) return alert('Choose a category.');
    if (isNaN(amount) || amount <= 0) return alert('Enter an amount.');
    if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) {
        return alert('The due day is a day of the month, 1 to 31. Leave it blank for no due date.');
    }

    try {
        const response = await fetch(editingItemId ? `/api/fixed-expenses/${editingItemId}` : '/api/fixed-expenses', {
            method: editingItemId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                category,
                amount,
                frequency,
                due_day: dueDay,
                due_month: frequency === 'yearly' && dueDay !== null ? Number(fixedDueMonthSelect.value) : null
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save fixed expense');

        fixedModal.style.display = 'none';
        await reloadFixedItems();
        await coverFixedItems(category);
        expanded.add(category);
        render();
    } catch (error) {
        console.error('Save fixed expense error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteFixedItem() {
    if (!editingItemId || !confirm(`Delete ${fixedNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/fixed-expenses/${editingItemId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete fixed expense');

        fixedModal.style.display = 'none';
        await reloadFixedItems();
        render();
    } catch (error) {
        console.error('Delete fixed expense error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
