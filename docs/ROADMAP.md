# Edward & Christie Store + Workshop System — Zero → Hero Roadmap

*The complete journey: where this system started, everything it is today, and the
staged path to a production-grade, multi-branch platform. Grounded in the actual
codebase — every module, table and endpoint named here exists.*

---

## 0. What this system is

A single application that runs the **stores**, the **workshop**, and **operations**
for Edward and Christie (Pvt) Ltd:

- **Stores** — material requests (MRNs), deliveries/receipts with prices, general
  item issues, battery registry, material transfers, supplier spend.
- **Workshop** — job cards, daily programme (labour per mechanic), and a full
  **per-job cost cockpit** (materials + issues + labour = total job cost).
- **Operations** — a job-request approval workflow (Transport → Transport Manager
  → Operational Manager), in-app notifications, and auto-email for outsourced jobs.

One Node process serves a single-page browser app over the LAN. No cloud
dependency; the whole system is a folder you can copy.

**Tech at a glance:** Node.js + Express, embedded SQLite (better-sqlite3, WAL),
a TypeScript single-page client compiled to `js/`, scrypt auth with SQLite-backed
sessions. **18 backend modules · 82 API endpoints · 17 tables · ~5,900-line client.**

---

## 1. The maturity ladder

Eight levels from the Access baseline to an enterprise platform. Levels 0–4 are
**done**; 5–8 are the road ahead.

| Level | Theme | Status |
|------:|-------|--------|
| 0 | Access + PowerShell baseline | ⬅ where we started |
| 1 | Fast SQLite core + dashboards | ✅ done |
| 2 | Per-job cost cockpit | ✅ done |
| 3 | Operations approval workflow | ✅ done |
| 4 | Hardened (security, correctness, integrity) | ✅ done |
| 5 | Production deployment | ⬜ next |
| 6 | Structural maturity | ⬜ |
| 7 | Feature depth | ⬜ |
| 8 | Hero: multi-branch platform | ⬜ |

---

## Level 0 — Zero (the baseline)

The system began as an **MS Access (`.accdb`) database driven by PowerShell**. Every
request spawned a new PowerShell process that re-scanned the whole database — slow,
single-user, fragile, and impossible to extend. Data lived in one desktop file.

That is the "zero." Everything below is the climb.

---

## Level 1 — Fast SQLite core ✅

**Goal:** kill the Access/PowerShell backend; make it fast, accurate, multi-user on
the LAN.

- **`db.js`** — embedded SQLite (better-sqlite3, WAL) with a `node:sqlite` fallback;
  synchronous, indexed, ~millisecond queries. `migrate_to_sqlite.js` rebuilds the
  DB from `tracker_data.json`.
- **Purchase-source rework** — requests tick **Local** vs **Head Office**; deliveries
  are **Local Purchase** / **Head Office Purchase** (old "pre-order" retired).
- **Premium dashboard** (`dashboard.js`) — monthly/daily spend split by origin,
  today/yesterday tiles, pending-item lists, supplier spend, MTD/YTD.
- **General Item Issue** desk with stock validation.
- **TypeScript client** — the HTML-embedded JS moved to `src/client/*.ts`
  (`app.ts`, `operations.ts`, `login.ts`), compiled to `js/`. `item_tracker.html`
  is pure markup.

**Outcome:** a responsive, accurate, multi-user store system.

---

## Level 2 — Per-job cost cockpit ✅

**Goal:** answer "what did this job actually cost?" end to end.

The chain **requested materials → received + prices → issued items + prices →
daily labour per mechanic → total job cost**, wired together:

- **`jobcards.js`** — job cards are the parent of daily programme entries and of the
  MRNs/issues linked to them. `get()` splits **Received Parts** vs **Issued Items**
  and attaches a per-mechanic labour breakdown.
- **`programme.js`** — labour = *each* named mechanic × **full** hours × their rate
  (two mechanics for 8 h = both × 8 h), summed.
