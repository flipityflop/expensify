# 💰 Expense Tracker

A simple, lightweight expense tracking web application built with Node.js and SQLite. Designed for mobile-first usage with a clean, fast interface.

## Features

- ✅ **Quick Expense Entry**: Simple form with all essential fields
- ✅ **Income/Expense Toggle**: Easy switch between expenses and income
- ✅ **Smart Date Picker**: Default to today with navigation arrows
- ✅ **Category Selection**: Predefined categories for consistent tracking
- ✅ **Autocomplete**: Smart suggestions based on previous entries
- ✅ **Mobile Optimized**: Fast, responsive design for mobile devices
- ✅ **Real-time Updates**: Instant feedback and updates
- ✅ **Data Persistence**: SQLite database for reliable storage

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Open in browser**:
   Navigate to `http://localhost:3000`

## Form Fields

1. **Amount** - Dollar amount (positive number)
2. **Type Toggle** - Switch between Expense (default) and Income
3. **Expense Date** - Date picker with navigation arrows (defaults to today)
4. **Category** - Dropdown with predefined categories:
   - Kitchen / Home
   - Investments
   - Office Work
   - Subscriptions
   - Electronics Personal
   - Clothes + Accessories
   - Travel
   - Food
   - Various / Debt Repayment
   - Fun
   - Rent + Bills
   - Gifts
   - Health
   - Restaurant
   - Tzedakah
5. **What** - Description with autocomplete from previous entries
6. **Notes** - Optional details with autocomplete

## Database

The application uses SQLite with the following schema:

```sql
expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    is_positive INTEGER DEFAULT 0,      -- 0 for expense, 1 for income
    expense_date TEXT NOT NULL,         -- Date of the expense
    category TEXT NOT NULL,             -- Selected category
    what TEXT NOT NULL,                 -- Description
    notes TEXT,                         -- Optional notes
    submission_date TEXT DEFAULT CURRENT_TIMESTAMP  -- When record was created
)
```

## API Endpoints

- `GET /api/expenses` - Retrieve all expenses
- `POST /api/expenses` - Add new expense
- `DELETE /api/expenses/:id` - Delete expense
- `GET /api/autocomplete/what?q=query` - Get suggestions for "what" field
- `GET /api/autocomplete/notes?q=query` - Get suggestions for "notes" field

## Technology Stack

- **Backend**: Node.js + Express
- **Database**: SQLite3
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Styling**: Mobile-first responsive CSS
- **Dependencies**: Minimal (express, sqlite3, cors)

## Project Structure

```
expense-tracker/
├── server.js              # Main Express server
├── package.json           # Node.js dependencies
├── database/              # SQLite database files (auto-created)
└── public/               # Static frontend files
    ├── index.html        # Main HTML page
    ├── styles.css        # Mobile-optimized CSS
    └── script.js         # Frontend JavaScript
```

## Mobile Optimization

- Touch-friendly interface with large buttons
- Responsive design that works on all screen sizes
- Fast loading with minimal JavaScript
- Native form controls for better mobile experience
- Prevents zoom on input focus (iOS)

## Future Enhancements

- Export data to CSV
- Category customization
- Expense search and filtering
- Monthly/yearly summaries
- Data visualization with charts
- Multi-user support with authentication

## Development

To modify the application:

1. **Backend changes**: Edit `server.js` for API endpoints
2. **Frontend changes**: Edit files in `public/` directory
3. **Database changes**: Modify schema in `server.js` initialization
4. **Styling**: Update `public/styles.css` for visual changes

The application automatically creates the database on first run, so no additional setup is required.
