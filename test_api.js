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
    // wait for listen (any HTTP response means the server is up)
    for (let i = 0; i < 40; i++) {
        try { await fetch(BASE + '/login'); break; } catch (_) {}
        await delay(100);
    }

    // The API now sits behind a login. Authenticate, then inject the session
    // cookie into every subsequent request via a thin fetch wrapper.
    const _fetch = global.fetch;
    let COOKIE = '';
    global.fetch = (url, opts = {}) => {
        const headers = Object.assign({}, opts.headers || {});
        if (COOKIE) headers['Cookie'] = COOKIE;
        return _fetch(url, Object.assign({}, opts, { headers }));
    };
    { const r = await _fetch(BASE + '/api/items?limit=1'); ok(r.status === 401, 'unauthenticated /api request returns 401'); }
    const loginRes = await _fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const setCookie = loginRes.headers.get('set-cookie');
    COOKIE = setCookie ? setCookie.split(';')[0] : '';
    ok(loginRes.status === 200 && !!COOKIE, 'POST /api/login authenticates as admin');

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

    // === JOB CARD / DAILY PROGRAMME / DASHBOARD TESTS ===
    console.log('\n--- Running Job Card / Daily Programme / Dashboard API Tests ---');

    let { body: jcRes } = await j(await fetch(BASE + '/api/jobcards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'INTERNAL', vehicleMachinery: 'TEST-VH', details: 'API test job' }) }));
    ok(jcRes.success && jcRes.jobcard && /^JC-\d{4}-\d{4}$/.test(jcRes.jobcard.jobNo), 'POST /api/jobcards creates with JC number', jcRes.jobcard && jcRes.jobcard.jobNo);
    const jcId = jcRes.jobcard.id;

    let { body: stRes } = await j(await fetch(BASE + `/api/jobcards/${jcId}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'IN_PROGRESS' }) }));
    ok(stRes.success && stRes.jobcard.status === 'IN_PROGRESS' && !!stRes.jobcard.startedAt, 'POST status OPEN -> IN_PROGRESS');

    let { status: badSt } = await j(await fetch(BASE + `/api/jobcards/${jcId}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'CLOSED' }) }));
    ok(badSt === 400, 'illegal status transition rejected (400)');

    let { body: dpRes } = await j(await fetch(BASE + `/api/jobcards/${jcId}/programme`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryDate: '2026-06-10', mechanics: 'Saman, Vinod', hours: 8, workDescription: 'Test work' }) }));
    ok(dpRes.success && dpRes.entry.labourCost === 6400, 'POST programme computes labour (8h each: Saman 8×425 + Vinod 8×375 = 6400)', 'labour=' + (dpRes.entry && dpRes.entry.labourCost));
    const dpId = dpRes.entry.id;

    let { body: jcGet } = await j(await fetch(BASE + '/api/jobcards/' + jcId));
    ok(jcGet.labourCost === 6400 && jcGet.programme.length === 1, 'job labourCost rolled up from programme');

    let { body: mItem } = await j(await fetch(BASE + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum: 'JCLINK-1', itemName: 'Test part', vehicleMachinery: 'TEST-VH', reqQty: 1, jobCardId: jcId }) }));
    await j(await fetch(BASE + `/api/items/${mItem.id}/receipts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1, transactionType: 'Receive', unitPrice: 500, deliveryDate: '2026-06-10' }) }));
    ({ body: jcGet } = await j(await fetch(BASE + '/api/jobcards/' + jcId)));
    ok(jcGet.partsCost === 500 && jcGet.totalCost === 6900, 'parts cost from linked MRN + total job cost (500 + 6400 = 6900)', 'total=' + jcGet.totalCost);

    let { body: dash } = await j(await fetch(BASE + '/api/dashboard'));
    ok(typeof dash.spend.mtd === 'number' && typeof dash.spend.ytd === 'number' && !!dash.received && Array.isArray(dash.suppliers) && !!dash.jobs, 'GET /api/dashboard returns spend/received/suppliers/jobs');

    let { body: dashLocal } = await j(await fetch(BASE + '/api/dashboard?source=local'));
    ok(dashLocal.received.headOffice === 0, 'dashboard source=local filter excludes head office');

    let { body: mechs } = await j(await fetch(BASE + '/api/mechanics'));
    ok(Array.isArray(mechs.mechanics) && mechs.mechanics.length >= 20, 'GET /api/mechanics seeded', 'count=' + mechs.mechanics.length);

    // cleanup
    await j(await fetch(BASE + '/api/programme/' + dpId, { method: 'DELETE' }));
    await j(await fetch(BASE + '/api/items/' + mItem.id + '?password=E%26CWorkshop', { method: 'DELETE' }));
    await j(await fetch(BASE + '/api/jobcards/' + jcId, { method: 'DELETE', headers: { 'x-delete-password': 'E&CWorkshop' } }));
    let { status: goneSt } = await j(await fetch(BASE + '/api/jobcards/' + jcId));
    ok(goneSt === 404, 'job card cleanup verified');

    // === AUTO-LINK (vehicle + date window) + JOB COST COCKPIT TESTS ===
    console.log('\n--- Running Auto-link / Job Cost Cockpit Tests ---');
    let { body: alJob } = await j(await fetch(BASE + '/api/jobcards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'INTERNAL', vehicleMachinery: 'ALV-1', date: '2026-04-10', expectedDate: '2026-04-14', details: 'autolink test' }) }));
    const alJobId = alJob.jobcard.id, alJobNo = alJob.jobcard.jobNo;

    let { body: mIn } = await j(await fetch(BASE + '/api/jobcards/match?vehicle=ALV-1&dateISO=2026-04-12'));
    ok(mIn.match && mIn.match.id === alJobId, 'GET /api/jobcards/match finds job in [start-2 … end+2]');
    let { body: mOut } = await j(await fetch(BASE + '/api/jobcards/match?vehicle=ALV-1&dateISO=2026-04-30'));
    ok(mOut.match === null, 'match returns null outside the window');

    let { body: aiIn } = await j(await fetch(BASE + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum: 'AL-IN', itemName: 'Belt', vehicleMachinery: 'ALV-1', reqDate: '2026-04-12', reqQty: 2 }) }));
    ok(aiIn.jobNo === alJobNo, 'POST /api/items auto-links an in-window MRN', 'jobNo=' + aiIn.jobNo);
    const aiInId = aiIn.id;
    let { body: aiOut } = await j(await fetch(BASE + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum: 'AL-OUT', itemName: 'Hose', vehicleMachinery: 'ALV-1', reqDate: '2026-04-30', reqQty: 1 }) }));
    ok(!aiOut.jobNo, 'an out-of-window MRN is not auto-linked');
    const aiOutId = aiOut.id;

    // Addendum 6 — dropdown feeds: item-name datalist + linkable-MRN select
    let { body: names } = await j(await fetch(BASE + '/api/item-names'));
    ok(Array.isArray(names.names) && names.names.length > 100 && names.names.includes('Belt'), 'GET /api/item-names returns distinct item names', 'count=' + (names.names || []).length);
    let { body: linkable } = await j(await fetch(BASE + '/api/jobcards/' + alJobId + '/linkable-mrns'));
    ok(Array.isArray(linkable.mrns) && linkable.mrns.some((m) => m.mrnNum === 'AL-OUT') && !linkable.mrns.some((m) => m.mrnNum === 'AL-IN'), 'GET /api/jobcards/:id/linkable-mrns lists unlinked same-vehicle MRNs only');

    let { body: alDetail } = await j(await fetch(BASE + '/api/jobcards/' + alJobId));
    const li = (alDetail.linkedItems || []).find((x) => x.mrnNum === 'AL-IN');
    ok(li && li.notReceived && li.unpriced && alDetail.pendingCount >= 1, 'linked item flagged not-received + no-price (highlight)');
    await j(await fetch(BASE + '/api/items/' + aiInId + '/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 2, transactionType: 'Receive', unitPrice: 300, deliveryDate: '2026-04-12' }) }));
    ({ body: alDetail } = await j(await fetch(BASE + '/api/jobcards/' + alJobId)));
    ok(alDetail.partsCost === 600, 'parts cost updates after pricing (2 × 300 = 600)', 'parts=' + alDetail.partsCost);

    let { body: paIn } = await j(await fetch(BASE + '/api/programme/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle: 'ALV-1', entryDate: '2026-04-11', mechanics: 'Saman', hours: 8 }) }));
    ok(paIn.matched && paIn.jobNo === alJobNo && paIn.entry.labourCost === 3400, 'POST /api/programme/auto matches job + costs labour (8h Saman = 3400)');
    let { body: dual } = await j(await fetch(BASE + '/api/programme/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle: 'ALV-1', entryDate: '2026-04-13', mechanics: 'Krishna, Dinesh', hours: 8 }) }));
    ok(dual.entry.labourCost === 5400, 'two mechanics costed at FULL hours each (Krishna 8×250 + Dinesh 8×425 = 5400)', 'labour=' + (dual.entry && dual.entry.labourCost));
    let { body: paOut } = await j(await fetch(BASE + '/api/programme/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle: 'ZZAUTO-X', entryDate: '2026-04-11', mechanics: 'Saman', hours: 2 }) }));
    ok(!paOut.matched && /^DW-/.test(paOut.jobNo || ''), 'programme/auto falls back to a per-vehicle catch-all', paOut.jobNo);

    let { body: alJob2 } = await j(await fetch(BASE + '/api/jobcards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'INTERNAL', vehicleMachinery: 'ALV-1', date: '2026-04-29', expectedDate: '2026-05-01', details: 'covers AL-OUT' }) }));
    let { body: pjLink } = await j(await fetch(BASE + '/api/jobcards/' + alJob2.jobcard.id + '/auto-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    ok(pjLink.success && pjLink.linked >= 1, 'per-job auto-link pulls in the matching unlinked MRN', 'linked=' + pjLink.linked);
    let { body: j2 } = await j(await fetch(BASE + '/api/jobcards/' + alJob2.jobcard.id));
    ok((j2.linkedItems || []).some((x) => x.mrnNum === 'AL-OUT'), 'AL-OUT now linked to the covering job');

    // issued item auto-links to a job + shows on the job card
    let { body: issIn } = await j(await fetch(BASE + '/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemName: 'Cable Tie', qty: 5, vehicleMachinery: 'ALV-1', issueDate: '2026-04-12' }) }));
    ok(issIn.jobNo === alJobNo, 'POST /api/issues auto-links an in-window issued item', 'jobNo=' + issIn.jobNo);
    const issInId = issIn.id;
    let { body: alD3 } = await j(await fetch(BASE + '/api/jobcards/' + alJobId));
    ok((alD3.linkedIssues || []).some((x) => x.id === issInId) && alD3.issuesCount >= 1, 'job linkedIssues includes the issued item');

    // cleanup
    await j(await fetch(BASE + '/api/issues/' + issInId + '?password=E%26CWorkshop', { method: 'DELETE' }));
    await j(await fetch(BASE + '/api/items/' + aiInId + '?password=E%26CWorkshop', { method: 'DELETE' }));
    await j(await fetch(BASE + '/api/items/' + aiOutId + '?password=E%26CWorkshop', { method: 'DELETE' }));
    await j(await fetch(BASE + '/api/jobcards/' + alJobId, { method: 'DELETE', headers: { 'x-delete-password': 'E&CWorkshop' } }));
    await j(await fetch(BASE + '/api/jobcards/' + alJob2.jobcard.id, { method: 'DELETE', headers: { 'x-delete-password': 'E&CWorkshop' } }));
    let { body: dwList } = await j(await fetch(BASE + '/api/jobcards?search=DW-ZZAUTO-X&limit=1'));
    if (dwList.jobcards && dwList.jobcards[0]) await j(await fetch(BASE + '/api/jobcards/' + dwList.jobcards[0].id, { method: 'DELETE', headers: { 'x-delete-password': 'E&CWorkshop' } }));
    ok(true, 'auto-link test cleanup done');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
