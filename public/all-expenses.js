// DOM Elements
const expensesTable = document.getElementById('expenses-table');
const expensesTbody = document.getElementById('expenses-tbody');
const loadingDiv = document.getElementById('loading');
const noResultsDiv = document.getElementById('no-results');
const searchInput = document.getElementById('search');
const categoryFilter = document.getElementById('category-filter');
const typeFilter = document.getElementById('type-filter');
const dateStartFilter = document.getElementById('date-start-filter');
const dateEndFilter = document.getElementById('date-end-filter');
const exportBtn = document.getElementById('export-btn');
const totalExpensesSpan = document.getElementById('total-expenses');
const totalIncomeSpan = document.getElementById('total-income');
const netBalanceSpan = document.getElementById('net-balance');

// Global variables
let allExpenses = [];
let filteredExpenses = [];
let sortColumn = 'expense_date';
let sortDirection = 'desc';

// Chart instances
let categoryBarChart = null;
let trendLineChart = null;

// Authentication helper functions
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

// Initialize the page
document.addEventListener('DOMContentLoaded', function() {
    // Check authentication first
    if (!checkAuth()) {
        return;
    }
    
    loadAllExpenses();
    setupEventListeners();
});

function setupEventListeners() {
    // Search and filter inputs
    searchInput.addEventListener('input', applyFilters);
    categoryFilter.addEventListener('change', applyFilters);
    typeFilter.addEventListener('change', applyFilters);    dateStartFilter.addEventListener('change', applyFilters);
    dateEndFilter.addEventListener('change', applyFilters);
    document.getElementById('consolidate-what-toggle').addEventListener('change', handleConsolidateToggle);
    document.getElementById('consolidate-notes-toggle').addEventListener('change', handleConsolidateToggle);
    
    // Export button
    exportBtn.addEventListener('click', exportToCSV);
    
    // Import functionality
    const importBtn = document.getElementById('import-btn');
    const sampleBtn = document.getElementById('sample-btn');
    const csvFileInput = document.getElementById('csv-file-input');
    const importModal = document.getElementById('import-modal');
    const closeModal = document.getElementById('close-modal');
    const fileDropZone = document.getElementById('file-drop-zone');
    const browseFileBtn = document.getElementById('browse-file');
    const downloadSampleBtn = document.getElementById('download-sample');
    const confirmImportBtn = document.getElementById('confirm-import');
    const cancelImportBtn = document.getElementById('cancel-import');

    importBtn.addEventListener('click', () => importModal.style.display = 'block');
    sampleBtn.addEventListener('click', downloadSampleCSV);
    downloadSampleBtn.addEventListener('click', downloadSampleCSV);
    closeModal.addEventListener('click', () => importModal.style.display = 'none');
    browseFileBtn.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', handleFileSelect);
    confirmImportBtn.addEventListener('click', confirmImport);
    cancelImportBtn.addEventListener('click', cancelImport);

    // File drop functionality
    fileDropZone.addEventListener('dragover', handleDragOver);
    fileDropZone.addEventListener('dragleave', handleDragLeave);
    fileDropZone.addEventListener('drop', handleFileDrop);    // Close modal when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === importModal) {
            importModal.style.display = 'none';
        }
    });

    // Chart controls
    setupChartEventListeners();
    
    // Table sorting
    document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.sort;
            handleSort(column);
        });
    });
}

async function loadAllExpenses() {
    try {
        loadingDiv.style.display = 'block';
        expensesTable.style.display = 'none';
        noResultsDiv.style.display = 'none';
        
        const response = await fetch('/api/expenses', {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                // Token expired or invalid, redirect to login
                localStorage.removeItem('authToken');
                window.location.href = '/login.html';
                return;
            }
            throw new Error('Failed to load expenses');
        }
        if (!response.ok) throw new Error('Failed to fetch expenses');
        
        allExpenses = await response.json();
        filteredExpenses = [...allExpenses];
          updateSummary();
        sortData();
        renderTable();
        
        // Initialize charts
        initializeCharts();
        updateCharts();
        
        loadingDiv.style.display = 'none';
        expensesTable.style.display = 'table';
        expensesTable.classList.add('loaded');
        
    } catch (error) {
        console.error('Error loading expenses:', error);
        loadingDiv.innerHTML = '<p style="color: #ef4444;">Error loading expenses. Please try again.</p>';
    }
}

