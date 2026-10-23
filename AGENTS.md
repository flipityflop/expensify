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

`scripts/test-fixed-expenses.js`, `scripts/test-accounts.js` and
`scripts/test-goals.js` assert some of the removed text stays out.

## How the pages work

How each page works, and why.

### Budget

**Monthly plan.** Income − Debt payment − Savings = Left for spending.

- Debt payment is meant for card balances carried over from earlier months.
  Those purchases were already counted as spending in the month they were
  made, so paying the card off is not new spending. It comes off the income
  instead.
- The three amounts are reserved rows in `budget_goals`:
  - `__income__`
  - `__debt_payment__`
  - `__savings__`
- The figures line under the plan:
  - **Budget** = all monthly budgets added up.
  - **Unassigned** = left for spending − Budget. Normally just the cents lost
    to rounding, or all of it when there is no spending history to spread it
    by. It reads **Over by** in red when Budget is more than is left.
  - **Flexible at N%** appears when the flexible parts were scaled: under
    100% squeezed to fit, over 100% grown to use spare money.

**Monthly budgets are worked out.** For each monthly group
(`monthlyBudgets()` in `budget.js`):

- **Fixed** = its fixed expenses.
- Its **usual flexible** part = its average monthly spend before the selected
  month, minus Fixed, never below 0. Past spending already includes the
  fixed bills, so only the average above them is flexible. With no earlier
  month it is 0.
- **Flexible** = the usual flexible part, scaled to fill what is left for
  spending (below).
- **Budget** = Fixed + Flexible.
- **Remaining** = Budget − Spent this month.

**Filling what is left for spending.** With an income set, every group
without a target scales its usual flexible part by one shared proportion.
The budgets then use exactly what is left for spending after the targets and
the other groups' fixed bills.

- Short of money, the groups shrink. With money to spare, they grow: the
  remainder is spread across them in proportion to what each usually spends
  beyond its fixed bills.
- Fixed bills and targets never change.
- A group with no spending history has no flexible part, so it gets no
  share.
- Scaled amounts round down to the cent, so the total can't pass what is
  left. The leftover cents show as Unassigned.
- If targets and fixed bills alone exceed what is left, the flexible parts go
  to 0 and the plan reads Over by.
- With no income set, or no spending history to scale by, nothing scales.

**Targets.** Typing in a group's Target sets its budget for the selected month
only (table `budget_targets`). A blank Target goes back to the worked-out
budget.

- The other groups fill around it as above, so a target takes from them.
- A target below a group's fixed bills is kept as typed. Its Flexible goes
  negative and shows red.
- Yearly goals are **not** taken off the income before fitting. The owner
  reverted that (35a291e). Ask before bringing it back.

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

### Accounts

Four sections, one page: credit cards, investment accounts, retirement accounts
and the debt tracker. Every section's rows share one look (`.acct-row`), and its
own figures sit under its heading.

#### Credit cards

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

**Balance date.** Typing a new balance sets its as-of date to today, as it does
for an investment or retirement account.

#### Investment accounts

Tracked, not projected: a kind, what it is worth, the date that was read, and
what goes in each month. The kinds are `INVESTMENT_KINDS` in `categories.js`,
which the server checks a saved account against.

- Largest balance first.
- The figures under the heading are the balance, and the monthly contributions
  when there are any.

#### Retirement accounts

The same fields plus the annual rate of return, typed by hand - nothing here
guesses at a market.

- The rate is a percentage a year. It may be negative: a pessimistic projection
  is still a projection. An account with no rate shows none, and grows only by
  what is paid in.

**Projected growth.** The combined balance at 1, 5, 10, 15, 20, 25 and 30 years
(`PROJECTION_YEARS` in `retirement.js`).

- Each account is compounded monthly at its own rate, with its contribution
  paid in at the end of each month: the usual future value of a balance plus an
  annuity.
- **Growth** is what is left after today's balance and everything paid in, so
  the three figures always add up.
- The bar is that year's balance against the furthest year's, so the rows read
  as one curve.
- The table is hidden when there is nothing to project.

#### Debt tracker

The bar shows what is still owed, so it empties as the debt is paid down.
Payoff adds to the paid amount and moves the as-of date.

### Goals

