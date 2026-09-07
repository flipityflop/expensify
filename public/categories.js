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

// Budget goals are monthly for everything except these two, which are lumpy
// month to month and only make sense against a full calendar year.
const YEARLY_CATEGORIES = ['Tzedakah', 'Travel'];

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
    module.exports = { CATEGORIES, INCOME_CATEGORIES, YEARLY_CATEGORIES, goalPeriod };
}
