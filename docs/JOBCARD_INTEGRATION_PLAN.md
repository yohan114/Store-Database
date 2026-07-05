# Plan — Integrate the Job-Card System & Complete the Full Job-Cost Cockpit

**Repos:** `yohan114/Store-Database` (target) + `yohan114/Job-Card-System` (source, branch `claude/quirky-brown-9ou4tb`)
**Status:** PLAN — awaiting scope decision before implementation.

---

## 0. What I found (verified from code + live data)

| Fact | Evidence |
|---|---|
| Store-Database **already holds all 2,996 `YYYY/M/R/NNN` job cards** — the same job numbers as the incoming file. The incoming and store data are **100% overlapping, not disjoint**. | `inventory.db`: 2,996 `/R/` jobcards; incoming `Job_Cost_Computed.xlsx` → 2,996 distinct Job No, intersection 2,996/2,996 |
| The job card table **already has every field you asked about**: `vehicleMachinery`, `ecdNo` (the E&C number), `projectName`, `meter`. | `db.js:273-289` |
| The **individual-mechanic labour model you described already exists and is correct**: `saman,ruwan,govinda – 10h` → saman×10 + ruwan×10 + govinda×10. | `programme.js:75-86` (`total += hours × rate` per mechanic) |
| The **mechanics + rates already match** the incoming data exactly (Dinesh 425, Nimesh 250, Govinda 250, …). Zero rate conflicts. | `mechanics` table (27 rows) vs incoming Daily Lines rate table |
| **Total job cost = labour + parts is already computed** per job. | `jobcards.js:189-204` (`totalCost = labourCost + partsCost`) |
| The Job-Card-System repo is a **separate job-REQUEST workflow app** (draft→review→approve→vendor email, roles, PDF, notifications) built on a zero-dependency JSON store — features the Store-Database does **not** have. | `job-card-system/src/domain.js`, `jobcards.js`, `mailer.js` |

### The real gaps (this is where the work is)

| Gap | Current | Meaning |
|---|---|---|
| **Requested materials not linked to jobs** | 2,983 of 3,638 items have no `jobCardId` | Most requested materials don't roll into any job's cost |
| **Issued items not linked** | 1,537 of 1,724 issues have no `jobCardId` | Most general-item issues don't roll into any job |
| **Issues have no price at all** | `issues` table has no price column | Issued items contribute Rs. 0 to job cost today |
| **~666 issues *could* be priced** | 666 issued items share a name with a priced delivery | We can auto-derive their unit price from receipts |
| **Labour only on recent jobs** | 415 of 3,303 jobs have `labourCost > 0` | The daily-work log only covers Dec 2025 – Jun 2026, so older jobs have no per-mechanic labour (only C-job recorded totals exist) |
| **Service jobs missing** | 0 `/S/` jobs in the store | The `service` sheet's 376 `YYYY/M/S/NNN` jobs were never imported |

---

## Track A — Complete the full job-cost cockpit (the core of your request)

*This is exactly the chain you described: requested materials → received + prices → issued items + prices → daily labour per mechanic → total labour → total job cost. Most of the engine exists; these phases close the data gaps and surface the result.*

### A1 · Price the general-item issues
- Add `unitPrice REAL` (+ derived `lineCost`) to the `issues` table (additive migration, same pattern as `requestSource`).
- **Auto-suggest** each issued item's unit price from the most recent priced `Receive` receipt of the same item name (666/1,724 issues get a price immediately); show it in the Issue Desk as a pre-filled, editable field.
- Feed issued-item cost into the job total (see A4).

### A2 · Link every requested material & issue to its job
- One-time backfill tool (`tools/link_all_to_jobs.js`, dry-run by default) that runs the **existing** `jobcards.findMatch(vehicle, date)` over all 2,983 unlinked items and 1,537 unlinked issues, attaching each to the job whose vehicle + date-window it falls in.
- Reuses the proven matcher (`WINDOW_DAYS=2`, vehicle-token + date span) — no new matching logic.
- Prints a report: how many linked, how many unmatched (and why). Optionally sweep leftovers into the per-vehicle `DW-<vehicle>` catch-all, exactly as the daily-work importer already does.
- The on-create auto-link already runs for *new* items/issues, so this only backfills history.

