# Inventory / Delivery Monitor

A fast, single-page inventory tracker for workshop MRN requests, receiving, GRN/pricing,
and items issued out to vehicles & machinery — with automatic item **categories**.

## What changed (performance rebuild)

The old backend stored data in MS Access (`inventory.accdb`) and talked to it by spawning a
**new PowerShell process on every request**, re-scanning the whole database each time. That is
why it was slow.

It now uses an **embedded SQLite database** (`inventory.db`) with proper indexes. All
search / sort / pagination happens in one in-process query. Typical timings on the real
dataset (~2,950 items): full list **~13 ms**, a single page **<1 ms**, vehicle + date search
**<1 ms** (previously several seconds). The app is now cross-platform (Windows / Mac / Linux).

> Your original `inventory.accdb` is left untouched as a backup and is used as the migration source.

## Setup

```bash
npm install            # installs the SQLite engine + libs
npm run migrate        # builds inventory.db from inventory.accdb (or the JSON snapshot)
npm start              # serves http://localhost:4000/item_tracker.html
```

On Windows you can just double-click **`start_server.bat`**, which does all three steps.

- `npm run migrate` is **safe to re-run** — it skips if the database already has data.
- `npm run migrate:force` wipes and re-imports from scratch.

The SQLite engine auto-selects `better-sqlite3`, falling back to Node's built-in `node:sqlite`
(Node ≥ 22.5) if a native build isn't available.

## Features

- **MRN Tracker** — add / edit / delete requests, paginated, sortable, with live search.
- **Categories** — every item is auto-classified into Battery, Filters, Tyre, Oil & Lubricants,
  Electrical, Bearings & Seals, Belts, Hydraulics, or General Items. Filter by category chips,
  and override any item's category manually in its edit form.
- **Receiving Desk** — log received quantities against an MRN (the "update receive" step).
- **Pricing & Audit / GRN** — attach GRN number, invoice, supplier and unit price ("update GRN").
- **Issued Items** — record items issued out to a vehicle/machinery, with their own search,
  category & date-range filters and full create / edit / delete.
- **Advanced search** — filter the tracker by vehicle, date range, category and free text, all
  server-side and instant.
- **Excel export** — Requests & Deliveries, Financial Summary, and Issued Items sheets.
- **Automatic backups** — a timestamped copy of `inventory.db` is saved to `backups/` every 30 min.

## Data model (SQLite)

- `items` — MRN request lines (`+ category`, `+ reqDateISO` for fast date filtering).
- `receipts` — received / returned transactions + GRN / invoice / pricing fields.
- `issues` — items issued out to a vehicle/machinery.
