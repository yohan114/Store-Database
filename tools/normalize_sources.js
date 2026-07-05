'use strict';

/**
 * normalize_sources.js — one-time data clean-up with a printed report.
 *
 *   node tools/normalize_sources.js                     dry run: report only
 *   node tools/normalize_sources.js --commit            apply source + date fixes
 *   node tools/normalize_sources.js --commit --backfill also fill items.requestSource
 *                                                       from delivered sources
 *
 * What it does:
 *  1. Normalises receipts.purchaseSource to the two canonical values:
 *     'Local Purchase'  <- local store / local purchase
 *     'Head Office Purchase' <- direct purchase / head office / pre-ordered
 *     Anything else (combined legacy values, blanks) is left alone and listed.
 *  2. Re-derives the *ISO date columns from their display columns via toISO()
 *     and lists any dates that cannot be parsed.
 *  3. --backfill: for legacy items with requestSource NULL whose deliveries all
 *     came from one bucket, sets requestSource to 'Local' or 'Head Office'.
 */

const db = require('../db');

const COMMIT = process.argv.includes('--commit');
const BACKFILL = process.argv.includes('--backfill');

const LOCAL_ALIASES = ['local store', 'local purchase'];
const HO_ALIASES = ['direct purchase', 'head office', 'pre-ordered', 'head office purchase'];
const ph = (arr) => arr.map(() => '?').join(',');

function sourceReport(label) {
    console.log(`\n== receipts.purchaseSource distribution (${label}) ==`);
    db.all(`SELECT COALESCE(NULLIF(TRIM(purchaseSource),''),'(blank)') AS src, COUNT(*) AS n
            FROM receipts GROUP BY src ORDER BY n DESC`)
      .forEach((r) => console.log(`  ${String(r.n).padStart(6)}  ${r.src}`));
}

