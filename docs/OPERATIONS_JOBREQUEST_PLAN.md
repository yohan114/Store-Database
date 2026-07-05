# Plan — Operations Job-Request Workflow (Track B)

**Repo:** `yohan114/Store-Database` · **Branch:** `claude/sqlite-migration-ui-updates-91x1u7`
**Goal:** a separate **Operations** dashboard where a job is *requested* by Transport, *approved* by the Transport Manager, then the Operational Manager, and on completion notifies Transport + Operational Manager. Outside (outsourced) jobs auto-email selected parties. This area shows **operations only** — kept apart from Stores (deliveries) and Workshop (job cards / costing).

---

## 0. What already exists (so we don't rebuild it)

| In place | Where |
|---|---|
| All 7 **roles** (Transport Officer/Manager, Operational Manager, Asst/Mech Engineer, Technician, Admin) + `requireRole()` gate | `auth.js:20-38,142-150` |
| **Users** table with `roles` (JSON), `email`, `designation`, scrypt passwords, SQLite sessions | `auth.js`, `users` table |
| The Job-Card-System's **mailer** (zero-dependency SMTP), **notifications**, **domain state-machine**, **PDF** modules — portable | `/workspace/job-card-system/src/{mailer,notifications,domain,pdf}.js` |

Missing (this is the build): user management, the job-request entity + approval engine, notifications, the mailer wiring, and the Operations dashboard + role-scoped navigation.

---

## 1. Data model (new tables, additive migrations in `db.js`)

```sql
CREATE TABLE job_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reqNo TEXT,                       -- JR-YYYY-NNNN (assigned on submit)
  type TEXT,                        -- INTERNAL | OUTSOURCED
  status TEXT,                      -- see state machine below
  title TEXT, details TEXT,
  vehicleMachinery TEXT, ecdNo TEXT, projectName TEXT, site TEXT,
  priority TEXT,                    -- Normal | Urgent
  neededBy TEXT, neededByISO TEXT,
  -- outsourced
  vendorName TEXT, vendorEmail TEXT,
  emailRecipients TEXT,             -- JSON array of extra selected recipients
  emailSentAt TEXT,
  -- lifecycle actors (snapshots)
  requestedBy INTEGER, requestedByName TEXT, requestedAt TEXT,
  tmApprovedBy INTEGER, tmApprovedAt TEXT,
  omApprovedBy INTEGER, omApprovedAt TEXT,
  completedBy INTEGER, completedAt TEXT,
  createdAt TEXT, updatedAt TEXT
);
CREATE TABLE job_request_audits (   -- immutable timeline
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requestId INTEGER, userId INTEGER, userName TEXT,
  action TEXT, fromStatus TEXT, toStatus TEXT, note TEXT, at TEXT
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER,                   -- recipient
  requestId INTEGER, reqNo TEXT,
  message TEXT, isRead INTEGER DEFAULT 0, at TEXT
);
CREATE TABLE outbox (               -- every email attempt, sent or simulated
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requestId INTEGER, reqNo TEXT,
  toAddr TEXT, cc TEXT, subject TEXT, body TEXT,
  status TEXT,                      -- sent | simulated | failed
  error TEXT, at TEXT
);
```

Job requests are a **separate entity** from the workshop `jobcards` (which carry cost data and a different lifecycle) — matching "operations only, separate from workshop." *(Optional future link: a completed request could spawn a workshop job card for costing — not in this phase.)*

---

## 2. Approval state machine (`jobrequests.js`, role-gated transitions)

```
DRAFT ──submit──▶ PENDING_TM ──tmApprove──▶ PENDING_OM ──omApprove──▶ APPROVED
   ▲                  │ tmReject                │ omReject                │ start
   └──── edit ────────┘        └──▶ REJECTED ◀──┘                        ▼
                                (notify requester)                   IN_PROGRESS
                                                                         │ complete
   CLOSED ◀──close── COMPLETED ◀───────────────────────────────────────┘
```

| Transition | Who | Effect |
|---|---|---|
| **submit** | Transport Officer / Admin | assigns `JR-` number → PENDING_TM; **notify Transport Manager** |
| **tmApprove** | Transport Manager / Admin | → PENDING_OM; **notify Operational Manager** |
| **omApprove** | Operational Manager / Admin | → APPROVED; if **OUTSOURCED → auto-email selected parties**; notify requester |
| **tmReject / omReject** | resp. approver | → REJECTED; **notify requester** (reason required) |
| **start** | Transport Officer/Manager / Admin | → IN_PROGRESS |
| **complete** | Transport Officer/Manager / Ops Manager / Admin | → COMPLETED; **notify Transport Officer + Transport Manager + Operational Manager** |
| **close** | Ops Manager / Admin | → CLOSED |

