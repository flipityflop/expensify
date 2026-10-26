// Life insurance on the accounts page: one row per policy with what it pays
// out, what it costs, and - for term cover - when it stops.
//
// Loaded after helpers.js and cards.js - classic scripts share one top-level
// scope, so `money()`, `escapeHtml()`, `isoDate()` and `shortDate()` here are
// helpers.js's, `daysFrom()` cards.js's, `LIFE_INSURANCE_KINDS` and
// `fillCategorySelect()` categories.js's, and every name below is kept distinct
// from the ones the other sections declare.

const policyList = document.getElementById('policy-list');
const policyFigures = document.getElementById('policy-figures');
const policyModal = document.getElementById('policy-modal');
const policyModalTitle = document.getElementById('policy-modal-title');
const policyNameInput = document.getElementById('policy-name');
const policyKindSelect = document.getElementById('policy-kind');
const policyInsuredInput = document.getElementById('policy-insured');
const policyBenefitInput = document.getElementById('policy-benefit');
const policyPremiumInput = document.getElementById('policy-premium');
const policyFrequencySelect = document.getElementById('policy-frequency');
const policyTermEndInput = document.getElementById('policy-term-end');
const policyCashInput = document.getElementById('policy-cash');
const policyNotesInput = document.getElementById('policy-notes');
const policyDeleteBtn = document.getElementById('policy-delete');

let policies = [];
let editingPolicyId = null; // null while the modal is adding rather than editing

// Term cover ending this close is worth acting on: new cover needs fresh
// underwriting, and converting a term policy has to be done before it ends.
const TERM_WARNING_DAYS = 365;

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    fillCategorySelect(policyKindSelect, LIFE_INSURANCE_KINDS, null);

    document.getElementById('add-policy-btn').addEventListener('click', () => openPolicyModal(null));
    document.getElementById('policy-save').addEventListener('click', savePolicy);
    policyDeleteBtn.addEventListener('click', deletePolicy);

    policyList.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-policy-edit]');
        if (button) openPolicyModal(policies.find(p => p.id === Number(button.dataset.policyEdit)));
    });

    loadPolicies();
});

