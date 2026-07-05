'use strict';

/**
 * jobrequests.js — Operations "job request" workflow.
 *
 * A job request is raised by Transport, approved by the Transport Manager, then
 * the Operational Manager; once fully approved a linked Workshop job card is
 * opened for costing. On completion the Transport Officer, Transport Manager and
 * Operational Manager are notified. Outsourced ("outside") requests e-mail the
 * selected parties on final approval.
 *
 * Kept separate from the workshop `jobcards` (different lifecycle) — this engine
 * only drives the operations approval flow. Adapted from the state-machine idea
 * in Job-Card-System/src/{domain,jobcards}.js onto SQLite.
 */

const db = require('./db');
const auth = require('./auth');
const notifications = require('./notifications');
const jobcards = require('./jobcards');
const R = auth.ROLES;

const nowISO = () => new Date().toISOString();
const s = (v) => (v === null || v === undefined) ? '' : String(v).trim();

const STATUSES = ['DRAFT', 'PENDING_TM', 'PENDING_OM', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'REJECTED'];
const STATUS_LABELS = {
    DRAFT: 'Draft', PENDING_TM: 'Pending Transport Manager', PENDING_OM: 'Pending Operational Manager',
    APPROVED: 'Approved', IN_PROGRESS: 'In Progress', COMPLETED: 'Completed', CLOSED: 'Closed', REJECTED: 'Rejected',
};

// Transition table: status -> [{action,label,to,roles,needNote,effect}]
const TRANSITIONS = {
    DRAFT: [
        { action: 'submit', label: 'Submit for approval', to: 'PENDING_TM', roles: [R.TRANSPORT_OFFICER, R.ADMIN], effect: 'submit' },
    ],
    PENDING_TM: [
        { action: 'tmApprove', label: 'Approve (Transport Manager)', to: 'PENDING_OM', roles: [R.TRANSPORT_MANAGER, R.ADMIN], effect: 'tmApprove' },
        { action: 'tmReject', label: 'Reject', to: 'REJECTED', roles: [R.TRANSPORT_MANAGER, R.ADMIN], needNote: true, effect: 'reject' },
    ],
    PENDING_OM: [
        { action: 'omApprove', label: 'Approve (Operational Manager)', to: 'APPROVED', roles: [R.OPERATIONAL_MANAGER, R.ADMIN], effect: 'omApprove' },
        { action: 'omReject', label: 'Reject', to: 'REJECTED', roles: [R.OPERATIONAL_MANAGER, R.ADMIN], needNote: true, effect: 'reject' },
    ],
    APPROVED: [
        { action: 'start', label: 'Start work', to: 'IN_PROGRESS', roles: [R.TRANSPORT_OFFICER, R.TRANSPORT_MANAGER, R.ADMIN] },
        { action: 'resendEmail', label: 'Resend vendor e-mail', to: 'APPROVED', roles: [R.TRANSPORT_OFFICER, R.TRANSPORT_MANAGER, R.OPERATIONAL_MANAGER, R.ADMIN], effect: 'resendEmail' },
    ],
    IN_PROGRESS: [
        { action: 'complete', label: 'Mark completed', to: 'COMPLETED', roles: [R.TRANSPORT_OFFICER, R.TRANSPORT_MANAGER, R.OPERATIONAL_MANAGER, R.ADMIN], effect: 'complete' },
    ],
    COMPLETED: [
        { action: 'close', label: 'Close', to: 'CLOSED', roles: [R.OPERATIONAL_MANAGER, R.ADMIN] },
    ],
    REJECTED: [
        { action: 'reopen', label: 'Reopen as draft', to: 'DRAFT', roles: [R.TRANSPORT_OFFICER, R.ADMIN] },
    ],
};

const CREATE_ROLES = [R.TRANSPORT_OFFICER, R.ADMIN];
const canCreate = (user) => !!user && user.roles.some((r) => CREATE_ROLES.includes(r));
const hasAnyRole = (user, roles) => !!user && user.roles.some((r) => roles.includes(r));

function genReqNo() {
    const year = new Date().getFullYear();
    const row = db.get(`SELECT reqNo FROM job_requests WHERE reqNo LIKE ? ORDER BY id DESC`, [`JR-${year}-%`]);
    let n = 0;
    if (row && row.reqNo) { const m = String(row.reqNo).match(/(\d+)$/); if (m) n = parseInt(m[1], 10); }
    return `JR-${year}-${String(n + 1).padStart(4, '0')}`;
}

