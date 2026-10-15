const monthInput = document.getElementById('month');
const tbody = document.getElementById('budget-tbody');
const tfoot = document.getElementById('budget-tfoot');
const yearlyTbody = document.getElementById('yearly-tbody');
const monthlyHeading = document.getElementById('monthly-heading');
const planLeft = document.getElementById('plan-left');
const planBreakdown = document.getElementById('plan-breakdown');
const progressLabel = document.getElementById('progress-label');
const progressFigures = document.getElementById('progress-figures');
const progressFill = document.getElementById('budget-progress-fill');
const loadingDiv = document.getElementById('loading');

let expenses = [];
let goals = {}; // category -> goal amount: yearly goals and the plan; monthly budgets are worked out
let targets = {}; // 'YYYY-MM' -> { category -> amount }: a monthly group's budget set by hand for one month
let fixedItems = []; // named fixed expenses inside categories; see fixed-expenses.js
const expanded = new Set(); // categories whose rows are open to show their fixed expenses

// The monthly plan - what comes in, and what comes off it before anything is
// spent - is stored as reserved rows in budget_goals rather than a table of
// its own: that table is already key -> amount with an upsert route, and the
// leading underscores keep these out of the real categories the page renders.
const INCOME_KEY = '__income__';
const DEBT_PAYMENT_KEY = '__debt_payment__';
const SAVINGS_KEY = '__savings__';
const PLAN_KEYS = [INCOME_KEY, DEBT_PAYMENT_KEY, SAVINGS_KEY];

const planInputs = {
    [INCOME_KEY]: document.getElementById('plan-income'),
    [DEBT_PAYMENT_KEY]: document.getElementById('plan-debt'),
    [SAVINGS_KEY]: document.getElementById('plan-savings')
};

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) {
        return;
    }

    // Built from local parts, not toISOString(), which is UTC and would land on
    // the next month late in the evening on the last day of a month.
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    monthInput.addEventListener('change', render);
    Object.entries(planInputs).forEach(([key, input]) => {
        input.addEventListener('change', () => {
            // A cleared field puts the stored amount back, as the goal inputs do.
            if (input.value === '') input.value = goals[key] ?? '';
            else saveGoal(key, input.value);
        });
    });
    // 'change' on a number input already means blur-with-a-new-value or Enter.
    // Delegated, as the rows are rebuilt on every render.
    document.addEventListener('change', e => {
        const data = e.target.dataset;
        if (!data) return;
        if (data.target) saveTarget(data.target, e.target.value);
        else if (data.category) saveGoal(data.category, e.target.value);
    });
    // The whole category name is the toggle, so it is an easy target on a phone.
    document.addEventListener('click', e => {
        const toggle = e.target.closest && e.target.closest('[data-expand]');
        if (!toggle) return;
        const category = toggle.dataset.expand;
        if (expanded.has(category)) expanded.delete(category);
        else expanded.add(category);
        render();
    });

    load();
});