function applyFilters() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    const categoryValue = categoryFilter.value.toLowerCase();
    const typeValue = typeFilter.value;
    const startDate = dateStartFilter.value;
    const endDate = dateEndFilter.value;
    
    filteredExpenses = allExpenses.filter(expense => {
        // Search filter
        const matchesSearch = !searchTerm || 
            expense.what.toLowerCase().includes(searchTerm) ||
            expense.notes.toLowerCase().includes(searchTerm) ||
            expense.category.toLowerCase().includes(searchTerm);
        
        // Category filter
        const matchesCategory = !categoryValue || 
            expense.category.toLowerCase() === categoryValue;
        
        // Type filter
        const matchesType = !typeValue || 
            (typeValue === 'expense' && !expense.is_positive) ||
            (typeValue === 'income' && expense.is_positive);
          // Date range filter - use transaction date, not entry date
        let matchesDateRange = true;
        if (startDate || endDate) {
            const expenseDate = safeParseDate(expense.expense_date);
            if (!expenseDate) return false; // Skip invalid dates
            
            if (startDate) {
                const start = new Date(startDate + 'T12:00:00');
                if (expenseDate < start) matchesDateRange = false;
            }
            
            if (endDate) {
                const end = new Date(endDate + 'T12:00:00');
                if (expenseDate > end) matchesDateRange = false;
            }
        }return matchesSearch && matchesCategory && matchesType && matchesDateRange;
    });
    
    // Apply consolidation based on which toggle is checked
    const consolidateWhatToggle = document.getElementById('consolidate-what-toggle');
    const consolidateNotesToggle = document.getElementById('consolidate-notes-toggle');
    
    if (consolidateWhatToggle.checked) {
        filteredExpenses = consolidateExpenses(filteredExpenses, 'what');
    } else if (consolidateNotesToggle.checked) {
        filteredExpenses = consolidateExpenses(filteredExpenses, 'notes');
    }
    
    updateSummary();
    sortData();
    renderTable();
}

function handleSort(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortDirection = 'asc';
    }
    
    // Update sort indicators
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === column) {
            th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
    
    sortData();
    renderTable();
}

