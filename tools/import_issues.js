'use strict';

/**
 * import_issues.js — load general item issues (store consumables) into the system.
 *
 *   general_item_issues.xlsx  (Date · Description · Qty · Vehicle No)  ->  issues
 *
 * Dates have no year; the file is one Nov->May season, so months Nov/Dec resolve
 * to START_YEAR and Jan-May to START_YEAR+1. Each issue auto-links to a job by
 * vehicle + date window (jobcards.findMatch). Issued items carry no price, so
 * they are informational on the job card (not added to Total Job Cost).
 *
 * Idempotent: rows tagged with IMPORT_TAG are deleted + reinserted on each run;
 * afterwards every still-unlinked issue (incl. pre-existing rows) is auto-linked.
 *
 * Usage:  node tools/import_issues.js [file.xlsx] [--commit]   (no --commit = dry run)
 */

const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));
const jobcards = require(path.join(ROOT, 'jobcards'));
const { classify } = require(path.join(ROOT, 'categorize'));

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const FILE = argv.find((a) => !a.startsWith('--')) || path.join(ROOT, 'data', 'general_item_issues.xlsx');
const IMPORT_TAG = 'Imported: general items 2024/25';
const START_YEAR = 2024;   // Nov/Dec 2024 -> Jan-May 2025

db.init();

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseIssueDate(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})(?:[-\s/](\d{2,4}))?/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null) {
        const d = +m[1], mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
        let year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : (mo >= 9 ? START_YEAR : START_YEAR + 1); // Oct..Dec -> Y, else Y+1
        return new Date(Date.UTC(year, mo, d));
    }
    const dt = new Date(s);
    if (!isNaN(dt)) return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
    return null;
}
const iso = (d) => (d ? d.toISOString().slice(0, 10) : '');

function load() {
    const wb = XLSX.readFile(FILE, { cellDates: false });
    const sheet = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' }).slice(1);
    const out = [];
    rows.forEach((r) => {
        const item = String(r[2] || '').trim();
        const vehicle = String(r[4] || '').trim();
        if (!item && !vehicle) return;
        const date = parseIssueDate(r[1]);
        out.push({ date, dateISO: iso(date), rawDate: String(r[1] || '').trim(), item, qty: Number(r[3]) || 0, vehicle });
    });
    return { rows: out, sheet };
}

function main() {
    const { rows, sheet } = load();
    const withVeh = rows.filter((r) => r.vehicle).length;
    const withDate = rows.filter((r) => r.dateISO).length;
    let willMatch = 0;
    rows.forEach((r) => { if (r.vehicle && r.dateISO && jobcards.findMatch(r.vehicle, r.dateISO)) willMatch++; });

    console.log('================ General item issues import ================');
    console.log(`File "${path.basename(FILE)}" sheet "${sheet}": ${rows.length} rows  (${withVeh} with vehicle, ${withDate} with date)`);
    console.log(`Date resolution: Nov/Dec -> ${START_YEAR}, Jan-May -> ${START_YEAR + 1}`);
    console.log(`Would auto-link to a job (vehicle + date window): ${willMatch}`);
    const sample = rows.find((r) => r.dateISO && jobcards.findMatch(r.vehicle, r.dateISO));
    if (sample) { const m = jobcards.findMatch(sample.vehicle, sample.dateISO); console.log(`Sample: "${sample.rawDate}" -> ${sample.dateISO}  ${sample.vehicle}  "${sample.item}" x${sample.qty}  ->  job ${m.jobNo}`); }

    if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit to import.'); return; }

    console.log('\nWriting to inventory.db …');
    db.transaction(() => {
        db.run('DELETE FROM issues WHERE notes=?', [IMPORT_TAG]);
        const now = new Date().toISOString();
        for (const r of rows) {
            const cat = classify(r.item, '');
            const res = db.run(
                `INSERT INTO issues (issueDate, issueDateISO, vehicleMachinery, itemName, itemDesc, qty, category, issuedTo, issuedBy, mrnNum, purchaseSource, notes, createdAt, updatedAt)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [r.rawDate, r.dateISO, r.vehicle, r.item, '', r.qty, cat, '', '', '', '', IMPORT_TAG, now, now]
            );
            const m = (r.vehicle && r.dateISO) ? jobcards.findMatch(r.vehicle, r.dateISO) : null;
            if (m) { const job = db.get('SELECT jobNo FROM jobcards WHERE id=?', [m.id]); db.run('UPDATE issues SET jobCardId=?, jobNo=? WHERE id=?', [m.id, job.jobNo, res.lastInsertRowid]); }
        }
        // Link any other still-unlinked issues too (e.g. the pre-existing rows).
        const others = db.all("SELECT id, vehicleMachinery, issueDateISO FROM issues WHERE jobCardId IS NULL AND vehicleMachinery != '' AND issueDateISO != ''");
        for (const o of others) {
            const m = jobcards.findMatch(o.vehicleMachinery, o.issueDateISO);
            if (m) { const job = db.get('SELECT jobNo FROM jobcards WHERE id=?', [m.id]); db.run('UPDATE issues SET jobCardId=?, jobNo=? WHERE id=?', [m.id, job.jobNo, o.id]); }
        }
    });
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}

    const total = db.get('SELECT COUNT(*) AS c FROM issues').c;
    const linked = db.get('SELECT COUNT(*) AS c FROM issues WHERE jobCardId IS NOT NULL').c;
    console.log(`Done. issues total=${total}, linked to jobs=${linked}.`);
}

main();