async function loadPolicies() {
    try {
        const response = await fetch('/api/life-insurance', { headers: getAuthHeaders() });
        if (response.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load policies');

        policies = await response.json();
        renderPolicies();
    } catch (error) {
        console.error('Error loading policies:', error);
        policyList.innerHTML = '<p class="empty-note" style="color: #ef4444;">Error loading policies.</p>';
    }
}

// A policy with no end date runs for life. One whose term ended before
// `today` (YYYY-MM-DD) covers nothing and costs nothing any more.
function policyInForce(policy, today) {
    return !policy.term_end || policy.term_end >= today;
}

// A yearly premium counts at a twelfth, as a yearly fixed expense does.
function monthlyPremium(policy) {
    return policy.premium_frequency === 'yearly' ? policy.premium / 12 : policy.premium;
}

// Policies in force first, largest payout first; ended ones go last.
function sortPolicies(list, today) {
    return [...list].sort((a, b) => policyInForce(b, today) - policyInForce(a, today) || b.death_benefit - a.death_benefit);
}

// Empty for a policy with no end date.
function termEndHtml(policy, today) {
    if (!policy.term_end) return '';
    if (!policyInForce(policy, today)) return `<span class="term-ended">ended ${shortDate(policy.term_end)}</span>`;

    const days = daysFrom(today, policy.term_end);
    if (days > TERM_WARNING_DAYS) return `ends ${shortDate(policy.term_end)}`;
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `<span class="renews-soon">ends ${shortDate(policy.term_end)} (${when})</span>`;
}

// Only what is known: a policy with no premium or cash value shows neither.
function policyRowHtml(policy, today) {
    const per = policy.premium_frequency === 'yearly' ? 'yr' : 'mo';
    const facts = [
        `<strong>${escapeHtml(policy.kind)}</strong>`,
        policy.insured ? escapeHtml(policy.insured) : '',
        policy.premium ? `${money(policy.premium)}/${per} premium` : '',
        policy.cash_value === null ? '' : `${money(policy.cash_value)} cash value`,
        termEndHtml(policy, today)
    ].filter(Boolean);

    return `
        <div class="acct-row">
            <div class="acct-row-head">
                <span class="acct-name">${escapeHtml(policy.name)}</span>
                <span class="acct-figure">${money(policy.death_benefit)}</span>
                <button type="button" class="small-btn" data-policy-edit="${policy.id}">Edit</button>
            </div>
            <div class="acct-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
            ${policy.notes ? `<div class="acct-meta">${escapeHtml(policy.notes)}</div>` : ''}
        </div>
    `;
}

// What the policies in force pay out between them, cost a month, and have
// built up in cash value.
function policyTotalsOf(list, today) {
    const inForce = list.filter(p => policyInForce(p, today));
    return {
        coverage: inForce.reduce((sum, p) => sum + p.death_benefit, 0),
        premium: inForce.reduce((sum, p) => sum + monthlyPremium(p), 0),
        cashValue: inForce.reduce((sum, p) => sum + (p.cash_value || 0), 0)
    };
}

function renderPolicies() {
    const today = isoDate(new Date());
    const totals = policyTotalsOf(policies, today);

    policyFigures.innerHTML = policies.length
        ? [
            `${money(totals.coverage)} coverage`,
            totals.premium ? `${money(totals.premium)}/mo premiums` : '',
            totals.cashValue ? `${money(totals.cashValue)} cash value` : ''
        ].filter(Boolean).join(' · ')
        : '';

    policyList.innerHTML = policies.length
        ? sortPolicies(policies, today).map(policy => policyRowHtml(policy, today)).join('')
        : '<p class="empty-note">No policies yet.</p>';
}

// One modal for both: `policy` is the one being edited, or null to add one.
function openPolicyModal(policy) {
    editingPolicyId = policy ? policy.id : null;
    policyModalTitle.textContent = policy ? 'Edit policy' : 'Add policy';
    policyNameInput.value = policy ? policy.name : '';
    policyKindSelect.value = policy ? policy.kind : LIFE_INSURANCE_KINDS[0];
    policyInsuredInput.value = policy ? policy.insured || '' : '';
    policyBenefitInput.value = policy ? policy.death_benefit : '';
    policyPremiumInput.value = policy && policy.premium ? policy.premium : '';
    policyFrequencySelect.value = policy ? policy.premium_frequency : 'monthly';
    policyTermEndInput.value = policy && policy.term_end ? policy.term_end : '';
    policyCashInput.value = policy && policy.cash_value !== null ? policy.cash_value : '';
    policyNotesInput.value = policy ? policy.notes || '' : '';
    policyDeleteBtn.style.display = policy ? 'block' : 'none';
    policyModal.style.display = 'block';
}

async function savePolicy() {
    const name = policyNameInput.value.trim();
    const benefit = policyBenefitInput.value === '' ? 0 : parseFloat(policyBenefitInput.value);
    const premium = policyPremiumInput.value === '' ? 0 : parseFloat(policyPremiumInput.value);
    const cashValue = policyCashInput.value === '' ? null : parseFloat(policyCashInput.value);

    if (!name) return alert('Enter a name.');
    if (!(benefit >= 0)) return alert('Death benefit must be 0 or more.');
    if (!(premium >= 0)) return alert('Premium must be 0 or more.');
    if (cashValue !== null && !(cashValue >= 0)) return alert('Cash value must be 0 or more.');

    try {
        const response = await fetch(editingPolicyId ? `/api/life-insurance/${editingPolicyId}` : '/api/life-insurance', {
            method: editingPolicyId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                kind: policyKindSelect.value,
                insured: policyInsuredInput.value.trim(),
                death_benefit: benefit,
                premium,
                premium_frequency: policyFrequencySelect.value,
                term_end: policyTermEndInput.value || null,
                cash_value: cashValue,
                notes: policyNotesInput.value.trim()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save policy');

        policyModal.style.display = 'none';
        await loadPolicies();
    } catch (error) {
        console.error('Save policy error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deletePolicy() {
    if (!editingPolicyId || !confirm(`Delete ${policyNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/life-insurance/${editingPolicyId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete policy');

        policyModal.style.display = 'none';
        await loadPolicies();
    } catch (error) {
        console.error('Delete policy error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