- **`costing.js`** — the single source of truth: one purchase-source taxonomy and
  one rule, `jobTotal = max(labour + parts + issues, recordedCost)`.
- **Automatic linking** — a material request, daily workdone, or issue attaches to a
  job whose window **`[start − 2 days … finish + 2 days]`** contains its date
  (`findMatch`, `config.WINDOW_DAYS`). Verified on both edges across all three record
  types.
- **Backfill tools** (`tools/`, `npm run backfill:jobcost`) — linked items
  655→3,611, issues 187→1,719, priced 666 issues, attributed Rs 1.57 M of labour.

**Outcome:** every job card shows a true, itemised total cost.

---

## Level 3 — Operations approval workflow ✅

**Goal:** a controlled request → approve → work → complete loop, separate from the
stores/workshop views.

- **`jobrequests.js`** — role-gated state machine
  `DRAFT → PENDING_TM → PENDING_OM → APPROVED → IN_PROGRESS → COMPLETED → CLOSED`
  (+ `REJECTED`), audit trail, `JR-YYYY-NNNN` numbering. On OM approval it **opens a
  linked workshop job card** so costing can begin.
- **`notifications.js`** — in-app bell + unread count; completion notifies Transport
  Officer, Transport Manager, Operational Manager and the requester.
- **`users.js` + `auth.js`** — user/role admin; roles: Transport Officer/Manager,
  Asst/Mechanical Engineer, Operational Manager, Technician, Admin.
- **`mailer.js`** — zero-dependency SMTP with a **simulate-to-outbox** fallback (the
  workflow works before SMTP is configured); outsourced jobs email vendor +
  requester-selected parties + a standing CC.
- **Role-scoped nav** — operations users see Operations only; admins see everything.

**Outcome:** transport can raise jobs, managers approve, outside jobs auto-notify
vendors, and everything lands back in the cost cockpit.

---

## Level 4 — Hardened ✅

**Goal:** close every P0–P3 finding from `docs/SYSTEM_REVIEW.md` so the system is
safe and trustworthy for real multi-user use.

| Area | What changed |
|------|--------------|
| **Security (P0)** | Stored XSS closed across ~30 sinks; DB/dumps untracked + gitignored; real ADMIN role gates replace fake client passwords; SMTP header-injection hardening; login rate-limiting; ADMIN-gated outbox/standing-CC; `Secure` cookie; env seed passwords. |
| **Correctness (P1)** | `costing.js` unifies the taxonomy + cost rule so list / detail / dashboard / export agree and the ≈Rs 4.9 M imported service cost surfaces; manual issue prices no longer clobbered. |
| **Performance (P1)** | Async gzip (2.9 MB → 183 KB on the wire); GROUP-BY aggregates replace per-row subqueries; `issuedQty` index kills an O(items×issues) loop; `structuredClone` drops 24 deep clones; cheaper single poll. |
| **Integrity (P2)** | FK-emulation triggers (no orphaned rows); link + date-repair provenance; `PRAGMA user_version` versioned migrations (removed a `DROP TABLE` landmine); async `db.backup()` + tiered retention + `docs/BACKUP_RESTORE.md`. |
| **Architecture (P2)** | `config.js` centralises tuning knobs; `AppError` + error middleware; `node:test` unit tests; GitHub Actions CI (typecheck → build → js/-drift → unit → API). |
| **UX/Ops (P3)** | Mobile off-canvas nav; admin modal (role checkboxes, shown-once password); atomic transitions; reopen keeps `reqNo`; `/api/health`; timezone-correct day boundaries. |

**Test bar:** `npm run test:api` (113 checks) + `npm run test:unit` (9 units) green;
browser smokes for XSS, every data view, the mobile drawer and the admin modal.

**Outcome:** the scorecard moves from a **D on security / C across the board** to a
system that is safe to expose to the whole team.

---

