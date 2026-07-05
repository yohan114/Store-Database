'use strict';

/**
 * dashboard.js — server-side analytics for the unified premium dashboard.
 *
 * All spend figures use priced "Receive" receipts (qty * unitPrice). The
 * Local vs Head Office split is derived from purchaseSource (per the approved
 * plan): Local = Local Store/Local Purchase; Head Office = Direct Purchase/
 * Head Office/Pre-Ordered; anything else = Other. Filters: startDate, endDate,
 * supplier, source (local|headOffice|other), category, vehicle.
 */

const db = require('./db');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Canonical values are 'Head Office Purchase' / 'Local Purchase'; the older
// spellings stay in the lists so rows written by legacy clients still classify.
const HEAD_OFFICE = ['head office purchase', 'direct purchase', 'head office', 'pre-ordered'];
const LOCAL = ['local purchase', 'local store'];

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localISO(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return localISO(d); };

// SQL CASE that classifies a receipt's purchaseSource into an origin bucket.
const ORIGIN_CASE = `CASE
    WHEN LOWER(TRIM(r.purchaseSource)) IN (${HEAD_OFFICE.map((v) => `'${v}'`).join(',')}) THEN 'headOffice'
    WHEN LOWER(TRIM(r.purchaseSource)) IN (${LOCAL.map((v) => `'${v}'`).join(',')}) THEN 'local'
    ELSE 'other' END`;

function receiptWhere(f) {
    const where = ["r.transactionType='Receive'", 'r.unitPrice IS NOT NULL'];
    const params = [];
    if (f.startDate) { where.push('r.deliveryDateISO >= ?'); params.push(f.startDate); }
    if (f.endDate) { where.push('r.deliveryDateISO <= ?'); params.push(f.endDate); }
    if (f.supplier) { where.push('r.supplierName = ?'); params.push(f.supplier); }
    if (f.category) { where.push('i.category = ?'); params.push(f.category); }
    if (f.vehicle) { where.push('i.vehicleMachinery = ?'); params.push(f.vehicle); }
    if (f.source === 'headOffice') { where.push(`LOWER(TRIM(r.purchaseSource)) IN (${HEAD_OFFICE.map(() => '?').join(',')})`); params.push(...HEAD_OFFICE); }
    else if (f.source === 'local') { where.push(`LOWER(TRIM(r.purchaseSource)) IN (${LOCAL.map(() => '?').join(',')})`); params.push(...LOCAL); }
    else if (f.source === 'other') { where.push(`LOWER(TRIM(r.purchaseSource)) NOT IN (${[...HEAD_OFFICE, ...LOCAL].map(() => '?').join(',')})`); params.push(...HEAD_OFFICE, ...LOCAL); }
    return { sql: where.join(' AND '), params };
}

function sumSpend(f) {
    const w = receiptWhere(f);
    const row = db.get(`SELECT COALESCE(SUM(r.qty*r.unitPrice),0) AS s FROM receipts r JOIN items i ON i.id=r.itemId WHERE ${w.sql}`, w.params);
    return round2(row ? row.s : 0);
}

function splitByOrigin(f) {
    const w = receiptWhere(f);
    const rows = db.all(
        `SELECT ${ORIGIN_CASE} AS origin, COALESCE(SUM(r.qty*r.unitPrice),0) AS val
         FROM receipts r JOIN items i ON i.id=r.itemId WHERE ${w.sql} GROUP BY origin`, w.params);
    const out = { local: 0, headOffice: 0, other: 0, total: 0 };
    rows.forEach((x) => { out[x.origin] = round2(x.val); });
    out.total = round2(out.local + out.headOffice + out.other);
    return out;
}

function dailySplit(f, limit = 60) {
    const w = receiptWhere(f);
    const rows = db.all(
        `SELECT r.deliveryDateISO AS day, ${ORIGIN_CASE} AS origin, SUM(r.qty*r.unitPrice) AS val
         FROM receipts r JOIN items i ON i.id=r.itemId
         WHERE ${w.sql} AND r.deliveryDateISO != '' AND r.deliveryDateISO IS NOT NULL
         GROUP BY day, origin ORDER BY day DESC`, w.params);
    const byDay = new Map();
    rows.forEach((x) => {
        if (!byDay.has(x.day)) byDay.set(x.day, { day: x.day, local: 0, headOffice: 0, other: 0, total: 0 });
        const d = byDay.get(x.day);
        d[x.origin] = round2(x.val);
        d.total = round2(d.total + x.val);
    });
    return [...byDay.values()].slice(0, limit);
}

// Month-by-month expense split for the last `limit` months (newest first).
function monthlySplit(f, limit = 12) {
    const w = receiptWhere(f);
    const rows = db.all(
        `SELECT SUBSTR(r.deliveryDateISO,1,7) AS month, ${ORIGIN_CASE} AS origin, SUM(r.qty*r.unitPrice) AS val
         FROM receipts r JOIN items i ON i.id=r.itemId
         WHERE ${w.sql} AND r.deliveryDateISO != '' AND r.deliveryDateISO IS NOT NULL
         GROUP BY month, origin ORDER BY month DESC`, w.params);
    const byMonth = new Map();
    rows.forEach((x) => {
        if (!byMonth.has(x.month)) byMonth.set(x.month, { month: x.month, local: 0, headOffice: 0, other: 0, total: 0 });
        const m = byMonth.get(x.month);
        m[x.origin] = round2(x.val);
        m.total = round2(m.total + x.val);
    });
    return [...byMonth.values()].slice(0, limit);
}

