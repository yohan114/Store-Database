# System Review — Workshop & Stores (Edward & Christie)

**Scope:** the whole application — `server.js`, `db.js`, `auth.js`, `jobcards.js`,
`programme.js`, `dashboard.js`, `jobrequests.js`, `notifications.js`, `users.js`,
`mailer.js`, the `tools/*` backfills, the TypeScript client (`src/client/*.ts` →
`js/*.js`) and the deployment/ops story.

**Method:** a multi-dimensional review (security, correctness, performance, data
integrity, architecture, UX/ops) with every serious finding independently
**adversarially verified against the code**. Result: **54 findings — 20 serious
confirmed, 0 refuted, 33 medium/low.** Line references were current at review time.

> Honest note: several correctness/consistency findings below are consequences of
> features added recently (issue pricing, the cost cockpit, the operations
> workflow). They're real and worth fixing; they're called out plainly.

---

## Health scorecard

| Dimension | Grade | One-line verdict |
|---|:---:|---|
| **Security** | 🔴 D | Stored XSS, live DB + password hashes in git, client-side-only "passwords", e-mail header injection. Not safe beyond a trusted LAN until fixed. |
| **Correctness / financial accuracy** | 🟠 C | Job totals disagree between list, detail, dashboard and export; ~Rs 4.9M service cost hidden. |
| **Performance / scalability** | 🟠 C | Whole-table refetch to every client on every write; sync DB blocks the one thread; O(items×issues) client loops. Fine now, cliff ahead. |
| **Data integrity** | 🟠 C | No foreign keys; backfill attribution is a 60-day guess with no provenance; unversioned boot migrations with a destructive branch. |
| **Architecture / maintainability** | 🟠 C | 5,900-line client monolith + 1,500-line route monolith; cost logic duplicated in 3 languages; TypeScript strictness off; no CI/lint. |
| **UX / Operations** | 🟠 C | No mobile nav; prompt()-based admin; single-process Windows start with no supervision; ~24 h backups, restore undocumented. |
| **Functionality (what it does)** | 🟢 B+ | Genuinely broad and coherent: stores, workshop costing, operations approvals, notifications, e-mail — all working end to end (97 API tests green). |

**Overall: a feature-rich, functionally strong system on a fragile foundation.**
The build quality of *features* is good; the gaps are in *security, consistency
and operational hardening* — exactly the things that matter once real money and
multiple users depend on it.

---

## P0 — Fix before real multi-user / off-LAN use (this week)

### 1. 🔴 CRITICAL — Stored XSS across the main client
`highlightMatch()` (`app.ts:442`) escapes only the search term, not the data, and
returns raw strings wrapped in markup that is injected via `innerHTML`. Item
names, vehicle, supplier, GRN/invoice, battery serial/brand/notes, movement notes
(≈dozens of `innerHTML` sinks) render **unescaped**. A payload like
`<img src=x onerror=…>` stored in any of those fields (typed, or via CSV/PDF
import) **executes in every other user's session, including admins** → full
account/session takeover driven through the authenticated API.
**Fix:** escape every data interpolation with the existing `escapeHtml`/`jcEsc`
before it reaches `innerHTML`; fix `highlightMatch` to escape text first, then
wrap matches; audit all `innerHTML` assignments. *(effort: L)*

### 2. 🔴 HIGH — Live database + password hashes committed to git
`inventory.db` (3.6 MB), `inventory.accdb`, `tracker_data.json`, `test_output.json`
are **tracked in the repo**. The DB blob contains the `users` table (scrypt hashes
+ salts) and `sessions` (non-expired session IDs that replay directly as the
`ecms_sid` cookie — password-free impersonation). `.gitignore` never actually
ignored `inventory.db`.
**Fix:** `git rm --cached` the DB/dumps, add to `.gitignore`, ship data only via
`npm run migrate` + backups. If the repo was ever shared, **rotate all passwords,
truncate `sessions`, and scrub history** (git filter-repo/BFG). A binary DB in git
also silently overwrites live data on any `pull`/`reset`. *(effort: S–M)*

### 3. 🔴 HIGH — "Passwords" that aren't
- The delete gate `'E&CWorkshop'` is a constant compared server-side **and shipped
  inside `js/app.js`** to every browser, and accepted via `?password=` (lands in
  logs). Zero real authorization.