## Level 5 — Production deployment ⬜  *(next)*

Make it a real, always-on service instead of a `node server.js` in a terminal.

- [ ] **Serve over HTTPS** (reverse proxy: Caddy/nginx with a self-signed or
      internal CA cert) and set `COOKIE_SECURE=true`.
- [ ] **Process supervision** — run under a service manager (Windows: NSSM/Task
      Scheduler; Linux: systemd) so it restarts on crash/reboot. Wire `/api/health`
      to the supervisor / an uptime probe.
- [ ] **Log rotation** — bound `server_run.log` (size/date rotation) instead of an
      unbounded file.
- [ ] **Real SMTP** — set `SMTP_*` (or `mail.config.json`); confirm outsourced
      emails actually deliver (the outbox already records sent/failed).
- [ ] **Backup drill** — actually restore from a `backups/` copy per
      `docs/BACKUP_RESTORE.md`; consider an **off-machine** copy (USB/network share)
      so a disk failure isn't fatal.
- [ ] **First-login hygiene** — rotate the seeded `admin` / approver passwords; set
      `SEED_ADMIN_PASSWORD` / `SEED_APPROVER_PASSWORD` on fresh installs.

*Effort: days. This is the highest-value next step — the code is ready; it needs an
operational home.*

---

## Level 6 — Structural maturity ⬜

Pay down the deferred architecture debt so the codebase scales with the team.

- [ ] **Split `server.js`** (82 handlers) into `routes/*` routers; push fat logic
      (Excel export, PDF import, battery move) into domain modules.
- [ ] **Split the client** — `app.ts` (~5,900 lines, one global scope) into ES
      modules by domain behind the existing build; expose only what inline HTML
      needs on an explicit `window.App`.
- [ ] **TypeScript `strict`, incrementally** — turn on `noImplicitAny`/`strict`
      file-by-file; define shared DTO types so `typecheck` catches real bugs.
- [ ] **FTS5 search** — add a full-text index for item/job search (today it's
      `LIKE '%…%'` full scans; fine at ~3.6 k rows, a cliff at scale). Mind the
      substring→token semantics change.
- [ ] **CI depth** — add ESLint/Prettier gating, coverage, and a "no committed
      drift" guard already in place; consider building `js/` in CI instead of
      committing it.
- [ ] **Async export** — stream/offload the Excel export off the event loop.

*Effort: weeks, incremental. Each item is its own PR; none blocks daily use.*

---

## Level 7 — Feature depth ⬜

Make it delightful and complete for day-to-day operators.

- [ ] **Mobile field UX** — the drawer nav unblocked phones; next, tune the request
      form + issue desk for one-handed field entry; consider a PWA/offline queue
      (a `syncService` scaffold already exists client-side).
