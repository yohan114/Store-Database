// operations.ts — Operations job-request workflow UI.
//
// Compiled to /js/operations.js (classic script, loaded after app.js) so it
// shares the page globals (formatCurrency, jcEsc, jcDate…) defined in app.ts.
// Covers: the Operations dashboard, request form, approval actions, the
// notification bell, and the admin Users / Outbox / standing-CC panels.
// ---- small helpers (fall back if app.ts globals aren't present) ------------
const opEsc = (s) => (typeof jcEsc === 'function') ? jcEsc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opDate = (s) => (typeof jcDate === 'function') ? jcDate(s) : (s || '—');
async function opJSON(url, opts) { const r = await fetch(url, opts); const b = await r.json().catch(() => null); return { ok: r.ok, status: r.status, body: b }; }
let opsMeta = null;
let opsFilter = 'all';
let opsSearchTerm = '';
let opsSearchTimer = null;
const OPS_ROLES = ['TRANSPORT_OFFICER', 'TRANSPORT_MANAGER', 'OPERATIONAL_MANAGER'];
const STATUS_TONE = {
    DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    PENDING_TM: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
    PENDING_OM: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
    APPROVED: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
    IN_PROGRESS: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400',
    COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    CLOSED: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    REJECTED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
};
const statusBadge = (st, label) => `<span class="inline-flex px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${STATUS_TONE[st] || STATUS_TONE.DRAFT}">${opEsc(label || st)}</span>`;
// ---- role-scoped navigation ------------------------------------------------
// Operations users land on Operations and don't see the stores/workshop nav;
// store/workshop users don't see Operations. Admin sees everything.
function applyRoleScopedNav(user) {
    const roles = (user && user.roles) || [];
    const isAdmin = roles.includes('ADMIN');
    const isOps = roles.some((r) => OPS_ROLES.includes(r));
    const opsNav = document.getElementById('nav-operations');
    if (opsNav)
        opsNav.classList.toggle('hidden', !(isAdmin || isOps));
    // If the user is operations-only (no admin), hide the stores/workshop nav items.
    if (isOps && !isAdmin) {
        ['nav-dashboard', 'nav-jobcards', 'nav-programme', 'nav-tracker', 'nav-fleet', 'nav-inventory', 'nav-batteries', 'nav-transfers', 'nav-issued']
            .forEach((id) => { const el = document.getElementById(id); if (el)
            el.classList.add('hidden'); });
        // Land on Operations if they arrived on a hidden section.
        if (!location.hash || location.hash === '#dashboard')
            location.hash = '#operations';
    }
}
// ---- notifications bell ----------------------------------------------------
let notifTimer = null;
async function refreshNotifications() {
    try {
        const { body } = await opJSON('/api/notifications');
        if (!body)
            return;
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = body.unread;
            badge.classList.toggle('hidden', !body.unread);
        }
        const list = document.getElementById('notifList');
        if (list)
            list.innerHTML = (body.notifications || []).length ? body.notifications.map((n) => `
            <button onclick="openNotif(${n.id}, ${n.requestId || 'null'})" class="block w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 ${n.isRead ? '' : 'bg-indigo-50/40 dark:bg-indigo-950/20'}">
                <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">${opEsc(n.message)}</div>
                <div class="text-[10px] text-slate-400 mt-0.5">${opDate((n.at || '').slice(0, 10))}${n.reqNo ? ' · ' + opEsc(n.reqNo) : ''}</div>
            </button>`).join('') : '<div class="px-4 py-6 text-center text-xs text-slate-400 italic">No notifications.</div>';
    }
    catch (e) { /* ignore */ }
}
function startNotifications() {
    refreshNotifications();
    if (notifTimer)
        clearInterval(notifTimer);
    // The badge is refreshed every 15 s by the main /api/summary poll (unread is
    // folded in there), so the full list only needs an occasional safety refresh
    // — plus an on-demand fetch whenever the dropdown is opened.
    notifTimer = setInterval(refreshNotifications, 60000);
}
function toggleNotifDropdown() {
    const d = document.getElementById('notifDropdown');
    if (d) {
        d.classList.toggle('hidden');
        if (!d.classList.contains('hidden'))
            refreshNotifications();
    }
}
async function markAllNotifsRead() { await fetch('/api/notifications/read-all', { method: 'POST' }); refreshNotifications(); }
async function openNotif(id, requestId) {
    try {
        await fetch('/api/notifications/' + id + '/read', { method: 'POST' });
    }
    catch (e) { }
    const d = document.getElementById('notifDropdown');
    if (d)
        d.classList.add('hidden');
    refreshNotifications();
    if (requestId)
        openJobRequestDetail(requestId);
}
document.addEventListener('click', function (e) {
    const c = document.getElementById('notifContainer');
    const d = document.getElementById('notifDropdown');
    if (c && d && !c.contains(e.target))
        d.classList.add('hidden');
});
// ---- Operations dashboard --------------------------------------------------
const OPS_FILTERS = [
    ['all', 'All'], ['pending', 'Pending my approval'], ['mine', 'My requests'],
    ['PENDING_TM', 'Pending TM'], ['PENDING_OM', 'Pending OM'], ['IN_PROGRESS', 'In progress'], ['COMPLETED', 'Completed'],
];
function opsSetFilter(f) { opsFilter = f; loadOperations(); }
function opsDebouncedSearch() { clearTimeout(opsSearchTimer); opsSearchTimer = setTimeout(() => { opsSearchTerm = document.getElementById('opsSearch').value.trim(); loadOperations(); }, 250); }
async function loadOperations() {
    if (!opsMeta) {
        const m = await opJSON('/api/job-requests/meta');
        opsMeta = m.body || {};
    }
    // New-request button only for those who can create.
    const newBtn = document.getElementById('opsNewBtn');
    if (newBtn)
        newBtn.classList.toggle('hidden', !opsMeta.canCreate);
    // Build query from the active filter.
    const q = new URLSearchParams();
    if (opsFilter === 'pending')
        q.set('pending', '1');
    else if (opsFilter === 'mine')
        q.set('mine', '1');
    else if (opsFilter !== 'all')
        q.set('status', opsFilter);
    if (opsSearchTerm)
        q.set('search', opsSearchTerm);
    const { body } = await opJSON('/api/job-requests?' + q.toString());
    const data = body || { requests: [], counts: {} };
    const c = data.counts || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el)
        el.textContent = v; };
    set('opsKpiPending', c.pendingMine || 0);
    set('opsKpiMine', c.mineOpen || 0);
    set('opsKpiProgress', c.inProgress || 0);
    set('opsKpiCompleted', c.completedMonth || 0);
    const pill = document.getElementById('count-ops-pending');
    if (pill) {
        pill.textContent = c.pendingMine || 0;
        pill.classList.toggle('hidden', !(c.pendingMine));
    }
    // Filter chips.
    const fWrap = document.getElementById('opsFilters');
    if (fWrap)
        fWrap.innerHTML = OPS_FILTERS.map(([k, lbl]) => `<button onclick="opsSetFilter('${k}')" class="px-3 py-1.5 rounded-lg text-xs font-bold ${opsFilter === k ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}">${lbl}</button>`).join('');
    // Rows.
    const body2 = document.getElementById('opsListBody');
    const rows = data.requests || [];
    if (body2)
        body2.innerHTML = rows.length ? rows.map((r) => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer" onclick="openJobRequestDetail(${r.id})">
            <td class="px-5 py-3">
                <div class="text-xs font-extrabold text-indigo-700 dark:text-indigo-400">${opEsc(r.reqNo || 'Draft')}</div>
                <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">${opEsc(r.title || r.details || '')}</div>
                <div class="text-[10px] text-slate-400 mt-0.5">${r.type === 'OUTSOURCED' ? '🏷️ Outsourced' : 'Internal'}${r.priority === 'Urgent' ? ' · <span class="text-rose-500 font-bold">Urgent</span>' : ''}</div>
            </td>
            <td class="px-5 py-3 text-slate-600 dark:text-slate-300 font-semibold">${opEsc(r.vehicleMachinery || '—')}</td>
            <td class="px-5 py-3 text-slate-500 dark:text-slate-400">${opEsc(r.requestedByName || '—')}<div class="text-[10px] text-slate-400">${opDate((r.requestedAt || r.createdAt || '').slice(0, 10))}</div></td>
            <td class="px-5 py-3">${statusBadge(r.status, r.statusLabel)}</td>
            <td class="px-5 py-3 text-right"><span class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">Open →</span></td>
        </tr>`).join('') : '<tr><td colspan="5" class="px-5 py-10 text-center text-sm text-slate-400 italic">No job requests in this view.</td></tr>';
    renderOpsAdmin();
}
// ---- request create / detail modal ----------------------------------------
function opCloseModal() { const m = document.getElementById('jobRequestModal'); if (m)
    m.classList.add('hidden'); }
function opShowModal(html) {
    const body = document.getElementById('jobRequestModalBody');
    if (body)
        body.innerHTML = html;
    const m = document.getElementById('jobRequestModal');
    if (m)
        m.classList.remove('hidden');
}
function openJobRequestModal() {
    const dir = (opsMeta && opsMeta.directory) || [];
    const recips = dir.filter((u) => u.email).map((u) => `<label class="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" class="opRecip" value="${opEsc(u.email)}"> ${opEsc(u.name)} <span class="text-slate-400">${opEsc(u.email)}</span></label>`).join('') || '<span class="text-xs text-slate-400 italic">No users with e-mail yet — add them in Admin.</span>';
    opShowModal(`
        <div class="flex items-center justify-between mb-5">
            <h3 class="text-xl font-black text-slate-900 dark:text-white">Request a Job</h3>
            <button onclick="opCloseModal()" class="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
        </div>
        <form id="jobRequestForm" class="space-y-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label class="opl">Job title <span class="text-rose-500">*</span></label><input id="jrTitle" required class="opi" placeholder="e.g. Excavator hydraulic leak"></div>
                <div><label class="opl">Type</label>
                    <select id="jrType" onchange="opToggleVendor()" class="opi"><option value="INTERNAL">Internal</option><option value="OUTSOURCED">Outsourced (outside)</option></select></div>
                <div><label class="opl">Vehicle / Machinery</label><input id="jrVehicle" class="opi" list="vehicleDatalist" placeholder="e.g. HEX-34"></div>
                <div><label class="opl">ECD No.</label><input id="jrEcd" class="opi" placeholder="e.g. 1090"></div>
                <div><label class="opl">Project / Site</label><input id="jrProject" class="opi" placeholder="e.g. Badalgama"></div>
                <div><label class="opl">Priority</label><select id="jrPriority" class="opi"><option>Normal</option><option>Urgent</option></select></div>
                <div><label class="opl">Needed by</label><input id="jrNeededBy" type="date" class="opi"></div>
            </div>
            <div><label class="opl">Details</label><textarea id="jrDetails" rows="3" class="opi" placeholder="Describe the work required…"></textarea></div>
            <div id="jrVendorWrap" class="hidden space-y-3 rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/10 p-4">
                <div class="text-[11px] font-extrabold uppercase tracking-wider text-amber-700 dark:text-amber-400">Outside job — e-mail on approval</div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div><label class="opl">Vendor name</label><input id="jrVendorName" class="opi" placeholder="e.g. ABC Motors"></div>
                    <div><label class="opl">Vendor e-mail</label><input id="jrVendorEmail" type="email" class="opi" placeholder="vendor@example.com"></div>
                </div>
                <div><label class="opl">Also notify (selected parties)</label><div class="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">${recips}</div>
                    <input id="jrExtraEmails" class="opi mt-2" placeholder="Extra e-mails, comma-separated (optional)"></div>
                <p class="text-[10px] text-amber-600 dark:text-amber-400/80">A standing CC list (set by Admin) is always included.</p>
            </div>
            <div id="jrError" class="hidden text-xs font-semibold text-rose-500"></div>
            <div class="flex justify-end gap-2 pt-2">
                <button type="button" onclick="opCloseModal()" class="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-sm font-bold">Cancel</button>
                <button type="button" onclick="submitJobRequest(false)" class="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-sm font-bold">Save draft</button>
                <button type="button" onclick="submitJobRequest(true)" class="px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-800 text-white text-sm font-bold">Submit for approval</button>
            </div>
        </form>`);
}
function opToggleVendor() {
    const t = document.getElementById('jrType').value;
    const w = document.getElementById('jrVendorWrap');
    if (w)
        w.classList.toggle('hidden', t !== 'OUTSOURCED');
}
async function submitJobRequest(submit) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const recips = Array.from(document.querySelectorAll('.opRecip')).filter((c) => c.checked).map((c) => c.value);
    const extra = val('jrExtraEmails').split(/[,;]/).map((s) => s.trim()).filter((s) => /@/.test(s));
    const payload = {
        title: val('jrTitle'), type: val('jrType'), vehicleMachinery: val('jrVehicle'), ecdNo: val('jrEcd'),
        projectName: val('jrProject'), priority: val('jrPriority'), neededBy: val('jrNeededBy'), details: val('jrDetails'),
        vendorName: val('jrVendorName'), vendorEmail: val('jrVendorEmail'),
        emailRecipients: recips.concat(extra), submit: !!submit,
    };
    const err = document.getElementById('jrError');
    if (!payload.title) {
        if (err) {
            err.textContent = 'A job title is required.';
            err.classList.remove('hidden');
        }
        return;
    }
    const { ok, body } = await opJSON('/api/job-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!ok) {
        if (err) {
            err.textContent = (body && body.error) || 'Could not save.';
            err.classList.remove('hidden');
        }
        return;
    }
    opCloseModal();
    loadOperations();
    refreshNotifications();
    if (body.request && body.request.id)
        openJobRequestDetail(body.request.id);
}
async function openJobRequestDetail(id) {
    if (location.hash !== '#operations')
        location.hash = '#operations';
    const { ok, body } = await opJSON('/api/job-requests/' + id);
    if (!ok || !body)
        return;
    const r = body;
    const actions = (r.availableActions || []).map((a) => `<button onclick="jobRequestAction(${r.id}, '${a.action}', ${a.needNote ? 'true' : 'false'})" class="px-4 py-2 rounded-xl text-xs font-bold ${a.action.includes('Reject') || a.action === 'tmReject' || a.action === 'omReject' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' : 'bg-gradient-to-r from-indigo-600 to-indigo-800 text-white'}">${opEsc(a.label)}</button>`).join('');
    const timeline = (r.audits || []).map((a) => `
        <div class="flex gap-3 text-xs">
            <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0"></div>
            <div><span class="font-bold text-slate-700 dark:text-slate-200">${opEsc(a.action)}</span> <span class="text-slate-400">${a.fromStatus ? a.fromStatus + ' → ' + a.toStatus : a.toStatus}</span>
                ${a.note ? `<div class="text-slate-500 dark:text-slate-400 italic">“${opEsc(a.note)}”</div>` : ''}
                <div class="text-[10px] text-slate-400">${opEsc(a.userName || '')} · ${opDate((a.at || '').slice(0, 10))}</div></div>
        </div>`).join('');
    const field = (l, v) => `<div><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${l}</div><div class="text-sm font-semibold text-slate-700 dark:text-slate-200">${opEsc(v || '—')}</div></div>`;
    opShowModal(`
        <div class="flex items-start justify-between mb-4">
            <div>
                <div class="flex items-center gap-3"><h3 class="text-xl font-black text-slate-900 dark:text-white">${opEsc(r.reqNo || 'Draft request')}</h3>${statusBadge(r.status, r.statusLabel)}</div>
                <div class="text-sm font-semibold text-slate-450 dark:text-slate-500 mt-1">${r.type === 'OUTSOURCED' ? 'Outsourced Service Request' : 'Internal Job Request'} · ${opEsc(r.title || '')}</div>
            </div>
            <button onclick="opCloseModal()" class="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl p-4 mb-4">
            ${field('Vehicle / Machinery', r.vehicleMachinery)} ${field('ECD No.', r.ecdNo)} ${field('Project / Site', r.projectName || r.site)}
            ${field('Priority', r.priority)} ${field('Needed by', r.neededBy)} ${field('Requested by', r.requestedByName)}
            ${field('Transport Mgr', r.tmApprovedByName)} ${field('Operational Mgr', r.omApprovedByName)} ${field('Completed by', r.completedByName)}
        </div>
        ${r.details ? `<div class="mb-4"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Details</div><div class="text-sm text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3">${opEsc(r.details)}</div></div>` : ''}
        ${r.jobCard ? `<div class="mb-4 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 rounded-xl px-3 py-2">✓ Workshop job card <strong>${opEsc(r.jobCard.jobNo)}</strong> opened for costing.</div>` : ''}
        ${r.type === 'OUTSOURCED' ? `<div class="mb-4 text-xs font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/10 rounded-xl px-3 py-2">Vendor: ${opEsc(r.vendorName || '—')} &lt;${opEsc(r.vendorEmail || 'no e-mail')}&gt;${r.emailSentAt ? ` · e-mailed ${opDate(r.emailSentAt.slice(0, 10))}` : ' · not e-mailed yet'}</div>` : ''}
        ${r.rejectReason ? `<div class="mb-4 text-xs font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/20 rounded-xl px-3 py-2">Rejected: ${opEsc(r.rejectReason)}</div>` : ''}
        <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">${actions || '<span class="text-xs text-slate-400 italic">No actions available to you in this state.</span>'}</div>
        ${timeline ? `<div class="mt-5"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Activity</div><div class="space-y-2.5">${timeline}</div></div>` : ''}
    `);
}
async function jobRequestAction(id, action, needNote) {
    let note = '';
    if (needNote) {
        note = prompt('Reason:') || '';
        if (!note.trim())
            return;
    }
    const { ok, body } = await opJSON('/api/job-requests/' + id + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note }) });
    if (!ok) {
        alert((body && body.error) || 'Action failed.');
        return;
    }
    openJobRequestDetail(id);
    loadOperations();
    refreshNotifications();
}
// ---- admin panels (Users / Outbox / standing CC) --------------------------
function renderOpsAdmin() {
    const panel = document.getElementById('opsAdminPanel');
    const isAdmin = window.__me && (window.__me.roles || []).includes('ADMIN');
    if (!panel)
        return;
    panel.classList.toggle('hidden', !isAdmin);
    if (!isAdmin)
        return;
    panel.innerHTML = `
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
            <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-extrabold text-slate-700 dark:text-slate-200">Users &amp; Roles</h3>
                <button onclick="opAddUserModal()" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">+ Add user</button></div>
            <div id="opsUsersList" class="space-y-1.5 text-xs"></div>
        </div>
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
            <h3 class="text-sm font-extrabold text-slate-700 dark:text-slate-200 mb-3">Outsourced e-mail settings</h3>
            <label class="opl">Standing CC list (always e-mailed)</label>
            <div class="flex gap-2 mt-1"><input id="opsStandingCc" class="opi" placeholder="ops@enc.lk, manager@enc.lk"><button onclick="opSaveStandingCc()" class="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold">Save</button></div>
            <h3 class="text-sm font-extrabold text-slate-700 dark:text-slate-200 mt-5 mb-2">Outbox <span class="text-[10px] font-semibold text-slate-400">(sent / simulated e-mails)</span></h3>
            <div id="opsOutbox" class="space-y-1.5 text-xs max-h-56 overflow-y-auto"></div>
        </div>`;
    opLoadUsers();
    opLoadOutbox();
    // Standing CC is ADMIN-only info; fetch it from the gated settings endpoint
    // (it is deliberately not exposed on the public /meta payload).
    opJSON('/api/settings/standing-cc').then(({ ok, body }) => {
        const cc = document.getElementById('opsStandingCc');
        if (cc && ok)
            cc.value = (body && body.standingCc) || '';
    });
}
async function opLoadUsers() {
    const { body } = await opJSON('/api/users');
    const mount = document.getElementById('opsUsersList');
    if (!mount)
        return;
    mount.innerHTML = ((body && body.users) || []).map((u) => `
        <div class="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
            <div><span class="font-bold text-slate-700 dark:text-slate-200">${opEsc(u.name || u.username)}</span> <span class="text-slate-400">@${opEsc(u.username)}</span>
                <div class="text-[10px] text-slate-400">${(u.roles || []).join(', ')}${u.email ? ' · ' + opEsc(u.email) : ''}</div></div>
            <button onclick="opResetPwd(${u.id})" class="text-[11px] font-bold text-slate-500 hover:text-rose-500">Reset pwd</button>
        </div>`).join('') || '<span class="text-slate-400 italic">No users.</span>';
}
async function opLoadOutbox() {
    const { body } = await opJSON('/api/outbox');
    const mount = document.getElementById('opsOutbox');
    if (!mount)
        return;
    mount.innerHTML = ((body && body.outbox) || []).map((o) => `
        <div class="py-1.5 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
            <div class="flex items-center justify-between"><span class="font-bold text-slate-700 dark:text-slate-200 truncate">${opEsc(o.toAddr)}</span>
                <span class="px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase ${o.status === 'sent' ? 'bg-emerald-100 text-emerald-700' : o.status === 'failed' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}">${opEsc(o.status)}</span></div>
            <div class="text-[10px] text-slate-400 truncate">${opEsc(o.subject)}${o.reqNo ? ' · ' + opEsc(o.reqNo) : ''}</div>
        </div>`).join('') || '<span class="text-slate-400 italic">No e-mails yet.</span>';
}
// A strong, readable one-time password (replaces the hardcoded 'changeme123').
function opGenPassword() {
    const rand = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4).toUpperCase();
    return `Ecms-${rand}!`;
}
const opEmailValid = (v) => !v || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(v).trim());
// Add-user modal (replaces the prompt()/alert() flow): role checkboxes, e-mail
// validation, and an initial password generated + shown once (review finding).
function opAddUserModal() {
    opCloseUserModal();
    const roleLabels = (opsMeta && opsMeta.roleLabels) || {
        TRANSPORT_OFFICER: 'Transport Officer', TRANSPORT_MANAGER: 'Transport Manager',
        OPERATIONAL_MANAGER: 'Operational Manager', ASST_MECH_ENGINEER: 'Assistant Mechanical Engineer',
        MECH_ENGINEER: 'Mechanical Engineer', TECHNICIAN: 'Workshop Technician', ADMIN: 'Administrator',
    };
    const roleRows = Object.keys(roleLabels).map((r) => `
        <label class="flex items-center gap-2 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
            <input type="checkbox" class="opNewRole" value="${opEsc(r)}"> ${opEsc(roleLabels[r])}</label>`).join('');
    const wrap = document.createElement('div');
    wrap.id = 'opUserModal';
    wrap.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4';
    wrap.innerHTML = `
        <div class="absolute inset-0 bg-slate-900/50" onclick="opCloseUserModal()"></div>
        <div class="relative bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-extrabold text-slate-700 dark:text-slate-200">Add user</h3>
                <button onclick="opCloseUserModal()" class="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button></div>
            <div class="space-y-2.5">
                <div><label class="opl">Username</label><input id="opNewUsername" class="opi" placeholder="e.g. jsilva" autocomplete="off"></div>
                <div><label class="opl">Full name</label><input id="opNewName" class="opi" placeholder="Full name"></div>
                <div><label class="opl">E-mail (optional)</label><input id="opNewEmail" class="opi" placeholder="name@enc.lk"></div>
                <div><label class="opl">Roles</label><div class="mt-1 grid grid-cols-1 gap-0.5 border border-slate-150 dark:border-slate-800 rounded-lg px-3 py-2">${roleRows}</div></div>
            </div>
            <div id="opNewUserMsg" class="text-[11px] font-semibold text-rose-500 mt-2 min-h-[16px]"></div>
            <div class="flex justify-end gap-2 mt-2">
                <button onclick="opCloseUserModal()" class="px-3 py-2 rounded-lg text-xs font-bold text-slate-500">Cancel</button>
                <button onclick="opSubmitNewUser()" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold">Create user</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);
}
function opCloseUserModal() { const m = document.getElementById('opUserModal'); if (m)
    m.remove(); }
