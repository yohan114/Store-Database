'use strict';

/**
 * jobcards.js — Job Card service for the unified Workshop + Stores system.
 *
 * Streamlined first cut (per approved plan): create / edit / list / get plus a
 * simple status lifecycle with an audit trail. The richer 7-role approval
 * workflow from Job-Card-System/src/domain.js is intentionally deferred; its
 * TRANSITIONS table can be layered on later without changing this schema.
 *
 * A Job Card is the PARENT of its Daily Programme entries (added in Phase 3)
 * and of any MRNs/issues linked to it (Phase 4).
 */

const db = require('./db');
const programme = require('./programme');
const costing = require('./costing');
const config = require('./config');

const STATUSES = ['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED'];

// Streamlined status lifecycle (no role gating yet).
const TRANSITIONS = {
    OPEN: ['IN_PROGRESS', 'CLOSED'],
    IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
    ON_HOLD: ['IN_PROGRESS'],
    COMPLETED: ['CLOSED', 'IN_PROGRESS'],
    CLOSED: [],
};

const s = (v) => (v === null || v === undefined) ? '' : String(v).trim();
const numOrNull = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- vehicle + date matching (shared rule with tools/import_workshop.js) -----
const WINDOW_DAYS = config.WINDOW_DAYS;
const normVeh = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
function vehSet(v) {
    const parts = String(v || '').split(/[\/,]/).map(normVeh).filter(Boolean);
    return parts.length ? parts : [normVeh(v)].filter(Boolean);
}
function addDaysISO(isoDate, n) {
    const d = new Date(String(isoDate) + 'T00:00:00Z');
    if (isNaN(d)) return isoDate;
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Best job matching a vehicle whose [start-2 … end+2] window contains dateISO. */
function findMatch(vehicle, dateISO) {
    const vn = normVeh(vehicle);
    if (!vn || !dateISO) return null;
    const lo = addDaysISO(dateISO, -WINDOW_DAYS);   // job end   must be >= D-2
    const hi = addDaysISO(dateISO, WINDOW_DAYS);    // job start must be <= D+2
    const cands = db.all(
        `SELECT id, jobNo, dateISO, expectedDateISO, vehicleMachinery FROM jobcards
         WHERE dateISO IS NOT NULL AND dateISO != ''
           AND dateISO <= ?
           AND COALESCE(NULLIF(expectedDateISO,''), dateISO) >= ?
           AND REPLACE(UPPER(vehicleMachinery), ' ', '') LIKE ?`,
        [hi, lo, '%' + vn + '%']
    ).filter((j) => vehSet(j.vehicleMachinery).includes(vn));
    if (!cands.length) return null;
    const span = (j) => Date.parse(j.expectedDateISO || j.dateISO) - Date.parse(j.dateISO);
    cands.sort((a, b) => (span(a) - span(b)) || (Math.abs(Date.parse(a.dateISO) - Date.parse(dateISO)) - Math.abs(Date.parse(b.dateISO) - Date.parse(dateISO))));
    return cands[0];
}

/** Get (or create) the per-vehicle catch-all job that holds unscheduled work. */
function getOrCreateCatchAll(vehicle) {
    const vn = normVeh(vehicle);
    if (!vn) return null;
    const jobNo = 'DW-' + vn;
    const ex = db.get('SELECT id FROM jobcards WHERE jobNo=?', [jobNo]);
    if (ex) return ex.id;
    const now = new Date().toISOString();
    const label = String(vehicle).trim();
    return db.run(
        `INSERT INTO jobcards (jobNo, type, status, vehicleMachinery, details, labourCost, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
        [jobNo, 'INTERNAL', 'COMPLETED', label, 'Auto-created to hold unscheduled work for ' + label, 0, now, now]
    ).lastInsertRowid;
}

function genJobNo() {
    const year = new Date().getFullYear();
    const prefix = `JC-${year}-`;
    // jobNo format JC-YYYY-#### → the number starts at character 9 (1-indexed).
    const row = db.get(
        `SELECT MAX(CAST(substr(jobNo, 9) AS INTEGER)) AS mx FROM jobcards WHERE jobNo LIKE ?`,
        [prefix + '%']
    );
    const next = ((row && row.mx) || 0) + 1;
    return prefix + String(next).padStart(4, '0');
}

function audit(jobCardId, user, action, fromStatus, toStatus, note) {
    db.run(
        `INSERT INTO job_audits (jobCardId, userId, userName, action, fromStatus, toStatus, note, at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [jobCardId, user ? user.id : null, user ? (user.name || user.username) : 'system',
         action, fromStatus || null, toStatus || null, s(note), new Date().toISOString()]
    );
}

function rowFields(form) {
    return {
        type: form.type === 'OUTSOURCED' ? 'OUTSOURCED' : 'INTERNAL',
        date: s(form.date) || new Date().toISOString().slice(0, 10),
        dateISO: db.toISO(form.date) || new Date().toISOString().slice(0, 10),
        projectName: s(form.projectName),
        vehicleMachinery: s(form.vehicleMachinery),
        meter: numOrNull(form.meter),
        repairType: s(form.repairType),
        repairTypeNote: s(form.repairTypeNote),
        expectedDate: s(form.expectedDate),
        expectedDateISO: db.toISO(form.expectedDate),
        driverName: s(form.driverName),
        contactNo: s(form.contactNo),
        ecdNo: s(form.ecdNo),
        details: s(form.details),
        vendorName: s(form.vendorName),
    };
}

function create(form, user) {
    const now = new Date().toISOString();
    const f = rowFields(form);
    const jobNo = genJobNo();
    const r = db.run(
        `INSERT INTO jobcards
         (jobNo, type, status, date, dateISO, projectName, vehicleMachinery, meter,
          repairType, repairTypeNote, expectedDate, expectedDateISO, driverName, contactNo, ecdNo,
          details, vendorName, labourCost, createdBy, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jobNo, f.type, 'OPEN', f.date, f.dateISO, f.projectName, f.vehicleMachinery, f.meter,
         f.repairType, f.repairTypeNote, f.expectedDate, f.expectedDateISO, f.driverName, f.contactNo, f.ecdNo,
         f.details, f.vendorName, 0, user ? user.id : null, now, now]
    );
    audit(r.lastInsertRowid, user, 'create', null, 'OPEN', '');
    return get(r.lastInsertRowid);
}

function update(id, form, user) {
    const existing = db.get('SELECT * FROM jobcards WHERE id=?', [id]);
    if (!existing) return null;
    const f = rowFields(form);
    db.run(
        `UPDATE jobcards SET type=?, date=?, dateISO=?, projectName=?, vehicleMachinery=?, meter=?,
            repairType=?, repairTypeNote=?, expectedDate=?, expectedDateISO=?, driverName=?, contactNo=?,
            ecdNo=?, details=?, vendorName=?, updatedAt=? WHERE id=?`,
        [f.type, f.date, f.dateISO, f.projectName, f.vehicleMachinery, f.meter,
         f.repairType, f.repairTypeNote, f.expectedDate, f.expectedDateISO, f.driverName, f.contactNo,
         f.ecdNo, f.details, f.vendorName, new Date().toISOString(), id]
    );
    audit(id, user, 'edit', existing.status, existing.status, '');
    return get(id);
}

function setStatus(id, toStatus, note, user) {
    const jc = db.get('SELECT * FROM jobcards WHERE id=?', [id]);
    if (!jc) return { error: 'Job card not found.' };
    if (!STATUSES.includes(toStatus)) return { error: 'Unknown status.' };
    const allowed = TRANSITIONS[jc.status] || [];
    if (!allowed.includes(toStatus)) {
        return { error: `Cannot move a ${jc.status} job card to ${toStatus}.` };
    }
    const now = new Date().toISOString();
    const sets = ['status=?', 'updatedAt=?'];
    const params = [toStatus, now];
    if (toStatus === 'IN_PROGRESS' && !jc.startedAt) { sets.push('startedAt=?'); params.push(now); }
    if (toStatus === 'COMPLETED') { sets.push('completedAt=?'); params.push(now); }
    if (toStatus === 'CLOSED') { sets.push('closedAt=?'); params.push(now); }
    if (toStatus === 'ON_HOLD') { sets.push('holdReason=?'); params.push(s(note)); }
    params.push(id);
    db.run(`UPDATE jobcards SET ${sets.join(', ')} WHERE id=?`, params);
    audit(id, user, 'status', jc.status, toStatus, note);
    return { jobcard: get(id) };
}

function get(id) {
    const jc = db.get('SELECT * FROM jobcards WHERE id=?', [id]);
    if (!jc) return null;
    jc.audits = db.all('SELECT * FROM job_audits WHERE jobCardId=? ORDER BY id DESC', [id]);
    jc.availableStatuses = TRANSITIONS[jc.status] || [];
    // Daily programme entries (child rows). labourCost is kept fresh on write.
    try {
        jc.programme = db.all('SELECT * FROM daily_programme WHERE jobCardId=? ORDER BY entryDateISO DESC, id DESC', [id]);
    } catch (_) { jc.programme = []; }
    // Linked MRNs (items) + parts cost from priced "Receive" receipts on them.
    try {
        jc.linkedItems = db.all(
            `SELECT i.id, i.mrnNum, i.itemName, i.itemDesc, i.vehicleMachinery, i.reqQty, i.category,
                    COALESCE((SELECT SUM(r.qty) FROM receipts r WHERE r.itemId=i.id AND r.transactionType='Receive'),0) AS recQty,
                    COALESCE((SELECT SUM(CASE WHEN r.transactionType='Receive' AND r.unitPrice IS NOT NULL THEN r.qty*r.unitPrice ELSE 0 END) FROM receipts r WHERE r.itemId=i.id),0) AS lineCost,
                    (SELECT COUNT(*) FROM receipts r WHERE r.itemId=i.id AND r.transactionType='Receive' AND (r.unitPrice IS NULL OR r.unitPrice=0)) AS unpricedCount
             FROM items i WHERE i.jobCardId=? ORDER BY i.id DESC`, [id]);
    } catch (_) { jc.linkedItems = []; }
    // Highlight flags: not fully received, or received-but-unpriced / no value yet.
    (jc.linkedItems || []).forEach((it) => {
        it.notReceived = (Number(it.recQty) || 0) < (Number(it.reqQty) || 0);
        it.unpriced = (Number(it.unpricedCount) || 0) > 0 || ((Number(it.recQty) || 0) > 0 && (Number(it.lineCost) || 0) <= 0) || (Number(it.recQty) || 0) === 0;
    });
    jc.pendingCount = (jc.linkedItems || []).filter((it) => it.notReceived).length;
    jc.unpricedItems = (jc.linkedItems || []).filter((it) => it.unpriced).length;
    jc.receivedPartsCost = round2((jc.linkedItems || []).reduce((sum, it) => sum + (it.lineCost || 0), 0));
    // Issued items (consumables) linked to this job — now priced, so they
    // contribute to job cost. Each carries a unit price (auto-derived from the
    // item's priced deliveries, editable on the Issue Desk); lineCost = qty×price.
    try {
        jc.linkedIssues = db.all('SELECT id, issueDate, issueDateISO, itemName, qty, category, issuedTo, unitPrice FROM issues WHERE jobCardId=? ORDER BY issueDateISO DESC, id DESC', [id]);
    } catch (_) { jc.linkedIssues = []; }
    (jc.linkedIssues || []).forEach((s) => {
        s.lineCost = (s.unitPrice != null) ? round2((Number(s.qty) || 0) * s.unitPrice) : 0;
        s.unpriced = (s.unitPrice == null);
    });
    jc.issuesCount = (jc.linkedIssues || []).length;
    jc.issuesCost = round2((jc.linkedIssues || []).reduce((sum, s) => sum + (s.lineCost || 0), 0));
    jc.unpricedIssues = (jc.linkedIssues || []).filter((s) => s.unpriced).length;
    // Parts = received materials + issued consumables; Total via the single
    // costing rule (labour+parts+issues, or the larger imported recordedCost).
    jc.partsCost = round2(jc.receivedPartsCost + jc.issuesCost);
    jc.recordedCost = (jc.recordedCost != null && jc.recordedCost > 0) ? round2(jc.recordedCost) : null;
    jc.computedCost = costing.computedCost(jc);
    jc.totalCost = costing.jobTotal(jc);
    // Per-mechanic labour breakdown per daily line (rate × full hours each),
    // mirroring the workshop's "Mechanic Breakdown" — for the cost cockpit.
    const rm = programme.rateMap();
    (jc.programme || []).forEach((dp) => {
        const hours = Number(dp.hours) || 0;
        dp.mechanicBreakdown = String(dp.mechanics || '').split(',').map((x) => x.trim()).filter(Boolean).map((name) => {
            const rate = programme.rateFor(name, rm);
            return { name, rate, hours, cost: rate ? round2(hours * rate) : 0 };
        });
    });
    return jc;
}

const JOB_SORTS = {
    jobNo: 'jobNo COLLATE NOCASE',
    date: 'dateISO',
    vehicleMachinery: 'vehicleMachinery COLLATE NOCASE',
    status: 'status',
    labourCost: 'labourCost',
};

function list(q = {}) {
    const where = [];
    const params = [];
    if (q.search) {
        const like = `%${q.search}%`;
        where.push('(jobNo LIKE ? OR vehicleMachinery LIKE ? OR projectName LIKE ? OR details LIKE ? OR driverName LIKE ?)');
        params.push(like, like, like, like, like);
    }
    if (q.status) { where.push('status=?'); params.push(q.status); }
    if (q.type) { where.push('type=?'); params.push(q.type); }
    if (q.vehicle) { where.push('vehicleMachinery=?'); params.push(q.vehicle); }
    if (q.startDate) { where.push('dateISO>=?'); params.push(q.startDate); }
    if (q.endDate) { where.push('dateISO<=?'); params.push(q.endDate); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderBy = JOB_SORTS[q.sort] || 'dateISO';
    const dir = String(q.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const total = db.get(`SELECT COUNT(*) AS c FROM jobcards ${whereSql}`, params).c;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
    const offset = (page - 1) * limit;
    const rows = db.all(
        `SELECT * FROM jobcards ${whereSql} ORDER BY ${orderBy} ${dir}, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    // Attach parts + issues cost for just this page with two GROUP-BY lookups
    // (not per-row correlated subqueries), then apply the one costing rule so
    // the grid total matches the detail view exactly (review finding 6).
    const ids = rows.map((r) => r.id);
    if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const partsMap = new Map();
        db.all(`SELECT i.jobCardId AS jid, COALESCE(${costing.RECEIVED_PARTS_SUM},0) AS c
                FROM items i JOIN receipts r ON r.itemId=i.id
                WHERE i.jobCardId IN (${ph}) GROUP BY i.jobCardId`, ids)
            .forEach((x) => partsMap.set(x.jid, x.c));
        const issMap = new Map();
        db.all(`SELECT s.jobCardId AS jid, COALESCE(${costing.ISSUES_SUM},0) AS c
                FROM issues s WHERE s.jobCardId IN (${ph}) GROUP BY s.jobCardId`, ids)
            .forEach((x) => issMap.set(x.jid, x.c));
        rows.forEach((r) => {
            r.receivedPartsCost = round2(partsMap.get(r.id) || 0);
            r.issuesCost = round2(issMap.get(r.id) || 0);
            r.partsCost = round2(r.receivedPartsCost + r.issuesCost);
            r.recordedCost = (r.recordedCost != null && r.recordedCost > 0) ? round2(r.recordedCost) : null;
            r.computedCost = costing.computedCost(r);
            r.totalCost = costing.jobTotal(r);
        });
    }
    return { jobcards: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

function remove(id) {
    db.run('DELETE FROM job_audits WHERE jobCardId=?', [id]);
    try { db.run('DELETE FROM daily_programme WHERE jobCardId=?', [id]); } catch (_) {}
    try { db.run('UPDATE items SET jobCardId=NULL, jobNo=NULL, linkMethod=NULL, linkGap=NULL WHERE jobCardId=?', [id]); } catch (_) {}
    try { db.run('UPDATE issues SET jobCardId=NULL, jobNo=NULL, linkMethod=NULL, linkGap=NULL WHERE jobCardId=?', [id]); } catch (_) {}
    db.run('DELETE FROM jobcards WHERE id=?', [id]);
    return { success: true };
}

/** Claim window for a job: [start-2 … (end||start)+2] + normalized vehicle.
 *  Null for jobs without a start date (e.g. DW- catch-all jobs). */
function jobWindow(job) {
    if (!job || !job.dateISO) return null;
    return {
        lo: addDaysISO(job.dateISO, -WINDOW_DAYS),
        hi: addDaysISO(job.expectedDateISO || job.dateISO, WINDOW_DAYS),
        vn: normVeh(job.vehicleMachinery),
    };
}

module.exports = { STATUSES, TRANSITIONS, create, update, setStatus, get, list, remove, genJobNo, findMatch, getOrCreateCatchAll, jobWindow, normVeh, vehSet };
