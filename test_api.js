// Self-contained API test: boots the server on a fresh port, exercises every
// endpoint via fetch, prints a report, then exits. No shell sleep / no lingering process.
process.env.PORT = '4173';
require('./server.js');

const BASE = 'http://localhost:4173';
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

(async () => {
    // wait for listen
    for (let i = 0; i < 40; i++) {
        try { const r = await fetch(BASE + '/api/categories'); if (r.ok) break; } catch (_) {}
        await delay(100);
    }

    // categories
    let { body: cats } = await j(await fetch(BASE + '/api/categories'));
    ok(Array.isArray(cats.categories) && cats.categories.length === 9, 'GET /api/categories returns 9 categories');

    // vehicles
    let { body: vehicles } = await j(await fetch(BASE + '/api/vehicles'));
    ok(Array.isArray(vehicles) && vehicles.length > 100, 'GET /api/vehicles', `count=${vehicles.length}`);

    // paginated items
    let t = Date.now();
    let { body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=50'));
    ok(page.items.length === 50 && typeof page.total === 'number' && page.total > 2000, 'GET /api/items paginated', `total=${page.total} in ${Date.now() - t}ms`);

    // category filter
    ({ body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=10&category=Filters')));
    ok(page.items.every(i => i.category === 'Filters'), 'category filter = Filters', `total=${page.total}`);

    // vehicle + date range
    ({ body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=50&vehicle=SL-11&startDate=2025-01-01&endDate=2026-12-31')));
    ok(page.items.every(i => i.vehicleMachinery === 'SL-11'), 'vehicle + date-range filter', `total=${page.total}`);

    // search across receipts
    ({ body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=5&search=battery')));
    ok(page.total > 0, 'free-text search "battery"', `total=${page.total}`);

    // CREATE item -> auto category
    let { body: created } = await j(await fetch(BASE + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum: 'TEST-001', reqDate: '2026-06-03', vehicleMachinery: 'TEST-VH', itemName: '150 Amp Battery', itemDesc: 'x', reqQty: 5 }) }));
    ok(created.success && created.id && created.category === 'Battery', 'POST /api/items auto-classifies Battery', `id=${created.id}`);
    const itemId = created.id;

    // UPDATE item with manual category override
    let { body: upd } = await j(await fetch(BASE + '/api/items/' + itemId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum: 'TEST-001', reqDate: '2026-06-03', vehicleMachinery: 'TEST-VH', itemName: '150 Amp Battery', itemDesc: 'x', reqQty: 8, category: 'Electrical' }) }));
    ok(upd.success && upd.category === 'Electrical', 'PUT /api/items manual category override');

    // add receipt (receive)
    let { body: rec } = await j(await fetch(BASE + `/api/items/${itemId}/receipts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 3, transactionType: 'Receive', deliveryDate: '2026-06-04', purchaseSource: 'Local Store' }) }));
    ok(rec.success && rec.id, 'POST receipt (update receive)', `recId=${rec.id}`);
    const recId = rec.id;

    // update GRN/pricing on receipt
    let { body: grn } = await j(await fetch(BASE + '/api/receipts/' + recId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grnNumber: 'GRN-99', invoiceNumber: 'INV-77', supplierName: 'ACME', unitPrice: 1200 }) }));
    ok(grn.success, 'PUT receipt (update GRN/pricing)');

    // verify recQty + receipt attached
    ({ body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=1&search=TEST-001')));
    let it = page.items[0];
    ok(it.recQty === 3 && it.receipts.length === 1 && it.receipts[0].grnNumber === 'GRN-99', 'recQty computed + GRN saved', `recQty=${it.recQty}`);

    // ISSUES CRUD
    let { body: iss } = await j(await fetch(BASE + '/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueDate: '2026-06-05', vehicleMachinery: 'TEST-VH', itemName: 'Air Filter', qty: 2, issuedTo: 'Site A', issuedBy: 'Store' }) }));
    ok(iss.success && iss.id && iss.category === 'Filters', 'POST /api/issues auto-classifies', `id=${iss.id}`);
    const issId = iss.id;
    let { body: issList } = await j(await fetch(BASE + '/api/issues?vehicle=TEST-VH'));
    ok(Array.isArray(issList) && issList.length === 1, 'GET /api/issues vehicle filter');
    await j(await fetch(BASE + '/api/issues/' + issId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueDate: '2026-06-05', vehicleMachinery: 'TEST-VH', itemName: 'Air Filter', qty: 9, issuedTo: 'Site B', issuedBy: 'Store' }) }));
    ({ body: issList } = await j(await fetch(BASE + '/api/issues?vehicle=TEST-VH')));
    ok(issList[0].qty === 9 && issList[0].issuedTo === 'Site B', 'PUT /api/issues updates');

    // DELETE everything we created
    let { body: dIss } = await j(await fetch(BASE + '/api/issues/' + issId, { method: 'DELETE', headers: { 'x-delete-password': 'E&CWorkshop' } }));
    let { body: dRec } = await j(await fetch(BASE + '/api/receipts/' + recId + '?password=E%26CWorkshop', { method: 'DELETE' }));
    let { body: dItem } = await j(await fetch(BASE + '/api/items/' + itemId + '?password=E%26CWorkshop', { method: 'DELETE' }));
    ok(dIss.success && dRec.success && dItem.success, 'DELETE issue/receipt/item');

    // confirm cleanup
    ({ body: page } = await j(await fetch(BASE + '/api/items?page=1&limit=1&search=TEST-001')));
    ok(page.total === 0, 'cleanup verified (item gone)');

    // === BATTERY REGISTRY TESTS ===
    console.log('\n--- Running Battery Registry API Tests ---');

    // 1. Register a battery
    let { status: bRegStatus, body: bReg } = await j(await fetch(BASE + '/api/batteries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            serialNumber: 'BAT-TEST-001',
            itemName: '12V 90Ah',
            brand: 'Exide',
            condition: 'New',
            state: 'In Store',
            purchaseDate: '2026-06-01',
            notes: 'Test note'
        })
    }));
    ok(bRegStatus === 200 && bReg.success && bReg.id, 'Register battery BAT-TEST-001', `id=${bReg.id}`);
    const bat1Id = bReg.id;

    // 2. Register duplicate serial number
    let { status: bDupStatus } = await j(await fetch(BASE + '/api/batteries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            serialNumber: 'BAT-TEST-001',
            itemName: '12V 90Ah',
            brand: 'Exide'
        })
    }));
    ok(bDupStatus === 409, 'Register duplicate battery returns 409 conflict');

    // 3. Get initial battery stats
    let { body: statsBefore } = await j(await fetch(BASE + '/api/battery-stats'));
    ok(typeof statsBefore.total === 'number' && statsBefore.newInStore >= 1, 'GET /api/battery-stats returns correct numbers');

    // 4. Move/issue battery with swap payload
    let { status: bMoveStatus, body: bMove } = await j(await fetch(BASE + '/api/batteries/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            batteryId: bat1Id,
            movementType: 'Issue',
            toVehicle: 'Excavator 01',
            movementDate: '2026-06-05',
            conditionAfter: 'New',
            notes: 'Issued new battery',
            issuedBy: 'Storekeeper A',
            mrnNum: 'MRN-BAT-1',
            replaced: {
                serialNumber: 'BAT-OLD-002',
                itemName: '12V 75Ah',
                brand: 'Amaron',
                notes: 'Replaced dead battery'
            }
        })
    }));
    ok(bMoveStatus === 200 && bMove.success, 'POST /api/batteries/move with swap payload');

    // 5. Verify states after swap
    let { body: bat1 } = await j(await fetch(BASE + '/api/batteries/' + bat1Id));
    ok(bat1.state === 'Installed' && bat1.currentVehicle === 'Excavator 01', 'Active battery state is Installed on Excavator 01');

    // Find the automatically registered swapped old battery
    let { body: batList } = await j(await fetch(BASE + '/api/batteries?search=BAT-OLD-002'));
    let bat2 = batList.find(b => b.serialNumber === 'BAT-OLD-002');
    ok(bat2 !== undefined && bat2.state === 'In Store' && bat2.condition === 'Old', 'Swapped old battery registered as Old / In Store');
    const bat2Id = bat2 ? bat2.id : null;

    // 6. Verify movements list for active battery
    ok(bat1.movements.length === 2 && bat1.movements[0].movementType === 'Issue' && bat1.movements[1].movementType === 'Register', 'Active battery movements timeline verified');

    // 7. Move/Transfer active battery to another vehicle
    let { status: bTransStatus } = await j(await fetch(BASE + '/api/batteries/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            batteryId: bat1Id,
            movementType: 'Transfer',
            toVehicle: 'Truck 02',
            movementDate: '2026-06-06',
            issuedBy: 'Storekeeper B',
            notes: 'Transfer to Truck 02'
        })
    }));
    let { body: bat1Trans } = await j(await fetch(BASE + '/api/batteries/' + bat1Id));
    ok(bTransStatus === 200 && bat1Trans.state === 'Installed' && bat1Trans.currentVehicle === 'Truck 02', 'Active battery transferred to Truck 02');

    // 8. Return battery to store
    let { status: bRetStatus } = await j(await fetch(BASE + '/api/batteries/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            batteryId: bat1Id,
            movementType: 'Return',
            movementDate: '2026-06-07',
            conditionAfter: 'Old',
            issuedBy: 'Storekeeper A',
            notes: 'Returned to store after use'
        })
    }));
    let { body: bat1Ret } = await j(await fetch(BASE + '/api/batteries/' + bat1Id));
    ok(bRetStatus === 200 && bat1Ret.state === 'In Store' && bat1Ret.condition === 'Old', 'Active battery returned to store and condition updated to Old');

    // 9. Dispose swapped old battery
    if (bat2Id) {
        let { status: bDispStatus } = await j(await fetch(BASE + '/api/batteries/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batteryId: bat2Id,
                movementType: 'Dispose',
                movementDate: '2026-06-07',
                issuedBy: 'Storekeeper B',
                notes: 'Scrapped'
            })
        }));
        let { body: bat2Disp } = await j(await fetch(BASE + '/api/batteries/' + bat2Id));
        ok(bDispStatus === 200 && bat2Disp.state === 'Disposed', 'Swapped old battery disposed successfully');
    }

    // 10. Verify Excel export queries and results
    let excelRes = await fetch(BASE + '/api/export/excel');
    ok(excelRes.status === 200 && excelRes.headers.get('content-type').includes('spreadsheet'), 'GET /api/export/excel returns XLSX buffer');

    // 11. Delete battery records (cleanup)
    let { status: bDel1Status } = await j(await fetch(BASE + '/api/batteries/' + bat1Id, {
        method: 'DELETE',
        headers: { 'x-delete-password': 'E&CWorkshop' }
    }));
    let { status: bDel2Status } = await j(await fetch(BASE + '/api/batteries/' + bat2Id, {
        method: 'DELETE',
        headers: { 'x-delete-password': 'E&CWorkshop' }
    }));
    ok(bDel1Status === 200 && bDel2Status === 200, 'DELETE batteries clean up');

    // Confirm batteries and movements are completely gone
    let { body: bat1Gone } = await j(await fetch(BASE + '/api/batteries/' + bat1Id));
    let { body: bat2Gone } = await j(await fetch(BASE + '/api/batteries/' + bat2Id));
    ok(bat1Gone.error && bat2Gone.error, 'Batteries cleanup verified');

    // === MATERIAL TRANSFERS API TESTS ===
    console.log('\n--- Running Material Transfer API Tests ---');

    // 1. Create a transfer
    let { status: mtRegStatus, body: mtReg } = await j(await fetch(BASE + '/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mtnNum: 'MTN-TEST-100',
            transferDate: '2026-06-08',
            itemName: 'Hydraulic Oil 15W40',
            qty: 15,
            fromLocation: 'Main Store',
            toLocation: 'Excavator 02',
            transferredBy: 'Storekeeper A',
            receivedBy: 'Driver B',
            notes: 'Refill hydraulic system'
        })
    }));
    ok(mtRegStatus === 200 && mtReg.success && mtReg.id && mtReg.category === 'Hydraulics', 'Create transfer MTN-TEST-100 with auto-classification', `id=${mtReg.id}`);
    const transferId = mtReg.id;

    // 2. Fetch and filter transfers
    let { body: mtList } = await j(await fetch(BASE + '/api/transfers?search=MTN-TEST-100'));
    let mtRecord = mtList.find(t => t.id === transferId);
    ok(mtRecord !== undefined && mtRecord.mtnNum === 'MTN-TEST-100' && mtRecord.category === 'Hydraulics', 'Fetch and search transfers by MTN');

    // 3. Get transfer stats
    let { body: mtStats } = await j(await fetch(BASE + '/api/transfer-stats'));
    ok(typeof mtStats.total === 'number' && mtStats.total >= 1, 'GET /api/transfer-stats returns statistics');

    // 4. Update the transfer
    let { status: mtUpdStatus, body: mtUpd } = await j(await fetch(BASE + '/api/transfers/' + transferId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mtnNum: 'MTN-TEST-100',
            transferDate: '2026-06-08',
            itemName: 'Hydraulic Oil 15W40',
            qty: 25,
            fromLocation: 'Main Store',
            toLocation: 'Excavator 02',
            transferredBy: 'Storekeeper A',
            receivedBy: 'Driver B',
            category: 'Consumables',
            notes: 'Refill hydraulic system (updated qty)'
        })
    }));
    ok(mtUpdStatus === 200 && mtUpd.success && mtUpd.category === 'Consumables', 'Update transfer details with manual category override');

    // 5. Delete transfer without password (should fail)
    let { status: mtDelFailStatus } = await j(await fetch(BASE + '/api/transfers/' + transferId, {
        method: 'DELETE'
    }));
    ok(mtDelFailStatus === 401 || mtDelFailStatus === 403, 'DELETE transfer without password fails');

    // 6. Delete transfer with correct password (should succeed)
    let { status: mtDelSuccessStatus } = await j(await fetch(BASE + '/api/transfers/' + transferId, {
        method: 'DELETE',
        headers: { 'x-delete-password': 'E&CWorkshop' }
    }));
    ok(mtDelSuccessStatus === 200, 'DELETE transfer with password succeeds');

    // 7. Verify deletion
    let { status: mtGoneStatus } = await j(await fetch(BASE + '/api/transfers/' + transferId));
    ok(mtGoneStatus === 404, 'Transfer cleanup verified');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
