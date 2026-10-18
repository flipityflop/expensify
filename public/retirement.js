// Retirement accounts on the accounts page, and the growth projected from
// them: each account has a rate of return typed by hand, and the table under
// the list compounds the balances and the monthly contributions forward at
// those rates.
//
// Loaded after helpers.js, cards.js and investments.js - classic scripts share
// one top-level scope, so `money()`, `escapeHtml()`, `isoDate()` and
// `shortDate()` here are helpers.js's, `RETIREMENT_KINDS` and
// `fillCategorySelect()` categories.js's, and every name below is kept distinct
// from the ones the other sections declare.

const retirementList = document.getElementById('retirement-list');
const retirementFigures = document.getElementById('retirement-figures');
const projectionBlock = document.getElementById('projection');
const projectionBody = document.getElementById('projection-tbody');
const retirementModal = document.getElementById('retirement-modal');
const retirementModalTitle = document.getElementById('retirement-modal-title');
const retirementNameInput = document.getElementById('retirement-name');
const retirementKindSelect = document.getElementById('retirement-kind');
const retirementBalanceInput = document.getElementById('retirement-balance');
const retirementAsOfInput = document.getElementById('retirement-as-of');
const retirementReturnInput = document.getElementById('retirement-return');
const retirementContributionInput = document.getElementById('retirement-contribution');
const retirementNotesInput = document.getElementById('retirement-notes');
const retirementDeleteBtn = document.getElementById('retirement-delete');

let retirementAccounts = [];
let editingRetirementId = null; // null while the modal is adding rather than editing

// How far ahead the projection goes, in years. Close together early, where a
// difference is still worth planning around, and further apart later.
const PROJECTION_YEARS = [1, 5, 10, 15, 20, 25, 30];

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    fillCategorySelect(retirementKindSelect, RETIREMENT_KINDS, null);

    document.getElementById('add-retirement-btn').addEventListener('click', () => openRetirementModal(null));
    document.getElementById('retirement-save').addEventListener('click', saveRetirement);
    retirementDeleteBtn.addEventListener('click', deleteRetirement);
    // A new balance was just read off the account, so it is current as of today.
    retirementBalanceInput.addEventListener('input', () => { retirementAsOfInput.value = isoDate(new Date()); });

    retirementList.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-retirement-edit]');
        if (button) openRetirementModal(retirementAccounts.find(a => a.id === Number(button.dataset.retirementEdit)));
    });

    loadRetirement();
});

