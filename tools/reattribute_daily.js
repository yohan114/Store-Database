'use strict';

/**
 * reattribute_daily.js — move daily-programme labour out of the anonymous
 * per-vehicle DW-<vehicle> catch-all cards onto the real dated job it most
 * likely belongs to.
 *
 *   node tools/reattribute_daily.js                 dry run: report only
 *   node tools/reattribute_daily.js --commit        re-point + recompute labour
 *   node tools/reattribute_daily.js --commit --max-gap=30
 *
 * Why: the original workshop import matched daily work to jobs with a strict
 * ±2-day window, so most daily rows fell into DW- catch-alls. Daily work
 * carries a precise date, so attaching each catch-all row to the nearest
 * same-vehicle dated job (within --max-gap days, default 45) is reliable and
 * moves the labour cost onto actual job cards. Rows already on real jobs are
 * never touched. Labour rollups on every affected job are recomputed via
 * programme.recomputeJobLabour, so totals stay exact.
 */

const db = require('../db');
const programme = require('../programme');
const { buildJobIndex, findNearestJob } = require('./_jobmatch');

const COMMIT = process.argv.includes('--commit');
const MAX_GAP = (() => {
    const a = process.argv.find((x) => x.startsWith('--max-gap='));
    const n = a ? parseInt(a.split('=')[1], 10) : 45;
    return Number.isFinite(n) && n >= 0 ? n : 45;
})();
const nowISO = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function main() {
    db.init();
    console.log(`Database: ${db.DB_FILE} (engine ${db.ENGINE})`);
    console.log(COMMIT ? 'Mode: COMMIT — daily rows will be re-pointed.' : 'Mode: DRY RUN — nothing will be written.');
    console.log(`Nearest-job window: ${MAX_GAP} days.`);

    const byVeh = buildJobIndex();

    // Daily rows currently parked on a DW- catch-all card.
    const rows = db.all(`
        SELECT dp.id, dp.jobCardId, dp.vehicleMachinery AS veh, dp.entryDateISO AS iso, dp.labourCost AS lc
        FROM daily_programme dp JOIN jobcards j ON j.id = dp.jobCardId
        WHERE j.jobNo LIKE 'DW-%'`);

    const affected = new Set();     // jobCardIds needing a labour recompute
    let moved = 0, movedLabour = 0, stayed = 0;

    db.transaction(() => {
        for (const r of rows) {
            const iso = (r.iso && String(r.iso).trim()) ? r.iso : null;
            const nr = iso ? findNearestJob(byVeh, r.veh, iso, MAX_GAP) : null;
            if (nr && nr.job.id !== r.jobCardId) {
                if (COMMIT) {
                    db.run(`UPDATE daily_programme SET jobCardId=?, updatedAt=? WHERE id=?`, [nr.job.id, nowISO(), r.id]);
                }
                affected.add(r.jobCardId); affected.add(nr.job.id);
                moved++; movedLabour += (r.lc || 0);
            } else {
                stayed++;
            }
        }
        if (COMMIT) affected.forEach((jid) => programme.recomputeJobLabour(jid));
    });

    console.log(`\n== daily_programme re-attribution ==`);
    console.log(`  rows on DW- catch-alls:        ${rows.length}`);
    console.log(`  moved to a real dated job:     ${moved}  (Rs ${round2(movedLabour).toLocaleString()} labour)`);
    console.log(`  left on catch-all (no match):  ${stayed}`);
    console.log(`  job cards whose labour recomputes: ${affected.size}`);

    if (COMMIT) {
        // Clean up catch-all cards that no longer hold any daily rows.
        const empties = db.all(`
            SELECT j.id, j.jobNo FROM jobcards j
            WHERE j.jobNo LIKE 'DW-%'
              AND NOT EXISTS (SELECT 1 FROM daily_programme dp WHERE dp.jobCardId = j.id)
              AND NOT EXISTS (SELECT 1 FROM items    i  WHERE i.jobCardId = j.id)
              AND NOT EXISTS (SELECT 1 FROM issues   s  WHERE s.jobCardId = j.id)`);
        empties.forEach((e) => db.run(`DELETE FROM jobcards WHERE id=?`, [e.id]));
        console.log(`  emptied catch-all cards removed:   ${empties.length}`);
        const realWithLabour = db.get(`SELECT COUNT(*) n, COALESCE(SUM(labourCost),0) lc FROM jobcards WHERE jobNo NOT LIKE 'DW-%' AND labourCost>0`);
        console.log(`  real jobs with labour now:     ${realWithLabour.n}  (Rs ${round2(realWithLabour.lc).toLocaleString()})`);
    }
    console.log(COMMIT ? '\nDone — committed.' : '\nDry run complete — re-run with --commit to apply.');
}

main();
