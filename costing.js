'use strict';

/**
 * costing.js — the single source of truth for money in this system.
 *
 * Two things lived in 5-6 copies across client JS, server JS and SQL and had
 * already drifted (see docs/SYSTEM_REVIEW.md, findings 6-9):
 *
 *   1. The purchase-source taxonomy (which spellings mean "Local" vs
 *      "Head Office"). Adding a source used to mean editing five files or it
 *      silently bucketed as "Other".
 *   2. The job-cost rollup. `list()` showed labour only, `get()` showed
 *      labour+parts+issues, the dashboard/export omitted priced issues and the
 *      imported `recordedCost` — so the same job showed different totals in
 *      different places.
 *
 * Everything money-related on the server now derives from here: the SQL CASE,
 * the normalisers and the one `jobTotal()` rule. Define a source or change the
 * costing rule in ONE place.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- purchase-source taxonomy ----------------------------------------------
// `canonical` is the value we store; `aliases` (lowercased) is every legacy /
// typo spelling that must fold into it; `origin` is the dashboard bucket.
// To add a source, add an alias here — nothing else changes.
const PURCHASE_SOURCES = [
    { canonical: 'Local Purchase',       origin: 'local',      aliases: ['local purchase', 'local store', 'local'] },
    { canonical: 'Head Office Purchase', origin: 'headOffice', aliases: ['head office purchase', 'headoffice purchase', 'direct purchase', 'head office', 'headoffice', 'pre-ordered'] },
];
// Requests are sourced 'Local' or 'Head Office' (no "Purchase" suffix).
const REQUEST_SOURCES = [
    { canonical: 'Local',       aliases: ['local'] },
    { canonical: 'Head Office', aliases: ['head office', 'headoffice'] },
];

const LOCAL = PURCHASE_SOURCES.find((s) => s.origin === 'local').aliases;
const HEAD_OFFICE = PURCHASE_SOURCES.find((s) => s.origin === 'headOffice').aliases;

/** Fold any delivery purchaseSource spelling into its canonical value. */
function canonicalPurchaseSource(v) {
    const t = String(v || '').trim().toLowerCase();
    if (!t) return v == null ? '' : String(v);
    for (const src of PURCHASE_SOURCES) if (src.aliases.includes(t)) return src.canonical;
    return String(v);
}
/** Fold a request source into 'Local' / 'Head Office', or null if unknown. */
function normRequestSource(v) {
    const t = String(v || '').trim().toLowerCase();
    for (const src of REQUEST_SOURCES) if (src.aliases.includes(t)) return src.canonical;
    return null;
}

/** SQL CASE that classifies a purchaseSource column into local|headOffice|other. */
function originCaseSql(col = 'r.purchaseSource') {
    const list = (arr) => arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
    return `CASE
        WHEN LOWER(TRIM(${col})) IN (${list(HEAD_OFFICE)}) THEN 'headOffice'
        WHEN LOWER(TRIM(${col})) IN (${list(LOCAL)}) THEN 'local'
        ELSE 'other' END`;
}

// --- the one job-cost rule -------------------------------------------------
// SQL fragments used identically by list(), get(), jobKpis() and the export so
// every place computes parts/issues the same way. `i`/`r`/`s` are the item,
// receipt and issue aliases.
const RECEIVED_PARTS_SUM = `SUM(CASE WHEN r.transactionType='Receive' AND r.unitPrice IS NOT NULL THEN r.qty*r.unitPrice ELSE 0 END)`;
const ISSUES_SUM = `SUM(CASE WHEN s.unitPrice IS NOT NULL THEN s.qty*s.unitPrice ELSE 0 END)`;

/** Live, itemised cost = labour + received parts + priced issues. */
function computedCost(j) {
    return round2((Number(j.labourCost) || 0) + (Number(j.receivedPartsCost) || 0) + (Number(j.issuesCost) || 0));
}

/**
 * A job's authoritative total.
 *
 * Normal jobs have no `recordedCost`, so the total is the live computed cost.
 * The 129 imported service jobs carry a spreadsheet `recordedCost` (their true
 * invoiced total) and only incidental live links — so we take the larger of the
 * two. `max` both surfaces the ≈Rs 4.9M of recorded service cost that used to
 * read as Rs 0 AND avoids double-counting the few recorded jobs that also
 * picked up a stray live link.
 */
function jobTotal(j) {
    return round2(Math.max(computedCost(j), Number(j.recordedCost) || 0));
}

module.exports = {
    round2,
    PURCHASE_SOURCES, REQUEST_SOURCES, LOCAL, HEAD_OFFICE,
    canonicalPurchaseSource, normRequestSource, originCaseSql,
    RECEIVED_PARTS_SUM, ISSUES_SUM, computedCost, jobTotal,
};
