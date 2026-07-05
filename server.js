/**
 * server.js — Delivery / Inventory Monitor API (SQLite edition).
 *
 * Rewritten from the old MS Access + PowerShell backend. Every request used to
 * spawn a PowerShell process and re-scan the entire database; now all work is
 * done in-process with indexed SQLite queries (single-digit milliseconds).
 *
 * Core operations: add MRN · update receive · update GRN · update issue.
 * Items are divided into categories (auto-classified, manual override allowed).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');

const dbApi = require('./db');
const { toISO, nowISO } = dbApi;
const { classify, CATEGORIES } = require('./categorize');
const auth = require('./auth');
const costing = require('./costing');
const config = require('./config');
const jobcards = require('./jobcards');
const programme = require('./programme');
const dashboard = require('./dashboard');
const jobrequests = require('./jobrequests');
const notifications = require('./notifications');
const users = require('./users');

dbApi.init();
auth.ensureSeedUser();
users.ensureSeedApprovers();
programme.ensureSeedMechanics();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '100mb' }));

// ---- Response gzip (zero-dependency) --------------------------------------
// The whole-dataset /api/items JSON is ~2.9 MB uncompressed; gzip drops it
// ~10× on the wire (review finding 10/perf). Compression is async so it never
// blocks the event loop, and only kicks in for bodies over ~1 KB when the
// client advertises gzip. Static files keep their own (browser-cached) path.
const zlib = require('zlib');
app.use((req, res, next) => {
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
    const rawSend = res.send.bind(res);
    res.send = (body) => {
        try {
            if (!res.getHeader('Content-Encoding') && (Buffer.isBuffer(body) || typeof body === 'string') && Buffer.byteLength(body) > 1024) {
                res.setHeader('Vary', 'Accept-Encoding');
                zlib.gzip(body, (err, gz) => {
                    if (err) return rawSend(body);
                    res.setHeader('Content-Encoding', 'gzip');
                    res.removeHeader('Content-Length');
                    rawSend(gz);
                });
                return res;
            }
        } catch (_) { /* fall through to uncompressed */ }
        return rawSend(body);
    };
    next();
});

// Resolve the logged-in user (if any) for every request from its session cookie.
app.use(auth.attachUser);

// Disable caching for API routes to ensure network clients always get fresh data
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// ---- Authentication routes (public) ---------------------------------------
app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/item_tracker.html');
    res.sendFile(path.join(__dirname, 'login.html'));
});

// --- Login brute-force throttle (in-memory, per IP+username) ---------------
const LOGIN_WINDOW_MS = config.LOGIN_WINDOW_MS;   // rolling window
const LOGIN_MAX_FAILS = config.LOGIN_MAX_FAILS;   // fails before lockout
const loginFails = new Map();             // key -> { count, until }
function loginKey(req, username) { return `${req.ip || req.socket.remoteAddress || '?'}|${username}`; }
function loginBlocked(key) { const e = loginFails.get(key); return e && e.until && e.until > Date.now(); }
function noteLoginFail(key) {
    const now = Date.now();
    const e = loginFails.get(key) || { count: 0, until: 0 };
    e.count = (e.until && e.until > now ? e.count : 0) + 1;   // reset count after a lapsed window
    if (e.count >= LOGIN_MAX_FAILS) { e.until = now + LOGIN_WINDOW_MS; e.count = 0; }
    else { e.until = now + LOGIN_WINDOW_MS; }
    loginFails.set(key, e);
}

app.post('/api/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const key = loginKey(req, username);
    if (loginBlocked(key)) {
        console.warn(`[AUTH] login locked out for ${key}`);
        return res.status(429).json({ error: 'Too many failed attempts. Please wait a few minutes and try again.' });
    }
    const user = dbApi.get('SELECT * FROM users WHERE LOWER(username)=? AND active=1', [username]);
    if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
        noteLoginFail(key);
        return res.status(401).json({ error: 'Invalid username or password.' });
    }
    loginFails.delete(key);   // clear on success
    auth.createSession(res, user.id);
    res.json({ success: true, user: auth.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
    auth.destroySession(req, res);
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    res.json({ user: auth.publicUser(req.user) });
});

// Change own password (forced first-login change + account screen).
app.post('/api/account/password', auth.requireApiAuth, (req, res) => {
    const newPassword = String((req.body && req.body.newPassword) || '');
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    if (!req.user.mustChangePassword) {
        if (!auth.verifyPassword(currentPassword, req.user.passwordSalt, req.user.passwordHash)) {
            return res.status(403).json({ error: 'Current password is incorrect.' });
        }
    }
    const { salt, hash } = auth.hashPassword(newPassword);
    dbApi.run('UPDATE users SET passwordHash=?, passwordSalt=?, mustChangePassword=0 WHERE id=?', [hash, salt, req.user.id]);
    res.json({ success: true });
});

// ---- Health check (public) — for a supervisor / uptime probe --------------
// Cheap liveness + a trivial DB read; returns 503 if the database is unreachable.
app.get('/api/health', (req, res) => {
    try {
        dbApi.get('SELECT 1 AS ok');
        res.json({ status: 'ok', engine: dbApi.ENGINE, uptimeSeconds: Math.round(process.uptime()) });
    } catch (e) {
        res.status(503).json({ status: 'error', error: 'database unavailable' });
    }
});

// Read-only KPI summary for the E&C Master Portal. Token-authed via the
// x-portal-token header and mounted BEFORE the session gate so the portal can
// read it server-to-server without a login. Reuses dashboard.build() so the
// numbers always match the in-app dashboard. Never mutates.
app.get('/api/portal/summary', (req, res) => {
    const token = req.get('x-portal-token');
    const expected = process.env.WORKSHOP_PORTAL_TOKEN || process.env.PORTAL_TOKEN;
    if (!expected || !token || token !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const d = dashboard.build();
    const pendingJr = (dbApi.get(
        "SELECT COUNT(*) AS c FROM job_requests WHERE status IN ('PENDING_TM','PENDING_OM')"
    ) || {}).c || 0;
    const rs = (n) => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-LK');
    res.json({
        system: 'workshop',
        generatedAt: new Date().toISOString(),
        kpis: [
            { label: 'Spend this month', value: rs(d.spend.mtd), tone: 'neutral', href: '/item_tracker.html#dashboard' },
            { label: 'Pending MRN lines', value: d.pending.counts.total, tone: d.pending.counts.total > 0 ? 'warn' : 'good', href: '/item_tracker.html#tracker' },
            { label: 'Active job cards', value: d.jobs.active, tone: 'neutral', href: '/item_tracker.html#jobcards' },
            { label: 'Pending approvals', value: pendingJr, tone: pendingJr > 0 ? 'warn' : 'good', href: '/item_tracker.html#operations' },
        ],
    });
});

// Read-only entity list for the Master Portal's master-data spine (M4).
// Machines come from two sources: E&C-coded rows (ecdNo on jobcards/job_requests,
// which auto-match) and free-text vehicleMachinery strings (the messy tail, which
// land in the portal's unmapped queue). Token-authed; mounted before the gate.
app.get('/api/portal/entities', (req, res) => {
    const token = req.get('x-portal-token');
    const expected = process.env.WORKSHOP_PORTAL_TOKEN || process.env.PORTAL_TOKEN;
    if (!expected || !token || token !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

    // E&C-coded machines (auto-matchable by code)
    const ecRows = dbApi.all(
        `SELECT ecdNo, vehicleMachinery FROM jobcards WHERE TRIM(COALESCE(ecdNo,'')) != ''
         UNION ALL
         SELECT ecdNo, vehicleMachinery FROM job_requests WHERE TRIM(COALESCE(ecdNo,'')) != ''`
    );
    const byCode = new Map();
    for (const r of ecRows) {
        const code = norm(r.ecdNo);
        if (code && !byCode.has(code)) byCode.set(code, (r.vehicleMachinery || '').trim() || code);
    }

    // Free-text vehicle names (no reliable code)
    const vehRows = dbApi.all(
        `SELECT DISTINCT TRIM(vehicleMachinery) AS v FROM (
            SELECT vehicleMachinery FROM items WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
            UNION SELECT vehicleMachinery FROM issues WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
            UNION SELECT vehicleMachinery FROM jobcards WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
            UNION SELECT vehicleMachinery FROM job_requests WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
         ) WHERE v != '' ORDER BY v`
    );

    const machines = [];
    for (const [code, label] of byCode) machines.push({ localId: 'ec:' + code, code, label });
    for (const r of vehRows) machines.push({ localId: 'veh:' + r.v, code: '', label: r.v });

    const siteRows = dbApi.all(
        `SELECT DISTINCT TRIM(p) AS p FROM (
            SELECT projectName AS p FROM jobcards WHERE TRIM(COALESCE(projectName,'')) != ''
            UNION SELECT projectName AS p FROM job_requests WHERE TRIM(COALESCE(projectName,'')) != ''
            UNION SELECT site AS p FROM job_requests WHERE TRIM(COALESCE(site,'')) != ''
         ) WHERE p != '' ORDER BY p`
    );
    const sites = siteRows.map((r) => ({ localId: r.p, name: r.p }));

    res.json({ system: 'workshop', generatedAt: new Date().toISOString(), machines, sites });
});

// Read-only month-scoped job-cost feed for the Master Portal's profit engine
// (M5): each job card's labour and parts, attributed to a machine (ecdNo E&C
// code) and project. Money returned in LKR cents. Token-authed.
app.get('/api/portal/costs', (req, res) => {
    const token = req.get('x-portal-token');
    const expected = process.env.WORKSHOP_PORTAL_TOKEN || process.env.PORTAL_TOKEN;
    if (!expected || !token || token !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month=YYYY-MM required' });
    }
    const start = `${month}-01`;
    const [y, mo] = month.split('-').map(Number);
    const end = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

    const rows = dbApi.all(
        `SELECT j.id, j.ecdNo, j.projectName, j.dateISO, j.labourCost,
                COALESCE(p.c,0) AS partsCost, COALESCE(s.c,0) AS issuesCost
         FROM jobcards j
         LEFT JOIN (SELECT i.jobCardId AS jid, ${costing.RECEIVED_PARTS_SUM} AS c
                    FROM items i JOIN receipts r ON r.itemId=i.id GROUP BY i.jobCardId) p ON p.jid=j.id
         LEFT JOIN (SELECT s.jobCardId AS jid, ${costing.ISSUES_SUM} AS c
                    FROM issues s GROUP BY s.jobCardId) s ON s.jid=j.id
         WHERE COALESCE(j.dateISO,'') != '' AND j.dateISO >= ? AND j.dateISO < ?`,
        [start, end]
    );

    const costs = [];
    for (const j of rows) {
        const code = norm(j.ecdNo) || null;
        const site = (j.projectName || '').trim() || null;
        const labour = Number(j.labourCost) || 0;
        const parts = (Number(j.partsCost) || 0) + (Number(j.issuesCost) || 0);
        if (labour > 0) costs.push({ sourceRef: `job-labour:${j.id}`, machineCode: code, siteRef: site, category: 'labour', amountCents: Math.round(labour * 100), occurredAt: j.dateISO });
        if (parts > 0) costs.push({ sourceRef: `job-parts:${j.id}`, machineCode: code, siteRef: site, category: 'parts', amountCents: Math.round(parts * 100), occurredAt: j.dateISO });
    }
    res.json({ system: 'workshop', month, costs, income: [] });
});

// ---- Gate everything else behind authentication ---------------------------
app.use('/api', auth.requireApiAuth);
app.get(['/', '/item_tracker.html'], auth.requirePageAuth, (req, res) => {
    if (req.path === '/') return res.redirect('/item_tracker.html');
    res.sendFile(path.join(__dirname, 'item_tracker.html'));
});
// Compiled client scripts (source in src/client/*.ts, built by `npm run
// build:client`). The app bundle sits behind the login like the page itself;
// the login script must be public because it runs on the sign-in screen.
app.get('/js/app.js', auth.requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'js', 'app.js'));
});
app.get('/js/operations.js', auth.requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'js', 'operations.js'));
});
app.get('/js/login.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'js', 'login.js'));
});
// No blanket static serving: it exposed inventory.db, backups/ and the raw
// data files to anyone on the network without a login. The app is fully
// self-contained in item_tracker.html + login.html (assets come from CDNs).

