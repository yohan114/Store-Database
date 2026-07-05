'use strict';

/**
 * programme.js — Daily Programme service + in-app labour costing.
 *
 * A Daily Programme entry is a child of a Job Card (jobCardId): one row per
 * day of work, recording the mechanics, hours, work done and remarks. This
 * replaces the offline Daily_Work_Done.xlsx + tools/import_job_costs.py flow.
 *
 * Labour cost mirrors import_job_costs.py `line_cost()`: a line's hours are
 * split equally across its named mechanics and each share is costed at that
 * mechanic's hourly rate (unrated names — foreman/external — contribute Rs.0).
 * Rates live in the editable `mechanics` table; known typo/alias spellings are
 * folded to a canonical name here so historical entries still cost correctly.
 */

const db = require('./db');

// Seed rates + canonical names (from tools/import_job_costs.py RATES/CANON).
const SEED_MECHANICS = [
    ['Anura', 425], ['Buddhika', 425], ['Dinesh', 425], ['Nawathilaka', 425],
    ['Saman', 425], ['Ruwan', 425], ['Theminda', 425], ['Kumara', 425],
    ['Vinod', 375], ['Seethananda', 400],
    ['Chaminda', 250], ['Krishna', 250], ['Govinda', 250], ['Theshan', 250],
    ['Jayaweera', 250], ['Nimesh', 250], ['Vinod M', 250], ['Herath', 250],
    ['Nimal', 200],
    ['Viboda', 125], ['Manula', 125], ['Tharusha', 125], ['Trainee Mechanic', 125],
    ['Dileepa', null], ['Dilip', null], ['External', null],
];

// Normalised alias spelling -> normalised canonical name.
const ALIASES = {
    'nawathilake': 'nawathilaka',
    'samanpriya': 'saman',
    'themindu': 'theminda',
    'tm (wijesuriya)': 'kumara',
    'electrical vinod': 'vinod',
    'seetha': 'seethananda',
    'krishan': 'krishna',
    'vinoth': 'vinod m',
};

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const splitMechanics = (raw) => String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function ensureSeedMechanics() {
    const row = db.get('SELECT COUNT(*) AS c FROM mechanics');
    if (row && row.c > 0) return;
    db.transaction(() => {
        SEED_MECHANICS.forEach(([name, rate]) => {
            db.run('INSERT OR IGNORE INTO mechanics (name, hourlyRate, active) VALUES (?,?,1)', [name, rate]);
        });
    });
    console.log(`  Seeded ${SEED_MECHANICS.length} mechanic rates for labour costing.`);
}

/** Map of normalised mechanic name -> hourlyRate (only rated, active mechanics). */
function rateMap() {
    const rows = db.all('SELECT name, hourlyRate FROM mechanics WHERE active=1 AND hourlyRate IS NOT NULL AND hourlyRate > 0');
    const m = new Map();
    rows.forEach((r) => m.set(normName(r.name), r.hourlyRate));
    return m;
}

function rateFor(name, map) {
    let n = normName(name);
    if (ALIASES[n]) n = ALIASES[n];
    return map.has(n) ? map.get(n) : null;
}

/** Labour cost for one daily line: each named mechanic is costed at the FULL
 *  hours × their rate (two mechanics for 8h = both × 8h), summed. Unrated
 *  names (foreman/external) contribute Rs.0. */
function computeLabour(mechanicsStr, hours, map) {
    const mechs = splitMechanics(mechanicsStr);
    const h = Number(hours) || 0;
    if (!mechs.length || h <= 0) return 0;
    const rm = map || rateMap();
    let total = 0;
    for (const m of mechs) {
        const r = rateFor(m, rm);
        if (r) total += h * r;
    }
    return round2(total);
}

function recomputeJobLabour(jobCardId) {
    const row = db.get('SELECT COALESCE(SUM(labourCost),0) AS s FROM daily_programme WHERE jobCardId=?', [jobCardId]);
    const total = round2(row ? row.s : 0);
    db.run('UPDATE jobcards SET labourCost=?, updatedAt=? WHERE id=?', [total, new Date().toISOString(), jobCardId]);
    return total;
}

function listForJob(jobCardId) {
    return db.all('SELECT * FROM daily_programme WHERE jobCardId=? ORDER BY entryDateISO DESC, id DESC', [jobCardId]);
}

