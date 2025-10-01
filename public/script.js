// DOM Elements
const form = document.getElementById('expense-form');
const amountInput = document.getElementById('amount');
const expenseBtn = document.getElementById('expense-btn');
const incomeBtn = document.getElementById('income-btn');
const isPositiveInput = document.getElementById('is-positive');
const dateInput = document.getElementById('expense-date');
const categorySelect = document.getElementById('category');
const whatInput = document.getElementById('what');
const notesInput = document.getElementById('notes');
const messageDiv = document.getElementById('message');
const expensesList = document.getElementById('expenses-list');

// Autocomplete elements
const whatSuggestions = document.getElementById('what-suggestions');
const notesSuggestions = document.getElementById('notes-suggestions');

// Authentication helpers
function getAuthToken() {
    return localStorage.getItem('authToken');
}

function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function checkAuth() {
    const token = getAuthToken();
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

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
    
    // Autocomplete for "what" field
    whatInput.addEventListener('input', () => handleAutocomplete(whatInput, whatSuggestions, 'what'));
    whatInput.addEventListener('blur', () => setTimeout(() => hideSuggestions(whatSuggestions), 200));
    
    // Autocomplete for "notes" field
    notesInput.addEventListener('input', () => handleAutocomplete(notesInput, notesSuggestions, 'notes'));
    notesInput.addEventListener('blur', () => setTimeout(() => hideSuggestions(notesSuggestions), 200));
    
    // Focus amount input on page load
    amountInput.focus();
}

function setExpenseType(isIncome) {
    const notesGroup = document.getElementById('notes-group');
    const taxableGroup = document.getElementById('taxable-group');
    
    if (isIncome) {
        // Set to income
        isPositiveInput.value = '1';
        incomeBtn.classList.add('active');
        expenseBtn.classList.remove('active');
        
        // Hide notes section, show taxable checkbox
        notesGroup.style.display = 'none';
        taxableGroup.style.display = 'block';
        
        // Update category options for income
        updateCategoryOptions(true);
    } else {
        // Set to expense
        isPositiveInput.value = '0';
        expenseBtn.classList.add('active');
        incomeBtn.classList.remove('active');
        
        // Show notes section, hide taxable checkbox
        notesGroup.style.display = 'block';
        taxableGroup.style.display = 'none';
        
        // Update category options for expenses
        updateCategoryOptions(false);
    }
}

function updateCategoryOptions(isIncome) {
    const categorySelect = document.getElementById('category');
    categorySelect.innerHTML = '<option value="">Select category...</option>';
      if (isIncome) {
        // Income categories
        const incomeCategories = [
            'work', 'sidejob', 'gift', 'investment', 'other'
        ];
        
        incomeCategories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            categorySelect.appendChild(option);
        });
    } else {
        // Expense categories
        const expenseCategories = [
            'kitchen / home', 'investments', 'office work', 'subscriptions',
            'electronics personal', 'clothes + accessories', 'travel', 'food',
            'various/ debt repayment', 'fun', 'rent+bills', 'gifts', 'health', 'beauty',
            'restaurant', 'tzedakah'
        ];
        
        expenseCategories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            categorySelect.appendChild(option);
        });
    }
}

function changeDate(days) {
    const currentDate = new Date(dateInput.value + 'T12:00:00'); // Add time to avoid timezone issues
    currentDate.setDate(currentDate.getDate() + days);
    dateInput.value = currentDate.toISOString().split('T')[0];
}

async function handleFormSubmit(e) {
    e.preventDefault();
      const formData = new FormData(form);
    const expenseData = {
        amount: parseFloat(formData.get('amount')),
        is_positive: formData.get('is_positive') === '1',
        expense_date: formData.get('expense_date'),
        category: formData.get('category'),
        what: formData.get('what').trim(),
        notes: formData.get('notes') ? formData.get('notes').trim() : '',
        is_taxable: formData.get('is_taxable') === '1'
    };
    
    try {        const response = await fetch('/api/expenses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify(expenseData)
        });
        
        const result = await response.json();        if (response.ok) {
            showMessage('Expense added successfully!', 'success');
            form.reset();
            
            // Reset to default values
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
            setExpenseType(false); // Reset to expense
            
            // Reset taxable checkbox
            document.getElementById('is-taxable').checked = false;
            
            // Reload expenses
            loadExpenses();
            
            // Focus amount input for next entry
            amountInput.focus();
        } else {
            showMessage(result.error || 'Error adding expense', 'error');
        }
    } catch (error) {
        showMessage('Network error. Please try again.', 'error');
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

async function loadExpenses() {
    try {
        expensesList.innerHTML = '<div class="loading">Loading expenses...</div>';
        
        const response = await fetch('/api/expenses', {
            headers: getAuthHeaders()
        });
        const expenses = await response.json();
          if (expenses.length === 0) {
            expensesList.innerHTML = `
                <div class="empty-state">
                    <p>No expenses recorded yet.</p>
                    <p>Add your first expense above!</p>
                </div>
            `;
        } else {
            // Show only the first 10 expenses for recent expenses section
            const recentExpenses = expenses.slice(0, 10);
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
            <div class="expense-line-1">
                <span class="expense-what">${expense.what}</span>
                <span class="expense-amount ${amountClass}">${amountPrefix}$${amount.toFixed(2)}</span>
            </div>
            <div class="expense-line-2">
                <span class="expense-category">${expense.category}</span>
                <span class="expense-separator">•</span>
                <span class="expense-date">${expenseDate}</span>
                ${expense.notes ? `<span class="expense-separator">•</span><span class="expense-notes">${expense.notes}</span>` : ''}
            </div>
        </div>
    `;
}

async function deleteExpense(id) {
    if (!confirm('Are you sure you want to delete this expense?')) {
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

function logout() {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
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

// Expose functions to global scope for HTML onclick handlers
window.changeDate = changeDate;
window.deleteExpense = deleteExpense;
window.logout = logout;
