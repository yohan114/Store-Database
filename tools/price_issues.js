'use strict';

/**
 * price_issues.js — backfill unitPrice on historical issued items that don't
 * have one, using the same rule the Issue Desk uses live: the most recent
 * priced 'Receive' receipt of the same item name.
 *
 *   node tools/price_issues.js            dry run: report only
 *   node tools/price_issues.js --commit   write derived unitPrice (only where NULL)
 *
 * Only rows with a NULL unitPrice are touched, so a manually-entered price is
 * never overwritten. Re-runnable.
 */

const db = require('../db');

const COMMIT = process.argv.includes('--commit');
const nowISO = () => new Date().toISOString();

function suggest(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    const row = db.get(
        `SELECT r.unitPrice AS p FROM receipts r JOIN items i ON i.id = r.itemId
         WHERE r.transactionType='Receive' AND r.unitPrice IS NOT NULL
           AND LOWER(TRIM(i.itemName)) = ?
         ORDER BY r.deliveryDateISO DESC, r.id DESC LIMIT 1`, [n]);
    return row ? row.p : null;
}

function main() {
    db.init();
    console.log(`Database: ${db.DB_FILE} (engine ${db.ENGINE})`);
    console.log(COMMIT ? 'Mode: COMMIT — derived prices will be written.' : 'Mode: DRY RUN — nothing will be written.');

    const rows = db.all(`SELECT id, itemName, qty FROM issues WHERE unitPrice IS NULL`);
    let priced = 0, still = 0, value = 0;
    db.transaction(() => {
        for (const r of rows) {
            const p = suggest(r.itemName);
            if (p != null) {
                if (COMMIT) db.run(`UPDATE issues SET unitPrice=?, updatedAt=? WHERE id=?`, [p, nowISO(), r.id]);
                priced++; value += (Number(r.qty) || 0) * p;
            } else still++;
        }
    });

    console.log(`\n== issue pricing backfill ==`);
    console.log(`  unpriced issues:            ${rows.length}`);
    console.log(`  ${COMMIT ? 'priced from deliveries' : 'would price'}: ${priced}  (adds ~Rs ${Math.round(value).toLocaleString()} of issued value)`);
    console.log(`  still unpriced (no match):  ${still}`);
    console.log(COMMIT ? '\nDone — committed.' : '\nDry run complete — re-run with --commit to apply.');
}

main();
