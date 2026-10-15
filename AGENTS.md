# Notes for agents

Read this before changing anything under `public/`. Schema, API routes and
setup are in [README.md](README.md).

## UI text: none unless it earns its place

The owner does not want explainer text in the UI unless it is very important
or genuinely helpful. How a feature works belongs in this file, the README or
code comments, not on the page.

**Fine on the page**, each kept to a few words:

- Labels, headings, column names, button text.
- Numbers and dates: `Fixed $245.00 · Unassigned $0.00`, `in 3 days`.
- Short empty states: `No cards yet.`
- Warnings that something is wrong or about to cost money: goals over what is
  left for spending, fixed expenses over a category's goal, a fee renewing
  within 30 days.
- A one-line confirm before overwriting data, and one-line error alerts.

**Not on the page**:

- Section notes or subtitles under a heading.
- Hint lines under a label.
- `e.g. …` placeholders.
- Long `title` tooltips.
- "How this works" sentences.
- Multi-paragraph confirm dialogs.
- Saying a value is "not set". Leave it out instead: a card with no APR shows
  no APR, and a fixed expense with no due date shows no date.

`scripts/test-fixed-expenses.js` and `scripts/test-cards.js` assert some of the
removed text stays out.

## How the pages work

What the UI used to say, and the reasoning behind it.

### Budget

**Monthly plan.** Income − Debt payment − Savings = Left for spending.

- Debt payment is meant for card balances carried over from earlier months.
  Those purchases were already counted as spending in the month they were
  made, so paying the card off is not new spending. It comes off the income
  instead.
- The three amounts are reserved rows in `budget_goals`:
  - `__spending_budget__` is the income. It keeps the name from when the
    figure was "income to spend", so the saved amount carried over.
  - `__debt_payment__`
  - `__savings__`
- The figures line under the plan:
  - **Budget** = all monthly budgets added up.
  - **Unassigned** = left for spending − Budget. It reads **Over by** in red
    when Budget is more than is left for spending.
  - **Flexible at N%** appears when targets squeezed the other groups.

**Monthly budgets are worked out, not typed.** For each monthly group
(`monthlyBudgets()` in `budget.js`):

- **Fixed** = its fixed expenses.
- **Flexible** = its average monthly spend before the selected month, minus
  Fixed, never below 0. Past spending already includes the fixed bills, so
  only the average above them is flexible. With no earlier month it is 0.
- **Budget** = Fixed + Flexible, so in practice the average, but never less
  than the fixed bills.
- **Remaining** = Budget − Spent this month.

**Targets.** Typing in a group's Target sets its budget for the selected month
only (table `budget_targets`). A blank Target goes back to the worked-out
budget.

- Every other group fits around the targets. From left for spending, take
  the targets and the other groups' fixed bills. Then shrink the other
  groups' flexible parts by one shared proportion until they fit.
- Fixed bills never shrink.
- Groups never grow past their average: spare money stays Unassigned.
- Shrunk amounts round down to the cent, so they can't add up past what is
  left.
- If targets and fixed bills alone exceed what is left, the flexible parts go
  to 0 and the plan reads Over by.
- With no income set, nothing shrinks, but targets still set their budgets.
- A target below a group's fixed bills is kept as typed. Its Flexible goes
  negative and shows red.
- Yearly goals are **not** taken off the income before fitting. The owner
  reverted that (35a291e). Ask before bringing it back.

**Removed:** pinning a whole category, typed monthly goals, and the Autofill
button.

- Older databases still have `budget_goals.fixed` (the pin) and the old
  monthly goal rows. Nothing reads them.
- A group that used to be pinned, like Rent, should be a fixed expense now.

**Fixed expenses inside a category.** Click the category name (▸) to open its
row. The `N fixed` badge counts what is inside.

- Each fixed expense is monthly or yearly.
- A due date is optional: a day of the month for a monthly one, or a month
  and day for a yearly one.
- In a monthly category, a yearly amount counts at a twelfth. In a yearly
  category, a monthly amount counts twelve times.
- For a yearly group, adding one raises its typed goal to cover its fixed
  expenses if the goal is unset or below them. It never lowers a goal.

**Fixed expenses schedule.** Every fixed expense, by next due date from today;
ones with no date go last.

- Rows due within 7 days are amber.
- A due day past the end of a short month falls on that month's last day.
- The monthly total counts yearly ones at a twelfth.

**Yearly goals.** Still typed by hand: maaser is a rule, not an average.

- Tzedakah runs on the Jewish year, 1 Tishrei to 29 Elul. The calculation is
  `public/hebrew-calendar.js`: plain arithmetic, not `Intl`.
- Travel runs January to December.
- Each row shows the period it covers.
- For the selected month, the year is the one containing today if that month
  is the current one, otherwise the one containing its last day.

**Progress bar.** Monthly budgets plus a twelfth of each yearly goal, against
this month's spending.

### Cards

**Order.** Highest APR first, since extra payments save the most there. Cards
with no APR go last; ties go to the larger balance.

**Interest a month.** Roughly balance × APR / 12.

- It's an estimate: cards charge daily on the average balance.
- Nothing is charged on a balance paid in full by the due date.

**Annual fee renewal.**

- A stored date still in the future is shown as it is. A waived first year
  can put it more than a year out.
- A date already passed rolls forward a year at a time, and 29 February
  becomes the 28th outside leap years.
- Amber within 30 days: the time to ask for a retention offer or cancel
  before the fee posts.

**Balance date.** Typing a new balance sets its as-of date to today.

**Debt tracker.** The bar shows what is still owed, so it empties as the debt
is paid down. Payoff adds to the paid amount and moves the as-of date.

### Tab bar

- On a phone each tab keeps at least 30% of the width, so the bar slides
  sideways instead of squeezing.
- It comes to rest with a tab centred, and fades at whichever edge has more
  tabs past it.
- `auth.js` centres the current page's tab on load.

## Working in this repo

- **Script loading.** Pages load classic scripts that share one global scope,
  in the order the HTML lists them.
  - `categories.js` is the only category list.
  - `helpers.js` has `money()`, `escapeHtml()`, `isoDate()` and the
    modal-closing listener.
  - Top-level names must be unique across every script a page loads.
- **Tests.** `npm test` runs the shipped files in a `vm` with a stub DOM, with
  no database. Each page test loads that page's scripts together, so a name
  clash fails there first.
  - Objects and arrays built inside the vm have their own prototypes, so pass
    them out as JSON before `deepStrictEqual`.
- **Running without Turso.**
  `TURSO_DATABASE_URL=file:/tmp/x.db TURSO_AUTH_TOKEN=x APP_PASSWORD=pw node server.js`.
  Chart.js on the Expenses page comes from a CDN and may not load in a
  sandbox.
- **Server conventions.**
  - Tables are created on cold start with `CREATE TABLE IF NOT EXISTS`.
    Columns are added with `try { ALTER TABLE … } catch {}`.
  - Each new resource follows the debts routes: one validation function
    returning `{ error }` or `{ args }`, shared by POST and PUT.
