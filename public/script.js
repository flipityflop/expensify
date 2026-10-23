// DOM Elements
const form = document.getElementById('expense-form');
const amountInput = document.getElementById('amount');
const expenseBtn = document.getElementById('expense-btn');
const incomeBtn = document.getElementById('income-btn');
const isPositiveInput = document.getElementById('is-positive');
const dateInput = document.getElementById('expense-date');
const holdDateCheckbox = document.getElementById('hold-date');
const categorySelect = document.getElementById('category');
const whatInput = document.getElementById('what');
const merchantInput = document.getElementById('merchant');
const eventInput = document.getElementById('event');
const messageDiv = document.getElementById('message');
const expensesList = document.getElementById('expenses-list');

// Autocomplete elements
const whatSuggestions = document.getElementById('what-suggestions');
const merchantSuggestions = document.getElementById('merchant-suggestions');
const merchantChips = document.getElementById('merchant-chips');
const eventSuggestions = document.getElementById('event-suggestions');

// Receipt photos for the expense being entered, uploaded once it is saved.
// The rest of receipts is receipts.js.
const submitBtn = form.querySelector('.submit-btn');
const receiptInput = document.getElementById('receipt-input');
const receiptThumbs = document.getElementById('receipt-thumbs');
let pendingReceipts = [];
let receiptThumbUrls = [];

// The recent list as last loaded, for redrawing a row's receipt button.
let recentExpenses = [];

// getAuthToken / getAuthHeaders / checkAuth / logout come from auth.js

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    // Check authentication first
    if (!checkAuth()) {
        return;
    }
    
    // Set default date to today
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
    
    // Initialize with expense categories (default)
    updateCategoryOptions(false);
    
    // Setup event listeners
    setupEventListeners();
    
    // Load initial expenses
    loadExpenses();
}

function setupEventListeners() {
    // Form submission
    form.addEventListener('submit', handleFormSubmit);
    
    // Type buttons
    expenseBtn.addEventListener('click', () => setExpenseType(false));
    incomeBtn.addEventListener('click', () => setExpenseType(true));
    
    // Autocomplete for "description" field
    whatInput.addEventListener('input', () => handleAutocomplete(whatInput, whatSuggestions, 'what'));
    whatInput.addEventListener('blur', () => setTimeout(() => hideSuggestions(whatSuggestions), 200));

    // Merchant chips are scoped to the chosen category - that is the whole
    // point of the split, so they follow the category, not the description.
    categorySelect.addEventListener('change', () => fetchMerchantChips(categorySelect.value));

    // Autocomplete for "merchant" field, as a fallback for anything not on a chip
    merchantInput.addEventListener('input', () => {
        clearChipSelection();
        handleAutocomplete(merchantInput, merchantSuggestions, 'merchant');
    });
    merchantInput.addEventListener('blur', () => setTimeout(() => hideSuggestions(merchantSuggestions), 200));

    // Autocomplete for "event" field (same as "what" field)
    eventInput.addEventListener('input', () => handleAutocomplete(eventInput, eventSuggestions, 'event'));
    eventInput.addEventListener('blur', () => setTimeout(() => hideSuggestions(eventSuggestions), 200));

    document.getElementById('receipt-pick-btn').addEventListener('click', () => receiptInput.click());
    receiptInput.addEventListener('change', () => {
        pendingReceipts.push(...receiptInput.files);
        receiptInput.value = '';
        renderReceiptThumbs();
    });
    receiptThumbs.addEventListener('click', e => {
        const index = e.target.dataset && e.target.dataset.unpick;
        if (index === undefined) return;
        pendingReceipts.splice(Number(index), 1);
        renderReceiptThumbs();
    });

    // Focus amount input on page load
    amountInput.focus();
}

function setExpenseType(isIncome) {
    const merchantGroup = document.getElementById('merchant-group');
    const eventGroup = document.getElementById('event-group');
    const taxableGroup = document.getElementById('taxable-group');

    isPositiveInput.value = isIncome ? '1' : '0';
    incomeBtn.classList.toggle('active', isIncome);
    expenseBtn.classList.toggle('active', !isIncome);

    // Merchant and event are expense-only; income gets the taxable checkbox.
    merchantGroup.style.display = isIncome ? 'none' : 'block';
    eventGroup.style.display = isIncome ? 'none' : 'block';
    taxableGroup.style.display = isIncome ? 'block' : 'none';

    updateCategoryOptions(isIncome);
    merchantChips.innerHTML = '';
}

function updateCategoryOptions(isIncome) {
    const list = isIncome ? INCOME_CATEGORIES : CATEGORIES;
    fillCategorySelect(categorySelect, list, 'Select category...');
}

function changeDate(days) {
    const currentDate = new Date(dateInput.value + 'T12:00:00'); // Add time to avoid timezone issues
    currentDate.setDate(currentDate.getDate() + days);
    dateInput.value = currentDate.toISOString().split('T')[0];
}