async function loadRetirement() {
    try {
        const response = await fetch('/api/retirement-accounts', { headers: getAuthHeaders() });
        if (response.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load retirement accounts');

        retirementAccounts = await response.json();
        renderRetirement();
    } catch (error) {
        console.error('Error loading retirement accounts:', error);
        retirementList.innerHTML = '<p class="empty-note" style="color: #ef4444;">Error loading retirement accounts.</p>';
    }
}

// What an account is worth in `years`: the balance compounded at its rate of
// return, plus the monthly contributions compounded from the month each one
// goes in. Monthly compounding, which is how a fund quoting an annual return
// actually grows. With no rate set it is the balance plus what is paid in.
function futureValue(account, years) {
    const months = Math.round(years * 12);
    const paidIn = (account.contribution || 0) * months;
    const rate = (account.annual_return || 0) / 100 / 12;
    if (!rate) return account.balance + paidIn;

    const compounded = Math.pow(1 + rate, months);
    return account.balance * compounded + (account.contribution || 0) * (compounded - 1) / rate;
}

// One row per horizon: the combined balance then, what was paid in to get
// there, and the growth that made up the rest.
function projectRetirement(list, thisYear) {
    const balanceNow = list.reduce((sum, a) => sum + a.balance, 0);
    const monthly = list.reduce((sum, a) => sum + (a.contribution || 0), 0);

    return PROJECTION_YEARS.map(years => {
        const balance = list.reduce((sum, a) => sum + futureValue(a, years), 0);
        const paidIn = monthly * years * 12;
        return { years, year: thisYear + years, balance, paidIn, growth: balance - balanceNow - paidIn };
    });
}

// Largest first, as the investment accounts are listed.
function sortRetirement(list) {
    return [...list].sort((a, b) => b.balance - a.balance);
}

// Only what is known: an account with no rate of return shows none.
function retirementRowHtml(account) {
    const facts = [
        `<strong>${escapeHtml(account.kind)}</strong>`,
        account.annual_return === null ? '' : `${account.annual_return}% return`,
        account.contribution ? `${money(account.contribution)}/mo in` : ''
    ].filter(Boolean);

    return `
        <div class="acct-row">
            <div class="acct-row-head">
                <span class="acct-name">${escapeHtml(account.name)}</span>
                <span class="acct-figure">${money(account.balance)}</span>
                <button type="button" class="small-btn" data-retirement-edit="${account.id}">Edit</button>
            </div>
            <div class="acct-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
            <div class="acct-meta">${account.balance_as_of ? `as of ${shortDate(account.balance_as_of)}` : ''}${account.balance_as_of && account.notes ? ' · ' : ''}${account.notes ? escapeHtml(account.notes) : ''}</div>
        </div>
    `;
}

// The bar is the balance against the furthest year's, so the rows read as one
// curve rather than seven full bars.
function projectionRowHtml(row, largest) {
    const percent = largest > 0 ? Math.max(0, row.balance / largest) * 100 : 0;

    return `
        <tr>
            <td>${row.year}<span class="years-out">in ${row.years} ${row.years === 1 ? 'year' : 'years'}</span></td>
            <td>${money(row.balance)}</td>
            <td>${money(row.growth)}</td>
            <td>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${percent}%"></div>
                </div>
            </td>
        </tr>
    `;
}

function retirementTotalsOf(list) {
    return {
        balance: list.reduce((sum, a) => sum + a.balance, 0),
        contribution: list.reduce((sum, a) => sum + (a.contribution || 0), 0)
    };
}

function renderRetirement() {
    const totals = retirementTotalsOf(retirementAccounts);

    retirementFigures.innerHTML = retirementAccounts.length
        ? [money(totals.balance), totals.contribution ? `${money(totals.contribution)}/mo in` : '']
            .filter(Boolean).join(' · ')
        : '';

    retirementList.innerHTML = retirementAccounts.length
        ? sortRetirement(retirementAccounts).map(retirementRowHtml).join('')
        : '<p class="empty-note">No retirement accounts yet.</p>';

    renderProjection();
}

// Nothing to project with no accounts, or with nothing in them and nothing
// going in: the table would be seven rows of $0.00.
function renderProjection() {
    const rows = projectRetirement(retirementAccounts, new Date().getFullYear());
    const largest = rows.length ? rows[rows.length - 1].balance : 0;

    projectionBlock.style.display = largest > 0 ? 'block' : 'none';
    projectionBody.innerHTML = rows.map(row => projectionRowHtml(row, largest)).join('');
}

// One modal for both: `account` is the one being edited, or null to add one.
function openRetirementModal(account) {
    editingRetirementId = account ? account.id : null;
    retirementModalTitle.textContent = account ? 'Edit account' : 'Add account';
    retirementNameInput.value = account ? account.name : '';
    retirementKindSelect.value = account ? account.kind : RETIREMENT_KINDS[0];
    retirementBalanceInput.value = account ? account.balance : '';
    retirementAsOfInput.value = account && account.balance_as_of ? account.balance_as_of : isoDate(new Date());
    retirementReturnInput.value = account && account.annual_return !== null ? account.annual_return : '';
    retirementContributionInput.value = account && account.contribution ? account.contribution : '';
    retirementNotesInput.value = account ? account.notes || '' : '';
    retirementDeleteBtn.style.display = account ? 'block' : 'none';
    retirementModal.style.display = 'block';
}

async function saveRetirement() {
    const name = retirementNameInput.value.trim();
    const balance = retirementBalanceInput.value === '' ? 0 : parseFloat(retirementBalanceInput.value);
    const annualReturn = retirementReturnInput.value === '' ? null : parseFloat(retirementReturnInput.value);
    const contribution = retirementContributionInput.value === '' ? 0 : parseFloat(retirementContributionInput.value);

    if (!name) return alert('Enter a name.');
    if (!(balance >= 0)) return alert('Balance must be 0 or more.');
    if (annualReturn !== null && !(annualReturn >= -100 && annualReturn <= 100)) return alert('Annual return must be -100–100.');
    if (!(contribution >= 0)) return alert('Monthly contribution must be 0 or more.');

    try {
        const response = await fetch(editingRetirementId ? `/api/retirement-accounts/${editingRetirementId}` : '/api/retirement-accounts', {
            method: editingRetirementId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                kind: retirementKindSelect.value,
                balance,
                balance_as_of: retirementAsOfInput.value || isoDate(new Date()),
                annual_return: annualReturn,
                contribution,
                notes: retirementNotesInput.value.trim()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save account');

        retirementModal.style.display = 'none';
        await loadRetirement();
    } catch (error) {
        console.error('Save retirement account error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteRetirement() {
    if (!editingRetirementId || !confirm(`Delete ${retirementNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/retirement-accounts/${editingRetirementId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete account');

        retirementModal.style.display = 'none';
        await loadRetirement();
    } catch (error) {
        console.error('Delete retirement account error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
