# Expense Tracker

Personal expense + income tracker. Hosted on Vercel with a Turso (libSQL) database.

## Tech Stack

- **Hosting**: Vercel (serverless Node.js function)
- **Database**: Turso (hosted SQLite via `@libsql/client`)
- **Backend**: Express.js
- **Frontend**: Vanilla HTML/CSS/JS + Chart.js (CDN)
- **Auth**: Single password via `APP_PASSWORD` env var, stored as Bearer token in `localStorage`

## Environment Variables

Required in both `.env` (local) and Vercel dashboard (production):

| Var | Purpose |
|-----|---------|
| `TURSO_DATABASE_URL` | Turso database URL (use `https://` prefix, not `libsql://`, for serverless) |
| `TURSO_AUTH_TOKEN` | Turso auth token (generate via Turso dashboard) |
| `APP_PASSWORD` | Password to log into the app |

See `.env.example` for the template.

## Local Development

```
npm install
npm start
```

Then open `http://localhost:3000`. Uses the same Turso database as production by default — there is no separate local database.

## Database Schema

```sql
CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    is_positive INTEGER DEFAULT 0,             -- 0 = expense, 1 = income
    expense_date TEXT NOT NULL,                -- YYYY-MM-DD
    category TEXT NOT NULL,
    what TEXT NOT NULL,                        -- short description
    notes TEXT,                                -- FROZEN: pre-v3 backup, never written
    merchant TEXT,                             -- where (optional)
    event TEXT,                                -- why (optional, e.g. trip name)
    is_taxable INTEGER DEFAULT 0,              -- only meaningful for income
    submission_date TEXT DEFAULT CURRENT_TIMESTAMP,
    version INTEGER DEFAULT 1                  -- 1 = pre-Vercel migration, 2 = after
);

CREATE TABLE budget_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL UNIQUE,             -- or a reserved plan key, below
    amount REAL NOT NULL,
    period TEXT NOT NULL DEFAULT 'monthly',    -- 'monthly' | 'yearly'
    fixed INTEGER DEFAULT 0,                   -- 1 = whole goal pinned; autofill leaves it alone
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    total REAL NOT NULL,                       -- originally owed
    paid REAL NOT NULL DEFAULT 0,              -- cleared so far; remaining = total - paid
    notes TEXT,
    as_of TEXT,                                -- YYYY-MM-DD the balance is current as of
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE fixed_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,                    -- one of the expense categories
    name TEXT NOT NULL,                        -- e.g. Phone, inside Bills & Insurance
    amount REAL NOT NULL,                      -- per `frequency`
    frequency TEXT NOT NULL DEFAULT 'monthly', -- 'monthly' | 'yearly'
    due_day INTEGER,                           -- 1-31, null = no due date
    due_month INTEGER,                         -- 1-12, yearly ones only
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credit_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,           -- owed now; below 0 when in credit
    balance_as_of TEXT,                        -- YYYY-MM-DD the balance was read
    apr REAL,                                  -- percentage, e.g. 24.99; null = not known
    annual_fee REAL NOT NULL DEFAULT 0,
    fee_renewal TEXT,                          -- YYYY-MM-DD the fee posts; rolled forward yearly on the page
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

The monthly plan on the budget page is three reserved rows in `budget_goals`,
kept out of the category list by their leading underscores:
`__spending_budget__` (the income - named from when it was "income to spend"),
`__debt_payment__` and `__savings__`.

The schema is created on cold start via `CREATE TABLE IF NOT EXISTS` in `server.js`.

One dimension per field: **category** = what was bought, **merchant** = where,
**event** = why. `notes` used to hold all three at once; `scripts/migrate-v3.js`
split it, and the column is kept unwritten as the in-place backup.

## API Endpoints

All require `Authorization: Bearer <APP_PASSWORD>` except `/api/login`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/login` | Validates password, returns it as token |
| `GET` | `/api/expenses` | All expenses, newest first |
| `POST` | `/api/expenses` | Add an expense (always written with `version = 2`) |
| `DELETE` | `/api/expenses/:id` | Delete by id |
| `GET` | `/api/autocomplete/what?q=` | Suggest descriptions |
| `GET` | `/api/autocomplete/merchant?q=` | Suggest merchants |
| `GET` | `/api/autocomplete/event?q=` | Suggest events |
| `GET` | `/api/merchants-by-category?category=` | Top 6 merchants in a category (entry-form chips) |
| `GET` | `/api/budget-goals` | All budget goals |
| `PUT` | `/api/budget-goals` | Upsert one goal by category |
| `GET` | `/api/debts` | All debts, oldest first |
| `POST` | `/api/debts` | Add a debt |
| `PUT` | `/api/debts/:id` | Replace a debt's name, total, paid, notes and as-of date |
| `POST` | `/api/debts/:id/payoff` | Add to what is paid off and move the as-of date |
| `DELETE` | `/api/debts/:id` | Delete by id |
| `GET` | `/api/fixed-expenses` | All fixed expenses, by category |
| `POST` | `/api/fixed-expenses` | Add a fixed expense |
| `PUT` | `/api/fixed-expenses/:id` | Replace a fixed expense's category, name, amount, frequency and due date |
| `DELETE` | `/api/fixed-expenses/:id` | Delete by id |
| `GET` | `/api/credit-cards` | All credit cards |
| `POST` | `/api/credit-cards` | Add a card |
| `PUT` | `/api/credit-cards/:id` | Replace a card's name, balance and its as-of date, APR, annual fee, renewal date and notes |
| `DELETE` | `/api/credit-cards/:id` | Delete by id |

