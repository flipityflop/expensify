// The Goals page: a goal amount and the date it is wanted by, and the amount
// that has to go by each month to get there.
//
// Loaded after helpers.js - classic scripts share one top-level scope, so
// `money()`, `escapeHtml()`, `isoDate()` and `shortDate()` here are
// helpers.js's.

const goalList = document.getElementById('goal-list');
const goalTotals = document.getElementById('goal-totals');
const goalPlanLine = document.getElementById('goal-plan');
const goalModal = document.getElementById('goal-modal');
const goalModalTitle = document.getElementById('goal-modal-title');
const goalNameInput = document.getElementById('goal-name');
const goalTargetInput = document.getElementById('goal-target');
const goalDateInput = document.getElementById('goal-date');
const goalSavedInput = document.getElementById('goal-saved');
const goalNotesInput = document.getElementById('goal-notes');
const goalDeleteBtn = document.getElementById('goal-delete');
const putByModal = document.getElementById('put-by-modal');
const putBySelect = document.getElementById('put-by-goal');
const putByAmountInput = document.getElementById('put-by-amount');

let goals = [];
let planSavings = 0; // the budget plan's monthly savings row, what the goals come out of
let editingGoalId = null; // null while the modal is adding rather than editing

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;

    document.getElementById('add-goal-btn').addEventListener('click', () => openGoalModal(null));
    document.getElementById('goal-save').addEventListener('click', saveGoal);
    goalDeleteBtn.addEventListener('click', deleteGoal);
    document.getElementById('put-by-btn').addEventListener('click', openPutBy);
    document.getElementById('put-by-save').addEventListener('click', savePutBy);

    goalList.addEventListener('click', e => {
        const button = e.target.closest && e.target.closest('[data-goal-edit]');
        if (button) openGoalModal(goals.find(g => g.id === Number(button.dataset.goalEdit)));
    });

    loadGoals();
});

async function loadGoals() {
    try {
        const [goalResponse, planResponse] = await Promise.all([
            fetch('/api/savings-goals', { headers: getAuthHeaders() }),
            fetch('/api/budget-goals', { headers: getAuthHeaders() })
        ]);
        if (goalResponse.status === 401 || planResponse.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!goalResponse.ok || !planResponse.ok) throw new Error('Failed to load goals');

        goals = await goalResponse.json();
        const savings = (await planResponse.json()).find(row => row.category === '__savings__');
        planSavings = savings ? savings.amount : 0;
        renderGoals();
    } catch (error) {
        console.error('Error loading goals:', error);
        goalList.innerHTML = '<p class="empty-note" style="color: #ef4444;">Error loading goals.</p>';
    }
}

// Clamped: `saved` is stored capped at the target, but a goal whose target was
// later edited downwards can still have more saved than it needs.
function goalLeft(goal) {
    return Math.max(0, goal.target - goal.saved);
}

// Whole months from today to the goal's date - the ones there is still a month
// of saving to do in. 0 for a date inside the month ahead, negative once it has
// passed.
function monthsLeft(goal, today) {
    const [year, month, day] = goal.target_date.split('-').map(Number);
    const months = (year - today.getFullYear()) * 12 + (month - 1 - today.getMonth());
    return day < today.getDate() ? months - 1 : months;
}

// What has to go by each month to get there: what is left spread over the
// months left, and all of it at once with less than a month to go.
function monthlyNeeded(goal, today) {
    return goalLeft(goal) / Math.max(1, monthsLeft(goal, today));
}

// A goal is late when its date has passed with money still to find. One that
// is met needs nothing, whatever its date.
function isLate(goal, today) {
    return goalLeft(goal) > 0 && goal.target_date < isoDate(today);
}

// The date, and how far off it is. Red once it has passed with money still to
// find: the plan has already slipped.
function goalWhenHtml(goal, today) {
    if (isLate(goal, today)) return `<span class="over">past ${shortDate(goal.target_date)}</span>`;

    const months = monthsLeft(goal, today);
    const when = months <= 0 ? 'this month' : months === 1 ? 'in 1 month' : `in ${months} months`;
    return `by ${shortDate(goal.target_date)} · ${when}`;
}

function goalRowHtml(goal, today) {
    const left = goalLeft(goal);
    const percent = goal.target > 0 ? Math.min(100, (goal.saved / goal.target) * 100) : 0;
    const monthly = left ? `${money(monthlyNeeded(goal, today))}/mo` : 'Met';

    return `
        <div class="goal-row">
            <div class="goal-row-head">
                <span class="goal-name">${escapeHtml(goal.name)}</span>
                <span class="goal-figures">${money(goal.saved)} of ${money(goal.target)}</span>
                <button type="button" class="small-btn" data-goal-edit="${goal.id}">Edit</button>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${percent}%"></div>
            </div>
            <div class="goal-meta"><span class="goal-monthly">${monthly}</span> · ${goalWhenHtml(goal, today)}${goal.notes ? ` · ${escapeHtml(goal.notes)}` : ''}</div>
        </div>
    `;
}