async function opSubmitNewUser() {
    const username = document.getElementById('opNewUsername').value.trim();
    const name = document.getElementById('opNewName').value.trim();
    const email = document.getElementById('opNewEmail').value.trim();
    const roles = Array.from(document.querySelectorAll('.opNewRole')).filter((c) => c.checked).map((c) => c.value);
    const msg = document.getElementById('opNewUserMsg');
    const fail = (t) => { if (msg)
        msg.textContent = t; };
    if (!username)
        return fail('Username is required.');
    if (!roles.length)
        return fail('Choose at least one role.');
    if (!opEmailValid(email))
        return fail('That e-mail address looks invalid.');
    const password = opGenPassword();
    const { ok, body } = await opJSON('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, name, email, roles, password }) });
    if (!ok)
        return fail((body && body.error) || 'Could not add user.');
    opCloseUserModal();
    opShowPasswordOnce(`User “${username}” created.`, password);
    opLoadUsers();
}
async function opResetPwd(id) {
    if (!confirm('Reset this user’s password to a new temporary one?'))
        return;
    const password = opGenPassword();
    const { ok, body } = await opJSON('/api/users/' + id + '/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!ok) {
        alert((body && body.error) || 'Failed.');
        return;
    }
    opShowPasswordOnce('Password reset.', password);
}
// Show a generated password ONCE (it is never stored client-side or re-shown).
function opShowPasswordOnce(title, password) {
    opCloseUserModal();
    const wrap = document.createElement('div');
    wrap.id = 'opUserModal';
    wrap.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4';
    wrap.innerHTML = `
        <div class="absolute inset-0 bg-slate-900/50" onclick="opCloseUserModal()"></div>
        <div class="relative bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl w-full max-w-sm p-5 text-center">
            <div class="text-sm font-extrabold text-slate-700 dark:text-slate-200 mb-1">${opEsc(title)}</div>
            <div class="text-[11px] text-slate-500 mb-3">Copy the initial password now — it is shown only once and the user must change it on first login.</div>
            <div class="font-mono text-base font-black tracking-wide bg-slate-100 dark:bg-slate-800 rounded-lg py-2.5 select-all">${opEsc(password)}</div>
            <button onclick="opCloseUserModal()" class="mt-4 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold">Done</button>
        </div>`;
    document.body.appendChild(wrap);
}
async function opSaveStandingCc() {
    const v = document.getElementById('opsStandingCc').value.trim();
    const { ok } = await opJSON('/api/settings/standing-cc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ standingCc: v }) });
    alert(ok ? 'Saved.' : 'Failed.');
}
