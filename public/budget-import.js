// Importing monthly targets from a CSV, and the sample file to start from.
//
// Loaded after budget.js, whose `targets`, `monthlyBudgets()` and
// `fixedItemsTotal()` it uses. A row is `month,category,amount`; a blank month
// means the month selected on the page. Each row sets that category's Target
// for that month, exactly as typing it would, except that a target is never
// set below the category's fixed expenses: the fixed bills stay covered and
// the fixed expenses themselves are never touched. Yearly categories have no
// target, so their rows are reported and skipped.

const importTargetsInput = document.getElementById('import-targets-input');

document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;
    document.getElementById('import-targets-btn').addEventListener('click', () => importTargetsInput.click());
    document.getElementById('sample-targets-btn').addEventListener('click', downloadTargetsSample);
    importTargetsInput.addEventListener('change', handleTargetsFile);
});

// One CSV line into its fields, honouring quotes and "" inside them.
function splitCsvLine(line) {
    const fields = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && quoted && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') quoted = !quoted;
        else if (ch === ',' && !quoted) { fields.push(current.trim()); current = ''; }
        else current += ch;
    }
    fields.push(current.trim());
    return fields;
}

// The CSV as { rows: [{ month, category, amount }], errors: [string] }.
//
// Columns are found by header name, in any order, any case. Categories match
// regardless of case. A $ sign and thousands commas in the amount are fine. A
// category listed twice for one month keeps the last row.
function parseTargetsCsv(text, defaultMonth) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return { rows: [], errors: ['The file is empty.'] };

    const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
    const col = { month: header.indexOf('month'), category: header.indexOf('category'), amount: header.indexOf('amount') };
    if (col.category < 0 || col.amount < 0) {
        return { rows: [], errors: ['The header needs category and amount columns.'] };
    }

    const byName = new Map(CATEGORIES.map(c => [c.toLowerCase(), c]));
    const found = new Map(); // 'month|category' -> row
    const errors = [];

    lines.slice(1).forEach((line, i) => {
        const fields = splitCsvLine(line);
        const lineNo = i + 2;
        const rawCategory = fields[col.category] || '';
        const category = byName.get(rawCategory.toLowerCase());
        const month = (col.month >= 0 && fields[col.month]) || defaultMonth;
        const rawAmount = (fields[col.amount] || '').replace(/[$,\s]/g, '');

        if (!category) return errors.push(`Line ${lineNo}: unknown category "${rawCategory}".`);
        if (goalPeriod(category) === 'yearly') return errors.push(`Line ${lineNo}: ${category} is yearly.`);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return errors.push(`Line ${lineNo}: month must be YYYY-MM.`);
        if (rawAmount === '') return; // a blank amount is a category left alone
        const amount = Number(rawAmount);
        if (!(amount >= 0)) return errors.push(`Line ${lineNo}: amount must be 0 or more.`);

        found.set(`${month}|${category}`, { month, category, amount: Math.round(amount * 100) / 100 });
    });

    return { rows: [...found.values()], errors };
}

// Lifts any target below its category's fixed expenses up to them. Returns how
// many were lifted.
function coverFixedExpenses(rows) {
    let lifted = 0;
    for (const row of rows) {
        const fixedPart = Math.round(fixedItemsTotal(row.category) * 100) / 100;
        if (row.amount < fixedPart) { row.amount = fixedPart; lifted++; }
    }
    return lifted;
}

async function handleTargetsFile(e) {
    const file = e.target.files[0];
    importTargetsInput.value = ''; // so choosing the same file again still fires
    if (!file) return;

    const { rows, errors } = parseTargetsCsv(await file.text(), monthInput.value);
    if (!rows.length) {
        alert(errors[0] || 'No targets in the file.');
        return;
    }
    const lifted = coverFixedExpenses(rows);

    // One line: how many, and what was changed or left out.
    const months = [...new Set(rows.map(r => r.month))].sort();
    const notes = [lifted && `${lifted} raised to fixed`, errors.length && `${errors.length} skipped`].filter(Boolean);
    const question = `Set ${rows.length} target${rows.length === 1 ? '' : 's'} for ${months.join(', ')}?`;
    if (!confirm(notes.length ? `${question} (${notes.join(', ')})` : question)) return;

    try {
        const response = await fetch('/api/budget-targets/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ targets: rows })
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Import failed');
        }
        rows.forEach(r => { (targets[r.month] ||= {})[r.category] = r.amount; });
        render();
    } catch (error) {
        console.error('Target import error:', error);
        alert(`${error.message}. Please try again.`);
    }
}

// Every monthly category with its budget for the selected month, ready to edit
// and import back.
function targetsSampleCsv(month) {
    const budgets = monthlyBudgets(month);
    const rows = CATEGORIES
        .filter(c => goalPeriod(c) !== 'yearly')
        .map(c => {
            const name = /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
            return `${month},${name},${budgets.rows[c].budget.toFixed(2)}`;
        });
    return ['month,category,amount', ...rows].join('\n') + '\n';
}

function downloadTargetsSample() {
    const month = monthInput.value;
    const blob = new Blob([targetsSampleCsv(month)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget_targets_${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
