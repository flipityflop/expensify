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
    category TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    period TEXT NOT NULL DEFAULT 'monthly',    -- 'monthly' | 'yearly'
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

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

## Categories

Defined once in `public/categories.js` — the browser pages and the migration
scripts both read that file. Add a category there and nowhere else.

**Expense** (22): Groceries, Household Supplies, Restaurants & Takeout, Transportation, Car, Home & Furnishing, Household Help, Clothing & Accessories, Beauty & Wigs, Rent, Bills & Insurance, Health, Fitness, Tzedakah, Judaism, Gifts, Fun & Entertainment, Travel, Subscriptions & Software, Work Expenses, Shopping & Other, Debt, Fees & Taxes

**Income**: work, sidejob, gift, investment, other

Income is the `is_positive` toggle, not a category; the list above is the income
sub-type, a separate dimension only reachable behind that toggle.

Budget goals are monthly, except **Tzedakah** and **Travel**, which are yearly
(`YEARLY_CATEGORIES` in `public/categories.js`).

## Project Structure

```
expensify-site/
├── server.js              # Express app + libsql client
├── vercel.json            # Vercel routing (everything → server.js)
├── package.json
├── .env.example
├── scripts/               # Maintenance, run by hand with node
│   ├── db.js              # Shared Turso client
│   ├── backup.js          # Dump expenses to backups/*.json
│   ├── restore.js         # Restore from a dump (dry-run by default)
│   ├── migrate-v3.js      # Category remap + notes split (dry-run by default)
│   └── test-csv-roundtrip.js
└── public/                # Served by Express static middleware
    ├── index.html         # Main entry form
    ├── login.html
    ├── budget.html        # Goals vs actual, per month
    ├── all-expenses.html  # Filter / chart / export view
    ├── categories.js      # THE category list - browser and scripts both read it
    ├── auth.js            # Shared auth helpers + active-tab marking
    ├── script.js
    ├── budget.js
    ├── all-expenses.js
    └── style.css
```

`public/all-expenses.css` was deleted: no page ever linked it. All styling is in
`style.css`.

## Checks

```bash
node scripts/migrate-v3.js --selftest   # category/merchant mapping rules
node scripts/test-csv-roundtrip.js      # export -> import survives a round trip
```

## Deployment

Push to `main` → Vercel auto-deploys. Env vars must be set in the Vercel dashboard.
