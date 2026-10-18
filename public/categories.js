// Single source of truth for the category lists.
//
// Plain script, no build step: every page loads this before its own script.
// Top-level declarations in a classic script are visible to the scripts that
// follow it, so pages just use `CATEGORIES` directly. The migration scripts
// require() this same file - hence the module.exports at the bottom.
//
// The list used to be copied into three places and had already drifted out of
// sync. If you add a category, add it here only.
//
// Values are stored in the database exactly as written, so they are already
// display-ready. Do not title-case them at the call site.

// Ordered as they should appear in the dropdown: most frequently entered first,
// so the common case is the short reach.
const CATEGORIES = [
    'Groceries',
    'Household Supplies',
    'Restaurants & Takeout',
    'Transportation',
    'Car',
    'Home & Furnishing',
    'Household Help',
    'Clothing & Accessories',
    'Beauty & Wigs',
    'Rent',
    'Bills & Insurance',
    'Health',
    'Fitness',
    'Tzedakah',
    'Judaism',
    'Gifts',
    'Fun & Entertainment',
    'Travel',
    'Subscriptions & Software',
    'Work Expenses',
    'Shopping & Other',
    'Debt, Fees & Taxes'
];

// Income is the is_positive toggle, not a category - these are the income
// sub-types, a separate dimension only reachable behind that toggle.
const INCOME_CATEGORIES = ['work', 'sidejob', 'gift', 'investment', 'other'];

// Budgets are monthly for everything except these two, which are lumpy
// month to month and only make sense against a full year.
const YEARLY_CATEGORIES = ['Tzedakah', 'Travel'];

// Of those, the ones whose year is the Jewish year - 1 Tishrei to the day
// before the next - rather than January to December.
const HEBREW_YEAR_CATEGORIES = ['Tzedakah'];

// The kinds of account on the Accounts page. Investments are only tracked;
// retirement ones are also projected forward, which is why they are two lists
// and two sections rather than one with a flag.
const INVESTMENT_KINDS = ['Brokerage', 'Savings', 'CD', 'Crypto', 'Real estate', 'HSA', '529', 'Other'];

const RETIREMENT_KINDS = ['401(k)', 'Roth IRA', 'Traditional IRA', '403(b)', 'SEP IRA', 'Pension', 'Other'];

function goalPeriod(category) {
    return YEARLY_CATEGORIES.includes(category) ? 'yearly' : 'monthly';
}

// Fills a <select> with options. `placeholder` becomes the first, empty-valued
// entry; pass null for a select that should have no blank choice.
function fillCategorySelect(select, categories, placeholder) {
    select.innerHTML = '';
    if (placeholder !== null) select.appendChild(new Option(placeholder, ''));
    categories.forEach(c => select.appendChild(new Option(c, c)));
}

if (typeof module !== 'undefined') {
    module.exports = { CATEGORIES, INCOME_CATEGORIES, YEARLY_CATEGORIES, HEBREW_YEAR_CATEGORIES, INVESTMENT_KINDS, RETIREMENT_KINDS, goalPeriod };
}