function sortData() {
    filteredExpenses.sort((a, b) => {
        let aVal = a[sortColumn];
        let bVal = b[sortColumn];
        
        // Handle different data types
        if (sortColumn === 'amount') {
            aVal = Math.abs(parseFloat(aVal));
            bVal = Math.abs(parseFloat(bVal));
        } else if (sortColumn === 'expense_date') {
            aVal = new Date(aVal);
            bVal = new Date(bVal);
        } else {
            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();
        }
        
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
}

function renderTable() {
    if (filteredExpenses.length === 0) {
        expensesTable.style.display = 'none';
        noResultsDiv.style.display = 'block';
        return;
    }
    
    expensesTable.style.display = 'table';
    noResultsDiv.style.display = 'none';    expensesTbody.innerHTML = filteredExpenses.map(expense => {
        const amount = Math.abs(expense.amount);
        const amountClass = expense.is_positive ? 'amount-positive' : 'amount-negative';
        const amountPrefix = expense.is_positive ? '+' : '-';
        // Use safe date formatting to handle various date formats
        const date = safeFormatDate(expense.expense_date);
        
        return `
            <tr>
                <td>${date}</td>
                <td class="${amountClass}">${amountPrefix}$${amount.toFixed(2)}</td>
                <td><span class="category-tag">${expense.category}</span></td>
                <td>${expense.what}</td>
                <td>${expense.notes || '-'}</td>
                <td>
                    <button class="delete-action" onclick="deleteExpense(${expense.id})" title="Delete">
                        🗑️
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function updateSummary() {
    let totalExpenses = 0;
    let totalIncome = 0;
    
    filteredExpenses.forEach(expense => {
        if (expense.is_positive) {
            totalIncome += Math.abs(expense.amount);
        } else {
            totalExpenses += Math.abs(expense.amount);
        }
    });
    
    const netBalance = totalIncome - totalExpenses;
    
    totalExpensesSpan.textContent = `$${totalExpenses.toFixed(2)}`;
    totalIncomeSpan.textContent = `$${totalIncome.toFixed(2)}`;
    netBalanceSpan.textContent = `$${Math.abs(netBalance).toFixed(2)}`;
    
    // Update net balance color
    netBalanceSpan.className = 'summary-value ' + (netBalance >= 0 ? 'positive' : 'negative');
}

async function deleteExpense(id) {
    if (!confirm('Are you sure you want to delete this expense?')) {
        return;
    }
      try {
        const response = await fetch(`/api/expenses/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        if (response.ok) {
            // Remove from local arrays
            allExpenses = allExpenses.filter(expense => expense.id !== id);
            applyFilters(); // This will update filteredExpenses and re-render
            
            // Show success message briefly
            const originalContent = loadingDiv.innerHTML;
            loadingDiv.style.display = 'block';
            loadingDiv.innerHTML = '<p style="color: #10b981;">Expense deleted successfully!</p>';
            setTimeout(() => {
                loadingDiv.style.display = 'none';
                loadingDiv.innerHTML = originalContent;
            }, 2000);
        } else {
            throw new Error('Failed to delete expense');
        }
    } catch (error) {
        alert('Error deleting expense. Please try again.');
        console.error('Delete error:', error);
    }
}

function exportToCSV() {
    if (filteredExpenses.length === 0) {
        alert('No data to export');
        return;
    }
    
    // Create CSV content
    const headers = ['Date', 'Amount', 'Type', 'Category', 'Description', 'Notes'];
    const csvContent = [
        headers.join(','),        ...filteredExpenses.map(expense => {
            const amount = Math.abs(expense.amount);
            const type = expense.is_positive ? 'Income' : 'Expense';
            const date = safeFormatDate(expense.expense_date);
            
            return [
                `"${date}"`,
                `"${amount.toFixed(2)}"`,
                `"${type}"`,
                `"${expense.category}"`,
                `"${expense.what.replace(/"/g, '""')}"`,
                `"${(expense.notes || '').replace(/"/g, '""')}"`
            ].join(',');
        })
    ].join('\n');
    
    // Download file
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `expenses_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// ===== CHARTS FUNCTIONALITY =====

function setupChartEventListeners() {
    // Bar chart controls
    document.getElementById('bar-chart-range').addEventListener('change', updateBarChart);
      // Line chart controls
    document.getElementById('line-chart-category').addEventListener('change', updateLineChart);
    document.getElementById('line-chart-period').addEventListener('change', updateLineChart);
    document.getElementById('line-chart-range').addEventListener('change', updateLineChart);
}

function initializeCharts() {
    // Populate category dropdown for line chart
    populateLineCategoryDropdown();
    
    // Initialize charts
    initializeCategoryBarChart();
    initializeTrendLineChart();
}

function populateLineCategoryDropdown() {
    const categorySelect = document.getElementById('line-chart-category');
    const categories = [...new Set(allExpenses.map(expense => expense.category))].sort();
    
    // Clear existing options except "All Categories"
    categorySelect.innerHTML = '<option value="all">All Categories</option>';
    
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category.charAt(0).toUpperCase() + category.slice(1);
        categorySelect.appendChild(option);
    });
}

function initializeCategoryBarChart() {
    const ctx = document.getElementById('category-bar-chart').getContext('2d');
    
    categoryBarChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Total Spent',
                data: [],
                backgroundColor: '#ef4444',
                borderColor: '#dc2626',
                borderWidth: 1,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#a8b3cf',
                        callback: function(value) {
                            return '$' + value.toFixed(0);
                        }
                    },
                    grid: {
                        color: '#374151'
                    }
                },
                x: {
                    ticks: {
                        color: '#a8b3cf',
                        maxRotation: 45
                    },
                    grid: {
                        color: '#374151'
                    }
                }
            },
            onClick: (event, elements) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const category = categoryBarChart.data.labels[index];
                    filterTableByCategory(category);
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    });
}

function initializeTrendLineChart() {
    const ctx = document.getElementById('trend-line-chart').getContext('2d');
    
    trendLineChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Daily Expenses',
                data: [],
                borderColor: '#67e8f9',
                backgroundColor: 'rgba(103, 232, 249, 0.1)',
                tension: 0.4,
                fill: true,
                pointBackgroundColor: '#67e8f9',
                pointBorderColor: '#4fc3f7',
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#a8b3cf'
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#a8b3cf',
                        callback: function(value) {
                            return '$' + value.toFixed(0);
                        }
                    },
                    grid: {
                        color: '#374151'
                    }
                },
                x: {
                    ticks: {
                        color: '#a8b3cf',
                        maxRotation: 45
                    },
                    grid: {
                        color: '#374151'
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    });
}

function updateCharts() {
    updateBarChart();
    updateLineChart();
}

function updateBarChart() {
    const range = document.getElementById('bar-chart-range').value;
    const chartData = getBarChartData(range);
    
    categoryBarChart.data.labels = chartData.labels;
    categoryBarChart.data.datasets[0].data = chartData.data;
    categoryBarChart.update();
    
    // Update table date filters to match the chart range
    updateTableDateFiltersFromRange(range);
}

function getBarChartData(range) {
    let filteredData = [...allExpenses];
    
    // Filter by date range
    if (range !== 'all') {
        const now = new Date();
        let startDate;
        
        switch (range) {
            case '30':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '90':
                startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                break;
            case '365':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            case 'current-month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            case 'current-year':
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date(now.getFullYear(), 11, 31);
                break;
        }          filteredData = filteredData.filter(expense => {
            // Use safe date parsing to handle various date formats
            const expenseDate = safeParseDate(expense.expense_date);
            return expenseDate && expenseDate >= startDate;
        });
    }
    
    // Filter only expenses (not income)
    filteredData = filteredData.filter(expense => !expense.is_positive);
    
    // Group by category and sum amounts
    const categoryTotals = {};
    filteredData.forEach(expense => {
        const category = expense.category;
        categoryTotals[category] = (categoryTotals[category] || 0) + Math.abs(expense.amount);
    });
    
    // Sort by amount (highest first)
    const sortedEntries = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
    
    return {
        labels: sortedEntries.map(([category]) => category.charAt(0).toUpperCase() + category.slice(1)),
        data: sortedEntries.map(([, amount]) => amount)
    };
}

function updateLineChart() {
    const category = document.getElementById('line-chart-category').value;
    const period = document.getElementById('line-chart-period').value;
    const range = document.getElementById('line-chart-range').value;
    
    // Calculate date range based on dropdown selection
    const now = new Date();
    let startDate, endDate = now;
    
    switch (range) {
        case '7':
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case '30':
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        case '90':
            startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            break;
        case '365':
            startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            break;
        case 'current-month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            break;
        case 'current-year':
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(now.getFullYear(), 11, 31);
            break;
    }
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const chartData = getLineChartData(category, period, startDateStr, endDateStr);
    
    trendLineChart.data.labels = chartData.labels;
    trendLineChart.data.datasets[0].data = chartData.data;
    trendLineChart.data.datasets[0].label = `${period.charAt(0).toUpperCase() + period.slice(1)} Expenses${category !== 'all' ? ` - ${category}` : ''}`;
    trendLineChart.update();
}

function getLineChartData(category, period, startDate, endDate) {
    let filteredData = allExpenses.filter(expense => {
        // Use safe date parsing to handle various date formats
        const expenseDate = safeParseDate(expense.expense_date);
        const start = new Date(startDate + 'T12:00:00');
        const end = new Date(endDate + 'T12:00:00');
        
        // Skip invalid dates
        if (!expenseDate) return false;
        
        // Filter by date range
        if (expenseDate < start || expenseDate > end) return false;
        
        // Filter by category
        if (category !== 'all' && expense.category !== category) return false;
        
        // Only expenses (not income)
        return !expense.is_positive;
    });
      // Group data by period
    const periodGroups = {};
    const start = new Date(startDate + 'T12:00:00');
    const end = new Date(endDate + 'T12:00:00');
      // Generate all periods in range
    const current = new Date(start);
    const endDateObj = new Date(end);
    while (current <= endDateObj) {
        const key = formatPeriodKey(current, period);
        periodGroups[key] = 0;
        
        // Advance to next period
        switch (period) {
            case 'daily':
                current.setDate(current.getDate() + 1);
                break;
            case 'weekly':
                current.setDate(current.getDate() + 7);
                break;
            case 'monthly':
                current.setMonth(current.getMonth() + 1);
                break;
        }
    }
      // Sum expenses by period
    filteredData.forEach(expense => {
        const expenseDate = safeParseDate(expense.expense_date);
        if (expenseDate) {
            const key = formatPeriodKey(expenseDate, period);
            if (periodGroups.hasOwnProperty(key)) {
                periodGroups[key] += Math.abs(expense.amount);
            }
        }
    });
    
    const sortedEntries = Object.entries(periodGroups).sort((a, b) => a[0].localeCompare(b[0]));
    
    return {
        labels: sortedEntries.map(([key]) => formatPeriodLabel(key, period)),
        data: sortedEntries.map(([, amount]) => amount)
    };
}

function formatPeriodKey(date, period) {
    switch (period) {
        case 'daily':
            return date.toISOString().split('T')[0];
        case 'weekly':
            const startOfWeek = new Date(date);
            startOfWeek.setDate(date.getDate() - date.getDay());
            return startOfWeek.toISOString().split('T')[0];
        case 'monthly':
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        default:
            return date.toISOString().split('T')[0];
    }
}

function formatPeriodLabel(key, period) {
    switch (period) {
        case 'daily':
            return new Date(key + 'T12:00:00').toLocaleDateString();
        case 'weekly':
            const weekStart = new Date(key + 'T12:00:00');
            return `Week of ${weekStart.toLocaleDateString()}`;
        case 'monthly':
            const [year, month] = key.split('-');
            return new Date(year, month - 1, 15).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
        default:
            return key;
    }
}

function filterTableByCategory(category) {
    // Set category filter
    document.getElementById('category-filter').value = category.toLowerCase();
    
    // Apply the current bar chart date range to the table filters
    const range = document.getElementById('bar-chart-range').value;
    if (range !== 'all') {
        const now = new Date();
        let startDate;
        let endDate = now;
        
        switch (range) {
            case '30':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '90':
                startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                break;
            case '365':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            case 'current-month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            case 'current-year':
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date(now.getFullYear(), 11, 31);
                break;
        }
        
        // Set the date filters to match the chart range
        if (startDate) {
            document.getElementById('date-start-filter').value = startDate.toISOString().split('T')[0];
        }
        document.getElementById('date-end-filter').value = endDate.toISOString().split('T')[0];
    } else {
        // Clear date filters for 'all' range
        document.getElementById('date-start-filter').value = '';
        document.getElementById('date-end-filter').value = '';
    }
    
    // Set sort to amount descending
    sortColumn = 'amount';
    sortDirection = 'desc';
    
    // Update sort indicators
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === 'amount') {
            th.classList.add('sort-desc');
        }
    });
    
    // Apply filters and re-render
    applyFilters();
}

// ===== IMPORT FUNCTIONALITY =====

let parsedImportData = [];

function downloadSampleCSV() {
    const sampleData = [
        ['Date', 'Amount', 'Category', 'What', 'Notes', 'Is Taxable'],
        ['2025-01-15', '50.25', 'food', 'Grocery shopping', 'Weekly groceries', 'false'],
        ['2025-01-16', '12.50', 'restaurant', 'Lunch', 'Business lunch', 'false'],
        ['2025-01-17', '75.00', 'travel', 'Gas', 'Road trip fuel', 'false'],
        ['2025-01-18', '25.99', 'subscriptions', 'Netflix', 'Monthly subscription', 'false'],
        ['2025-01-19', '150.00', 'clothes + accessories', 'New shoes', 'Running shoes', 'false']
    ];

    const csvContent = sampleData.map(row => 
        row.map(cell => `"${cell}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'expense_import_sample.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.target.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    e.target.classList.remove('dragover');
}

function handleFileDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.target.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processFile(files[0]);
    }
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
        processFile(file);
    }
}