// Requests not yet fully delivered, split by where they were requested from.
function pendingItems(f, limit = 100) {
    const where = [];
    const params = [];
    if (f.category) { where.push('i.category = ?'); params.push(f.category); }
    if (f.vehicle) { where.push('i.vehicleMachinery = ?'); params.push(f.vehicle); }
    const clause = where.length ? 'AND ' + where.join(' AND ') : '';
    const rows = db.all(
        `SELECT i.id, i.mrnNum, i.itemName, i.vehicleMachinery, i.reqDate, i.reqDateISO, i.requestSource,
                i.reqQty, COALESCE(SUM(r.qty),0) AS recQty,
                ROUND(i.reqQty - COALESCE(SUM(r.qty),0), 2) AS outstandingQty,
                CAST(JULIANDAY('now') - JULIANDAY(NULLIF(i.reqDateISO,'')) AS INTEGER) AS ageDays
         FROM items i LEFT JOIN receipts r ON r.itemId = i.id
         WHERE 1=1 ${clause}
         GROUP BY i.id HAVING i.reqQty - COALESCE(SUM(r.qty),0) > 0.005
         ORDER BY NULLIF(i.reqDateISO,'') ASC`, params);
    const bucket = (r) => (r.requestSource === 'Local' ? 'local' : r.requestSource === 'Head Office' ? 'headOffice' : 'unspecified');
    const out = { local: [], headOffice: [], unspecified: [], counts: { local: 0, headOffice: 0, unspecified: 0, total: rows.length } };
    rows.forEach((r) => {
        const b = bucket(r);
        out.counts[b] += 1;
        if (out[b].length < limit) out[b].push(r);
    });
    return out;
}

function supplierSpend(f, limit = 12) {
    const w = receiptWhere(f);
    const rows = db.all(
        `SELECT COALESCE(NULLIF(TRIM(r.supplierName),''),'Unspecified') AS supplier, COALESCE(SUM(r.qty*r.unitPrice),0) AS spend
         FROM receipts r JOIN items i ON i.id=r.itemId WHERE ${w.sql}
         GROUP BY supplier ORDER BY spend DESC`, w.params);
    const total = rows.reduce((s, x) => s + x.spend, 0);
    return rows.slice(0, limit).map((x) => ({ supplier: x.supplier, spend: round2(x.spend), pct: total > 0 ? Math.round((x.spend / total) * 100) : 0 }));
}

function jobKpis() {
    const counts = { OPEN: 0, IN_PROGRESS: 0, ON_HOLD: 0, COMPLETED: 0, CLOSED: 0 };
    let total = 0;
    db.all('SELECT status, COUNT(*) AS c FROM jobcards GROUP BY status').forEach((r) => { counts[r.status] = r.c; total += r.c; });
    const labour = round2((db.get('SELECT COALESCE(SUM(labourCost),0) AS s FROM jobcards') || {}).s);
    const parts = round2((db.get(
        `SELECT COALESCE(SUM(r.qty*r.unitPrice),0) AS s FROM receipts r JOIN items i ON i.id=r.itemId
         WHERE r.transactionType='Receive' AND r.unitPrice IS NOT NULL AND i.jobCardId IS NOT NULL`) || {}).s);
    return {
        open: counts.OPEN, inProgress: counts.IN_PROGRESS, onHold: counts.ON_HOLD,
        completed: counts.COMPLETED, closed: counts.CLOSED, total,
        active: counts.OPEN + counts.IN_PROGRESS + counts.ON_HOLD,
        labourCost: labour, partsCost: parts, totalCost: round2(labour + parts),
    };
}

function build(query = {}) {
    const f = {
        startDate: query.startDate || null,
        endDate: query.endDate || null,
        supplier: query.supplier || null,
        source: query.source || null,
        category: query.category || null,
        vehicle: query.vehicle || null,
    };
    // MTD / YTD respect the non-date filters but use fixed month/year windows.
    const nonDate = { supplier: f.supplier, source: f.source, category: f.category, vehicle: f.vehicle };
    return {
        filters: f,
        spend: {
            mtd: sumSpend({ ...nonDate, startDate: monthStart(), endDate: today() }),
            ytd: sumSpend({ ...nonDate, startDate: yearStart(), endDate: today() }),
            total: sumSpend(nonDate),
            period: sumSpend(f),
        },
        received: splitByOrigin(f),
        daily: dailySplit(f),
        monthly: monthlySplit(f),
        todays: {
            today: splitByOrigin({ ...nonDate, startDate: today(), endDate: today() }),
            yesterday: splitByOrigin({ ...nonDate, startDate: yesterday(), endDate: yesterday() }),
        },
        pending: pendingItems(f),
        suppliers: supplierSpend(f),
        jobs: jobKpis(),
    };
}

module.exports = { build };