Every transition writes a `job_request_audits` row (who/when/note). Illegal transitions return 400.

---

## 3. Notifications (in-app)

- `notifications` rows created on submit / approve / reject / complete per the table above.
- API: `GET /api/notifications` (mine, newest first, unread count), `POST /api/notifications/read-all`, `POST /api/notifications/:id/read`.
- UI: a **bell** in the top bar with an unread badge + a dropdown list; clicking a notification opens the request. On **completion**, the Transport Officer and Operational Manager (and TM) see it immediately (next poll / on open).

---

## 4. Email for outsourced jobs (`mailer.js`, ported)

- Zero-dependency SMTP (from Job-Card-System) with **graceful fallback**: if SMTP isn't configured, the email is **composed and logged to the Outbox as `simulated`** (nothing lost) and really sends once credentials are added.
- **Config**: `SMTP_HOST/PORT/USER/PASS/FROM` via env or `mail.config.json` (git-ignored). An **Outbox** screen shows every email (sent/simulated/failed) with its content.
- **Recipients = "selected parties"**: on an outsourced request the requester picks the **vendor email** + ticks **additional recipients** (from the user directory and/or free emails); an admin-set **standing CC list** is always included. Sent automatically on final (OM) approval; a **Resend** action is available.
- ⚠️ Outbound SMTP may be blocked by this environment's network policy — the simulate-to-outbox fallback means the workflow still works; real delivery is verified once you run it where SMTP egress is allowed and creds are set.

---

## 5. Users & roles admin

- New **Admin → Users** screen + API (`GET/POST /api/users`, `POST /api/users/:id` update, `POST /api/users/:id/reset-password`), all `requireRole('ADMIN')`.
- Create accounts with **name, username, email, role(s), password** (forced change on first login). Emails matter — notifications/CC use them.
- Seed a few example accounts (a Transport Officer, Transport Manager, Operational Manager) you can rename/repoint, so the flow is demoable on day one.

---

## 6. Operations dashboard + role-scoped navigation

- New sidebar section **Operations** (icon), containing:
  - **Ops overview**: tiles — *Pending my approval*, *My open requests*, *In progress*, *Completed this month*; a *Pending approvals* queue; my recent requests; the notification feed.
  - **Request a Job** form (Internal / Outsourced toggle; vehicle/ECD, project/site, details, priority, needed-by; outsourced → vendor + recipient picker).
  - **Requests list** (filters: status, mine, pending-my-approval) → **request detail** with the role-gated action buttons, audit timeline, and (outsourced) the email/outbox panel.
- **Role-scoped nav** so the area "shows operations only":
  - Transport Officer/Manager, Operational Manager → see **Operations** (default landing).
  - Store keeper → **Stores**. Technician / Mech Engineer → **Workshop / Job Cards**.
  - **Admin** sees everything.
  This is view-gating in the SPA plus `requireRole` on the server; workshop/stores data never appears in the Operations area.

---

## 7. Delivery phases (each shippable, tests + smoke per phase)

1. **B1 — schema + `jobrequests.js` engine + API** (create/list/get/transition) with audit trail; unit-ish API tests for the state machine + role gates.
2. **B2 — notifications** (table, API, bell UI).
3. **B3 — users admin** (API + screen) + seed example approver accounts.
4. **B4 — Operations dashboard + request form + detail/approvals + role-scoped nav.**
5. **B5 — mailer** (port, config, Outbox screen, outsourced auto-email + resend).
6. **B6 — tests + browser smoke of the full request→approve→approve→complete→notify flow (+ outsourced email→outbox); ship PR.**

Client code goes in `src/client/` (TypeScript) and compiles to `js/`, consistent with the current build.

---

## 8. Decisions (defaults chosen; tell me to change any)

1. **Email now**: build with **simulate-to-outbox fallback + real SMTP when configured** (recommended) — works immediately, you add a Gmail app-password later. *(alt: provide SMTP creds now / skip email.)*
2. **Outsourced recipients**: **requester picks per request + admin standing CC** (recommended). *(alt: one fixed configurable list.)*
3. **Job requests vs workshop job cards**: keep **separate** (recommended, matches "operations only"). *(alt: an approved request also opens a workshop job card for costing.)*
4. **Completion notification channel**: **in-app** to Transport Officer + Transport Manager + Operational Manager (recommended). Add **email too** on completion? (optional.)