function processFile(file) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
        alert('Please select a CSV file.');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            parseCSV(e.target.result);
        } catch (error) {
            console.error('Error parsing CSV:', error);
            alert('Error parsing CSV file. Please check the format and try again.');
        }
    };
    reader.readAsText(file);
}

function parseCSV(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
        alert('CSV file must contain at least a header row and one data row.');
        return;
    }

    // Parse header
    const headers = parseCSVLine(lines[0]);
    const requiredHeaders = ['Date', 'Amount', 'Category', 'What'];
    const missingHeaders = requiredHeaders.filter(header => 
        !headers.some(h => h.toLowerCase().includes(header.toLowerCase()))
    );

    if (missingHeaders.length > 0) {
        alert(`Missing required columns: ${missingHeaders.join(', ')}`);
        return;
    }

    // Map headers to indices
    const headerMap = {};
    headers.forEach((header, index) => {
        const cleanHeader = header.toLowerCase().trim();
        if (cleanHeader.includes('date')) headerMap.date = index;
        else if (cleanHeader.includes('amount')) headerMap.amount = index;
        else if (cleanHeader.includes('category')) headerMap.category = index;
        else if (cleanHeader.includes('what') || cleanHeader.includes('description')) headerMap.what = index;
        else if (cleanHeader.includes('notes')) headerMap.notes = index;
        else if (cleanHeader.includes('taxable')) headerMap.is_taxable = index;
    });

    // Parse data rows
    parsedImportData = [];
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i]);
        if (row.length === 0) continue;

        try {
            const expense = parseExpenseRow(row, headerMap, i + 1);
            if (expense) {
                parsedImportData.push(expense);
            }
        } catch (error) {
            errors.push(`Row ${i + 1}: ${error.message}`);
        }
    }

    if (errors.length > 0) {
        alert(`Found ${errors.length} errors:\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? '\n...' : ''}`);
        return;
    }

    if (parsedImportData.length === 0) {
        alert('No valid data found in CSV file.');
        return;
    }

    showImportPreview();
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim());
    return result;
}