function renderReceiptThumbs() {
    receiptThumbUrls.forEach(url => URL.revokeObjectURL(url));
    receiptThumbUrls = pendingReceipts.map(file => URL.createObjectURL(file));
    receiptThumbs.innerHTML = receiptThumbUrls.map((url, i) => `
        <span class="receipt-thumb">
            <img src="${url}" alt="Receipt">
            <button type="button" class="receipt-unpick" data-unpick="${i}" aria-label="Remove">×</button>
        </span>`).join('');
}

async function handleFormSubmit(e) {
    e.preventDefault();
    // Held down until the photos are up as well: a second tap would add the
    // expense twice.
    const submitLabel = submitBtn.textContent;
    submitBtn.disabled = true;
      const formData = new FormData(form);
    const expenseData = {
        amount: parseFloat(formData.get('amount')),
        is_positive: formData.get('is_positive') === '1',
        expense_date: formData.get('expense_date'),
        category: formData.get('category'),
        what: formData.get('what').trim(),
        merchant: formData.get('merchant') ? formData.get('merchant').trim() : '',
        event: formData.get('event') ? formData.get('event').trim() : '',
        is_taxable: formData.get('is_taxable') === '1'
    };

    try {
        const resolved = await resolveEvent(expenseData.event);
        if (resolved === null) {          // user declined to create a new event
            eventInput.focus();
            return;
        }
        expenseData.event = resolved;

        const response = await fetch('/api/expenses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify(expenseData)
        });
        
        const result = await response.json();
        if (response.ok) {
            // The form waits for the photos, so the page is not left mid-upload.
            let receiptErrors = [];
            if (pendingReceipts.length) {
                submitBtn.textContent = 'Saving receipt…';
                receiptErrors = await uploadReceipts(result.id, pendingReceipts);
            }
            if (receiptErrors.length) {
                showMessage(`Expense added, receipt not saved: ${receiptErrors[0]}`, 'error');
            } else {
                showMessage('Expense added successfully!', 'success');
            }

            // Save date and hold state before reset
            const currentDate = dateInput.value;
            const holdDate = holdDateCheckbox.checked;

            form.reset();

            // Restore hold checkbox state
            holdDateCheckbox.checked = holdDate;

            // Reset date based on hold checkbox
            if (holdDate) {
                dateInput.value = currentDate;
            } else {
                const today = new Date().toISOString().split('T')[0];
                dateInput.value = today;
            }
            setExpenseType(false); // Reset to expense
            
            // Reset taxable checkbox
            document.getElementById('is-taxable').checked = false;

            // Clear merchant suggestion chips
            merchantChips.innerHTML = '';

            pendingReceipts = [];
            renderReceiptThumbs();

            // Reload expenses
            loadExpenses();
            
            // Focus amount input for next entry
            amountInput.focus();
        } else {
            showMessage(result.error || 'Error adding expense', 'error');
        }
    } catch (error) {
        showMessage('Network error. Please try again.', 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
    }
}

async function handleAutocomplete(input, suggestionsDiv, field) {
    const query = input.value.trim();
    
    if (query.length < 2) {
        hideSuggestions(suggestionsDiv);
        return;
    }
    
    try {
        const response = await fetch(`/api/autocomplete/${field}?q=${encodeURIComponent(query)}`, {
            headers: getAuthHeaders()
        });
        const suggestions = await response.json();
        
        if (suggestions.length > 0) {
            showSuggestions(suggestionsDiv, suggestions, input);
        } else {
            hideSuggestions(suggestionsDiv);
        }
    } catch (error) {
        console.error('Autocomplete error:', error);
        hideSuggestions(suggestionsDiv);
    }
}

function showSuggestions(suggestionsDiv, suggestions, input) {
    suggestionsDiv.innerHTML = '';

    suggestions.slice(0, 5).forEach((suggestion, index) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = suggestion;

        item.addEventListener('click', () => {
            input.value = suggestion;
            hideSuggestions(suggestionsDiv);
            input.focus();
        });

        suggestionsDiv.appendChild(item);
    });

    suggestionsDiv.style.display = 'block';
}

function hideSuggestions(suggestionsDiv) {
    suggestionsDiv.style.display = 'none';
}

// The merchants most used in this category, as tappable chips.
async function fetchMerchantChips(category) {
    merchantChips.innerHTML = '';
    if (!category) return;

    try {
        const url = `/api/merchants-by-category?category=${encodeURIComponent(category)}`;
        const response = await fetch(url, { headers: getAuthHeaders() });
        const merchants = await response.json();

        merchants.forEach(merchant => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'suggestion-chip';
            chip.textContent = merchant;

            chip.addEventListener('click', () => {
                merchantInput.value = merchant;
                clearChipSelection();
                chip.classList.add('selected');
            });

            merchantChips.appendChild(chip);
        });
    } catch (error) {
        console.error('Merchant chips error:', error);
    }
}

function clearChipSelection() {
    merchantChips.querySelectorAll('.selected').forEach(c => c.classList.remove('selected'));
}

