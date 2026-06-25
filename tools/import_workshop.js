'use strict';

/**
 * import_workshop.js — load historical workshop data into the unified system.
 *
 *   Job_Record.xlsx   "Requested job" + "C-job"  -> jobcards
 *   Daily_Work_Done.xlsx "From 1st Dec2025"       -> daily_programme (attached
 *                                                    to the matching job card)
 *                        "Labor Hour"             -> mechanics (hourly rates)
 *
 * A daily line is matched to a job by vehicle + date window [start-2, end+2].
 * Multiple matches -> the single narrowest/closest job. No match -> a per-vehicle
 * catch-all job ("DW-<VEHICLE>"). Labour cost is computed with the same logic the
 * app uses (programme.computeLabour). Idempotent: jobs upsert by jobNo, and a
 * job's daily rows are replaced on re-run.
 *
 * Usage:  node tools/import_workshop.js [jobRecord.xlsx] [dailyWork.xlsx] [--commit]
 *   (no --commit = dry run: parse, match and print a summary, write nothing)
 */

const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));
const programme = require(path.join(ROOT, 'programme'));

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const fileArgs = argv.filter((a) => !a.startsWith('--'));
const JOB_XLSX = fileArgs[0] || path.join(ROOT, 'data', 'Job_Record.xlsx');
const DAILY_XLSX = fileArgs[1] || path.join(ROOT, 'data', 'Daily_Work_Done.xlsx');

const DAY = 86400000;
const WINDOW_DAYS = 2;

db.init();
programme.ensureSeedMechanics();

// --- parsing helpers --------------------------------------------------------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normVeh = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
function vehSet(v) {
    const parts = String(v || '').split(/[\/,]/).map(normVeh).filter(Boolean);
    return parts.length ? parts : [normVeh(v)].filter(Boolean);
}

/** Parse a messy date cell into a UTC Date (or null). Slash/dot dates are
 *  month-first (this dataset), with a day-first fallback when month > 12. */
function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
    let s = String(v).trim().replace(/\.$/, '');
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);          // ISO-ish
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);            // M/D/Y (month-first)
    if (m) {
        let mo = +m[1], d = +m[2], y = +m[3];
        if (y < 100) y += 2000;
        if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; }
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
    }
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})(?:[-\s](\d{2,4}))?/);   // 20-Jun / 20-Jun-26
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null) {
        const d = +m[1], mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
        let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : 2026;   // no year -> recent
        return new Date(Date.UTC(y, mo, d));
    }
    const dt = new Date(s);
    if (!isNaN(dt)) return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
    return null;
}
const iso = (d) => (d ? d.toISOString().slice(0, 10) : '');

function rows1(sheet) {
    return sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) : [];
}

// --- load jobs --------------------------------------------------------------
function loadJobs() {
    const wb = XLSX.readFile(JOB_XLSX, { cellDates: true });
    const find = (re) => wb.SheetNames.find((n) => re.test(n));
    const reqName = find(/request/i);
    const cName = find(/^c[-\s]?job/i);
    const jobs = [];
    rows1(wb.Sheets[reqName]).slice(1).forEach((r, i) => {
        const jobNo = String(r[0] || '').trim(), vehicle = String(r[1] || '').trim();
        if (!jobNo && !vehicle) return;
        jobs.push({ source: 'Requested', jobNo: jobNo || `REQ-${i + 1}`, vehicle, desc: String(r[2] || '').trim(), start: parseDate(r[3]), end: parseDate(r[4]), site: String(r[5] || '').trim(), remarks: String(r[6] || '').trim() });
    });
    rows1(wb.Sheets[cName]).slice(1).forEach((r, i) => {
        const jobNo = String(r[0] || '').trim(), vehicle = String(r[2] || '').trim();
        if (!jobNo && !vehicle) return;
        jobs.push({ source: 'C-job', jobNo: jobNo || `CJOB-${i + 1}`, ref: String(r[1] || '').trim(), vehicle, desc: String(r[3] || '').trim(), start: parseDate(r[4]), end: parseDate(r[5]), recHrs: r[6], recCost: r[7], site: String(r[8] || '').trim(), remarks: String(r[9] || '').trim() });
    });
    jobs.forEach((j) => { j.vehSet = vehSet(j.vehicle); });
    return { jobs, reqName, cName };
}

