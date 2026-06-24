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
const jobcards = require('./jobcards');

dbApi.init();
auth.ensureSeedUser();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '100mb' }));

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

app.post('/api/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const user = dbApi.get('SELECT * FROM users WHERE LOWER(username)=? AND active=1', [username]);
    if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }
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

// ---- Gate everything else behind authentication ---------------------------
app.use('/api', auth.requireApiAuth);
app.get(['/', '/item_tracker.html'], auth.requirePageAuth, (req, res, next) => {
    if (req.path === '/') return res.redirect('/item_tracker.html');
    next();
});

app.use(express.static(__dirname));

// ---- Job Cards -------------------------------------------------------------
app.get('/api/jobcards', (req, res) => {
    res.json(jobcards.list(req.query));
});
app.post('/api/jobcards', (req, res) => {
    const jc = jobcards.create(req.body || {}, req.user);
    res.json({ success: true, jobcard: jc });
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

        // The computed columns used by both filter tabs and sorting.
        const computed = `
            i.*,
            COALESCE((SELECT SUM(qty) FROM receipts r WHERE r.itemId=i.id),0) AS recQty,
            (SELECT COUNT(*) FROM receipts r WHERE r.itemId=i.id) AS recCount,
            (SELECT MAX(deliveryDateISO) FROM receipts r WHERE r.itemId=i.id) AS recDateISO,
            CASE WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.itemId=i.id AND (r.unitPrice IS NULL OR r.unitPrice=0)) THEN 1 ELSE 0 END AS hasUnpriced
        `;

        // Unpaginated: return the whole dataset (used by dashboard/fleet/dropdowns).
        if (!page || !limit) {
            const items = dbApi.all(`SELECT ${computed} FROM items i ORDER BY i.reqDateISO DESC, i.id DESC`);
            return res.json(attachReceipts(items));
        }

        const { clause, params } = buildItemWhere(req.query);
        const tab = filterTabClause(req.query.filter);
        const outerWhere = tab ? `WHERE ${tab}` : '';

        const sortKey = ITEM_SORTS[req.query.sort] || ITEM_SORTS.reqDate;
        const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const skip = (page - 1) * limit;

        const baseCte = `WITH base AS (SELECT ${computed} FROM items i ${clause})`;
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
            `INSERT INTO items (mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s(b.mrnNum), s(b.reqDate), toISO(b.reqDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.reqQty) || 0, category, now, now]
        );
        res.json({ success: true, id: r.lastInsertRowid, category });
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
            `UPDATE items SET mrnNum=?, reqDate=?, reqDateISO=?, vehicleMachinery=?, itemName=?, itemDesc=?, reqQty=?, category=?, updatedAt=? WHERE id=?`,
            [s(b.mrnNum), s(b.reqDate), toISO(b.reqDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.reqQty) || 0, category, nowISO(), id]
        );
        res.json({ success: true, category });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Middleware to verify deletion password
const verifyDeletePassword = (req, res, next) => {
    const password = req.headers['x-delete-password'] || req.query.password;
    if (password !== 'E&CWorkshop') {
        return res.status(403).json({ error: 'Unauthorized: Incorrect delete password.' });
    }
    next();
};

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
            [itemId, Number(b.qty) || 0, s(b.transactionType), s(b.deliveryDate), toISO(b.deliveryDate), s(b.purchaseSource),
             s(b.grnNumber), s(b.invoiceNumber), s(b.invoiceDate), s(b.supplierName), numOrNull(b.unitPrice)]
        );
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
        setIf('purchaseSource', 'purchaseSource');
        setIf('grnNumber', 'grnNumber');
        setIf('invoiceNumber', 'invoiceNumber');
        setIf('invoiceDate', 'invoiceDate');
        setIf('supplierName', 'supplierName');
        setIf('unitPrice', 'unitPrice', numOrNull);
        if (!fields.length) return res.json({ success: true });
        params.push(id);
        dbApi.run(`UPDATE receipts SET ${fields.join(', ')} WHERE id=?`, params);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. DELETE /api/receipts/:id
app.delete('/api/receipts/:id', verifyDeletePassword, (req, res) => {
    try {
        dbApi.run(`DELETE FROM receipts WHERE id=?`, [parseInt(req.params.id)]);
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

app.post('/api/issues', (req, res) => {
    try {
        const b = req.body || {};
        const itemName = s(b.itemName);
        const itemDesc = s(b.itemDesc);
        const category = b.category && String(b.category).trim() ? String(b.category).trim() : classify(itemName, itemDesc);
        const now = nowISO();
        const r = dbApi.run(
            `INSERT INTO issues (issueDate, issueDateISO, vehicleMachinery, itemName, itemDesc, qty, category, issuedTo, issuedBy, mrnNum, purchaseSource, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s(b.issueDate), toISO(b.issueDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.qty) || 0, category,
             s(b.issuedTo), s(b.issuedBy), s(b.mrnNum), s(b.purchaseSource), s(b.notes), now, now]
        );
        res.json({ success: true, id: r.lastInsertRowid, category });
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
        dbApi.run(
            `UPDATE issues SET issueDate=?, issueDateISO=?, vehicleMachinery=?, itemName=?, itemDesc=?, qty=?, category=?, issuedTo=?, issuedBy=?, mrnNum=?, purchaseSource=?, notes=?, updatedAt=? WHERE id=?`,
            [s(b.issueDate), toISO(b.issueDate), s(b.vehicleMachinery), itemName, itemDesc, Number(b.qty) || 0, category,
             s(b.issuedTo), s(b.issuedBy), s(b.mrnNum), s(b.purchaseSource), s(b.notes), nowISO(), id]
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
        const insItem = `INSERT INTO items (mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`;
        const insRec = `INSERT INTO receipts (itemId, qty, transactionType, deliveryDate, deliveryDateISO, purchaseSource, grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
        dbApi.transaction(() => {
            for (const it of data) {
                const itemName = s(it.itemName || it.name);
                const itemDesc = s(it.itemDesc);
                const category = it.category && String(it.category).trim() ? String(it.category).trim() : classify(itemName, itemDesc);
                const r = dbApi.run(insItem, [s(it.mrnNum), s(it.reqDate), toISO(it.reqDate), s(it.vehicleMachinery), itemName, itemDesc, Number(it.reqQty) || 0, category, now, now]);
                const itemId = r.lastInsertRowid;
                for (const rc of (it.receipts || [])) {
                    dbApi.run(insRec, [itemId, Number(rc.qty) || 0, s(rc.transactionType || rc.type || 'Receive'), s(rc.deliveryDate || rc.date), toISO(rc.deliveryDate || rc.date),
                        s(rc.purchaseSource || rc.source), s(rc.grnNumber), s(rc.invoiceNumber), s(rc.invoiceDate), s(rc.supplierName), numOrNull(rc.unitPrice)]);
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

// --- start + lightweight single-file backups -------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Inventory Monitor running at http://localhost:${PORT}/item_tracker.html  (engine: ${dbApi.ENGINE})`);
    const nets = os.networkInterfaces();
    for (const name in nets) for (const iface of nets[name]) {
        if (iface.family === 'IPv4' && !iface.internal) console.log(`  Network: http://${iface.address}:${PORT}`);
    }
});

const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL = 30 * 60 * 1000;
function runAutomaticBackup() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        try { dbApi.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(BACKUP_DIR, `inventory_backup_${ts}.db`);
        if (fs.existsSync(dbApi.DB_FILE)) {
            fs.copyFileSync(dbApi.DB_FILE, dest);
            const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('inventory_backup_') && f.endsWith('.db'))
                .map(f => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtime })).sort((a, b) => b.m - a.m);
            files.slice(48).forEach(({ f }) => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {} });
        }
    } catch (e) {
        console.error('[BACKUP] failed:', e.message);
    }
}
setInterval(runAutomaticBackup, BACKUP_INTERVAL);
setTimeout(runAutomaticBackup, 10000);