function parseExpenseRow(row, headerMap, rowNumber) {
    // Parse date
    const dateStr = row[headerMap.date]?.trim();
    if (!dateStr) throw new Error('Date is required');
    
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) throw new Error('Invalid date format');

    // Parse amount
    const amountStr = row[headerMap.amount]?.trim();
    if (!amountStr) throw new Error('Amount is required');
    
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount === 0) throw new Error('Invalid amount');

    // All amounts are treated as expenses (is_positive = false)
    const isPositive = false;

    // Parse category
    const category = row[headerMap.category]?.trim();
    if (!category) throw new Error('Category is required');

    // Parse what
    const what = row[headerMap.what]?.trim();
    if (!what) throw new Error('What/Description is required');

    // Parse optional fields
    const notes = row[headerMap.notes]?.trim() || '';
    const isTaxableStr = row[headerMap.is_taxable]?.trim()?.toLowerCase();
    const isTaxable = isTaxableStr === 'true' || isTaxableStr === '1';

    return {
        amount: Math.abs(amount),
        is_positive: isPositive,
        expense_date: date.toISOString().split('T')[0],
        category: category,
        what: what,
        notes: notes,
        is_taxable: isTaxable
    };
}

function showImportPreview() {
    const previewDiv = document.getElementById('import-preview');
    const previewTable = document.getElementById('preview-table');
    const importCount = document.getElementById('import-count');

    // Show first 5 rows as preview
    const preview = parsedImportData.slice(0, 5);
    const previewHtml = preview.map(expense => {
        // All imports are expenses, so show with negative prefix
        return `${expense.expense_date} | -$${expense.amount.toFixed(2)} | ${expense.category} | ${expense.what} | ${expense.notes}`;
    }).join('\n');

    previewTable.textContent = previewHtml;
    importCount.textContent = parsedImportData.length;
    previewDiv.style.display = 'block';

    // Hide file drop zone
    document.getElementById('file-drop-zone').style.display = 'none';
}