// --- load daily work + rates ------------------------------------------------
function loadDaily() {
    const wb = XLSX.readFile(DAILY_XLSX, { cellDates: true });
    const dailyName = wb.SheetNames.find((n) => /dec|daily|work|from/i.test(n)) || wb.SheetNames[0];
    const lines = [];
    rows1(wb.Sheets[dailyName]).slice(1).forEach((r) => {
        const vehicle = String(r[1] || '').trim();
        const date = parseDate(r[0]);
        if (!vehicle && !String(r[2] || '').trim()) return;
        lines.push({ date, vehicle, vehNorm: normVeh(vehicle), desc: String(r[2] || '').trim(), mechanics: String(r[3] || '').trim(), hours: Number(r[4]) || 0, outside: Number(r[5]) || 0, remarks: String(r[6] || '').trim() });
    });
    const rateName = wb.SheetNames.find((n) => /labou?r|hour|rate/i.test(n));
    const rates = [];
    if (rateName) rows1(wb.Sheets[rateName]).slice(1).forEach((r) => { const name = String(r[0] || '').trim(); const rate = Number(r[1]); if (name && !isNaN(rate) && rate > 0) rates.push({ name, rate }); });
    return { lines, rates, dailyName, rateName };
}

// --- matching ---------------------------------------------------------------
function buildJobsByVeh(jobs) {
    const map = new Map();
    jobs.forEach((j) => j.vehSet.forEach((v) => { if (!map.has(v)) map.set(v, []); map.get(v).push(j); }));
    return map;
}
function matchJob(line, jobsByVeh) {
    if (!line.date) return null;
    const t = line.date.getTime();
    const cands = (jobsByVeh.get(line.vehNorm) || []).filter((j) => {
        if (!j.start) return false;
        const start = j.start.getTime(), end = (j.end || j.start).getTime();
        return t >= start - WINDOW_DAYS * DAY && t <= end + WINDOW_DAYS * DAY;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
        const wa = (a.end || a.start) - a.start, wb = (b.end || b.start) - b.start;
        if (wa !== wb) return wa - wb;
        return Math.abs(a.start - line.date) - Math.abs(b.start - line.date);
    });
    return cands[0];
}

// --- rate map (sheet overrides seeded) --------------------------------------
function buildRateMap(rates) {
    const m = new Map();
    programme.mechanicsList().forEach((x) => { if (x.active && x.hourlyRate) m.set(normName(x.name), x.hourlyRate); });
    rates.forEach((r) => m.set(normName(r.name), r.rate));
    return m;
}

