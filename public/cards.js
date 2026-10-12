// Credit cards on the cards page: one row per card with what it costs to keep
// - the balance, its APR and the interest that comes to, and the annual fee
// and when it next renews. The debt tracker below it is debts.js.
//
// Loaded after helpers.js - classic scripts share one top-level scope, so
// `money()`, `escapeHtml()` and `isoDate()` here are helpers.js's.

const cardList = document.getElementById('card-list');
const cardTotals = document.getElementById('card-totals');
const cardModal = document.getElementById('card-modal');
const cardModalTitle = document.getElementById('card-modal-title');
const cardNameInput = document.getElementById('card-name');
const cardBalanceInput = document.getElementById('card-balance');
const cardAsOfInput = document.getElementById('card-as-of');
const cardAprInput = document.getElementById('card-apr');
const cardFeeInput = document.getElementById('card-fee');
const cardRenewalInput = document.getElementById('card-renewal');
const cardNotesInput = document.getElementById('card-notes');
const cardDeleteBtn = document.getElementById('card-delete');

let cards = [];
let editingCardId = null; // null while the card modal is adding rather than editing

// A renewal this close is worth acting on: calling for a retention offer, or
// cancelling before the fee posts.
const RENEWAL_WARNING_DAYS = 30;

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    document.getElementById('add-card-btn').addEventListener('click', () => openCardModal(null));
    document.getElementById('card-save').addEventListener('click', saveCard);
    cardDeleteBtn.addEventListener('click', deleteCard);
    // A new balance was just read off the card, so it is current as of today.
    cardBalanceInput.addEventListener('input', () => { cardAsOfInput.value = isoDate(new Date()); });

    cardList.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-card-edit]');
        if (button) openCardModal(cards.find(c => c.id === Number(button.dataset.cardEdit)));
    });

    loadCards();
});

async function loadCards() {
    try {
        const response = await fetch('/api/credit-cards', { headers: getAuthHeaders() });
        if (response.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load cards');

        cards = await response.json();
        renderCards();
    } catch (error) {
        console.error('Error loading cards:', error);
        cardList.innerHTML = '<p class="empty-note" style="color: #ef4444;">Error loading cards.</p>';
    }
}

// What carrying the balance for a month costs: a twelfth of a year's interest
// at the card's APR. An estimate - cards charge daily on the average balance -
// and nothing is charged on a balance paid in full by the due date.
function monthlyInterest(card) {
    if (!card.apr || card.balance <= 0) return 0;
    return card.balance * card.apr / 100 / 12;
}

// The next day, on or after `today` (YYYY-MM-DD), the annual fee posts. A
// stored date still ahead is used as it is - a first year with the fee waived
// can put it more than a year out. One already passed rolls forward a year at
// a time; 29 February falls on the 28th outside a leap year. null when no
// date is set.
function nextRenewal(card, today) {
    if (!card.fee_renewal) return null;
    if (card.fee_renewal >= today) return card.fee_renewal;
    const [, month, day] = card.fee_renewal.split('-').map(Number);
    const on = year => isoDate(new Date(year, month - 1, Math.min(day, new Date(year, month, 0).getDate())));
    const year = Number(today.slice(0, 4));
    return on(year) >= today ? on(year) : on(year + 1);
}

// Whole days from one YYYY-MM-DD to another. Both parse as UTC midnight, so
// there is no daylight-saving hour to round away.
function daysFrom(from, to) {
    return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

// Built from local parts rather than parsing the string as a date, which would
// be read as UTC and show the day before west of Greenwich.
function cardDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Highest APR first: money paid beyond the minimum saves the most interest
// there. Cards with no APR set go last; ties by the larger balance.
function sortCards(list) {
    return [...list].sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1) || b.balance - a.balance);
}

function renewalHtml(card, today) {
    if (!card.annual_fee) return 'No annual fee';
    const renewal = nextRenewal(card, today);
    if (!renewal) return `${money(card.annual_fee)} annual fee · renewal date not set`;

    const days = daysFrom(today, renewal);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `<span${days <= RENEWAL_WARNING_DAYS ? ' class="renews-soon"' : ''}>`
        + `${money(card.annual_fee)} annual fee · renews ${cardDate(renewal)} (${when})</span>`;
}