A goal is an amount, a date it is wanted by, and what has been put by so far.
The page works out what has to go by each month to get there.

- **Months left** is whole calendar months from today to the date. A date later
  in its month counts that month; an earlier one does not.
- **The monthly amount** is what is left spread over those months, and all of
  it at once with less than a month to go - never a division by zero or by a
  negative.
- A goal already met asks for nothing a month, whatever its date.
- A date gone by with money still to find is red.
- The bar fills as the money goes by, the opposite way round to a debt bar.
- The line under the tiles appears only when the goals need more a month than
  the budget plan's savings row sets aside - money that would have to come from
  somewhere else.
- Put by adds to what is saved, capped at the target, as a debt payoff is.

### Receipts

A receipt is a photo kept against one expense, as proof. There is no matching:
it is taken with the expense or added from the expense's row.

- **Where.** The entry form has a Receipt picker. Each row on the home page
  and the Expenses page ends in 📎 (none yet, opens the picker) or 🧾 / 🧾N
  (opens the viewer: each photo, Original, Remove, and Add). A consolidated
  row has no button: it stands for several expenses.
- **The picker.** `accept="image/*"` and no `capture` attribute, so the phone
  offers its camera and its photo library. `capture` would go straight to the
  camera. `test-receipts.js` checks it stays off.
- **Two files per photo** in the R2 bucket:
  - the original, byte for byte as the phone handed it over, the proof;
  - a JPEG copy, long edge at most 3000 px and under 4 MB (Azure's free tier
    limit, for reading text later). The viewer shows it. Drawing it through an
    `<img>` turns the photo upright and turns HEIC into something every
    browser shows.
- **Upload.** The browser asks for signed URLs, puts both files straight into
  the bucket (Vercel's 4.5 MB request limit never applies), then asks for the
  upload to be recorded. The server checks both files are there, reads the
  original back and stores its SHA-256. Nothing is recorded that is not in
  the bucket.
- **The entry form waits.** The expense is saved first, then its photos, and
  the form resets only after both. If a photo fails the expense stays, the
  message says so, and the row's 📎 tries again.
- **The same photo twice** on one expense is stored once. It can go on two
  expenses: one receipt split across two categories.
- **Deleting** a receipt, or an expense with receipts, removes the files
  first and the row after: if the files cannot be removed, the row is still
  there to say they exist. The delete question names the receipts.
- The bucket is private. An `<img>` cannot send the login token, so the page
  gets signed URLs good for an hour.

### Tab bar

- On a phone each tab keeps at least 30% of the width, so the bar slides
  sideways instead of squeezing.
- It comes to rest with a tab centred, and fades at whichever edge has more
  tabs past it.
- `auth.js` centres the current page's tab on load.

## Working in this repo

- **Script loading.** Pages load classic scripts that share one global scope,
  in the order the HTML lists them.
  - `categories.js` is the only category list, and the only list of account
    kinds.
  - `helpers.js` has `money()`, `escapeHtml()`, `isoDate()`, `shortDate()` and
    the modal-closing listener.
  - `receipts.js` builds the receipt picker and viewer into the page itself,
    so the home and Expenses pages share one copy. The page defines
    `receiptsChanged()` to redraw a row.
  - Top-level names must be unique across every script a page loads.
- **Tests.** `npm test` runs the shipped files in a `vm` with a stub DOM, with
  no database. Each page test loads that page's scripts together, so a name
  clash fails there first.
  - Objects and arrays built inside the vm have their own prototypes, so pass
    them out as JSON before `deepStrictEqual`.
- **Running without Turso.**
  `TURSO_DATABASE_URL=file:/tmp/x.db TURSO_AUTH_TOKEN=x APP_PASSWORD=pw node server.js`.
  Receipts also need the `R2_*` variables; `R2_ENDPOINT` can point them at a
  local S3-compatible store.
  Chart.js on the Expenses page comes from a CDN and may not load in a
  sandbox.
- **Server conventions.**
  - Tables are created on cold start with `CREATE TABLE IF NOT EXISTS`.
    Columns are added with `try { ALTER TABLE … } catch {}`.
  - Each new resource follows the debts routes: one validation function
    returning `{ error }` or `{ args }`, shared by POST and PUT.
