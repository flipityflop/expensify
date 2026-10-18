// Investment accounts on the accounts page: what each one holds and what goes
// into it every month. Retirement accounts are retirement.js, which projects
// them forward as well; these are only tracked.
//
// Loaded after helpers.js and cards.js - classic scripts share one top-level
// scope, so `money()`, `escapeHtml()`, `isoDate()` and `shortDate()` here are
// helpers.js's, `INVESTMENT_KINDS` and `fillCategorySelect()` categories.js's,
// and every name below is kept distinct from the ones the other sections
// declare.

const investmentList = document.getElementById('investment-list');
const investmentFigures = document.getElementById('investment-figures');
const investmentModal = document.getElementById('investment-modal');
const investmentModalTitle = document.getElementById('investment-modal-title');
const investmentNameInput = document.getElementById('investment-name');
const investmentKindSelect = document.getElementById('investment-kind');
const investmentBalanceInput = document.getElementById('investment-balance');
const investmentAsOfInput = document.getElementById('investment-as-of');
const investmentContributionInput = document.getElementById('investment-contribution');
const investmentNotesInput = document.getElementById('investment-notes');
const investmentDeleteBtn = document.getElementById('investment-delete');

let investments = [];
let editingInvestmentId = null; // null while the modal is adding rather than editing

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    fillCategorySelect(investmentKindSelect, INVESTMENT_KINDS, null);

    document.getElementById('add-investment-btn').addEventListener('click', () => openInvestmentModal(null));
    document.getElementById('investment-save').addEventListener('click', saveInvestment);
    investmentDeleteBtn.addEventListener('click', deleteInvestment);
    // A new balance was just read off the account, so it is current as of today.
    investmentBalanceInput.addEventListener('input', () => { investmentAsOfInput.value = isoDate(new Date()); });

    investmentList.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-investment-edit]');
        if (button) openInvestmentModal(investments.find(a => a.id === Number(button.dataset.investmentEdit)));
    });

    loadInvestments();
});

async function loadInvestments() {
    try {
        const response = await fetch('/api/investment-accounts', { headers: getAuthHeaders() });
        if (response.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load investment accounts');

        investments = await response.json();
        renderInvestments();
    } catch (error) {
        console.error('Error loading investment accounts:', error);
        investmentList.innerHTML = '<p class="empty-note" style="color: #ef4444;">Error loading investment accounts.</p>';
    }
}

// Largest first: the account carrying the most reads first.
function sortInvestments(list) {
    return [...list].sort((a, b) => b.balance - a.balance);
}

// Only what is known: an account with nothing going in says nothing about it.
function investmentRowHtml(account) {
    const facts = [
        `<strong>${escapeHtml(account.kind)}</strong>`,
        account.contribution ? `${money(account.contribution)}/mo in` : ''
    ].filter(Boolean);

    return `
        <div class="acct-row">
            <div class="acct-row-head">
                <span class="acct-name">${escapeHtml(account.name)}</span>
                <span class="acct-figure">${money(account.balance)}</span>
                <button type="button" class="small-btn" data-investment-edit="${account.id}">Edit</button>
            </div>
            <div class="acct-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
            <div class="acct-meta">${account.balance_as_of ? `as of ${shortDate(account.balance_as_of)}` : ''}${account.balance_as_of && account.notes ? ' · ' : ''}${account.notes ? escapeHtml(account.notes) : ''}</div>
        </div>
    `;
}

// What the accounts hold between them, and what goes in every month.
function investmentTotalsOf(list) {
    return {
        balance: list.reduce((sum, a) => sum + a.balance, 0),
        contribution: list.reduce((sum, a) => sum + (a.contribution || 0), 0)
    };
}

function renderInvestments() {
    const totals = investmentTotalsOf(investments);

    investmentFigures.innerHTML = investments.length
        ? [money(totals.balance), totals.contribution ? `${money(totals.contribution)}/mo in` : '']
            .filter(Boolean).join(' · ')
        : '';

    investmentList.innerHTML = investments.length
        ? sortInvestments(investments).map(investmentRowHtml).join('')
        : '<p class="empty-note">No investment accounts yet.</p>';
}

// One modal for both: `account` is the one being edited, or null to add one.
function openInvestmentModal(account) {
    editingInvestmentId = account ? account.id : null;
    investmentModalTitle.textContent = account ? 'Edit account' : 'Add account';
    investmentNameInput.value = account ? account.name : '';
    investmentKindSelect.value = account ? account.kind : INVESTMENT_KINDS[0];
    investmentBalanceInput.value = account ? account.balance : '';
    investmentAsOfInput.value = account && account.balance_as_of ? account.balance_as_of : isoDate(new Date());
    investmentContributionInput.value = account && account.contribution ? account.contribution : '';
    investmentNotesInput.value = account ? account.notes || '' : '';
    investmentDeleteBtn.style.display = account ? 'block' : 'none';
    investmentModal.style.display = 'block';
}

async function saveInvestment() {
    const name = investmentNameInput.value.trim();
    const balance = investmentBalanceInput.value === '' ? 0 : parseFloat(investmentBalanceInput.value);
    const contribution = investmentContributionInput.value === '' ? 0 : parseFloat(investmentContributionInput.value);

    if (!name) return alert('Enter a name.');
    if (!(balance >= 0)) return alert('Balance must be 0 or more.');
    if (!(contribution >= 0)) return alert('Monthly contribution must be 0 or more.');

    try {
        const response = await fetch(editingInvestmentId ? `/api/investment-accounts/${editingInvestmentId}` : '/api/investment-accounts', {
            method: editingInvestmentId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                kind: investmentKindSelect.value,
                balance,
                balance_as_of: investmentAsOfInput.value || isoDate(new Date()),
                contribution,
                notes: investmentNotesInput.value.trim()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save account');

        investmentModal.style.display = 'none';
        await loadInvestments();
    } catch (error) {
        console.error('Save investment account error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteInvestment() {
    if (!editingInvestmentId || !confirm(`Delete ${investmentNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/investment-accounts/${editingInvestmentId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete account');

        investmentModal.style.display = 'none';
        await loadInvestments();
    } catch (error) {
        console.error('Delete investment account error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