function main() {
    console.log(`Database: ${db.DB_FILE} (engine ${db.ENGINE})`);
    console.log(COMMIT ? 'Mode: COMMIT — changes will be written.' : 'Mode: DRY RUN — nothing will be written.');

    if (COMMIT) db.init(); // ensure requestSource/itemId columns exist before writing

    sourceReport('before');

    const toLocal = db.get(`SELECT COUNT(*) AS n FROM receipts
        WHERE LOWER(TRIM(purchaseSource)) IN (${ph(LOCAL_ALIASES)}) AND purchaseSource <> 'Local Purchase'`, LOCAL_ALIASES).n;
    const toHo = db.get(`SELECT COUNT(*) AS n FROM receipts
        WHERE LOWER(TRIM(purchaseSource)) IN (${ph(HO_ALIASES)}) AND purchaseSource <> 'Head Office Purchase'`, HO_ALIASES).n;
    console.log(`\nWill rename ${toLocal} receipt(s) -> 'Local Purchase', ${toHo} -> 'Head Office Purchase'.`);

    const odd = db.all(`SELECT COALESCE(NULLIF(TRIM(purchaseSource),''),'(blank)') AS src, COUNT(*) AS n
        FROM receipts
        WHERE LOWER(TRIM(purchaseSource)) NOT IN (${ph(LOCAL_ALIASES.concat(HO_ALIASES))})
        GROUP BY src ORDER BY n DESC`, LOCAL_ALIASES.concat(HO_ALIASES));
    if (odd.length) {
        console.log(`\nLeft untouched for manual review (counted as "Other" on the dashboard):`);
        odd.forEach((r) => console.log(`  ${String(r.n).padStart(6)}  ${r.src}`));
    }

    if (COMMIT) {
        db.transaction(() => {
            db.run(`UPDATE receipts SET purchaseSource='Local Purchase'
                    WHERE LOWER(TRIM(purchaseSource)) IN (${ph(LOCAL_ALIASES)})`, LOCAL_ALIASES);
            db.run(`UPDATE receipts SET purchaseSource='Head Office Purchase'
                    WHERE LOWER(TRIM(purchaseSource)) IN (${ph(HO_ALIASES)})`, HO_ALIASES);
        });
        sourceReport('after');
    }

    // ---- ISO date re-derivation -------------------------------------------
    const DATE_COLS = [
        ['items', 'reqDate', 'reqDateISO'],
        ['receipts', 'deliveryDate', 'deliveryDateISO'],
        ['issues', 'issueDate', 'issueDateISO'],
        ['material_transfers', 'transferDate', 'transferDateISO'],
    ];
    console.log('\n== date columns ==');
    for (const [table, col, isoCol] of DATE_COLS) {
        const rows = db.all(`SELECT id, ${col} AS d, ${isoCol} AS iso FROM ${table}
                             WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''`);
        const fixes = [];
        const bad = [];
        for (const r of rows) {
            const want = db.toISO(r.d);
            if (!want) { if (!r.iso) bad.push(r); continue; }
            // Only overwrite when the display date carries an explicit year —
            // yearless imports (e.g. "2-Nov") already have a better ISO from
            // the importer's year context, which toISO() cannot reproduce.
            const hasExplicitYear = /\d{4}/.test(String(r.d));
            if (want !== r.iso && (hasExplicitYear || !r.iso)) fixes.push({ id: r.id, iso: want });
        }
        console.log(`  ${table}.${isoCol}: ${fixes.length} to fix, ${bad.length} unparseable`);
        bad.slice(0, 10).forEach((r) => console.log(`      unparseable id=${r.id}: "${r.d}"`));
        if (COMMIT && fixes.length) {
            db.transaction(() => fixes.forEach((f) =>
                db.run(`UPDATE ${table} SET ${isoCol}=? WHERE id=?`, [f.iso, f.id])));
        }
    }

    // ---- suspect-date repair ----------------------------------------------
    // Legacy imports parsed yearless dates ("16-May") into year 2001, and one
    // typo landed in 1996. The month/day part is right; only the year is off.
    // Repair: take the median year of the nearest rows FOR THE SAME VEHICLE that
    // have a sane ISO date (a same-vehicle batch is a far better year signal than
    // arbitrary neighbouring ids), and rebuild the ISO with it. Bounded to ISO
    // years < 2020. The original ISO is preserved in dateRepairedFrom so a wrong
    // guess is recoverable, not silently overwritten (review finding 17).
    console.log('\n== suspect dates (ISO year < 2020) ==');
    const SUSPECT = [
        ['items', 'reqDate', 'reqDateISO', 'vehicleMachinery'],
        ['receipts', 'deliveryDate', 'deliveryDateISO', null],
        ['issues', 'issueDate', 'issueDateISO', 'vehicleMachinery'],
    ];
    for (const [table, col, isoCol, vehCol] of SUSPECT) {
        const bad = db.all(`SELECT id, ${col} AS d, ${isoCol} AS iso${vehCol ? `, ${vehCol} AS veh` : ''} FROM ${table}
                            WHERE ${isoCol} <> '' AND ${isoCol} < '2020'
                              AND (dateRepairedFrom IS NULL OR dateRepairedFrom = '')`);
        let repaired = 0, skipped = 0;
        for (const r of bad) {
            // Prefer same-vehicle dated rows; fall back to nearby ids only when a
            // vehicle column exists but yields nothing (or the table has none).
            let neighbours = [];
            if (vehCol && r.veh) {
                neighbours = db.all(
                    `SELECT ${isoCol} AS iso FROM ${table}
                     WHERE ${isoCol} >= '2020' AND ${isoCol} <> '' AND ${vehCol} = ? AND id <> ?
                     ORDER BY ABS(id - ?) LIMIT 10`, [r.veh, r.id, r.id]);
            }
            if (!neighbours.length) {
                neighbours = db.all(
                    `SELECT ${isoCol} AS iso FROM ${table}
                     WHERE ${isoCol} >= '2020' AND ${isoCol} <> '' AND id BETWEEN ? AND ? AND id <> ?
                     ORDER BY ABS(id - ?) LIMIT 10`, [r.id - 200, r.id + 200, r.id, r.id]);
            }
            if (!neighbours.length) { skipped++; console.log(`  ${table} id=${r.id} "${r.d}" (${r.iso}) — no dated neighbours, left as-is`); continue; }
            const years = neighbours.map((n) => parseInt(n.iso.slice(0, 4), 10)).sort((a, b) => a - b);
            const year = years[Math.floor(years.length / 2)];
            const fixedISO = `${year}${r.iso.slice(4)}`;
            repaired += 1;
            if (COMMIT) db.run(`UPDATE ${table} SET ${isoCol}=?, dateRepairedFrom=? WHERE id=?`, [fixedISO, r.iso, r.id]);
            else if (repaired <= 8) console.log(`  ${table} id=${r.id} "${r.d}": ${r.iso} -> ${fixedISO} (keeps dateRepairedFrom=${r.iso})`);
        }
        console.log(`  ${table}.${isoCol}: ${bad.length} suspect, ${repaired} ${COMMIT ? 'repaired' : 'repairable'}, ${skipped} left as-is`);
    }

    // ---- requestSource backfill -------------------------------------------
    if (BACKFILL) {
        const rows = db.all(`
            SELECT i.id,
                   SUM(CASE WHEN LOWER(TRIM(r.purchaseSource)) IN (${ph(LOCAL_ALIASES)}) THEN 1 ELSE 0 END) AS nLocal,
                   SUM(CASE WHEN LOWER(TRIM(r.purchaseSource)) IN (${ph(HO_ALIASES)}) THEN 1 ELSE 0 END) AS nHo,
                   COUNT(r.id) AS nAll
            FROM items i JOIN receipts r ON r.itemId = i.id AND r.transactionType='Receive'
            WHERE i.requestSource IS NULL
            GROUP BY i.id`, LOCAL_ALIASES.concat(HO_ALIASES));
        const local = rows.filter((r) => r.nLocal === r.nAll && r.nAll > 0);
        const ho = rows.filter((r) => r.nHo === r.nAll && r.nAll > 0);
        const mixed = rows.length - local.length - ho.length;
        console.log(`\n== requestSource backfill ==`);
        console.log(`  ${local.length} item(s) -> 'Local', ${ho.length} -> 'Head Office', ${mixed} mixed/other left NULL.`);
        if (COMMIT) {
            db.transaction(() => {
                local.forEach((r) => db.run(`UPDATE items SET requestSource='Local' WHERE id=?`, [r.id]));
                ho.forEach((r) => db.run(`UPDATE items SET requestSource='Head Office' WHERE id=?`, [r.id]));
            });
        }
    }

    console.log(COMMIT ? '\nDone — changes committed.' : '\nDry run complete — re-run with --commit to apply.');
}

main();
