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
    notes TEXT,                                -- optional
    event TEXT,                                -- optional tag (e.g. trip name)
    is_taxable INTEGER DEFAULT 0,              -- only meaningful for income
    submission_date TEXT DEFAULT CURRENT_TIMESTAMP,
    version INTEGER DEFAULT 1                  -- 1 = pre-Vercel migration, 2 = after
);
```

The schema is created on cold start via `CREATE TABLE IF NOT EXISTS` in `server.js`.

## API Endpoints

All require `Authorization: Bearer <APP_PASSWORD>` except `/api/login`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/login` | Validates password, returns it as token |
| `GET` | `/api/expenses` | All expenses, newest first |
| `POST` | `/api/expenses` | Add an expense (always written with `version = 2`) |
| `DELETE` | `/api/expenses/:id` | Delete by id |
| `GET` | `/api/autocomplete/what?q=` | Suggest descriptions |
| `GET` | `/api/autocomplete/notes?q=` | Suggest notes |
| `GET` | `/api/autocomplete/event?q=` | Suggest events |
| `GET` | `/api/suggestions/notes-by-what?what=` | Most-common notes for a given "what" |

## Categories

**Expense**: kitchen / home, investments, office work, subscriptions, electronics personal, clothes + accessories, travel, food, various/ debt repayment, fun, rent+bills, gifts, health, beauty, restaurant, tzedakah

**Income**: work, sidejob, gift, investment, other

(Note: income uses `investment` singular, expense uses `investments` plural — intentional, they're different concepts.)

## Project Structure

```
expensify-site/
├── server.js              # Express app + libsql client
├── vercel.json            # Vercel routing (everything → server.js)
├── package.json
├── .env.example
└── public/                # Served by Express static middleware
    ├── index.html         # Main entry form
    ├── login.html
    ├── all-expenses.html  # Filter / chart / export view
    ├── script.js
    ├── all-expenses.js
    ├── style.css
    └── all-expenses.css
```

## Deployment

Push to `main` → Vercel auto-deploys. Env vars must be set in the Vercel dashboard.
