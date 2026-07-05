'use strict';

/**
 * _jobmatch.js — shared "nearest dated job for a vehicle+date" helpers, used by
 * the link_all_to_jobs and reattribute_daily backfill tools. Builds on the
 * app's own vehicle tokenisation (jobcards.vehSet/normVeh) so attribution
 * matches the live auto-linker's notion of a vehicle.
 */

const db = require('../db');
const jobcards = require('../jobcards');
const { WINDOW_DAYS } = require('../config');   // same claim window as the live matcher

const DAY = 86400000;
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Dated REAL jobs (excludes DW- catch-alls) indexed by normalised vehicle token,
// each pre-stamped with its claim window [start-2 … (expected||start)+2].
function buildJobIndex() {
    const jobs = db.all(`SELECT id, jobNo, vehicleMachinery AS v, dateISO, expectedDateISO AS e
                         FROM jobcards
                         WHERE dateISO IS NOT NULL AND dateISO <> '' AND jobNo NOT LIKE 'DW-%'`);
    const byVeh = new Map();
    for (const j of jobs) {
        const hiBase = (j.e && String(j.e).trim()) ? j.e : j.dateISO;
        j._lo = addDays(j.dateISO, -WINDOW_DAYS);
        j._hi = addDays(hiBase, WINDOW_DAYS);
        j._span = (new Date(j._hi) - new Date(j._lo)) / DAY;
        for (const v of jobcards.vehSet(j.v)) {
            if (!byVeh.has(v)) byVeh.set(v, []);
            byVeh.get(v).push(j);
        }
    }
    return byVeh;
}

// Gap in days between a date and a [lo,hi] window (0 if inside).
function windowGap(iso, lo, hi) {
    const d = +new Date(iso), a = +new Date(lo), b = +new Date(hi);
    if (d >= a && d <= b) return 0;
    return d < a ? (a - d) / DAY : (d - b) / DAY;
}

// Nearest same-vehicle dated job within maxGap; smallest gap wins, then narrowest span.
function findNearestJob(byVeh, vehicle, dateISO, maxGap) {
    let best = null, bestGap = Infinity;
    for (const v of jobcards.vehSet(vehicle)) {
        for (const j of (byVeh.get(v) || [])) {
            const g = windowGap(dateISO, j._lo, j._hi);
            if (g < bestGap || (g === bestGap && best && j._span < best._span)) { best = j; bestGap = g; }
        }
    }
    return best && bestGap <= maxGap ? { job: best, gap: bestGap } : null;
}

module.exports = { buildJobIndex, findNearestJob, windowGap, addDays, DAY };
