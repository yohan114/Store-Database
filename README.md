# Workshop & Stores — Unified System

One application for **Edward & Christie (Pvt) Ltd** that combines the **Job Card
System** (vehicle & machinery repair/service jobs) with the **Stores / Delivery
Monitor** (MRN requests, receiving, GRN/pricing, issues, batteries, transfers),
behind a single login and a premium analytics dashboard.

It runs as one Node + SQLite app: fast, cross-platform (Windows / Mac / Linux),
no MS Access required.

## Setup

```bash
npm install            # installs the SQLite engine + libs
npm run migrate        # builds inventory.db from the store data (safe to re-run)
npm start              # serves http://localhost:5000/item_tracker.html
```

### TypeScript client

The browser application is written in **TypeScript** under `src/client/`
(`app.ts` — the main app, `login.ts` — the sign-in page, `globals.d.ts` — the
domain types: `Item`, `ReceiptRec`, `IssueRec`, `BatteryRec`, `TransferRec`,
`JobCard`, `QueueAction`). It compiles to plain classic scripts in `js/`
(committed, so `npm start` needs no build step):

```bash
npm run build:client   # compile src/client -> js/ (run after editing client code)
npm run typecheck      # type-check only, no emit
```

Never edit `js/*.js` directly — they are build output. The HTML files contain
only markup plus two tiny bootstrap snippets (error collector, Tailwind
config); all application logic lives in the TypeScript sources.

On Windows you can double-click **`start_server.bat`** (runs all three steps).

- First run seeds a default admin — **username `admin`, password `admin123`** —
  and prompts you to set a new password on first login.
- `npm run migrate` is safe to re-run; `npm run migrate:force` re-imports the
  store data from scratch. New tables (users, job cards, daily programme, etc.)
  are created automatically on startup.
- `npm run test:api` runs the self-contained API test suite (boots on a spare
  port, logs in, exercises every endpoint, prints a report).

### Importing historical workshop data
`tools/import_workshop.js` loads `data/Job_Record.xlsx` (Requested job + C-job →
job cards) and `data/Daily_Work_Done.xlsx` (daily log → daily programme, plus
the `Labor Hour` rate sheet → mechanics). Daily lines are matched to a job by
vehicle + date window; unmatched lines go to a per-vehicle catch-all job. It's
idempotent (jobs upsert by job number; a job's daily rows are replaced).

```bash
npm run import:workshop                 # dry run — parse, match, print a summary
npm run import:workshop -- --commit     # write into inventory.db
```

`tools/import_issues.js` loads `data/general_item_issues.xlsx` (general consumables
issued out) into the `issues` table and auto-links each to a job by vehicle + date.
Issued items are listed on the job card (qty) but carry no price, so they don't
change Total Job Cost.

```bash
npm run import:issues                    # dry run
npm run import:issues -- --commit        # write into inventory.db
```
This repo already ships the imported data in `inventory.db`.

### Completing the per-job cost (materials + issues + labour)
Four idempotent backfill tools wire every historical requested material, issued
item and daily labour line into its job card so each job shows a true total
cost = **received parts + issued items + labour**. Each runs as a dry-run
report by default; add `--commit` to write (or run them all with
`npm run backfill:jobcost`):

```bash
npm run price:issues        # derive an issued item's price from its priced deliveries
npm run import:service       # import the Job_Record "service" sheet (recorded cost)
npm run link:jobs            # attach unlinked items/issues to their vehicle's job
npm run reattribute:daily    # move daily labour off DW- catch-alls onto real jobs
```

- `link:jobs` attributes each material/issue in three tiers — exact date-window
  match, nearest same-vehicle job within `--max-gap` days (default 60), else a
  per-vehicle `DW-<vehicle>` catch-all (`--catchall`).
- Issued items now carry an editable **unit price** (auto-suggested from the
  item's last priced delivery) and roll into job cost; a `recordedCost` column
  holds flat service-log / C-job totals for reference (never double-counted).
- Labour keeps the workshop rule — **each mechanic on a line is costed at the
  full hours × their rate** (e.g. `Saman, Ruwan – 10h` → Saman×10 + Ruwan×10).

## What's inside

### Workshop
- **Job Cards** — create / edit vehicle & machinery jobs (internal or
  outsourced) with a simple status lifecycle (Open → In Progress ⇄ On Hold →
  Completed → Closed) and an activity trail. Each job shows its **total cost =
  parts + labour**.
- **Daily Programme** — the daily work log is **assigned to a job card**: each
  day's entry (mechanics, hours, work done) is added under its job. Labour cost
  is calculated automatically from per-mechanic hourly rates (editable under
  **Mechanics & Rates**), replacing the old offline Excel/Python costing. Use
  the **Daily Programme** screen to log work for any date across all jobs.
- A job card can link to its **MRNs/GRNs**, so priced deliveries roll up into
  the job's parts cost.

### Stores (unchanged, now behind login)
- **MRN Tracker**, **Receiving Desk** (GRN), **Pricing & Audit**, **Issued
  Items**, **Battery Registry**, **Material Transfers**, **Excel export**,
  automatic categories and 30-min backups — all as before. New MRNs can be
  linked to a job card from the **Log a New Request** form.
- Every new request records **where it is purchased from** (Local / Head
  Office); the Receiving Desk pre-selects the matching purchase source
  (**Local Purchase** / **Head Office Purchase**) and flags mismatches.
- Issues drawn from an MRN carry a hard `itemId` link and are stock-checked
  server-side (an issue can never exceed the received balance of its line).

### Command Centre dashboard
A filterable analytics band (filters: date range / month / year presets,
source, category, vehicle, supplier):
- **This Month** and **This Year** total spend tiles, plus a period total.
- **Received Items — Local vs Head Office** split. Purchase sources are stored
  as two canonical values — **Local Purchase** and **Head Office Purchase** —
  and legacy spellings (*Local Store*, *Direct Purchase*, *Pre-Ordered*, *Head
  Office*) are folded into them automatically at startup.
- **Today's Local Purchase / Head Office Purchase totals** (with yesterday
  comparison) and a **Monthly Expenses** chart + table (last 12 months, split
  by source).
- **Pending Items** lists — requests not yet fully delivered, tabbed by where
  they were requested from (Head Office / Local), with outstanding qty and
  days waiting.
- **Supplier Spend Distribution** (doughnut + ranked list).
- **Daily received value** split Local vs Head Office.
- **Active jobs** and **total job cost** (parts + labour) KPIs.

## Authentication

Scrypt-hashed passwords with server-side sessions (SQLite-backed). All pages and
`/api` routes require a login; the session cookie is issued at sign-in. Manage
your password from the account menu (top-right).

## Data model (SQLite — `inventory.db`)

| Table | Purpose |
|-------|---------|
| `users`, `sessions` | authentication |
| `jobcards`, `job_audits` | job cards + activity trail |
| `daily_programme` | per-day work log (child of a job card) |
| `mechanics` | hourly rates for labour costing |
| `items` (`+ jobCardId/jobNo, requestSource`) | MRN request lines (Local / Head Office), optionally linked to a job |
| `receipts` | received / returned transactions + GRN / invoice / pricing (canonical `purchaseSource`) |
| `issues` (`+ jobCardId/jobNo, itemId`) | items issued out to a vehicle/machinery, hard-linked to their MRN line |
| `batteries`, `battery_movements`, `material_transfers` | store subsystems |

The SQLite engine auto-selects `better-sqlite3`, falling back to Node's built-in
`node:sqlite` (Node ≥ 22.5).
