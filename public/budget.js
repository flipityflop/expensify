const monthInput = document.getElementById('month');
const tbody = document.getElementById('budget-tbody');
const tfoot = document.getElementById('budget-tfoot');
const yearlyTbody = document.getElementById('yearly-tbody');
const monthlyHeading = document.getElementById('monthly-heading');
const yearlyHeading = document.getElementById('yearly-heading');
const autofillBtn = document.getElementById('autofill');
const progressLabel = document.getElementById('progress-label');
const progressFigures = document.getElementById('progress-figures');
const progressFill = document.getElementById('budget-progress-fill');
const loadingDiv = document.getElementById('loading');

let expenses = [];
let goals = {}; // category -> goal amount

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) {
        return;
    }

    // Built from local parts, not toISOString(), which is UTC and would land on
    // the next month late in the evening on the last day of a month.
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    monthInput.addEventListener('change', render);
    autofillBtn.addEventListener('click', autofill);
    // 'change' on a number input already means blur-with-a-new-value or Enter.
    // Delegated from the document so both tables are covered by one listener.
    document.addEventListener('change', e => {
        if (e.target.dataset && e.target.dataset.category) {
            saveGoal(e.target.dataset.category, e.target.value);
        }
    });

    load();
});

async function load() {
    try {
        const [expensesRes, goalsRes] = await Promise.all([
            fetch('/api/expenses', { headers: getAuthHeaders() }),
            fetch('/api/budget-goals', { headers: getAuthHeaders() })
        ]);

        if (expensesRes.status === 401 || goalsRes.status === 401) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!expensesRes.ok || !goalsRes.ok) throw new Error('Failed to load budget');

        expenses = await expensesRes.json();
        (await goalsRes.json()).forEach(goal => goals[goal.category] = goal.amount);

        loadingDiv.style.display = 'none';
        render();
    } catch (error) {
        console.error('Error loading budget:', error);
        loadingDiv.innerHTML = '<p style="color: #ef4444;">Error loading budget. Please try again.</p>';
    }
}

// expense_date is a YYYY-MM-DD string, so a prefix match is exact and skips the
// timezone shift new Date() would introduce at a month or year boundary.
// `prefix` is YYYY-MM for a month, YYYY for a year.
function spentIn(category, prefix) {
    return expenses
        .filter(e => !e.is_positive && e.category === category && e.expense_date.startsWith(prefix))
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);
}

function actual(category, month) {
    return spentIn(category, goalPeriod(category) === 'yearly' ? month.slice(0, 4) : month);
}

// Mean spend per month across every month before the selected one. Divides by
// all months that hold any expense, not just the months this category appears
// in - a month you spent nothing on Gifts is still a month you budgeted for it.
// Returns null when there is no earlier month to average.
function averageMonthly(category, month) {
    const past = expenses.filter(e => !e.is_positive && e.expense_date.slice(0, 7) < month);
    const months = new Set(past.map(e => e.expense_date.slice(0, 7))).size;
    if (!months) return null;

    const total = past
        .filter(e => e.category === category)
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);

    return Math.round((total / months) * 100) / 100;
}

function money(amount) {
    return `$${amount.toFixed(2)}`;
}

function diffCell(diff) {
    if (diff === null) return '<td>—</td>';
    return `<td class="${diff >= 0 ? 'under' : 'over'}">${diff < 0 ? '-' : '+'}${money(Math.abs(diff))}</td>`;
}

function rowHtml(category, month) {
    const goal = goals[category];
    const spent = actual(category, month);

    return `
        <tr>
            <td>${category}</td>
            <td>${goal === undefined ? '—' : money(goal)}</td>
            <td>${money(spent)}</td>
            ${diffCell(goal === undefined ? null : goal - spent)}
            <td><input type="number" class="goal-input" step="0.01" min="0" data-category="${category}" value="${goal ?? ''}"></td>
        </tr>
    `;
}

function render() {
    const month = monthInput.value;
    if (!month) return;

    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const yearly = CATEGORIES.filter(c => goalPeriod(c) === 'yearly');

    tbody.innerHTML = monthly.map(c => rowHtml(c, month)).join('');
    yearlyTbody.innerHTML = yearly.map(c => rowHtml(c, month)).join('');

    // Which period each table covers, so the two Actual columns are not read
    // as the same span of time. Mid-month date, so no timezone edge case.
    const [year, mon] = month.split('-');
    const label = new Date(year, mon - 1, 15).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    monthlyHeading.textContent = `Monthly goals — ${label}`;
    yearlyHeading.textContent = `Yearly goals — ${year}`;

    // Totals cover the monthly table only; a year's goal against a month's
    // spending would not add up to anything meaningful.
    const goalTotal = monthly.reduce((sum, c) => sum + (goals[c] || 0), 0);
    const actualTotal = monthly.reduce((sum, c) => sum + actual(c, month), 0);

    tfoot.innerHTML = `
        <tr>
            <td>Monthly totals</td>
            <td>${money(goalTotal)}</td>
            <td>${money(actualTotal)}</td>
            ${diffCell(goalTotal - actualTotal)}
            <td></td>
        </tr>
    `;

    renderProgress(month, label);
}

// One bar for all 21 categories, everything put on a monthly footing: a yearly
// goal counts at a twelfth, against that category's spend in this month only.
// Adding a whole year's Travel to one month of Groceries would not mean anything.
function renderProgress(month, label) {
    const budget = CATEGORIES.reduce((sum, c) => {
        const goal = goals[c];
        if (goal === undefined) return sum;
        return sum + (goalPeriod(c) === 'yearly' ? goal / 12 : goal);
    }, 0);

    const spend = expenses
        .filter(e => !e.is_positive && e.expense_date.startsWith(month))
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);

    progressLabel.textContent = `Total spend — ${label}`;
    progressFigures.textContent = budget
        ? `${money(spend)} of ${money(budget)}`
        : `${money(spend)} — no goals set yet`;

    progressFill.style.width = `${budget ? Math.min(100, (spend / budget) * 100) : 0}%`;
    progressFill.classList.toggle('over', budget > 0 && spend > budget);
}

async function putGoal(category, amount) {
    const response = await fetch('/api/budget-goals', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
        },
        body: JSON.stringify({ category, amount, period: goalPeriod(category) })
    });

    if (!response.ok) throw new Error(`Failed to save ${category}`);
    goals[category] = amount;
}

async function saveGoal(category, value) {
    const amount = parseFloat(value);
    if (isNaN(amount)) return render(); // cleared field: put the stored goal back

    try {
        await putGoal(category, amount);
        render();
    } catch (error) {
        console.error('Save error:', error);
        alert('Error saving budget goal. Please try again.');
    }
}

// Yearly goals are left out: a twelve-month total is not an average of months.
async function autofill() {
    const month = monthInput.value;
    const averages = CATEGORIES
        .filter(c => goalPeriod(c) !== 'yearly')
        .map(c => [c, averageMonthly(c, month)])
        .filter(([, avg]) => avg !== null);

    if (!averages.length) {
        return alert(`No months before ${month} to average.`);
    }
    if (!confirm(`Overwrite ${averages.length} monthly goals with the average spend before ${month}?`)) {
        return;
    }

    autofillBtn.disabled = true;
    try {
        for (const [category, amount] of averages) {
            await putGoal(category, amount);
        }
        render();
    } catch (error) {
        console.error('Autofill error:', error);
        alert(`${error.message}. Some goals may not have been saved.`);
        render();
    } finally {
        autofillBtn.disabled = false;
    }
}
