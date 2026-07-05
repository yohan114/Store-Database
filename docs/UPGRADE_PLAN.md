# Upgrade Plan — SQLite Completion, Faster/More Accurate System & UI Changes

**Repo:** `yohan114/Store-Database` · **Branch:** `claude/sqlite-migration-ui-updates-91x1u7`
**Status:** PLAN — awaiting approval before implementation.

---

## 0. Where the system stands today (verified from code)

| Fact | Evidence |
|---|---|
| The app is **already a Node + Express + SQLite system**. Every API endpoint reads/writes `inventory.db`; nothing reads `tracker_data.json` at runtime. | `server.js:18` uses only `./db`; zero references to the JSON file |
| SQLite runs in WAL mode with indexes and 30-minute automatic backups. | `db.js:38-41`, `server.js:1320-1338` |
| `tracker_data.json` (2,954 legacy records) is only the **one-time import source** for `npm run migrate`. | `migrate_to_sqlite.js:28-103` |
| `inventory.db` already holds the migrated data: 3,638 items, 2,918 receipts, 1,724 issues, 3,303 job cards, 1,906 daily-programme rows. | direct DB inspection |
| Legacy data already uses the names you want: receipts store `Local Purchase` (1,230) and `Head Office` (842). Only the **UI radio buttons** use the old names `Local Store` / `Direct Purchase` / `Pre-Ordered`. | `item_tracker.html:1051-1059`; data scan |

**Conclusion:** the "move to SQLite" is done in code. What remains is: make sure the machine you use daily runs *this* build (Phase 0), then make it faster and more accurate (Phase 6), and apply your requested changes (Phases 1–5).

---

## Phase 0 — Deployment baseline (get your PC onto the SQLite build)

*Goal: the system you use every day is this SQLite version, with a safe backup first.*