### A3 · Fill in labour where daily-work data exists
- Import the **Daily Lines** (per-mechanic, already rate×hours costed) + **Unmatched Daily** from `Job_Cost_Computed.xlsx` onto job cards, reusing `programme.computeLabour` (the full-hours model — already correct) and de-duping against the 1,906 `daily_programme` rows already present so nothing double-counts.
- Normalise the ~8 unregistered mechanic spellings from the Unmatched sheet (`Nawathilake→Nawathilaka`, `Themindu→Theminda`, `Vinoth→Vinod`, `Krishan→Krishna`, `Seetha→Seethananda`, …) via the existing alias map — do **not** create duplicate mechanics.
- **Honest limit:** the daily-work log only covers **Dec 2025 – Jun 2026**, so labour can only be computed for jobs in that window. For older **C-jobs (2023–24)** the Excel carries a job-level *Recorded Cost* total (279 jobs) with no per-mechanic breakdown — we can optionally store that as a job-level labour figure so those jobs aren't shown as Rs. 0.

### A4 · The per-job cost cockpit (UI)
A single job-card detail view that shows, for each job (found by vehicle number or E&C no):
1. **Requested Materials** — the linked `items` (MRN lines).
2. **Received Materials & Prices** — their priced `receipts` (qty × unit price), with GRN/invoice/supplier.
3. **Issued Items & Prices** — the linked `issues` with their (derived/entered) unit price.
4. **Daily Programme & Labour** — each daily entry with the **per-mechanic breakdown** (`Dinesh: 11h @425 = Rs.4,675; Nimesh: 11h @250 = Rs.2,750; …`), like the Excel's "Mechanic Breakdown".
5. **Totals** — **Total Labour** (Σ daily), **Total Parts** (received + issued), **Total Job Cost = labour + parts**.
- Extend `jobcards.get()` so the total **includes issued-item cost** (today it counts only received parts + labour), and add the mechanic breakdown string to each daily row.

### A5 · Import the missing service jobs & fix data typos
- Import the 376 `YYYY/M/S/NNN` **service** jobs from `Job_Record.xlsx` (`service` sheet) that were never brought in — with their labour/filter/oil/total cost columns.
- Fix the ~3 real date typos flagged in the overlap analysis (e.g. `0225-11-23`, year-3002 outlier).

---

## Track B — Port the Job-Request workflow into the unified app (optional, larger)

*The Job-Card-System repo's real value-add over Store-Database is the **request lifecycle** — the part your store doesn't have. Bringing it in makes Store-Database the single system.*

- **Rich request form** (from `job-card-system`): project/plant, company code (`ENC/`), driver/operator + contact, meter, repair type (Accident/Running/Other), ECD No., document-availability checkboxes, vendor + linked service-request.
- **Approval lifecycle**: DRAFT → PENDING_REVIEW → PENDING_APPROVAL → APPROVED → IN_PROGRESS ⇄ ON_HOLD → COMPLETED → CLOSED (internal), and the outsourced path (→ SENT_TO_VENDOR). Role-gated transitions with an **audit timeline** (the `job_audits` table already exists, currently empty).
- **Roles**: Transport Officer/Manager, Asst/Mech Engineer, Operational Manager, Technician, Admin (extends the current `users.roles`).
- **PDF job-card** generation and **printable request**.
- **Vendor email** on outsourced approval (optional — see decision 3).

Rebuilt natively on the Store's stack (Express + SQLite + the new TypeScript client), not copied as a separate app — so it shares the one login, database, and dashboard.

---

## Delivery order

1. **A1 + A2** (price issues + link everything) — highest value, unlocks accurate job costs immediately.
2. **A4** (cockpit view) — makes the linked data visible per job.
3. **A3 + A5** (labour backfill + service jobs) — fills remaining cost data.
4. **Track B** — only if you want the request workflow (decision 1).

Each phase ships as its own PR with the API test-suite extended and the browser smoke test re-run, exactly like the previous phases.

---

## Decisions needed before implementation

1. **Scope** — (a) **Track A only** (complete the cost cockpit: link materials, price issues, per-job totals — everything you described step-by-step), or (b) **Track A + Track B** (also port the full job-request approval workflow with roles/PDF/email). *Recommended: start with Track A; add Track B after.*
2. **Issue pricing** — auto-derive issued-item prices from matching priced deliveries (recommended), keep them editable per issue?
3. **Vendor email (only if Track B)** — include the SMTP vendor-email feature (it hard-codes 6 CC addresses like `encsrepair@gmail.com`), or leave email out and just generate the PDF?
4. **Unmatched leftovers** — items/issues/daily-lines that don't match any job: sweep into a per-vehicle `DW-<vehicle>` catch-all card (recommended, matches current behaviour), or leave unlinked and just report them?