async function confirmImport() {
    if (parsedImportData.length === 0) {
        alert('No data to import');
        return;
    }

    const progressDiv = document.getElementById('import-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const previewDiv = document.getElementById('import-preview');

    // Show progress
    previewDiv.style.display = 'none';
    progressDiv.style.display = 'block';

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < parsedImportData.length; i++) {
        try {
            const response = await fetch('/api/expenses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify(parsedImportData[i])
            });

            if (response.ok) {
                successCount++;
            } else {
                errorCount++;
                console.error(`Failed to import row ${i + 1}:`, await response.text());
            }
        } catch (error) {
            errorCount++;
            console.error(`Error importing row ${i + 1}:`, error);
        }

        // Update progress
        const progress = ((i + 1) / parsedImportData.length) * 100;
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `Importing ${i + 1} of ${parsedImportData.length}...`;
    }

    // Show completion message
    progressText.textContent = `Import complete! ${successCount} imported, ${errorCount} errors.`;
    
    setTimeout(() => {
        document.getElementById('import-modal').style.display = 'none';
        resetImportModal();
        loadAllExpenses(); // Reload the expenses table
    }, 2000);
}

function cancelImport() {
    resetImportModal();
}

function resetImportModal() {
    parsedImportData = [];
    document.getElementById('import-preview').style.display = 'none';
    document.getElementById('import-progress').style.display = 'none';
    document.getElementById('file-drop-zone').style.display = 'block';
    document.getElementById('csv-file-input').value = '';
    document.getElementById('progress-fill').style.width = '0%';
}