function audit(requestId, user, action, fromStatus, toStatus, note) {
    db.run(
        `INSERT INTO job_request_audits (requestId, userId, userName, action, fromStatus, toStatus, note, at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [requestId, user ? user.id : null, user ? (user.name || user.username) : 'system', action, fromStatus, toStatus, s(note), nowISO()]
    );
}

function rowFromForm(form) {
    return {
        type: form.type === 'OUTSOURCED' ? 'OUTSOURCED' : 'INTERNAL',
        title: s(form.title),
        details: s(form.details),
        vehicleMachinery: s(form.vehicleMachinery),
        ecdNo: s(form.ecdNo),
        projectName: s(form.projectName),
        site: s(form.site),
        priority: (s(form.priority).toLowerCase() === 'urgent') ? 'Urgent' : 'Normal',
        neededBy: s(form.neededBy),
        neededByISO: db.toISO(form.neededBy),
        vendorName: s(form.vendorName),
        vendorEmail: s(form.vendorEmail),
        emailRecipients: JSON.stringify(Array.isArray(form.emailRecipients)
            ? form.emailRecipients.map((x) => s(x)).filter(Boolean) : []),
    };
}

/** Create a request. If form.submit is truthy, immediately submit for approval. */
function create(form, user) {
    if (!canCreate(user)) return { error: 'Only a Transport Officer can raise a job request.', status: 403 };
    const f = rowFromForm(form);
    if (!f.title && !f.details) return { error: 'A title or details are required.', status: 400 };
    const now = nowISO();
    const r = db.run(
        `INSERT INTO job_requests
         (type, status, title, details, vehicleMachinery, ecdNo, projectName, site, priority, neededBy, neededByISO,
          vendorName, vendorEmail, emailRecipients, requestedBy, requestedByName, createdBy, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [f.type, 'DRAFT', f.title, f.details, f.vehicleMachinery, f.ecdNo, f.projectName, f.site, f.priority,
         f.neededBy, f.neededByISO, f.vendorName, f.vendorEmail, f.emailRecipients,
         user.id, user.name || user.username, user.id, now, now]
    );
    audit(r.lastInsertRowid, user, 'create', null, 'DRAFT', '');
    if (form.submit) {
        const t = transition(r.lastInsertRowid, 'submit', {}, user);
        if (t.error) return t;
        return t;
    }
    return { request: get(r.lastInsertRowid) };
}

function update(id, form, user) {
    const req = db.get('SELECT * FROM job_requests WHERE id=?', [id]);
    if (!req) return { error: 'Request not found.', status: 404 };
    if (req.status !== 'DRAFT') return { error: 'Only draft requests can be edited.', status: 400 };
    if (req.requestedBy !== user.id && !user.roles.includes(R.ADMIN)) return { error: 'Not your request.', status: 403 };
    const f = rowFromForm(form);
    db.run(
        `UPDATE job_requests SET type=?, title=?, details=?, vehicleMachinery=?, ecdNo=?, projectName=?, site=?,
            priority=?, neededBy=?, neededByISO=?, vendorName=?, vendorEmail=?, emailRecipients=?, updatedAt=? WHERE id=?`,
        [f.type, f.title, f.details, f.vehicleMachinery, f.ecdNo, f.projectName, f.site, f.priority, f.neededBy,
         f.neededByISO, f.vendorName, f.vendorEmail, f.emailRecipients, nowISO(), id]
    );
    return { request: get(id) };
}

// Attempt the outsourced e-mail; tolerant if the mailer isn't present/configured.
function tryEmailOutsourced(req) {
    try {
        const mailer = require('./mailer');
        if (mailer && typeof mailer.sendOutsourced === 'function') return mailer.sendOutsourced(req);
    } catch (e) { console.error(`[JOBREQ] outsourced e-mail failed for ${req.reqNo}:`, e.message); }
    return null;
}

function applyEffect(effect, req, user, note) {
    const set = (patch) => {
        const keys = Object.keys(patch);
        db.run(`UPDATE job_requests SET ${keys.map((k) => `${k}=?`).join(', ')}, updatedAt=? WHERE id=?`,
            [...keys.map((k) => patch[k]), nowISO(), req.id]);
    };
    switch (effect) {
        case 'submit':
            // Assign reqNo only on FIRST submit — a reopen→resubmit must keep the
            // original number so prior audits/notifications aren't orphaned
            // (review finding: reopen re-mints reqNo).
            set(req.reqNo ? { requestedAt: nowISO() } : { reqNo: genReqNo(), requestedAt: nowISO() });
            notifications.notifyRoles([R.TRANSPORT_MANAGER], get(req.id),
                `New job request ${get(req.id).reqNo} awaits your approval.`);
            break;
        case 'tmApprove':
            set({ tmApprovedBy: user.id, tmApprovedByName: user.name || user.username, tmApprovedAt: nowISO() });
            notifications.notifyRoles([R.OPERATIONAL_MANAGER], get(req.id),
                `Job request ${req.reqNo} approved by Transport Manager — awaits your approval.`);
            break;
        case 'omApprove': {
            set({ omApprovedBy: user.id, omApprovedByName: user.name || user.username, omApprovedAt: nowISO() });
            // Open a linked Workshop job card so costing can begin.
            const fresh = get(req.id);
            try {
                const jc = jobcards.create({
                    type: fresh.type, vehicleMachinery: fresh.vehicleMachinery, ecdNo: fresh.ecdNo,
                    projectName: fresh.projectName || fresh.site, details: fresh.title ? `${fresh.title} — ${fresh.details}` : fresh.details,
                    vendorName: fresh.vendorName, expectedDate: fresh.neededBy,
                }, user);
                if (jc && jc.id) { db.run('UPDATE jobcards SET jobRequestId=? WHERE id=?', [req.id, jc.id]); set({ jobCardId: jc.id }); }
            } catch (e) {
                // Best-effort, but a silent failure hid a real data problem
                // (review: swallowed data failures). Log so it is diagnosable.
                console.error(`[JOBREQ] auto job-card creation failed for ${req.reqNo}:`, e.message);
            }
            if (fresh.type === 'OUTSOURCED') { const sent = tryEmailOutsourced(get(req.id)); if (sent) set({ emailSentAt: nowISO() }); }
            notifications.notifyUser(req.requestedBy, get(req.id), `Your job request ${req.reqNo} is fully approved.`);
            break;
        }
        case 'reject':
            set({ rejectedBy: user.id, rejectedByName: user.name || user.username, rejectedAt: nowISO(), rejectReason: s(note) });
            notifications.notifyUser(req.requestedBy, get(req.id), `Job request ${req.reqNo} was rejected: ${s(note)}`);
            break;
        case 'complete':
            set({ completedBy: user.id, completedByName: user.name || user.username, completedAt: nowISO() });
            // On completion notify Transport Officer(s), Transport Manager, Operational Manager + the requester.
            notifications.notifyRoles([R.TRANSPORT_OFFICER, R.TRANSPORT_MANAGER, R.OPERATIONAL_MANAGER], get(req.id),
                `Job request ${req.reqNo} has been completed.`);
            notifications.notifyUser(req.requestedBy, get(req.id), `Your job request ${req.reqNo} is completed.`);
            break;
        case 'resendEmail': {
            if (req.type === 'OUTSOURCED') { const sent = tryEmailOutsourced(get(req.id)); if (sent) set({ emailSentAt: nowISO() }); }
            break;
        }
        default: break;
    }
}

function transition(id, action, body, user) {
    const req = db.get('SELECT * FROM job_requests WHERE id=?', [id]);
    if (!req) return { error: 'Request not found.', status: 404 };
    const t = (TRANSITIONS[req.status] || []).find((x) => x.action === action);
    if (!t) return { error: `Action "${action}" is not allowed from ${req.status}.`, status: 400 };
    if (!hasAnyRole(user, t.roles)) return { error: 'You do not have permission for this action.', status: 403 };
    const note = body && body.note;
    if (t.needNote && !s(note)) return { error: 'A reason is required.', status: 400 };
    const from = req.status;
    // Status change + side-effects + audit are one atomic unit: a mid-effect
    // throw must not leave e.g. APPROVED with no audit row (review: atomicity).
    db.transaction(() => {
        if (t.to !== req.status) db.run('UPDATE job_requests SET status=?, updatedAt=? WHERE id=?', [t.to, nowISO(), id]);
        if (t.effect) applyEffect(t.effect, req, user, note);
        audit(id, user, action, from, t.to, note);
    });
    return { request: get(id) };
}

function get(id) {
    const req = db.get('SELECT * FROM job_requests WHERE id=?', [id]);
    if (!req) return null;
    req.emailRecipients = auth.safeRoles(req.emailRecipients);
    req.statusLabel = STATUS_LABELS[req.status] || req.status;
    req.audits = db.all('SELECT * FROM job_request_audits WHERE requestId=? ORDER BY id DESC', [id]);
    req.availableActions = TRANSITIONS[req.status] || [];
    if (req.jobCardId) {
        const jc = db.get('SELECT id, jobNo, status FROM jobcards WHERE id=?', [req.jobCardId]);
        req.jobCard = jc || null;
    }
    return req;
}

// Which statuses is this user the pending approver for?
function pendingStatusesFor(user) {
    const st = [];
    if (hasAnyRole(user, [R.TRANSPORT_MANAGER, R.ADMIN])) st.push('PENDING_TM');
    if (hasAnyRole(user, [R.OPERATIONAL_MANAGER, R.ADMIN])) st.push('PENDING_OM');
    return st;
}

function list(query = {}, user) {
    const where = [];
    const params = [];
    if (query.status && STATUSES.includes(query.status)) { where.push('status=?'); params.push(query.status); }
    if (query.type) { where.push('type=?'); params.push(query.type); }
    if (query.mine === '1' || query.mine === true) { where.push('requestedBy=?'); params.push(user.id); }
    if (query.pending === '1' || query.pending === true) {
        const st = pendingStatusesFor(user);
        if (!st.length) { return { requests: [], counts: emptyCounts(), total: 0 }; }
        where.push(`status IN (${st.map(() => '?').join(',')})`); params.push(...st);
    }
    if (query.search) { const like = `%${query.search}%`; where.push('(reqNo LIKE ? OR title LIKE ? OR vehicleMachinery LIKE ? OR details LIKE ?)'); params.push(like, like, like, like); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.all(`SELECT * FROM job_requests ${clause} ORDER BY id DESC LIMIT 500`, params);
    rows.forEach((r) => { r.statusLabel = STATUS_LABELS[r.status] || r.status; });
    return { requests: rows, counts: counts(user), total: rows.length };
}

function emptyCounts() { return { pendingMine: 0, mineOpen: 0, inProgress: 0, completedMonth: 0 }; }
function counts(user) {
    const monthStart = new Date(); const ms = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`;
    const st = pendingStatusesFor(user);
    const pendingMine = st.length
        ? (db.get(`SELECT COUNT(*) c FROM job_requests WHERE status IN (${st.map(() => '?').join(',')})`, st) || {}).c
        : 0;
    return {
        pendingMine,
        mineOpen: (db.get(`SELECT COUNT(*) c FROM job_requests WHERE requestedBy=? AND status NOT IN ('CLOSED','REJECTED')`, [user.id]) || {}).c,
        inProgress: (db.get(`SELECT COUNT(*) c FROM job_requests WHERE status='IN_PROGRESS'`) || {}).c,
        completedMonth: (db.get(`SELECT COUNT(*) c FROM job_requests WHERE status IN ('COMPLETED','CLOSED') AND substr(COALESCE(completedAt,''),1,7)=?`, [ms.slice(0, 7)]) || {}).c,
    };
}

function remove(id, user) {
    const req = db.get('SELECT * FROM job_requests WHERE id=?', [id]);
    if (!req) return { success: true };
    if (!user.roles.includes(R.ADMIN) && !(req.status === 'DRAFT' && req.requestedBy === user.id)) {
        return { error: 'Only a draft you own (or an admin) can be deleted.', status: 403 };
    }
    db.run('DELETE FROM job_request_audits WHERE requestId=?', [id]);
    db.run('DELETE FROM job_requests WHERE id=?', [id]);
    return { success: true };
}

module.exports = { STATUSES, STATUS_LABELS, TRANSITIONS, canCreate, create, update, transition, get, list, counts, remove };