// ============================================================================
function main() {
    const { jobs, reqName, cName } = loadJobs();
    const { lines, rates, dailyName, rateName } = loadDaily();
    const jobsByVeh = buildJobsByVeh(jobs);
    const rateMap = buildRateMap(rates);

    // Match every daily line.
    let matched = 0, unmatched = 0, noDate = 0, totalLabour = 0;
    const catchVehicles = new Set();
    const noRate = new Set();
    const knownNorm = new Set([...rateMap.keys()]);
    lines.forEach((ln) => {
        if (!ln.date) noDate++;
        ln.labour = programme.computeLabour(ln.mechanics, ln.hours, rateMap);
        totalLabour += ln.labour;
        ln.job = matchJob(ln, jobsByVeh);
        if (ln.job) matched++; else { unmatched++; if (ln.vehNorm) catchVehicles.add(ln.vehNorm); }
        String(ln.mechanics || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((nm) => { if (!knownNorm.has(normName(nm))) noRate.add(nm); });
    });

    const reqCount = jobs.filter((j) => j.source === 'Requested').length;
    const cCount = jobs.filter((j) => j.source === 'C-job').length;

    console.log('================ Workshop data import ================');
    console.log(`Job_Record : "${reqName}" + "${cName}"  ->  ${reqCount} requested + ${cCount} C-jobs = ${jobs.length} job cards`);
    console.log(`Daily work : "${dailyName}"  ->  ${lines.length} lines  (matched ${matched}, unmatched ${unmatched}, no-date ${noDate})`);
    console.log(`Rates sheet: ${rateName ? `"${rateName}" (${rates.length} rates)` : '(none — using seeded rates)'}`);
    console.log(`Catch-all jobs to create (unmatched vehicles): ${catchVehicles.size}`);
    console.log(`Total computed labour across daily lines: Rs. ${totalLabour.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    if (noRate.size) console.log(`Mechanic names with NO rate (0-costed, add a rate in-app): ${[...noRate].slice(0, 20).join(', ')}${noRate.size > 20 ? ' …' : ''}`);
    const sample = lines.find((l) => l.job);
    if (sample) console.log(`Sample match: ${iso(sample.date)} ${sample.vehicle} [${sample.mechanics}] ${sample.hours}h = Rs.${sample.labour}  ->  job ${sample.job.jobNo}`);

    if (!COMMIT) {
        console.log('\nDRY RUN — nothing written. Re-run with --commit to import.');
        return;
    }

    console.log('\nWriting to inventory.db …');
    db.transaction(() => {
        const now = new Date().toISOString();
        // 1) rates sheet -> mechanics table
        rates.forEach((r) => {
            const ex = db.get('SELECT id FROM mechanics WHERE LOWER(name)=?', [r.name.toLowerCase()]);
            if (ex) db.run('UPDATE mechanics SET hourlyRate=?, active=1 WHERE id=?', [r.rate, ex.id]);
            else db.run('INSERT INTO mechanics (name, hourlyRate, active) VALUES (?,?,1)', [r.name, r.rate]);
        });

        // 2) upsert jobs by jobNo
        const jobIdByNo = new Map();
        jobs.forEach((j) => {
            const dateISO = iso(j.start), endISO = iso(j.end);
            const status = endISO ? 'CLOSED' : 'OPEN';   // ended historical jobs are terminal
            let details = j.desc || '';
            if (j.source === 'C-job' && (j.recHrs || j.recCost)) details += `\n[Recorded: ${j.recHrs || '?'} hrs, Rs.${j.recCost || '?'}]`;
            const ex = db.get('SELECT id FROM jobcards WHERE jobNo=?', [j.jobNo]);
            let id;
            if (ex) {
                id = ex.id;
                db.run('UPDATE jobcards SET type=?, status=?, date=?, dateISO=?, projectName=?, vehicleMachinery=?, expectedDate=?, expectedDateISO=?, details=?, updatedAt=? WHERE id=?',
                    ['INTERNAL', status, dateISO, dateISO, j.site, j.vehicle, endISO, endISO, details, now, id]);
            } else {
                id = db.run('INSERT INTO jobcards (jobNo, type, status, date, dateISO, projectName, vehicleMachinery, expectedDate, expectedDateISO, details, labourCost, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    [j.jobNo, 'INTERNAL', status, dateISO, dateISO, j.site, j.vehicle, endISO, endISO, details, 0, now, now]).lastInsertRowid;
            }
            jobIdByNo.set(j.jobNo, id);
            j._id = id;
        });

        // 3) per-vehicle catch-all jobs (lazy)
        const catchById = new Map();
        const catchAll = (vehNorm, label) => {
            if (catchById.has(vehNorm)) return catchById.get(vehNorm);
            const jobNo = 'DW-' + vehNorm;
            let ex = db.get('SELECT id FROM jobcards WHERE jobNo=?', [jobNo]);
            let id = ex ? ex.id : db.run('INSERT INTO jobcards (jobNo, type, status, vehicleMachinery, details, labourCost, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)',
                [jobNo, 'INTERNAL', 'COMPLETED', label, 'Auto-created to hold unscheduled daily work for ' + label, 0, now, now]).lastInsertRowid;
            catchById.set(vehNorm, id);
            return id;
        };

        // 4) resolve each daily line to a job id
        const affected = new Set();
        lines.forEach((ln) => {
            ln._jobId = ln.job ? ln.job._id : (ln.vehNorm ? catchAll(ln.vehNorm, ln.vehicle) : null);
            if (ln._jobId) affected.add(ln._jobId);
        });

        // 5) replace daily_programme for affected jobs, then insert fresh
        affected.forEach((id) => db.run('DELETE FROM daily_programme WHERE jobCardId=?', [id]));
        lines.forEach((ln) => {
            if (!ln._jobId) return;
            db.run(`INSERT INTO daily_programme (jobCardId, entryDate, entryDateISO, vehicleMachinery, workDescription, mechanics, hours, outsideValue, remarks, labourCost, createdAt, updatedAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [ln._jobId, iso(ln.date), iso(ln.date), ln.vehicle, ln.desc, ln.mechanics, ln.hours, ln.outside, ln.remarks, ln.labour, now, now]);
        });

        // 6) recompute labour rollup for every affected job
        affected.forEach((id) => programme.recomputeJobLabour(id));
    });

    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}

    const jc = db.get('SELECT COUNT(*) c FROM jobcards').c;
    const dp = db.get('SELECT COUNT(*) c FROM daily_programme').c;
    const lab = db.get('SELECT COALESCE(SUM(labourCost),0) s FROM jobcards').s;
    console.log(`Done. jobcards=${jc}, daily_programme=${dp}, total job labour=Rs.${Number(lab).toLocaleString()}`);
}

main();
