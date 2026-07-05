'use strict';

/**
 * link_all_to_jobs.js — backfill the job link on historical items & issues.
 *
 *   node tools/link_all_to_jobs.js                         dry run: report only
 *   node tools/link_all_to_jobs.js --commit                write jobCardId/jobNo
 *   node tools/link_all_to_jobs.js --commit --catchall     also sweep leftovers
 *                                                          into per-vehicle DW-<veh>
 *   node tools/link_all_to_jobs.js --max-gap=45            widen/narrow tier-2 window
 *
 * Only rows with a NULL jobCardId are touched — already-linked rows are never
 * re-pointed. Materials/issues are attributed to a job in three tiers:
 *
 *   1. EXACT  — the request/issue date falls inside a same-vehicle job's window
 *               (jobcards.findMatch, WINDOW_DAYS=2). Identical to the live
 *               auto-linker.
 *   2. NEAR   — no exact window, but the same vehicle has a dated job within
 *               --max-gap days (default 60). Attributed to the nearest such job.
 *               (MRN request dates typically lead/lag the job date by weeks.)
 *   3. CATCH  — everything else (vehicle has no dated job, or all jobs too far):
 *               swept into a per-vehicle DW-<vehicle> catch-all when --catchall.
 */

const db = require('../db');
const jobcards = require('../jobcards');
const { buildJobIndex, findNearestJob } = require('./_jobmatch');
const { NEAR_MAX_GAP_DAYS } = require('../config');

const COMMIT = process.argv.includes('--commit');
const CATCHALL = process.argv.includes('--catchall');
const MAX_GAP = (() => {
    const a = process.argv.find((x) => x.startsWith('--max-gap='));
    const n = a ? parseInt(a.split('=')[1], 10) : NEAR_MAX_GAP_DAYS;
    return Number.isFinite(n) && n >= 0 ? n : NEAR_MAX_GAP_DAYS;
})();
const nowISO = () => new Date().toISOString();

function linkRow(table, id, jobCardId, jobNo) {
    db.run(`UPDATE ${table} SET jobCardId=?, jobNo=?, updatedAt=? WHERE id=?`, [jobCardId, jobNo, nowISO(), id]);
}

function backfill(table, dateCol, byVeh) {
    const rows = db.all(`SELECT id, vehicleMachinery AS veh, ${dateCol} AS iso FROM ${table} WHERE jobCardId IS NULL`);
    const stats = { total: rows.length, exact: 0, near: 0, caught: 0, unmatched: 0 };
    const catchCache = new Map();
    db.transaction(() => {
        for (const r of rows) {
            const iso = (r.iso && String(r.iso).trim()) ? r.iso : null;
            let job = iso ? jobcards.findMatch(r.veh, iso) : null;
            if (job) { stats.exact++; }
            else if (iso) { const nr = findNearestJob(byVeh, r.veh, iso, MAX_GAP); if (nr) { job = nr.job; stats.near++; } }

            if (job) {
                if (COMMIT) linkRow(table, r.id, job.id, job.jobNo);
                continue;
            }
            if (CATCHALL && String(r.veh || '').trim()) {
                const key = jobcards.normVeh(r.veh);
                // getOrCreateCatchAll returns the catch-all job's id; its jobNo is DW-<veh>.
                let ccId = catchCache.get(key);
                if (ccId === undefined && COMMIT) { ccId = jobcards.getOrCreateCatchAll(r.veh); catchCache.set(key, ccId); }
                if (COMMIT && ccId) linkRow(table, r.id, ccId, 'DW-' + key);
                stats.caught++;
            } else {
                stats.unmatched++;
            }
        }
    });
    return stats;
}

function main() {
    db.init();
    console.log(`Database: ${db.DB_FILE} (engine ${db.ENGINE})`);
    console.log(COMMIT ? 'Mode: COMMIT — links will be written.' : 'Mode: DRY RUN — nothing will be written.');
    console.log(`Tier-2 (NEAR) window: ${MAX_GAP} days.  Leftovers: ${CATCHALL ? 'swept into DW-<vehicle> catch-all.' : 'left unlinked (pass --catchall to sweep).'}`);

    const byVeh = buildJobIndex();
    for (const [table, dateCol] of [['items', 'reqDateISO'], ['issues', 'issueDateISO']]) {
        const before = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE jobCardId IS NULL`).n;
        const st = backfill(table, dateCol, byVeh);
        console.log(`\n== ${table} (unlinked before: ${before}) ==`);
        console.log(`  EXACT  (±2d window):        ${st.exact}`);
        console.log(`  NEAR   (≤${MAX_GAP}d nearest job):    ${st.near}`);
        console.log(`  CATCH  (per-vehicle DW-):   ${st.caught}${CATCHALL ? '' : ' (would sweep, with --catchall)'}`);
        console.log(`  still UNMATCHED:            ${st.unmatched}`);
        if (COMMIT) console.log(`  unlinked after:            ${db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE jobCardId IS NULL`).n}`);
    }
    console.log(COMMIT ? '\nDone — links committed.' : '\nDry run complete — re-run with --commit --catchall to apply.');
}

main();