- [ ] **Documents** — job-card PDF, request PDF, GRN/issue printouts.
- [ ] **Bulk operations** — bulk approve/close requests, bulk price/link items.
- [ ] **Inline edit-after-create** for requests (a typo shouldn't force recreate).
- [ ] **Analytics** — supplier scorecards, per-vehicle lifetime cost, mechanic
      utilisation, spend forecasting, budget-vs-actual per project/site.
- [ ] **Battery lifecycle** — warranty/expiry alerts, per-vehicle battery history.
- [ ] **Notifications** — optional email/SMS for approvals and overdue deliveries.

*Effort: pick by business value; each is independent.*

---

## Level 8 — Hero: multi-branch platform ⬜

The end state — from one workshop to an organisation-wide platform.

- [ ] **Multi-location** — per-branch stores/workshops with consolidated reporting
      and inter-branch transfers (the `material_transfers` table is the seed).
- [ ] **Accounting integration** — export/sync receipts + job costs to the finance
      system (or QuickBooks/Xero-style hooks) so the workshop's numbers reconcile
      with the books.
- [ ] **BI dashboards** — trends, drill-downs, exports for management; a read-only
      analytics role.
- [ ] **RBAC depth + audit/compliance** — granular permissions, immutable audit log
      export, retention policy.
- [ ] **Scale-out** — if concurrency grows, move hot reads to async workers / a
      connection pool, or graduate to Postgres behind the same domain modules
      (the `db.js` boundary makes this a contained change).
- [ ] **Vendor/customer portals** — outsourced vendors accept jobs and post updates;
      customers track their vehicle's status.

**Definition of "hero":** always-on, HTTPS, supervised, backed up off-machine;
every job's cost is trustworthy and reconciles with the books; the team works it
from phones in the field; and adding a branch, a report, or an integration is a
contained change, not a rewrite.

---

## 2. Architecture snapshot (today)

**Backend modules**

| Module | Responsibility |
|--------|----------------|
| `server.js` | Express app, 82 endpoints, gzip, auth gate, error middleware, backups |
| `db.js` | SQLite engine, schema, versioned migrations, FK-emulation triggers, `backup()` |
| `auth.js` | scrypt passwords, SQLite sessions, roles, `requireRole` |
| `costing.js` | source taxonomy + the one job-cost rule |
| `config.js` | centralised tuning knobs (window, retention, login, dashboard, TZ) |
| `jobcards.js` | job cards, matching window, per-job rollup |
| `programme.js` | daily programme + per-mechanic labour |
| `dashboard.js` | analytics (spend split, pending, suppliers, job KPIs) |
| `jobrequests.js` | Operations state machine + audit |
| `notifications.js` · `mailer.js` · `users.js` · `categorize.js` | notifications, email/outbox, user admin, auto-categorisation |
| `tools/*` | one-off importers + backfill (`_jobmatch`, `link_all_to_jobs`, `reattribute_daily`, …) |

**Data model (17 tables):** `items`, `receipts`, `issues`, `jobcards`,
`daily_programme`, `mechanics`, `job_audits`, `batteries`, `battery_movements`,
`material_transfers`, `users`, `sessions`, `job_requests`, `job_request_audits`,
`notifications`, `outbox`, `app_settings`.

**Request lifecycle:** browser → `/api/*` → `attachUser` (session cookie) →
role gate → domain module → `db.js` → JSON (gzipped) → client render. A 15 s
`/api/summary` change-signature poll drives cheap refresh + the notification bell.

---

## 3. Setup from zero (stand up a fresh instance)

```bash
npm ci                       # install (better-sqlite3 builds natively)
npm run migrate              # build inventory.db from tracker_data.json
npm run build:client         # compile src/client/*.ts → js/
npm start                    # serve on 0.0.0.0:5000
```

First login: `admin` / `admin123` (forced change). Seed approver logins:
`transport` / `tmanager` / `opsmanager` (password `changeme123`). Override seeds
with `SEED_ADMIN_PASSWORD` / `SEED_APPROVER_PASSWORD`. Set `COOKIE_SECURE=true`,
`SMTP_*`, and `BUSINESS_TZ` for production.

**Verify:** `npm test` (unit + API), `npm run typecheck`. CI runs the same on push.

---

## 4. Recommended sequence

1. **Level 5 (deploy)** — biggest jump in real-world value; the code is ready.
2. **Level 7 quick wins** — job-card/request PDF, bulk approve, inline edit.
3. **Level 6 incrementally** — `routes/*` split first, then client modules, then
   `strict`; FTS5 when row counts climb.
4. **Level 8** — as the business grows to multiple branches / needs finance sync.

Everything is additive and reversible; the domain-module + `db.js` boundaries mean
each level is a contained change, not a rewrite.

---

*Companion docs: `SYSTEM_REVIEW.md` (findings + scorecard), `UPGRADE_PLAN.md`,
`JOBCARD_INTEGRATION_PLAN.md`, `OPERATIONS_JOBREQUEST_PLAN.md`,
`BACKUP_RESTORE.md`.*