- The edit "confirmation password" `'E&CWorkshopEdit'` is checked **only in the
  browser** — the server `PUT /api/items|receipts|issues|…` has no check at all, so
  any authenticated user edits any record via a direct API call.
**Fix:** delete both constants; gate destructive/edit actions with the real role
system (`requireRole`) and/or re-auth of the user's own password; never send a
secret to the client; never accept it via query string. *(effort: M)*

### 4. 🔴 HIGH — E-mail header / SMTP injection (outsourced e-mail)
`sendOutsourced` puts `vendorEmail` and `vehicleMachinery` **unvalidated** into the
`To:`/`Subject:` MIME headers and the raw `RCPT TO:` — no CRLF stripping, no format
check on the primary recipient. A value with `\r\n` can inject headers / extra
envelope recipients when real SMTP is on (spam/phishing from the company Gmail,
silent Bcc exfiltration).
**Fix:** strict single-line address validation, reject/strip any value containing
`\r`/`\n`, route `vendorEmail` through the same `@`-check as the CC list, sanitize
all header values. *(effort: M)*

### 5. 🟠 Quick security hygiene (bundle these)
- **Login has no rate-limiting/lockout** → online brute force of the weak seed
  accounts. Add per-IP + per-account backoff.
- **Seed accounts** `admin/admin123` + `transport|tmanager|opsmanager` all
  `changeme123`, **printed to `server_run.log`**, on a `0.0.0.0` bind. Randomize
  seeded passwords (print once, don't log), block API access while
  `mustChangePassword=1`, raise the 6-char minimum.
- **`GET /api/outbox`** (vendor e-mail bodies/recipients) is only `requireApiAuth`
  — add `requireRole('ADMIN')`.
- **Cookie has no `Secure` flag** and the app is plain HTTP → session sniffable on
  the LAN. Add TLS + `Secure`; consider a shorter TTL than 7 days.

*(Good news: **no SQL injection** — all queries are parameterized and dynamic
identifiers come from whitelists. Session minting is sound.)*

---

## P1 — Financial correctness (numbers must agree)

These four make the same job show **different totals in different places** — they
undermine trust in the costing the whole system exists to produce.

| # | Finding | Where | Effect |
|---|---|---|---|
| 6 | **Job list total = labour only** (`(labourCost)+0`) while the detail total = labour + parts + issues | `jobcards.js:267` vs `:219-220` | A Rs 50k parts job shows Rs 0 in the grid, Rs 50k when opened |
| 7 | **Dashboard KPIs & Excel export count received parts but omit priced issues** | `dashboard.js:140-142`, `server.js:1410-1417` | Org-wide "Total Cost" understates by the whole issued-consumables value; never reconciles with per-job totals |
| 8 | **`recordedCost` (129 service jobs, ≈Rs 4.93M) excluded from every total**; those jobs show ≈Rs 0 | `jobcards.js:220,267`; `db.js` | ~Rs 4.9M of real service cost invisible in headline figures |
| 9 | **Cost math + purchase-source taxonomy duplicated in client JS, server JS and SQL (5-6 copies)** with already-drifted alias lists | `app.ts`, `dashboard.js`, `server.js:410`, `db.js`, `tools/` | The two dashboards can disagree; adding a source means editing 5 files or it silently buckets as "Other" |

**Fix approach:** define **one** costing function and **one** source taxonomy
(list of `{canonical, aliases}`), derive the SQL `CASE`, the server normaliser and
the client label from it; make `list()`, `get()`, `jobKpis()` and the export share
one parts+issues+recorded rollup. Decide explicitly whether `recordedCost` joins
the grand total or shows as a clearly-labelled separate column. *(effort: M each)*

*(Downgraded on verification: "editing an issue overwrites its manual price" is a
latent server asymmetry, not reachable through the current UI — but worth fixing
when the issue endpoints are touched: preserve `existing.unitPrice` on update
unless a re-suggest is explicitly requested.)*

---

## P1 — Performance (works now, cliff ahead)

| # | Finding | Where | Effect |
|---|---|---|---|
| 10 | **`GET /api/items` (unpaginated) returns the whole table + all receipts** (4 correlated subqueries/row) and the global change-signature means **one write by anyone forces a full ~2.9 MB refetch on every client** | `server.js:463-503`, poll `app.ts:4224-4265` | N clients × 2.9 MB + ~80 ms DB block per write; scales with rows × clients |
| 11 | **All DB access is synchronous** better-sqlite3 on the one event loop; `export/excel` + big-job `get()` block every other request | `db.js:47-71`, `server.js:1267`, `jobcards.js:179` | An export or a 400-item catch-all view (~182 ms) stalls all logins/polls/writes |
| 12 | **O(items × issues) client recompute + full deep-clone of `allItems`** on each fleet/inventory render | `app.ts:53-67, 2205-2226, 2386` | Multi-million-iteration main-thread loop + multi-MB clone → UI jank, worsens quadratically |
| 13 | Idle clients issue **~58 aggregate queries/min each** (15 s data poll + 20 s notif poll; `/api/summary` = 13 COUNT/MAX scans) | `app.ts:4224`, `operations.ts:65`, `server.js:189` | 10 idle clients ≈ 580 q/min of pure polling on one thread |
| 14 | Leading-wildcard `LIKE '%…%'` search = unindexable full scans (+ correlated EXISTS per item); no FTS | `server.js:421-424`, etc. | Every keystroke scans 3.6k/1.7k/4.1k rows |

**Fix approach:** stop shipping whole tables to the browser (aggregates already
exist server-side in `dashboard.js`; use the paginated path + light lookups);
replace per-row correlated subqueries with one `GROUP BY` join; precompute an
`issuedQty` Map per load (O(1) lookups) and drop the deep clone; merge the two
polls into one cheap change-counter (or SSE); add an FTS5 index for search; offload
`export/excel` to a worker/stream. Also add gzip/brotli + minify (315 KB bundle
served raw). *(effort: mostly M, the refetch redesign L)*

---

## P2 — Data integrity & durability

| # | Finding | Where | Effect |
|---|---|---|---|
| 15 | **No foreign keys anywhere** (PRAGMA is ON but no `REFERENCES`); deletes silently orphan children | `db.js` all link cols | First real delete → dangling items/issues/receipts/daily rows, mis-costed rollups |
| 16 | **Backfill attribution has no provenance**: EXACT (±2 d) and NEAR (≤60 d guess) look identical in the DB; 66% of items / 50% of issues sit on anonymous `DW-` catch-alls | `tools/link_all_to_jobs.js`, `_jobmatch.js` | Low-confidence guesses count toward job cost with no way to audit/roll back |
| 17 | **Suspect-date repair rewrites the *year*** by median-of-neighbours and overwrites the original; 1,425 yearless issue dates can't be re-derived if wrong | `tools/normalize_sources.js:106-131` | A wrong year silently moves an issue's reporting period / job link, unrecoverably |
| 18 | **Unversioned ALTER-on-boot migrations** with a **`DROP TABLE batteries` heuristic** if a column is missing; boot rewrites `receipts` every start | `db.js:172-178, 380-443` | No `schema_version`; a schema surprise can wipe battery data; every boot writes |
| 19 | **30-min backup is a synchronous `copyFileSync`** on the main thread; ~24 h retention; restore undocumented | `server.js:1514-1533` | App freezes for the copy every 30 min (grows with DB); a >1-day-old mistake has no backup |
| 20 | Duplicate mechanic `Seethananda/seetha` (id 27) redundant with the alias — latent double-count | `programme.js`, mechanics id 10 & 27 | No current mis-cost; delete id 27, keep the alias |

**Fix approach:** rebuild-migration to add `REFERENCES … ON DELETE SET NULL`;
add a `linkMethod`/`linkGap` column so NEAR/CATCH links are auditable and
reversible; preserve original ISO + a `repaired` flag before any date rewrite and
constrain neighbours to the same vehicle/batch; introduce `PRAGMA user_version`
and run each migration once (replace the DROP heuristic); switch backups to
better-sqlite3's online `db.backup()` (async, consistent) with tiered retention +
a documented restore. *(effort: M–L)*

---

## P2 — Architecture & maintainability

- **Client monolith:** `app.ts` is 5,863 lines in one global scope; `operations.ts`
  reaches into its globals via `typeof x === 'function'` shims — no module boundary,
  collision-prone, unreviewable. Split into ES modules by domain behind the existing
  build; expose only what inline HTML needs on an explicit `window.App`.
- **TypeScript in name only:** `strict:false`, `noImplicitAny:false` → params are
  `any`, `window.__*`/DTOs unchecked; `typecheck` passes on broken code. Turn on
  `strict` incrementally; define shared DTO types.
- **Route monolith:** `server.js` = ~1,533 lines / ~81 handlers, fat logic inlined
  (Excel export, PDF import, battery move), manual route ordering. Split into
  `routes/*` Routers; push logic into the domain modules.
- **Testing/CI:** only one end-to-end API test, and it runs **against the live DB**;
  no unit tests for cost math / state machine / matchers; **no CI**. Point tests at
  a temp/`:memory:` DB; add `node:test` units for the risky logic; add a GitHub
  Actions workflow (`typecheck` + `build:client` + tests + a "build produces no git
  diff" check). *(the `session-start-hook` skill can bootstrap web-session checks.)*
- **Error handling:** every route `catch → 500` (can't tell 400 from bug; leaks
  messages); several data-affecting `catch(_){}` swallow failures silently (the
  auto-job-card creation on approval especially). Add an error taxonomy +
  middleware; log swallowed data failures.
- **Config:** magic numbers duplicated (`WINDOW_DAYS=2` in two places, `MAX_GAP`,
  backup cadence, dashboard caps). Centralize in `config.js` so the live matcher and
  the backfill tools are provably identical.
- **Tooling:** `ignoreDeprecations` defers a TS-major break; no ESLint/Prettier;
  compiled `js/*` committed (can drift). Add lint/format + CI; stop committing `js/`
  or CI-check it's in sync.

---

## P3 — UX & Operations polish

- **No mobile navigation** — the sidebar is `hidden md:flex` and the hamburger only
  changes width; on a phone you can't switch sections at all (a hard block for a
  transport officer raising requests in the field). Add an off-canvas drawer / bottom
  tabs.
- **Admin user management is `prompt()`/`alert()`** with a hardcoded `changeme123`
  and free-typed single role. Replace with the existing modal pattern: role
  checkboxes, e-mail validation, shown-once initial password.
- **Operations workflow gaps:** no edit-after-create (a typo forces recreate),
  `reopen` lands in a non-editable draft (dead end), no request PDF, no completion
  e-mail, no bulk approve/close. `reopen` also **re-mints `reqNo`**, orphaning prior
  audit/notifications — only assign `reqNo` on first submit.
- **Ops resilience:** single-process `node server.js` via `.bat` with no
  service/pm2/NSSM, no `/api/health`, unbounded `server_run.log`. Supervise +
  rotate logs + add a health endpoint.
- **Transition not atomic:** `jobrequests` status/effect/audit are separate writes
  with no surrounding transaction — a mid-effect throw can leave APPROVED with no
  audit row. Wrap in `db.transaction`.
- **Timezone:** dashboard `today/yesterday/MTD` use server-local time vs date-only
  data — near midnight in UTC+5:30 the "Today" card can show the wrong day. Compute
  boundaries in the business timezone.

---

## What's genuinely strong (keep it)

- **Breadth & cohesion:** one login over stores, workshop costing, operations
  approvals, notifications and e-mail — and it all works end to end.
- **Costing model:** the full-hours-per-mechanic labour rule is correct and applied
  consistently in the compute path; the request→approve→approve→complete state
  machine is clean and role-gated.
- **No SQL injection; sound password hashing (scrypt) and session minting.**
- **Idempotent, dry-run-first tooling** and a 97-check API suite that actually
  exercises the flows.
- **Pragmatic engine choice** (better-sqlite3 with a `node:sqlite` fallback), WAL,
  automatic backups (just needs to be async), and a real migration path.

---

## Recommended sequence

1. **P0 security (days):** gitignore+purge the DB & rotate creds; escape XSS;
   remove the two client "passwords" and gate with roles; validate e-mail headers;
   add login rate-limit + outbox role gate + randomized seeds. *Ship as one
   security PR.*
2. **P1 financial consistency (days):** one costing function + one source taxonomy;
   make list/detail/dashboard/export agree; decide `recordedCost` semantics.
3. **P1 performance (1–2 wks):** kill the whole-table refetch, single cheap poll,
   GROUP-BY aggregates, FTS search, gzip+minify.
4. **P2 integrity & architecture (ongoing):** FKs + versioned migrations + async
   backups; add CI + unit tests; then split the client & server monoliths
   domain-by-domain behind the tests.
5. **P3 UX/ops:** mobile nav, admin form, operations edit/PDF/bulk, service
   supervision + health + log rotation.

Everything above is fixable without a rewrite — the architecture is sound enough to
harden in place. The urgent line is **P0 (security) before this system is exposed
to more than a trusted, single-user LAN.**