## Categories

Defined once in `public/categories.js` — the browser pages and the migration
scripts both read that file. Add a category there and nowhere else.

**Expense** (22): Groceries, Household Supplies, Restaurants & Takeout, Transportation, Car, Home & Furnishing, Household Help, Clothing & Accessories, Beauty & Wigs, Rent, Bills & Insurance, Health, Fitness, Tzedakah, Judaism, Gifts, Fun & Entertainment, Travel, Subscriptions & Software, Work Expenses, Shopping & Other, Debt, Fees & Taxes

**Income**: work, sidejob, gift, investment, other

Income is the `is_positive` toggle, not a category; the list above is the income
sub-type, a separate dimension only reachable behind that toggle.

Budget goals are monthly, except **Tzedakah** and **Travel**, which are yearly
(`YEARLY_CATEGORIES` in `public/categories.js`). Tzedakah's year is the Jewish
year, Rosh Hashanah (1 Tishrei) to the day before the next
(`HEBREW_YEAR_CATEGORIES`); Travel's is January to December.

## How the pages work

What each page does and why, and the rule on UI text (none unless it earns its
place), are in [AGENTS.md](AGENTS.md).

## Project Structure

```
expensify-site/
├── AGENTS.md              # How the pages work + UI text rule (CLAUDE.md imports it)
├── server.js              # Express app + libsql client
├── vercel.json            # Vercel routing (everything → server.js)
├── package.json
├── .env.example
├── scripts/               # Maintenance, run by hand with node
│   ├── db.js              # Shared Turso client
│   ├── backup.js          # Dump expenses to backups/*.json
│   ├── restore.js         # Restore from a dump (dry-run by default)
│   ├── migrate-v3.js      # Category remap + notes split (dry-run by default)
│   ├── migrate-debts-to-cards.js  # One-time: card debts -> credit_cards (dry-run by default)
│   ├── test-csv-roundtrip.js
│   ├── test-hebrew-calendar.js
│   ├── test-budget.js
│   ├── test-fixed-expenses.js
│   ├── test-cards.js
│   └── test-debt.js
└── public/                # Served by Express static middleware
    ├── index.html         # Main entry form
    ├── login.html
    ├── budget.html        # Goals vs actual, per month
    ├── all-expenses.html  # Filter / chart / export view
    ├── cards.html         # Credit cards + debt tracker
    ├── categories.js      # THE category list - browser and scripts both read it
    ├── hebrew-calendar.js # Rosh Hashanah for any year, for Tzedakah's year
    ├── auth.js            # Shared auth helpers + active-tab marking and sliding
    ├── helpers.js         # money, escaping, local dates, modal closing (budget + cards)
    ├── script.js
    ├── budget.js
    ├── cards.js           # Credit cards section of the cards page
    ├── debts.js           # Debt tracker section of the cards page
    ├── fixed-expenses.js  # Fixed expenses: the modal, opened rows, due-date schedule
    ├── all-expenses.js
    └── style.css
```

`public/all-expenses.css` was deleted: no page ever linked it. All styling is in
`style.css`.

## Checks

```bash
node scripts/migrate-v3.js --selftest   # category/merchant mapping rules
node scripts/test-csv-roundtrip.js      # export -> import survives a round trip
node scripts/test-hebrew-calendar.js    # Rosh Hashanah against published dates
node scripts/test-budget.js             # autofill split, plan, fixed expenses, Tzedakah's year
node scripts/test-fixed-expenses.js     # next due dates, opened rows, schedule
node scripts/test-cards.js              # card interest, fee renewal, order, totals
node scripts/test-debt.js               # debt remaining + bar arithmetic
```

`npm test` runs all seven. The first needs `TURSO_*` set; the others do not
touch the database.

## Deployment

Push to `main` → Vercel auto-deploys. Env vars must be set in the Vercel dashboard.
