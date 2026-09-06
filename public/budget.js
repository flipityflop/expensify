const monthInput = document.getElementById('month');
const tbody = document.getElementById('budget-tbody');
const tfoot = document.getElementById('budget-tfoot');
const yearlyTbody = document.getElementById('yearly-tbody');
const monthlyHeading = document.getElementById('monthly-heading');
const yearlyHeading = document.getElementById('yearly-heading');
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
// timezone shift new Date() would introduce at a month boundary. Yearly
// categories match on the year alone.
function actual(category, month) {
    const prefix = goalPeriod(category) === 'yearly' ? month.slice(0, 4) : month;

    return expenses
        .filter(e => !e.is_positive && e.category === category && e.expense_date.startsWith(prefix))
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);
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
}

async function saveGoal(category, value) {
    const amount = parseFloat(value);
    if (isNaN(amount)) return render(); // cleared field: put the stored goal back

    try {
        const response = await fetch('/api/budget-goals', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({ category, amount, period: goalPeriod(category) })
        });

        if (!response.ok) throw new Error('Failed to save goal');

        goals[category] = amount;
        render();
    } catch (error) {
        console.error('Save error:', error);
        alert('Error saving budget goal. Please try again.');
    }
}