async function load() {
    try {
        const responses = await Promise.all([
            fetch('/api/expenses', { headers: getAuthHeaders() }),
            fetch('/api/budget-goals', { headers: getAuthHeaders() }),
            fetch('/api/fixed-expenses', { headers: getAuthHeaders() }),
            fetch('/api/budget-targets', { headers: getAuthHeaders() })
        ]);

        if (responses.some(r => r.status === 401)) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (responses.some(r => !r.ok)) throw new Error('Failed to load budget');

        const [expensesRes, goalsRes, itemsRes, targetsRes] = responses;
        expenses = await expensesRes.json();
        fixedItems = await itemsRes.json();
        (await goalsRes.json()).forEach(goal => { goals[goal.category] = goal.amount; });
        (await targetsRes.json()).forEach(t => { (targets[t.month] ||= {})[t.category] = t.amount; });

        PLAN_KEYS.forEach(key => {
            if (goals[key] !== undefined) planInputs[key].value = goals[key];
        });

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

// Same, between two YYYY-MM-DD dates - start included, end not. String
// comparison is date order for that format.
function spentBetween(category, start, end) {
    return expenses
        .filter(e => !e.is_positive && e.category === category && e.expense_date >= start && e.expense_date < end)
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);
}

// The day that decides which year a yearly goal shows for the selected month:
// today while that month is the current one, otherwise its last day. A month
// that Rosh Hashanah falls in belongs to the year it ends in.
function referenceDate(month, today = isoDate(new Date())) {
    if (today.startsWith(month)) return today;
    const [year, mon] = month.split('-').map(Number);
    return isoDate(new Date(year, mon, 0)); // day 0 of the next month is the last of this one
}

// The span a yearly goal covers for the selected month, as YYYY-MM-DD dates,
// start included and end not. Tzedakah runs from Rosh Hashanah to Rosh
// Hashanah; the other yearly goals run on the calendar year.
function yearWindow(category, month, today) {
    const ref = referenceDate(month, today);
    if (HEBREW_YEAR_CATEGORIES.includes(category)) {
        const year = hebrewYear(ref);
        return { start: roshHashanah(year), end: roshHashanah(year + 1), label: String(year) };
    }
    const year = Number(ref.slice(0, 4));
    return { start: `${year}-01-01`, end: `${year + 1}-01-01`, label: String(year) };
}

function actual(category, month) {
    if (goalPeriod(category) !== 'yearly') return spentIn(category, month);
    const { start, end } = yearWindow(category, month);
    return spentBetween(category, start, end);
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

function diffCell(diff) {
    if (diff === null) return '<td>—</td>';
    return `<td class="${diff >= 0 ? 'under' : 'over'}">${diff < 0 ? '-' : '+'}${money(Math.abs(diff))}</td>`;
}

// ---- fixed expenses -------------------------------------------------------

function fixedItemsIn(category) {
    return fixedItems.filter(item => item.category === category);
}

// What a fixed expense comes to over its category's period: a month's worth
// in a monthly budget, a year's against a yearly goal. A yearly bill in a
// monthly category counts at a twelfth, spread across every month.
function fixedItemAmount(item) {
    const yearlyGoal = goalPeriod(item.category) === 'yearly';
    if (item.frequency === 'yearly') return yearlyGoal ? item.amount : item.amount / 12;
    return yearlyGoal ? item.amount * 12 : item.amount;
}

function fixedItemsTotal(category) {
    return fixedItemsIn(category).reduce((sum, item) => sum + fixedItemAmount(item), 0);
}

// ---- monthly budgets --------------------------------------------------------

// Every monthly group's budget for a month, from its fixed expenses and past
// spending.
//
// A group's usual budget is its fixed expenses plus what it has averaged a
// month on top of them. Past spending already includes those fixed bills, so
// only the average above them is flexible - never below nothing, so a group
// whose fixed bills outrun its history budgets exactly its fixed bills. With
// no earlier month to average, the flexible part is nothing.
//
// A group with a target for the month takes the target instead, and the rest
// fit around it: once the targets and everyone else's fixed bills are taken
// out of what is left for spending, the other groups' flexible parts shrink
// by the same proportion until they fit. They never grow past their averages
// - spare money stays unassigned. Fixed bills never shrink. With no income
// set there is nothing to fit into, so nothing shrinks.
//
// Returns { rows: { category -> { fixed, flexible, budget, spent, target } },
// totals, scale }, where scale is how far the flexible parts shrank (1 = not).
function monthlyBudgets(month) {
    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const set = targets[month] || {};

    const rows = {};
    for (const c of monthly) {
        const fixedPart = fixedItemsTotal(c);
        const average = averageMonthly(c, month);
        rows[c] = {
            fixed: fixedPart,
            usual: average === null ? 0 : Math.max(0, Math.round((average - fixedPart) * 100) / 100),
            target: set[c],
            spent: actual(c, month)
        };
    }

    const free = monthly.filter(c => rows[c].target === undefined);
    const wanted = free.reduce((sum, c) => sum + rows[c].usual, 0);
    const left = leftForSpending();
    let scale = 1;
    if (left !== null && wanted > 0) {
        const room = left
            - monthly.reduce((sum, c) => sum + (rows[c].target ?? 0), 0)
            - free.reduce((sum, c) => sum + rows[c].fixed, 0);
        scale = Math.max(0, Math.min(1, room / wanted));
    }

    const totals = { fixed: 0, flexible: 0, budget: 0, spent: 0 };
    for (const c of monthly) {
        const r = rows[c];
        if (r.target !== undefined) {
            r.budget = r.target;
            r.flexible = r.target - r.fixed; // below 0 when the target is under the fixed bills
        } else {
            // Shrunk amounts round down, so the cents cannot add up past what
            // is left; the epsilon keeps 304.9999999 from flooring to 304.99.
            r.flexible = scale < 1 ? Math.floor(r.usual * scale * 100 + 1e-6) / 100 : r.usual;
            r.budget = r.fixed + r.flexible;
        }
        delete r.usual;
        for (const key of Object.keys(totals)) totals[key] += r[key];
    }

    return { rows, totals, scale };
}

// The progress bar's budget: every monthly budget, plus a twelfth of each
// yearly goal - a whole year's Travel against one month would mean nothing.
function progressBudget(budgets) {
    const yearly = CATEGORIES
        .filter(c => goalPeriod(c) === 'yearly')
        .reduce((sum, c) => sum + (goals[c] || 0) / 12, 0);
    return budgets.totals.budget + yearly;
}

// ---- the plan -------------------------------------------------------------

// Income less what comes off the top. null when no income is set.
function leftForSpending() {
    const income = goals[INCOME_KEY];
    if (!income) return null;
    return income - (goals[DEBT_PAYMENT_KEY] || 0) - (goals[SAVINGS_KEY] || 0);
}

// Whether the monthly budgets fit in what is left for spending, and how far
// the targets squeezed everything else.
function renderPlan(budgets) {
    const left = leftForSpending();
    planLeft.textContent = left === null ? '—' : money(left);
    planLeft.className = left !== null && left < 0 ? 'over' : '';

    if (left === null) {
        planBreakdown.innerHTML = '';
        return;
    }

    const spare = left - budgets.totals.budget;
    planBreakdown.innerHTML = `Budget ${money(budgets.totals.budget)} · `
        + (spare > -0.005 ? `Unassigned ${money(Math.max(0, spare))}` : `<span class="over">Over by ${money(-spare)}</span>`)
        + (budgets.scale < 1 ? ` · Flexible at ${Math.round(budgets.scale * 100)}%` : '');
}

// ---- the tables -----------------------------------------------------------

// "5787 · Sep 12, 2026 – Oct 1, 2027" for Tzedakah, "2026" for the rest.
function yearLabel(category, month) {
    const { start, end, label } = yearWindow(category, month);
    if (!HEBREW_YEAR_CATEGORIES.includes(category)) return label;
    const day = (iso, offset = 0) => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d + offset).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };
    return `${label} · ${day(start)} – ${day(end, -1)}`;
}