function listByDate(dateISO) {
    return db.all(
        `SELECT dp.*, j.jobNo AS jobNo, j.status AS jobStatus
         FROM daily_programme dp LEFT JOIN jobcards j ON j.id = dp.jobCardId
         WHERE dp.entryDateISO = ? ORDER BY dp.id DESC`,
        [dateISO]
    );
}

const s = (v) => (v === null || v === undefined) ? '' : String(v).trim();
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? 0 : Number(v);

function create(jobCardId, form, user) {
    const job = db.get('SELECT id, vehicleMachinery FROM jobcards WHERE id=?', [jobCardId]);
    if (!job) return { error: 'Job card not found.' };
    const now = new Date().toISOString();
    const labour = computeLabour(form.mechanics, form.hours);
    const r = db.run(
        `INSERT INTO daily_programme
         (jobCardId, entryDate, entryDateISO, vehicleMachinery, workDescription, mechanics, hours, outsideValue, remarks, labourCost, createdBy, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jobCardId, s(form.entryDate) || now.slice(0, 10), db.toISO(form.entryDate) || now.slice(0, 10),
         s(form.vehicleMachinery) || s(job.vehicleMachinery), s(form.workDescription), s(form.mechanics),
         num(form.hours), num(form.outsideValue), s(form.remarks), labour, user ? user.id : null, now, now]
    );
    recomputeJobLabour(jobCardId);
    return { entry: db.get('SELECT * FROM daily_programme WHERE id=?', [r.lastInsertRowid]) };
}

function update(id, form, user) {
    const existing = db.get('SELECT * FROM daily_programme WHERE id=?', [id]);
    if (!existing) return { error: 'Entry not found.' };
    const labour = computeLabour(form.mechanics, form.hours);
    db.run(
        `UPDATE daily_programme SET entryDate=?, entryDateISO=?, vehicleMachinery=?, workDescription=?,
            mechanics=?, hours=?, outsideValue=?, remarks=?, labourCost=?, updatedAt=? WHERE id=?`,
        [s(form.entryDate) || existing.entryDate, db.toISO(form.entryDate) || existing.entryDateISO,
         s(form.vehicleMachinery), s(form.workDescription), s(form.mechanics), num(form.hours),
         num(form.outsideValue), s(form.remarks), labour, new Date().toISOString(), id]
    );
    recomputeJobLabour(existing.jobCardId);
    return { entry: db.get('SELECT * FROM daily_programme WHERE id=?', [id]) };
}

function remove(id) {
    const existing = db.get('SELECT jobCardId FROM daily_programme WHERE id=?', [id]);
    if (!existing) return { success: true };
    db.run('DELETE FROM daily_programme WHERE id=?', [id]);
    recomputeJobLabour(existing.jobCardId);
    return { success: true };
}

// ---- Mechanics admin -------------------------------------------------------
function mechanicsList() {
    return db.all('SELECT * FROM mechanics ORDER BY (hourlyRate IS NULL), hourlyRate DESC, name COLLATE NOCASE');
}
function mechanicAdd(form) {
    const name = s(form.name);
    if (!name) return { error: 'Name is required.' };
    const rate = (form.hourlyRate === '' || form.hourlyRate == null) ? null : Number(form.hourlyRate);
    try {
        const r = db.run('INSERT INTO mechanics (name, hourlyRate, active) VALUES (?,?,1)', [name, rate]);
        return { mechanic: db.get('SELECT * FROM mechanics WHERE id=?', [r.lastInsertRowid]) };
    } catch (e) { return { error: 'A mechanic with that name already exists.' }; }
}
function mechanicUpdate(id, form) {
    const existing = db.get('SELECT * FROM mechanics WHERE id=?', [id]);
    if (!existing) return { error: 'Not found.' };
    const rate = (form.hourlyRate === '' || form.hourlyRate == null) ? null : Number(form.hourlyRate);
    const active = (form.active === undefined) ? existing.active : (form.active ? 1 : 0);
    db.run('UPDATE mechanics SET name=?, hourlyRate=?, active=? WHERE id=?', [s(form.name) || existing.name, rate, active, id]);
    return { mechanic: db.get('SELECT * FROM mechanics WHERE id=?', [id]) };
}

module.exports = {
    ensureSeedMechanics, computeLabour, recomputeJobLabour,
    listForJob, listByDate, create, update, remove,
    mechanicsList, mechanicAdd, mechanicUpdate, rateMap, rateFor,
};