// Event is the one field where free text must not quietly create near-duplicates
// ("israel trip" vs "Israel Trip" vs "israel"). An existing spelling wins; a
// genuinely new event needs an explicit yes.
// Returns the value to save, or null if the user backed out.
async function resolveEvent(value) {
    if (!value) return '';

    const response = await fetch(`/api/autocomplete/event?q=${encodeURIComponent(value)}`, {
        headers: getAuthHeaders()
    });
    const existing = await response.json();

    const match = existing.find(e => e.toLowerCase() === value.toLowerCase());
    if (match) return match;

    return confirm(`"${value}" is not an existing event. Create it as a new one?`) ? value : null;
}

async function loadExpenses() {
    try {
        expensesList.innerHTML = '<div class="loading">Loading expenses...</div>';
        
        const response = await fetch('/api/expenses', {
            headers: getAuthHeaders()
        });
        const expenses = await response.json();
        // Only the first 10 make the recent list.
        recentExpenses = expenses.slice(0, 10);
          if (expenses.length === 0) {
            expensesList.innerHTML = `
                <div class="empty-state">
                    <p>No expenses recorded yet.</p>
                    <p>Add your first expense above!</p>
                </div>
            `;
        } else {
            expensesList.innerHTML = recentExpenses.map(expense => createExpenseHTML(expense)).join('');
        }
    } catch (error) {
        expensesList.innerHTML = '<div class="error">Error loading expenses</div>';
    }
}

function createExpenseHTML(expense) {
    const amount = Math.abs(expense.amount);
    const amountClass = expense.is_positive ? 'positive' : 'negative';
    const amountPrefix = expense.is_positive ? '+' : '-';
    const itemClass = expense.is_positive ? 'positive' : 'negative';
    
    const expenseDate = safeFormatDate(expense.expense_date);
    
    return `
        <div class="expense-item ${itemClass}">
            <button class="delete-btn" onclick="deleteExpense(${expense.id})" title="Delete expense">×</button>
            ${receiptButtonHtml(expense, 'receipt-btn')}
            <div class="expense-line-1">
                <span class="expense-what">${expense.what}</span>
                <span class="expense-amount ${amountClass}">${amountPrefix}$${amount.toFixed(2)}</span>
            </div>
            <div class="expense-line-2">
                <span class="expense-category">${expense.category}</span>
                <span class="expense-separator">•</span>
                <span class="expense-date">${expenseDate}</span>
                ${expense.merchant ? `<span class="expense-separator">•</span><span class="expense-merchant">${expense.merchant}</span>` : ''}
                ${expense.event ? `<span class="expense-separator">•</span><span class="expense-event">${expense.event}</span>` : ''}
            </div>
        </div>
    `;
}

// Called by receipts.js once a row's receipts have changed.
function receiptsChanged(expenseId, count) {
    const expense = recentExpenses.find(e => e.id === expenseId);
    if (!expense) return;
    expense.receipt_count = count;
    expensesList.innerHTML = recentExpenses.map(e => createExpenseHTML(e)).join('');
}

async function deleteExpense(id) {
    const expense = recentExpenses.find(e => e.id === id);
    if (!confirm(deleteExpenseQuestion(expense ? expense.receipt_count : 0))) {
        return;
    }
    
    try {        const response = await fetch(`/api/expenses/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        if (response.ok) {
            showMessage('Expense deleted successfully!', 'success');
            loadExpenses();
        } else {
            const result = await response.json();
            showMessage(result.error || 'Error deleting expense', 'error');
        }
    } catch (error) {
        showMessage('Network error. Please try again.', 'error');
    }
}

function showMessage(text, type) {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    // Hide message after 3 seconds
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // Enter key on amount field moves to expense button
    if (e.target === amountInput && e.key === 'Enter') {
        e.preventDefault();
        expenseBtn.focus();
    }
    
    // Number keys for quick type selection when buttons are focused
    if ((e.target === expenseBtn || e.target === incomeBtn) && e.key === '1') {
        e.preventDefault();
        setExpenseType(false); // Expense
    }
    if ((e.target === expenseBtn || e.target === incomeBtn) && e.key === '2') {
        e.preventDefault();
        setExpenseType(true); // Income
    }
});

// Safe date formatting function
function safeFormatDate(dateString) {
    try {
        let date;
        
        // Check if the date already includes time information
        if (dateString.includes('T') || dateString.includes(' ')) {
            // Date already has time, use as is
            date = new Date(dateString);
        } else {
            // Date only, add noon time to avoid timezone issues
            date = new Date(dateString + 'T12:00:00');
        }
        
        // Check if the date is valid
        if (isNaN(date.getTime())) {
            return 'Invalid Date';
        }
        
        return date.toLocaleDateString();
    } catch (error) {
        console.error('Date formatting error:', error, 'Input:', dateString);
        return 'Invalid Date';
    }
}

// Expose functions to global scope for HTML onclick handlers (logout: auth.js)
window.changeDate = changeDate;
window.deleteExpense = deleteExpense;