// The category name is the toggle that opens the row onto its fixed
// expenses; a yearly row also shows the span its year covers.
function categoryCell(category, month) {
    const count = fixedItemsIn(category).length;
    const open = expanded.has(category);
    return `
        <td>
            <button type="button" class="expand-btn" data-expand="${category}" aria-expanded="${open}"><span class="caret">${open ? '▾' : '▸'}</span>${category}${count ? `<span class="item-count">${count} fixed</span>` : ''}</button>
            ${goalPeriod(category) === 'yearly' ? `<span class="period-note">${yearLabel(category, month)}</span>` : ''}
        </td>`;
}

// A target shows in the last column and lights the budget it sets. An open
// row is followed by its fixed expenses, from fixed-expenses.js.
function monthlyRowHtml(category, month, row) {
    const { fixed: fixedPart, flexible, budget, spent, target } = row;
    return `
        <tr>
            ${categoryCell(category, month)}
            <td>${fixedPart ? money(fixedPart) : '—'}</td>
            <td${flexible < 0 ? ' class="over"' : ''}>${money(flexible)}</td>
            <td${target !== undefined ? ' class="targeted"' : ''}>${money(budget)}</td>
            <td>${money(spent)}</td>
            ${diffCell(budget - spent)}
            <td><input type="number" class="goal-input" step="0.01" min="0" data-target="${category}" value="${target ?? ''}"></td>
        </tr>
        ${expanded.has(category) ? fixedDetailHtml(category) : ''}
    `;
}

