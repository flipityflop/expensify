// Debt tracker section of the budget page.
//
// Loaded after budget.js - classic scripts share one top-level scope, so
// `money()` here is budget.js's and every name below is kept distinct from the
// ones that file already declares.

const debtList = document.getElementById('debt-list');
const payoffBtn = document.getElementById('payoff-btn');
const addDebtBtn = document.getElementById('add-debt-btn');
const debtModal = document.getElementById('debt-modal');
const debtModalTitle = document.getElementById('debt-modal-title');
const debtNameInput = document.getElementById('debt-name');
const debtTotalInput = document.getElementById('debt-total');
const debtPaidInput = document.getElementById('debt-paid');
const debtAsOfInput = document.getElementById('debt-as-of');
const debtNotesInput = document.getElementById('debt-notes');
const debtDeleteBtn = document.getElementById('debt-delete');
const payoffModal = document.getElementById('payoff-modal');
const payoffSelect = document.getElementById('payoff-debt');
const payoffAmountInput = document.getElementById('payoff-amount');
const payoffDateInput = document.getElementById('payoff-date');

let debts = [];
let editingId = null; // null while the debt modal is adding rather than editing

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    payoffBtn.addEventListener('click', openPayoff);
    addDebtBtn.addEventListener('click', () => openDebtModal(null));
    document.getElementById('payoff-save').addEventListener('click', savePayoff);
    document.getElementById('debt-save').addEventListener('click', saveDebt);
    debtDeleteBtn.addEventListener('click', deleteDebt);

    // Every close control carries the id of the modal it closes, so the two
    // modals need one listener between them rather than four.
    document.addEventListener('click', e => {
        const closes = e.target.dataset && e.target.dataset.close;
        if (closes) document.getElementById(closes).style.display = 'none';
        else if (e.target === debtModal || e.target === payoffModal) e.target.style.display = 'none';
    });

    debtList.addEventListener('click', e => {
        const id = e.target.dataset && e.target.dataset.debtEdit;
        if (id) openDebtModal(debts.find(d => d.id === Number(id)));
    });

    loadDebts();
});

async function loadDebts() {
    try {
        const response = await fetch('/api/debts', { headers: getAuthHeaders() });
        if (response.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load debts');

        debts = await response.json();
        renderDebts();
    } catch (error) {
        console.error('Error loading debts:', error);
        debtList.innerHTML = '<p class="debt-empty" style="color: #ef4444;">Error loading debts.</p>';
    }
}

// Clamped: an overpayment is stored capped at the total, but a debt whose total
// was later edited downwards can still have paid > total.
function debtLeft(debt) {
    return Math.max(0, debt.total - debt.paid);
}

// Built from local parts rather than parsing the string as a date, which would
// be read as UTC and show the day before west of Greenwich.
function debtDate(isoDate) {
    if (!isoDate) return '—';
    const [year, month, day] = isoDate.split('-');
    return new Date(year, month - 1, day).toLocaleDateString();
}

// Debt names and notes are free text going into innerHTML.
function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The bar is what is left, not what is paid: it empties as the debt goes down.
function debtRowHtml(debt) {
    const left = debtLeft(debt);
    const percent = debt.total > 0 ? (left / debt.total) * 100 : 0;

    return `
        <div class="debt-row">
            <div class="debt-row-head">
                <span class="debt-name">${escapeHtml(debt.name)}</span>
                <span class="debt-figures">${money(left)} left of ${money(debt.total)}</span>
                <button type="button" class="debt-btn" data-debt-edit="${debt.id}">Edit</button>
            </div>
            <div class="progress-bar">
                <div class="progress-fill debt-fill" style="width: ${percent}%"></div>
            </div>
            <div class="debt-meta">as of ${debtDate(debt.as_of)}${debt.notes ? ` · ${escapeHtml(debt.notes)}` : ''}</div>
        </div>
    `;
}

function renderDebts() {
    debtList.innerHTML = debts.length
        ? debts.map(debtRowHtml).join('')
        : '<p class="debt-empty">No debts yet.</p>';
}

function todayValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function openPayoff() {
    if (!debts.length) return alert('Add a debt first.');

    payoffSelect.innerHTML = '';
    debts.forEach(d => payoffSelect.appendChild(new Option(`${d.name} — ${money(debtLeft(d))} left`, d.id)));
    payoffAmountInput.value = '';
    payoffDateInput.value = todayValue();
    payoffModal.style.display = 'block';
}

async function savePayoff() {
    const amount = parseFloat(payoffAmountInput.value);
    if (isNaN(amount) || amount <= 0) return alert('Enter an amount.');

    try {
        const response = await fetch(`/api/debts/${payoffSelect.value}/payoff`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ amount, date: payoffDateInput.value || todayValue() })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save payoff');

        payoffModal.style.display = 'none';
        await loadDebts();
    } catch (error) {
        console.error('Payoff error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

// One modal for both: `debt` is the row being edited, or null to add a new one.
function openDebtModal(debt) {
    editingId = debt ? debt.id : null;
    debtModalTitle.textContent = debt ? 'Edit debt' : 'Add new debt';
    debtNameInput.value = debt ? debt.name : '';
    debtTotalInput.value = debt ? debt.total : '';
    debtPaidInput.value = debt ? debt.paid : '';
    debtAsOfInput.value = debt ? debt.as_of || todayValue() : todayValue();
    debtNotesInput.value = debt ? debt.notes || '' : '';
    debtDeleteBtn.style.display = debt ? 'block' : 'none';
    debtModal.style.display = 'block';
}

async function saveDebt() {
    const name = debtNameInput.value.trim();
    const total = parseFloat(debtTotalInput.value);
    const paid = debtPaidInput.value === '' ? 0 : parseFloat(debtPaidInput.value);

    if (!name) return alert('Enter a name.');
    if (isNaN(total) || total <= 0) return alert('Enter a total.');
    if (isNaN(paid) || paid < 0) return alert('Paid off must be 0 or more.');

    try {
        const response = await fetch(editingId ? `/api/debts/${editingId}` : '/api/debts', {
            method: editingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                total,
                paid,
                notes: debtNotesInput.value.trim(),
                as_of: debtAsOfInput.value || todayValue()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save debt');

        debtModal.style.display = 'none';
        await loadDebts();
    } catch (error) {
        console.error('Save debt error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteDebt() {
    if (!editingId || !confirm(`Delete ${debtNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/debts/${editingId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete debt');

        debtModal.style.display = 'none';
        await loadDebts();
    } catch (error) {
        console.error('Delete debt error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