// ---- Unified dashboard analytics -------------------------------------------
app.get('/api/dashboard', (req, res) => {
    res.json(dashboard.build(req.query));
});

// ===========================================================================
// Operations — job requests, notifications, users
// ===========================================================================
const svcErr = (res, out) => res.status(out.status || 500).json({ error: out.error });

// Error taxonomy: throw AppError(status, message) for an *expected* failure whose
// message is safe to show the client (400/403/404/409/429). Anything else is an
// unexpected bug — the centralized handler (bottom of file) returns a generic 500
// and logs the real detail instead of leaking it (review: error handling).
class AppError extends Error {
    constructor(status, message) { super(message); this.status = status; this.expose = true; }
}

app.get('/api/job-requests', (req, res) => {
    try { res.json(jobrequests.list(req.query, req.user)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/job-requests/meta', (req, res) => {
    res.json({
        statuses: jobrequests.STATUSES, statusLabels: jobrequests.STATUS_LABELS,
        canCreate: jobrequests.canCreate(req.user), roleLabels: auth.ROLE_LABELS,
        directory: users.directory(),
        // standingCc intentionally omitted — it is ADMIN-only and served from
        // the gated /api/settings/standing-cc endpoint instead.
    });
});
app.post('/api/job-requests', (req, res) => {
    try { const out = jobrequests.create(req.body || {}, req.user); if (out.error) return svcErr(res, out); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/job-requests/:id', (req, res) => {
    const r = jobrequests.get(parseInt(req.params.id)); if (!r) return res.status(404).json({ error: 'Not found' }); res.json(r);
});
app.put('/api/job-requests/:id', (req, res) => {
    try { const out = jobrequests.update(parseInt(req.params.id), req.body || {}, req.user); if (out.error) return svcErr(res, out); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/job-requests/:id/action', (req, res) => {
    try { const out = jobrequests.transition(parseInt(req.params.id), (req.body || {}).action, req.body || {}, req.user); if (out.error) return svcErr(res, out); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/job-requests/:id', (req, res) => {
    try { const out = jobrequests.remove(parseInt(req.params.id), req.user); if (out.error) return svcErr(res, out); res.json(out); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Notifications (current user's)
app.get('/api/notifications', (req, res) => {
    res.json({ notifications: notifications.listFor(req.user.id), unread: notifications.unreadCount(req.user.id) });
});
app.post('/api/notifications/read-all', (req, res) => { notifications.markAllRead(req.user.id); res.json({ success: true }); });
app.post('/api/notifications/:id/read', (req, res) => { notifications.markRead(parseInt(req.params.id), req.user.id); res.json({ success: true }); });

// Users admin (ADMIN only)
app.get('/api/users', auth.requireRole('ADMIN'), (req, res) => res.json({ users: users.list() }));
app.post('/api/users', auth.requireRole('ADMIN'), (req, res) => {
    const out = users.create(req.body || {}); if (out.error) return svcErr(res, out); res.json(out);
});
app.put('/api/users/:id', auth.requireRole('ADMIN'), (req, res) => {
    const out = users.update(parseInt(req.params.id), req.body || {}); if (out.error) return svcErr(res, out); res.json(out);
});
app.post('/api/users/:id/reset-password', auth.requireRole('ADMIN'), (req, res) => {
    const out = users.resetPassword(parseInt(req.params.id), req.body || {}); if (out.error) return svcErr(res, out); res.json(out);
});

// Standing CC list for outsourced e-mails (ADMIN)
app.get('/api/settings/standing-cc', auth.requireRole('ADMIN'), (req, res) => res.json({ standingCc: (dbApi.get(`SELECT value FROM app_settings WHERE key='standingCc'`) || {}).value || '' }));
app.post('/api/settings/standing-cc', auth.requireRole('ADMIN'), (req, res) => {
    const v = String((req.body || {}).standingCc || '').trim();
    dbApi.run(`INSERT INTO app_settings (key,value) VALUES ('standingCc',?) ON CONFLICT(key) DO UPDATE SET value=?`, [v, v]);
    res.json({ success: true, standingCc: v });
});

// Outbox (e-mail log) — ADMIN only (contains vendor communications).
app.get('/api/outbox', auth.requireRole('ADMIN'), (req, res) => res.json({ outbox: dbApi.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200') }));

// ---- Lightweight change signature for client polling ------------------------
// The UI polls this tiny endpoint instead of re-downloading the whole dataset;
// it only refetches when `version` changes. Receipt writes bump the parent
// item's updatedAt so pricing edits are visible in the signature too.
app.get('/api/summary', (req, res) => {
    try {
        // One scan per table (count + max id + max updatedAt together) instead of
        // two — halves the poll cost (review finding 13). count catches deletes,
        // maxId catches inserts, maxUpdatedAt catches in-place edits.
        const withUpdated = new Set(['items', 'issues', 'batteries', 'material_transfers', 'jobcards', 'daily_programme']);
        const parts = [];
        for (const t of ['items', 'receipts', 'issues', 'batteries', 'material_transfers', 'jobcards', 'daily_programme']) {
            const cols = withUpdated.has(t)
                ? `COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(MAX(updatedAt),'') AS u`
                : `COUNT(*) AS n, COALESCE(MAX(id),0) AS m, '' AS u`;
            const r = dbApi.get(`SELECT ${cols} FROM ${t}`);
            parts.push(`${r.n}:${r.m}:${r.u}`);
        }
        // Fold in the caller's unread-notification count so the client can drive
        // the bell from this one poll instead of a second /api/notifications hit.
        const unread = req.user ? notifications.unreadCount(req.user.id) : 0;
        res.json({ version: parts.join('|'), unread });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Job Cards -------------------------------------------------------------
app.get('/api/jobcards', (req, res) => {
    res.json(jobcards.list(req.query));
});
app.post('/api/jobcards', (req, res) => {
    const jc = jobcards.create(req.body || {}, req.user);
    res.json({ success: true, jobcard: jc });
});
// Suggest the job a vehicle + date would auto-link to (live form helper).
app.get('/api/jobcards/match', (req, res) => {
    res.json({ match: jobcards.findMatch(req.query.vehicle, req.query.dateISO) || null });
});
// Bulk: auto-link every still-unlinked MRN to its matching job (vehicle + window).
app.post('/api/jobcards/auto-link-mrns', auth.requireRole('ADMIN'), (req, res) => {
    const rows = dbApi.all("SELECT id, vehicleMachinery, reqDateISO FROM items WHERE jobCardId IS NULL AND vehicleMachinery != '' AND reqDateISO != ''");
    const issues = dbApi.all("SELECT id, vehicleMachinery, issueDateISO FROM issues WHERE jobCardId IS NULL AND vehicleMachinery != '' AND issueDateISO != ''");
    let linked = 0, issuesLinked = 0;
    dbApi.transaction(() => {
        for (const it of rows) {
            const m = jobcards.findMatch(it.vehicleMachinery, it.reqDateISO);
            if (m) { setItemJob(it.id, m.id, 'EXACT'); linked++; }
        }
        for (const is of issues) {
            const m = jobcards.findMatch(is.vehicleMachinery, is.issueDateISO);
            if (m) { setIssueJob(is.id, m.id, 'EXACT'); issuesLinked++; }
        }
    });
    res.json({ success: true, scanned: rows.length + issues.length, linked, issuesLinked });
});
app.get('/api/jobcards/:id', (req, res) => {
    const jc = jobcards.get(req.params.id);
    if (!jc) return res.status(404).json({ error: 'Job card not found.' });
    res.json(jc);
});
app.put('/api/jobcards/:id', (req, res) => {
    const jc = jobcards.update(req.params.id, req.body || {}, req.user);
    if (!jc) return res.status(404).json({ error: 'Job card not found.' });
    res.json({ success: true, jobcard: jc });
});
app.post('/api/jobcards/:id/status', (req, res) => {
    const r = jobcards.setStatus(req.params.id, (req.body || {}).status, (req.body || {}).note, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, jobcard: r.jobcard });
});
app.delete('/api/jobcards/:id', auth.requireRole('ADMIN'), (req, res) => {
    res.json(jobcards.remove(req.params.id));
});
// Pull in EVERY unlinked MRN + issue for this job's vehicle dated within its
// window [start-2 … end+2] (not just best-match). Only claims unlinked rows.
app.post('/api/jobcards/:id/auto-link', (req, res) => {
    const job = dbApi.get('SELECT id, vehicleMachinery, dateISO, expectedDateISO FROM jobcards WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job card not found.' });
    const w = jobcards.jobWindow(job);
    if (!w || !w.vn) return res.json({ success: true, linked: 0, issuesLinked: 0 });
    const like = '%' + w.vn + '%';
    const rows = dbApi.all("SELECT id, vehicleMachinery FROM items WHERE jobCardId IS NULL AND reqDateISO != '' AND reqDateISO >= ? AND reqDateISO <= ? AND REPLACE(UPPER(vehicleMachinery),' ','') LIKE ?", [w.lo, w.hi, like]).filter((r) => jobcards.vehSet(r.vehicleMachinery).includes(w.vn));
    const issues = dbApi.all("SELECT id, vehicleMachinery FROM issues WHERE jobCardId IS NULL AND issueDateISO != '' AND issueDateISO >= ? AND issueDateISO <= ? AND REPLACE(UPPER(vehicleMachinery),' ','') LIKE ?", [w.lo, w.hi, like]).filter((r) => jobcards.vehSet(r.vehicleMachinery).includes(w.vn));
    let linked = 0, issuesLinked = 0;
    dbApi.transaction(() => {
        for (const it of rows) { setItemJob(it.id, job.id, 'EXACT'); linked++; }
        for (const is of issues) { setIssueJob(is.id, job.id, 'EXACT'); issuesLinked++; }
    });
    res.json({ success: true, linked, issuesLinked });
});
// Distinct unlinked MRNs whose vehicle matches this job — feeds the "Link MRN"
// dropdown in the job modal. Vehicle match is the shared normVeh/vehSet rule
// (any plate the job shares with the MRN), one row per mrnNum.
app.get('/api/jobcards/:id/linkable-mrns', (req, res) => {
    const job = dbApi.get('SELECT vehicleMachinery FROM jobcards WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job card not found.' });
    const jobVehs = jobcards.vehSet(job.vehicleMachinery);
    if (!jobVehs.length) return res.json({ mrns: [] });
    const likes = jobVehs.map(() => "REPLACE(UPPER(vehicleMachinery),' ','') LIKE ?").join(' OR ');
    const params = jobVehs.map((v) => '%' + v + '%');
    const rows = dbApi.all(
        "SELECT mrnNum, itemName, vehicleMachinery FROM items WHERE jobCardId IS NULL AND TRIM(COALESCE(mrnNum,'')) != '' AND (" + likes + ") ORDER BY mrnNum",
        params
    );
    const seen = new Set(); const mrns = [];
    for (const r of rows) {
        if (seen.has(r.mrnNum)) continue;
        if (!jobcards.vehSet(r.vehicleMachinery).some((v) => jobVehs.includes(v))) continue;
        seen.add(r.mrnNum);
        mrns.push({ mrnNum: r.mrnNum, itemName: r.itemName || '' });
    }
    res.json({ mrns });
});

// ---- Daily Programme (child of a job card) + mechanic rates ----------------
app.get('/api/jobcards/:id/programme', (req, res) => {
    res.json({ programme: programme.listForJob(req.params.id) });
});
app.post('/api/jobcards/:id/programme', (req, res) => {
    const r = programme.create(req.params.id, req.body || {}, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, entry: r.entry });
});
app.put('/api/programme/:id', (req, res) => {
    const r = programme.update(req.params.id, req.body || {}, req.user);
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ success: true, entry: r.entry });
});
app.delete('/api/programme/:id', (req, res) => {
    res.json(programme.remove(req.params.id));
});
// Add a daily entry by vehicle + date — auto-resolve the job (else per-vehicle catch-all).
app.post('/api/programme/auto', (req, res) => {
    const b = req.body || {};
    const vehicle = b.vehicle || b.vehicleMachinery;
    const dateISO = dbApi.toISO(b.entryDate) || new Date().toISOString().slice(0, 10);
    let jobId = b.jobCardId ? parseInt(b.jobCardId) : null;
    let matched = !!jobId;
    if (!jobId) {
        const m = jobcards.findMatch(vehicle, dateISO);
        if (m) { jobId = m.id; matched = true; }
        else jobId = jobcards.getOrCreateCatchAll(vehicle);
    }
    if (!jobId) return res.status(400).json({ error: 'A vehicle (or job) is required.' });
    const r = programme.create(jobId, Object.assign({}, b, { vehicleMachinery: vehicle }), req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    const job = dbApi.get('SELECT jobNo FROM jobcards WHERE id=?', [jobId]);
    res.json({ success: true, entry: r.entry, jobCardId: jobId, jobNo: job ? job.jobNo : null, matched });
});
// "Today" view across all jobs.
app.get('/api/programme', (req, res) => {
    const dateISO = req.query.dateISO || new Date().toISOString().slice(0, 10);
    res.json({ dateISO, programme: programme.listByDate(dateISO) });
});
// Mechanic rates admin.
app.get('/api/mechanics', (req, res) => {
    res.json({ mechanics: programme.mechanicsList() });
});
app.post('/api/mechanics', (req, res) => {
    const r = programme.mechanicAdd(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, mechanic: r.mechanic });
});
app.put('/api/mechanics/:id', (req, res) => {
    const r = programme.mechanicUpdate(req.params.id, req.body || {});
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ success: true, mechanic: r.mechanic });
});

// ---- Link MRNs (items) to job cards (parts cost) ---------------------------
// method: how the link was made — 'MANUAL' | 'EXACT' (in-window) | 'NEAR'
// (nearest guess) | 'CATCHALL' (per-vehicle bucket). gap: day distance, if known.
// Recorded so low-confidence links are auditable/reversible (review finding 16).
function setItemJob(itemId, jobCardId, method = 'MANUAL', gap = null) {
    if (!jobCardId) { dbApi.run('UPDATE items SET jobCardId=NULL, jobNo=NULL, linkMethod=NULL, linkGap=NULL WHERE id=?', [itemId]); return null; }
    const j = dbApi.get('SELECT jobNo FROM jobcards WHERE id=?', [jobCardId]);
    if (!j) return null;
    dbApi.run('UPDATE items SET jobCardId=?, jobNo=?, linkMethod=?, linkGap=? WHERE id=?', [jobCardId, j.jobNo, method, gap, itemId]);
    return j.jobNo;
}
function setIssueJob(issueId, jobCardId, method = 'MANUAL', gap = null) {
    if (!jobCardId) { dbApi.run('UPDATE issues SET jobCardId=NULL, jobNo=NULL, linkMethod=NULL, linkGap=NULL WHERE id=?', [issueId]); return null; }
    const j = dbApi.get('SELECT jobNo FROM jobcards WHERE id=?', [jobCardId]);
    if (!j) return null;
    dbApi.run('UPDATE issues SET jobCardId=?, jobNo=?, linkMethod=?, linkGap=? WHERE id=?', [jobCardId, j.jobNo, method, gap, issueId]);
    return j.jobNo;
}
// Link every item line of an MRN number to a job card.
app.post('/api/jobcards/:id/link-mrn', (req, res) => {
    const jobCardId = parseInt(req.params.id);
    const job = dbApi.get('SELECT jobNo FROM jobcards WHERE id=?', [jobCardId]);
    if (!job) return res.status(404).json({ error: 'Job card not found.' });
    const mrnNum = String((req.body || {}).mrnNum || '').trim();
    if (!mrnNum) return res.status(400).json({ error: 'MRN number is required.' });
    const r = dbApi.run('UPDATE items SET jobCardId=?, jobNo=? WHERE mrnNum=?', [jobCardId, job.jobNo, mrnNum]);
    if (!r.changes) return res.status(404).json({ error: 'No MRN found with that number.' });
    res.json({ success: true, linked: r.changes });
});
// Link / unlink a single item line.
app.post('/api/items/:id/link', (req, res) => {
    const jobNo = setItemJob(parseInt(req.params.id), (req.body || {}).jobCardId || null);
    res.json({ success: true, jobNo });
});
// Link / unlink a single issued item.
app.post('/api/issues/:id/link', (req, res) => {
    const jobNo = setIssueJob(parseInt(req.params.id), (req.body || {}).jobCardId || null);
    res.json({ success: true, jobNo });
});

// --- helpers ----------------------------------------------------------------
const s = (v) => (v === null || v === undefined) ? '' : String(v);
const numOrNull = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

// Whitelisted sort columns (prevents SQL injection via the sort param).
const ITEM_SORTS = {
    mrnNum: 'mrnNum COLLATE NOCASE',
    itemName: 'itemName COLLATE NOCASE',
    vehicleMachinery: 'vehicleMachinery COLLATE NOCASE',
    category: 'category COLLATE NOCASE',
    reqDate: 'reqDateISO',
    reqQty: 'reqQty',
    recQty: 'recQty',
    gap: '(reqQty - recQty)',
};

// Canonical source values come from costing.js (the single source of truth) so
// requests/deliveries/dashboard/export can never fragment (finding 9).
const { normRequestSource, canonicalPurchaseSource } = costing;

// Build the item-level WHERE clause shared by list + count queries.
function buildItemWhere(q) {
    const where = [];
    const params = [];
    if (q.search) {
        const like = `%${q.search}%`;
        where.push(`(i.mrnNum LIKE ? OR i.itemName LIKE ? OR i.vehicleMachinery LIKE ? OR i.itemDesc LIKE ? OR i.category LIKE ? OR EXISTS(SELECT 1 FROM receipts rr WHERE rr.itemId=i.id AND (rr.grnNumber LIKE ? OR rr.invoiceNumber LIKE ? OR rr.supplierName LIKE ?)))`);
        params.push(like, like, like, like, like, like, like, like);
    }
    if (q.category && q.category !== 'all') { where.push(`i.category = ?`); params.push(q.category); }
    if (q.vehicle && q.vehicle !== 'all') { where.push(`LOWER(TRIM(i.vehicleMachinery)) = LOWER(TRIM(?))`); params.push(q.vehicle); }
    if (q.requestSource && q.requestSource !== 'all') {
        if (q.requestSource === 'Unspecified') where.push(`(i.requestSource IS NULL OR i.requestSource = '')`);
        else { where.push(`i.requestSource = ?`); params.push(normRequestSource(q.requestSource) || q.requestSource); }
    }
    const startISO = q.startDate ? toISO(q.startDate) : '';
    const endISO = q.endDate ? toISO(q.endDate) : '';
    if (startISO) { where.push(`i.reqDateISO >= ? AND i.reqDateISO != ''`); params.push(startISO); }
    if (endISO) { where.push(`i.reqDateISO <= ? AND i.reqDateISO != ''`); params.push(endISO); }
    return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// Filter-tab condition on the computed columns.
function filterTabClause(filter) {
    switch (filter) {
        case 'pending-delivery': return 'reqQty > recQty';
        case 'pending-pricing': return 'reqQty <= recQty AND recCount > 0 AND hasUnpriced = 1';
        case 'completed': return 'reqQty <= recQty AND NOT (recCount > 0 AND hasUnpriced = 1)';
        default: return '';
    }
}

function attachReceipts(items) {
    if (!items.length) return items;
    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const receipts = dbApi.all(`SELECT * FROM receipts WHERE itemId IN (${placeholders})`, ids);
    const byItem = {};
    for (const r of receipts) (byItem[r.itemId] = byItem[r.itemId] || []).push(r);
    for (const it of items) it.receipts = byItem[it.id] || [];
    return items;
}

// ===========================================================================
// 1. GET /api/items — paginated list OR full unpaginated array
// ===========================================================================
app.get('/api/items', (req, res) => {
    try {
        const page = parseInt(req.query.page) || null;
        const limit = parseInt(req.query.limit) || null;

        // The computed columns used by both filter tabs and sorting. One
        // GROUP-BY aggregate over receipts replaces four correlated subqueries
        // per row (review finding 10) — a single pass instead of 4×N lookups.
        const computed = `
            i.*,
            COALESCE(rc.recQty,0) AS recQty,
            COALESCE(rc.recCount,0) AS recCount,
            rc.recDateISO AS recDateISO,
            COALESCE(rc.hasUnpriced,0) AS hasUnpriced
        `;
        const RECEIPT_AGG = `LEFT JOIN (
            SELECT itemId,
                   COALESCE(SUM(qty),0) AS recQty,
                   COUNT(*) AS recCount,
                   MAX(deliveryDateISO) AS recDateISO,
                   MAX(CASE WHEN unitPrice IS NULL OR unitPrice=0 THEN 1 ELSE 0 END) AS hasUnpriced
            FROM receipts GROUP BY itemId
        ) rc ON rc.itemId = i.id`;

        // Unpaginated: return the whole dataset (used by dashboard/fleet/dropdowns).
        if (!page || !limit) {
            const items = dbApi.all(`SELECT ${computed} FROM items i ${RECEIPT_AGG} ORDER BY i.reqDateISO DESC, i.id DESC`);
            return res.json(attachReceipts(items));
        }

        const { clause, params } = buildItemWhere(req.query);
        const tab = filterTabClause(req.query.filter);
        const outerWhere = tab ? `WHERE ${tab}` : '';

        const sortKey = ITEM_SORTS[req.query.sort] || ITEM_SORTS.reqDate;
        const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const skip = (page - 1) * limit;

        const baseCte = `WITH base AS (SELECT ${computed} FROM items i ${RECEIPT_AGG} ${clause})`;
        const total = dbApi.get(`${baseCte} SELECT COUNT(*) AS c FROM base ${outerWhere}`, params).c;
        const items = dbApi.all(
            `${baseCte} SELECT * FROM base ${outerWhere} ORDER BY ${sortKey} ${order}, id DESC LIMIT ? OFFSET ?`,
            [...params, limit, skip]
        );
        attachReceipts(items);

        res.json({ items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 2. POST /api/items — add new MRN (auto-categorize when no category given)
// ===========================================================================
app.post('/api/items', (req, res) => {
    try {
        const b = req.body || {};
        const itemName = s(b.itemName);
        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        const now = nowISO();
        const r = dbApi.run(
            `INSERT INTO items (mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, requestSource, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s(b.mrnNum), s(b.reqDate), toISO(b.reqDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.reqQty) || 0, category, normRequestSource(b.requestSource), now, now]
        );
        // Link to a job: explicit pick wins; otherwise auto-match by vehicle + date window.
        let linkedJobNo = null;
        if (b.jobCardId) linkedJobNo = setItemJob(r.lastInsertRowid, b.jobCardId, 'MANUAL');
        else {
            const m = jobcards.findMatch(s(b.vehicleMachinery), toISO(b.reqDate));
            if (m) linkedJobNo = setItemJob(r.lastInsertRowid, m.id, 'EXACT');
        }
        res.json({ success: true, id: r.lastInsertRowid, category, jobNo: linkedJobNo });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 3. PUT /api/items/:id — edit MRN (respect manual category, else re-classify)
// ===========================================================================
app.put('/api/items/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const b = req.body || {};
        const itemName = s(b.itemName);
        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        dbApi.run(
            `UPDATE items SET mrnNum=?, reqDate=?, reqDateISO=?, vehicleMachinery=?, itemName=?, itemDesc=?, reqQty=?, category=?, requestSource=COALESCE(?, requestSource), updatedAt=? WHERE id=?`,
            [s(b.mrnNum), s(b.reqDate), toISO(b.reqDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.reqQty) || 0, category, normRequestSource(b.requestSource), nowISO(), id]
        );
        if (b.jobCardId !== undefined) setItemJob(id, b.jobCardId || null);
        res.json({ success: true, category });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Destructive deletes require the ADMIN role (real authorization). This
// replaces the old shared 'delete password' — a constant that shipped in the
// client bundle and provided no real protection.
const verifyDeletePassword = auth.requireRole('ADMIN');

// 4. DELETE /api/items/:id  (cascades receipts)
app.delete('/api/items/:id', verifyDeletePassword, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        dbApi.transaction(() => {
            dbApi.run(`DELETE FROM receipts WHERE itemId=?`, [id]);
            dbApi.run(`DELETE FROM items WHERE id=?`, [id]);
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 5. POST /api/items/:id/receipts — update receive (and initial GRN fields)
// ===========================================================================
app.post('/api/items/:id/receipts', (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const b = req.body || {};
        const r = dbApi.run(
            `INSERT INTO receipts (itemId, qty, transactionType, deliveryDate, deliveryDateISO, purchaseSource, grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [itemId, Number(b.qty) || 0, s(b.transactionType), s(b.deliveryDate), toISO(b.deliveryDate), canonicalPurchaseSource(b.purchaseSource),
             s(b.grnNumber), s(b.invoiceNumber), s(b.invoiceDate), s(b.supplierName), numOrNull(b.unitPrice)]
        );
        dbApi.run(`UPDATE items SET updatedAt=? WHERE id=?`, [nowISO(), itemId]);
        res.json({ success: true, id: r.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. PUT /api/receipts/:id — update GRN / invoice / supplier / pricing
app.put('/api/receipts/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const b = req.body || {};
        // Only overwrite columns that were actually provided (pricing edits send a subset).
        const fields = [];
        const params = [];
        const setIf = (key, col, transform = s) => {
            if (Object.prototype.hasOwnProperty.call(b, key)) { fields.push(`${col}=?`); params.push(transform(b[key])); }
        };
        setIf('qty', 'qty', v => Number(v) || 0);
        setIf('transactionType', 'transactionType');
        if (Object.prototype.hasOwnProperty.call(b, 'deliveryDate')) {
            fields.push('deliveryDate=?', 'deliveryDateISO=?'); params.push(s(b.deliveryDate), toISO(b.deliveryDate));
        }
        setIf('purchaseSource', 'purchaseSource', canonicalPurchaseSource);
        setIf('grnNumber', 'grnNumber');
        setIf('invoiceNumber', 'invoiceNumber');
        setIf('invoiceDate', 'invoiceDate');
        setIf('supplierName', 'supplierName');
        setIf('unitPrice', 'unitPrice', numOrNull);
        if (!fields.length) return res.json({ success: true });
        params.push(id);
        dbApi.run(`UPDATE receipts SET ${fields.join(', ')} WHERE id=?`, params);
        dbApi.run(`UPDATE items SET updatedAt=? WHERE id=(SELECT itemId FROM receipts WHERE id=?)`, [nowISO(), id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. DELETE /api/receipts/:id
app.delete('/api/receipts/:id', verifyDeletePassword, (req, res) => {
    try {
        const rid = parseInt(req.params.id);
        const owner = dbApi.get(`SELECT itemId FROM receipts WHERE id=?`, [rid]);
        dbApi.run(`DELETE FROM receipts WHERE id=?`, [rid]);
        if (owner) dbApi.run(`UPDATE items SET updatedAt=? WHERE id=?`, [nowISO(), owner.itemId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 8. ISSUES — update issue (items issued out to a vehicle/machinery)
// ===========================================================================
app.get('/api/issues', (req, res) => {
    try {
        const where = [];
        const params = [];
        if (req.query.search) {
            const like = `%${req.query.search}%`;
            where.push(`(vehicleMachinery LIKE ? OR itemName LIKE ? OR itemDesc LIKE ? OR issuedTo LIKE ? OR issuedBy LIKE ? OR mrnNum LIKE ? OR category LIKE ?)`);
            params.push(like, like, like, like, like, like, like);
        }
        if (req.query.category && req.query.category !== 'all') { where.push(`category = ?`); params.push(req.query.category); }
        if (req.query.vehicle && req.query.vehicle !== 'all') { where.push(`LOWER(TRIM(vehicleMachinery)) = LOWER(TRIM(?))`); params.push(req.query.vehicle); }
        if (req.query.startDate) { where.push(`issueDateISO >= ? AND issueDateISO != ''`); params.push(toISO(req.query.startDate)); }
        if (req.query.endDate) { where.push(`issueDateISO <= ? AND issueDateISO != ''`); params.push(toISO(req.query.endDate)); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const page = parseInt(req.query.page) || null;
        const limit = parseInt(req.query.limit) || null;
        if (!page || !limit) {
            return res.json(dbApi.all(`SELECT * FROM issues ${clause} ORDER BY issueDateISO DESC, id DESC`, params));
        }
        const total = dbApi.get(`SELECT COUNT(*) AS c FROM issues ${clause}`, params).c;
        const issues = dbApi.all(`SELECT * FROM issues ${clause} ORDER BY issueDateISO DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
        res.json({ items: issues, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Suggested unit price for an issued item: the most recent priced 'Receive'
// receipt of the same item name (case-insensitive). Null when the item was
// never priced. Used to auto-fill the issue price so issues roll into job cost.
function suggestIssuePrice(itemName) {
    const name = String(itemName || '').trim().toLowerCase();
    if (!name) return null;
    const row = dbApi.get(
        `SELECT r.unitPrice AS p FROM receipts r JOIN items i ON i.id = r.itemId
         WHERE r.transactionType='Receive' AND r.unitPrice IS NOT NULL
           AND LOWER(TRIM(i.itemName)) = ?
         ORDER BY r.deliveryDateISO DESC, r.id DESC LIMIT 1`, [name]);
    return row ? row.p : null;
}

// GET /api/issues/suggest-price?itemName=... -> { unitPrice }
app.get('/api/issues/suggest-price', (req, res) => {
    try {
        res.json({ unitPrice: suggestIssuePrice(req.query.itemName) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// How much of a linked request line is still available to issue: receipts
// minus issues drawn from it (linked by itemId, or legacy rows matching the
// same MRN + name). Only issues that pick a request line (itemId) are hard-
// validated — free-text issues keep the client-side soft check, because the
// legacy data contains name-level imbalances that would block real work.
// Returns an error string when qty cannot be issued, else null.
function checkIssueStock({ itemId, qty, excludeIssueId }) {
    if (!itemId || !(qty > 0)) return null;
    const EPS = 0.005;
    const excl = excludeIssueId || -1;
    const item = dbApi.get(`SELECT id, mrnNum, itemName FROM items WHERE id=?`, [itemId]);
    if (!item) return 'Selected request line no longer exists.';
    const received = (dbApi.get(`SELECT COALESCE(SUM(qty),0) AS q FROM receipts WHERE itemId=?`, [itemId]) || {}).q || 0;
    const issued = (dbApi.get(
        `SELECT COALESCE(SUM(qty),0) AS q FROM issues
         WHERE id != ? AND (itemId = ? OR (itemId IS NULL
               AND LOWER(TRIM(itemName)) = LOWER(TRIM(?))
               AND LOWER(TRIM(COALESCE(mrnNum,''))) = LOWER(TRIM(?))))`,
        [excl, itemId, item.itemName, item.mrnNum || '']) || {}).q || 0;
    const available = received - issued;
    if (qty > available + EPS) {
        return `Insufficient stock on MRN ${item.mrnNum || item.id}: received ${received}, already issued ${issued}, available ${Math.max(0, Math.round(available * 100) / 100)} — cannot issue ${qty}.`;
    }
    return null;
}

app.post('/api/issues', (req, res) => {
    try {
        const b = req.body || {};
        const itemName = s(b.itemName);
        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        const itemId = b.itemId ? parseInt(b.itemId) : null;
        const qty = Number(b.qty) || 0;
        // Explicit price wins; otherwise auto-suggest from the item's priced deliveries.
        const unitPrice = Object.prototype.hasOwnProperty.call(b, 'unitPrice')
            ? numOrNull(b.unitPrice) : suggestIssuePrice(itemName);
        const stockErr = checkIssueStock({ itemId, qty, excludeIssueId: null });
        if (stockErr) return res.status(400).json({ error: stockErr });
        const now = nowISO();
        const r = dbApi.run(
            `INSERT INTO issues (issueDate, issueDateISO, vehicleMachinery, itemName, itemDesc, qty, category, issuedTo, issuedBy, mrnNum, purchaseSource, notes, itemId, unitPrice, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s(b.issueDate), toISO(b.issueDate), s(b.vehicleMachinery), itemName, itemDesc, qty, category,
             s(b.issuedTo), s(b.issuedBy), s(b.mrnNum), s(b.purchaseSource), s(b.notes), itemId, unitPrice, now, now]
        );
        // Link to a job: explicit pick wins; otherwise auto-match by vehicle + date window.
        let issJobNo = null;
        if (b.jobCardId) issJobNo = setIssueJob(r.lastInsertRowid, b.jobCardId, 'MANUAL');
        else {
            const m = jobcards.findMatch(s(b.vehicleMachinery), toISO(b.issueDate));
            if (m) issJobNo = setIssueJob(r.lastInsertRowid, m.id, 'EXACT');
        }
        res.json({ success: true, id: r.lastInsertRowid, category, jobNo: issJobNo });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/issues/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const b = req.body || {};
        const itemName = s(b.itemName);
        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        const existing = dbApi.get(`SELECT itemId, unitPrice FROM issues WHERE id=?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Issue not found' });
        const itemId = Object.prototype.hasOwnProperty.call(b, 'itemId')
            ? (b.itemId ? parseInt(b.itemId) : null)
            : existing.itemId;
        const qty = Number(b.qty) || 0;
        // Price precedence: an explicit unitPrice in the body wins (including a
        // deliberate clear to null); else re-derive only when resuggestPrice is
        // asked for; otherwise keep the stored price so an unrelated edit can't
        // silently clobber a hand-entered one (review: latent issue-price asymmetry).
        const unitPrice = Object.prototype.hasOwnProperty.call(b, 'unitPrice')
            ? numOrNull(b.unitPrice)
            : (b.resuggestPrice ? suggestIssuePrice(itemName) : (existing.unitPrice != null ? existing.unitPrice : suggestIssuePrice(itemName)));
        const stockErr = checkIssueStock({ itemId, qty, excludeIssueId: id });
        if (stockErr) return res.status(400).json({ error: stockErr });
        dbApi.run(
            `UPDATE issues SET issueDate=?, issueDateISO=?, vehicleMachinery=?, itemName=?, itemDesc=?, qty=?, category=?, issuedTo=?, issuedBy=?, mrnNum=?, purchaseSource=?, notes=?, itemId=?, unitPrice=?, updatedAt=? WHERE id=?`,
            [s(b.issueDate), toISO(b.issueDate), s(b.vehicleMachinery), itemName, itemDesc, qty, category,
             s(b.issuedTo), s(b.issuedBy), s(b.mrnNum), s(b.purchaseSource), s(b.notes), itemId, unitPrice, nowISO(), id]
        );
        res.json({ success: true, category });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/issues/:id', verifyDeletePassword, (req, res) => {
    try {
        dbApi.run(`DELETE FROM issues WHERE id=?`, [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 9. Lookups — vehicles + categories (for dropdowns / chips / advanced search)
// ===========================================================================
app.get('/api/vehicles', (req, res) => {
    try {
        const rows = dbApi.all(`
            SELECT DISTINCT TRIM(vehicleMachinery) AS v FROM items WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
            UNION
            SELECT DISTINCT TRIM(vehicleMachinery) AS v FROM issues WHERE TRIM(COALESCE(vehicleMachinery,'')) != ''
            UNION
            SELECT DISTINCT TRIM(fromLocation) AS v FROM material_transfers WHERE TRIM(COALESCE(fromLocation,'')) != ''
            UNION
            SELECT DISTINCT TRIM(toLocation) AS v FROM material_transfers WHERE TRIM(COALESCE(toLocation,'')) != ''
            ORDER BY v COLLATE NOCASE`);
        res.json(rows.map(r => r.v));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Distinct item/consumable names across MRNs + issues — feeds the searchable
// datalists in the job-card modal (item/part name, consumable name).
app.get('/api/item-names', (req, res) => {
    try {
        const rows = dbApi.all(`
            SELECT DISTINCT TRIM(itemName) AS n FROM items WHERE TRIM(COALESCE(itemName,'')) != ''
            UNION
            SELECT DISTINCT TRIM(itemName) AS n FROM issues WHERE TRIM(COALESCE(itemName,'')) != ''
            ORDER BY n COLLATE NOCASE`);
        res.json({ names: rows.map(r => r.n) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/categories', (req, res) => {
    try {
        const counts = {};
        dbApi.all(`SELECT COALESCE(category,'General Items') AS category, COUNT(*) AS c FROM items GROUP BY COALESCE(category,'General Items')`)
            .forEach(r => { counts[r.category] = r.c; });
        res.json({ categories: CATEGORIES, counts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ===========================================================================
// Battery Registry API Endpoints
// ===========================================================================

app.get('/api/batteries', (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const where = [];
        const params = [];
        if (req.query.search) {
            const like = `%${req.query.search}%`;
            where.push(`(serialNumber LIKE ? OR itemName LIKE ? OR brand LIKE ? OR itemDesc LIKE ? OR currentVehicle LIKE ? OR notes LIKE ?)`);
            params.push(like, like, like, like, like, like);
        }
        if (req.query.condition && req.query.condition !== 'all') {
            if (req.query.condition === 'Expired') {
                where.push(`(condition = 'Expired' OR (expiryDateISO != '' AND expiryDateISO <= ?))`);
                params.push(today);
            } else {
                where.push(`condition = ? AND (expiryDateISO = '' OR expiryDateISO IS NULL OR expiryDateISO > ?)`);
                params.push(req.query.condition, today);
            }
        }
        if (req.query.state && req.query.state !== 'all') {
            where.push(`state = ?`);
            params.push(req.query.state);
        }
        if (req.query.vehicle && req.query.vehicle !== 'all') {
            where.push(`LOWER(TRIM(currentVehicle)) = LOWER(TRIM(?))`);
            params.push(req.query.vehicle);
        }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const sqlParams = [today, ...params];
        const batteries = dbApi.all(`
            SELECT *,
            CASE WHEN condition = 'Expired' OR (expiryDateISO != '' AND expiryDateISO <= ?) THEN 1 ELSE 0 END AS isExpired
            FROM batteries ${clause}
            ORDER BY serialNumber COLLATE NOCASE ASC
        `, sqlParams);
        res.json(batteries);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/battery-stats', (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const stats = dbApi.get(`
            SELECT
                COUNT(CASE WHEN state != 'Disposed' THEN 1 END) AS total,
                COUNT(CASE WHEN condition = 'New' AND state = 'In Store' THEN 1 END) AS newInStore,
                COUNT(CASE WHEN condition = 'Old' AND state = 'In Store' THEN 1 END) AS oldInStore,
                COUNT(CASE WHEN condition = 'Expired' OR (expiryDateISO != '' AND expiryDateISO <= ?) THEN 1 END) AS expired,
                COUNT(CASE WHEN state = 'Installed' THEN 1 END) AS installed
            FROM batteries
        `, [today]);
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/batteries/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const battery = dbApi.get(`SELECT * FROM batteries WHERE id = ?`, [id]);
        if (!battery) return res.status(404).json({ error: 'Battery not found' });
        const movements = dbApi.all(`SELECT * FROM battery_movements WHERE batteryId = ? ORDER BY movementDateISO DESC, id DESC`, [id]);
        battery.movements = movements;
        res.json(battery);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/batteries', (req, res) => {
    try {
        const b = req.body || {};
        const serialNumber = s(b.serialNumber).trim();
        if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

        const itemName = s(b.itemName || 'Battery');
        const itemDesc = s(b.itemDesc);
        const brand = s(b.brand);
        const condition = s(b.condition || 'New'); // New, Old, Expired
        const state = s(b.state || 'In Store'); // In Store, Installed, Disposed
        const currentVehicle = state === 'Installed' ? s(b.currentVehicle) : '';
        const purchaseDate = s(b.purchaseDate);
        const expiryDate = s(b.expiryDate);
        const notes = s(b.notes);
        const now = nowISO();

        const id = dbApi.transaction(() => {
            const exists = dbApi.get(`SELECT id FROM batteries WHERE UPPER(TRIM(serialNumber)) = UPPER(?)`, [serialNumber]);
            if (exists) throw { status: 409, message: `Battery with Serial Number "${serialNumber}" already registered.` };

            const batteryResult = dbApi.run(
                `INSERT INTO batteries (serialNumber, itemName, brand, itemDesc, condition, state, currentVehicle, purchaseDate, purchaseDateISO, expiryDate, expiryDateISO, notes, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [serialNumber, itemName, brand, itemDesc, condition, state, currentVehicle, purchaseDate, toISO(purchaseDate), expiryDate, toISO(expiryDate), notes, now, now]
            );
            const batteryId = batteryResult.lastInsertRowid;

            const toLoc = state === 'Installed' ? currentVehicle : state;
            dbApi.run(
                `INSERT INTO battery_movements (batteryId, serialNumber, movementType, movementDate, movementDateISO, fromLocation, toLocation, conditionAfter, notes, createdAt)
                 VALUES (?, ?, 'Register', ?, ?, 'Unknown', ?, ?, ?, ?)`,
                [batteryId, serialNumber, purchaseDate || now.split('T')[0], toISO(purchaseDate || now.split('T')[0]), toLoc, condition, 'Initial registration. ' + notes, now]
            );
            return batteryId;
        });

        res.json({ success: true, id });
    } catch (e) {
        if (e.status) {
            res.status(e.status).json({ error: e.message });
        } else {
            res.status(500).json({ error: e.message });
        }
    }
});

app.post('/api/batteries/move', (req, res) => {
    try {
        const b = req.body || {};
        const batteryId = parseInt(b.batteryId);
        const movementType = s(b.movementType); // Register, Issue, Return, Transfer, Dispose, Update
        const movementDate = s(b.movementDate);
        const conditionAfter = b.conditionAfter ? s(b.conditionAfter) : null;
        const notes = s(b.notes);
        const now = nowISO();

        if (!batteryId || !movementType || !movementDate) {
            return res.status(400).json({ error: 'Missing required movement details (batteryId, movementType, movementDate)' });
        }

        dbApi.transaction(() => {
            const battery = dbApi.get(`SELECT * FROM batteries WHERE id = ?`, [batteryId]);
            if (!battery) throw new Error('Battery not found');

            const fromLocation = battery.state === 'Installed' ? battery.currentVehicle : (battery.state === 'In Store' ? 'Store' : battery.state);
            let toLocation = 'Store';
            let newState = 'In Store';
            let newVehicle = '';

            if (movementType === 'Issue' || movementType === 'Transfer') {
                if (!b.toVehicle) throw new Error('Target vehicle is required for issue/transfer.');
                toLocation = s(b.toVehicle).trim();
                newState = 'Installed';
                newVehicle = toLocation;
            } else if (movementType === 'Dispose') {
                toLocation = 'Disposed';
                newState = 'Disposed';
            } else if (movementType === 'Return') {
                toLocation = 'Store';
                newState = 'In Store';
            } else if (movementType === 'Update') {
                toLocation = fromLocation;
                newState = battery.state;
                newVehicle = battery.currentVehicle;
            }

            const cond = conditionAfter || battery.condition;

            // 1. Update the battery state, vehicle, condition and notes
            dbApi.run(
                `UPDATE batteries
                 SET state=?, currentVehicle=?, condition=?, notes=CASE WHEN ? != '' THEN notes || ' | ' || ? ELSE notes END, updatedAt=?
                 WHERE id=?`,
                [newState, newVehicle, cond, notes, notes, now, batteryId]
            );

            // 2. Insert movement log
            dbApi.run(
                `INSERT INTO battery_movements (batteryId, serialNumber, movementType, movementDate, movementDateISO, fromLocation, toLocation, conditionAfter, issuedBy, mrnNum, notes, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [batteryId, battery.serialNumber, movementType, movementDate, toISO(movementDate), fromLocation, toLocation, cond, s(b.issuedBy), s(b.mrnNum), notes, now]
            );

            // 3. Handle replaced old battery swap, if provided
            if (b.replaced && b.replaced.serialNumber && b.replaced.serialNumber.trim()) {
                const repSerial = b.replaced.serialNumber.trim();
                const repItemName = b.replaced.itemName || 'Battery';
                const repBrand = b.replaced.brand || '';
                const repItemDesc = b.replaced.itemDesc || '';
                const repNotes = b.replaced.notes || '';
                const swapNotes = `Returned via swap replaced by battery ${battery.serialNumber} on vehicle ${fromLocation}. ${repNotes}`.trim();

                const existingRep = dbApi.get(`SELECT id, notes FROM batteries WHERE UPPER(TRIM(serialNumber)) = UPPER(?)`, [repSerial]);
                if (existingRep) {
                    const repId = existingRep.id;
                    dbApi.run(
                        `UPDATE batteries
                         SET state='In Store', currentVehicle='', condition='Old', notes=notes || ' | ' || ?, updatedAt=?
                         WHERE id=?`,
                        [swapNotes, now, repId]
                    );
                    dbApi.run(
                        `INSERT INTO battery_movements (batteryId, serialNumber, movementType, movementDate, movementDateISO, fromLocation, toLocation, conditionAfter, issuedBy, mrnNum, notes, createdAt)
                         VALUES (?, ?, 'Return', ?, ?, ?, 'Store', 'Old', ?, ?, ?, ?)`,
                        [repId, repSerial, movementDate, toISO(movementDate), fromLocation, s(b.issuedBy), s(b.mrnNum), swapNotes, now]
                    );
                } else {
                    const insertResult = dbApi.run(
                        `INSERT INTO batteries (serialNumber, itemName, brand, itemDesc, condition, state, currentVehicle, notes, createdAt, updatedAt)
                         VALUES (?, ?, ?, ?, 'Old', 'In Store', '', ?, ?, ?)`,
                        [repSerial, repItemName, repBrand, repItemDesc, swapNotes, now, now]
                    );
                    const repId = insertResult.lastInsertRowid;
                    dbApi.run(
                        `INSERT INTO battery_movements (batteryId, serialNumber, movementType, movementDate, movementDateISO, fromLocation, toLocation, conditionAfter, issuedBy, mrnNum, notes, createdAt)
                         VALUES (?, ?, 'Register', ?, ?, 'Unknown', 'Store', 'Old', ?, ?, ?, ?)`,
                        [repId, repSerial, movementDate, toISO(movementDate), s(b.issuedBy), s(b.mrnNum), `Registered old battery via swap. ${swapNotes}`, now]
                    );
                    dbApi.run(
                        `INSERT INTO battery_movements (batteryId, serialNumber, movementType, movementDate, movementDateISO, fromLocation, toLocation, conditionAfter, issuedBy, mrnNum, notes, createdAt)
                         VALUES (?, ?, 'Return', ?, ?, ?, 'Store', 'Old', ?, ?, ?, ?)`,
                        [repId, repSerial, movementDate, toISO(movementDate), fromLocation, s(b.issuedBy), s(b.mrnNum), swapNotes, now]
                    );
                }
            }
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/batteries/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const b = req.body || {};
        const serialNumber = s(b.serialNumber).trim();
        if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

        const exists = dbApi.get(`SELECT id FROM batteries WHERE UPPER(TRIM(serialNumber)) = UPPER(?) AND id != ?`, [serialNumber, id]);
        if (exists) return res.status(409).json({ error: `Battery with Serial Number "${serialNumber}" already registered.` });

        const now = nowISO();
        dbApi.run(
            `UPDATE batteries SET serialNumber=?, itemName=?, brand=?, itemDesc=?, condition=?, state=?, currentVehicle=?, purchaseDate=?, purchaseDateISO=?, expiryDate=?, expiryDateISO=?, notes=?, updatedAt=? WHERE id=?`,
            [serialNumber, s(b.itemName), s(b.brand), s(b.itemDesc), s(b.condition), s(b.state), s(b.currentVehicle), s(b.purchaseDate), toISO(b.purchaseDate), s(b.expiryDate), toISO(b.expiryDate), s(b.notes), now, id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/batteries/:id', verifyDeletePassword, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        dbApi.transaction(() => {
            dbApi.run(`DELETE FROM battery_movements WHERE batteryId = ?`, [id]);
            dbApi.run(`DELETE FROM batteries WHERE id = ?`, [id]);
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ===========================================================================
// Material Transfer API Endpoints
// ===========================================================================

app.get('/api/transfers', (req, res) => {
    try {
        const page = parseInt(req.query.page) || null;
        const limit = parseInt(req.query.limit) || null;
        const where = [];
        const params = [];

        if (req.query.search) {
            const like = `%${req.query.search}%`;
            where.push(`(mtnNum LIKE ? OR itemName LIKE ? OR itemDesc LIKE ? OR fromLocation LIKE ? OR toLocation LIKE ? OR transferredBy LIKE ? OR receivedBy LIKE ? OR notes LIKE ?)`);
            params.push(like, like, like, like, like, like, like, like);
        }
        if (req.query.from && req.query.from !== 'all') {
            where.push(`fromLocation = ?`);
            params.push(req.query.from);
        }
        if (req.query.to && req.query.to !== 'all') {
            where.push(`toLocation = ?`);
            params.push(req.query.to);
        }
        const startISO = req.query.startDate ? toISO(req.query.startDate) : '';
        const endISO = req.query.endDate ? toISO(req.query.endDate) : '';
        if (startISO) { where.push(`transferDateISO >= ? AND transferDateISO != ''`); params.push(startISO); }
        if (endISO) { where.push(`transferDateISO <= ? AND transferDateISO != ''`); params.push(endISO); }

        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        if (!page || !limit) {
            const rows = dbApi.all(`SELECT * FROM material_transfers ${clause} ORDER BY transferDateISO DESC, id DESC`, params);
            return res.json(rows);
        }

        const skip = (page - 1) * limit;
        const total = dbApi.get(`SELECT COUNT(*) AS c FROM material_transfers ${clause}`, params).c;
        const items = dbApi.all(
            `SELECT * FROM material_transfers ${clause} ORDER BY transferDateISO DESC, id DESC LIMIT ? OFFSET ?`,
            [...params, limit, skip]
        );

        res.json({ items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/transfer-stats', (req, res) => {
    try {
        const startOfMonth = new Date().toISOString().substring(0, 7) + '-01';
        const stats = dbApi.get(`
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(qty), 0) AS totalQty,
                COUNT(CASE WHEN transferDateISO >= ? THEN 1 END) AS thisMonth
            FROM material_transfers
        `, [startOfMonth]);
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/transfers/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const transfer = dbApi.get(`SELECT * FROM material_transfers WHERE id = ?`, [id]);
        if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
        res.json(transfer);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/transfers', (req, res) => {
    try {
        const b = req.body || {};
        const mtnNum = s(b.mtnNum).trim();
        if (!mtnNum) return res.status(400).json({ error: 'MTN number is required' });
        const itemName = s(b.itemName).trim();
        if (!itemName) return res.status(400).json({ error: 'Item name is required' });

        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        const now = nowISO();

        const r = dbApi.run(
            `INSERT INTO material_transfers (transferDate, transferDateISO, mtnNum, itemName, itemDesc, qty, category, fromLocation, toLocation, transferredBy, receivedBy, mrnNum, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s(b.transferDate), toISO(b.transferDate), mtnNum, itemName, itemDesc, Number(b.qty) || 0, category, s(b.fromLocation), s(b.toLocation), s(b.transferredBy), s(b.receivedBy), s(b.mrnNum), s(b.notes), now, now]
        );
        res.json({ success: true, id: r.lastInsertRowid, category });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/transfers/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const b = req.body || {};
        const mtnNum = s(b.mtnNum).trim();
        if (!mtnNum) return res.status(400).json({ error: 'MTN number is required' });
        const itemName = s(b.itemName).trim();
        if (!itemName) return res.status(400).json({ error: 'Item name is required' });

        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);

        dbApi.run(
            `UPDATE material_transfers SET transferDate=?, transferDateISO=?, mtnNum=?, itemName=?, itemDesc=?, qty=?, category=?, fromLocation=?, toLocation=?, transferredBy=?, receivedBy=?, mrnNum=?, notes=?, updatedAt=? WHERE id=?`,
            [s(b.transferDate), toISO(b.transferDate), mtnNum, itemName, itemDesc, Number(b.qty) || 0, category, s(b.fromLocation), s(b.toLocation), s(b.transferredBy), s(b.receivedBy), s(b.mrnNum), s(b.notes), nowISO(), id]
        );
        res.json({ success: true, category });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/transfers/:id', verifyDeletePassword, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        dbApi.run(`DELETE FROM material_transfers WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 10. Bulk import (items + receipts), parameterized + transactional
// ===========================================================================
app.post('/api/import', (req, res) => {
    try {
        const data = req.body;
        if (!Array.isArray(data)) return res.status(400).json({ error: 'Data must be an array of items' });
        const now = nowISO();
        const insItem = `INSERT INTO items (mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, requestSource, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
        const insRec = `INSERT INTO receipts (itemId, qty, transactionType, deliveryDate, deliveryDateISO, purchaseSource, grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
        dbApi.transaction(() => {
            for (const it of data) {
                const itemName = s(it.itemName || it.name);
                const itemDesc = s(it.itemDesc);
                const category = it.category && String(it.category).trim() ? String(it.category).trim() : classify(itemName, itemDesc);
                const r = dbApi.run(insItem, [s(it.mrnNum), s(it.reqDate), toISO(it.reqDate), s(it.vehicleMachinery), itemName, itemDesc, Number(it.reqQty) || 0, category, normRequestSource(it.requestSource), now, now]);
                const itemId = r.lastInsertRowid;
                for (const rc of (it.receipts || [])) {
                    dbApi.run(insRec, [itemId, Number(rc.qty) || 0, s(rc.transactionType || rc.type || 'Receive'), s(rc.deliveryDate || rc.date), toISO(rc.deliveryDate || rc.date),
                        canonicalPurchaseSource(rc.purchaseSource || rc.source), s(rc.grnNumber), s(rc.invoiceNumber), s(rc.invoiceDate), s(rc.supplierName), numOrNull(rc.unitPrice)]);
                }
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 11. Excel export — Requests/Deliveries + Financial Summary + Issues sheet
// ===========================================================================
app.get('/api/export/excel', (req, res) => {
    try {
        const items = dbApi.all(`SELECT * FROM items`);
        const receipts = dbApi.all(`SELECT * FROM receipts`);
        const issues = dbApi.all(`SELECT * FROM issues ORDER BY issueDateISO DESC`);
        const batteries = dbApi.all(`SELECT * FROM batteries ORDER BY serialNumber COLLATE NOCASE ASC`);
        const batteryMovements = dbApi.all(`SELECT bm.*, b.serialNumber, b.itemName FROM battery_movements bm JOIN batteries b ON bm.batteryId = b.id ORDER BY bm.movementDateISO DESC, bm.id DESC`);
        const transfers = dbApi.all(`SELECT * FROM material_transfers ORDER BY transferDateISO DESC, id DESC`);

        const byItem = {};
        for (const r of receipts) (byItem[r.itemId] = byItem[r.itemId] || []).push(r);

        const wb = XLSX.utils.book_new();
        const itemsSheet = [[
            'MRN Number', 'Request Date', 'Category', 'Vehicle/Machinery', 'Item Name', 'Item Description',
            'Requested Qty', 'Received Qty', 'Receive Date', 'Purchase Source', 'Qty Gap', 'Status',
            'GRN Number', 'Invoice Number', 'Invoice Date', 'Supplier Name', 'Unit Price (Rs.)', 'Total Price (Rs.)'
        ]];

        const supplierSpend = {};
        let totalSpend = 0, pricedCount = 0, unpricedCount = 0;
        const activeSuppliers = new Set();

        for (const item of items) {
            const recs = byItem[item.id] || [];
            const recQty = Math.round(recs.reduce((sum, r) => sum + (r.qty || 0), 0) * 100) / 100;
            let recDate = '';
            if (recs.length) recDate = [...recs].sort((a, b) => s(b.deliveryDateISO).localeCompare(s(a.deliveryDateISO)))[0].deliveryDate;
            const uniqueSources = [...new Set(recs.map(r => r.purchaseSource).filter(Boolean))].join(' & ');
            const qtyGap = Math.round((item.reqQty - recQty) * 100) / 100;
            let status = 'Pending';
            if (recQty > 0) status = recQty < item.reqQty ? 'Partial' : (recQty === item.reqQty ? 'Complete' : 'Over-received');

            const grns = [...new Set(recs.map(r => r.grnNumber).filter(Boolean))].join('; ');
            const invoices = [...new Set(recs.map(r => r.invoiceNumber).filter(Boolean))].join('; ');
            const invoiceDates = [...new Set(recs.map(r => r.invoiceDate).filter(Boolean))].filter(d => d && d !== '1899-12-30').join('; ');
            const suppliers = [...new Set(recs.map(r => r.supplierName).filter(Boolean))].join('; ');

            const priced = recs.filter(r => r.unitPrice);
            let totalUnitPrice = '', totalPrice = 0;
            if (priced.length) {
                totalUnitPrice = priced.map(r => r.unitPrice).join('; ');
                totalPrice = recs.reduce((sum, r) => {
                    if (r.unitPrice && r.qty > 0) {
                        const cost = Math.abs(r.qty) * r.unitPrice;
                        totalSpend += cost;
                        const sup = r.supplierName || 'Unknown Supplier';
                        supplierSpend[sup] = (supplierSpend[sup] || 0) + cost;
                        activeSuppliers.add(sup);
                        return sum + cost;
                    }
                    return sum;
                }, 0);
                totalPrice = Math.round(totalPrice * 100) / 100;
            }
            if (recQty > 0) (priced.length ? pricedCount++ : unpricedCount++);

            itemsSheet.push([item.mrnNum || '', item.reqDate || '', item.category || 'General Items', item.vehicleMachinery || '',
                item.itemName || '', item.itemDesc || '', item.reqQty || 0, recQty, recDate, uniqueSources, qtyGap, status,
                grns, invoices, invoiceDates, suppliers, totalUnitPrice, totalPrice || '']);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(itemsSheet), 'Requests & Deliveries');

        // Financial summary
        const summary = [['Supplier Name', 'Total Spend (Rs.)', 'Spend Share (%)']];
        Object.entries(supplierSpend).sort((a, b) => b[1] - a[1]).forEach(([name, amount]) => {
            const pct = totalSpend > 0 ? ((amount / totalSpend) * 100).toFixed(1) : 0;
            summary.push([name, amount, `${pct}%`]);
        });
        if (Object.keys(supplierSpend).length) {
            summary.push([''], ['TOTAL SPEND', totalSpend, '100.0%'], ['ACTIVE SUPPLIERS', activeSuppliers.size, ''],
                ['PRICED DELIVERIES', pricedCount, ''], ['UNPRICED DELIVERIES', unpricedCount, '']);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Financial Summary');

        // Issues sheet
        const issuesSheet = [['Issue Date', 'Category', 'Vehicle/Machinery', 'Item Name', 'Item Description', 'Qty', 'Issued To', 'Issued By', 'MRN Ref', 'Source', 'Notes']];
        for (const is of issues) {
            issuesSheet.push([is.issueDate || '', is.category || '', is.vehicleMachinery || '', is.itemName || '', is.itemDesc || '',
                is.qty || 0, is.issuedTo || '', is.issuedBy || '', is.mrnNum || '', is.purchaseSource || '', is.notes || '']);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(issuesSheet), 'Issued Items');

        // Batteries Registry sheet
        const batteriesSheet = [['Serial Number', 'Specs/Model', 'Brand', 'Condition', 'State', 'Current Vehicle/Location', 'Purchase Date', 'Expiry Date', 'Notes', 'Created At', 'Last Updated']];
        for (const bat of batteries) {
            batteriesSheet.push([
                bat.serialNumber || '',
                bat.itemName || '',
                bat.brand || '',
                bat.condition || '',
                bat.state || '',
                bat.state === 'Installed' ? (bat.currentVehicle || '') : bat.state,
                bat.purchaseDate || '',
                bat.expiryDate || '',
                bat.notes || '',
                bat.createdAt || '',
                bat.updatedAt || ''
            ]);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(batteriesSheet), 'Battery Registry');

        // Battery Movements sheet
        const batteryMovementsSheet = [['Date', 'Serial Number', 'Specs/Model', 'Movement Type', 'From Location', 'To Location', 'Condition After', 'Issued By', 'MRN Ref', 'Notes', 'Log Timestamp']];
        for (const mov of batteryMovements) {
            batteryMovementsSheet.push([
                mov.movementDate || '',
                mov.serialNumber || '',
                mov.itemName || '',
                mov.movementType || '',
                mov.fromLocation || '',
                mov.toLocation || '',
                mov.conditionAfter || '',
                mov.issuedBy || '',
                mov.mrnNum || '',
                mov.notes || '',
                mov.createdAt || ''
            ]);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(batteryMovementsSheet), 'Battery Movement Logs');
 
        // Material Transfers sheet
        const transfersSheet = [['Transfer Date', 'MTN Number', 'Category', 'Item Name', 'Item Description', 'Qty', 'From Location', 'To Location', 'Transferred By', 'Received By', 'MRN Ref', 'Notes', 'Logged At']];
        for (const tr of transfers) {
            transfersSheet.push([
                tr.transferDate || '',
                tr.mtnNum || '',
                tr.category || '',
                tr.itemName || '',
                tr.itemDesc || '',
                tr.qty || 0,
                tr.fromLocation || '',
                tr.toLocation || '',
                tr.transferredBy || '',
                tr.receivedBy || '',
                tr.mrnNum || '',
                tr.notes || '',
                tr.createdAt || ''
            ]);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(transfersSheet), 'Material Transfers');

        // --- Job Cards sheet (labour + parts + issues + recorded + total) ---
        // Same rollup as list()/get()/jobKpis so the export reconciles with the
        // dashboard and the per-job cockpit (findings 6-8).
        const jobRows = dbApi.all(`SELECT j.*,
            COALESCE(p.c,0) AS receivedPartsCost, COALESCE(s.c,0) AS issuesCost
            FROM jobcards j
            LEFT JOIN (SELECT i.jobCardId AS jid, ${costing.RECEIVED_PARTS_SUM} AS c
                       FROM items i JOIN receipts r ON r.itemId=i.id GROUP BY i.jobCardId) p ON p.jid=j.id
            LEFT JOIN (SELECT s.jobCardId AS jid, ${costing.ISSUES_SUM} AS c
                       FROM issues s GROUP BY s.jobCardId) s ON s.jid=j.id
            ORDER BY j.id DESC`);
        const jobSheet = [['Job No', 'Type', 'Status', 'Date', 'Vehicle/Machinery', 'Project', 'Repair Type', 'Driver', 'Labour (Rs.)', 'Received Parts (Rs.)', 'Issued Parts (Rs.)', 'Recorded Service (Rs.)', 'Total Job Cost (Rs.)', 'Details']];
        for (const jc of jobRows) {
            const received = costing.round2(jc.receivedPartsCost || 0);
            const issued = costing.round2(jc.issuesCost || 0);
            const recorded = (jc.recordedCost != null && jc.recordedCost > 0) ? costing.round2(jc.recordedCost) : 0;
            jobSheet.push([jc.jobNo || '', jc.type || '', jc.status || '', jc.dateISO || jc.date || '', jc.vehicleMachinery || '', jc.projectName || '', jc.repairType || '', jc.driverName || '', jc.labourCost || 0, received, issued, recorded, costing.jobTotal(jc), jc.details || '']);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(jobSheet), 'Job Cards');

        // --- Daily Programme sheet ---
        const dpRows = dbApi.all(`SELECT dp.*, j.jobNo AS jobNo FROM daily_programme dp LEFT JOIN jobcards j ON j.id=dp.jobCardId ORDER BY dp.entryDateISO DESC, dp.id DESC`);
        const dpSheet = [['Date', 'Job No', 'Vehicle/Machinery', 'Work Done', 'Mechanics', 'Hours', 'Labour (Rs.)', 'Outside Value (Rs.)', 'Remarks']];
        for (const e of dpRows) {
            dpSheet.push([e.entryDateISO || e.entryDate || '', e.jobNo || '', e.vehicleMachinery || '', e.workDescription || '', e.mechanics || '', e.hours || 0, e.labourCost || 0, e.outsideValue || 0, e.remarks || '']);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dpSheet), 'Daily Programme');

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="inventory_report.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// 12. Heuristic PDF parser (unchanged) — pre-fills receiving form from invoices
// ===========================================================================
function parsePdfTextHeuristically(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let mrnNum = '', reqDate = new Date().toISOString().split('T')[0], vehicleMachinery = '';
    let itemName = '', itemDesc = '', reqQty = 1, supplierName = '', invoiceNumber = '', unitPrice = null, grnNumber = '';

    const mrnMatch = text.match(/(?:mrn|requisition|req)(?:\s*number|\s*no\.?)?[\s:-]*([a-z0-9-]+)/i);
    if (mrnMatch) mrnNum = mrnMatch[1].trim().toUpperCase();
    else { const m = text.match(/\b(mrn-[0-9a-z-]+)\b/i); if (m) mrnNum = m[1].toUpperCase(); }

    const dateMatch = text.match(/\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/);
    if (dateMatch) { const d = new Date(dateMatch[1]); if (!isNaN(d.getTime())) reqDate = d.toISOString().split('T')[0]; }

    const vehicleMatch = text.match(/(?:vehicle|machinery|unit|fleet|eq|equip)(?:\s*number|\s*no\.?)?[\s:-]+([^\n,]+)/i);
    if (vehicleMatch) vehicleMachinery = vehicleMatch[1].trim();
    else {
        const keywords = ['excavator', 'truck', 'car', 'dumper', 'digger', 'loader', 'tractor', 'generator', 'roller', 'forklift'];
        for (const line of lines) { if (keywords.some(k => line.toLowerCase().includes(k))) { vehicleMachinery = line; break; } }
    }

    const supplierMatch = text.match(/(?:supplier|vendor|invoice\s+from|billed\s+by)(?:\s*name)?[\s:-]+([^\n,]+)/i);
    if (supplierMatch) supplierName = supplierMatch[1].trim();
    const invoiceMatch = text.match(/(?:invoice|inv)(?:\s*number|\s*no\.?)?[\s:-]+([a-z0-9-]+)/i);
    if (invoiceMatch) invoiceNumber = invoiceMatch[1].trim().toUpperCase();
    const grnMatch = text.match(/(?:grn|goods\s+received\s+note|receipt)(?:\s*number|\s*no\.?)?[\s:-]+([a-z0-9-]+)/i);
    if (grnMatch) grnNumber = grnMatch[1].trim().toUpperCase();

    const itemCandidates = [];
    for (const line of lines) {
        const ll = line.toLowerCase();
        if (ll.includes('monitor') || ll.includes('tracker') || ll.includes('requisition') || ll.includes('report') || ll.includes('invoice')) continue;
        const match = line.match(/\b(\d+(?:\.\d+)?)\s*(?:x|pcs|units|qty|qty:)?\s+([a-zA-Z\s\-]{3,40})\b/i);
        if (match && !ll.includes('date') && !ll.includes('phone') && !ll.includes('total') && !ll.includes('no')) {
            const qtyVal = parseFloat(match[1]); const nameVal = match[2].trim();
            if (qtyVal > 0 && nameVal.length > 3) itemCandidates.push({ name: nameVal, qty: qtyVal, desc: line });
        }
    }
    if (itemCandidates.length) { itemName = itemCandidates[0].name; reqQty = itemCandidates[0].qty; itemDesc = itemCandidates[0].desc; }
    else { const dm = text.match(/\b(\d+(?:\.\d+)?)\b/); if (dm) reqQty = parseFloat(dm[1]); itemName = 'Unparsed Item'; itemDesc = text.substring(0, 120).replace(/\r?\n/g, ' ') + '...'; }

    const priceMatch = text.match(/(?:unit\s*price|rate|price|cost|amount)[\s:-]+(?:rs\.?|usd\.?)?\s*(\d+(?:\.\d+)?)/i);
    if (priceMatch) unitPrice = parseFloat(priceMatch[1]);

    return { mrnNum, reqDate, vehicleMachinery, itemName, itemDesc, reqQty, supplierName, invoiceNumber, unitPrice, grnNumber };
}

app.post('/api/import/pdf', async (req, res) => {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'Missing pdfBase64 content' });
    let parser;
    try {
        parser = new PDFParse({ data: Buffer.from(pdfBase64, 'base64') });
        const data = await parser.getText();
        res.json({ success: true, text: data.text, data: parsePdfTextHeuristically(data.text) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to parse PDF file: ' + e.message });
    } finally {
        if (parser) {
            try {
                await parser.destroy();
            } catch (_) {}
        }
    }
});

// Centralized error handler — the safety net for any throw that escapes a
// route (Express routes sync throws here). Expected AppErrors show their
// message + status; everything else is a logged 500 with a generic body so
// internal detail / stack traces never reach the client.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err && err.status) || 500;
    if (status >= 500) console.error(`[ERR] ${req.method} ${req.originalUrl}:`, (err && err.stack) || err);
    res.status(status).json({ error: (err && err.expose && err.message) ? err.message : 'Internal server error.' });
});

// --- start + lightweight single-file backups -------------------------------
// Standalone: `node server.js` listens on its own port. Embedded (the unified
// E&C server requires this file as a module): no listen here — the host server
// mounts `app` and owns the socket. Backups below run in both modes.
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Inventory Monitor running at http://localhost:${PORT}/item_tracker.html  (engine: ${dbApi.ENGINE})`);
        const nets = os.networkInterfaces();
        for (const name in nets) for (const iface of nets[name]) {
            if (iface.family === 'IPv4' && !iface.internal) console.log(`  Network: http://${iface.address}:${PORT}`);
        }
    });
}

module.exports = app;

// --- Automatic backups: async (non-blocking) + tiered retention ------------
// db.backup() is a consistent online copy that never freezes the event loop the
// way copyFileSync did (review finding 19). Retention keeps recent granularity
// without unbounded growth: every backup for 24 h, then one per day for 30 days.
// Restore: stop the server, copy the chosen backups/inventory_backup_*.db over
// inventory.db (delete any -wal/-shm sidecars first), restart. See docs/BACKUP_RESTORE.md.
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL = config.BACKUP_INTERVAL_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
function pruneBackups() {
    const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('inventory_backup_') && f.endsWith('.db'))
        .map((f) => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.m - a.m);
    const now = Date.now();
    const keptDays = new Set();
    for (const { f, m } of files) {
        const age = now - m;
        if (age <= config.BACKUP_KEEP_ALL_MS) continue;   // keep everything < 24 h old
        if (age > config.BACKUP_KEEP_DAILY_DAYS * DAY_MS) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {} continue; }
        const dayKey = Math.floor(m / DAY_MS);            // one per calendar day beyond 24 h
        if (keptDays.has(dayKey)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {} }
        else keptDays.add(dayKey);
    }
}
function runAutomaticBackup() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        if (!fs.existsSync(dbApi.DB_FILE)) return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(BACKUP_DIR, `inventory_backup_${ts}.db`);
        Promise.resolve(dbApi.backup(dest))
            .then(() => { try { pruneBackups(); } catch (_) {} })
            .catch((e) => console.error('[BACKUP] failed:', e.message));
    } catch (e) {
        console.error('[BACKUP] failed:', e.message);
    }
}
setInterval(runAutomaticBackup, BACKUP_INTERVAL);
setTimeout(runAutomaticBackup, 10000);
