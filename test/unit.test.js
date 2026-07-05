'use strict';

/**
 * Unit tests for the risky pure logic — cost math, the source taxonomy, the
 * per-mechanic labour rule, the vehicle tokeniser and the request state machine.
 * Run with `npm test` (node:test). No live DB: INVENTORY_DB is pointed at a
 * throwaway temp path before any module that opens the database is required.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `unit_${process.pid}.db`);
process.env.INVENTORY_DB = TMP_DB;
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch (_) {} } });

const costing = require('../costing');
const config = require('../config');

// ---- costing: the one job-cost rule --------------------------------------
test('jobTotal = max(computed, recordedCost) — surfaces recorded, no double count', () => {
    assert.equal(costing.jobTotal({ labourCost: 100, receivedPartsCost: 50, issuesCost: 25, recordedCost: 0 }), 175);
    assert.equal(costing.jobTotal({ labourCost: 100, receivedPartsCost: 50, issuesCost: 25, recordedCost: 500 }), 500);
    assert.equal(costing.jobTotal({ labourCost: 100, receivedPartsCost: 50, issuesCost: 25, recordedCost: 100 }), 175);
    assert.equal(costing.jobTotal({ labourCost: 0, receivedPartsCost: 0, issuesCost: 0, recordedCost: null }), 0);
});

test('computedCost = labour + received parts + priced issues', () => {
    assert.equal(costing.computedCost({ labourCost: 6400, receivedPartsCost: 500, issuesCost: 100 }), 7000);
});

// ---- costing: one source taxonomy ----------------------------------------
test('canonicalPurchaseSource folds every alias', () => {
    assert.equal(costing.canonicalPurchaseSource('local store'), 'Local Purchase');
    assert.equal(costing.canonicalPurchaseSource('LOCAL'), 'Local Purchase');
    assert.equal(costing.canonicalPurchaseSource('Direct Purchase'), 'Head Office Purchase');
    assert.equal(costing.canonicalPurchaseSource('pre-ordered'), 'Head Office Purchase');
    assert.equal(costing.canonicalPurchaseSource('Something Else'), 'Something Else');
    assert.equal(costing.canonicalPurchaseSource(''), '');
});

test('normRequestSource maps to Local / Head Office or null', () => {
    assert.equal(costing.normRequestSource('local'), 'Local');
    assert.equal(costing.normRequestSource('Head Office'), 'Head Office');
    assert.equal(costing.normRequestSource('headoffice'), 'Head Office');
    assert.equal(costing.normRequestSource('nonsense'), null);
});

test('originCaseSql references both buckets', () => {
    const sql = costing.originCaseSql('p.purchaseSource');
    assert.match(sql, /'headOffice'/);
    assert.match(sql, /'local'/);
    assert.match(sql, /p\.purchaseSource/);
});

// ---- config: matcher window is a single source of truth ------------------
test('config exposes the matcher + retention knobs', () => {
    assert.equal(config.WINDOW_DAYS, 2);
    assert.equal(config.NEAR_MAX_GAP_DAYS, 60);
    assert.ok(config.BACKUP_INTERVAL_MS > 0);
    assert.ok(config.LOGIN_MAX_FAILS >= 1);
});

// ---- labour: each mechanic × FULL hours ----------------------------------
test('computeLabour costs each named mechanic at full hours', () => {
    const programme = require('../programme');
    const rates = new Map([['saman', 340], ['ruwan', 250], ['govinda', 425]]);
    // "saman, ruwan, govinda - 10hr" → each × 10h, summed.
    assert.equal(programme.computeLabour('saman, ruwan, govinda', 10, rates), 10 * (340 + 250 + 425));
    // Unrated names contribute nothing; rated ones still count.
    assert.equal(programme.computeLabour('saman, foreman', 8, rates), 8 * 340);
    assert.equal(programme.computeLabour('', 8, rates), 0);
    assert.equal(programme.computeLabour('saman', 0, rates), 0);
});

// ---- vehicle tokeniser (matcher) -----------------------------------------
test('normVeh strips spaces + uppercases; vehSet splits multi-vehicle', () => {
    const jobcards = require('../jobcards');
    assert.equal(jobcards.normVeh(' ab 12 '), 'AB12');
    assert.deepEqual(jobcards.vehSet('AB-12 / CD-34'), ['AB-12', 'CD-34']);
    assert.deepEqual(jobcards.vehSet('ZZ 9'), ['ZZ9']);
});

// ---- request state machine (pure transition table) -----------------------
test('job-request transitions gate the approval chain', () => {
    const jr = require('../jobrequests');
    const to = (from) => (jr.TRANSITIONS[from] || []).map((t) => t.to);
    // Draft can only be submitted; PENDING_TM only moves to PENDING_OM (or reject).
    assert.ok(to('PENDING_TM').includes('PENDING_OM'));
    assert.ok(to('PENDING_OM').includes('APPROVED'));
    // A completed/closed request is terminal (no onward *approval* transitions).
    assert.ok(!to('COMPLETED').includes('PENDING_TM'));
    assert.deepEqual(jr.TRANSITIONS.CLOSED || [], []);
});