// Yearly goals are still typed: maaser is a rule, not an average.
function yearlyRowHtml(category, month) {
    const goal = goals[category];
    const spent = actual(category, month);
    return `
        <tr>
            ${categoryCell(category, month)}
            <td>${goal === undefined ? '—' : money(goal)}</td>
            <td>${money(spent)}</td>
            ${diffCell(goal === undefined ? null : goal - spent)}
            <td><input type="number" class="goal-input" step="0.01" min="0" data-category="${category}" value="${goal ?? ''}"></td>
        </tr>
        ${expanded.has(category) ? fixedDetailHtml(category) : ''}
    `;
}

function render() {
    const month = monthInput.value;
    if (!month) return;

    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const yearly = CATEGORIES.filter(c => goalPeriod(c) === 'yearly');

    const budgets = monthlyBudgets(month);
    tbody.innerHTML = monthly.map(c => monthlyRowHtml(c, month, budgets.rows[c])).join('');
    yearlyTbody.innerHTML = yearly.map(c => yearlyRowHtml(c, month)).join('');

    // Which month the monthly table covers. Each yearly row carries its own
    // span, since Tzedakah's year and Travel's differ. Mid-month date, so no
    // timezone edge case.
    const [year, mon] = month.split('-');
    const label = new Date(year, mon - 1, 15).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    monthlyHeading.textContent = `Monthly budget — ${label}`;

    // Totals cover the monthly table only; a year's goal against a month's
    // spending would not add up to anything meaningful.
    const totals = budgets.totals;
    tfoot.innerHTML = `
        <tr>
            <td>Totals</td>
            <td>${money(totals.fixed)}</td>
            <td>${money(totals.flexible)}</td>
            <td>${money(totals.budget)}</td>
            <td>${money(totals.spent)}</td>
            ${diffCell(totals.budget - totals.spent)}
            <td></td>
        </tr>
    `;

    renderProgress(month, label, budgets);
    renderPlan(budgets);
    renderSchedule();
}

// One bar for every category on a monthly footing, against everything spent
// this month.
function renderProgress(month, label, budgets) {
    const budget = progressBudget(budgets);

    const spend = expenses
        .filter(e => !e.is_positive && e.expense_date.startsWith(month))
        .reduce((sum, e) => sum + Math.abs(e.amount), 0);

    progressLabel.textContent = `Total spend — ${label}`;
    progressFigures.textContent = budget ? `${money(spend)} of ${money(budget)}` : money(spend);

    progressFill.style.width = `${budget ? Math.min(100, (spend / budget) * 100) : 0}%`;
    progressFill.classList.toggle('over', budget > 0 && spend > budget);
}

// ---- saving ---------------------------------------------------------------

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

// A blank target goes back to the worked-out budget.
async function saveTarget(category, value) {
    const month = monthInput.value;
    const amount = value === '' ? null : parseFloat(value);
    if (amount !== null && !(amount >= 0)) return render();

    try {
        const response = amount === null
            ? await fetch(`/api/budget-targets?category=${encodeURIComponent(category)}&month=${month}`, {
                method: 'DELETE',
                headers: getAuthHeaders()
            })
            : await fetch('/api/budget-targets', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ category, month, amount })
            });
        if (!response.ok) throw new Error(`Failed to save the ${category} target`);

        if (amount === null) delete (targets[month] || {})[category];
        else (targets[month] ||= {})[category] = amount;
        render();
    } catch (error) {
        console.error('Target save error:', error);
        alert(`${error.message}. Please try again.`);
        render();
    }
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
