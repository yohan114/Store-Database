'use strict';

/**
 * import_service.js — import the "service" sheet of data/Job_Record.xlsx into
 * jobcards. These are quick service entries (oil/filter changes) with a flat
 * PRE-COMPUTED cost (Labor + filter + oil = Total), not the per-mechanic
 * labour model — so the total is stored in jobcards.recordedCost (shown for
 * reference) and NOT in the computed labour/parts fields.
 *
 *   node tools/import_service.js                dry run: report only
 *   node tools/import_service.js --commit       upsert service jobcards
 *
 * Idempotent: rows with a real "JOB NO" (e.g. 2025/4/S/188) upsert by that
 * number; rows without one get a deterministic SVC-<dateISO>-<vehicle> number
 * so re-runs update rather than duplicate.
 */

const path = require('path');
const XLSX = require('xlsx');
const db = require('../db');

const COMMIT = process.argv.includes('--commit');
const FILE = process.argv.find((a) => a.endsWith('.xlsx')) || path.join(__dirname, '..', 'data', 'Job_Record.xlsx');
const nowISO = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const s = (v) => (v == null ? '' : String(v).trim());

// Service-sheet dates are text "DD.MM.YYYY"; also tolerate real Excel dates + ISO.
function serviceISO(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    const str = String(v).trim();
    let m = str.match(/^(\d{1,2})[.](\d{1,2})[.](\d{2,4})$/);   // DD.MM.YYYY
    if (m) { let [_, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`; }
    return db.toISO(str);   // fall back to the app's parser for / and - forms
}
const normVeh = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

function main() {
    db.init();
    console.log(`Database: ${db.DB_FILE} (engine ${db.ENGINE})`);
    console.log(`Source:   ${FILE} [sheet "service"]`);
    console.log(COMMIT ? 'Mode: COMMIT — service jobcards will be upserted.' : 'Mode: DRY RUN — nothing will be written.');

    const wb = XLSX.readFile(FILE);
    const ws = wb.Sheets['service'];
    if (!ws) { console.error('No "service" sheet found.'); process.exit(1); }
    const raw = XLSX.utils.sheet_to_json(ws, { defval: null });

    // Keep rows that identify a vehicle (skip the blank spacer rows).
    const rows = raw.filter((r) => s(r['Vehicle No']) || s(r['JOB NO']));
    let created = 0, updated = 0, skipped = 0, withNo = 0, synth = 0;
    const seen = new Set();

    db.transaction(() => {
        for (const r of rows) {
            const veh = s(r['Vehicle No']);
            if (!veh) { skipped++; continue; }
            const iso = serviceISO(r['DATE']);
            let jobNo = s(r['JOB NO']);
            if (jobNo) withNo++;
            else { jobNo = `SVC-${iso || 'NODATE'}-${normVeh(veh)}`; synth++; }
            // De-dup synthetic collisions within one run (same date+vehicle).
            let uniq = jobNo, n = 2;
            while (seen.has(uniq)) uniq = `${jobNo}#${n++}`;
            seen.add(uniq);
            jobNo = uniq;

            const total = round2(r['Total cost']);
            const costNote = ['Labor', 'filter', 'oil'].map((k) => {
                const key = k === 'Labor' ? 'Labor cost' : `${k} cost`;
                const v = r[key]; return (v != null && v !== '' && Number(v)) ? `${k}: Rs.${round2(v)}` : null;
            }).filter(Boolean).join(', ');
            const details = [s(r['DESCRIPTION']), costNote ? `[recorded ${costNote}${total ? ` → total Rs.${total}` : ''}]` : '', s(r['Remarks'])]
                .filter(Boolean).join('  ');

            const existing = db.get('SELECT id FROM jobcards WHERE jobNo=?', [jobNo]);
            if (COMMIT) {
                if (existing) {
                    db.run(`UPDATE jobcards SET vehicleMachinery=?, date=?, dateISO=?, repairType='Service', details=?, recordedCost=?, status='CLOSED', type='INTERNAL', updatedAt=? WHERE id=?`,
                        [veh, s(r['DATE']), iso, details, total || null, nowISO(), existing.id]);
                    updated++;
                } else {
                    db.run(`INSERT INTO jobcards (jobNo, type, status, date, dateISO, vehicleMachinery, repairType, details, recordedCost, createdAt, updatedAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                        [jobNo, 'INTERNAL', 'CLOSED', s(r['DATE']), iso, veh, 'Service', details, total || null, nowISO(), nowISO()]);
                    created++;
                }
            } else {
                existing ? updated++ : created++;
            }
        }
    });

    console.log(`\n== service import ==`);
    console.log(`  rows with a vehicle:        ${rows.length}`);
    console.log(`  with a real /S/ job number: ${withNo}`);
    console.log(`  synthesised SVC- numbers:   ${synth}`);
    console.log(`  ${COMMIT ? 'created' : 'would create'}: ${created}   ${COMMIT ? 'updated' : 'would update'}: ${updated}   skipped: ${skipped}`);
    console.log(COMMIT ? '\nDone — committed.' : '\nDry run complete — re-run with --commit to apply.');
}

main();
