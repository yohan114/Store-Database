/**
 * migrate_to_sqlite.js — One-time migration into the fast SQLite database.
 *
 * Source priority (first that works wins):
 *   1. Live inventory.accdb via PowerShell/ACE-OLEDB  (Windows — freshest data)
 *   2. test_output.json   (faithful dump of the live DB, current schema + ids)
 *   3. tracker_data.json  (legacy snapshot, older field names)
 *
 * Safe + idempotent: refuses to run if the SQLite DB already has items,
 * unless you pass --force (which wipes items/receipts first).
 *
 * Usage:  node migrate_to_sqlite.js          (skip if already populated)
 *         node migrate_to_sqlite.js --force   (re-import from scratch)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dbApi = require('./db');
const { classify } = require('./categorize');

const FORCE = process.argv.includes('--force');
const ACCDB_PATH = path.join(__dirname, 'inventory.accdb');

// Build a name-restore map from the legacy snapshot (keyed by MRN number).
// The original migration lost item names; this lets us recover them.
function buildNameBackfill() {
    const map = new Map(); // mrnNum -> [names...] (FIFO for duplicate MRNs)
    const p = path.join(__dirname, 'tracker_data.json');
    if (!fs.existsSync(p)) return map;
    try {
        const legacy = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const it of legacy) {
            const name = (it.name || it.itemName || '').trim();
            if (!name) continue;
            const key = String(it.mrnNum || '');
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(name);
        }
    } catch (_) {}
    return map;
}

function readFromAccdb() {
    if (!fs.existsSync(ACCDB_PATH)) return null;
    const psScript = `
$ErrorActionPreference = 'Stop'
$dbPath = '${ACCDB_PATH.replace(/'/g, "''")}'
$conn = New-Object System.Data.OleDb.OleDbConnection
$conn.ConnectionString = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;"
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT * FROM items"
$r = $cmd.ExecuteReader()
$items = @()
while ($r.Read()) {
    $items += @{ id=$r["id"]; mrnNum=$r["mrnNum"]; reqDate=$r["reqDate"]; vehicleMachinery=$r["vehicleMachinery"]; itemName=$r["itemName"]; itemDesc=$r["itemDesc"]; reqQty=$r["reqQty"] }
}
$r.Close()
$cmd.CommandText = "SELECT * FROM receipts"
$r = $cmd.ExecuteReader()
$receipts = @()
while ($r.Read()) {
    $receipts += @{ id=$r["id"]; itemId=$r["itemId"]; qty=$r["qty"]; transactionType=$r["transactionType"]; deliveryDate=$r["deliveryDate"]; purchaseSource=$r["purchaseSource"]; grnNumber=$r["grnNumber"]; invoiceNumber=$r["invoiceNumber"]; invoiceDate=$r["invoiceDate"]; supplierName=$r["supplierName"]; unitPrice=$r["unitPrice"] }
}
$r.Close(); $conn.Close()
@{ items=$items; receipts=$receipts } | ConvertTo-Json -Depth 5 -Compress
`;
    const tmp = path.join(__dirname, '_migrate_read.ps1');
    fs.writeFileSync(tmp, psScript, 'utf8');
    try {
        const out = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`, {
            encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 200
        });
        const data = JSON.parse(out.trim() || '{}');
        const byItem = {};
        (data.receipts || []).forEach(rc => {
            (byItem[rc.itemId] = byItem[rc.itemId] || []).push(rc);
        });
        return (data.items || []).map(it => ({ ...it, receipts: byItem[it.id] || [] }));
    } catch (e) {
        return null; // not on Windows / ACE not installed — fall through to JSON
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

function readFromJson() {
    // tracker_data.json first: it still has the real item names (test_output.json lost them).
    for (const file of ['tracker_data.json', 'test_output.json']) {
        const p = path.join(__dirname, file);
        if (!fs.existsSync(p)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(raw) && raw.length) {
                console.log(`Reading source data from ${file} (${raw.length} items)`);
                return raw;
            }
        } catch (e) {
            console.warn(`Could not parse ${file}: ${e.message}`);
        }
    }
    return null;
}

// Normalize any source record (current OR legacy schema) into a canonical shape.
function normalize(raw, nameBackfill) {
    return raw.map(it => {
        let itemName = (it.itemName || it.name || '').trim();
        const mrnKey = String(it.mrnNum || '');
        // Restore lost names from the legacy snapshot when the source is blank.
        if (!itemName && nameBackfill && nameBackfill.has(mrnKey)) {
            const queue = nameBackfill.get(mrnKey);
            if (queue.length) itemName = queue.shift();
        }
        const itemDesc = it.itemDesc || '';
        return {
            srcId: it.id != null ? Number(it.id) : null,
            mrnNum: it.mrnNum || '',
            reqDate: it.reqDate || '',
            vehicleMachinery: it.vehicleMachinery || '',
            itemName,
            itemDesc,
            reqQty: Number(it.reqQty) || 0,
            category: classify(itemName, itemDesc),
        receipts: (it.receipts || []).map(r => ({
            qty: Number(r.qty) || 0,
            transactionType: r.transactionType || r.type || 'Receive',
            deliveryDate: r.deliveryDate || r.date || '',
            purchaseSource: r.purchaseSource || r.source || '',
            grnNumber: r.grnNumber || '',
            invoiceNumber: r.invoiceNumber || '',
            invoiceDate: r.invoiceDate || '',
            supplierName: r.supplierName || '',
            unitPrice: (r.unitPrice === 0 || r.unitPrice == null || r.unitPrice === '') ? null : Number(r.unitPrice)
        }))
        };
    });
}

function main() {
    dbApi.init();

    const existing = dbApi.get('SELECT COUNT(*) AS c FROM items');
    if (existing.c > 0 && !FORCE) {
        console.log(`SQLite DB already has ${existing.c} items. Use --force to re-import. Skipping.`);
        return;
    }
    if (FORCE) {
        dbApi.exec('DELETE FROM receipts; DELETE FROM items;');
        try { dbApi.exec("DELETE FROM sqlite_sequence WHERE name IN ('items','receipts');"); } catch (_) {}
        console.log('--force: cleared existing items & receipts.');
    }

    let source = readFromAccdb();
    if (source) {
        console.log(`Read ${source.length} items from live inventory.accdb (Windows).`);
    } else {
        source = readFromJson();
    }
    if (!source || !source.length) {
        console.log('No source data found to migrate. Schema is ready and empty.');
        return;
    }

    const records = normalize(source, buildNameBackfill());
    const now = dbApi.nowISO();

    const insItem = `INSERT INTO items (id, mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insItemAuto = `INSERT INTO items (mrnNum, reqDate, reqDateISO, vehicleMachinery, itemName, itemDesc, reqQty, category, createdAt, updatedAt)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insRec = `INSERT INTO receipts (itemId, qty, transactionType, deliveryDate, deliveryDateISO, purchaseSource, grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    let itemCount = 0, receiptCount = 0;
    dbApi.transaction(() => {
        for (const it of records) {
            let itemId;
            if (it.srcId != null) {
                dbApi.run(insItem, [it.srcId, it.mrnNum, it.reqDate, dbApi.toISO(it.reqDate), it.vehicleMachinery, it.itemName, it.itemDesc, it.reqQty, it.category, now, now]);
                itemId = it.srcId;
            } else {
                const res = dbApi.run(insItemAuto, [it.mrnNum, it.reqDate, dbApi.toISO(it.reqDate), it.vehicleMachinery, it.itemName, it.itemDesc, it.reqQty, it.category, now, now]);
                itemId = res.lastInsertRowid;
            }
            itemCount++;
            for (const r of it.receipts) {
                dbApi.run(insRec, [itemId, r.qty, r.transactionType, r.deliveryDate, dbApi.toISO(r.deliveryDate), r.purchaseSource, r.grnNumber, r.invoiceNumber, r.invoiceDate, r.supplierName, r.unitPrice]);
                receiptCount++;
            }
        }
    });

    console.log(`[OK] Migration complete using ${dbApi.ENGINE}: ${itemCount} items, ${receiptCount} receipts imported into ${dbApi.DB_FILE}`);
}

main();