// Soonest first, so a date already passed comes top: that is the one to deal with.
function sortGoals(list) {
    return [...list].sort((a, b) => a.target_date.localeCompare(b.target_date));
}

function goalTotalsOf(list, today) {
    return {
        target: list.reduce((sum, g) => sum + g.target, 0),
        saved: list.reduce((sum, g) => sum + Math.min(g.saved, g.target), 0),
        monthly: list.reduce((sum, g) => sum + monthlyNeeded(g, today), 0)
    };
}

// Said only when the goals ask for more a month than the plan sets aside for
// saving - money that would have to come from somewhere else.
function planLineHtml(monthly) {
    if (!planSavings || monthly <= planSavings) return '';
    return `<span class="over">${money(monthly - planSavings)}/mo over the plan's savings</span>`;
}

function renderGoals() {
    const today = new Date();
    const totals = goalTotalsOf(goals, today);

    goalTotals.innerHTML = `
        <div class="summary-item">
            <span class="summary-label">Needed / mo</span>
            <span class="summary-value">${money(totals.monthly)}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Saved</span>
            <span class="summary-value">${money(totals.saved)}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Goal</span>
            <span class="summary-value">${money(totals.target)}</span>
        </div>
    `;

    goalPlanLine.innerHTML = planLineHtml(totals.monthly);

    goalList.innerHTML = goals.length
        ? sortGoals(goals).map(goal => goalRowHtml(goal, today)).join('')
        : '<p class="empty-note">No goals yet.</p>';
}

// One modal for both: `goal` is the one being edited, or null to add one.
function openGoalModal(goal) {
    editingGoalId = goal ? goal.id : null;
    goalModalTitle.textContent = goal ? 'Edit goal' : 'Add goal';
    goalNameInput.value = goal ? goal.name : '';
    goalTargetInput.value = goal ? goal.target : '';
    goalDateInput.value = goal ? goal.target_date : '';
    goalSavedInput.value = goal && goal.saved ? goal.saved : '';
    goalNotesInput.value = goal ? goal.notes || '' : '';
    goalDeleteBtn.style.display = goal ? 'block' : 'none';
    goalModal.style.display = 'block';
}

async function saveGoal() {
    const name = goalNameInput.value.trim();
    const target = parseFloat(goalTargetInput.value);
    const saved = goalSavedInput.value === '' ? 0 : parseFloat(goalSavedInput.value);

    if (!name) return alert('Enter a name.');
    if (isNaN(target) || target <= 0) return alert('Enter a goal amount.');
    if (!goalDateInput.value) return alert('Enter a date.');
    if (!(saved >= 0)) return alert('Saved must be 0 or more.');

    try {
        const response = await fetch(editingGoalId ? `/api/savings-goals/${editingGoalId}` : '/api/savings-goals', {
            method: editingGoalId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                name,
                target,
                target_date: goalDateInput.value,
                saved,
                notes: goalNotesInput.value.trim()
            })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save goal');

        goalModal.style.display = 'none';
        await loadGoals();
    } catch (error) {
        console.error('Save goal error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

function openPutBy() {
    if (!goals.length) return alert('Add a goal first.');

    putBySelect.innerHTML = '';
    sortGoals(goals).forEach(g => putBySelect.appendChild(new Option(`${g.name} — ${money(goalLeft(g))} to go`, g.id)));
    putByAmountInput.value = '';
    putByModal.style.display = 'block';
}

async function savePutBy() {
    const amount = parseFloat(putByAmountInput.value);
    if (isNaN(amount) || amount <= 0) return alert('Enter an amount.');

    try {
        const response = await fetch(`/api/savings-goals/${putBySelect.value}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ amount })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to save');

        putByModal.style.display = 'none';
        await loadGoals();
    } catch (error) {
        console.error('Put by error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

async function deleteGoal() {
    if (!editingGoalId || !confirm(`Delete ${goalNameInput.value.trim()}?`)) return;

    try {
        const response = await fetch(`/api/savings-goals/${editingGoalId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete goal');

        goalModal.style.display = 'none';
        await loadGoals();
    } catch (error) {
        console.error('Delete goal error:', error);
        alert(`${error.message}. Please try again.`);
    }
}