function consolidateExpenses(expenses, consolidateBy) {
    const consolidated = {};
    
    expenses.forEach(expense => {
        // Create a key based on normalized category and the specified field (what or notes)
        // This helps combine spelling variations by removing spaces, apostrophes, etc.
        let key;
        if (consolidateBy === 'what') {
            const normalizedCategory = normalizeText(expense.category);
            const normalizedWhat = normalizeText(expense.what);
            key = `${normalizedCategory}|${normalizedWhat}`;
        } else if (consolidateBy === 'notes') {
            const normalizedCategory = normalizeText(expense.category);
            const normalizedNotes = normalizeText(expense.notes);
            key = `${normalizedCategory}|${normalizedNotes}`;
        }
        
        if (consolidated[key]) {
            // Add to existing consolidated expense
            consolidated[key].amount += expense.amount;
            // Keep the most recent date using safe date parsing
            const expenseDate = safeParseDate(expense.expense_date);
            const consolidatedDate = safeParseDate(consolidated[key].expense_date);
            if (expenseDate && consolidatedDate && expenseDate > consolidatedDate) {
                consolidated[key].expense_date = expense.expense_date;
            }
            // Append to the other field to show it's consolidated
            if (consolidateBy === 'what') {
                // Consolidating by what, so append to notes
                const currentNotes = consolidated[key].notes || '';
                if (!currentNotes.includes(' (consolidated)')) {
                    consolidated[key].notes = currentNotes + ' (consolidated)';
                }
            } else {
                // Consolidating by notes, so append to what
                const currentWhat = consolidated[key].what || '';
                if (!currentWhat.includes(' (consolidated)')) {
                    consolidated[key].what = currentWhat + ' (consolidated)';
                }
            }
        } else {
            // Create new consolidated entry
            consolidated[key] = {
                ...expense,
                // Use a unique negative ID for consolidated entries to avoid conflicts
                id: -(Math.random() * 1000000 + Date.now())
            };
        }
    });
    
    return Object.values(consolidated);
}

// Expose deleteExpense to global scope for onclick handlers
window.deleteExpense = deleteExpense;

function updateTableDateFiltersFromRange(range) {
    const now = new Date();
    let startDate;
    let endDate = now;
    
    if (range !== 'all') {
        switch (range) {
            case '30':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '90':
                startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                break;
            case '365':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            case 'current-month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            case 'current-year':
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date(now.getFullYear(), 11, 31);
                break;
        }
        
        // Set the date filters to match the chart range
        if (startDate) {
            document.getElementById('date-start-filter').value = startDate.toISOString().split('T')[0];
        }
        document.getElementById('date-end-filter').value = endDate.toISOString().split('T')[0];
    } else {
        // Clear date filters for 'all' range
        document.getElementById('date-start-filter').value = '';
        document.getElementById('date-end-filter').value = '';
    }
    
    // Apply the updated filters to the table
    applyFilters();
}

function handleConsolidateToggle(event) {
    const whatToggle = document.getElementById('consolidate-what-toggle');
    const notesToggle = document.getElementById('consolidate-notes-toggle');
    
    // Ensure mutual exclusivity - only one can be checked at a time
    if (event.target.checked) {
        if (event.target.id === 'consolidate-what-toggle') {
            notesToggle.checked = false;
        } else {
            whatToggle.checked = false;
        }
    }
    
    // Apply filters with the new consolidation setting
    applyFilters();
}

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

function safeParseDate(dateString) {
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
            return null;
        }
        
        return date;
    } catch (error) {
        console.error('Date parsing error:', error, 'Input:', dateString);
        return null;
    }
}

function normalizeText(text) {
    if (!text) return '';
    // Convert to lowercase, remove spaces, apostrophes, and other common punctuation
    return text.toString()
        .toLowerCase()
        .replace(/[\s'"`.,;:!?()-]/g, '')
        .trim();
}