function cardRowHtml(card, today) {
    const interest = monthlyInterest(card);
    const facts = [
        card.apr === null ? 'APR not set' : `<strong>${card.apr}%</strong> APR`,
        interest ? `≈ ${money(interest)} interest a month` : null,
        renewalHtml(card, today)
    ].filter(Boolean);

    return `
        <div class="card-row">
            <div class="card-row-head">
                <span class="card-name">${escapeHtml(card.name)}</span>
                <span class="card-balance">${money(card.balance)}</span>
                <button type="button" class="small-btn" data-card-edit="${card.id}">Edit</button>
            </div>
            <div class="card-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
            <div class="card-meta">balance as of ${card.balance_as_of ? cardDate(card.balance_as_of) : '—'}${card.notes ? ` · ${escapeHtml(card.notes)}` : ''}</div>
        </div>
    `;
}

// Totals across every card: what is owed, what that costs a month, and what
// the fees come to a year.
function cardTotalsOf(list) {
    return {
        balance: list.reduce((sum, c) => sum + c.balance, 0),
        interest: list.reduce((sum, c) => sum + monthlyInterest(c), 0),
        fees: list.reduce((sum, c) => sum + (c.annual_fee || 0), 0)
    };
}

function renderCards() {
    const today = isoDate(new Date());
    const totals = cardTotalsOf(cards);

    cardTotals.innerHTML = `
        <div class="summary-item">
            <span class="summary-label">Owed on cards</span>
            <span class="summary-value">${money(totals.balance)}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Interest a month</span>
            <span class="summary-value${totals.interest ? ' expense' : ''}">≈ ${money(totals.interest)}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Annual fees</span>
            <span class="summary-value">${money(totals.fees)}</span>
        </div>
    `;

    cardList.innerHTML = cards.length
        ? sortCards(cards).map(card => cardRowHtml(card, today)).join('')
        : '<p class="empty-note">No cards yet.</p>';
}

// One modal for both: `card` is the one being edited, or null to add a new one.
function openCardModal(card) {
    editingCardId = card ? card.id : null;
    cardModalTitle.textContent = card ? 'Edit card' : 'Add card';
    cardNameInput.value = card ? card.name : '';
    cardBalanceInput.value = card ? card.balance : '';
    cardAsOfInput.value = card && card.balance_as_of ? card.balance_as_of : isoDate(new Date());
    cardAprInput.value = card && card.apr !== null ? card.apr : '';
    cardFeeInput.value = card && card.annual_fee ? card.annual_fee : '';
    cardRenewalInput.value = card && card.fee_renewal ? card.fee_renewal : '';
    cardNotesInput.value = card ? card.notes || '' : '';
    cardDeleteBtn.style.display = card ? 'block' : 'none';
    cardModal.style.display = 'block';
}

async function saveCard() {
    const name = cardNameInput.value.trim();
    const balance = cardBalanceInput.value === '' ? 0 : parseFloat(cardBalanceInput.value);
    const apr = cardAprInput.value === '' ? null : parseFloat(cardAprInput.value);
    const fee = cardFeeInput.value === '' ? 0 : parseFloat(cardFeeInput.value);

    if (!name) return alert('Enter a name.');
    if (isNaN(balance)) return alert('Enter the balance, or leave it blank for none.');
    if (apr !== null && !(apr >= 0 && apr <= 100)) return alert('The APR is a percentage, 0 to 100.');
    if (!(fee >= 0)) return alert('The annual fee is 0 or more. Leave it blank for none.');

    try {
        const response = await fetch(editingCardId ? `/api/credit-cards/${editingCardId}` : '/api/credit-cards', {
            method: editingCardId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                balance,
                balance_as_of: cardAsOfInput.value || isoDate(new Date()),
                apr,
                annual_fee: fee,
                fee_renewal: cardRenewalInput.value || null,
                notes: cardNotesInput.value.trim()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save card');

        cardModal.style.display = 'none';
        await loadCards();
    } catch (error) {
        console.error('Save card error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteCard() {
    if (!editingCardId || !confirm(`Delete ${cardNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/credit-cards/${editingCardId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete card');

        cardModal.style.display = 'none';
        await loadCards();
    } catch (error) {
        console.error('Delete card error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
