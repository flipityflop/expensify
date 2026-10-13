const monthInput = document.getElementById('month');
const tbody = document.getElementById('budget-tbody');
const tfoot = document.getElementById('budget-tfoot');
const yearlyTbody = document.getElementById('yearly-tbody');
const monthlyHeading = document.getElementById('monthly-heading');
const autofillBtn = document.getElementById('autofill');
const planLeft = document.getElementById('plan-left');
const planBreakdown = document.getElementById('plan-breakdown');
const progressLabel = document.getElementById('progress-label');
const progressFigures = document.getElementById('progress-figures');
const progressFill = document.getElementById('budget-progress-fill');
const loadingDiv = document.getElementById('loading');

let expenses = [];
let goals = {}; // category -> goal amount
let fixed = {}; // category -> true when the whole goal is a fixed cost, set by hand
let fixedItems = []; // named fixed expenses inside categories; see fixed-expenses.js
const expanded = new Set(); // categories whose rows are open to show their fixed expenses

// The monthly plan - what comes in, and what comes off it before anything is
// spent - is stored as reserved rows in budget_goals rather than a table of
// its own: that table is already key -> amount with an upsert route, and the
// leading underscores keep these out of the real categories the page renders.
//
// INCOME_KEY keeps the name from when the figure was "income to spend", so the
// amount already saved carries over as the income.
const INCOME_KEY = '__spending_budget__';
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
    autofillBtn.addEventListener('click', autofill);
    Object.entries(planInputs).forEach(([key, input]) => {
        input.addEventListener('change', () => {
            // A cleared field puts the stored amount back, as the goal inputs do.
            if (input.value === '') input.value = goals[key] ?? '';
            else saveGoal(key, input.value);
        });
    });
    // 'change' on a number input already means blur-with-a-new-value or Enter.
    // Delegated from the document so both tables are covered by one listener.
    document.addEventListener('change', e => {
        const data = e.target.dataset;
        if (!data) return;
        if (data.fixedFor) toggleFixed(data.fixedFor, e.target.checked);
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
        const [expensesRes, goalsRes, itemsRes] = await Promise.all([
            fetch('/api/expenses', { headers: getAuthHeaders() }),
            fetch('/api/budget-goals', { headers: getAuthHeaders() }),
            fetch('/api/fixed-expenses', { headers: getAuthHeaders() })
        ]);

        if ([expensesRes, goalsRes, itemsRes].some(r => r.status === 401)) {
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
            return;
        }
        if (!expensesRes.ok || !goalsRes.ok || !itemsRes.ok) throw new Error('Failed to load budget');

        expenses = await expensesRes.json();
        fixedItems = await itemsRes.json();
        (await goalsRes.json()).forEach(goal => {
            goals[goal.category] = goal.amount;
            if (goal.fixed) fixed[goal.category] = true;
        });

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

// What a fixed expense comes to over its category's goal period: a month's
// worth against a monthly goal, a year's against a yearly one. A yearly bill
// in a monthly category counts at a twelfth - the goal is the same every
// month, so the bill is spread across all of them.
function fixedItemAmount(item) {
    const yearlyGoal = goalPeriod(item.category) === 'yearly';
    if (item.frequency === 'yearly') return yearlyGoal ? item.amount : item.amount / 12;
    return yearlyGoal ? item.amount * 12 : item.amount;
}

function fixedItemsTotal(category) {
    return fixedItemsIn(category).reduce((sum, item) => sum + fixedItemAmount(item), 0);
}

// What autofill must leave alone in a monthly category: the whole goal when
// the category is pinned, otherwise its fixed expenses.
function reservedFor(category) {
    return fixed[category] ? (goals[category] || 0) : fixedItemsTotal(category);
}

// ---- the plan -------------------------------------------------------------

// Income less what comes off the top. null when no income is set, which is
// also what tells autofill to use the raw averages.
function leftForSpending() {
    const income = goals[INCOME_KEY];
    if (!income) return null;
    return income - (goals[DEBT_PAYMENT_KEY] || 0) - (goals[SAVINGS_KEY] || 0);
}

function renderPlan() {
    const left = leftForSpending();
    planLeft.textContent = left === null ? '—' : money(left);
    planLeft.className = left !== null && left < 0 ? 'over' : '';

    if (left === null) {
        planBreakdown.innerHTML = '';
        return;
    }

    // Unassigned is what is left for spending that no monthly goal has yet.
    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const reserved = monthly.reduce((sum, c) => sum + reservedFor(c), 0);
    const spare = left - monthly.reduce((sum, c) => sum + (goals[c] || 0), 0);

    planBreakdown.innerHTML = `Fixed ${money(reserved)} · `
        + (spare >= 0 ? `Unassigned ${money(spare)}` : `<span class="over">Goals over by ${money(-spare)}</span>`);
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

// `showFixed` is off for the yearly table: autofill never touches those, so a
// checkbox there would do nothing. An open row is followed by its fixed
// expenses, from fixed-expenses.js.
function rowHtml(category, month, showFixed) {
    const goal = goals[category];
    const spent = actual(category, month);
    const isFixed = !!fixed[category];
    const count = fixedItemsIn(category).length;
    const open = expanded.has(category);

    return `
        <tr${isFixed ? ' class="fixed-row"' : ''}>
            <td>
                <button type="button" class="expand-btn" data-expand="${category}" aria-expanded="${open}"><span class="caret">${open ? '▾' : '▸'}</span>${category}${count ? `<span class="item-count">${count} fixed</span>` : ''}</button>
                ${goalPeriod(category) === 'yearly' ? `<span class="period-note">${yearLabel(category, month)}</span>` : ''}
            </td>
            <td>${goal === undefined ? '—' : money(goal)}</td>
            <td>${money(spent)}</td>
            ${diffCell(goal === undefined ? null : goal - spent)}
            <td><input type="number" class="goal-input" step="0.01" min="0" data-category="${category}" value="${goal ?? ''}"></td>
            <td>${showFixed ? `<input type="checkbox" data-fixed-for="${category}"${isFixed ? ' checked' : ''}>` : ''}</td>
        </tr>
        ${open ? fixedDetailHtml(category) : ''}
    `;
}

function render() {
    const month = monthInput.value;
    if (!month) return;

    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const yearly = CATEGORIES.filter(c => goalPeriod(c) === 'yearly');

    tbody.innerHTML = monthly.map(c => rowHtml(c, month, true)).join('');
    yearlyTbody.innerHTML = yearly.map(c => rowHtml(c, month, false)).join('');

    // Which month the monthly table covers. Each yearly row carries its own
    // span, since Tzedakah's year and Travel's no longer line up. Mid-month
    // date, so no timezone edge case.
    const [year, mon] = month.split('-');
    const label = new Date(year, mon - 1, 15).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    monthlyHeading.textContent = `Monthly goals — ${label}`;

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
            <td></td>
        </tr>
    `;

    renderProgress(month, label);
    renderPlan();
    renderSchedule();
}

// One bar for every category, everything put on a monthly footing: a yearly
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

// ---- saving ---------------------------------------------------------------

// The upsert rewrites the whole row, so `fixed` has to be sent every time or
// editing an amount would quietly clear the flag. Defaults to what is already
// stored.
async function putGoal(category, amount, isFixed = !!fixed[category]) {
    const response = await fetch('/api/budget-goals', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
        },
        body: JSON.stringify({ category, amount, period: goalPeriod(category), fixed: isFixed })
    });

    if (!response.ok) throw new Error(`Failed to save ${category}`);
    goals[category] = amount;
    if (isFixed) fixed[category] = true;
    else delete fixed[category];
}

async function toggleFixed(category, isFixed) {
    // A fixed cost with no amount is meaningless - autofill would reserve zero
    // for it and then scale it as if it were discretionary anyway.
    if (goals[category] === undefined) {
        alert(`Set an amount for ${category} first — a fixed cost needs one.`);
        return render();
    }

    try {
        await putGoal(category, goals[category], isFixed);
        render();
    } catch (error) {
        console.error('Fixed toggle error:', error);
        alert('Error saving. Please try again.');
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

// ---- autofill -------------------------------------------------------------

// The arithmetic behind Autofill, without the confirm or the saves, so the
// test runs the real thing.
//
// Past averages give the shape, what is left for spending gives the scale.
// Fixed costs come off first and are never scaled - rent does not shrink
// because there is less to spend. A pinned category keeps its whole goal and
// is not rewritten. Any other category keeps its fixed expenses, and only its
// past spending above them is flexible. What remains after the fixed costs is
// split across those flexible parts in proportion to their averages. With no
// income set, the averages are used as they are.
//
// Yearly goals are left out: a twelve-month total is not an average of months.
function planAutofill(month) {
    const monthly = CATEGORIES.filter(c => goalPeriod(c) !== 'yearly');
    const toSpend = leftForSpending();
    const reserved = monthly.reduce((sum, c) => sum + reservedFor(c), 0);

    const rows = monthly
        .filter(c => !fixed[c])
        .map(c => ({ category: c, average: averageMonthly(c, month), fixedPart: fixedItemsTotal(c) }))
        .filter(row => row.average !== null)
        .map(row => ({ ...row, flexible: Math.max(0, row.average - row.fixedPart) }));

    const historic = rows.reduce((sum, row) => sum + row.flexible, 0);
    const available = toSpend === null ? null : toSpend - reserved;
    // Guard the divisor: with no prior spending there are no proportions to
    // scale, and every goal would come out NaN.
    const scale = available !== null && historic ? available / historic : 1;

    return {
        toSpend,
        reserved,
        available,
        scale,
        goals: rows.map(row => [row.category, Math.round((row.fixedPart + row.flexible * scale) * 100) / 100])
    };
}

async function autofill() {
    const month = monthInput.value;
    const plan = planAutofill(month);
    const count = plan.goals.length;

    if (!count) {
        return alert(`Nothing to autofill: no months before ${month} to average, or every category is pinned.`);
    }

    if (plan.available !== null && plan.available <= 0) {
        return alert(`Fixed costs (${money(plan.reserved)}) use up the ${money(plan.toSpend)} left for spending.`);
    }

    // It overwrites goals, so it asks first - in one line.
    const question = plan.available === null
        ? `Set ${count} monthly goals to their average before ${month}?`
        : `Split ${money(plan.available)} across ${count} monthly goals by past spending?`;
    if (!confirm(question)) return;

    autofillBtn.disabled = true;
    try {
        for (const [category, amount] of plan.goals) {
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
