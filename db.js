/**
 * db.js — Fast embedded SQLite data layer for the Delivery / Inventory Monitor.
 *
 * Replaces the old MS Access (.accdb) + PowerShell backend, which spawned a new
 * PowerShell process and re-scanned the entire database on every request.
 *
 * Engine selection is automatic and zero-config:
 *   1. better-sqlite3  (preferred — ships prebuilt binaries, fastest)
 *   2. node:sqlite     (built-in fallback on Node >= 22.5, no install needed)
 *
 * Both expose a compatible synchronous API: db.prepare(sql).{run,get,all}(...params)
 * and db.exec(sql). We only use positional `?` parameters so both engines work.
 */
const path = require('path');
const fs = require('fs');

const DB_FILE = process.env.INVENTORY_DB || path.join(__dirname, 'inventory.db');

let db;
let ENGINE = 'better-sqlite3';

try {
    const Database = require('better-sqlite3');
    db = new Database(DB_FILE);
} catch (e) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(DB_FILE);
        ENGINE = 'node:sqlite';
    } catch (e2) {
        console.error('FATAL: No SQLite engine available. Install better-sqlite3 (npm install) or run on Node >= 22.5.');
        throw e2;
    }
}

// Pragmas for speed + safe concurrent reads. exec() works on both engines.
try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA temp_store = MEMORY;');
} catch (e) {
    console.warn('Pragma setup warning:', e.message);
}

// ---- Thin query helpers (prepare + execute) -------------------------------
function all(sql, params = []) {
    return db.prepare(sql).all(...params);
}
function get(sql, params = []) {
    return db.prepare(sql).get(...params);
}
function run(sql, params = []) {
    const r = db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}
function exec(sql) {
    return db.exec(sql);
}
/** Run fn() inside a transaction (portable across both engines). */
function transaction(fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
    }
}

// ---- Date normalization ----------------------------------------------------
// Stored dates are inconsistent ("12/11/2025" M/D/YYYY, "2025-12-11", etc.).
// We normalize every date to ISO "YYYY-MM-DD" in a parallel *ISO column so that
// range filters and sorting are correct AND fast (plain indexed string compare).
function toISO(dateStr) {
    if (dateStr === null || dateStr === undefined) return '';
    let s = String(dateStr).trim();
    if (!s) return '';

    // ISO-ish: YYYY-MM-DD or YYYY/MM/DD (optionally followed by time)
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) {
        return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }

    // M/D/YYYY (app convention) — fall back to D/M/YYYY when month > 12
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (m) {
        let mo = parseInt(m[1], 10);
        let d = parseInt(m[2], 10);
        let y = parseInt(m[3], 10);
        if (y < 100) y += 2000;
        if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; }
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }
    return '';
}

const nowISO = () => new Date().toISOString();

