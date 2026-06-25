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
This repo already ships the imported data in `inventory.db`.

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

### Command Centre dashboard
A filterable analytics band (filters: date range / month / year presets,
source, category, vehicle, supplier):
- **This Month** and **This Year** total spend tiles, plus a period total.
- **Received Items — Local vs Head Office** split (derived from the purchase
  source: *Local Store* → Local; *Direct Purchase / Pre-Ordered* → Head Office).
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
| `items` (`+ jobCardId/jobNo`) | MRN request lines, optionally linked to a job |
| `receipts` | received / returned transactions + GRN / invoice / pricing |
| `issues` (`+ jobCardId/jobNo`) | items issued out to a vehicle/machinery |
| `batteries`, `battery_movements`, `material_transfers` | store subsystems |

The SQLite engine auto-selects `better-sqlite3`, falling back to Node's built-in
`node:sqlite` (Node ≥ 22.5).