1. Back up the current live folder (copy `inventory.db`, `backups/`, `tracker_data.json`).
2. On the store PC: pull this branch, run `npm install` (installs `better-sqlite3`; without it the app silently falls back to Node's slower built-in engine).
3. Run `npm run migrate` **only if** `inventory.db` is empty (the script refuses to overwrite existing data unless `--force`).
4. Run `npm run test:api` — the built-in test suite must pass before go-live.
5. Verify login, MRN list, receiving desk, dashboard load correctly at `http://localhost:5000`.

**Acceptance:** app starts with `ENGINE=better-sqlite3` in the boot log; all API tests green.

---

## Phase 1 — Data model changes & one-time data normalisation

*Goal: the database speaks one language: every purchase is either **Local Purchase** or **Head Office Purchase**.*

### 1.1 New column: where a request should be purchased from
```sql
ALTER TABLE items ADD COLUMN requestSource TEXT;   -- 'Local' | 'Head Office' | NULL (legacy)
CREATE INDEX idx_items_requestSource ON items(requestSource);
```
Added as an additive migration inside `db.js init()` (same pattern as the existing `jobCardId` migration at `db.js:342-348`).

### 1.2 Canonical purchase-source values (receipts)
New canonical values stored in `receipts.purchaseSource`:
- **`Local Purchase`** (was UI value `Local Store`)
- **`Head Office Purchase`** (was UI values `Direct Purchase` and `Pre-Ordered`)

One-time normalisation script `tools/normalize_sources.js` (dry-run by default, `--commit` to write, prints a before/after report):
```sql
UPDATE receipts SET purchaseSource='Local Purchase'
 WHERE LOWER(TRIM(purchaseSource)) IN ('local store','local purchase');
UPDATE receipts SET purchaseSource='Head Office Purchase'
 WHERE LOWER(TRIM(purchaseSource)) IN ('direct purchase','head office','pre-ordered');
```
Edge cases found in real data (script will list them for manual review):
- 10 receipts with combined values like `Local Purchase & Head Office` → stay as-is, counted in the "Other" bucket (decision open — see §8).
- 9 receipts with empty source → stay empty, shown as "Other".

### 1.3 Keep old spellings working everywhere
The two classifiers keep accepting legacy aliases so nothing breaks if an old row slips through:
- Server: `dashboard.js:16-27` (`HEAD_OFFICE`, `LOCAL`, `ORIGIN_CASE`) — add `'head office purchase'` to the head-office list.
- Client: `item_tracker.html:6091-6098` (`renderDailyReceivedLedger`) — same alias lists.

**Acceptance:** after `--commit`, `SELECT purchaseSource, COUNT(*) FROM receipts GROUP BY 1` shows only `Local Purchase`, `Head Office Purchase`, the 10 combined rows, and 9 blanks.

---

## Phase 2 — "Log a New Request": Local / Head Office tick

*Your request: “add new tick to request local or headoffice”.*

### UI (`item_tracker.html`)
- Add a required radio pair to the **Log a New Request** modal (`addForm`, lines 2017-2053):
  `Request From:  (•) Local   ( ) Head Office`  — element name `reqSource`.
- Same field in the **Edit Request** modal (lines 2302-2361).
- Show a small badge (LOCAL / HEAD OFFICE, colour-coded like the dashboard split) in:
  - the MRN Tracker table rows (`renderTable()`, line 4033),
  - the receiving-desk item metadata box (`handleReceivingItemSelection()`, line 5120),
  - the request-details offcanvas.
- Add a "Request Source" filter to the tracker's advanced search panel.

### API (`server.js`)
- `POST /api/items` (line 384) and `PUT /api/items/:id` (line 412): accept + store `requestSource`.
- `GET /api/items`: return it; add `requestSource` to `buildItemWhere` filters (line 298).

### Behaviour for old records
Legacy items have `requestSource = NULL` → displayed as "—" and filterable as "Unspecified". Optional backfill: infer from the item's delivered sources (single-source items only) — script included in `tools/normalize_sources.js` as an opt-in flag.

**Acceptance:** new MRN cannot be saved without choosing Local/Head Office; badge visible in tracker; filter works.

---

## Phase 3 — "Log Material Delivery": renames, remove Pre-Order, confirm source

*Your request: rename Local Stores → Local Purchase, Direct Purchase → Headoffice Purchase, remove Pre-Order; delivery log confirms received local or head office.*

### 3.1 Radio group (`item_tracker.html:1048-1063`)
| Before | After |
|---|---|
| `Local Store` | **`Local Purchase`** |
| `Direct Purchase` | **`Head Office Purchase`** |
| `Pre-Ordered` | **(removed)** |

### 3.2 "Confirm received from" flow
When an MRN is selected on the receiving desk:
1. The metadata box shows the request's source: *"Requested from: **Head Office**"*.
2. The matching purchase-source radio is **pre-selected automatically** (the confirmation tick you asked for).
3. If the storekeeper picks the other source, a yellow inline note appears: *"Note: requested from Head Office but receiving as Local Purchase"* — allowed, but deliberate. The mismatch is stored as part of the receipt so the dashboard pending lists stay accurate.

### 3.3 Remove every hidden dependence on the old strings
- `item_tracker.html:5730` — silent fallback `'Direct Purchase'` when no radio checked → **removed**; the field becomes truly required (validation error instead of a wrong guess). *(accuracy fix)*
- `item_tracker.html:7935` — job-card quick-add hardcodes `'Local Store'` → change to `'Local Purchase'`.
- CSV import mapping (lines 6423-6471) — normalise incoming source text through one shared `canonicalSource()` helper.
- Dashboard legend labels (lines 773, 777): "Head Office (Direct)" → "Head Office Purchase"; "Local Purchase (Store)" → "Local Purchase".
- `test_api.js` fixtures using `'Local Store'` → updated.

**Acceptance:** the three old strings appear nowhere in the UI; submitting without a source is blocked; new receipts store only the two canonical values.

---

## Phase 4 — Dashboard upgrades

*Your request: monthly expenses view, daily local + head-office purchase totals, pending-items lists for both sources.*

All server-side, in `dashboard.js` (fast SQL aggregates over indexed columns), rendered in the existing Command Centre section (`item_tracker.html:577-663`, JS `8035-8141`).

### 4.1 Monthly Expenses (new card)
- New `monthly` block in `dashboard.build()`: last 12 months, `GROUP BY substr(deliveryDateISO,1,7)`, split Local / Head Office / Other / Total.
- Rendered as a stacked bar chart (Chart.js, already loaded) + a month-by-month table with the same split. Respects all existing dashboard filters.

### 4.2 Daily purchase totals (new KPI tiles)
- Two new tiles at the top: **"Today — Local Purchase: Rs. X"** and **"Today — Head Office Purchase: Rs. Y"** (plus small "yesterday" comparison underneath).
- The existing *Daily Received Value* table (lines 649-660) stays and gets its columns re-labelled to the new names.

### 4.3 Pending items lists (new two-tab card)
- New `pending` block in `dashboard.build()`:
  ```sql
  -- items where requested qty not yet fully delivered
  SELECT i.id, i.mrnNum, i.itemName, i.vehicleMachinery, i.reqDate, i.requestSource,
         i.reqQty, COALESCE(SUM(r.qty),0) AS recQty,
         i.reqQty - COALESCE(SUM(r.qty),0) AS outstandingQty,
         JULIANDAY('now') - JULIANDAY(i.reqDateISO) AS ageDays
  FROM items i LEFT JOIN receipts r ON r.itemId = i.id AND r.transactionType='Receive'
  GROUP BY i.id HAVING outstandingQty > 0.005
  ORDER BY i.reqDateISO ASC;
  ```
- Dashboard card with two tabs: **Pending — Head Office** and **Pending — Local** (split by `requestSource`; a third "Unspecified" count covers legacy NULLs). Columns: MRN, item, vehicle, requested date, outstanding qty, days waiting (red when overdue). Each row links to the MRN in the tracker.
- Tile counters ("12 pending head office / 7 pending local") shown even when the card is collapsed.

**Acceptance:** dashboard shows monthly chart + table, two daily KPI tiles, and both pending lists; numbers reconcile with the MRN tracker's pending filter.

---

## Phase 5 — General Item Issue section (proposed improvements)

*You said this section “needs to modify” — these are the concrete problems found in the code, with proposed fixes. Please tick which ones you want (see §8).*

| # | Problem today | Proposed fix |
|---|---|---|
| 5.1 | Issues are matched to stock **by typing the item name**; the same matching logic is copy-pasted 4–5 times (`item_tracker.html:3342, 3432, 4661, 4853, 6579`); typos create false "Discrepancy" rows in Store Stock | Issue Desk picks the item from a **stock list** (select, not free text); new nullable `issues.itemId` link column; one shared issued-qty helper |
| 5.2 | Over-issue check runs **only in the browser** — two users can issue the same stock at once | Server-side stock validation in `POST/PUT /api/issues` (reject when issue qty > available balance, with clear error) |
| 5.3 | Issue Desk writes directly with no offline queue (unlike requests/deliveries) | Route it through the same `syncService` offline queue |
| 5.4 | No record of which store location issued the item | Optional "Issued From: Local stock / Head-office stock" tick, consistent with Phases 2–3 |
| 5.5 | Deleting an issue needs a password typed into a browser `prompt()` (hardcoded `E&CWorkshop` visible in the page source) | Replace with role-based permission (ADMIN role already exists in `users.roles`) |
| 5.6 | No printed proof of issue | Optional: printable Issue Note (A5) with issue number, item, qty, issued-to/by, signature line |

---

## Phase 6 — Speed & accuracy hardening

*Your request: “more fast and accurate system”.*

| # | Today | Change | Effect |
|---|---|---|---|
| 6.1 | Page load + every 15 s: **the entire items table** (3,638 rows + all receipts) is downloaded (`GET /api/items` unpaginated, `loadAllData()` `item_tracker.html:3051`) | New lightweight `GET /api/summary` (counts + badges only) for polling; full dataset fetched only for the views that need it, cached client-side and refreshed on change | Biggest single speed win; UI stays snappy as data grows |
| 6.2 | Search uses `LIKE '%…%'` (unindexable, `server.js:303`) | Add SQLite **FTS5** index over item name/MRN/vehicle for the tracker search | Instant search even at 50k+ rows |
| 6.3 | `inventory.db`, `backups/`, `tracker_data.json`, `data/*.xlsx` are **downloadable without login** (`express.static(__dirname)`, `server.js:94`) | Serve a whitelist only (html/js/css); block DB/backup/data files | Protects the whole database from anyone on the LAN |
| 6.4 | Delete/edit passwords hardcoded in client JS (`E&CWorkshop`, `E&CWorkshopEdit`) | Role-based checks server-side (ADMIN); remove client passwords | Real access control |
| 6.5 | Mixed date formats in legacy rows (`M/D/YYYY`, ISO, oddities like `0004-03-17`) | Data-quality pass in `tools/normalize_sources.js`: re-derive all `*ISO` columns via `toISO()`, list unparseable dates for manual fix | Correct date filtering & dashboards |
| 6.6 | Excel export builds 8 sheets synchronously (blocks server for everyone) | Keep, but stream on a worker thread or advise off-peak use (low priority) | No mid-day freezes |
| 6.7 | 30-min backups already exist (`backups/`, keep 48) | Add daily copy to a second folder/drive (configurable path) | Survives disk failure |

---

## 7. Delivery order, testing & rollout

Recommended implementation order (each step is releasable on its own):

1. **Phase 1 + 3** (schema + renames + normalisation) — one PR; the rename is meaningless without the data migration, so they ship together.
2. **Phase 2** (request tick + confirm flow) — depends on 1.
3. **Phase 4** (dashboard) — depends on 1–2 (pending lists need `requestSource`).
4. **Phase 5** (issue section) — after you confirm scope.
5. **Phase 6** (perf/security) — 6.3/6.4 early (small, high value); 6.1/6.2 after the UI phases so testing covers them.
6. **Phase 0** rollout steps run once at the start (get on this build) and again at the end (deploy the finished version).

Testing per phase: extend `test_api.js` (already covers login → CRUD → dashboard) with: `requestSource` round-trip, canonical source values, dashboard `monthly`/`pending` blocks, server-side over-issue rejection. Manual smoke checklist for the storekeeper flow (request → receive → price → issue).

Rollback: every phase is one commit + the automatic DB backups; restoring = checkout previous commit + copy latest `backups/inventory-*.db` back.

---

## 8. Decisions needed from you before implementation

1. **Exact label**: "Head Office Purchase" — OK, or do you prefer just "Head Office"? (Stored value follows the label.)
2. **10 legacy receipts** with combined source (`Local Purchase & Head Office`): leave in "Other" (recommended), or assign each manually?
3. **Request tick**: required for every new MRN (recommended), or optional?
4. **General Item Issue (Phase 5)**: which of 5.1–5.6 do you want? (Recommended minimum: 5.1 + 5.2.)
5. **Old backfill**: should legacy requests get their `requestSource` guessed from where they were actually delivered (single-source items only)?