// ---- Schema ----------------------------------------------------------------
function init() {
    exec(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mrnNum TEXT,
            reqDate TEXT,
            reqDateISO TEXT,
            vehicleMachinery TEXT,
            itemName TEXT,
            itemDesc TEXT,
            reqQty REAL DEFAULT 0,
            category TEXT,
            createdAt TEXT,
            updatedAt TEXT
        );

        CREATE TABLE IF NOT EXISTS receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            itemId INTEGER,
            qty REAL DEFAULT 0,
            transactionType TEXT,
            deliveryDate TEXT,
            deliveryDateISO TEXT,
            purchaseSource TEXT,
            grnNumber TEXT,
            invoiceNumber TEXT,
            invoiceDate TEXT,
            supplierName TEXT,
            unitPrice REAL
        );

        CREATE TABLE IF NOT EXISTS issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            issueDate TEXT,
            issueDateISO TEXT,
            vehicleMachinery TEXT,
            itemName TEXT,
            itemDesc TEXT,
            qty REAL DEFAULT 0,
            category TEXT,
            issuedTo TEXT,
            issuedBy TEXT,
            mrnNum TEXT,
            purchaseSource TEXT,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_items_reqDateISO ON items(reqDateISO);
        CREATE INDEX IF NOT EXISTS idx_items_vehicle    ON items(vehicleMachinery);
        CREATE INDEX IF NOT EXISTS idx_items_mrn        ON items(mrnNum);
        CREATE INDEX IF NOT EXISTS idx_items_category   ON items(category);
        CREATE INDEX IF NOT EXISTS idx_receipts_itemId  ON receipts(itemId);
        CREATE INDEX IF NOT EXISTS idx_receipts_dateISO ON receipts(deliveryDateISO);
        CREATE INDEX IF NOT EXISTS idx_receipts_type    ON receipts(transactionType);
        CREATE INDEX IF NOT EXISTS idx_issues_vehicle   ON issues(vehicleMachinery);
        CREATE INDEX IF NOT EXISTS idx_issues_dateISO   ON issues(issueDateISO);
    `);

    // Refined migration check: drop old tables if upgrading
    try {
        const cols = all(`PRAGMA table_info(batteries)`);
        if (cols.length > 0 && !cols.some(c => c.name === 'brand')) {
            exec(`DROP TABLE IF EXISTS battery_movements;`);
            exec(`DROP TABLE IF EXISTS batteries;`);
        }
    } catch (_) {}

    exec(`
        CREATE TABLE IF NOT EXISTS batteries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serialNumber TEXT UNIQUE NOT NULL,
            itemName TEXT,
            itemDesc TEXT,
            brand TEXT,
            condition TEXT,
            state TEXT,
            currentVehicle TEXT DEFAULT '',
            purchaseDate TEXT,
            purchaseDateISO TEXT,
            expiryDate TEXT,
            expiryDateISO TEXT,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
        );

        CREATE TABLE IF NOT EXISTS battery_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batteryId INTEGER,
            serialNumber TEXT,
            movementType TEXT,
            movementDate TEXT,
            movementDateISO TEXT,
            fromLocation TEXT,
            toLocation TEXT,
            conditionAfter TEXT,
            issuedBy TEXT,
            mrnNum TEXT,
            notes TEXT,
            createdAt TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_batteries_lookup ON batteries(serialNumber, condition, state, currentVehicle);
        CREATE INDEX IF NOT EXISTS idx_movements_lookup ON battery_movements(batteryId, movementDateISO, serialNumber);
    `);

    exec(`
        CREATE TABLE IF NOT EXISTS material_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transferDate TEXT,
            transferDateISO TEXT,
            mtnNum TEXT,
            itemName TEXT,
            itemDesc TEXT,
            qty REAL DEFAULT 0,
            category TEXT,
            fromLocation TEXT,
            toLocation TEXT,
            transferredBy TEXT,
            receivedBy TEXT,
            mrnNum TEXT,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_transfers_dateISO ON material_transfers(transferDateISO);
        CREATE INDEX IF NOT EXISTS idx_transfers_from ON material_transfers(fromLocation);
        CREATE INDEX IF NOT EXISTS idx_transfers_to ON material_transfers(toLocation);
        CREATE INDEX IF NOT EXISTS idx_transfers_mtn ON material_transfers(mtnNum);
    `);

    // ---- Auth: users + sessions (combined Workshop + Store system) ---------
    exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            name TEXT,
            designation TEXT,
            email TEXT,
            roles TEXT,                       -- JSON array e.g. '["ADMIN"]'
            passwordHash TEXT,
            passwordSalt TEXT,
            active INTEGER DEFAULT 1,
            mustChangePassword INTEGER DEFAULT 0,
            createdAt TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            userId INTEGER,
            createdAt TEXT,
            expiresAt TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
    `);

    // ---- Job Cards (parent) + audit trail ----------------------------------
    exec(`
        CREATE TABLE IF NOT EXISTS jobcards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jobNo TEXT,
            type TEXT,                        -- INTERNAL | OUTSOURCED
            status TEXT,                      -- OPEN | IN_PROGRESS | ON_HOLD | COMPLETED | CLOSED
            date TEXT, dateISO TEXT,
            projectName TEXT,
            vehicleMachinery TEXT,
            meter REAL,
            repairType TEXT, repairTypeNote TEXT,
            expectedDate TEXT, expectedDateISO TEXT,
            driverName TEXT, contactNo TEXT, ecdNo TEXT,
            details TEXT,
            vendorName TEXT,
            startedAt TEXT, completedAt TEXT, closedAt TEXT, holdReason TEXT,
            labourCost REAL DEFAULT 0,        -- cached rollup of daily_programme rows
            createdBy INTEGER, createdAt TEXT, updatedAt TEXT
        );

        CREATE TABLE IF NOT EXISTS job_audits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jobCardId INTEGER,
            userId INTEGER, userName TEXT,
            action TEXT, fromStatus TEXT, toStatus TEXT, note TEXT, at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_jobcards_status  ON jobcards(status);
        CREATE INDEX IF NOT EXISTS idx_jobcards_vehicle ON jobcards(vehicleMachinery);
        CREATE INDEX IF NOT EXISTS idx_jobcards_dateISO ON jobcards(dateISO);
        CREATE INDEX IF NOT EXISTS idx_jobaudits_card   ON job_audits(jobCardId);
    `);

    // ---- Daily Programme (child of a job card) + mechanic rates ------------
    exec(`
        CREATE TABLE IF NOT EXISTS daily_programme (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            jobCardId INTEGER NOT NULL,
            entryDate TEXT, entryDateISO TEXT,
            vehicleMachinery TEXT,
            workDescription TEXT,
            mechanics TEXT,                   -- comma-separated names
            hours REAL DEFAULT 0,
            outsideValue REAL DEFAULT 0,
            remarks TEXT,
            labourCost REAL DEFAULT 0,        -- computed from mechanics + hours + rates
            createdBy INTEGER, createdAt TEXT, updatedAt TEXT
        );

        CREATE TABLE IF NOT EXISTS mechanics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            hourlyRate REAL,                  -- NULL/0 => excluded from labour cost
            active INTEGER DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_dp_jobCard ON daily_programme(jobCardId);
        CREATE INDEX IF NOT EXISTS idx_dp_dateISO ON daily_programme(entryDateISO);
    `);

    // Lightweight migration: add the category column if upgrading an older DB.
    try {
        const cols = all(`PRAGMA table_info(items)`);
        if (!cols.some(c => c.name === 'category')) {
            exec(`ALTER TABLE items ADD COLUMN category TEXT;`);
            exec(`CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);`);
        }
    } catch (e) { /* fresh DB already has it */ }

    // Migration: link MRNs (items) and issues to a job card (nullable, additive).
    ['items', 'issues'].forEach((tbl) => {
        try {
            const cols = all(`PRAGMA table_info(${tbl})`);
            if (!cols.some(c => c.name === 'jobCardId')) exec(`ALTER TABLE ${tbl} ADD COLUMN jobCardId INTEGER;`);
            if (!cols.some(c => c.name === 'jobNo')) exec(`ALTER TABLE ${tbl} ADD COLUMN jobNo TEXT;`);
        } catch (e) { /* fresh DB already has the columns */ }
    });
    try { exec(`CREATE INDEX IF NOT EXISTS idx_items_jobCardId ON items(jobCardId);`); } catch (e) {}
    try { exec(`CREATE INDEX IF NOT EXISTS idx_issues_jobCardId ON issues(jobCardId);`); } catch (e) {}

    // Migration: where a request should be purchased from ('Local' | 'Head Office').
    try {
        const cols = all(`PRAGMA table_info(items)`);
        if (!cols.some(c => c.name === 'requestSource')) exec(`ALTER TABLE items ADD COLUMN requestSource TEXT;`);
    } catch (e) { /* fresh DB already has it */ }
    try { exec(`CREATE INDEX IF NOT EXISTS idx_items_requestSource ON items(requestSource);`); } catch (e) {}

    // Migration: hard link from an issue to the request line it draws stock from.
    try {
        const cols = all(`PRAGMA table_info(issues)`);
        if (!cols.some(c => c.name === 'itemId')) exec(`ALTER TABLE issues ADD COLUMN itemId INTEGER;`);
    } catch (e) { /* fresh DB already has it */ }
    try { exec(`CREATE INDEX IF NOT EXISTS idx_issues_itemId ON issues(itemId);`); } catch (e) {}

    // Migration: a unit price on issued items so they roll into job cost.
    // NULL = unpriced; the app auto-suggests from the item's priced deliveries.
    try {
        const cols = all(`PRAGMA table_info(issues)`);
        if (!cols.some(c => c.name === 'unitPrice')) exec(`ALTER TABLE issues ADD COLUMN unitPrice REAL;`);
    } catch (e) { /* fresh DB already has it */ }

    // Migration: an externally-recorded flat cost on a job card (service-log /
    // C-job totals that predate the per-mechanic computed model). Shown for
    // reference alongside — never folded into — the computed labour+parts total.
    try {
        const cols = all(`PRAGMA table_info(jobcards)`);
        if (!cols.some(c => c.name === 'recordedCost')) exec(`ALTER TABLE jobcards ADD COLUMN recordedCost REAL;`);
    } catch (e) { /* fresh DB already has it */ }

    // Normalise purchase sources to the two canonical values. Idempotent and
    // cheap, so it runs on every boot — old spellings can never accumulate.
    try {
        run(`UPDATE receipts SET purchaseSource='Local Purchase'
              WHERE LOWER(TRIM(purchaseSource)) IN ('local store','local purchase')
                AND purchaseSource <> 'Local Purchase'`);
        run(`UPDATE receipts SET purchaseSource='Head Office Purchase'
              WHERE LOWER(TRIM(purchaseSource)) IN ('direct purchase','head office','pre-ordered','head office purchase')
                AND purchaseSource <> 'Head Office Purchase'`);
    } catch (e) { /* table may not exist yet on a brand-new DB */ }
    return db;
}

module.exports = { db, ENGINE, DB_FILE, init, all, get, run, exec, transaction, toISO, nowISO };
