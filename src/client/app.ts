// app.ts — application code for item_tracker.html.
// Compiled by `npm run build:client` to /js/app.js as a classic
// (non-module) script, so top-level declarations stay page-global and the
// HTML's inline event handlers keep resolving them.

// ===== extracted from item_tracker.html lines 2602-7513 =====
        // DOM Elements
        const addForm = document.getElementById('addForm');
        const tableBody = document.getElementById('tableBody');
        const emptyState = document.getElementById('emptyState');
        const searchInput = document.getElementById('searchInput');
        const addModal = document.getElementById('addModal');
        const editRequestDetailsForm = document.getElementById('editRequestDetailsForm');
        const activeMrnContainer = document.getElementById('activeMrnContainer');
        const activeMrnList = document.getElementById('activeMrnList');

        // State variables
        let items: Item[] = [];
        let searchQuery = '';
        let currentFilterTab = 'all';
        let isSidebarCollapsed = false;
        let sortColumn = 'reqDate'; // Default sort
        let sortDirection = 'desc'; // Default direction
        let searchStartDate = '';
        let searchEndDate = '';
        let searchVehicle = 'all';
        let searchCategory = 'all';
        let searchRequestSource = 'all';
        let lastDataVersion = null; // /api/summary change signature for cheap polling

        // Batteries state
        let batteries: BatteryRec[] = [];
        let batterySearchQuery = '';
        let batteryStatusFilter = 'all';

        // Material Transfers state
        let transfers: TransferRec[] = [];

        // Fast deep clone for the per-render display copies. Native
        // structuredClone avoids the multi-MB string round-trip that
        // JSON.parse(JSON.stringify(...)) did on every fleet/inventory render
        // (review finding 12), with identical semantics; JSON is the fallback.
        const cloneDeep = (typeof (globalThis as any).structuredClone === 'function')
            ? (x) => (globalThis as any).structuredClone(x)
            : (x) => JSON.parse(JSON.stringify(x));

        // Category + Issues state
        const FALLBACK_CATEGORIES = ['Battery','Filters','Tyre','Oil & Lubricants','Electrical','Bearings & Seals','Belts','Hydraulics','General Items'];

        // Purchase-source taxonomy — the client mirror of costing.js
        // (PURCHASE_SOURCES). Keep these alias lists in sync with that file;
        // both classify the same spellings. One list drives every client use.
        const SOURCE_LOCAL = ['local purchase', 'local store', 'local'];
        const SOURCE_HEAD_OFFICE = ['head office purchase', 'headoffice purchase', 'direct purchase', 'head office', 'headoffice', 'pre-ordered'];
        // Fold any legacy purchase-source spelling into the two canonical values.
        function canonicalSourceText(v) {
            const t = String(v || '').trim().toLowerCase();
            if (SOURCE_LOCAL.includes(t)) return 'Local Purchase';
            if (SOURCE_HEAD_OFFICE.includes(t)) return 'Head Office Purchase';
            return String(v || '');
        }
        // Classify a purchaseSource into a dashboard origin bucket.
        function originOfSource(v) {
            const t = String(v || '').trim().toLowerCase();
            if (SOURCE_HEAD_OFFICE.includes(t)) return 'headOffice';
            if (SOURCE_LOCAL.includes(t)) return 'local';
            return 'other';
        }

        // Total qty already issued against a request item. One shared rule for
        // Issue Desk, Fleet and Store Stock: the hard itemId link wins, then
        // MRN + name, then vehicle + name, then name alone (legacy rows).
        //
        // Every non-itemId branch requires the issue's name to equal the item's,
        // so we bucket issues by name once per data load and scan only the
        // matching bucket instead of the whole `issues` array for every item —
        // turning the O(items × issues) render loop into O(items × sameName)
        // (review finding 12). `_issuedIndex` is rebuilt lazily after each load.
        let _issuedIndex: { byItemId: Map<string, number>, byName: Map<string, IssueRec[]>, byId: Map<string, IssueRec> } | null = null;
        function invalidateIssuedIndex() { _issuedIndex = null; }
        function buildIssuedIndex() {
            const byItemId = new Map<string, number>();
            const byName = new Map<string, IssueRec[]>();
            const byId = new Map<string, IssueRec>();
            for (const is of issues) {
                byId.set(String(is.id), is);
                if (is.itemId) {
                    const k = String(is.itemId);
                    byItemId.set(k, (byItemId.get(k) || 0) + (Number(is.qty) || 0));
                } else {
                    const k = String(is.itemName || '').trim().toLowerCase();
                    let arr = byName.get(k); if (!arr) { arr = []; byName.set(k, arr); }
                    arr.push(is);
                }
            }
            _issuedIndex = { byItemId, byName, byId };
        }
        function issuedQtyForItem(item, excludeIssueId = null) {
            if (!_issuedIndex) buildIssuedIndex();
            const idx = _issuedIndex!;
            const norm = (v) => String(v || '').trim().toLowerCase();
            const itemName = norm(item.name || item.itemName);
            // Hard itemId links (exact) — subtract the excluded issue if it is one.
            let sum = idx.byItemId.get(String(item.id)) || 0;
            if (excludeIssueId) {
                const ex = idx.byId.get(String(excludeIssueId));
                if (ex && ex.itemId && String(ex.itemId) === String(item.id)) sum -= Number(ex.qty) || 0;
            }
            // Non-linked issues that share this item's name (a small bucket).
            const bucket = idx.byName.get(itemName) || [];
            for (const is of bucket) {
                if (excludeIssueId && String(is.id) === String(excludeIssueId)) continue;
                let match;
                if (item.mrnNum && is.mrnNum) match = norm(is.mrnNum) === norm(item.mrnNum);
                else if (item.vehicleMachinery && is.vehicleMachinery) match = norm(is.vehicleMachinery) === norm(item.vehicleMachinery);
                else match = true;   // name already equal (bucket key)
                if (match) sum += Number(is.qty) || 0;
            }
            return sum;
        }
        let allCategories = FALLBACK_CATEGORIES.slice();
        let categoryCounts: Record<string, number> = {};
        let allVehicles: string[] = [];
        let issues: IssueRec[] = [];
        let issueFilters = { search: '', vehicle: 'all', category: 'all', startDate: '', endDate: '' };
        let issueSearchTimeout;

        // Server-side Pagination state
        let currentPage = 1;
        let pageSize = 50;
        let totalItems = 0;
        let totalPages = 1;
        let allItems: Item[] = [];
        let currentView = 'dashboard';
        let searchTimeout;

        // Local-First Synchronizer Service
        class DatabaseSync {
            queue: QueueAction[];
            isProcessing: boolean;
            retryInterval: number;

            constructor() {
                this.queue = JSON.parse(localStorage.getItem('delivery_sync_queue') || '[]');
                this.isProcessing = false;
                this.retryInterval = 2000;
            }

            saveQueue() {
                localStorage.setItem('delivery_sync_queue', JSON.stringify(this.queue));
                this.updateIndicator();
            }

            async enqueue(action, url, method, body, optimisticMutator) {
                const tempId = 'opt-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
                const queueItem = {
                    id: tempId,
                    action,
                    url,
                    method,
                    body,
                    retries: 0,
                    timestamp: Date.now()
                };

                this.queue.push(queueItem);
                this.saveQueue();

                if (optimisticMutator) {
                    try {
                        optimisticMutator(tempId);
                    } catch (err) {
                        console.error('Optimistic mutation failed:', err);
                    }
                }

                this.processQueue();
                return tempId;
            }

            updateIndicator() {
                const dot = document.getElementById('syncStatusDot');
                const text = document.getElementById('syncStatusText');
                if (!dot || !text) return;

                if (this.queue.length === 0) {
                    dot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]";
                    text.textContent = "Synced";
                    text.className = "text-emerald-400 font-bold";
                } else if (this.isProcessing) {
                    dot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.7)] animate-pulse";
                    text.textContent = `Syncing (${this.queue.length})...`;
                    text.className = "text-amber-400 font-bold";
                } else {
                    const hasError = this.queue.some(q => q.retries > 5);
                    if (hasError) {
                        dot.className = "w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)] animate-pulse";
                        text.textContent = `Sync Error (${this.queue.length})`;
                        text.className = "text-rose-400 font-bold cursor-pointer";
                        text.title = "Click to retry sync";
                        text.onclick = () => {
                            this.queue.forEach(q => q.retries = 0);
                            this.saveQueue();
                            this.processQueue();
                        };
                    } else {
                        dot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.7)] animate-pulse";
                        text.textContent = `Pending (${this.queue.length})`;
                        text.className = "text-amber-400 font-bold";
                    }
                }
            }

            async processQueue() {
                if (this.isProcessing || this.queue.length === 0) {
                    this.updateIndicator();
                    return;
                }

                this.isProcessing = true;
                this.updateIndicator();

                const item = this.queue[0];
                
                if (item.retries > 0) {
                    const wait = Math.min(30000, Math.pow(2, item.retries) * 1000);
                    await new Promise(resolve => setTimeout(resolve, wait));
                }

                try {
                    const fetchOptions = {
                        method: item.method,
                        headers: { 'Content-Type': 'application/json' },
                        body: item.body ? JSON.stringify(item.body) : undefined
                    };

                    const response = await fetch(item.url, fetchOptions);
                    if (!response.ok) {
                        throw new Error(`Sync failed with status: ${response.status}`);
                    }

                    const responseData = await response.json();
                    this.queue.shift();
                    this.saveQueue();
                    
                    if (item.action === 'CREATE_ITEM' && responseData && responseData.id) {
                        const realId = responseData.id;
                        const tempId = item.id;
                        
                        const memItem = items.find(i => String(i.id) === String(tempId));
                        if (memItem) {
                            memItem.id = realId;
                            (memItem.receipts || []).forEach(r => {
                                r.itemId = realId;
                            });
                        }
                        this.updateQueueItemIds(tempId, realId);
                    } else if (item.action === 'CREATE_RECEIPT' && responseData && responseData.id) {
                        const realRecId = responseData.id;
                        const tempRecId = item.id;
                        
                        items.forEach(memItem => {
                            const rec = (memItem.receipts || []).find(r => String(r.id) === String(tempRecId));
                            if (rec) {
                                rec.id = realRecId;
                            }
                        });
                        this.updateQueueItemIds(tempRecId, realRecId);
                    }

                    this.isProcessing = false;
                    
                    // Reload current page items to align with DB
                    loadItems();

                } catch (error) {
                    console.error('Queue item processing error:', error);
                    item.retries++;
                    this.isProcessing = false;
                    
                    if (item.retries > 5) {
                        this.saveQueue();
                    } else {
                        this.saveQueue();
                        setTimeout(() => this.processQueue(), this.retryInterval);
                    }
                }
            }

            updateQueueItemIds(tempId, realId) {
                this.queue = this.queue.map(q => {
                    if (q.url.includes('/' + tempId)) {
                        q.url = q.url.replace('/' + tempId, '/' + realId);
                    }
                    if (q.body) {
                        let bodyStr = JSON.stringify(q.body);
                        if (bodyStr.includes(tempId)) {
                            bodyStr = bodyStr.replace(new RegExp(tempId, 'g'), realId);
                            q.body = JSON.parse(bodyStr);
                        }
                    }
                    return q;
                });
                localStorage.setItem('delivery_sync_queue', JSON.stringify(this.queue));
            }
        }

        const syncService = new DatabaseSync();
        // Start processing background sync queue on startup
        setTimeout(() => syncService.processQueue(), 500);

        // Dark/Light Theme Support
        function initTheme() {
            const isDark = localStorage.getItem('darkMode') === 'true' || 
                (!('darkMode' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
            
            if (isDark) {
                document.documentElement.classList.add('dark');
                document.getElementById('themeIconSun').classList.remove('hidden');
                document.getElementById('themeIconMoon').classList.add('hidden');
            } else {
                document.documentElement.classList.remove('dark');
                document.getElementById('themeIconSun').classList.add('hidden');
                document.getElementById('themeIconMoon').classList.remove('hidden');
            }
        }

        function toggleDarkMode() {
            const htmlClass = document.documentElement.classList;
            const themeSun = document.getElementById('themeIconSun');
            const themeMoon = document.getElementById('themeIconMoon');
            
            if (htmlClass.contains('dark')) {
                htmlClass.remove('dark');
                themeSun.classList.add('hidden');
                themeMoon.classList.remove('hidden');
                localStorage.setItem('darkMode', 'false');
            } else {
                htmlClass.add('dark');
                themeSun.classList.remove('hidden');
                themeMoon.classList.add('hidden');
                localStorage.setItem('darkMode', 'true');
            }
            // Trigger chart refresh for grid color alignments
            renderTable();
        }

        // Sidebar Collapse Logic
        // On phones the sidebar is an off-canvas drawer (it is display:none in the
        // flow and slides in over a backdrop); on md+ the hamburger keeps its
        // original desktop collapse behaviour.
        const isMobileViewport = () => window.matchMedia('(max-width: 767px)').matches;
        function closeMobileSidebar() {
            const sidebar = document.querySelector('aside');
            if (sidebar) sidebar.classList.remove('mobile-open');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (backdrop) backdrop.classList.remove('show');
        }
        function toggleMobileSidebar() {
            const sidebar = document.querySelector('aside');
            const backdrop = document.getElementById('sidebarBackdrop');
            const open = sidebar && sidebar.classList.toggle('mobile-open');
            if (backdrop) backdrop.classList.toggle('show', !!open);
        }
        function toggleSidebar() {
            if (isMobileViewport()) { toggleMobileSidebar(); return; }
            isSidebarCollapsed = !isSidebarCollapsed;
            const sidebar = document.querySelector('aside');
            const toggleIcon = document.getElementById('sidebarToggleIcon');

            if (isSidebarCollapsed) {
                sidebar.classList.add('sidebar-collapsed');
                if (toggleIcon) toggleIcon.setAttribute('d', 'M9 5l7 7-7 7');
                localStorage.setItem('sidebarCollapsed', 'true');
            } else {
                sidebar.classList.remove('sidebar-collapsed');
                if (toggleIcon) toggleIcon.setAttribute('d', 'M4 6h16M4 12h16M4 18h16');
                localStorage.setItem('sidebarCollapsed', 'false');
            }
        }
        
        function initSidebarState() {
            const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
            const sidebar = document.querySelector('aside');
            const toggleIcon = document.getElementById('sidebarToggleIcon');
            if (collapsed) {
                isSidebarCollapsed = true;
                if (sidebar) sidebar.classList.add('sidebar-collapsed');
                if (toggleIcon) toggleIcon.setAttribute('d', 'M9 5l7 7-7 7');
            } else {
                if (toggleIcon) toggleIcon.setAttribute('d', 'M4 6h16M4 12h16M4 18h16');
            }
        }

        // Dropdown Actions Toggles
        function toggleActionsDropdown() {
            const dropdown = document.getElementById('actionsDropdown');
            dropdown.classList.toggle('hidden');
        }
        
        function closeActionsDropdown() {
            const dropdown = document.getElementById('actionsDropdown');
            dropdown.classList.add('hidden');
        }
        
        window.addEventListener('click', (e) => {
            const container = document.getElementById('actionsDropdownContainer');
            if (container && !container.contains(e.target)) {
                closeActionsDropdown();
            }
        });

        // Add Modals Toggles
        function openAddModal() { addModal.classList.remove('hidden'); if (typeof populateJobLinkSelect === 'function') populateJobLinkSelect(); }
        function closeAddModal() { 
            addModal.classList.add('hidden'); 
            addForm.reset(); 
            document.getElementById('reqDate').valueAsDate = new Date(); 
        }

        // Formatting utilities
        function formatCurrency(amount) {
            if (amount === null || amount === undefined || isNaN(amount)) return '-';
            return 'Rs. ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function parseDate(dateStr) {
            if (!dateStr) return new Date(0);
            const str = String(dateStr);
            if (str.includes('-')) {
                const parts = str.split('-');
                if (parts.length === 3 && parts[0].length === 4) {
                    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
                }
            }
            if (str.includes('/')) {
                const parts = str.split('/');
                if (parts.length === 3) {
                    const month = parseInt(parts[0], 10);
                    const day = parseInt(parts[1], 10);
                    const year = parseInt(parts[2], 10);
                    return new Date(year, month - 1, day);
                }
            }
            const parsed = new Date(str);
            return isNaN(parsed.getTime()) ? new Date(0) : parsed;
        }

        function calculateDateGap(reqDate, recDate) {
            if (!recDate) return '<span class="text-slate-400">-</span>';
            const d1 = new Date(reqDate);
            const d2 = new Date(recDate);
            const diffTime = d2.getTime() - d1.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            
            if (diffDays < 0) return `<span class="text-emerald-600 dark:text-emerald-400 font-bold">${Math.abs(diffDays)} days early</span>`;
            if (diffDays === 0) return `<span class="text-indigo-650 dark:text-indigo-400 font-bold">Same day</span>`;
            return `<span class="text-amber-600 dark:text-amber-500 font-bold">${diffDays} days delay</span>`;
        }

        function getStatusBadge(reqQty, recQty, reqDateStr) {
            if (recQty < reqQty) {
                const reqDate = parseDate(reqDateStr);
                const today = new Date();
                today.setHours(0,0,0,0);
                if (reqDate < today) {
                    return '<span class="px-2.5 py-1 inline-flex text-[10px] leading-tight font-extrabold rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-100 dark:border-rose-900/30 shadow-sm">Overdue</span>';
                }
            }
            if (recQty === 0) return '<span class="px-2.5 py-1 inline-flex text-[10px] leading-tight font-extrabold rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-100 dark:border-amber-900/30 shadow-sm">Pending</span>';
            if (recQty < reqQty) return '<span class="px-2.5 py-1 inline-flex text-[10px] leading-tight font-extrabold rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-900/30 shadow-sm">Partial</span>';
            if (recQty === reqQty) return '<span class="px-2.5 py-1 inline-flex text-[10px] leading-tight font-extrabold rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/30 shadow-sm">Completed</span>';
            if (recQty > reqQty) return '<span class="px-2.5 py-1 inline-flex text-[10px] leading-tight font-extrabold rounded-full bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 border border-purple-100 dark:border-purple-900/30 shadow-sm">Over-received</span>';
        }

        // Get pricing summary calculations
        function getItemPricingInfo(item) {
            const receipts = item.receipts || [];
            let totalCost = 0;
            const suppliers = new Set<string>();
            const grns = new Set<string>();
            let hasPricing = false;

            receipts.forEach(r => {
                if (r.unitPrice && r.qty > 0) {
                    totalCost += Math.abs(r.qty) * r.unitPrice;
                    hasPricing = true;
                }
                if (r.supplierName) suppliers.add(r.supplierName);
                if (r.grnNumber) grns.add(r.grnNumber);
            });

            return {
                totalCost: Math.round(totalCost * 100) / 100,
                suppliers: [...suppliers],
                grns: [...grns],
                hasPricing
            };
        }
                // Column Sorting Trigger
        function toggleSort(col) {
            if (sortColumn === col) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = col;
                sortDirection = 'desc';
            }
            fetchTrackerPage();
        }

        // Highlight matching query helper.
        // SECURITY: HTML-escape the source text FIRST, then wrap matches — the
        // result is injected via innerHTML, so raw data here would be stored XSS.
        function highlightMatch(text, query) {
            if (text === null || text === undefined) return '-';
            const safe = escapeHtml(String(text));
            if (!query) return safe || '-';
            // Escape the query for HTML too, then for regex, so it matches the escaped text.
            const escapedQuery = escapeHtml(String(query)).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            if (!escapedQuery) return safe || '-';
            const regex = new RegExp(`(${escapedQuery})`, 'gi');
            return safe.replace(regex, '<span class="search-highlight">$1</span>') || '-';
        }

        // Get sorted indicator text
        function updateHeaderSortIndicators() {
            ['mrnNum', 'itemName', 'reqDate', 'recQty', 'gap', 'pricing'].forEach(col => {
                const indicatorsEl = document.getElementById('sort-' + col);
                if (indicatorsEl) {
                    if (sortColumn === col) {
                        indicatorsEl.innerHTML = sortDirection === 'asc' ? ' ▲' : ' ▼';
                        indicatorsEl.className = 'ml-1 text-[10px] text-indigo-650 dark:text-indigo-400 font-bold';
                    } else {
                        indicatorsEl.innerHTML = '';
                    }
                }
            });
        }

        // Apply local sync queue actions optimistically in-memory
        function applyQueueMutations(itemsList) {
            syncService.queue.forEach(q => {
                try {
                    if (q.action === 'CREATE_ITEM') {
                        const b = q.body;
                        itemsList.unshift({
                            id: q.id,
                            mrnNum: b.mrnNum,
                            reqDate: b.reqDate,
                            vehicleMachinery: b.vehicleMachinery,
                            itemName: b.itemName,
                            name: b.itemName,
                            itemDesc: b.itemDesc,
                            reqQty: b.reqQty,
                            category: b.category || '',
                            requestSource: b.requestSource || null,
                            recQty: 0,
                            recDate: null,
                            purchaseSource: '',
                            receipts: []
                        });
                    } else if (q.action === 'DELETE_ITEM') {
                        const match = q.url.match(/\/api\/items\/([^/]+)/);
                        if (match) {
                            const delId = match[1];
                            const idx = itemsList.findIndex(i => String(i.id) === String(delId));
                            if (idx !== -1) itemsList.splice(idx, 1);
                        }
                    } else if (q.action === 'UPDATE_ITEM') {
                        const match = q.url.match(/\/api\/items\/([^/]+)/);
                        if (match) {
                            const editId = match[1];
                            const item = itemsList.find(i => String(i.id) === String(editId));
                            if (item) {
                                Object.assign(item, q.body);
                                item.name = q.body.itemName;
                            }
                        }
                    } else if (q.action === 'CREATE_RECEIPT') {
                        const match = q.url.match(/\/api\/items\/([^/]+)\/receipts/);
                        if (match) {
                            const itemId = match[1];
                            const item = itemsList.find(i => String(i.id) === String(itemId));
                            if (item) {
                                item.receipts = item.receipts || [];
                                item.receipts.push({
                                    id: q.id,
                                    itemId: itemId,
                                    ...q.body
                                });
                                recalcItemReceipts(item);
                            }
                        }
                    } else if (q.action === 'UPDATE_RECEIPT') {
                        const match = q.url.match(/\/api\/receipts\/([^/]+)/);
                        if (match) {
                            const recId = match[1];
                            itemsList.forEach(item => {
                                if (item.receipts) {
                                    const rec = item.receipts.find(r => String(r.id) === String(recId));
                                    if (rec) {
                                        Object.assign(rec, q.body);
                                        recalcItemReceipts(item);
                                    }
                                }
                            });
                        }
                    } else if (q.action === 'DELETE_RECEIPT') {
                        const match = q.url.match(/\/api\/receipts\/([^/]+)/);
                        if (match) {
                            const recId = match[1];
                            itemsList.forEach(item => {
                                if (item.receipts) {
                                    const lengthBefore = item.receipts.length;
                                    item.receipts = item.receipts.filter(r => String(r.id) !== String(recId));
                                    if (item.receipts.length !== lengthBefore) {
                                        recalcItemReceipts(item);
                                    }
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error("Optimistic mutation error:", err, q);
                }
            });
        }

        // Fetch paginated page of items for the tracker grid
        async function fetchTrackerPage() {
            try {
                const url = `/api/items?page=${currentPage}&limit=${pageSize}&search=${encodeURIComponent(searchQuery)}&filter=${currentFilterTab}&sort=${sortColumn}&order=${sortDirection}&startDate=${encodeURIComponent(searchStartDate)}&endDate=${encodeURIComponent(searchEndDate)}&vehicle=${encodeURIComponent(searchVehicle)}&category=${encodeURIComponent(searchCategory)}&requestSource=${encodeURIComponent(searchRequestSource)}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error('Failed to load tracker page');
                const data = await res.json();
                
                if (data && data.items) {
                    items = data.items.map(item => {
                        item.name = item.itemName;
                        recalcItemReceipts(item);
                        return item;
                    });
                    totalItems = data.total;
                    totalPages = data.totalPages;
                } else {
                    items = data.map(item => {
                        item.name = item.itemName;
                        recalcItemReceipts(item);
                        return item;
                    });
                    totalItems = items.length;
                    totalPages = 1;
                }
                
                renderTable();
            } catch (err) {
                console.error("Tracker page load error:", err);
            }
        }

        // Fetch unpaginated database items for metrics summaries
        async function loadAllData() {
            try {
                // Fetch batteries list globally
                await fetchBatteries();
                // Fetch transfers list globally
                await fetchTransfers();

                const res = await fetch('/api/items');
                if (!res.ok) throw new Error('Failed to load full database list');
                const rawAllItems = await res.json();
                
                allItems = rawAllItems.map(item => {
                    item.name = item.itemName;
                    recalcItemReceipts(item);
                    return item;
                });

                // Fetch issues list globally for fleet pending calculations
                try {
                    const resIssues = await fetch('/api/issues');
                    if (resIssues.ok) {
                        issues = await resIssues.json();
                        invalidateIssuedIndex();
                    }
                } catch (err) {
                    console.error("Failed to load issues list:", err);
                }

                // Populate vehicle select dropdown dynamically
                populateAdvancedSearchVehicles();

                // Set dynamic sidebar badge counts
                updateSidebarBadges();

                if (currentView === 'tracker') {
                    await fetchTrackerPage();
                } else {
                    renderCurrentView();
                }
            } catch (e) {
                console.error(e);
            }
        }

        // Advanced Search Functions
        function toggleAdvancedSearch() {
            const panel = document.getElementById('advancedSearchPanel');
            const btn = document.getElementById('advSearchToggleBtn');
            if (!panel || !btn) return;
            
            if (panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                btn.classList.add('bg-indigo-50', 'dark:bg-indigo-950/40', 'border-indigo-300', 'dark:border-indigo-900/50', 'text-indigo-650', 'dark:text-indigo-400');
            } else {
                panel.classList.add('hidden');
                btn.classList.remove('bg-indigo-50', 'dark:bg-indigo-950/40', 'border-indigo-300', 'dark:border-indigo-900/50', 'text-indigo-650', 'dark:text-indigo-400');
            }
        }

        function handleAdvSearchChange() {
            searchStartDate = document.getElementById('advStartDate').value;
            searchEndDate = document.getElementById('advEndDate').value;
            searchVehicle = document.getElementById('advVehicle').value;
            const advCat = document.getElementById('advCategory');
            if (advCat) searchCategory = advCat.value;
            const advSrc = document.getElementById('advRequestSource');
            if (advSrc) searchRequestSource = advSrc.value;
            currentPage = 1;
            renderCategoryChips();
            fetchTrackerPage();
        }

        function resetAdvancedSearch() {
            document.getElementById('advStartDate').value = '';
            document.getElementById('advEndDate').value = '';
            document.getElementById('advVehicle').value = 'all';
            const advCat = document.getElementById('advCategory');
            if (advCat) advCat.value = 'all';
            const advSrc = document.getElementById('advRequestSource');
            if (advSrc) advSrc.value = 'all';
            searchStartDate = '';
            searchEndDate = '';
            searchVehicle = 'all';
            searchCategory = 'all';
            searchRequestSource = 'all';
            currentPage = 1;
            renderCategoryChips();
            fetchTrackerPage();
        }

        function populateAdvancedSearchVehicles() {
            const select = document.getElementById('advVehicle');
            if (!select) return;

            const vehicles = new Set<string>();
            allItems.forEach(item => {
                if (item.vehicleMachinery) {
                    const trimmed = item.vehicleMachinery.trim();
                    if (trimmed) vehicles.add(trimmed);
                }
            });

            const currentSelected = searchVehicle;
            select.innerHTML = '<option value="all">All Vehicles / Machinery</option>';
            
            const sortedVehicles = Array.from(vehicles).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            sortedVehicles.forEach(vehicle => {
                const opt = document.createElement('option');
                opt.value = vehicle;
                opt.textContent = vehicle;
                if (vehicle === currentSelected) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });
        }

        // ---- Categories ------------------------------------------------------
        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function categoryBadgeClass(cat) {
            const map = {
                'Battery': 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900/30',
                'Filters': 'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900/30',
                'Tyre': 'bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800/60 dark:text-stone-300 dark:border-stone-700',
                'Oil & Lubricants': 'bg-orange-50 text-orange-700 border-orange-100 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900/30',
                'Electrical': 'bg-violet-50 text-violet-700 border-violet-100 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900/30',
                'Bearings & Seals': 'bg-teal-50 text-teal-700 border-teal-100 dark:bg-teal-950/40 dark:text-teal-400 dark:border-teal-900/30',
                'Belts': 'bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/30',
                'Hydraulics': 'bg-cyan-50 text-cyan-700 border-cyan-100 dark:bg-cyan-950/40 dark:text-cyan-400 dark:border-cyan-900/30',
                'General Items': 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700'
            };
            return map[cat] || map['General Items'];
        }

        async function loadCategories() {
            try {
                const res = await fetch('/api/categories');
                if (res.ok) {
                    const d = await res.json();
                    allCategories = (d.categories && d.categories.length) ? d.categories : FALLBACK_CATEGORIES;
                    categoryCounts = d.counts || {};
                }
            } catch (e) { /* offline — keep fallback */ }
            populateCategoryDropdowns();
            renderCategoryChips();
        }

        function populateCategoryDropdowns() {
            document.querySelectorAll('.category-select').forEach(sel => {
                const cur = sel.value;
                sel.innerHTML = '<option value="">Auto-detect from name</option>' + allCategories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
                sel.value = cur;
            });
            ['advCategory', 'issueCategoryFilter'].forEach(id => {
                const sel = document.getElementById(id);
                if (!sel) return;
                const cur = sel.value || 'all';
                sel.innerHTML = '<option value="all">All Categories</option>' + allCategories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}${categoryCounts[c] ? ` (${categoryCounts[c]})` : ''}</option>`).join('');
                sel.value = cur;
            });
        }

        function renderCategoryChips() {
            const c = document.getElementById('categoryChips');
            if (!c) return;
            const total = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
            const chip = (label, val, count) => {
                const active = searchCategory === val;
                const base = active
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700';
                const countCls = active ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-500';
                return `<button onclick="setCategoryFilter('${String(val).replace(/'/g, "\\'")}')" class="px-3.5 py-1.5 rounded-full text-xs font-bold border transition ${base}">${escapeHtml(label)}${count != null ? ` <span class="${countCls} font-extrabold">${count}</span>` : ''}</button>`;
            };
            let html = chip('All', 'all', total);
            allCategories.forEach(cat => { html += chip(cat, cat, categoryCounts[cat] || 0); });
            c.innerHTML = html;
        }

        function setCategoryFilter(cat) {
            searchCategory = cat;
            const adv = document.getElementById('advCategory');
            if (adv) adv.value = cat;
            currentPage = 1;
            renderCategoryChips();
            fetchTrackerPage();
        }

        async function loadVehicles() {
            try {
                const res = await fetch('/api/vehicles');
                if (res.ok) allVehicles = await res.json();
            } catch (e) { /* ignore */ }
            const dl = document.getElementById('vehicleDatalist');
            if (dl) dl.innerHTML = allVehicles.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
            const sel = document.getElementById('issueVehicleFilter');
            if (sel) {
                const cur = sel.value || 'all';
                sel.innerHTML = '<option value="all">All Vehicles</option>' + allVehicles.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
                sel.value = cur;
            }
        }

        // ---- Issued Items ----------------------------------------------------
        function toDateInput(str) {
            if (!str) return '';
            if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
            const d = parseDate(str);
            if (isNaN(d.getTime()) || d.getTime() === 0) return '';
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        async function loadIssues() {
            try {
                const p = new URLSearchParams();
                if (issueFilters.search) p.set('search', issueFilters.search);
                if (issueFilters.vehicle && issueFilters.vehicle !== 'all') p.set('vehicle', issueFilters.vehicle);
                if (issueFilters.category && issueFilters.category !== 'all') p.set('category', issueFilters.category);
                if (issueFilters.startDate) p.set('startDate', issueFilters.startDate);
                if (issueFilters.endDate) p.set('endDate', issueFilters.endDate);
                const res = await fetch('/api/issues?' + p.toString());
                issues = res.ok ? await res.json() : [];
                invalidateIssuedIndex();
            } catch (e) { issues = []; invalidateIssuedIndex(); }
            renderIssuesTable();
        }

        async function refreshIssueBadge() {
            try {
                const r = await fetch('/api/issues');
                const all = r.ok ? await r.json() : [];
                const b = document.getElementById('count-issued');
                if (b) b.textContent = all.length;
            } catch (e) { /* ignore */ }
        }

        function renderIssuesView() { loadIssues(); }

        function renderIssuesTable() {
            const body = document.getElementById('issuesTableBody');
            const empty = document.getElementById('issuesEmptyState');
            const countEl = document.getElementById('issuesCount');
            if (!body) return;
            if (countEl) countEl.textContent = issues.length;
            if (!issues.length) { body.innerHTML = ''; if (empty) empty.classList.remove('hidden'); return; }
            if (empty) empty.classList.add('hidden');
            body.innerHTML = issues.map(is => `
                <tr class="hover:bg-indigo-50/30 dark:hover:bg-slate-850/20 transition">
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-slate-800 dark:text-slate-200">${escapeHtml(is.issueDate) || '-'}</td>
                    <td class="px-6 py-4">
                        <div class="text-sm font-bold text-slate-800 dark:text-slate-200">${escapeHtml(is.itemName) || '-'}</div>
                        ${is.itemDesc ? `<div class="text-xs text-slate-400 dark:text-slate-500 truncate max-w-[200px]">${escapeHtml(is.itemDesc)}</div>` : ''}
                        ${is.category ? `<div class="mt-1"><span class="inline-flex text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-md border ${categoryBadgeClass(is.category)}">${escapeHtml(is.category)}</span></div>` : ''}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold text-slate-700 dark:text-slate-300">${escapeHtml(is.vehicleMachinery) || '-'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-extrabold text-indigo-650 dark:text-indigo-400">
                        ${is.qty}
                        ${is.unitPrice != null ? `<div class="text-[10px] font-bold text-slate-500 dark:text-slate-400 mt-0.5">@ ${formatCurrency(is.unitPrice)} = ${formatCurrency(is.qty * is.unitPrice)}</div>` : `<div class="text-[10px] text-slate-400 dark:text-slate-600 mt-0.5 italic">no price</div>`}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-xs text-slate-600 dark:text-slate-400">
                        <div class="font-semibold text-slate-700 dark:text-slate-300">${escapeHtml(is.issuedTo) || '-'}</div>
                        ${is.issuedBy ? `<div class="text-slate-400 dark:text-slate-500">by ${escapeHtml(is.issuedBy)}</div>` : ''}
                        ${is.mrnNum ? `<div class="text-[10px] text-indigo-500 dark:text-indigo-400 font-bold mt-0.5">MRN: ${escapeHtml(is.mrnNum)}</div>` : ''}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-right">
                        <div class="flex items-center justify-end gap-1.5">
                            <a href="#issue-desk/edit/${is.id}" class="p-2 bg-blue-50/50 dark:bg-slate-800/40 text-blue-600 dark:text-blue-400 hover:bg-blue-650 hover:text-white dark:hover:text-white rounded-xl transition border border-blue-100/40 dark:border-slate-700/60 flex items-center justify-center" title="Edit Issue"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg></a>
                            <button onclick="deleteIssue(${is.id})" class="p-2 bg-rose-50/50 dark:bg-slate-800/40 text-rose-600 dark:text-rose-455 hover:bg-rose-650 hover:text-white dark:hover:text-white rounded-xl transition border border-rose-100/40 dark:border-slate-700/60" title="Delete Issue"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                        </div>
                    </td>
                </tr>`).join('');
        }

        // Setup dynamic drop-downs and auto-fills in Issue Desk View
        function setupIssueDesk(type = null, id = null) {
            const form = document.getElementById('issueDeskForm');
            const select = document.getElementById('issueDeskItemSelect');
            const searchInput = document.getElementById('issueDeskMrnSearch');
            const datalist = document.getElementById('issueDeskMrnOptions');
            const metaContainer = document.getElementById('issueDeskMetadata');
            const qtyInput = document.getElementById('issueDeskQty');
            const issueIdInput = document.getElementById('issueDeskId');
            const titleEl = document.getElementById('issueDeskTitle');
            const subEl = document.getElementById('issueDeskSub');
            
            if (!form || !searchInput || !datalist) return;
            form.reset();
            issueIdInput.value = '';
            
            // Set default date to today
            document.getElementById('issueDeskDate').value = new Date().toISOString().split('T')[0];

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Filter out items that have already been fully issued OR have not been received yet
            const activeItems = displayAll.filter(item => {
                const issuedQty = issuedQtyForItem(item);
                // Only received items (item.recQty > 0) can be issued, and only up to the received quantity (issuedQty < item.recQty)
                return item.recQty > 0 && issuedQty < item.recQty;
            });

            // Populate the MRN search datalist
            datalist.innerHTML = '';
            activeItems.forEach(item => {
                const opt = document.createElement('option');
                opt.value = `${item.mrnNum} - ${item.name} (${item.vehicleMachinery})`;
                datalist.appendChild(opt);
            });

            // Handle typing / selection in search
            searchInput.oninput = () => {
                const val = searchInput.value;
                const match = activeItems.find(item => 
                    `${item.mrnNum} - ${item.name} (${item.vehicleMachinery})` === val
                );
                if (match) {
                    select.value = match.id;
                    handleIssueItemSelection(match.id);
                } else {
                    select.value = '';
                    handleIssueItemSelection('');
                }
            };

            // If we have route parameters
            if (type === 'edit' && id) {
                // Editing an existing issue record
                const existingIssue = issues.find(x => String(x.id) === String(id));
                if (existingIssue) {
                    titleEl.innerHTML = `<svg class="w-6 h-6 text-indigo-655 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg> Edit Material Issue`;
                    subEl.textContent = `Modify the recorded issue record details.`;
                    
                    issueIdInput.value = existingIssue.id;
                    document.getElementById('issueDeskDate').value = toDateInput(existingIssue.issueDate);
                    document.getElementById('issueDeskVehicle').value = existingIssue.vehicleMachinery || '';
                    document.getElementById('issueDeskItemName').value = existingIssue.itemName || '';
                    document.getElementById('issueDeskCategory').value = existingIssue.category || '';
                    document.getElementById('issueDeskItemDesc').value = existingIssue.itemDesc || '';
                    document.getElementById('issueDeskQty').value = existingIssue.qty || '';
                    document.getElementById('issueDeskUnitPrice').value = (existingIssue.unitPrice != null ? existingIssue.unitPrice : '');
                    document.getElementById('issueDeskMrn').value = existingIssue.mrnNum || '';
                    document.getElementById('issueDeskIssuedTo').value = existingIssue.issuedTo || '';
                    document.getElementById('issueDeskIssuedBy').value = existingIssue.issuedBy || '';
                    document.getElementById('issueDeskNotes').value = existingIssue.notes || '';
                    updateIssueDeskCost();
                    
                    // Match MRN request item: the hard itemId link wins, then MRN + name.
                    if (existingIssue.itemId || existingIssue.mrnNum) {
                        const matchedItem = displayAll.find(item => existingIssue.itemId
                            ? String(item.id) === String(existingIssue.itemId)
                            : (item.mrnNum === existingIssue.mrnNum && item.itemName === existingIssue.itemName));
                        if (matchedItem) {
                            searchInput.value = `${matchedItem.mrnNum} - ${matchedItem.name} (${matchedItem.vehicleMachinery})`;
                            select.value = matchedItem.id;
                            handleIssueItemSelection(matchedItem.id);
                        } else {
                            searchInput.value = '';
                            select.value = '';
                            metaContainer.innerHTML = `Linked to MRN: <strong>${existingIssue.mrnNum}</strong>`;
                        }
                    } else {
                        searchInput.value = '';
                        select.value = '';
                        metaContainer.innerHTML = 'Manual entry mode (no MRN)';
                    }
                    searchInput.disabled = false;
                }
            } else if (type === 'request' && id) {
                // Creating a new issue pre-filled from an MRN request item
                const matchedItem = displayAll.find(item => String(item.id) === String(id));
                if (matchedItem) {
                    if (!matchedItem.recQty || matchedItem.recQty <= 0) {
                        alert("Error: Only received items can be issued. No delivery has been received for this request yet.");
                        window.location.hash = '#tracker';
                        return;
                    }
                    const issuedQty = issuedQtyForItem(matchedItem);
                    if (issuedQty >= matchedItem.recQty) {
                        alert("Error: This item has already been fully issued.");
                        window.location.hash = '#tracker';
                        return;
                    }

                    titleEl.innerHTML = `<svg class="w-6 h-6 text-indigo-655 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path></svg> Log Material Issue`;
                    subEl.textContent = `Search an active request MRN to prefill details, or log a custom store issue manually.`;
                    
                    searchInput.value = `${matchedItem.mrnNum} - ${matchedItem.name} (${matchedItem.vehicleMachinery})`;
                    select.value = id;
                    handleIssueItemSelection(id);
                    searchInput.disabled = false;
                }
            } else {
                // Empty new issue form
                titleEl.innerHTML = `<svg class="w-6 h-6 text-indigo-655 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path></svg> Log Material Issue`;
                subEl.textContent = `Search an active request MRN to prefill details, or log a custom store issue manually.`;
                
                searchInput.value = '';
                select.value = '';
                metaContainer.innerHTML = 'No request selected (manual entry mode)';
                
                document.getElementById('issueDeskVehicle').value = '';
                document.getElementById('issueDeskItemName').value = '';
                document.getElementById('issueDeskCategory').value = '';
                document.getElementById('issueDeskItemDesc').value = '';
                document.getElementById('issueDeskQty').value = '';
                document.getElementById('issueDeskUnitPrice').value = '';
                document.getElementById('issueDeskMrn').value = '';
                document.getElementById('issueDeskIssuedTo').value = '';
                document.getElementById('issueDeskIssuedBy').value = '';
                document.getElementById('issueDeskNotes').value = '';
                updateIssueDeskCost();

                searchInput.disabled = false;
            }
        }

        function handleIssueItemSelection(itemId) {
            const metaContainer = document.getElementById('issueDeskMetadata');
            if (!itemId) {
                metaContainer.innerHTML = 'No request selected (manual entry mode)';
                return;
            }

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) {
                metaContainer.innerHTML = 'Requisition item not found';
                return;
            }

            // Prefill issue form fields from selected request
            document.getElementById('issueDeskVehicle').value = item.vehicleMachinery || '';
            document.getElementById('issueDeskItemName').value = item.name || '';
            document.getElementById('issueDeskCategory').value = item.category || '';
            document.getElementById('issueDeskItemDesc').value = item.itemDesc || '';
            document.getElementById('issueDeskMrn').value = item.mrnNum || '';
            // Suggest a unit price from this item's priced deliveries (only if blank).
            suggestIssueDeskPrice(item.name || '', false);

            // We can show details in the metadata box
            metaContainer.innerHTML = `
                <div class="space-y-1 w-full text-xs font-semibold">
                    <div>Machinery: <strong class="text-slate-800 dark:text-white font-extrabold">${escapeHtml(item.vehicleMachinery)}</strong></div>
                    <div>Item Name: <strong class="text-slate-800 dark:text-white font-extrabold">${escapeHtml(item.name)}</strong></div>
                    <div>Fulfillment Status: <strong class="text-indigo-650 dark:text-indigo-400 font-extrabold">${item.recQty || 0} received of ${item.reqQty} requested</strong></div>
                    <div class="text-[10px] text-slate-450 dark:text-slate-500 font-medium">Requisition opened: ${item.reqDate}</div>
                </div>
            `;
        }

        // Recompute the "Issue value = qty × unit price" hint under the price field.
        function updateIssueDeskCost() {
            const qty = parseFloat((document.getElementById('issueDeskQty') || {}).value) || 0;
            const price = parseFloat((document.getElementById('issueDeskUnitPrice') || {}).value);
            const line = document.getElementById('issueDeskCostLine');
            if (!line) return;
            line.textContent = (qty > 0 && price >= 0 && !isNaN(price)) ? `Issue value: ${formatCurrency(qty * price)}` : '';
        }

        // Fetch a suggested unit price for an item name. When force=false, only
        // fills the field if it's currently empty (so a manual edit is kept).
        async function suggestIssueDeskPrice(itemName, force) {
            const el = document.getElementById('issueDeskUnitPrice');
            if (!el || !itemName) return;
            if (!force && String(el.value).trim() !== '') { updateIssueDeskCost(); return; }
            try {
                const data = await (await fetch('/api/issues/suggest-price?itemName=' + encodeURIComponent(itemName))).json();
                if (data && data.unitPrice != null && (force || String(el.value).trim() === '')) el.value = data.unitPrice;
            } catch (e) { /* leave blank on failure */ }
            updateIssueDeskCost();
        }

        function handleIssueFilterChange() {
            clearTimeout(issueSearchTimeout);
            issueSearchTimeout = setTimeout(() => {
                issueFilters.search = document.getElementById('issueSearchInput').value.trim();
                issueFilters.vehicle = document.getElementById('issueVehicleFilter').value;
                issueFilters.category = document.getElementById('issueCategoryFilter').value;
                issueFilters.startDate = document.getElementById('issueStartDate').value;
                issueFilters.endDate = document.getElementById('issueEndDate').value;
                loadIssues();
            }, 250);
        }

        async function deleteIssue(id) {
            if (!confirm('Delete this issued item record permanently?')) return;
            try {
                const res = await fetch('/api/issues/' + id, {
                    method: 'DELETE'
                });
                if (!res.ok) throw new Error('failed');
                await loadIssues();
                refreshIssueBadge();
            } catch (e) { alert('Failed to delete issue.'); }
        }

        function updateSidebarBadges() {
            let countAll = allItems.length;
            let countPendingDelivery = 0;
            let countPendingPricing = 0;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            displayAll.forEach(item => {
                const isPendingDelivery = item.reqQty > item.recQty;
                const hasReceipts = item.receipts && item.receipts.length > 0;
                const isPendingPricing = hasReceipts && item.receipts.some(r => !r.unitPrice || !r.invoiceNumber);

                if (isPendingDelivery) countPendingDelivery++;
                if (!isPendingDelivery && isPendingPricing) countPendingPricing++;
            });

            const allBadge = document.getElementById('count-all');
            const delBadge = document.getElementById('count-pending-delivery');
            const prBadge = document.getElementById('count-pending-pricing');
            const invBadge = document.getElementById('count-inventory');
            
            if (allBadge) allBadge.textContent = countAll;
            if (delBadge) delBadge.textContent = countPendingDelivery;
            if (prBadge) prBadge.textContent = countPendingPricing;

            // Calculate in-stock items (currentStock > 0)
            const invList = calculateInventoryList();
            const inStockBadgeCount = invList.filter(inv => inv.currentStock > 0).length;
            if (invBadge) invBadge.textContent = inStockBadgeCount;

            // Calculate store batteries count (In Store)
            const batBadge = document.getElementById('count-batteries');
            const storeBatteriesCount = batteries.filter(b => b.state === 'In Store').length;
            if (batBadge) batBadge.textContent = storeBatteriesCount;

            // Calculate transfers count
            const transBadge = document.getElementById('count-transfers');
            if (transBadge) transBadge.textContent = transfers.length;
        }

        // ---- Store Stock & Inventory calculations ----
        let inventorySearchQuery = '';
        let inventoryStatusFilter = 'all';
        let inventoryCategoryFilter = 'all';
        let inventorySortColumn = 'itemName';
        let inventorySortDirection = 'asc';

        function calculateInventoryList() {
            const inventoryMap: Record<string, any> = {};

            // 1. Process all request items & receipts
            const displayItems = cloneDeep(allItems);
            applyQueueMutations(displayItems);

            displayItems.forEach(item => {
                if (!item.itemName) return;
                const cleanName = item.itemName.trim().toLowerCase();
                if (!cleanName) return;

                if (!inventoryMap[cleanName]) {
                    inventoryMap[cleanName] = {
                        cleanName: cleanName,
                        itemName: item.itemName.trim(),
                        category: item.category || 'General Items',
                        totalReceived: 0,
                        totalIssued: 0,
                        receipts: [],
                        issues: []
                    };
                }

                const recs = item.receipts || [];
                recs.forEach(r => {
                    if (r.qty) {
                        inventoryMap[cleanName].totalReceived += r.qty;
                        inventoryMap[cleanName].receipts.push({
                            mrnNum: item.mrnNum,
                            vehicleMachinery: item.vehicleMachinery,
                            ...r
                        });
                    }
                });
            });

            // 2. Process all issues
            const displayIssues = cloneDeep(issues);
            displayIssues.forEach(is => {
                if (!is.itemName) return;
                const cleanName = is.itemName.trim().toLowerCase();
                if (!cleanName) return;

                if (!inventoryMap[cleanName]) {
                    inventoryMap[cleanName] = {
                        cleanName: cleanName,
                        itemName: is.itemName.trim(),
                        category: is.category || 'General Items',
                        totalReceived: 0,
                        totalIssued: 0,
                        receipts: [],
                        issues: []
                    };
                }

                if (is.qty) {
                    inventoryMap[cleanName].totalIssued += is.qty;
                    inventoryMap[cleanName].issues.push(is);
                }
            });

            // Calculate stock and assign status
            return Object.values(inventoryMap).map(inv => {
                inv.totalReceived = Math.round(inv.totalReceived * 100) / 100;
                inv.totalIssued = Math.round(inv.totalIssued * 100) / 100;
                inv.currentStock = Math.round((inv.totalReceived - inv.totalIssued) * 100) / 100;

                if (inv.currentStock < 0) {
                    inv.status = 'anomaly';
                } else if (inv.currentStock === 0) {
                    inv.status = 'outstock';
                } else if (inv.currentStock <= 2) {
                    inv.status = 'lowstock';
                } else {
                    inv.status = 'instock';
                }
                return inv;
            });
        }

        function renderInventoryView() {
            const list = calculateInventoryList();

            // Calculate KPIs
            let totalSKUs = list.length;
            let inStockCount = 0;
            let lowStockCount = 0;
            let outOfStockCount = 0;
            let discrepanciesCount = 0;

            list.forEach(inv => {
                if (inv.status === 'instock') inStockCount++;
                else if (inv.status === 'lowstock') lowStockCount++;
                else if (inv.status === 'outstock') outOfStockCount++;
                else if (inv.status === 'anomaly') discrepanciesCount++;
            });

            document.getElementById('invKpiTotalItems').textContent = totalSKUs;
            document.getElementById('invKpiInStock').textContent = inStockCount;
            document.getElementById('invKpiLowStock').textContent = lowStockCount;
            document.getElementById('invKpiOutOfStock').textContent = outOfStockCount;
            document.getElementById('invKpiDiscrepancies').textContent = discrepanciesCount;

            // Render Category Chips
            renderInventoryCategoryChips(list);

            // Filter
            const query = inventorySearchQuery.toLowerCase().trim();
            const filtered = list.filter(inv => {
                const matchesSearch = !query || inv.itemName.toLowerCase().includes(query) || inv.category.toLowerCase().includes(query);
                const matchesStatus = inventoryStatusFilter === 'all' || inv.status === inventoryStatusFilter;
                const matchesCategory = inventoryCategoryFilter === 'all' || inv.category === inventoryCategoryFilter;
                return matchesSearch && matchesStatus && matchesCategory;
            });

            // Sort
            filtered.sort((a, b) => {
                let valA = a[inventorySortColumn];
                let valB = b[inventorySortColumn];

                if (typeof valA === 'string') {
                    valA = valA.toLowerCase();
                    valB = valB.toLowerCase();
                    return inventorySortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
                } else {
                    return inventorySortDirection === 'asc' ? valA - valB : valB - valA;
                }
            });

            updateInventorySortIndicators();

            // Render
            const tbody = document.getElementById('inventoryTableBody');
            const emptyState = document.getElementById('inventoryEmptyState');
            const totalCountEl = document.getElementById('inventoryTotalCount');
            
            if (totalCountEl) totalCountEl.textContent = filtered.length;

            if (filtered.length === 0) {
                tbody.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }
            emptyState.classList.add('hidden');

            tbody.innerHTML = filtered.map(inv => {
                let badgeClass = '';
                let statusLabel = '';
                if (inv.status === 'anomaly') {
                    badgeClass = 'bg-purple-50 text-purple-700 border-purple-100 dark:bg-purple-950/40 dark:text-purple-400 dark:border-purple-900/30';
                    statusLabel = 'Discrepancy';
                } else if (inv.status === 'outstock') {
                    badgeClass = 'bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/40 dark:text-rose-455 dark:border-rose-900/30';
                    statusLabel = 'Out of Stock';
                } else if (inv.status === 'lowstock') {
                    badgeClass = 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900/30';
                    statusLabel = 'Low Stock';
                } else {
                    badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900/30';
                    statusLabel = 'In Stock';
                }

                const displayName = highlightMatch(inv.itemName, inventorySearchQuery);

                return `
                    <tr class="hover:bg-indigo-50/30 dark:hover:bg-slate-850/20 transition">
                        <td class="px-6 py-4 text-sm font-bold text-slate-800 dark:text-slate-200">
                            ${displayName}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-xs">
                            <span class="inline-flex font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-md border ${categoryBadgeClass(inv.category)}">
                                ${escapeHtml(inv.category)}
                            </span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold text-slate-700 dark:text-slate-350">
                            ${inv.totalReceived}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold text-slate-700 dark:text-slate-350">
                            ${inv.totalIssued}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-black text-slate-850 dark:text-white">
                            ${inv.currentStock}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-xs">
                            <span class="px-2.5 py-1 inline-flex leading-tight font-extrabold rounded-full border shadow-sm ${badgeClass}">
                                ${statusLabel}
                            </span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-right text-xs">
                            <button onclick="openInventoryOffcanvas('${inv.cleanName.replace(/'/g, "\\'")}')" class="p-2 bg-indigo-50/50 dark:bg-slate-800/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-650 hover:text-white dark:hover:text-white rounded-xl transition border border-indigo-100/40 dark:border-slate-700/60" title="View Item Ledger">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function renderInventoryCategoryChips(inventoryList) {
            const container = document.getElementById('inventoryCategoryChips');
            if (!container) return;

            const counts: Record<string, number> = {};
            inventoryList.forEach(inv => {
                counts[inv.category] = (counts[inv.category] || 0) + 1;
            });

            const total = Object.values(counts).reduce((a, b) => a + b, 0);

            const chip = (label, val, count) => {
                const active = inventoryCategoryFilter === val;
                const base = active
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700';
                const countCls = active ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-550';
                return `<button onclick="setInventoryCategoryFilter('${String(val).replace(/'/g, "\\'")}')" class="px-3.5 py-1.5 rounded-full text-xs font-bold border transition ${base}">${escapeHtml(label)}${count != null ? ` <span class="${countCls} font-extrabold">${count}</span>` : ''}</button>`;
            };

            let html = chip('All Categories', 'all', total);
            allCategories.forEach(cat => {
                if (counts[cat]) {
                    html += chip(cat, cat, counts[cat]);
                }
            });
            container.innerHTML = html;
        }

        function setInventoryCategoryFilter(cat) {
            inventoryCategoryFilter = cat;
            renderInventoryView();
        }

        function setInventoryStatusFilter(filter) {
            inventoryStatusFilter = filter;
            
            const btns = ['all', 'instock', 'lowstock', 'outstock', 'anomaly'];
            btns.forEach(b => {
                const el = document.getElementById('btn-invFilter-' + b);
                if (!el) return;
                if (b === filter) {
                    el.className = "px-3.5 py-2 rounded-xl text-xs font-black transition border shadow-sm bg-indigo-600 text-white border-indigo-600";
                } else {
                    let borderHoverClass = 'hover:border-indigo-300 dark:hover:border-indigo-900/50';
                    if (b === 'instock') borderHoverClass = 'hover:border-emerald-305 dark:hover:border-emerald-900/50';
                    if (b === 'lowstock') borderHoverClass = 'hover:border-amber-305 dark:hover:border-amber-900/50';
                    if (b === 'outstock') borderHoverClass = 'hover:border-rose-305 dark:hover:border-rose-900/50';
                    
                    el.className = `px-3.5 py-2 rounded-xl text-xs font-bold transition border border-slate-200 dark:border-slate-800 text-slate-655 dark:text-slate-300 ${borderHoverClass}`;
                }
            });

            renderInventoryView();
        }

        function toggleInventorySort(col) {
            if (inventorySortColumn === col) {
                inventorySortDirection = inventorySortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                inventorySortColumn = col;
                inventorySortDirection = 'asc';
            }
            renderInventoryView();
        }

        function updateInventorySortIndicators() {
            ['itemName', 'category', 'totalReceived', 'totalIssued', 'currentStock'].forEach(col => {
                const el = document.getElementById('sort-inv-' + col);
                if (el) {
                    if (inventorySortColumn === col) {
                        el.innerHTML = inventorySortDirection === 'asc' ? ' ▲' : ' ▼';
                        el.className = 'ml-1 text-[10px] text-indigo-650 dark:text-indigo-400 font-bold';
                    } else {
                        el.innerHTML = '';
                    }
                }
            });
        }

        let inventorySearchTimeout;
        function handleInventoryFilterChange() {
            clearTimeout(inventorySearchTimeout);
            inventorySearchTimeout = setTimeout(() => {
                inventorySearchQuery = document.getElementById('inventorySearchInput').value;
                renderInventoryView();
            }, 250);
        }

        function openInventoryOffcanvas(cleanName) {
            const offcanvas = document.getElementById('inventoryOffcanvas');
            if (!offcanvas) return;

            const list = calculateInventoryList();
            const inv = list.find(item => item.cleanName === cleanName);
            if (!inv) return;

            document.getElementById('inventoryOffcanvasName').textContent = inv.itemName;
            document.getElementById('inventoryOffcanvasCategory').textContent = inv.category;

            document.getElementById('inventoryOffcanvasTotalReceived').textContent = inv.totalReceived;
            document.getElementById('inventoryOffcanvasTotalIssued').textContent = inv.totalIssued;
            
            const currentStockEl = document.getElementById('inventoryOffcanvasCurrentStock');
            currentStockEl.textContent = inv.currentStock;

            let colorClass = 'text-slate-800 dark:text-white';
            let statusDotClass = 'w-3 h-3 rounded-full bg-slate-300';
            if (inv.status === 'anomaly') {
                colorClass = 'text-purple-600 dark:text-purple-400 font-black';
                statusDotClass = 'w-3 h-3 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.7)] animate-pulse';
            } else if (inv.status === 'outstock') {
                colorClass = 'text-rose-600 dark:text-rose-455 font-black';
                statusDotClass = 'w-3 h-3 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]';
            } else if (inv.status === 'lowstock') {
                colorClass = 'text-amber-500 dark:text-amber-400 font-black';
                statusDotClass = 'w-3 h-3 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.7)]';
            } else {
                colorClass = 'text-emerald-600 dark:text-emerald-400 font-black';
                statusDotClass = 'w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]';
            }
            currentStockEl.className = 'text-sm font-black mt-1 ' + colorClass;
            document.getElementById('inventoryOffcanvasStatusDot').className = statusDotClass;

            const inflowsContainer = document.getElementById('inventoryOffcanvasInflowsList');
            const sortedReceipts = inv.receipts.sort((a, b) => new Date(b.deliveryDate).getTime() - new Date(a.deliveryDate).getTime());
            if (sortedReceipts.length === 0) {
                inflowsContainer.innerHTML = `
                    <div class="text-center py-6 text-slate-400 dark:text-slate-600 text-xs italic bg-slate-50 dark:bg-slate-950/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                        No receipts logged for this item.
                    </div>
                `;
            } else {
                inflowsContainer.innerHTML = sortedReceipts.map(r => {
                    const typeText = r.transactionType === 'Return' ? 'Returned' : 'Received';
                    const grnPart = r.grnNumber ? `<span>GRN: <strong>${escapeHtml(r.grnNumber)}</strong></span>` : '';
                    const invPart = r.invoiceNumber ? `<span>INV: <strong>${escapeHtml(r.invoiceNumber)}</strong></span>` : '';
                    const pricePart = r.unitPrice ? `<div class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold mt-1">${formatCurrency(r.unitPrice)} &times; ${Math.abs(r.qty)} = ${formatCurrency(Math.abs(r.qty) * r.unitPrice)}</div>` : '';
                    const sourcePart = r.purchaseSource ? `<span class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 text-[8px] uppercase font-bold text-slate-550 rounded">${escapeHtml(r.purchaseSource)}</span>` : '';

                    return `
                        <div class="bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800/80 rounded-xl p-3 text-xs shadow-sm hover:shadow-glow transition duration-150 flex flex-col justify-between">
                            <div class="flex justify-between items-start gap-2 mb-1">
                                <div>
                                    <div class="font-extrabold text-slate-855 dark:text-slate-200 ${r.transactionType === 'Return' ? 'text-rose-600' : 'text-emerald-650'}">${typeText} ${Math.abs(r.qty)}</div>
                                    <div class="text-[10px] text-slate-450 dark:text-slate-500 font-medium">MRN: ${escapeHtml(r.mrnNum)} (${escapeHtml(r.vehicleMachinery)})</div>
                                </div>
                                <span class="text-[9px] font-black text-slate-400 dark:text-slate-500">${r.deliveryDate}</span>
                            </div>
                            <div class="flex flex-wrap gap-2 items-center text-[9px] text-slate-500 mt-2">
                                ${grnPart}
                                ${invPart}
                                ${sourcePart}
                            </div>
                            ${pricePart}
                        </div>
                    `;
                }).join('');
            }

            const outflowsContainer = document.getElementById('inventoryOffcanvasOutflowsList');
            const sortedIssues = inv.issues.sort((a, b) => new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime());
            if (sortedIssues.length === 0) {
                outflowsContainer.innerHTML = `
                    <div class="text-center py-6 text-slate-400 dark:text-slate-600 text-xs italic bg-slate-50 dark:bg-slate-950/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                        No issues logged for this item.
                    </div>
                `;
            } else {
                outflowsContainer.innerHTML = sortedIssues.map(is => {
                    const mrnPart = is.mrnNum ? `<span>MRN Ref: <strong>${escapeHtml(is.mrnNum)}</strong></span>` : '';
                    const recipientPart = is.issuedTo ? `<span>To: <strong>${escapeHtml(is.issuedTo)}</strong></span>` : '';

                    return `
                        <div class="bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800/80 rounded-xl p-3 text-xs shadow-sm hover:shadow-glow transition duration-150 flex flex-col justify-between">
                            <div class="flex justify-between items-start gap-2 mb-1">
                                <div>
                                    <div class="font-extrabold text-indigo-650 dark:text-indigo-400">Issued ${is.qty}</div>
                                    <div class="text-[10px] text-slate-455 dark:text-slate-500 font-medium">Machine: <strong class="text-slate-700 dark:text-slate-350">${escapeHtml(is.vehicleMachinery)}</strong></div>
                                </div>
                                <span class="text-[9px] font-black text-slate-400 dark:text-slate-505">${escapeHtml(is.issueDate)}</span>
                            </div>
                            <div class="flex flex-wrap gap-2 items-center text-[9px] text-slate-500 mt-2">
                                ${mrnPart}
                                ${recipientPart}
                            </div>
                        </div>
                    `;
                }).join('');
            }

            const receiveBtn = document.getElementById('inventoryOffcanvasReceiveBtn');
            const issueBtn = document.getElementById('inventoryOffcanvasIssueBtn');

            const displayItems = cloneDeep(allItems);
            applyQueueMutations(displayItems);
            const linkedItem = displayItems.find(item => item.itemName && item.itemName.trim().toLowerCase() === cleanName);
            
            if (linkedItem) {
                receiveBtn.onclick = () => {
                    closeInventoryOffcanvas();
                    window.location.hash = `#receiving/${linkedItem.id}`;
                };
                receiveBtn.disabled = false;
                receiveBtn.className = "w-full py-3 px-4 bg-emerald-650 hover:bg-emerald-700 text-white font-extrabold rounded-xl transition duration-150 text-xs shadow-sm hover:shadow-glow flex items-center justify-center gap-2";
            } else {
                receiveBtn.onclick = null;
                receiveBtn.disabled = true;
                receiveBtn.className = "w-full py-3 px-4 bg-slate-100 dark:bg-slate-850 text-slate-400 dark:text-slate-655 font-bold rounded-xl transition duration-150 text-xs flex items-center justify-center gap-2 cursor-not-allowed border border-transparent";
            }

            issueBtn.onclick = () => {
                closeInventoryOffcanvas();
                if (linkedItem) {
                    window.location.hash = `#issue-desk/request/${linkedItem.id}`;
                } else {
                    window.location.hash = `#issue-desk`;
                    setTimeout(() => {
                        const nameInput = document.getElementById('issueDeskItemName');
                        if (nameInput) {
                            nameInput.value = inv.itemName;
                            document.getElementById('issueDeskCategory').value = inv.category;
                        }
                    }, 50);
                }
            };

            offcanvas.classList.remove('translate-x-full');
        }

        function closeInventoryOffcanvas() {
            const offcanvas = document.getElementById('inventoryOffcanvas');
            if (offcanvas) offcanvas.classList.add('translate-x-full');
        }

        // Render paginated tracker view
        function renderTable() {
            tableBody.innerHTML = '';
            updateHeaderSortIndicators();

            const displayItems = cloneDeep(items);
            applyQueueMutations(displayItems);

            // Re-sort the current page items locally if necessary
            displayItems.sort((a, b) => {
                let valA, valB;
                if (sortColumn === 'reqDate' || sortColumn === 'recDate') {
                    valA = parseDate(a[sortColumn]);
                    valB = parseDate(b[sortColumn]);
                } else if (sortColumn === 'mrnNum' || sortColumn === 'itemName' || sortColumn === 'vehicleMachinery') {
                    valA = String(a[sortColumn] || '').toLowerCase();
                    valB = String(b[sortColumn] || '').toLowerCase();
                } else if (sortColumn === 'reqQty' || sortColumn === 'recQty') {
                    valA = parseFloat(a[sortColumn]) || 0;
                    valB = parseFloat(b[sortColumn]) || 0;
                } else if (sortColumn === 'pricing') {
                    const pricingA = getItemPricingInfo(a);
                    const pricingB = getItemPricingInfo(b);
                    valA = pricingA.totalCost;
                    valB = pricingB.totalCost;
                } else if (sortColumn === 'gap') {
                    valA = Math.round((a.reqQty - a.recQty) * 100) / 100;
                    valB = Math.round((b.reqQty - b.recQty) * 100) / 100;
                }

                if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
                if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
                return 0;
            });

            if (displayItems.length === 0) {
                emptyState.classList.remove('hidden');
                emptyState.innerText = allItems.length === 0 ? "No items tracked yet. Add a request to get started." : "No items match your search filter.";
            } else {
                emptyState.classList.add('hidden');
            }

            displayItems.forEach((item) => {
                const qtyGap = Math.round((item.reqQty - item.recQty) * 100) / 100;
                const dateGap = calculateDateGap(item.reqDate, item.recDate);
                const status = getStatusBadge(item.reqQty, item.recQty, item.reqDate);
                const pricing = getItemPricingInfo(item);

                let qtyGapHtml = `<span class="text-slate-400 dark:text-slate-600">-</span>`;
                if (item.recQty > 0) {
                    if (qtyGap > 0) {
                        qtyGapHtml = `<span class="text-rose-600 dark:text-rose-400 font-bold">${qtyGap} short</span>`;
                    } else if (qtyGap < 0) {
                        qtyGapHtml = `<span class="text-violet-600 dark:text-violet-400 font-bold">${Math.abs(qtyGap)} extra</span>`;
                    } else {
                        qtyGapHtml = `<span class="text-emerald-600 dark:text-emerald-450 font-bold">Match</span>`;
                    }
                }

                const percent = item.reqQty > 0 ? Math.round((item.recQty / item.reqQty) * 100) : 0;
                let barColor = 'bg-indigo-500';
                let textColor = 'text-indigo-650 dark:text-indigo-400';
                if (percent === 100) {
                    barColor = 'bg-emerald-500';
                    textColor = 'text-emerald-600 dark:text-emerald-450';
                } else if (percent > 100) {
                    barColor = 'bg-violet-500';
                    textColor = 'text-violet-600 dark:text-violet-400';
                } else if (percent > 0) {
                    barColor = 'bg-blue-500';
                    textColor = 'text-blue-600 dark:text-blue-450';
                } else {
                    barColor = 'bg-slate-200 dark:bg-slate-800';
                    textColor = 'text-slate-400 dark:text-slate-600';
                }

                let pricingHtml = '';
                if (pricing.hasPricing) {
                    pricingHtml = `
                        <div class="text-sm font-extrabold text-slate-855 dark:text-slate-200">${formatCurrency(pricing.totalCost)}</div>
                        ${pricing.suppliers.length > 0 ? `<div class="text-xs font-semibold text-slate-500 truncate max-w-[140px]" title="${pricing.suppliers.join(', ')}">${highlightMatch(pricing.suppliers.join(', '), searchQuery)}</div>` : ''}
                        ${pricing.grns.length > 0 ? `<div class="text-[9px] text-indigo-600 dark:text-indigo-400 uppercase tracking-widest mt-0.5 font-extrabold truncate max-w-[140px]" title="GRN: ${pricing.grns.join(', ')}">GRN: ${highlightMatch(pricing.grns.join(', '), searchQuery)}</div>` : ''}
                    `;
                } else {
                    pricingHtml = `<span class="text-slate-400 dark:text-slate-600 text-xs italic">No pricing</span>`;
                }

                const row = `
                    <tr class="hover:bg-indigo-50/30 dark:hover:bg-slate-850/20 transition-all duration-150 border-b border-slate-100 dark:border-slate-800/80">
                        <td class="px-6 py-4 whitespace-nowrap">
                            <div class="text-sm font-extrabold text-slate-900 dark:text-white">${highlightMatch(item.mrnNum, searchQuery)}</div>
                            <div class="text-xs text-slate-500 dark:text-slate-455 font-semibold mt-0.5">${highlightMatch(item.vehicleMachinery, searchQuery)}</div>
                            ${item.requestSource ? `<div class="mt-1.5"><span class="inline-flex items-center text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-md border ${item.requestSource === 'Head Office' ? 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900/30' : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900/30'}">${escapeHtml(item.requestSource)}</span></div>` : ''}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            <div class="text-sm font-bold text-slate-800 dark:text-slate-250">${highlightMatch(item.name, searchQuery)}</div>
                            <div class="text-xs text-slate-400 dark:text-slate-500 font-medium truncate max-w-[155px] mt-0.5" title="${escapeHtml(item.itemDesc || '')}">${highlightMatch(item.itemDesc, searchQuery)}</div>
                            ${item.category ? `<div class="mt-1.5"><span class="inline-flex items-center text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-md border ${categoryBadgeClass(item.category)}">${escapeHtml(item.category)}</span></div>` : ''}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            <div class="text-sm font-extrabold text-slate-900 dark:text-white">${item.reqQty}</div>
                            <div class="text-xs text-slate-400 dark:text-slate-550 font-semibold mt-0.5">${escapeHtml(item.reqDate)}</div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            <div class="text-sm font-extrabold text-slate-800 dark:text-slate-200">${item.recQty > 0 ? item.recQty : '0'} <span class="text-xs text-slate-450 dark:text-slate-600 font-normal">of ${item.reqQty}</span></div>
                            <div class="flex items-center space-x-2 mt-2 max-w-[130px]">
                                <div class="flex-1 bg-slate-250/60 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                    <div class="h-full rounded-full ${barColor} transition-all duration-300" style="width: ${Math.min(percent, 100)}%"></div>
                                </div>
                                <span class="text-[9px] font-black ${textColor}">${percent}%</span>
                            </div>
                            <div class="text-[10px] text-slate-450 dark:text-slate-550 font-semibold mt-1.5">${escapeHtml(item.recDate || 'Not received')} ${item.receipts && item.receipts.length > 1 ? `(${item.receipts.length} deliveries)` : ''}</div>
                            ${item.purchaseSource ? `<div class="text-[9px] uppercase tracking-widest mt-1.5 font-extrabold text-indigo-700 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100/50 dark:border-indigo-900/30 px-2 py-0.5 rounded-md w-fit">${escapeHtml(item.purchaseSource)}</div>` : ''}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold">
                            <div class="mb-0.5">${qtyGapHtml}</div>
                            <div class="text-xs text-slate-450 dark:text-slate-550 font-medium">${dateGap}</div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            ${pricingHtml}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            ${status}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-semibold">
                            <div class="flex items-center justify-end gap-1.5">
                                <a href="#receiving/${item.id}" class="p-2 bg-indigo-50/50 dark:bg-slate-800/40 text-indigo-600 dark:text-indigo-400 hover:text-white dark:hover:text-white hover:bg-indigo-650 dark:hover:bg-indigo-650 rounded-xl transition duration-150 border border-indigo-100/40 dark:border-slate-700/60" title="Log Delivery">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                </a>
                                ${item.recQty > 0 ? `
                                <a href="#issue-desk/request/${item.id}" class="p-2 bg-indigo-50/50 dark:bg-slate-800/40 text-indigo-600 dark:text-indigo-400 hover:text-white dark:hover:text-white hover:bg-indigo-650 dark:hover:bg-indigo-650 rounded-xl transition duration-150 border border-indigo-100/40 dark:border-slate-700/60" title="Issue Item">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path></svg>
                                </a>
                                ` : `
                                <button disabled class="p-2 bg-slate-100/50 dark:bg-slate-800/20 text-slate-350 dark:text-slate-600 rounded-xl border border-slate-200/40 dark:border-slate-700/30 cursor-not-allowed" title="Cannot issue before delivery receipt">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path></svg>
                                </button>
                                `}
                                <button onclick="openPricingOffcanvas('${item.id}')" class="p-2 bg-emerald-50/50 dark:bg-slate-800/40 text-emerald-600 dark:text-emerald-400 hover:text-white dark:hover:text-white hover:bg-emerald-650 dark:hover:bg-emerald-650 rounded-xl transition duration-150 border border-emerald-100/40 dark:border-slate-700/60" title="Update Pricing & Supplier">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                </button>
                                <button onclick="openEditRequestModal('${item.id}')" class="p-2 bg-blue-50/50 dark:bg-slate-800/40 text-blue-600 dark:text-blue-400 hover:text-white dark:hover:text-white hover:bg-blue-650 dark:hover:bg-blue-650 rounded-xl transition duration-150 border border-blue-100/40 dark:border-slate-700/60" title="Edit Request Details">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                                </button>
                                <button onclick="deleteItem('${item.id}')" class="p-2 bg-rose-50/50 dark:bg-slate-800/40 text-rose-600 dark:text-rose-455 hover:text-white dark:hover:text-white hover:bg-rose-650 dark:hover:bg-rose-650 rounded-xl transition duration-150 border border-rose-100/40 dark:border-slate-700/60" title="Delete Request">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
                tableBody.insertAdjacentHTML('beforeend', row);
            });

            // Update Pagination Control States
            const pagStart = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
            const pagEnd = Math.min(currentPage * pageSize, totalItems);
            
            document.getElementById('pag-start').textContent = pagStart;
            document.getElementById('pag-end').textContent = pagEnd;
            document.getElementById('pag-total').textContent = totalItems;

            renderPaginationButtons();
            renderOpenMrns();
        }

        // Render interactive pagination controls
        function renderPaginationButtons() {
            const container = document.getElementById('paginationControls');
            if (!container) return;
            container.innerHTML = '';

            if (totalPages <= 1) return;

            // Previous Button
            const prevBtn = document.createElement('button');
            prevBtn.className = `px-3 py-1.5 rounded-lg border text-xs font-bold transition ${currentPage === 1 ? 'text-slate-300 dark:text-slate-700 border-slate-200 dark:border-slate-850 cursor-not-allowed' : 'text-slate-600 dark:text-slate-350 border-slate-200 dark:border-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-800 hover:text-indigo-650'}`;
            prevBtn.textContent = 'Prev';
            prevBtn.disabled = currentPage === 1;
            prevBtn.onclick = () => goToPage(currentPage - 1);
            container.appendChild(prevBtn);

            // Page numbers
            const maxVisible = 5;
            let start = Math.max(1, currentPage - 2);
            let end = Math.min(totalPages, start + maxVisible - 1);
            if (end - start + 1 < maxVisible) {
                start = Math.max(1, end - maxVisible + 1);
            }

            if (start > 1) {
                container.appendChild(createPageButton(1));
                if (start > 2) {
                    const dots = document.createElement('span');
                    dots.className = "text-slate-400 dark:text-slate-600 text-xs px-1 font-bold";
                    dots.textContent = '...';
                    container.appendChild(dots);
                }
            }

            for (let i = start; i <= end; i++) {
                container.appendChild(createPageButton(i));
            }

            if (end < totalPages) {
                if (end < totalPages - 1) {
                    const dots = document.createElement('span');
                    dots.className = "text-slate-400 dark:text-slate-600 text-xs px-1 font-bold";
                    dots.textContent = '...';
                    container.appendChild(dots);
                }
                container.appendChild(createPageButton(totalPages));
            }

            // Next Button
            const nextBtn = document.createElement('button');
            nextBtn.className = `px-3 py-1.5 rounded-lg border text-xs font-bold transition ${currentPage === totalPages ? 'text-slate-300 dark:text-slate-700 border-slate-200 dark:border-slate-850 cursor-not-allowed' : 'text-slate-600 dark:text-slate-350 border-slate-200 dark:border-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-800 hover:text-indigo-650'}`;
            nextBtn.textContent = 'Next';
            nextBtn.disabled = currentPage === totalPages;
            nextBtn.onclick = () => goToPage(currentPage + 1);
            container.appendChild(nextBtn);
        }

        function createPageButton(pageIndex) {
            const btn = document.createElement('button');
            const isActive = pageIndex === currentPage;
            btn.className = `w-8 h-8 rounded-lg text-xs font-black transition ${isActive ? 'bg-indigo-600 text-white border border-indigo-600 shadow-sm' : 'text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-800 hover:text-indigo-650 dark:hover:text-indigo-400'}`;
            btn.textContent = pageIndex;
            btn.onclick = () => goToPage(pageIndex);
            return btn;
        }

        function goToPage(pageIndex) {
            if (pageIndex < 1 || pageIndex > totalPages) return;
            currentPage = pageIndex;
            fetchTrackerPage();
        }

        function changePageSize(size) {
            pageSize = parseInt(size) || 50;
            currentPage = 1;
            fetchTrackerPage();
        }

        // Sidebar active MRN selection filter
        function filterByOpenMrn(mrnNum) {
            searchInput.value = mrnNum;
            searchQuery = mrnNum;
            currentPage = 1;
            fetchTrackerPage();
        }

        function clearMrnFilter() {
            searchInput.value = '';
            searchQuery = '';
            currentPage = 1;
            fetchTrackerPage();
        }

        // Render Open MRNs in Sidebar
        function renderOpenMrns() {
            const openMrns: Record<string, any> = {};
            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            displayAll.forEach(item => {
                if (item.reqQty > item.recQty) {
                    if (item.mrnNum) {
                        if (!openMrns[item.mrnNum]) {
                            openMrns[item.mrnNum] = { count: 0, vehicle: item.vehicleMachinery || '' };
                        }
                        openMrns[item.mrnNum].count++;
                    }
                }
            });

            const mrnKeys = Object.keys(openMrns).sort();
            if (mrnKeys.length === 0) {
                activeMrnContainer.classList.add('hidden');
                activeMrnList.innerHTML = '';
                return;
            }

            activeMrnContainer.classList.remove('hidden');
            const isAnyMrnSelected = Object.keys(openMrns).some(mrn => searchQuery.toLowerCase() === mrn.toLowerCase());
            const clearBtn = document.getElementById('clearMrnBtn');
            if (clearBtn) {
                if (isAnyMrnSelected) clearBtn.classList.remove('hidden');
                else clearBtn.classList.add('hidden');
            }

            activeMrnList.innerHTML = mrnKeys.map(mrn => {
                const data = openMrns[mrn];
                const isSelected = searchQuery.toLowerCase() === mrn.toLowerCase();
                return `
                    <button onclick="filterByOpenMrn(this.dataset.mrn)" data-mrn="${escapeHtml(mrn)}"
                        class="w-full flex items-center justify-between p-3 rounded-xl border transition shadow-sm ${isSelected ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-900/50 ring-1 ring-indigo-300' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-900 hover:shadow-glow'} text-left outline-none">
                        <div class="overflow-hidden pr-2">
                            <div class="text-sm font-extrabold text-slate-800 dark:text-white truncate">${escapeHtml(mrn)}</div>
                            <div class="text-[10px] font-bold text-slate-500 dark:text-slate-450 truncate mt-0.5">${escapeHtml(data.vehicle || '-')}</div>
                        </div>
                        <span class="shrink-0 inline-flex items-center justify-center px-2 py-0.5 bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 text-[10px] font-black rounded-full border border-amber-200/40">
                            ${data.count}
                        </span>
                    </button>
                `;
            }).join('');
        }

        // Render Supplier Spend Breakdown
        function renderPricingSummary() {
            let totalSpend = 0;
            const supplierSpend: Record<string, any> = {};
            let pricedCount = 0;
            let unpricedReceivedCount = 0;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            displayAll.forEach(item => {
                const receipts = item.receipts || [];
                let itemHasPricing = false;

                receipts.forEach(r => {
                    if (r.unitPrice && r.qty > 0) {
                        const cost = Math.abs(r.qty) * r.unitPrice;
                        totalSpend += cost;
                        itemHasPricing = true;
                        const supplier = r.supplierName || 'Unknown Supplier';
                        supplierSpend[supplier] = (supplierSpend[supplier] || 0) + cost;
                    }
                });

                if (item.recQty > 0) {
                    if (itemHasPricing) pricedCount++;
                    else unpricedReceivedCount++;
                }
            });

            // Populate dashboard metrics values
            const totalSpendValEl = document.getElementById('totalSpendValue');
            const supplierCountValEl = document.getElementById('supplierCountValue');
            const pricedItemsValEl = document.getElementById('pricedItemsValue');
            const unpricedItemsValEl = document.getElementById('unpricedItemsValue');

            if (totalSpendValEl) totalSpendValEl.textContent = formatCurrency(Math.round(totalSpend * 100) / 100);
            if (supplierCountValEl) supplierCountValEl.textContent = Object.keys(supplierSpend).length;
            if (pricedItemsValEl) pricedItemsValEl.textContent = pricedCount;
            if (unpricedItemsValEl) unpricedItemsValEl.textContent = unpricedReceivedCount;

            const breakdownEl = document.getElementById('supplierBreakdown');
            if (breakdownEl) {
                if (Object.keys(supplierSpend).length > 0) {
                    const sorted = Object.entries(supplierSpend).sort((a, b) => b[1] - a[1]);
                    breakdownEl.innerHTML = `
                        <h4 class="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4">Spend share by supplier</h4>
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            ${sorted.map(([name, amount]) => {
                                const pct = totalSpend > 0 ? ((amount / totalSpend) * 100).toFixed(1) : 0;
                                return `
                                <div class="bg-slate-50 dark:bg-slate-950/40 rounded-2xl p-4 border border-slate-150 dark:border-slate-800 shadow-sm flex flex-col justify-between">
                                    <div class="flex justify-between items-start gap-2 mb-2">
                                        <span class="text-sm font-bold text-slate-800 dark:text-slate-200 truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                                        <span class="text-sm font-extrabold text-slate-900 dark:text-white whitespace-nowrap">${formatCurrency(Math.round(amount * 100) / 100)}</span>
                                    </div>
                                    <div>
                                        <div class="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                            <div class="bg-indigo-600 dark:bg-indigo-400 h-full rounded-full transition-all" style="width: ${pct}%"></div>
                                        </div>
                                        <div class="text-[10px] font-bold text-slate-450 dark:text-slate-550 mt-1.5 text-right">${pct}% share</div>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>
                    `;
                } else {
                    breakdownEl.innerHTML = '<p class="text-xs text-slate-400 mt-2 italic">No pricing data recorded yet.</p>';
                }
            }
        }

        // Charts update routine
        let spendTrendChart = null;
        let supplierShareChart = null;

        function initCharts() {
            const canvasTrend = document.getElementById('spendTrendChart');
            const canvasShare = document.getElementById('supplierShareChart');
            if (!canvasTrend || !canvasShare) return;

            const ctxTrend = canvasTrend.getContext('2d');
            const ctxShare = canvasShare.getContext('2d');
            
            Chart.defaults.font.family = 'Plus Jakarta Sans';
            
            spendTrendChart = new Chart(ctxTrend, {
                type: 'line',
                data: { labels: [], datasets: [] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10, weight: 600 } } },
                        y: { grid: { color: 'rgba(148, 163, 184, 0.1)' }, ticks: { color: '#94a3b8', font: { size: 10, weight: 600 } } }
                    }
                }
            });

            supplierShareChart = new Chart(ctxShare, {
                type: 'doughnut',
                data: { labels: [], datasets: [] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'right', labels: { color: '#94a3b8', boxWidth: 12, padding: 12, font: { size: 11, weight: 500 } } }
                    },
                    cutout: '65%'
                }
            });
        }

        function updateCharts() {
            if (!spendTrendChart || !supplierShareChart) return;
            const isDark = document.documentElement.classList.contains('dark');

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Spend trend calculations
            const spendByDate: Record<string, number> = {};
            displayAll.forEach(item => {
                (item.receipts || []).forEach(r => {
                    if (r.unitPrice && r.qty > 0 && r.deliveryDate) {
                        const cost = Math.abs(r.qty) * r.unitPrice;
                        const dStr = r.deliveryDate;
                        spendByDate[dStr] = (spendByDate[dStr] || 0) + cost;
                    }
                });
            });

            const sortedDates = Object.keys(spendByDate).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
            let runningTotal = 0;
            const trendLabels = [];
            const trendValues = [];

            sortedDates.forEach(date => {
                runningTotal += spendByDate[date];
                trendLabels.push(date);
                trendValues.push(Math.round(runningTotal));
            });

            spendTrendChart.data.labels = trendLabels;
            spendTrendChart.data.datasets = [{
                data: trendValues,
                borderColor: '#6366f1',
                backgroundColor: isDark ? 'rgba(99, 102, 241, 0.05)' : 'rgba(99, 102, 241, 0.08)',
                fill: true,
                tension: 0.35,
                borderWidth: 2.5,
                pointRadius: trendValues.length > 25 ? 0 : 3,
                pointBackgroundColor: '#6366f1'
            }];
            
            spendTrendChart.options.scales.x.ticks.color = isDark ? '#64748b' : '#94a3b8';
            spendTrendChart.options.scales.y.ticks.color = isDark ? '#64748b' : '#94a3b8';
            spendTrendChart.options.scales.y.grid.color = isDark ? 'rgba(51, 65, 85, 0.4)' : 'rgba(226, 232, 240, 0.5)';
            spendTrendChart.update();

            // Supplier spend distribution calculations
            const supplierSpend: Record<string, any> = {};
            displayAll.forEach(item => {
                (item.receipts || []).forEach(r => {
                    if (r.unitPrice && r.qty > 0) {
                        const cost = Math.abs(r.qty) * r.unitPrice;
                        const sup = r.supplierName || 'Unknown';
                        supplierSpend[sup] = (supplierSpend[sup] || 0) + cost;
                    }
                });
            });

            const sortedSuppliers = Object.entries(supplierSpend).sort((a, b) => b[1] - a[1]);
            const shareLabels = sortedSuppliers.map(([name]) => name);
            const shareValues = sortedSuppliers.map(([, amount]) => Math.round(amount));
            const colors = ['#6366f1', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#14b8a6', '#f43f5e', '#a855f7'];

            supplierShareChart.data.labels = shareLabels;
            supplierShareChart.data.datasets = [{
                data: shareValues,
                backgroundColor: colors.slice(0, shareLabels.length),
                borderWidth: isDark ? 2 : 0,
                borderColor: isDark ? '#0f172a' : '#ffffff'
            }];
            supplierShareChart.options.plugins.legend.labels.color = isDark ? '#94a3b8' : '#64748b';
            supplierShareChart.update();
        }

        function renderDashboardTransfers() {
            const container = document.getElementById('dashboardTransferFeedContainer');
            if (!container) return;

            if (transfers.length === 0) {
                container.innerHTML = `
                    <div class="p-6 text-center text-xs font-semibold text-slate-400 dark:text-slate-655 italic">
                        No material transfers logged yet.
                    </div>
                `;
                return;
            }

            const latestTransfers = transfers.slice(0, 5);

            container.innerHTML = latestTransfers.map(t => {
                const catBadge = `<span class="text-[10px] bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 border border-indigo-100/30 rounded-full font-bold px-2 py-0.5">${t.category || 'General'}</span>`;

                return `
                    <div class="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition cursor-pointer" onclick="openTransferOffcanvas(${t.id})">
                        <div class="flex flex-col gap-2">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-655 dark:text-slate-350 text-[10px] font-extrabold rounded-md font-mono">${escapeHtml(t.mtnNum)}</span>
                                <span class="text-[10px] text-slate-400 dark:text-slate-500 font-extrabold">${escapeHtml(t.transferDate || '')}</span>
                                ${catBadge}
                            </div>
                            <div class="text-sm font-extrabold text-slate-800 dark:text-slate-200">
                                ${escapeHtml(t.itemName)} <span class="text-slate-400 dark:text-slate-550 font-normal">x ${t.qty || 0}</span>
                            </div>
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <span class="text-xs font-extrabold text-indigo-650 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 rounded-md border border-indigo-150/40 dark:border-indigo-900/30">${escapeHtml(t.fromLocation)}</span>
                                <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                                <span class="text-xs font-extrabold text-emerald-655 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-md border border-emerald-150/40 dark:border-emerald-900/30">${escapeHtml(t.toLocation)}</span>
                            </div>
                        </div>
                        <div>
                            <button type="button" class="p-2 bg-indigo-50/50 dark:bg-slate-800/40 text-indigo-600 dark:text-indigo-400 hover:text-white hover:bg-indigo-650 dark:hover:bg-indigo-650 rounded-xl transition duration-150 border border-indigo-100/40 dark:border-slate-700/60 flex items-center justify-center" title="View Details">
                                <svg class="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"></path></svg>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Render Command Dashboard View
        function renderDashboard() {
            renderPricingSummary();
            updateCharts();
            renderDailyReceivedLedger();
            renderDashboardTransfers();

            // Render Overdue & Urgent Requisitions
            const urgentBody = document.getElementById('urgentDashboardBody');
            if (!urgentBody) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const today = new Date();
            today.setHours(0,0,0,0);

            const overdue = displayAll.filter(item => {
                const isPendingDelivery = item.reqQty > item.recQty;
                if (!isPendingDelivery) return false;
                const reqDate = parseDate(item.reqDate);
                return reqDate < today;
            });

            if (overdue.length === 0) {
                urgentBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="py-6 text-center text-xs font-semibold text-slate-400 dark:text-slate-655 italic">
                            No urgent requisitions currently overdue. Fleet supply lines are secure.
                        </td>
                    </tr>
                `;
                return;
            }

            urgentBody.innerHTML = overdue.map(item => `
                <tr class="hover:bg-rose-50/10 dark:hover:bg-rose-950/5 transition">
                    <td class="py-4 font-bold text-slate-800 dark:text-slate-200">
                        <div class="text-sm font-extrabold">${escapeHtml(item.mrnNum)}</div>
                        <div class="text-xs text-rose-500 font-semibold mt-0.5">${escapeHtml(item.vehicleMachinery)}</div>
                    </td>
                    <td class="py-4">
                        <div class="text-sm font-semibold">${escapeHtml(item.name)}</div>
                        <div class="text-[11px] text-slate-450 dark:text-slate-500 mt-0.5">${escapeHtml(item.itemDesc || '-')}</div>
                    </td>
                    <td class="py-4 text-xs font-semibold text-rose-600 dark:text-rose-400">
                        ${item.reqDate}
                    </td>
                    <td class="py-4 text-xs font-semibold">
                        <div class="text-slate-700 dark:text-slate-300 font-bold">${item.recQty || 0} <span class="text-slate-450 font-normal">of ${item.reqQty}</span></div>
                    </td>
                    <td class="py-4 text-right">
                        <a href="#receiving/${item.id}" class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-600 hover:text-white dark:bg-rose-950/20 text-rose-600 dark:text-rose-400 text-xs font-black rounded-lg border border-rose-100 dark:border-rose-900/30 transition shadow-inner">
                            Log Delivery
                        </a>
                    </td>
                </tr>
            `).join('');
        }

        // Render Fleet board view
        function renderFleetView() {
            const container = document.getElementById('fleetGridContainer');
            if (!container) return;

            const searchVal = document.getElementById('fleetSearchInput')?.value.toLowerCase().trim() || '';

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Group all items (requisitions) by vehicle
            const vehicles: Record<string, any> = {};
            
            // Collect all unique vehicles from allItems and issues
            const allVehicleNames = new Set<string>();
            displayAll.forEach(item => {
                if (item.vehicleMachinery) allVehicleNames.add(item.vehicleMachinery.trim());
            });
            issues.forEach(is => {
                if (is.vehicleMachinery) allVehicleNames.add(is.vehicleMachinery.trim());
            });

            allVehicleNames.forEach(vName => {
                const vehicleItems = displayAll.filter(item => item.vehicleMachinery && item.vehicleMachinery.trim() === vName);
                const vehicleIssues = issues.filter(is => is.vehicleMachinery && is.vehicleMachinery.trim() === vName);

                // Shared matching rule (itemId link -> MRN + name -> vehicle + name)
                const getIssuedQty = (item) => issuedQtyForItem(item);

                let pendingSupplierCount = 0;
                let pendingWorkshopCount = 0;
                let totalReqQty = 0;
                let totalIssuedQty = 0;
                let hasOverdue = false;
                const today = new Date();
                today.setHours(0,0,0,0);

                vehicleItems.forEach(item => {
                    totalReqQty += item.reqQty;
                    const issuedQty = getIssuedQty(item);
                    totalIssuedQty += Math.min(item.reqQty, issuedQty); // cap at reqQty for progress bar

                    const isPendingSupplier = item.reqQty > item.recQty;
                    const isPendingWorkshop = item.recQty > issuedQty;

                    if (isPendingSupplier) {
                        pendingSupplierCount++;
                        const isOverdue = parseDate(item.reqDate) < today;
                        if (isOverdue) hasOverdue = true;
                    }
                    if (isPendingWorkshop) {
                        pendingWorkshopCount++;
                    }
                });

                // Calculate progress %
                const progressPct = totalReqQty > 0 ? Math.round((totalIssuedQty / totalReqQty) * 100) : 0;

                // Only include if there is any pending activity, OR if we searched and there's a match
                const hasPending = pendingSupplierCount > 0 || pendingWorkshopCount > 0;
                const isSearchMatch = vName.toLowerCase().includes(searchVal);

                if ((searchVal && isSearchMatch) || (!searchVal && hasPending)) {
                    vehicles[vName] = {
                        name: vName,
                        pendingSupplierCount,
                        pendingWorkshopCount,
                        progressPct,
                        hasOverdue,
                        totalItems: vehicleItems.length,
                        items: vehicleItems
                    };
                }
            });

            const keys = Object.keys(vehicles).sort();
            if (keys.length === 0) {
                container.innerHTML = `
                    <div class="col-span-full py-16 text-center text-slate-400 dark:text-slate-500 italic bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-sm">
                        ${searchVal ? 'No matching machinery found.' : 'No active requisitions or workshop store stocks recorded.'}
                    </div>
                `;
                return;
            }

            container.innerHTML = keys.map(vehicleName => {
                const v = vehicles[vehicleName];
                
                // Color configuration depending on vehicle supply status
                let borderClass = 'border-slate-100 dark:border-slate-850 hover:border-indigo-350 dark:hover:border-indigo-800';
                let indicatorClass = 'bg-emerald-500';
                let statusText = 'Operational';
                let statusColor = 'text-emerald-600 dark:text-emerald-400';

                if (v.hasOverdue) {
                    borderClass = 'border-rose-200 dark:border-rose-900/50 shadow-inner hover:border-rose-450';
                    indicatorClass = 'bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]';
                    statusText = 'Downtime Risk';
                    statusColor = 'text-rose-600 dark:text-rose-400 font-extrabold';
                } else if (v.pendingSupplierCount > 0) {
                    indicatorClass = 'bg-amber-500';
                    statusText = 'In Procurement';
                    statusColor = 'text-amber-600 dark:text-amber-400 font-extrabold';
                } else if (v.pendingWorkshopCount > 0) {
                    borderClass = 'border-blue-200 dark:border-blue-900/40 hover:border-blue-450';
                    indicatorClass = 'bg-blue-500';
                    statusText = 'Workshop Stock';
                    statusColor = 'text-blue-600 dark:text-blue-400 font-extrabold';
                }

                return `
                    <div onclick="openVehicleOffcanvas('${escapeHtml(v.name).replace(/'/g, "\\'")}')" 
                        class="bg-white dark:bg-slate-900 rounded-2xl border ${borderClass} shadow-glass-light dark:shadow-glass-dark p-6 hover:shadow-glow hover:-translate-y-1 transition duration-200 cursor-pointer flex flex-col justify-between group">
                        <div>
                            <div class="flex justify-between items-start mb-4">
                                <h3 class="text-base font-extrabold text-slate-850 dark:text-white group-hover:text-indigo-600 transition truncate max-w-[170px]" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</h3>
                                <div class="flex items-center gap-2">
                                    <span class="w-2.5 h-2.5 rounded-full ${indicatorClass}"></span>
                                    <span class="text-[10px] uppercase tracking-wider font-extrabold ${statusColor}">${statusText}</span>
                                </div>
                            </div>
                            
                            <!-- Sleek visual pipeline metrics -->
                            <div class="space-y-3 mt-4">
                                <div class="flex justify-between text-xs font-bold">
                                    <span class="text-slate-455">Supplier Deliveries:</span>
                                    <span class="${v.pendingSupplierCount > 0 ? 'text-amber-500 font-extrabold' : 'text-slate-450 dark:text-slate-550'}">${v.pendingSupplierCount} pending</span>
                                </div>
                                <div class="flex justify-between text-xs font-bold">
                                    <span class="text-slate-455">Workshop Store Stock:</span>
                                    <span class="${v.pendingWorkshopCount > 0 ? 'text-indigo-500 font-extrabold' : 'text-slate-450 dark:text-slate-550'}">${v.pendingWorkshopCount} on shelf</span>
                                </div>
                                
                                <div class="mt-4 pt-2">
                                    <div class="flex justify-between items-center text-[10px] font-black text-slate-450 uppercase mb-1.5">
                                        <span>Fulfillment Rate</span>
                                        <span class="text-indigo-650 dark:text-indigo-400">${v.progressPct}%</span>
                                    </div>
                                    <div class="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                        <div class="h-full bg-indigo-500 rounded-full transition-all duration-300" style="width: ${v.progressPct}%"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="mt-5 pt-3 border-t border-slate-100 dark:border-slate-850/60 flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-455">
                            <span>Open Requisitions:</span>
                            <span class="text-slate-800 dark:text-white font-extrabold">${v.items.length} lines</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // --- Slide-out Vehicle Detail Panel (Offcanvas Drawer) Controller ---
        let activeVehicleName = '';
        let vehicleActiveTab = 'supplier';

        function openVehicleOffcanvas(vehicleName) {
            const offcanvas = document.getElementById('vehicleOffcanvas');
            if (!offcanvas) return;

            activeVehicleName = vehicleName;
            document.getElementById('vehicleOffcanvasName').textContent = vehicleName;

            vehicleActiveTab = 'supplier';
            setVehicleTab('supplier');

            // Slide in
            offcanvas.classList.remove('translate-x-full');
        }

        function closeVehicleOffcanvas() {
            const offcanvas = document.getElementById('vehicleOffcanvas');
            if (offcanvas) offcanvas.classList.add('translate-x-full');
            activeVehicleName = '';
        }

        function setVehicleTab(tab) {
            vehicleActiveTab = tab;
            
            // Tab button styles
            const tabs = ['supplier', 'store', 'history'];
            tabs.forEach(t => {
                const btn = document.getElementById(`btn-vehicleTab-${t}`);
                const content = document.getElementById(`vehicleTabContent-${t}`);
                if (!btn || !content) return;

                if (t === tab) {
                    btn.className = "flex-1 pb-3 text-xs font-black uppercase tracking-wider border-b-2 border-indigo-600 text-indigo-650 dark:text-indigo-400 outline-none transition-all";
                    content.classList.remove('hidden');
                } else {
                    btn.className = "flex-1 pb-3 text-xs font-black uppercase tracking-wider border-b-2 border-transparent text-slate-455 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 outline-none transition-all";
                    content.classList.add('hidden');
                }
            });

            renderVehicleOffcanvasData();
        }

        function renderVehicleOffcanvasData() {
            if (!activeVehicleName) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Filter items & issues for active vehicle
            const vehicleItems = displayAll.filter(item => item.vehicleMachinery && item.vehicleMachinery.trim() === activeVehicleName);
            const vehicleIssues = issues.filter(is => is.vehicleMachinery && is.vehicleMachinery.trim() === activeVehicleName);

            // Shared matching rule (itemId link -> MRN + name -> vehicle + name)
            const getIssuedQty = (item) => issuedQtyForItem(item);

            // Totals and spend
            let totalSpend = 0;
            let pendingSupplierCount = 0;
            let pendingWorkshopCount = 0;
            let hasOverdue = false;
            const today = new Date();
            today.setHours(0,0,0,0);

            // Calculate spend from receipts linked to this vehicle's items
            vehicleItems.forEach(item => {
                (item.receipts || []).forEach(r => {
                    if (r.unitPrice && r.qty > 0) {
                        totalSpend += Math.abs(r.qty) * r.unitPrice;
                    }
                });

                const issuedQty = getIssuedQty(item);
                const isPendingSupplier = item.reqQty > item.recQty;
                const isPendingWorkshop = item.recQty > issuedQty;

                if (isPendingSupplier) {
                    pendingSupplierCount++;
                    if (parseDate(item.reqDate) < today) hasOverdue = true;
                }
                if (isPendingWorkshop) {
                    pendingWorkshopCount++;
                }
            });

            // Set KPIs
            document.getElementById('vehicleOffcanvasSpend').textContent = formatCurrency(Math.round(totalSpend * 100) / 100);
            document.getElementById('vehicleOffcanvasPendingSupplierCount').textContent = pendingSupplierCount;
            document.getElementById('vehicleOffcanvasPendingWorkshopCount').textContent = pendingWorkshopCount;

            // Set Header Status
            const statusDot = document.getElementById('vehicleOffcanvasStatusDot');
            const statusText = document.getElementById('vehicleOffcanvasStatusText');
            if (statusDot && statusText) {
                if (hasOverdue) {
                    statusDot.className = "w-3 h-3 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]";
                    statusText.textContent = "Downtime Risk (Overdue Requisitions)";
                    statusText.className = "text-rose-600 dark:text-rose-400 font-extrabold";
                } else if (pendingSupplierCount > 0) {
                    statusDot.className = "w-3 h-3 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.7)]";
                    statusText.textContent = "Requisitions Pending Supplier";
                    statusText.className = "text-amber-605 dark:text-amber-400 font-extrabold";
                } else if (pendingWorkshopCount > 0) {
                    statusDot.className = "w-3 h-3 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]";
                    statusText.textContent = "Items on Shelf (Pending Fitting)";
                    statusText.className = "text-blue-600 dark:text-blue-450 font-extrabold";
                } else {
                    statusDot.className = "w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]";
                    statusText.textContent = "Fully Operational";
                    statusText.className = "text-emerald-600 dark:text-emerald-450 font-extrabold";
                }
            }

            // Set Pipeline Progress Bar width and steps colors
            const progressBar = document.getElementById('vehiclePipelineProgressBar');
            const step1 = document.getElementById('vehiclePipelineStep1');
            const step2 = document.getElementById('vehiclePipelineStep2');
            const step3 = document.getElementById('vehiclePipelineStep3');

            if (progressBar && step1 && step2 && step3) {
                // Default styles
                step2.className = "w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-850 text-slate-500 flex items-center justify-center font-bold text-xs border border-slate-200 dark:border-slate-800";
                step3.className = "w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-850 text-slate-500 flex items-center justify-center font-bold text-xs border border-slate-200 dark:border-slate-800";

                if (pendingSupplierCount > 0) {
                    progressBar.style.width = "0%";
                    step1.className = "w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold text-xs border border-amber-200";
                } else if (pendingWorkshopCount > 0) {
                    progressBar.style.width = "50%";
                    step1.className = "w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-xs border border-emerald-250";
                    step2.className = "w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-450 flex items-center justify-center font-bold text-xs border border-blue-200";
                } else if (vehicleItems.length > 0) {
                    progressBar.style.width = "100%";
                    step1.className = "w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-xs border border-emerald-250";
                    step2.className = "w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-xs border border-emerald-250";
                    step3.className = "w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-450 flex items-center justify-center font-bold text-xs border border-emerald-250";
                } else {
                    progressBar.style.width = "0%";
                    step1.className = "w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-850 text-slate-500 flex items-center justify-center font-bold text-xs border border-slate-200 dark:border-slate-800";
                }
            }

            // Populate Tabs Content
            const supplierContent = document.getElementById('vehicleTabContent-supplier');
            const storeContent = document.getElementById('vehicleTabContent-store');
            const historyContent = document.getElementById('vehicleTabContent-history');

            if (vehicleActiveTab === 'supplier') {
                const supplierItems = vehicleItems.filter(i => i.reqQty > i.recQty);
                if (supplierItems.length === 0) {
                    supplierContent.innerHTML = `
                        <div class="text-center py-8 text-slate-400 dark:text-slate-600 text-xs italic bg-slate-50 dark:bg-slate-950/20 border border-dashed border-slate-250 dark:border-slate-800 rounded-2xl">
                            All ordered items have arrived. No pending supplier deliveries.
                        </div>
                    `;
                } else {
                    supplierContent.innerHTML = supplierItems.map(item => {
                        const balance = Math.round((item.reqQty - item.recQty) * 100) / 100;
                        const isItemOverdue = parseDate(item.reqDate) < today;
                        const dateBadge = isItemOverdue 
                            ? `<span class="px-2 py-0.5 rounded text-[9px] font-extrabold uppercase border border-rose-100 bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:border-rose-900/20">Overdue: ${item.reqDate}</span>`
                            : `<span class="px-2 py-0.5 rounded text-[9px] font-extrabold uppercase border border-slate-200 bg-slate-50 text-slate-500">Ordered: ${item.reqDate}</span>`;
                        
                        return `
                            <div class="bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm hover:shadow-glow transition duration-150 flex flex-col justify-between">
                                <div class="flex justify-between items-start gap-2 mb-2">
                                    <div>
                                        <div class="text-sm font-bold text-slate-800 dark:text-slate-200">${escapeHtml(item.name)}</div>
                                        <div class="text-[10px] text-slate-450 dark:text-slate-550 font-medium truncate max-w-[280px]" title="${escapeHtml(item.itemDesc || '')}">${escapeHtml(item.itemDesc) || 'No description'}</div>
                                    </div>
                                    <span class="text-xs font-black text-amber-500 whitespace-nowrap bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 rounded-lg border border-amber-100 dark:border-amber-900/30">${balance} Pending</span>
                                </div>
                                <div class="flex justify-between items-center mt-3 pt-3 border-t border-slate-100 dark:border-slate-850/60 w-full">
                                    <div class="flex gap-2 items-center font-bold">
                                        ${dateBadge}
                                        <span class="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${categoryBadgeClass(item.category)}">${item.category || 'General'}</span>
                                    </div>
                                    <a href="#receiving/${item.id}" onclick="closeVehicleOffcanvas()" class="text-xs font-extrabold text-indigo-650 dark:text-indigo-400 hover:underline flex items-center gap-1">
                                        Log Receipt &rarr;
                                    </a>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } else if (vehicleActiveTab === 'store') {
                const storeItems = vehicleItems.filter(item => item.recQty > getIssuedQty(item));
                if (storeItems.length === 0) {
                    storeContent.innerHTML = `
                        <div class="text-center py-8 text-slate-400 dark:text-slate-600 text-xs italic bg-slate-50 dark:bg-slate-950/20 border border-dashed border-slate-250 dark:border-slate-800 rounded-2xl">
                            No store stock registered. All received items have been issued/fitted.
                        </div>
                    `;
                } else {
                    storeContent.innerHTML = storeItems.map(item => {
                        const issued = getIssuedQty(item);
                        const storeStock = Math.round((item.recQty - issued) * 100) / 100;
                        const sources = [...new Set(item.receipts.map(r => r.purchaseSource).filter(Boolean))].join(', ');
                        
                        return `
                            <div class="bg-white dark:bg-slate-900 border border-slate-150 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm hover:shadow-glow transition duration-150 flex flex-col justify-between">
                                <div class="flex justify-between items-start gap-2 mb-2">
                                    <div>
                                        <div class="text-sm font-bold text-slate-800 dark:text-slate-200">${escapeHtml(item.name)}</div>
                                        <div class="text-[10px] text-slate-450 dark:text-slate-550 font-medium">MRN Ref: <strong class="text-indigo-650 dark:text-indigo-400">${escapeHtml(item.mrnNum)}</strong></div>
                                    </div>
                                    <span class="text-xs font-black text-indigo-600 dark:text-indigo-400 whitespace-nowrap bg-indigo-50 dark:bg-indigo-950/40 px-2.5 py-1 rounded-lg border border-indigo-100 dark:border-indigo-900/30">${storeStock} in Stock</span>
                                </div>
                                <div class="flex justify-between items-center mt-3 pt-3 border-t border-slate-100 dark:border-slate-850/60 w-full text-xs">
                                    <div class="flex gap-2 items-center">
                                        <span class="px-2 py-0.5 rounded text-[9px] font-extrabold uppercase border border-slate-200 bg-slate-50 text-slate-500">Arrived: ${item.recDate || '-'}</span>
                                        ${sources ? `<span class="px-2 py-0.5 bg-slate-100 dark:bg-slate-850 text-[8px] uppercase font-black text-slate-500 rounded border border-slate-200 dark:border-slate-800">${sources}</span>` : ''}
                                    </div>
                                    <a href="#issue-desk/request/${item.id}" onclick="closeVehicleOffcanvas()" class="text-xs font-extrabold text-emerald-600 dark:text-emerald-450 hover:underline flex items-center gap-1">
                                        Issue Log &rarr;
                                    </a>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } else if (vehicleActiveTab === 'history') {
                if (vehicleIssues.length === 0) {
                    historyContent.innerHTML = `
                        <div class="text-center py-8 text-slate-400 dark:text-slate-600 text-xs italic bg-slate-50 dark:bg-slate-950/20 border border-dashed border-slate-250 dark:border-slate-800 rounded-2xl">
                            No issue history recorded for this machinery.
                        </div>
                    `;
                } else {
                    historyContent.innerHTML = vehicleIssues.map(is => `
                        <div class="bg-slate-50 dark:bg-slate-950/30 border border-slate-150 dark:border-slate-800/80 rounded-2xl p-4 text-xs shadow-sm flex flex-col justify-between">
                            <div>
                                <div class="flex justify-between items-center w-full mb-2">
                                    <span class="font-extrabold text-indigo-650 dark:text-indigo-400 text-sm">Issued ${is.qty} units</span>
                                    <span class="px-2 py-0.5 bg-white dark:bg-slate-850 text-[9px] font-black uppercase text-slate-500 rounded border border-slate-200 dark:border-slate-800">${escapeHtml(is.issueDate)}</span>
                                </div>
                                <div class="font-extrabold text-slate-800 dark:text-slate-250 text-sm mb-1">${escapeHtml(is.itemName)}</div>
                                ${is.itemDesc ? `<div class="text-[10px] text-slate-450 dark:text-slate-550 font-medium mb-2">${escapeHtml(is.itemDesc)}</div>` : ''}
                            </div>
                            <div class="flex justify-between items-center mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-800/80 w-full text-slate-500 font-bold">
                                <div>Recipient: <strong class="text-slate-700 dark:text-slate-350 font-extrabold">${escapeHtml(is.issuedTo) || '-'}</strong></div>
                                ${is.issuedBy ? `<div>By: <strong class="text-slate-700 dark:text-slate-350 font-extrabold">${escapeHtml(is.issuedBy)}</strong></div>` : ''}
                            </div>
                        </div>
                    `).join('');
                }
            }
        }

        // Setup dynamic drop-downs in Receiving Desk View
        function setupReceivingDesk(prefilledId = null) {
            const select = document.getElementById('recDeskItemSelect');
            const searchInput = document.getElementById('recDeskItemSearch');
            const datalist = document.getElementById('recDeskItemOptions');
            const metaContainer = document.getElementById('recDeskItemMetadata');
            const recQtyInput = document.getElementById('recDeskQty');
            const filenameLabel = document.getElementById('receivingPdfFilename');
            if (!select || !searchInput || !datalist) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Fetch active pending MRN items
            const activeItems = displayAll.filter(item => item.reqQty > item.recQty);

            // Populate datalist options
            datalist.innerHTML = '';
            activeItems.forEach(item => {
                const opt = document.createElement('option');
                opt.value = `${item.mrnNum} - ${item.name} (${item.vehicleMachinery})`;
                datalist.appendChild(opt);
            });

            // Set up input event handler to update selected ID
            searchInput.oninput = () => {
                const val = searchInput.value;
                const match = activeItems.find(item => 
                    `${item.mrnNum} - ${item.name} (${item.vehicleMachinery})` === val
                );
                if (match) {
                    select.value = match.id;
                    handleReceivingItemSelection(match.id);
                } else {
                    select.value = '';
                    handleReceivingItemSelection('');
                }
            };

            if (prefilledId) {
                const matchedItem = activeItems.find(item => String(item.id) === String(prefilledId)) || 
                                    displayAll.find(item => String(item.id) === String(prefilledId));
                if (matchedItem) {
                    searchInput.value = `${matchedItem.mrnNum} - ${matchedItem.name} (${matchedItem.vehicleMachinery})`;
                } else {
                    searchInput.value = '';
                }
                searchInput.disabled = true;
                select.value = prefilledId;
                select.disabled = true;
                handleReceivingItemSelection(prefilledId);
            } else {
                searchInput.disabled = false;
                searchInput.value = '';
                select.disabled = false;
                select.value = '';
                metaContainer.innerHTML = 'No item selected';
                recQtyInput.value = '';
                if (filenameLabel) filenameLabel.textContent = 'No invoice PDF selected (optional)';
            }

            document.getElementById('recDeskDate').value = new Date().toISOString().split('T')[0];
        }

        // Where the currently selected MRN was requested from ('Local'|'Head Office'|null);
        // drives the purchase-source pre-selection + mismatch note on the receiving desk.
        let recDeskRequestedSource = null;
        const PURCHASE_FOR_REQUEST = { 'Local': 'Local Purchase', 'Head Office': 'Head Office Purchase' };

        function updateRecDeskMismatchNote() {
            const note = document.getElementById('recDeskSourceMismatch');
            if (!note) return;
            const checked = document.querySelector('input[name="recDeskPurchaseSource"]:checked');
            const expected = PURCHASE_FOR_REQUEST[recDeskRequestedSource];
            if (expected && checked && checked.value !== expected) {
                note.textContent = `Note: this item was requested from ${recDeskRequestedSource}, but you are confirming it as received via ${checked.value}.`;
                note.classList.remove('hidden');
            } else {
                note.classList.add('hidden');
            }
        }

        function handleReceivingItemSelection(itemId) {
            const metaContainer = document.getElementById('recDeskItemMetadata');
            if (!itemId) {
                metaContainer.innerHTML = 'No item selected';
                recDeskRequestedSource = null;
                updateRecDeskMismatchNote();
                return;
            }

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) {
                metaContainer.innerHTML = 'Requisition item not found';
                recDeskRequestedSource = null;
                updateRecDeskMismatchNote();
                return;
            }

            const dateGapInfo = item.recDate ? `(Last delivery on ${item.recDate})` : '(No deliveries logged yet)';
            const reqSrcBadge = item.requestSource
                ? `<div>Requested From: <strong class="${item.requestSource === 'Head Office' ? 'text-indigo-650 dark:text-indigo-400' : 'text-emerald-600 dark:text-emerald-400'} font-extrabold">${escapeHtml(item.requestSource)}</strong></div>`
                : '';
            metaContainer.innerHTML = `
                <div class="space-y-1 w-full text-xs font-semibold">
                    <div>Machinery: <strong class="text-slate-800 dark:text-white font-extrabold">${escapeHtml(item.vehicleMachinery)}</strong></div>
                    <div>Item Spec: <strong class="text-slate-800 dark:text-white font-extrabold">${escapeHtml(item.name)}</strong></div>
                    ${reqSrcBadge}
                    <div>Fulfillment Status: <strong class="text-indigo-650 dark:text-indigo-400 font-extrabold">${item.recQty || 0} received of ${item.reqQty} requested</strong></div>
                    <div class="text-[10px] text-slate-450 dark:text-slate-500 font-medium">Requisition opened: ${item.reqDate} ${dateGapInfo}</div>
                </div>
            `;

            // Pre-select the purchase source that matches where it was requested from.
            recDeskRequestedSource = item.requestSource || null;
            const expected = PURCHASE_FOR_REQUEST[recDeskRequestedSource];
            if (expected) {
                const radio = document.querySelector(`input[name="recDeskPurchaseSource"][value="${expected}"]`);
                if (radio) radio.checked = true;
            }
            updateRecDeskMismatchNote();

            // Auto-fill delivery qty to fulfill remaining balance by default
            const balance = Math.max(0, Math.round((item.reqQty - item.recQty) * 100) / 100);
            document.getElementById('recDeskQty').value = balance;
        }

        // Render Pricing & Audit Desk View
        function renderPricingDesk() {
            const listContainer = document.getElementById('unpricedDeliveriesList');
            if (!listContainer) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Get search query
            const searchInput = document.getElementById('pricingSearchInput');
            const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

            const unpriced = [];
            displayAll.forEach(item => {
                (item.receipts || []).forEach(r => {
                    const isMissingPrice = !r.unitPrice || r.unitPrice === 0;
                    if (isMissingPrice) {
                        const mrnMatch = item.mrnNum ? item.mrnNum.toLowerCase().includes(query) : false;
                        const nameMatch = item.name ? item.name.toLowerCase().includes(query) : false;
                        const vehicleMatch = item.vehicleMachinery ? item.vehicleMachinery.toLowerCase().includes(query) : false;
                        
                        if (!query || mrnMatch || nameMatch || vehicleMatch) {
                            unpriced.push({ item, receipt: r });
                        }
                    }
                });
            });

            if (unpriced.length === 0) {
                listContainer.innerHTML = `
                    <div class="py-10 text-center text-xs font-semibold text-slate-400 dark:text-slate-550 italic bg-slate-50/50 dark:bg-slate-900/10 border border-slate-150 dark:border-slate-850 rounded-2xl">
                        ${query ? 'No matching unpriced deliveries found.' : 'No unpriced deliveries. Audit status: 100% complete!'}
                    </div>
                `;
                const activeReceiptId = document.getElementById('auditReceiptId')?.value;
                if (!query && activeReceiptId) {
                    closePricingAuditWorkspace();
                }
                return;
            }

            listContainer.innerHTML = unpriced.map(({item, receipt}) => {
                const activeReceiptId = document.getElementById('auditReceiptId')?.value;
                const isSelected = String(receipt.id) === String(activeReceiptId);
                const typeText = receipt.transactionType === 'Return' ? 'Returned' : 'Delivered';
                const sourceBadge = receipt.purchaseSource ? `<span class="shrink-0 text-[8px] tracking-widest uppercase font-extrabold px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-md border border-slate-200/50 dark:border-slate-800/80">${receipt.purchaseSource}</span>` : '';
                
                return `
                    <button onclick="openPricingAuditWorkspace('${item.id}', '${receipt.id}')"
                        class="w-full text-left p-4 rounded-2xl border transition shadow-sm outline-none flex flex-col justify-between ${isSelected ? 'bg-indigo-50/50 dark:bg-indigo-950/30 border-indigo-400 dark:border-indigo-900/50 ring-1 ring-indigo-300' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-900 hover:shadow-glow'}">
                        <div class="flex justify-between items-start w-full gap-2 mb-1.5">
                            <span class="text-xs font-extrabold text-slate-900 dark:text-white truncate max-w-[125px]">${escapeHtml(item.mrnNum)}</span>
                            <span class="text-xs font-black ${receipt.transactionType === 'Return' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-450'} whitespace-nowrap">${typeText}: ${Math.abs(receipt.qty)}</span>
                        </div>
                        <div class="text-xs font-bold text-slate-700 dark:text-slate-350 truncate w-full mb-2">${escapeHtml(item.name)}</div>
                        <div class="flex justify-between items-center w-full mt-1.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                            <span class="text-[10px] text-slate-400 dark:text-slate-550 font-semibold">${receipt.deliveryDate}</span>
                            ${sourceBadge}
                        </div>
                    </button>
                `;
            }).join('');
        }

        function openPricingAuditWorkspace(itemId, receiptId) {
            const formContainer = document.getElementById('pricingAuditWorkspace');
            const emptyContainer = document.getElementById('pricingAuditEmptyState');
            if (!formContainer || !emptyContainer) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;
            const receipt = (item.receipts || []).find(r => String(r.id) === String(receiptId));
            if (!receipt) return;

            document.getElementById('auditItemId').value = itemId;
            document.getElementById('auditReceiptId').value = receiptId;
            document.getElementById('auditWorkspaceMrn').textContent = `${item.mrnNum} - ${item.vehicleMachinery}`;
            document.getElementById('auditWorkspaceQty').textContent = `Log Qty: ${receipt.qty} (${receipt.transactionType})`;

            // Load values or reset
            document.getElementById('aud_grnNumber').value = receipt.grnNumber || '';
            document.getElementById('aud_invoiceNumber').value = receipt.invoiceNumber || '';
            document.getElementById('aud_invoiceDate').value = receipt.invoiceDate || '';
            document.getElementById('aud_supplierName').value = receipt.supplierName || '';
            document.getElementById('aud_unitPrice').value = receipt.unitPrice || '';
            
            updateAuditFormTotalPrice();

            formContainer.classList.remove('hidden');
            emptyContainer.classList.add('hidden');

            // Re-render unpriced sidebar to display selected active ring
            renderPricingDesk();
        }

        function closePricingAuditWorkspace() {
            const formContainer = document.getElementById('pricingAuditWorkspace');
            const emptyContainer = document.getElementById('pricingAuditEmptyState');
            const auditReceiptIdInput = document.getElementById('auditReceiptId');
            if (!formContainer || !emptyContainer) return;

            if (auditReceiptIdInput) auditReceiptIdInput.value = '';

            formContainer.classList.add('hidden');
            emptyContainer.classList.remove('hidden');
            
            // Re-render list to clean active borders
            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);
            const listContainer = document.getElementById('unpricedDeliveriesList');
            if (listContainer) {
                const unpriced = [];
                displayAll.forEach(item => {
                    (item.receipts || []).forEach(r => {
                        if (!r.unitPrice || r.unitPrice === 0) {
                            unpriced.push({ item, receipt: r });
                        }
                    });
                });
                renderPricingDesk();
            }
        }

        function updateAuditFormTotalPrice() {
            const itemId = document.getElementById('auditItemId').value;
            const receiptId = document.getElementById('auditReceiptId').value;
            
            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;
            const receipt = (item.receipts || []).find(r => String(r.id) === String(receiptId));
            if (!receipt) return;

            const qty = Math.abs(receipt.qty);
            const unitPrice = parseFloat(document.getElementById('aud_unitPrice').value) || 0;
            const total = qty * unitPrice;
            document.getElementById('aud_totalPriceDisplay').textContent = formatCurrency(total);
        }

        // Central Router Engine
        function handleRouting() {
            // Navigating from the mobile drawer should close it.
            if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
            const hash = window.location.hash || '#dashboard';
            const views = ['operations', 'dashboard', 'jobcards', 'jobcard-entry', 'programme', 'tracker', 'receiving', 'pricing', 'fleet', 'issued', 'issue-desk', 'inventory', 'batteries', 'battery-entry', 'battery-move', 'transfers', 'transfer-entry'];
            
            let matchedView = 'dashboard';
            let routeParam = null;
            let routeSubParam = null;

            views.forEach(v => {
                if (hash.startsWith('#' + v)) {
                    matchedView = v;
                    const parts = hash.split('/');
                    if (parts.length > 2) {
                        routeParam = parts[1];
                        routeSubParam = parts[2];
                    } else if (parts.length > 1) {
                        routeParam = parts[1];
                    }
                }
            });

            currentView = matchedView;

            // Close any open overlays by default when routing
            closePricingOffcanvas();
            closeVehicleOffcanvas();
            closeInventoryOffcanvas();
            closeEditRequestModal();
            closeAddModal();
            closeBatteryOffcanvas();
            closeTransferOffcanvas();
            closeJobCardModal();

            // Toggle route views visibility in main frame
            document.querySelectorAll('.route-view').forEach(el => {
                el.classList.add('hidden');
                el.classList.remove('animate-fade-in');
            });
            const activeSection = document.getElementById('view-' + currentView);
            if (activeSection) {
                activeSection.classList.remove('hidden');
                activeSection.classList.add('animate-fade-in');
            }

            // Sync sidebar links styling
            document.querySelectorAll('#sidebarNav a').forEach(link => {
                const isBatterySubView = (currentView === 'battery-entry' || currentView === 'battery-move') && link.id === 'nav-batteries';
                const isTransferSubView = (currentView === 'transfer-entry') && link.id === 'nav-transfers';
                if (link.id === 'nav-' + currentView || isBatterySubView || isTransferSubView) {
                    link.className = "sidebar-btn w-full flex items-center justify-between px-3.5 py-3 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 font-semibold rounded-2xl transition-all duration-200 border border-indigo-100/50 dark:border-indigo-900/30 outline-none";
                    const badge = link.querySelector('.sidebar-badge');
                    if (badge) badge.className = "sidebar-badge bg-indigo-100 dark:bg-indigo-900/60 text-indigo-850 dark:text-indigo-300 py-0.5 px-3 rounded-full text-xs font-extrabold transition-all";
                } else {
                    link.className = "sidebar-btn w-full flex items-center justify-between px-3.5 py-3 text-slate-655 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 font-semibold rounded-2xl transition-all duration-200 border border-transparent outline-none";
                    const badge = link.querySelector('.sidebar-badge');
                    if (badge) badge.className = "sidebar-badge bg-slate-100 dark:bg-slate-800 text-slate-655 dark:text-slate-400 py-0.5 px-3 rounded-full text-xs font-extrabold transition-all";
                }
            });

            renderCurrentView(routeParam, routeSubParam);
        }

        // Renders active routed page views
        function renderCurrentView(param = null, subParam = null) {
            switch(currentView) {
                case 'operations':
                    if (typeof loadOperations === 'function') loadOperations();
                    break;
                case 'dashboard':
                    renderDashboard();
                    if (typeof renderUnifiedDashboard === 'function') renderUnifiedDashboard();
                    break;
                case 'jobcards':
                    renderJobCards();
                    break;
                case 'jobcard-entry':
                    setupJobCardEntry(param);
                    break;
                case 'programme':
                    renderProgramme();
                    break;
                case 'tracker':
                    renderTable();
                    break;
                case 'receiving':
                    setupReceivingDesk(param);
                    break;
                case 'pricing':
                    const pSearch = document.getElementById('pricingSearchInput');
                    if (pSearch) pSearch.value = '';
                    renderPricingDesk();
                    break;
                case 'fleet':
                    renderFleetView();
                    break;
                case 'issued':
                    renderIssuesView();
                    break;
                case 'issue-desk':
                    setupIssueDesk(param, subParam);
                    break;
                case 'inventory':
                    renderInventoryView();
                    break;
                case 'batteries':
                    renderBatteriesView();
                    break;
                case 'battery-entry':
                    setupBatteryEntry(param);
                    break;
                case 'battery-move':
                    setupBatteryMove(param);
                    break;
                case 'transfers':
                    renderTransfersView();
                    break;
                case 'transfer-entry':
                    setupTransferEntry(param);
                    break;
            }
        }

        window.addEventListener('hashchange', handleRouting);
        window.addEventListener('DOMContentLoaded', handleRouting);

        // Slide-out Pricing Offcanvas Panel Logic
        function openPricingOffcanvas(itemId) {
            const offcanvas = document.getElementById('pricingOffcanvas');
            if (!offcanvas) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;

            document.getElementById('pricingOffcanvasMrn').textContent = item.mrnNum;
            document.getElementById('pricingOffcanvasMrn').dataset.itemId = itemId;
            document.getElementById('pricingOffcanvasName').textContent = item.name;

            // Populate deliveries dropdown
            populateOffcanvasDeliverySelect(item);

            // Populate fulfillment logs list
            renderOffcanvasReceiptHistory(item);

            // Slide in
            offcanvas.classList.remove('translate-x-full');
        }

        function closePricingOffcanvas() {
            const offcanvas = document.getElementById('pricingOffcanvas');
            if (offcanvas) offcanvas.classList.add('translate-x-full');
        }

        function populateOffcanvasDeliverySelect(item) {
            const select = document.getElementById('offcanvasDeliverySelect');
            const pricingForm = document.getElementById('offcanvasPricingForm');
            const noDeliveriesWarning = document.getElementById('offcanvasNoDeliveriesWarning');
            const receipts = item.receipts || [];

            select.innerHTML = '';
            if (receipts.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No deliveries logged yet';
                select.appendChild(opt);
                select.disabled = true;

                pricingForm.classList.add('hidden');
                noDeliveriesWarning.classList.remove('hidden');
            } else {
                select.disabled = false;
                pricingForm.classList.remove('hidden');
                noDeliveriesWarning.classList.add('hidden');

                const optDefault = document.createElement('option');
                optDefault.value = '';
                optDefault.textContent = '-- Select Logged Delivery --';
                select.appendChild(optDefault);

                receipts.forEach((r, idx) => {
                    const opt = document.createElement('option');
                    opt.value = idx;
                    const typeText = r.transactionType === 'Return' ? 'Returned' : 'Delivered';
                    const pricingText = r.unitPrice ? `Priced: ${formatCurrency(r.unitPrice * Math.abs(r.qty))}` : 'Unpriced';
                    opt.textContent = `${typeText} ${Math.abs(r.qty)} on ${r.deliveryDate} (${pricingText})`;
                    select.appendChild(opt);
                });
            }
        }

        function loadOffcanvasSelectedDeliveryPricing() {
            const select = document.getElementById('offcanvasDeliverySelect');
            const itemId = document.getElementById('pricingOffcanvasMrn').dataset.itemId;
            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;

            const receiptIdx = select.value;
            if (receiptIdx === '') {
                document.getElementById('off_grnNumber').value = '';
                document.getElementById('off_invoiceNumber').value = '';
                document.getElementById('off_invoiceDate').value = '';
                document.getElementById('off_supplierName').value = '';
                document.getElementById('off_unitPrice').value = '';
                document.getElementById('off_totalPriceDisplay').textContent = 'Rs. 0.00';
                return;
            }

            const receipt = item.receipts[receiptIdx];
            document.getElementById('off_grnNumber').value = receipt.grnNumber || '';
            document.getElementById('off_invoiceNumber').value = receipt.invoiceNumber || '';
            document.getElementById('off_invoiceDate').value = receipt.invoiceDate || '';
            document.getElementById('off_supplierName').value = receipt.supplierName || '';
            document.getElementById('off_unitPrice').value = receipt.unitPrice || '';

            updateOffcanvasPricingFormTotalPrice();
        }

        function updateOffcanvasPricingFormTotalPrice() {
            const select = document.getElementById('offcanvasDeliverySelect');
            const itemId = document.getElementById('pricingOffcanvasMrn').dataset.itemId;
            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;

            const receiptIdx = select.value;
            if (receiptIdx === '') {
                document.getElementById('off_totalPriceDisplay').textContent = 'Rs. 0.00';
                return;
            }

            const receipt = item.receipts[receiptIdx];
            const qty = Math.abs(receipt.qty);
            const unitPrice = parseFloat(document.getElementById('off_unitPrice').value) || 0;
            const total = qty * unitPrice;
            document.getElementById('off_totalPriceDisplay').textContent = formatCurrency(total);
        }

        function renderOffcanvasReceiptHistory(item) {
            const list = document.getElementById('offcanvasReceiptHistoryList');
            const receipts = item.receipts || [];
            if (!list) return;

            if (receipts.length === 0) {
                list.innerHTML = `
                    <div class="text-center py-6 text-slate-400 dark:text-slate-600 text-xs italic">
                        No transactions recorded.
                    </div>
                `;
                return;
            }

            list.innerHTML = receipts.map((r, i) => {
                const typeText = r.transactionType === 'Return' ? 'Returned' : 'Received';
                const grnVal = r.grnNumber ? `<span>GRN: <strong class="text-slate-700 dark:text-slate-300 font-extrabold">${escapeHtml(r.grnNumber)}</strong></span>` : '';
                const invVal = r.invoiceNumber ? `<span>INV: <strong class="text-slate-700 dark:text-slate-300 font-extrabold">${escapeHtml(r.invoiceNumber)}</strong></span>` : '';
                const supplierVal = r.supplierName ? `<span>Supplier: <strong class="text-slate-700 dark:text-slate-300 font-bold">${escapeHtml(r.supplierName)}</strong></span>` : '';
                const priceVal = r.unitPrice ? `<div class="text-emerald-700 dark:text-emerald-450 font-extrabold mt-1 w-full block">${formatCurrency(r.unitPrice)} &times; ${Math.abs(r.qty)} = ${formatCurrency(Math.abs(r.qty) * r.unitPrice)}</div>` : '';
                const hasPricing = r.grnNumber || r.invoiceNumber || r.supplierName || r.unitPrice;

                return `
                    <div class="bg-slate-50 dark:bg-slate-950/30 border border-slate-150 dark:border-slate-800 rounded-xl p-3.5 text-xs">
                        <div class="flex justify-between items-center w-full mb-1">
                            <span class="font-extrabold ${r.transactionType === 'Return' ? 'text-rose-600 dark:text-rose-400' : 'text-indigo-655 dark:text-indigo-400'}">${typeText} ${Math.abs(r.qty)}</span>
                            <div class="flex gap-2 items-center">
                                ${r.purchaseSource ? `<span class="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-[9px] uppercase tracking-wider font-extrabold rounded-md text-slate-500">${escapeHtml(r.purchaseSource)}</span>` : ''}
                                ${hasPricing ? `
                                    <button type="button" onclick="clearReceiptPricing('${item.id}', '${r.id}')" class="text-amber-500 hover:text-amber-700 transition" title="Delete Pricing & Supplier Details">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
                                    </button>
                                ` : ''}
                                <button type="button" onclick="deleteReceipt('${item.id}', '${r.id}')" class="text-rose-500 hover:text-rose-700 transition" title="Delete Log">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </div>
                        <div class="text-[10px] text-slate-400 dark:text-slate-550 font-semibold mb-1">Fulfillment recorded: ${r.deliveryDate}</div>
                        ${hasPricing ? `
                            <div class="flex flex-wrap gap-x-3 gap-y-1.5 mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-850/60 text-slate-500">
                                ${grnVal}
                                ${invVal}
                                ${supplierVal}
                                ${priceVal}
                            </div>
                        ` : `
                            <div class="mt-2 text-[9px] font-extrabold text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-950/20 px-2 py-0.5 border border-amber-100/50 dark:border-amber-900/10 rounded-md w-fit">No pricing details linked yet.</div>
                        `}
                    </div>
                `;
            }).join('');
        }

        // Lightweight Edit Modal Overlay Controllers
        function openEditRequestModal(itemId) {
            const modal = document.getElementById('editRequestModal');
            if (!modal) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            const item = displayAll.find(i => String(i.id) === String(itemId));
            if (!item) return;

            document.getElementById('editRequestDetailsItemId').value = itemId;
            document.getElementById('editReqMrnNum').value = item.mrnNum || '';
            document.getElementById('editReqDateInput').value = item.reqDateISO || toDateInput(item.reqDate);
            document.getElementById('editReqVehicle').value = item.vehicleMachinery || '';
            document.getElementById('editReqName').value = item.itemName || '';
            document.getElementById('editReqDesc').value = item.itemDesc || '';
            document.getElementById('editReqQtyInput').value = item.reqQty || '';
            document.getElementById('editReqCategory').value = item.category || '';
            document.querySelectorAll('input[name="editReqSource"]').forEach(r => { r.checked = (r.value === item.requestSource); });

            modal.classList.remove('hidden');
        }

        function closeEditRequestModal() {
            const modal = document.getElementById('editRequestModal');
            if (modal) modal.classList.add('hidden');
        }

        // Edit request details form submission
        editRequestDetailsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('editRequestDetailsItemId').value;

            const mrnNum = document.getElementById('editReqMrnNum').value.trim();
            const reqDate = document.getElementById('editReqDateInput').value;
            const vehicleMachinery = document.getElementById('editReqVehicle').value.trim();
            const itemName = document.getElementById('editReqName').value.trim();
            const itemDesc = document.getElementById('editReqDesc').value.trim();
            const reqQty = parseFloat(document.getElementById('editReqQtyInput').value);
            const category = document.getElementById('editReqCategory').value;
            const editSrcEl = document.querySelector('input[name="editReqSource"]:checked');
            const requestSource = editSrcEl ? editSrcEl.value : null;

            const updateData = { mrnNum, reqDate, vehicleMachinery, itemName, itemDesc, reqQty, category, requestSource };

            await syncService.enqueue(
                'UPDATE_ITEM',
                `/api/items/${itemId}`,
                'PUT',
                updateData,
                () => {
                    const item = allItems.find(i => String(i.id) === String(itemId));
                    if (item) {
                        Object.assign(item, updateData);
                        item.name = itemName;
                    }
                    const pageItem = items.find(i => String(i.id) === String(itemId));
                    if (pageItem) {
                        Object.assign(pageItem, updateData);
                        pageItem.name = itemName;
                    }
                    renderCurrentView();
                }
            );

            closeEditRequestModal();
        });

        // Form Submit Listeners with Optimistic + Background sync enqueues
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mrnNum = document.getElementById('mrnNum').value.trim();
            const reqDate = document.getElementById('reqDate').value;
            const vehicleMachinery = document.getElementById('vehicleMachinery').value.trim();
            const itemName = document.getElementById('itemName').value.trim();
            const itemDesc = document.getElementById('itemDesc').value.trim();
            const reqQty = parseFloat(document.getElementById('reqQty').value);
            const category = document.getElementById('itemCategory').value;
            const jcLinkEl = document.getElementById('jcLinkSelect');
            const jobCardId = jcLinkEl && jcLinkEl.value ? Number(jcLinkEl.value) : undefined;
            const reqSourceEl = document.querySelector('input[name="reqSource"]:checked');
            if (!reqSourceEl) {
                alert('Please choose where this request is purchased from: Local or Head Office.');
                return;
            }
            const requestSource = reqSourceEl.value;

            const newItem: any = { mrnNum, reqDate, vehicleMachinery, itemName, itemDesc, reqQty, category, requestSource };
            if (jobCardId) newItem.jobCardId = jobCardId;

            await syncService.enqueue(
                'CREATE_ITEM',
                '/api/items',
                'POST',
                newItem,
                (tempId) => {
                    const localItem = {
                        id: tempId,
                        mrnNum,
                        reqDate,
                        vehicleMachinery,
                        itemName,
                        name: itemName,
                        itemDesc,
                        reqQty,
                        category: category || '',
                        requestSource,
                        recQty: 0,
                        recDate: null,
                        purchaseSource: '',
                        receipts: []
                    };
                    allItems.unshift(localItem);
                    if (currentPage === 1) {
                        items.unshift(localItem);
                        if (items.length > pageSize) items.pop();
                    }
                    totalItems++;
                    renderCurrentView();
                }
            );

            addForm.reset();
            document.getElementById('reqDate').valueAsDate = new Date();
            closeAddModal();
        });

        // Receiving desk form submit listener
        const receivingDeskForm = document.getElementById('receivingDeskForm');
        receivingDeskForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('recDeskItemSelect').value;
            if (!itemId) {
                alert('Please select a valid Requisition MRN from the list.');
                return;
            }
            const rawQty = parseFloat(document.getElementById('recDeskQty').value);
            const newDate = document.getElementById('recDeskDate').value;
            const type = document.querySelector('input[name="recDeskTransactionType"]:checked').value;
            
            const checkedSourceEl = document.querySelector('input[name="recDeskPurchaseSource"]:checked');
            if (!checkedSourceEl) {
                alert('Please confirm the purchase source: Local Purchase or Head Office Purchase.');
                return;
            }
            const source = checkedSourceEl.value;

            const qty = type === 'Return' ? -Math.abs(rawQty) : Math.abs(rawQty);

            const receiptEntry = {
                qty,
                transactionType: type,
                deliveryDate: newDate,
                purchaseSource: source,
                grnNumber: '',
                invoiceNumber: '',
                invoiceDate: '',
                supplierName: '',
                unitPrice: null
            };

            await syncService.enqueue(
                'CREATE_RECEIPT',
                `/api/items/${itemId}/receipts`,
                'POST',
                receiptEntry,
                (tempRecId) => {
                    const item = allItems.find(i => String(i.id) === String(itemId));
                    if (item) {
                        item.receipts = item.receipts || [];
                        item.receipts.push({
                            id: tempRecId,
                            itemId,
                            ...receiptEntry
                        });
                        recalcItemReceipts(item);
                    }
                    const pageItem = items.find(i => String(i.id) === String(itemId));
                    if (pageItem) {
                        pageItem.receipts = pageItem.receipts || [];
                        pageItem.receipts.push({
                            id: tempRecId,
                            itemId,
                            ...receiptEntry
                        });
                        recalcItemReceipts(pageItem);
                    }
                    renderCurrentView();
                }
            );

            receivingDeskForm.reset();
            document.getElementById('recDeskDate').value = new Date().toISOString().split('T')[0];
            recDeskRequestedSource = null;
            updateRecDeskMismatchNote();

            // Redirect to MRN Tracker
            window.location.hash = '#tracker';
        });
        document.querySelectorAll('input[name="recDeskPurchaseSource"]').forEach(r =>
            r.addEventListener('change', updateRecDeskMismatchNote));

        // Pricing forms submissions
        const pricingAuditForm = document.getElementById('pricingAuditForm');
        pricingAuditForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('auditItemId').value;
            const receiptId = document.getElementById('auditReceiptId').value;
            
            const grnNumber = document.getElementById('aud_grnNumber').value.trim();
            const invoiceNumber = document.getElementById('aud_invoiceNumber').value.trim();
            const invoiceDate = document.getElementById('aud_invoiceDate').value;
            const supplierName = document.getElementById('aud_supplierName').value.trim();
            
            const unitPriceVal = parseFloat(document.getElementById('aud_unitPrice').value);
            const unitPrice = isNaN(unitPriceVal) ? null : unitPriceVal;

            const updateData = { grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice };

            await syncService.enqueue(
                'UPDATE_RECEIPT',
                `/api/receipts/${receiptId}`,
                'PUT',
                updateData,
                () => {
                    const item = allItems.find(i => String(i.id) === String(itemId));
                    if (item && item.receipts) {
                        const receipt = item.receipts.find(r => String(r.id) === String(receiptId));
                        if (receipt) {
                            Object.assign(receipt, updateData);
                            recalcItemReceipts(item);
                        }
                    }
                    const pageItem = items.find(i => String(i.id) === String(itemId));
                    if (pageItem && pageItem.receipts) {
                        const receipt = pageItem.receipts.find(r => String(r.id) === String(receiptId));
                        if (receipt) {
                            Object.assign(receipt, updateData);
                            recalcItemReceipts(pageItem);
                        }
                    }
                    renderCurrentView();
                }
            );

            closePricingAuditWorkspace();
        });

        const offcanvasPricingForm = document.getElementById('offcanvasPricingForm');
        offcanvasPricingForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('pricingOffcanvasMrn').dataset.itemId;
            const receiptIdx = document.getElementById('offcanvasDeliverySelect').value;
            if (receiptIdx === '') return;

            const item = allItems.find(i => String(i.id) === String(itemId));
            if (!item || !item.receipts[receiptIdx]) return;
            const receipt = item.receipts[receiptIdx];

            const grnNumber = document.getElementById('off_grnNumber').value.trim();
            const invoiceNumber = document.getElementById('off_invoiceNumber').value.trim();
            const invoiceDate = document.getElementById('off_invoiceDate').value;
            const supplierName = document.getElementById('off_supplierName').value.trim();
            
            const unitPriceVal = parseFloat(document.getElementById('off_unitPrice').value);
            const unitPrice = isNaN(unitPriceVal) ? null : unitPriceVal;

            const updateData = { grnNumber, invoiceNumber, invoiceDate, supplierName, unitPrice };

            await syncService.enqueue(
                'UPDATE_RECEIPT',
                `/api/receipts/${receipt.id}`,
                'PUT',
                updateData,
                () => {
                    Object.assign(receipt, updateData);
                    recalcItemReceipts(item);

                    const pageItem = items.find(i => String(i.id) === String(itemId));
                    if (pageItem && pageItem.receipts) {
                        const rec = pageItem.receipts.find(r => String(r.id) === String(receipt.id));
                        if (rec) {
                            Object.assign(rec, updateData);
                            recalcItemReceipts(pageItem);
                        }
                    }
                    renderCurrentView();
                    renderOffcanvasReceiptHistory(item);
                }
            );

            alert("Delivery price and GRN metrics updated locally!");
        });

        // Delete entire item requisition record
        async function deleteItem(itemId) {
            if (confirm('Are you sure you want to permanently delete this item and all its delivery records? This cannot be undone!')) {
                await syncService.enqueue(
                    'DELETE_ITEM',
                    `/api/items/${itemId}`,
                    'DELETE',
                    null,
                    () => {
                        allItems = allItems.filter(i => String(i.id) !== String(itemId));
                        items = items.filter(i => String(i.id) !== String(itemId));
                        totalItems--;
                        renderCurrentView();
                    }
                );
            }
        }

        // Delete delivery receipt record
        async function deleteReceipt(itemId, receiptId) {
            if (confirm("Delete this delivery record permanently?")) {
                await syncService.enqueue(
                    'DELETE_RECEIPT',
                    `/api/receipts/${receiptId}`,
                    'DELETE',
                    null,
                    () => {
                        const item = allItems.find(i => String(i.id) === String(itemId));
                        if (item && item.receipts) {
                            item.receipts = item.receipts.filter(r => String(r.id) !== String(receiptId));
                            recalcItemReceipts(item);
                        }
                        const pageItem = items.find(i => String(i.id) === String(itemId));
                        if (pageItem && pageItem.receipts) {
                            pageItem.receipts = pageItem.receipts.filter(r => String(r.id) !== String(receiptId));
                            recalcItemReceipts(pageItem);
                        }
                        
                        renderCurrentView();

                        const offcanvas = document.getElementById('pricingOffcanvas');
                        if (offcanvas && !offcanvas.classList.contains('translate-x-full') && item) {
                            renderOffcanvasReceiptHistory(item);
                            populateOffcanvasDeliverySelect(item);
                        }
                    }
                );
            }
        }

        // Clear pricing & supplier details from receipt record
        async function clearReceiptPricing(itemId, receiptId) {
            if (confirm("Delete pricing and supplier details from this receipt permanently?")) {
                const updateData = {
                    grnNumber: '',
                    invoiceNumber: '',
                    invoiceDate: '',
                    supplierName: '',
                    unitPrice: null
                };

                await syncService.enqueue(
                    'UPDATE_RECEIPT',
                    `/api/receipts/${receiptId}`,
                    'PUT',
                    updateData,
                    () => {
                        const item = allItems.find(i => String(i.id) === String(itemId));
                        if (item && item.receipts) {
                            const receipt = item.receipts.find(r => String(r.id) === String(receiptId));
                            if (receipt) {
                                Object.assign(receipt, updateData);
                                recalcItemReceipts(item);
                            }
                        }
                        const pageItem = items.find(i => String(i.id) === String(itemId));
                        if (pageItem && pageItem.receipts) {
                            const receipt = pageItem.receipts.find(r => String(r.id) === String(receiptId));
                            if (receipt) {
                                Object.assign(receipt, updateData);
                                recalcItemReceipts(pageItem);
                            }
                        }
                        
                        renderCurrentView();

                        const offcanvas = document.getElementById('pricingOffcanvas');
                        if (offcanvas && !offcanvas.classList.contains('translate-x-full') && item) {
                            renderOffcanvasReceiptHistory(item);
                            populateOffcanvasDeliverySelect(item);
                        }
                    }
                );
            }
        }

        // Recalculate local quantities from aggregated receipts
        function recalcItemReceipts(item) {
            if (!item.receipts || item.receipts.length === 0) {
                item.recQty = 0;
                item.recDate = null;
                item.purchaseSource = '';
                return;
            }
            item.recQty = item.receipts.reduce((sum, r) => sum + r.qty, 0);
            item.recQty = Math.round(item.recQty * 100) / 100;
            
            const sorted = [...item.receipts].filter(r => r.deliveryDate).sort((a, b) => new Date(b.deliveryDate).getTime() - new Date(a.deliveryDate).getTime());
            item.recDate = sorted.length > 0 ? sorted[0].deliveryDate : null;
            
            const uniqueSources = [...new Set(item.receipts.map(r => r.purchaseSource).filter(Boolean))];
            item.purchaseSource = uniqueSources.join(' & ');
        }

        function toggleSummarySection() {
            const section = document.getElementById('summarySection');
            const chevron = document.getElementById('summaryChevron');
            section.classList.toggle('open');
            chevron.classList.toggle('open');
        }

        // Daily Received Ledger Actions
        let ledgerShowAll = false;
        const expandedLedgerDates = new Set<string>();

        function toggleLedgerShowAll() {
            ledgerShowAll = !ledgerShowAll;
            const btnText = document.getElementById('ledgerShowMoreBtnText');
            const btnIcon = document.getElementById('ledgerShowMoreBtnIcon');
            if (btnText) btnText.textContent = ledgerShowAll ? 'Show Less' : 'Show All Days';
            if (btnIcon) {
                if (ledgerShowAll) btnIcon.classList.add('rotate-180');
                else btnIcon.classList.remove('rotate-180');
            }
            renderDailyReceivedLedger();
        }

        function toggleDailyLedgerRow(date) {
            const collapseEl = document.getElementById(`ledger-collapse-${date}`);
            const chevronEl = document.getElementById(`chevron-ledger-${date}`);
            if (!collapseEl || !chevronEl) return;
            
            const isOpen = !collapseEl.classList.contains('hidden');
            if (isOpen) {
                collapseEl.classList.add('hidden');
                chevronEl.classList.remove('rotate-180');
                expandedLedgerDates.delete(date);
            } else {
                collapseEl.classList.remove('hidden');
                chevronEl.classList.add('rotate-180');
                expandedLedgerDates.add(date);
            }
        }

        function renderDailyReceivedLedger() {
            const container = document.getElementById('dailyInflowLedgerContainer');
            const showMoreContainer = document.getElementById('ledgerShowMoreContainer');
            if (!container) return;

            const displayAll = cloneDeep(allItems);
            applyQueueMutations(displayAll);

            // Group receipts by date
            const dailyData: Record<string, any> = {};
            
            displayAll.forEach(item => {
                const receipts = item.receipts || [];
                receipts.forEach(r => {
                    if (r.qty > 0 && r.deliveryDateISO) {
                        const date = r.deliveryDateISO;
                        if (!dailyData[date]) {
                            dailyData[date] = {
                                date: date,
                                totalValue: 0,
                                hoValue: 0,
                                lpValue: 0,
                                otherValue: 0,
                                totalCount: 0,
                                unpricedCount: 0,
                                receipts: []
                            };
                        }
                        
                        const cost = (r.unitPrice || 0) * r.qty;
                        const isPriced = r.unitPrice !== null && r.unitPrice !== undefined && r.unitPrice > 0;
                        
                        dailyData[date].totalValue += cost;
                        dailyData[date].totalCount++;
                        if (!isPriced) {
                            dailyData[date].unpricedCount++;
                        }

                        const origin = originOfSource(r.purchaseSource);
                        // Downstream badges use 'localPurchase' for the local bucket.
                        const sourceCategory = origin === 'local' ? 'localPurchase' : origin;
                        if (origin === 'headOffice') {
                            dailyData[date].hoValue += cost;
                        } else if (origin === 'local') {
                            dailyData[date].lpValue += cost;
                        } else {
                            dailyData[date].otherValue += cost;
                        }

                        dailyData[date].receipts.push({
                            ...r,
                            itemName: item.name,
                            mrnNum: item.mrnNum,
                            vehicleMachinery: item.vehicleMachinery,
                            cost: cost,
                            isPriced: isPriced,
                            sourceCategory: sourceCategory
                        });
                    }
                });
            });

            // Sort dates descending
            const sortedDates = Object.keys(dailyData).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

            if (sortedDates.length === 0) {
                container.innerHTML = `
                    <div class="p-6 text-center text-xs font-semibold text-slate-400 dark:text-slate-655 italic">
                        No received deliveries recorded yet.
                    </div>
                `;
                if (showMoreContainer) showMoreContainer.classList.add('hidden');
                return;
            }

            const initialLimit = 5;
            const hasMore = sortedDates.length > initialLimit;
            if (showMoreContainer) {
                if (hasMore) showMoreContainer.classList.remove('hidden');
                else showMoreContainer.classList.add('hidden');
            }

            const datesToRender = ledgerShowAll ? sortedDates : sortedDates.slice(0, initialLimit);

            container.innerHTML = datesToRender.map(date => {
                const data = dailyData[date];
                const totalVal = data.totalValue;
                
                let hoPct = 0;
                let lpPct = 0;
                let othPct = 0;
                if (totalVal > 0) {
                    hoPct = Math.round((data.hoValue / totalVal) * 100);
                    lpPct = Math.round((data.lpValue / totalVal) * 100);
                    othPct = 100 - hoPct - lpPct;
                } else {
                    const hoCount = data.receipts.filter(r => r.sourceCategory === 'headOffice').length;
                    const lpCount = data.receipts.filter(r => r.sourceCategory === 'localPurchase').length;
                    const totalCount = data.receipts.length;
                    if (totalCount > 0) {
                        hoPct = Math.round((hoCount / totalCount) * 100);
                        lpPct = Math.round((lpCount / totalCount) * 100);
                        othPct = 100 - hoPct - lpPct;
                    }
                }

                const parts = date.split('-');
                let dayOfWeek = '---';
                let dayAndMonth = '---';
                if (parts.length === 3) {
                    const dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                    dayOfWeek = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
                    dayAndMonth = dt.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
                }

                const unpricedBadge = data.unpricedCount > 0 
                    ? `<span class="shrink-0 text-[10px] font-bold px-2 py-0.5 bg-amber-50 dark:bg-amber-950/20 text-amber-600 dark:text-amber-400 rounded-lg border border-amber-100 dark:border-amber-900/30 flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                        ${data.unpricedCount} unpriced
                       </span>`
                    : '';

                const itemsListHtml = data.receipts.map(r => {
                    const priceText = r.isPriced ? formatCurrency(r.unitPrice) : '<span class="text-amber-550 italic font-bold">Unpriced</span>';
                    const costText = r.isPriced ? formatCurrency(r.cost) : '<span class="text-amber-550 italic font-bold">Pending</span>';
                    const srcText = r.purchaseSource || '-';
                    const srcClass = r.sourceCategory === 'headOffice' 
                        ? 'text-indigo-650 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100/40 dark:border-indigo-900/30' 
                        : (r.sourceCategory === 'localPurchase'
                            ? 'text-emerald-600 dark:text-emerald-450 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100/40 dark:border-emerald-900/30'
                            : 'text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 border border-slate-200');
                    return `
                        <tr class="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition">
                            <td class="py-2.5 font-bold">
                                <div class="text-slate-800 dark:text-slate-200">${escapeHtml(r.mrnNum || '-')}</div>
                                <div class="text-[10px] text-slate-405 mt-0.5">${escapeHtml(r.vehicleMachinery || '-')}</div>
                            </td>
                            <td class="py-2.5 font-semibold">
                                <div class="text-slate-700 dark:text-slate-300 truncate max-w-[150px] sm:max-w-[250px]" title="${escapeHtml(r.itemName)}">${escapeHtml(r.itemName)}</div>
                            </td>
                            <td class="py-2.5">
                                <span class="px-1.5 py-0.5 text-[9px] uppercase font-extrabold rounded-md ${srcClass}">${srcText}</span>
                            </td>
                            <td class="py-2.5 text-slate-700 dark:text-slate-300 font-bold">${r.qty}</td>
                            <td class="py-2.5 text-slate-500 dark:text-slate-450">${priceText}</td>
                            <td class="py-2.5 text-right font-extrabold text-slate-900 dark:text-white">${costText}</td>
                        </tr>
                    `;
                }).join('');

                const isExpanded = expandedLedgerDates.has(date);
                const collapseClass = isExpanded ? '' : 'hidden';
                const chevronClass = isExpanded ? 'rotate-180' : '';

                return `
                    <div class="group border-b border-slate-100 dark:border-slate-800/50 last:border-b-0">
                        <div onclick="toggleDailyLedgerRow('${date}')" class="flex flex-col md:flex-row md:items-center justify-between p-4 cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-all duration-200 gap-4">
                            <div class="flex items-center gap-4">
                                <div class="p-2 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-655 dark:text-indigo-400 rounded-xl font-bold text-center min-w-[70px] border border-indigo-100/40 dark:border-indigo-900/30">
                                    <div class="text-[9px] uppercase tracking-wider text-indigo-500 dark:text-indigo-455">${dayOfWeek}</div>
                                    <div class="text-base font-black mt-0.5 leading-none">${dayAndMonth}</div>
                                </div>
                                <div>
                                    <div class="text-[9px] font-extrabold text-slate-400 dark:text-slate-550 uppercase tracking-wider">Total Received Value</div>
                                    <div class="text-base font-black text-slate-850 dark:text-white mt-0.5">${formatCurrency(totalVal)}</div>
                                </div>
                            </div>

                            <div class="flex-grow max-w-md md:mx-6">
                                <div class="w-full bg-slate-100 dark:bg-slate-800/80 rounded-full h-2 overflow-hidden flex">
                                    <div class="bg-indigo-650 dark:bg-indigo-400 h-full transition-all" style="width: ${hoPct}%" title="Head Office: ${hoPct}%"></div>
                                    <div class="bg-emerald-500 dark:bg-emerald-450 h-full transition-all" style="width: ${lpPct}%" title="Local Purchase: ${lpPct}%"></div>
                                    <div class="bg-slate-400 dark:bg-slate-600 h-full transition-all" style="width: ${othPct}%" title="Other: ${othPct}%"></div>
                                </div>
                                <div class="flex justify-between items-center mt-2 text-[10px] font-bold text-slate-455 dark:text-slate-500">
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-indigo-650 dark:bg-indigo-400"></span>
                                        <span>Head Office: <span class="text-slate-700 dark:text-slate-350">${formatCurrency(data.hoValue)}</span></span>
                                    </div>
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-450"></span>
                                        <span>Local Purchase: <span class="text-slate-700 dark:text-slate-350">${formatCurrency(data.lpValue)}</span></span>
                                    </div>
                                </div>
                            </div>

                            <div class="flex items-center justify-between md:justify-end gap-3 self-stretch md:self-auto">
                                <div class="flex items-center gap-2">
                                    ${unpricedBadge}
                                    <span class="text-xs font-bold px-2 py-0.5 bg-slate-150/40 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg border border-slate-200/50 dark:border-slate-700/50">
                                        ${data.totalCount} item${data.totalCount !== 1 ? 's' : ''}
                                    </span>
                                </div>
                                <svg id="chevron-ledger-${date}" class="w-4 h-4 text-slate-400 transform transition-transform duration-250 ${chevronClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"></path>
                                </svg>
                            </div>
                        </div>

                        <div id="ledger-collapse-${date}" class="${collapseClass} overflow-hidden border-t border-slate-100/60 dark:border-slate-800/40 bg-slate-50/40 dark:bg-slate-950/10 transition-all duration-300">
                            <div class="p-4 space-y-3">
                                <div class="text-[9px] font-extrabold text-slate-400 dark:text-slate-550 uppercase tracking-widest">Received Items Details</div>
                                <div class="overflow-x-auto">
                                    <table class="min-w-full text-xs">
                                        <thead>
                                            <tr class="text-[9px] font-bold text-slate-455 dark:text-slate-500 uppercase tracking-wider text-left border-b border-slate-150 dark:border-slate-800 pb-2">
                                                <th class="pb-2">MRN / Vehicle</th>
                                                <th class="pb-2">Item Name</th>
                                                <th class="pb-2">Source</th>
                                                <th class="pb-2">Qty</th>
                                                <th class="pb-2">Unit Price</th>
                                                <th class="pb-2 text-right">Total Cost</th>
                                            </tr>
                                        </thead>
                                        <tbody class="divide-y divide-slate-100 dark:divide-slate-800/60 font-semibold text-slate-655 dark:text-slate-350">
                                            ${itemsListHtml}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Auto-calculating Excel downloader
        function exportPremiumExcel() {
            if (allItems.length === 0) {
                alert("No data available to export!");
                return;
            }
            window.location.href = '/api/export/excel';
        }

        // JSON Backup Exporter
        function exportJSON() {
            if (allItems.length === 0) {
                alert("No data to export!");
                return;
            }
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allItems, null, 2));
            const link = document.createElement("a");
            link.setAttribute("href", dataStr);
            link.setAttribute("download", `tracker_backup_${new Date().toISOString().split('T')[0]}.json`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        // Base bulk JSON importer caller
        async function doImport(dataToImport) {
            try {
                const res = await fetch('/api/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(dataToImport)
                });
                if (!res.ok) throw new Error('Import failed');
                await loadAllData();
                alert('Database import completed successfully!');
            } catch (e) {
                console.error(e);
                alert('Database import failed.');
            }
        }

        function importJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const importedData = JSON.parse(e.target.result as string);
                    if (Array.isArray(importedData)) {
                        const isValid = importedData.every(i => (i.name || i.itemName) && i.reqQty !== undefined && i.reqDate !== undefined);
                        if (isValid) {
                            if (confirm(`Successfully read ${importedData.length} items. Do you want to overwrite database with this import?`)) {
                                doImport(importedData);
                            }
                        } else {
                            alert("Invalid JSON backup structure.");
                        }
                    } else {
                        alert("Invalid backup file format. Must contain a JSON array of items.");
                    }
                } catch (error) {
                    alert("Error parsing file contents. Ensure file is a valid JSON backup.");
                }
                event.target.value = ''; // Reset file input
            };
            reader.readAsText(file);
        }

        function importCSV(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const text = e.target.result;
                    const parsedItems = parseCSV(text);
                    if (parsedItems.length > 0) {
                        if (confirm(`Successfully parsed ${parsedItems.length} items from CSV. Import them into database?`)) {
                            doImport(parsedItems);
                        }
                    } else {
                        alert("No valid items parsed from the uploaded CSV.");
                    }
                } catch (error) {
                    console.error("CSV Import Error:", error);
                    alert("Error parsing CSV. Verify correct column headers like 'Item Name' and 'Requested Qty'.");
                }
                event.target.value = '';
            };
            reader.readAsText(file);
        }

        function parseCSV(text) {
            const lines = [];
            let currentLine = [];
            let currentCell = '';
            let inQuotes = false;
            
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                const nextChar = text[i+1];
                
                if (char === '"') {
                    if (inQuotes && nextChar === '"') {
                        currentCell += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (char === ',' && !inQuotes) {
                    currentLine.push(currentCell.trim());
                    currentCell = '';
                } else if (char === '\n' && !inQuotes) {
                    currentLine.push(currentCell.trim());
                    lines.push(currentLine);
                    currentLine = [];
                    currentCell = '';
                } else if (char === '\r' && !inQuotes) {
                    // Ignore CR outside quotes
                } else {
                    currentCell += char;
                }
            }
            
            if (currentCell !== '' || currentLine.length > 0) {
                currentLine.push(currentCell.trim());
                lines.push(currentLine);
            }
            
            const newItems = [];
            if (lines.length > 1) {
                const headers = lines[0].map(h => h.toLowerCase().replace(/['"]/g, ''));
                
                const idxMrn = headers.findIndex(h => h.includes("mrn"));
                const idxReqDate = headers.findIndex(h => h.includes("request date") || h.includes("req date"));
                const idxVehicle = headers.findIndex(h => h.includes("vehicle") || h.includes("machinery"));
                const idxName = headers.findIndex(h => h.includes("item name"));
                const idxDesc = headers.findIndex(h => h.includes("description"));
                const idxReqQty = headers.findIndex(h => h.includes("requested qty") || h.includes("req qty"));
                const idxRecQty = headers.findIndex(h => h.includes("received qty") || h.includes("rec qty"));
                const idxRecDate = headers.findIndex(h => h.includes("receive date") || h.includes("rec date"));
                const idxSource = headers.findIndex(h => h.includes("source") || h.includes("purchase"));
                const idxGRN = headers.findIndex(h => h.includes("grn"));
                const idxInvNum = headers.findIndex(h => h.includes("invoice number") || h.includes("inv num") || h.includes("invoice no"));
                const idxInvDate = headers.findIndex(h => h.includes("invoice date") || h.includes("inv date"));
                const idxSupplier = headers.findIndex(h => h.includes("supplier"));
                const idxUnitPrice = headers.findIndex(h => h.includes("unit price"));
                
                if (idxName === -1 || idxReqQty === -1) {
                    throw new Error("Missing required columns");
                }
                
                for (let i = 1; i < lines.length; i++) {
                    const row = lines[i];
                    if (row.length < 2 && row.join('').trim() === '') continue;
                    
                    const reqQtyStr = row[idxReqQty] ? row[idxReqQty].replace(/['"]/g, '') : '';
                    const reqQtyVal = parseFloat(reqQtyStr);
                    if (isNaN(reqQtyVal)) continue;
                    
                    const recQtyVal = idxRecQty !== -1 && row[idxRecQty] ? parseFloat(row[idxRecQty].replace(/['"]/g, '')) || 0 : 0;
                    const recDateVal = idxRecDate !== -1 && row[idxRecDate] ? (row[idxRecDate].replace(/['"]/g, '') || null) : null;
                    const sourceVal = canonicalSourceText(idxSource !== -1 && row[idxSource] ? row[idxSource].replace(/['"]/g, '') : '');

                    const grnVal = idxGRN !== -1 && row[idxGRN] ? row[idxGRN].replace(/['"]/g, '').trim() : '';
                    const invNumVal = idxInvNum !== -1 && row[idxInvNum] ? row[idxInvNum].replace(/['"]/g, '').trim() : '';
                    const invDateVal = idxInvDate !== -1 && row[idxInvDate] ? row[idxInvDate].replace(/['"]/g, '').trim() : '';
                    const supplierVal = idxSupplier !== -1 && row[idxSupplier] ? row[idxSupplier].replace(/['"]/g, '').trim() : '';
                    const unitPriceStr = idxUnitPrice !== -1 && row[idxUnitPrice] ? row[idxUnitPrice].replace(/['"]/g, '').trim() : '';
                    const unitPriceVal = unitPriceStr ? parseFloat(unitPriceStr) : null;

                    const newItem = {
                        mrnNum: idxMrn !== -1 && row[idxMrn] ? row[idxMrn].replace(/['"]/g, '') : '',
                        reqDate: idxReqDate !== -1 && row[idxReqDate] ? row[idxReqDate].replace(/['"]/g, '') : '',
                        vehicleMachinery: idxVehicle !== -1 && row[idxVehicle] ? row[idxVehicle].replace(/['"]/g, '') : '',
                        itemName: row[idxName] ? row[idxName].replace(/['"]/g, '') : '',
                        itemDesc: idxDesc !== -1 && row[idxDesc] ? row[idxDesc].replace(/['"]/g, '') : '',
                        reqQty: reqQtyVal,
                        recQty: recQtyVal,
                        recDate: recDateVal,
                        purchaseSource: sourceVal,
                        receipts: []
                    };
                    
                    if (newItem.recQty > 0) {
                        const receipt: any = {
                            qty: newItem.recQty,
                            transactionType: 'Receive',
                            deliveryDate: newItem.recDate,
                            purchaseSource: newItem.purchaseSource || ''
                        };
                        if (grnVal) receipt.grnNumber = grnVal;
                        if (invNumVal) receipt.invoiceNumber = invNumVal;
                        if (invDateVal) receipt.invoiceDate = invDateVal;
                        if (supplierVal) receipt.supplierName = supplierVal;
                        if (unitPriceVal !== null && !isNaN(unitPriceVal)) receipt.unitPrice = unitPriceVal;

                        newItem.receipts.push(receipt);
                    }

                    newItems.push(newItem);
                }
            }
            return newItems;
        }



        function handleReceivingDeskPdfUpload(e) {
            const file = e.target.files[0];
            const label = document.getElementById('receivingPdfFilename');
            if (file) {
                if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
                    alert("Only PDF files are supported!");
                    return;
                }
                if (label) label.textContent = `Selected: ${file.name}`;
                
                // Perform quick pre-fill scan
                processReceivingDeskPdfAutoFill(file);
            }
        }

        async function processReceivingDeskPdfAutoFill(file) {
            try {
                const base64Str = await readPdfAsBase64(file);
                const res = await fetch('/api/import/pdf', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pdfBase64: base64Str })
                });

                if (!res.ok) throw new Error('PDF scanning failure');
                const result = await res.json();
                
                if (result.success && result.data) {
                    const d = result.data;
                    if (d.reqQty) document.getElementById('recDeskQty').value = d.reqQty;
                    if (d.reqDate) document.getElementById('recDeskDate').value = d.reqDate;
                    
                    // Pre-fill vendor info if pricing tab is visible
                    alert("Material invoice PDF scanned successfully! Quantities and dates have been pre-filled.");
                }
            } catch (err) {
                console.error("Receiving auto-fill PDF error:", err);
            }
        }



        function readPdfAsBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = (reader.result as string).split(',')[1];
                    resolve(base64);
                };
                reader.onerror = error => reject(error);
                reader.readAsDataURL(file);
            });
        }

        // Debounce helper
        function debounce(func, wait) {
            return function(...args) {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        }

        // Event Listeners for debounced search
        if (searchInput) {
            searchInput.addEventListener('input', debounce((e) => {
                searchQuery = e.target.value.trim();
                currentPage = 1;
                fetchTrackerPage();
            }, 300));
        }

        // Issue create/edit form submission (direct server write — new feature, no offline queue)
        const issueDeskForm = document.getElementById('issueDeskForm');
        if (issueDeskForm) {
            issueDeskForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const id = document.getElementById('issueDeskId').value;
                const itemId = document.getElementById('issueDeskItemSelect').value;
                const qtyVal = parseFloat(document.getElementById('issueDeskQty').value) || 0;
                const priceRaw = document.getElementById('issueDeskUnitPrice').value;
                const unitPrice = String(priceRaw).trim() === '' ? null : (parseFloat(priceRaw) || 0);

                if (itemId) {
                    const item = allItems.find(i => String(i.id) === String(itemId));
                    if (item) {
                        if (!item.recQty || item.recQty <= 0) {
                            alert("Error: Only received items can be issued. No delivery has been received for this request.");
                            return;
                        }

                        // Other issues of this item (excluding the one being edited)
                        const otherIssuedQty = issuedQtyForItem(item, id || null);
                        const remainingToIssue = Math.round((item.recQty - otherIssuedQty) * 100) / 100;
                        if (qtyVal > remainingToIssue) {
                            alert(`Error: Cannot issue ${qtyVal} units. Remaining received stock for this request in store is only ${remainingToIssue} units.`);
                            return;
                        }
                    }
                }

                const payload = {
                    issueDate: document.getElementById('issueDeskDate').value,
                    vehicleMachinery: document.getElementById('issueDeskVehicle').value.trim(),
                    itemName: document.getElementById('issueDeskItemName').value.trim(),
                    itemDesc: document.getElementById('issueDeskItemDesc').value.trim(),
                    category: document.getElementById('issueDeskCategory').value,
                    qty: qtyVal,
                    mrnNum: document.getElementById('issueDeskMrn').value.trim(),
                    issuedTo: document.getElementById('issueDeskIssuedTo').value.trim(),
                    issuedBy: document.getElementById('issueDeskIssuedBy').value.trim(),
                    notes: document.getElementById('issueDeskNotes').value.trim(),
                    unitPrice,
                    // Hard link to the request line being drawn from — the server
                    // validates stock against it and it survives item renames.
                    itemId: itemId ? Number(itemId) : null
                };
                try {
                    const res = await fetch(id ? ('/api/issues/' + id) : '/api/issues', {
                        method: id ? 'PUT' : 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) {
                        let msg = 'Failed to save issue. Please try again.';
                        try { const errBody = await res.json(); if (errBody && errBody.error) msg = errBody.error; } catch (_) {}
                        alert(msg);
                        return;
                    }
                    window.location.hash = '#issued';
                    await loadIssues();
                    refreshIssueBadge();
                } catch (err) { alert('Failed to save issue. Please try again.'); }
            });
        }

        // Initial setup calls
        initTheme();
        initSidebarState();
        initCharts();
        loadAllData();
        loadCategories();
        loadVehicles();
        refreshIssueBadge();

        // Auto-refresh logic for multi-user / network environment
        setInterval(async () => {
            const addModal = document.getElementById('addModal');
            const editModal = document.getElementById('editRequestModal');
            const pricingOffcanvas = document.getElementById('pricingOffcanvas');
            
            const isEditing = 
                (addModal && !addModal.classList.contains('hidden')) ||
                (editModal && !editModal.classList.contains('hidden')) ||
                (currentView === 'issue-desk') ||
                (pricingOffcanvas && !pricingOffcanvas.classList.contains('translate-x-full'));
                
            const hasFocus = document.activeElement && 
                (document.activeElement.tagName === 'INPUT' || 
                 document.activeElement.tagName === 'SELECT' || 
                 document.activeElement.tagName === 'TEXTAREA');

            if (!document.hidden && !isEditing && !hasFocus) {
                if (syncService && syncService.queue.length > 0) {
                    if (!syncService.isProcessing) {
                        // Reset retries if they exceeded limit to allow auto-recovery
                        const hasError = syncService.queue.some(q => q.retries > 5);
                        if (hasError) {
                            syncService.queue.forEach(q => { if (q.retries > 5) q.retries = 5; });
                            syncService.saveQueue();
                        }
                        await syncService.processQueue();
                    }
                } else {
                    // Cheap change check first: only re-download the dataset when
                    // the server-side change signature actually moved.
                    try {
                        const sum = await (await fetch('/api/summary')).json();
                        // The bell badge rides on this one poll (unread is folded
                        // into /api/summary) so the notifications list can poll
                        // far less often (review finding 13: merge the two polls).
                        if (sum && typeof sum.unread !== 'undefined') {
                            const badge = document.getElementById('notifBadge');
                            if (badge) { badge.textContent = sum.unread; badge.classList.toggle('hidden', !sum.unread); }
                        }
                        if (sum && sum.version !== lastDataVersion) {
                            lastDataVersion = sum.version;
                            await loadAllData();
                        }
                    } catch (e) {
                        await loadAllData(); // fall back to the old behaviour if /api/summary fails
                    }
                }
            }
        }, 15000); // Poll every 15 seconds

        // ---- Battery Registry UI and API
        async function fetchBatteries() {
            try {
                const search = document.getElementById('batSearchInput').value.trim();
                const condition = document.getElementById('batConditionFilter').value;
                const state = document.getElementById('batStateFilter').value;
                
                const url = `/api/batteries?search=${encodeURIComponent(search)}&condition=${condition}&state=${state}`;
                const res = await fetch(url);
                if (res.ok) {
                    batteries = await res.json();
                }
            } catch (err) {
                console.error("Failed to fetch batteries:", err);
            }
        }

        async function handleBatteryFilterChange() {
            await fetchBatteries();
            renderBatteriesView();
        }

        async function updateBatteryKPIs() {
            try {
                const res = await fetch('/api/battery-stats');
                if (res.ok) {
                    const stats = await res.json();
                    document.getElementById('batKpiTotal').textContent = stats.total;
                    document.getElementById('batKpiNew').textContent = stats.newInStore;
                    document.getElementById('batKpiOld').textContent = stats.oldInStore;
                    document.getElementById('batKpiExpired').textContent = stats.expired;
                    document.getElementById('batKpiInstalled').textContent = stats.installed;

                    // Update badge in sidebar
                    const badge = document.getElementById('count-batteries');
                    if (badge) badge.textContent = stats.newInStore + stats.oldInStore;
                }
            } catch (err) {
                console.error("Failed to update battery KPIs:", err);
            }
        }

        function renderBatteriesView() {
            const tbody = document.getElementById('batteriesTableBody');
            const emptyState = document.getElementById('batteriesEmptyState');
            if (!tbody) return;

            tbody.innerHTML = '';
            updateBatteryKPIs();

            if (batteries.length === 0) {
                if (emptyState) emptyState.classList.remove('hidden');
                return;
            }

            if (emptyState) emptyState.classList.add('hidden');

            batteries.forEach(b => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 dark:hover:bg-slate-800/45 transition cursor-pointer";
                tr.onclick = (e) => {
                    if ((e.target as any).closest('button') || (e.target as any).closest('a')) return;
                    openBatteryOffcanvas(b.id);
                };

                let conditionBadge = '';
                if (b.condition === 'New') {
                    conditionBadge = `<span class="px-2.5 py-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-455 border border-emerald-100/50 dark:border-emerald-900/30 rounded-full text-[10px] font-bold">New</span>`;
                } else if (b.condition === 'Old') {
                    conditionBadge = `<span class="px-2.5 py-1 bg-amber-50 text-amber-700 dark:bg-amber-955/40 dark:text-amber-400 border border-amber-100/50 dark:border-amber-900/30 rounded-full text-[10px] font-bold">Old</span>`;
                } else if (b.condition === 'Expired' || b.isExpired) {
                    conditionBadge = `<span class="px-2.5 py-1 bg-rose-50 text-rose-700 dark:bg-rose-955/40 dark:text-rose-455 border border-rose-100/50 dark:border-rose-900/30 rounded-full text-[10px] font-bold">Expired</span>`;
                }

                let stateBadge = '';
                if (b.state === 'In Store') {
                    stateBadge = `<span class="px-2.5 py-1 bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400 border border-teal-100/50 dark:border-teal-900/30 rounded-full text-[10px] font-bold">In Store</span>`;
                } else if (b.state === 'Installed') {
                    stateBadge = `<span class="px-2.5 py-1 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 border border-indigo-100/50 dark:border-indigo-900/30 rounded-full text-[10px] font-bold">Installed</span>`;
                } else if (b.state === 'Disposed') {
                    stateBadge = `<span class="px-2.5 py-1 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded-full text-[10px] font-bold">Disposed</span>`;
                }

                const locationVal = b.state === 'Installed' ? 
                    `<span class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></span>${escapeHtml(b.currentVehicle)}</span>` : 
                    (b.state === 'Disposed' ? '<span class="text-rose-500 dark:text-rose-400 font-bold">Disposed</span>' : '<span class="text-slate-400 dark:text-slate-500 italic">Store Stock</span>');

                tr.innerHTML = `
                    <td class="px-6 py-4 text-sm font-extrabold text-indigo-650 dark:text-indigo-400 whitespace-nowrap font-mono">${escapeHtml(b.serialNumber)}</td>
                    <td class="px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">${escapeHtml((b.brand ? b.brand + ' ' : '') + (b.itemName || ''))}</td>
                    <td class="px-6 py-4 text-sm whitespace-nowrap">${conditionBadge}</td>
                    <td class="px-6 py-4 text-sm whitespace-nowrap">${stateBadge} <span class="text-xs text-slate-400 dark:text-slate-500 ml-1">(${locationVal})</span></td>
                    <td class="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title="${escapeHtml(b.notes || '')}">${b.notes ? escapeHtml(b.notes) : '<span class="text-slate-350 dark:text-slate-600">-</span>'}</td>
                    <td class="px-6 py-4 text-sm text-right whitespace-nowrap flex justify-end gap-1">
                        <a href="#battery-move/${b.id}" class="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded-lg transition" title="Log Movement">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                        </a>
                        <a href="#battery-entry/${b.id}" class="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-lg transition" title="Edit battery details">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                        </a>
                        <button onclick="deleteBatteryRecord(${b.id})" class="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition" title="Delete record">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        // Inline View Handlers
        function handleEntryStateChange() {
            const state = document.getElementById('entryBatState').value;
            const container = document.getElementById('entryBatVehicleContainer');
            const vInput = document.getElementById('entryBatVehicle');
            if (state === 'Installed') {
                container.classList.remove('hidden');
                vInput.required = true;
            } else {
                container.classList.add('hidden');
                vInput.required = false;
                vInput.value = '';
            }
        }

        async function setupBatteryEntry(batteryId = null) {
            const form = document.getElementById('batteryEntryForm');
            if (!form) return;
            form.reset();
            document.getElementById('entryBatId').value = '';
            document.getElementById('entryBatPurchaseDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('entryBatExpiryDate').value = '';
            document.getElementById('batteryEntryTitle').textContent = 'Register Battery';

            if (batteryId) {
                try {
                    const res = await fetch(`/api/batteries/${batteryId}`);
                    if (res.ok) {
                        const battery = await res.json();
                        document.getElementById('entryBatId').value = battery.id;
                        document.getElementById('entryBatSerial').value = battery.serialNumber;
                        document.getElementById('entryBatName').value = battery.itemName || '';
                        document.getElementById('entryBatBrand').value = battery.brand || '';
                        document.getElementById('entryBatDesc').value = battery.itemDesc || '';
                        document.getElementById('entryBatCondition').value = battery.condition || 'New';
                        document.getElementById('entryBatState').value = battery.state || 'In Store';
                        document.getElementById('entryBatVehicle').value = battery.currentVehicle || '';
                        document.getElementById('entryBatPurchaseDate').value = battery.purchaseDateISO || '';
                        document.getElementById('entryBatExpiryDate').value = battery.expiryDateISO || '';
                        document.getElementById('entryBatNotes').value = battery.notes || '';
                        document.getElementById('batteryEntryTitle').textContent = 'Edit Battery Details';
                    }
                } catch (err) {
                    console.error("Failed to load battery for edit:", err);
                }
            }
            handleEntryStateChange();
        }

        async function setupBatteryMove(selectedBatteryId = null) {
            const form = document.getElementById('batteryMoveForm');
            if (!form) return;
            form.reset();
            document.getElementById('moveBatDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('moveBatSwapToggle').checked = false;
            handleSwapToggle(false);

            const select = document.getElementById('moveBatSelect');
            select.innerHTML = '<option value="">-- Choose Battery --</option>';

            try {
                const res = await fetch('/api/batteries');
                if (res.ok) {
                    batteries = await res.json();
                    batteries.forEach(b => {
                        const opt = document.createElement('option');
                        opt.value = String(b.id);
                        opt.textContent = `${b.serialNumber} (${b.brand ? b.brand + ' ' : ''}${b.itemName || 'Battery'}) - State: ${b.state}`;
                        if (selectedBatteryId && String(b.id) === String(selectedBatteryId)) {
                            opt.selected = true;
                        }
                        select.appendChild(opt);
                    });
                }
            } catch (err) {
                console.error("Failed to load batteries for movement:", err);
            }

            handleMoveBatterySelectChange();
        }

        function handleMoveBatterySelectChange() {
            const batteryId = document.getElementById('moveBatSelect').value;
            const battery = batteries.find(b => String(b.id) === String(batteryId));
            const moveTypeSelect = document.getElementById('moveBatType');

            if (!battery) return;

            if (battery.state === 'Installed') {
                moveTypeSelect.value = 'Return';
            } else {
                moveTypeSelect.value = 'Issue';
            }
            handleMoveTypeChange();
        }

        function handleMoveTypeChange() {
            const moveType = document.getElementById('moveBatType').value;
            const vehicleContainer = document.getElementById('moveBatVehicleContainer');
            const vehicleInput = document.getElementById('moveBatToVehicle');
            const swapContainer = document.getElementById('moveBatSwapContainer');

            // Vehicle input is required only for Issue / Transfer
            if (moveType === 'Issue' || moveType === 'Transfer') {
                vehicleContainer.classList.remove('hidden');
                vehicleInput.required = true;
            } else {
                vehicleContainer.classList.add('hidden');
                vehicleInput.required = false;
                vehicleInput.value = '';
            }

            // Swap is only relevant when issuing a battery from Store
            const batteryId = document.getElementById('moveBatSelect').value;
            const battery = batteries.find(b => String(b.id) === String(batteryId));
            const isFromStore = battery && battery.state === 'In Store';

            if (moveType === 'Issue' && isFromStore) {
                swapContainer.classList.remove('hidden');
            } else {
                swapContainer.classList.add('hidden');
                document.getElementById('moveBatSwapToggle').checked = false;
                handleSwapToggle(false);
            }
        }

        function handleSwapToggle(isChecked) {
            const swapInputs = document.getElementById('moveBatSwapInputs');
            const oldSerial = document.getElementById('moveBatOldSerial');
            if (isChecked) {
                swapInputs.classList.remove('hidden');
                oldSerial.required = true;
            } else {
                swapInputs.classList.add('hidden');
                oldSerial.required = false;
                oldSerial.value = '';
                document.getElementById('moveBatOldName').value = '';
                document.getElementById('moveBatOldBrand').value = '';
                document.getElementById('moveBatOldNotes').value = '';
            }
        }

        // Modals Management (Placeholders for backwards compatibility)
        function openRegisterBatteryModal() { window.location.hash = '#battery-entry'; }
        function closeRegisterBatteryModal() { window.location.hash = '#batteries'; }
        function openLogBatteryMovementModal(selectedBatteryId = null) { window.location.hash = selectedBatteryId ? `#battery-move/${selectedBatteryId}` : '#battery-move'; }
        function closeLogBatteryMovementModal() { window.location.hash = '#batteries'; }

        // Details drawer/offcanvas
        async function openBatteryOffcanvas(batteryId) {
            try {
                const res = await fetch(`/api/batteries/${batteryId}`);
                if (!res.ok) throw new Error();
                const battery = await res.json();

                document.getElementById('batteryOffcanvasSerial').textContent = battery.serialNumber;
                document.getElementById('batteryOffcanvasSerial').dataset.batteryId = battery.id;
                document.getElementById('batteryOffcanvasSpecs').textContent = (battery.brand ? battery.brand + ' ' : '') + (battery.itemName || 'No Specifications');
                document.getElementById('batteryOffcanvasLocation').textContent = battery.state === 'Installed' ? battery.currentVehicle : battery.state;
                document.getElementById('batteryOffcanvasStatus').textContent = battery.condition;
                document.getElementById('batteryOffcanvasRegistered').textContent = battery.createdAt ? battery.createdAt.split('T')[0] : '';
                document.getElementById('batteryOffcanvasNotes').textContent = battery.notes || 'None';

                // Populate separate columns if present
                const ob = document.getElementById('batteryOffcanvasBrand');
                if (ob) ob.textContent = battery.brand || '-';
                const oc = document.getElementById('batteryOffcanvasCondition');
                if (oc) oc.textContent = battery.condition;
                const os = document.getElementById('batteryOffcanvasState');
                if (os) os.textContent = battery.state + (battery.state === 'Installed' ? ` (${battery.currentVehicle})` : '');
                const op = document.getElementById('batteryOffcanvasPurchaseDate');
                if (op) op.textContent = battery.purchaseDate || '-';
                const oe = document.getElementById('batteryOffcanvasExpiryDate');
                if (oe) oe.textContent = battery.expiryDate || '-';

                const dot = document.getElementById('batteryOffcanvasStatusDot');
                dot.className = "w-3 h-3 rounded-full";
                if (battery.condition === 'New') dot.classList.add('bg-emerald-500');
                else if (battery.condition === 'Old') dot.classList.add('bg-amber-500');
                else if (battery.condition === 'Expired' || battery.isExpired) dot.classList.add('bg-rose-500');
                else dot.classList.add('bg-indigo-500');

                const pathList = document.getElementById('batteryOffcanvasPathList');
                pathList.innerHTML = '';

                const movements = battery.movements || [];
                if (movements.length === 0) {
                    pathList.innerHTML = '<p class="text-xs text-slate-400 italic">No movement logs recorded.</p>';
                } else {
                    const chronologicalMovements = [...movements].reverse();
                    chronologicalMovements.forEach((m, idx) => {
                        const div = document.createElement('div');
                        div.className = "relative pl-2";
                        
                        let dotColor = "bg-indigo-500";
                        if (m.conditionAfter === 'Old') dotColor = "bg-amber-500";
                        else if (m.conditionAfter === 'Expired') dotColor = "bg-rose-500";
                        else if (m.conditionAfter === 'New') dotColor = "bg-emerald-500";

                        div.innerHTML = `
                            <span class="absolute -left-[31px] top-[4px] w-4.5 h-4.5 rounded-full ${dotColor} border-4 border-white dark:border-slate-900 flex items-center justify-center text-[7px] text-white font-extrabold z-10 shadow-sm">${idx + 1}</span>
                            <div class="bg-slate-50 dark:bg-slate-950/40 border border-slate-150 dark:border-slate-850/60 p-3.5 rounded-2xl">
                                <div class="flex justify-between items-center text-xs text-slate-400 dark:text-slate-500 font-extrabold">
                                    <span>${m.movementDate}</span>
                                    <div class="flex gap-1">
                                        <span class="text-[10px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md text-slate-655 dark:text-slate-350 border border-slate-200/50 dark:border-slate-700/50 font-bold">${escapeHtml(m.movementType)}</span>
                                        <span class="text-[10px] bg-slate-150 dark:bg-slate-800 px-2 py-0.5 rounded-md text-slate-600 dark:text-slate-400 border border-slate-200/50 dark:border-slate-700/50">${m.conditionAfter}</span>
                                    </div>
                                </div>
                                <div class="text-sm font-bold text-slate-700 dark:text-slate-200 mt-1.5 flex items-center gap-1.5 flex-wrap">
                                    <span class="text-indigo-650 dark:text-indigo-400 font-extrabold">${escapeHtml(m.fromLocation || 'Store')}</span>
                                    <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                                    <span class="text-emerald-655 dark:text-emerald-400 font-extrabold">${escapeHtml(m.toLocation || 'Store')}</span>
                                </div>
                                ${m.notes ? `<p class="text-xs text-slate-500 dark:text-slate-400 mt-2 italic font-medium leading-relaxed bg-white dark:bg-slate-900/60 p-2 rounded-xl border border-slate-100 dark:border-slate-850/40">${escapeHtml(m.notes)}</p>` : ''}
                            </div>
                        `;
                        pathList.appendChild(div);
                    });
                }

                document.getElementById('batteryOffcanvas').classList.remove('translate-x-full');
            } catch (err) {
                alert('Failed to load battery details.');
            }
        }

        function closeBatteryOffcanvas() {
            document.getElementById('batteryOffcanvas').classList.add('translate-x-full');
        }

        function openMoveFromOffcanvas() {
            const batteryId = document.getElementById('batteryOffcanvasSerial').dataset.batteryId;
            closeBatteryOffcanvas();
            window.location.hash = `#battery-move/${batteryId}`;
        }

        async function deleteBatteryRecord(id) {
            if (!confirm('Delete this battery record permanently?')) return;
            try {
                const res = await fetch(`/api/batteries/${id}`, {
                    method: 'DELETE'
                });
                const r = await res.json();
                if (!res.ok) throw new Error(r.error || 'Deletion failed');
                await fetchBatteries();
                renderBatteriesView();
                updateSidebarBadges();
            } catch (err) {
                alert(err.message || 'Failed to delete record.');
            }
        }

        // ---- Material Transfers UI and API ----
        async function fetchTransfers() {
            try {
                const search = document.getElementById('transSearchInput').value.trim();
                const from = document.getElementById('transFromFilter').value.trim();
                const to = document.getElementById('transToFilter').value.trim();
                
                const url = `/api/transfers?search=${encodeURIComponent(search)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
                const res = await fetch(url);
                if (res.ok) {
                    transfers = await res.json();
                }
            } catch (err) {
                console.error("Failed to fetch transfers:", err);
            }
        }

        async function handleTransferFilterChange() {
            await fetchTransfers();
            renderTransfersTable();
        }

        async function updateTransferKPIs() {
            try {
                const res = await fetch('/api/transfer-stats');
                if (res.ok) {
                    const stats = await res.json();
                    document.getElementById('kpi-transfer-total').textContent = stats.total || 0;
                    document.getElementById('kpi-transfer-qty').textContent = stats.totalQty || 0;
                    document.getElementById('kpi-transfer-month').textContent = stats.thisMonth || 0;

                    // Calculate active categories count
                    const cats = [...new Set(transfers.map(t => t.category).filter(Boolean))];
                    document.getElementById('kpi-transfer-categories').textContent = cats.length;
                }
            } catch (err) {
                console.error("Failed to update transfer KPIs:", err);
            }
        }

        function renderTransfersView() {
            const tbody = document.getElementById('transfersTableBody');
            const emptyState = document.getElementById('transfersEmptyState');
            if (!tbody) return;

            tbody.innerHTML = '';
            updateTransferKPIs();
            updateSidebarBadges();

            if (transfers.length === 0) {
                if (emptyState) emptyState.classList.remove('hidden');
                return;
            }

            if (emptyState) emptyState.classList.add('hidden');

            transfers.forEach(t => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 dark:hover:bg-slate-800/45 transition cursor-pointer";
                tr.onclick = (e) => {
                    if ((e.target as any).closest('button') || (e.target as any).closest('a')) return;
                    openTransferOffcanvas(t.id);
                };

                const catBadge = `<span class="px-2.5 py-1 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 border border-indigo-100/50 dark:border-indigo-900/30 rounded-full text-[10px] font-bold">${escapeHtml(t.category || 'General Items')}</span>`;

                tr.innerHTML = `
                    <td class="px-6 py-4 text-sm font-extrabold text-indigo-650 dark:text-indigo-400 whitespace-nowrap font-mono">${escapeHtml(t.mtnNum)}</td>
                    <td class="px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-350 whitespace-nowrap">${escapeHtml(t.transferDate || '')}</td>
                    <td class="px-6 py-4 text-sm whitespace-nowrap">${catBadge}</td>
                    <td class="px-6 py-4 text-sm font-bold text-slate-800 dark:text-slate-200" title="${escapeHtml(t.itemDesc || '')}">${escapeHtml(t.itemName)}</td>
                    <td class="px-6 py-4 text-sm font-extrabold text-slate-800 dark:text-slate-200 whitespace-nowrap">${t.qty || 0}</td>
                    <td class="px-6 py-4 text-sm font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">${escapeHtml(t.fromLocation)}</td>
                    <td class="px-6 py-4 text-sm font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">${escapeHtml(t.toLocation)}</td>
                    <td class="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap">${escapeHtml(t.transferredBy)}</td>
                    <td class="px-6 py-4 text-sm text-right whitespace-nowrap flex justify-end gap-1">
                        <a href="#transfer-entry/${t.id}" class="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-lg transition" title="Edit transfer details">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                        </a>
                        <button onclick="deleteTransferRecord(${t.id})" class="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition" title="Delete record">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function renderTransfersTable() {
            renderTransfersView();
        }

        async function setupTransferEntry(transferId = null) {
            const form = document.getElementById('transferEntryForm');
            if (!form) return;
            form.reset();
            document.getElementById('entryTransferId').value = '';
            document.getElementById('entryTransferDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('transferEntryTitle').textContent = 'Log Material Transfer';

            // Populate category select dropdown
            const catSelect = document.getElementById('entryTransferCategory');
            if (catSelect) {
                catSelect.innerHTML = '<option value="">-- Auto-Classify Category --</option>';
                allCategories.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    catSelect.appendChild(opt);
                });
            }

            if (transferId) {
                try {
                    const res = await fetch(`/api/transfers/${transferId}`);
                    if (res.ok) {
                        const tr = await res.json();
                        document.getElementById('entryTransferId').value = tr.id;
                        document.getElementById('entryTransferMtnNum').value = tr.mtnNum || '';
                        document.getElementById('entryTransferDate').value = tr.transferDateISO || '';
                        document.getElementById('entryTransferItemName').value = tr.itemName || '';
                        document.getElementById('entryTransferItemDesc').value = tr.itemDesc || '';
                        document.getElementById('entryTransferQty').value = tr.qty || 0;
                        document.getElementById('entryTransferCategory').value = tr.category || '';
                        document.getElementById('entryTransferFrom').value = tr.fromLocation || '';
                        document.getElementById('entryTransferTo').value = tr.toLocation || '';
                        document.getElementById('entryTransferBy').value = tr.transferredBy || '';
                        document.getElementById('entryTransferReceivedBy').value = tr.receivedBy || '';
                        document.getElementById('entryTransferMrn').value = tr.mrnNum || '';
                        document.getElementById('entryTransferNotes').value = tr.notes || '';
                        document.getElementById('transferEntryTitle').textContent = 'Edit Material Transfer';
                    }
                } catch (err) {
                    console.error("Failed to load transfer for edit:", err);
                }
            }
        }

        async function deleteTransferRecord(id) {
            if (!confirm('Delete this transfer record permanently?')) return;
            try {
                const res = await fetch(`/api/transfers/${id}`, {
                    method: 'DELETE'
                });
                const r = await res.json();
                if (!res.ok) throw new Error(r.error || 'Deletion failed');
                await fetchTransfers();
                renderTransfersView();
                updateSidebarBadges();
            } catch (err) {
                alert(err.message || 'Failed to delete record.');
            }
        }

        async function openTransferOffcanvas(transferId) {
            try {
                const res = await fetch(`/api/transfers/${transferId}`);
                if (!res.ok) throw new Error();
                const tr = await res.json();

                document.getElementById('transferOffcanvasMtn').textContent = tr.mtnNum;
                document.getElementById('transferOffcanvasItemName').textContent = tr.itemName;
                document.getElementById('transferOffcanvasItemDesc').textContent = tr.itemDesc || 'No additional description details.';
                document.getElementById('transferOffcanvasDate').textContent = tr.transferDate || '';
                document.getElementById('transferOffcanvasQty').textContent = tr.qty || 0;
                document.getElementById('transferOffcanvasFrom').textContent = tr.fromLocation || '';
                document.getElementById('transferOffcanvasTo').textContent = tr.toLocation || '';
                document.getElementById('transferOffcanvasBy').textContent = tr.transferredBy || '';
                document.getElementById('transferOffcanvasReceived').textContent = tr.receivedBy || '';
                document.getElementById('transferOffcanvasCategory').textContent = tr.category || 'General Items';
                document.getElementById('transferOffcanvasMrn').textContent = tr.mrnNum || '-';
                document.getElementById('transferOffcanvasNotes').textContent = tr.notes || 'None';

                const editBtn = document.getElementById('transferOffcanvasEditBtn');
                editBtn.onclick = () => {
                    closeTransferOffcanvas();
                    window.location.hash = `#transfer-entry/${tr.id}`;
                };

                const deleteBtn = document.getElementById('transferOffcanvasDeleteBtn');
                deleteBtn.onclick = () => {
                    closeTransferOffcanvas();
                    deleteTransferRecord(tr.id);
                };

                const panel = document.getElementById('transferOffcanvas');
                if (panel) panel.classList.remove('translate-x-full');
            } catch (err) {
                console.error("Failed to open transfer details:", err);
            }
        }

        function closeTransferOffcanvas() {
            const panel = document.getElementById('transferOffcanvas');
            if (panel) panel.classList.add('translate-x-full');
        }

        // Bind form submissions on load
        window.addEventListener('DOMContentLoaded', () => {
            const entryForm = document.getElementById('batteryEntryForm');
            if (entryForm) {
                entryForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const id = document.getElementById('entryBatId').value;
                    const payload = {
                        serialNumber: document.getElementById('entryBatSerial').value.trim(),
                        itemName: document.getElementById('entryBatName').value.trim(),
                        brand: document.getElementById('entryBatBrand').value.trim(),
                        itemDesc: document.getElementById('entryBatDesc').value.trim(),
                        condition: document.getElementById('entryBatCondition').value,
                        state: document.getElementById('entryBatState').value,
                        currentVehicle: document.getElementById('entryBatState').value === 'Installed' ? 
                            document.getElementById('entryBatVehicle').value.trim() : '',
                        purchaseDate: document.getElementById('entryBatPurchaseDate').value,
                        expiryDate: document.getElementById('entryBatExpiryDate').value,
                        notes: document.getElementById('entryBatNotes').value.trim()
                    };

                    try {
                        const url = id ? `/api/batteries/${id}` : '/api/batteries';
                        const method = id ? 'PUT' : 'POST';
                        const res = await fetch(url, {
                            method,
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const r = await res.json();
                        if (!res.ok) throw new Error(r.error || 'Registration failed');
                        
                        await fetchBatteries();
                        renderBatteriesView();
                        updateSidebarBadges();
                        window.location.hash = '#batteries';
                    } catch (err) {
                        alert(err.message || 'Failed to save battery details.');
                    }
                });
            }

            const moveForm = document.getElementById('batteryMoveForm');
            if (moveForm) {
                moveForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const isSwapChecked = document.getElementById('moveBatSwapToggle').checked;
                    const payload = {
                        batteryId: document.getElementById('moveBatSelect').value,
                        movementType: document.getElementById('moveBatType').value,
                        toVehicle: document.getElementById('moveBatToVehicle').value.trim(),
                        movementDate: document.getElementById('moveBatDate').value,
                        conditionAfter: document.getElementById('moveBatConditionAfter').value || null,
                        notes: document.getElementById('moveBatNotes').value.trim(),
                        issuedBy: document.getElementById('moveBatIssuedBy').value.trim(),
                        mrnNum: document.getElementById('moveBatMrnNum').value.trim(),
                        replaced: isSwapChecked ? {
                            serialNumber: document.getElementById('moveBatOldSerial').value.trim(),
                            itemName: document.getElementById('moveBatOldName').value.trim(),
                            brand: document.getElementById('moveBatOldBrand').value.trim(),
                            notes: document.getElementById('moveBatOldNotes').value.trim()
                        } : null
                    };

                    try {
                        const res = await fetch('/api/batteries/move', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const r = await res.json();
                        if (!res.ok) throw new Error(r.error || 'Movement logging failed');
                        
                        await fetchBatteries();
                        renderBatteriesView();
                        updateSidebarBadges();
                        window.location.hash = '#batteries';
                    } catch (err) {
                        alert(err.message || 'Failed to log battery movement.');
                    }
                });
            }

            const transferForm = document.getElementById('transferEntryForm');
            if (transferForm) {
                transferForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const id = document.getElementById('entryTransferId').value;
                    const payload = {
                        mtnNum: document.getElementById('entryTransferMtnNum').value.trim(),
                        transferDate: document.getElementById('entryTransferDate').value,
                        itemName: document.getElementById('entryTransferItemName').value.trim(),
                        qty: parseFloat(document.getElementById('entryTransferQty').value) || 0,
                        category: document.getElementById('entryTransferCategory').value || null,
                        fromLocation: document.getElementById('entryTransferFrom').value.trim(),
                        toLocation: document.getElementById('entryTransferTo').value.trim(),
                        transferredBy: document.getElementById('entryTransferBy').value.trim(),
                        receivedBy: document.getElementById('entryTransferReceivedBy').value.trim(),
                        mrnNum: document.getElementById('entryTransferMrn').value.trim(),
                        itemDesc: document.getElementById('entryTransferItemDesc').value.trim(),
                        notes: document.getElementById('entryTransferNotes').value.trim()
                    };

                    try {
                        const url = id ? `/api/transfers/${id}` : '/api/transfers';
                        const method = id ? 'PUT' : 'POST';
                        const res = await fetch(url, {
                            method,
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const r = await res.json();
                        if (!res.ok) throw new Error(r.error || 'Save transfer failed');
                        
                        await fetchTransfers();
                        renderTransfersView();
                        updateSidebarBadges();
                        window.location.hash = '#transfers';
                    } catch (err) {
                        alert(err.message || 'Failed to save transfer details.');
                    }
                });
            }
        });

        function loadItems() {
            loadAllData();
        }
// ===== extracted from item_tracker.html lines 7518-7766 =====
        const jcEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const jcCur = (n) => (typeof formatCurrency === 'function') ? formatCurrency(n) : ('Rs. ' + Number(n || 0).toLocaleString());
        const jcDate = (iso) => {
            if (!iso) return '—';
            const d = new Date(iso); if (isNaN(d.getTime())) return jcEsc(iso);
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        };
        const JC_STATUS_META = {
            OPEN:        { label: 'Open',        cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
            IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
            ON_HOLD:     { label: 'On Hold',     cls: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-400' },
            COMPLETED:   { label: 'Completed',   cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
            CLOSED:      { label: 'Closed',      cls: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400' },
        };
        const JC_STATUS_ACTION = {
            IN_PROGRESS: { label: 'Start / Resume', tone: 'from-blue-500 to-blue-700' },
            ON_HOLD:     { label: 'Put On Hold',    tone: 'from-amber-500 to-amber-600', note: true },
            COMPLETED:   { label: 'Complete',       tone: 'from-emerald-500 to-emerald-700' },
            CLOSED:      { label: 'Close',          tone: 'from-indigo-500 to-indigo-700' },
        };

        function jcBadge(status) {
            const m = JC_STATUS_META[status] || JC_STATUS_META.OPEN;
            return `<span class="px-2.5 py-1 rounded-lg text-[10px] font-extrabold uppercase tracking-wider ${m.cls}">${m.label}</span>`;
        }

        async function renderJobCards() {
            const body = document.getElementById('jobCardsTableBody');
            if (!body) return;
            const q = new URLSearchParams();
            const search = (document.getElementById('jcSearch') || {}).value;
            const status = (document.getElementById('jcStatusFilter') || {}).value;
            const type = (document.getElementById('jcTypeFilter') || {}).value;
            if (search) q.set('search', search);
            if (status) q.set('status', status);
            if (type) q.set('type', type);
            q.set('limit', '200');
            body.innerHTML = `<tr><td colspan="7" class="px-5 py-10 text-center text-sm font-semibold text-slate-400">Loading…</td></tr>`;
            let data;
            try {
                const res = await fetch('/api/jobcards?' + q.toString());
                data = await res.json();
            } catch (e) {
                body.innerHTML = `<tr><td colspan="7" class="px-5 py-10 text-center text-sm font-semibold text-rose-500">Failed to load job cards.</td></tr>`;
                return;
            }
            const rows = (data && data.jobcards) || [];
            const badge = document.getElementById('count-jobcards');
            if (badge) badge.textContent = rows.filter((r) => r.status !== 'CLOSED').length;
            if (!rows.length) {
                body.innerHTML = `<tr><td colspan="7" class="px-5 py-12 text-center"><div class="text-sm font-semibold text-slate-400 dark:text-slate-500">No job cards yet.</div><a href="#jobcard-entry" class="inline-block mt-3 text-sm font-bold text-indigo-600 dark:text-indigo-400">+ Create the first job card</a></td></tr>`;
                return;
            }
            body.innerHTML = rows.map((r) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition cursor-pointer" onclick="openJobCardDetail(${r.id})">
                    <td class="px-5 py-3.5 font-extrabold text-slate-800 dark:text-slate-100">${jcEsc(r.jobNo || '—')}</td>
                    <td class="px-5 py-3.5 font-semibold text-slate-700 dark:text-slate-300">${jcEsc(r.vehicleMachinery || '—')}</td>
                    <td class="px-5 py-3.5"><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">${r.type === 'OUTSOURCED' ? 'Outsourced' : 'Internal'}</span></td>
                    <td class="px-5 py-3.5 text-slate-500 dark:text-slate-400 font-semibold">${jcDate(r.dateISO)}</td>
                    <td class="px-5 py-3.5">${jcBadge(r.status)}</td>
                    <td class="px-5 py-3.5 text-right font-bold text-slate-700 dark:text-slate-300">${(r.labourCost || 0) > 0 ? jcCur(r.labourCost) : '—'}</td>
                    <td class="px-5 py-3.5 text-right" onclick="event.stopPropagation()">
                        <button onclick="editJobCard(${r.id})" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition">Edit</button>
                    </td>
                </tr>`).join('');
        }

        async function openJobCardDetail(id) {
            const modal = document.getElementById('jobCardModal');
            const mount = document.getElementById('jobCardModalContent');
            if (!modal || !mount) return;
            mount.innerHTML = `<div class="py-10 text-center text-sm font-semibold text-slate-400">Loading…</div>`;
            modal.classList.remove('hidden');
            let jc;
            try { jc = await (await fetch('/api/jobcards/' + id)).json(); } catch (e) { jc = null; }
            if (!jc || jc.error) { mount.innerHTML = `<div class="py-10 text-center text-sm font-semibold text-rose-500">Could not load this job card.</div>`; return; }
            renderJobCardModal(jc);
        }
        function closeJobCardModal() {
            const modal = document.getElementById('jobCardModal');
            if (modal) modal.classList.add('hidden');
        }

        function jcField(label, value) {
            return `<div><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">${label}</div><div class="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">${value || '—'}</div></div>`;
        }

        function renderJobCardModal(jc) {
            const mount = document.getElementById('jobCardModalContent');
            const actions = (jc.availableStatuses || []).map((st) => {
                const a = JC_STATUS_ACTION[st]; if (!a) return '';
                return `<button onclick="changeJobStatus(${jc.id}, '${st}', ${a.note ? 'true' : 'false'})" class="px-4 py-2 rounded-xl bg-gradient-to-r ${a.tone} text-white text-xs font-bold shadow-sm transition">${a.label}</button>`;
            }).join('');
            const timeline = (jc.audits || []).map((au) => `
                <div class="flex gap-3 text-xs">
                    <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0"></div>
                    <div>
                        <span class="font-bold text-slate-700 dark:text-slate-300">${jcEsc(au.action)}</span>
                        ${au.fromStatus ? `<span class="text-slate-400">· ${jcEsc(au.fromStatus)} → ${jcEsc(au.toStatus || '')}</span>` : (au.toStatus ? `<span class="text-slate-400">· ${jcEsc(au.toStatus)}</span>` : '')}
                        ${au.note ? `<div class="text-slate-500 dark:text-slate-400 mt-0.5 italic">“${jcEsc(au.note)}”</div>` : ''}
                        <div class="text-[10px] text-slate-400 mt-0.5">${jcEsc(au.userName || '')} · ${jcDate(au.at)}</div>
                    </div>
                </div>`).join('');
            mount.innerHTML = `
                <div class="flex items-start justify-between gap-4 mb-5">
                    <div>
                        <div class="flex items-center gap-3">
                            <h3 class="text-xl font-black text-slate-900 dark:text-white tracking-tight">${jcEsc(jc.jobNo || 'Job Card')}</h3>
                            ${jcBadge(jc.status)}
                        </div>
                        <div class="text-sm font-semibold text-slate-450 dark:text-slate-500 mt-1">${jc.type === 'OUTSOURCED' ? 'Outsourced Service Request' : 'Internal Workshop Job'} · ${jcEsc(jc.vehicleMachinery || '')}</div>
                    </div>
                    <button onclick="closeJobCardModal()" class="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl p-4 mb-5">
                    ${jcField('Date', jcDate(jc.dateISO))}
                    ${jcField('Project / Plant', jcEsc(jc.projectName))}
                    ${jcField('Meter', jc.meter != null ? jcEsc(jc.meter) : '—')}
                    ${jcField('Repair Type', jcEsc(jc.repairType))}
                    ${jcField('Expected', jcDate(jc.expectedDateISO))}
                    ${jcField('Driver / Operator', jcEsc(jc.driverName))}
                    ${jcField('Contact', jcEsc(jc.contactNo))}
                    ${jcField('ECD No', jcEsc(jc.ecdNo))}
                    ${jc.type === 'OUTSOURCED' ? jcField('Vendor', jcEsc(jc.vendorName)) : ''}
                </div>

                ${jc.details ? `<div class="mb-5"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Required Work</div><div class="text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3">${jcEsc(jc.details)}</div></div>` : ''}

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                    <div class="rounded-2xl border border-slate-150 dark:border-slate-800 p-3"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Received Parts</div><div class="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5">${jcCur(jc.receivedPartsCost || 0)}</div></div>
                    <div class="rounded-2xl border border-slate-150 dark:border-slate-800 p-3"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Issued Items</div><div class="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5">${jcCur(jc.issuesCost || 0)}</div></div>
                    <div class="rounded-2xl border border-slate-150 dark:border-slate-800 p-3"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Labour</div><div class="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5">${jcCur(jc.labourCost || 0)}</div></div>
                    <div class="rounded-2xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/50 dark:bg-indigo-950/20 p-3"><div class="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Total Job Cost</div><div class="text-base font-black text-indigo-700 dark:text-indigo-400 mt-0.5">${jcCur(jc.totalCost || 0)}</div><div class="text-[9px] font-semibold text-indigo-400/80 mt-0.5">${(jc.recordedCost != null && jc.recordedCost > 0 && jc.recordedCost >= (jc.computedCost || 0)) ? 'recorded service cost' : `parts ${jcCur(jc.partsCost || 0)} + labour ${jcCur(jc.labourCost || 0)}`}</div></div>
                </div>
                ${jc.recordedCost != null && jc.recordedCost > 0 ? `<div class="mb-5 -mt-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/40 rounded-xl px-3 py-2">Externally recorded cost (imported service log / C-job): <span class="font-black text-slate-700 dark:text-slate-200">${jcCur(jc.recordedCost)}</span> <span class="text-slate-400">${jc.recordedCost >= (jc.computedCost || 0) ? '— this is the job total above (larger than the Rs ' + jcCur(jc.computedCost || 0) + ' computed from live parts + labour).' : '— the live computed total above is larger, so it is used instead.'}</span></div>` : ''}

                <!-- Daily Programme mount (Phase 3) -->
                <div id="jcProgrammeMount"></div>
                <!-- Linked MRNs mount (Phase 4) -->
                <div id="jcMrnMount"></div>
                <!-- Issued items mount (Addendum 3) -->
                <div id="jcIssuesMount"></div>

                <div class="flex flex-wrap items-center gap-2 mt-5 pt-5 border-t border-slate-100 dark:border-slate-800">
                    ${actions}
                    <div class="flex-grow"></div>
                    <button onclick="editJobCard(${jc.id})" class="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition">Edit Job Card</button>
                </div>

                ${timeline ? `<div class="mt-6"><div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">Activity</div><div class="space-y-3">${timeline}</div></div>` : ''}
            `;
            if (typeof renderJobProgramme === 'function') renderJobProgramme(jc);   // Phase 3 hook
            if (typeof renderJobMrns === 'function') renderJobMrns(jc);             // Phase 4 hook
            if (typeof renderJobIssues === 'function') renderJobIssues(jc);         // Addendum 3 hook
        }

        async function changeJobStatus(id, status, needNote) {
            let note = '';
            if (needNote) {
                note = prompt('Reason for putting this job on hold:') || '';
                if (note === null) return;
            }
            try {
                const res = await fetch('/api/jobcards/' + id + '/status', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status, note })
                });
                const data = await res.json();
                if (!res.ok) { alert(data.error || 'Could not change status.'); return; }
                renderJobCardModal(data.jobcard);
                renderJobCards();
            } catch (e) { alert('Network error.'); }
        }

        function editJobCard(id) { closeJobCardModal(); window.location.hash = '#jobcard-entry/' + id; }
        function toggleVendorField() {
            const wrap = document.getElementById('jcVendorWrap');
            const type = (document.getElementById('jcType') || {}).value;
            if (wrap) wrap.classList.toggle('hidden', type !== 'OUTSOURCED');
        }

        async function setupJobCardEntry(param) {
            const form = document.getElementById('jobCardForm');
            if (form) form.reset();
            const err = document.getElementById('jcEntryError'); if (err) err.classList.add('hidden');
            document.getElementById('jcId').value = '';
            const title = document.getElementById('jcEntryTitle');
            const sub = document.getElementById('jcEntrySubtitle');
            if (param) {
                if (title) title.textContent = 'Edit Job Card';
                if (sub) sub.textContent = 'Update the job card details.';
                try {
                    const jc = await (await fetch('/api/jobcards/' + param)).json();
                    if (jc && !jc.error) {
                        document.getElementById('jcId').value = jc.id;
                        document.getElementById('jcType').value = jc.type || 'INTERNAL';
                        document.getElementById('jcVehicle').value = jc.vehicleMachinery || '';
                        document.getElementById('jcDate').value = jc.dateISO || '';
                        document.getElementById('jcProject').value = jc.projectName || '';
                        document.getElementById('jcMeter').value = jc.meter != null ? jc.meter : '';
                        document.getElementById('jcRepairType').value = jc.repairType || '';
                        document.getElementById('jcExpectedDate').value = jc.expectedDateISO || '';
                        document.getElementById('jcDriver').value = jc.driverName || '';
                        document.getElementById('jcContact').value = jc.contactNo || '';
                        document.getElementById('jcEcd').value = jc.ecdNo || '';
                        document.getElementById('jcVendor').value = jc.vendorName || '';
                        document.getElementById('jcDetails').value = jc.details || '';
                    }
                } catch (e) { /* ignore */ }
            } else {
                if (title) title.textContent = 'New Job Card';
                if (sub) sub.textContent = 'Create a vehicle / machinery repair or service job.';
                const d = document.getElementById('jcDate'); if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
            }
            toggleVendorField();
        }

        async function saveJobCard(event) {
            event.preventDefault();
            const err = document.getElementById('jcEntryError'); if (err) err.classList.add('hidden');
            const id = document.getElementById('jcId').value;
            const payload = {
                type: document.getElementById('jcType').value,
                vehicleMachinery: document.getElementById('jcVehicle').value,
                date: document.getElementById('jcDate').value,
                projectName: document.getElementById('jcProject').value,
                meter: document.getElementById('jcMeter').value,
                repairType: document.getElementById('jcRepairType').value,
                expectedDate: document.getElementById('jcExpectedDate').value,
                driverName: document.getElementById('jcDriver').value,
                contactNo: document.getElementById('jcContact').value,
                ecdNo: document.getElementById('jcEcd').value,
                vendorName: document.getElementById('jcVendor').value,
                details: document.getElementById('jcDetails').value,
            };
            if (!payload.vehicleMachinery.trim()) { if (err) { err.textContent = 'Vehicle / Machinery is required.'; err.classList.remove('hidden'); } return; }
            const btn = document.getElementById('jcSaveBtn'); if (btn) btn.disabled = true;
            try {
                const res = await fetch('/api/jobcards' + (id ? '/' + id : ''), {
                    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not save.'; err.classList.remove('hidden'); } if (btn) btn.disabled = false; return; }
                window.location.hash = '#jobcards';
            } catch (e) {
                if (err) { err.textContent = 'Network error — please try again.'; err.classList.remove('hidden'); }
                if (btn) btn.disabled = false;
            }
        }
// ===== extracted from item_tracker.html lines 7771-8004 =====
        const dpTodayISO = () => new Date().toISOString().slice(0, 10);

        // ---- Programme section inside the Job Card detail modal ----
        function renderJobProgramme(jc) {
            const mount = document.getElementById('jcProgrammeMount');
            if (!mount) return;
            const entries = jc.programme || [];
            window.__jcProgramme = {}; entries.forEach((e) => { window.__jcProgramme[e.id] = e; });
            const mechOpts = (window.__mechanics || []).map((n) => `<option value="${jcEsc(n)}">${jcEsc(n)}</option>`).join('');
            const rows = entries.map((e) => {
                // Per-mechanic breakdown (rate × full hours each) — the "saman×10, ruwan×10" detail.
                const bd = (e.mechanicBreakdown || []).map((m) =>
                    `<span class="inline-block mr-2 whitespace-nowrap">${jcEsc(m.name)}: ${m.hours}h${m.rate ? ' @' + m.rate + ' = ' + jcCur(m.cost) : ' <span class=\"text-slate-400\">(unrated)</span>'}</span>`
                ).join('');
                return `
                <div class="flex items-start justify-between gap-3 py-2.5 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
                    <div class="min-w-0">
                        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${jcDate(e.entryDateISO)} · ${e.hours || 0}h ${e.mechanics ? '· ' + jcEsc(e.mechanics) : ''}</div>
                        ${e.workDescription ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${jcEsc(e.workDescription)}</div>` : ''}
                        ${bd ? `<div class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 font-semibold">${bd}</div>` : ''}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-xs font-extrabold text-slate-700 dark:text-slate-200">${jcCur(e.labourCost || 0)}</span>
                        <button onclick="editJobDaily(${e.id})" class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">Edit</button>
                        <button onclick="deleteJobDaily(${e.id}, ${jc.id})" class="text-[11px] font-bold text-rose-500">Del</button>
                    </div>
                </div>`;
            }).join('');
            mount.innerHTML = `
                <div class="mt-2 mb-5 rounded-2xl border border-slate-150 dark:border-slate-800 overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-150 dark:border-slate-800">
                        <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">Daily Programme (${entries.length})</span>
                        <span class="text-xs font-bold text-slate-600 dark:text-slate-300">Labour: ${jcCur(jc.labourCost || 0)}</span>
                    </div>
                    <div class="px-4 py-2">${rows || '<div class="py-3 text-xs text-slate-400 italic">No daily entries yet.</div>'}</div>
                    <div class="px-4 py-3 bg-slate-50/60 dark:bg-slate-800/20 border-t border-slate-150 dark:border-slate-800">
                        <input type="hidden" id="jdpEditId">
                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <input id="jdpDate" type="date" value="${dpTodayISO()}" class="px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <input id="jdpHours" type="number" step="any" min="0" placeholder="Hours" class="px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <input id="jdpMechanics" list="mechanicDatalist" placeholder="Mechanics" class="col-span-2 sm:col-span-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <select id="jdpMechPick" onchange="jdpAddMech(this)" class="col-span-2 sm:col-span-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-500 dark:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                                <option value="">+ Add mechanic ▾</option>
                                ${mechOpts}
                            </select>
                            <input id="jdpWork" placeholder="Work done" class="col-span-2 sm:col-span-3 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <button onclick="saveJobDaily(${jc.id})" class="px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-indigo-700 text-white text-xs font-bold">Add</button>
                        </div>
                        <div id="jdpError" class="hidden mt-2 text-xs font-semibold text-rose-500"></div>
                    </div>
                </div>`;
        }
        // Pick a mechanic from the ▾ list → append to the comma-separated Mechanics field.
        function jdpAddMech(sel) {
            const name = (sel.value || '').trim(); if (!name) return;
            const inp = document.getElementById('jdpMechanics');
            if (inp) {
                const cur = inp.value.split(',').map((x) => x.trim()).filter(Boolean);
                if (!cur.some((x) => x.toLowerCase() === name.toLowerCase())) cur.push(name);
                inp.value = cur.join(', ');
            }
            sel.value = '';
        }
        function editJobDaily(id) {
            const e = (window.__jcProgramme || {})[id]; if (!e) return;
            document.getElementById('jdpEditId').value = e.id;
            document.getElementById('jdpDate').value = e.entryDateISO || dpTodayISO();
            document.getElementById('jdpHours').value = e.hours || '';
            document.getElementById('jdpMechanics').value = e.mechanics || '';
            document.getElementById('jdpWork').value = e.workDescription || '';
        }
        async function saveJobDaily(jobCardId) {
            const editId = document.getElementById('jdpEditId').value;
            const payload = {
                entryDate: document.getElementById('jdpDate').value,
                hours: document.getElementById('jdpHours').value,
                mechanics: document.getElementById('jdpMechanics').value,
                workDescription: document.getElementById('jdpWork').value,
            };
            const err = document.getElementById('jdpError');
            try {
                const url = editId ? '/api/programme/' + editId : '/api/jobcards/' + jobCardId + '/programme';
                const res = await fetch(url, { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not save.'; err.classList.remove('hidden'); } return; }
                openJobCardDetail(jobCardId);
                if (typeof renderJobCards === 'function') renderJobCards();
            } catch (e) { if (err) { err.textContent = 'Network error.'; err.classList.remove('hidden'); } }
        }
        async function deleteJobDaily(id, jobCardId) {
            if (!confirm('Delete this daily entry?')) return;
            try { await fetch('/api/programme/' + id, { method: 'DELETE' }); openJobCardDetail(jobCardId); if (typeof renderJobCards === 'function') renderJobCards(); } catch (e) {}
        }

        // ---- "Today" view ----
        async function loadJobOptions(selectedId) {
            const sel = document.getElementById('dpqJob'); if (!sel) return;
            let data; try { data = await (await fetch('/api/jobcards?limit=300')).json(); } catch (e) { return; }
            const active = (data.jobcards || []).filter((j) => j.status !== 'CLOSED');
            sel.innerHTML = '<option value="">— Auto-match by vehicle —</option>' +
                active.map((j) => `<option value="${j.id}">${jcEsc(j.jobNo)} · ${jcEsc(j.vehicleMachinery || '')}</option>`).join('');
            if (selectedId) sel.value = String(selectedId);
        }
        async function renderProgramme() {
            const dateInput = document.getElementById('dpViewDate');
            if (dateInput && !dateInput.value) dateInput.value = dpTodayISO();
            const dateISO = (dateInput && dateInput.value) || dpTodayISO();
            await loadJobOptions(document.getElementById('dpqJob') ? document.getElementById('dpqJob').value : null);
            const body = document.getElementById('programmeTodayBody'); if (!body) return;
            body.innerHTML = `<tr><td colspan="5" class="px-5 py-8 text-center text-sm font-semibold text-slate-400">Loading…</td></tr>`;
            let data; try { data = await (await fetch('/api/programme?dateISO=' + encodeURIComponent(dateISO))).json(); } catch (e) { return; }
            const entries = data.programme || [];
            window.__todayProgramme = {}; entries.forEach((e) => { window.__todayProgramme[e.id] = e; });
            let hrs = 0, lab = 0;
            entries.forEach((e) => { hrs += Number(e.hours) || 0; lab += Number(e.labourCost) || 0; });
            document.getElementById('dpSumCount').textContent = entries.length;
            document.getElementById('dpSumHours').textContent = (Math.round(hrs * 100) / 100);
            document.getElementById('dpSumLabour').textContent = jcCur(lab);
            body.innerHTML = entries.length ? entries.map((e) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                    <td class="px-5 py-3 font-bold text-slate-800 dark:text-slate-100">${jcEsc(e.jobNo || '—')}<div class="text-[10px] font-semibold text-slate-400">${jcEsc(e.vehicleMachinery || '')}</div></td>
                    <td class="px-5 py-3"><div class="text-slate-700 dark:text-slate-300 font-semibold">${jcEsc(e.workDescription || '—')}</div><div class="text-[11px] text-slate-400 mt-0.5">${jcEsc(e.mechanics || '')}</div></td>
                    <td class="px-5 py-3 text-right font-bold text-slate-700 dark:text-slate-300">${e.hours || 0}</td>
                    <td class="px-5 py-3 text-right font-extrabold text-slate-800 dark:text-slate-100">${jcCur(e.labourCost || 0)}</td>
                    <td class="px-5 py-3 text-right whitespace-nowrap">
                        <button onclick="editDailyEntry(${e.id})" class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 mr-2">Edit</button>
                        <button onclick="deleteTodayEntry(${e.id})" class="text-[11px] font-bold text-rose-500">Del</button>
                    </td>
                </tr>`).join('') : `<tr><td colspan="5" class="px-5 py-10 text-center text-sm font-semibold text-slate-400">No work logged for this date.</td></tr>`;
        }
        function resetDailyForm() {
            ['dpqEditId', 'dpqHours', 'dpqOutside', 'dpqMechanics', 'dpqWork', 'dpqVehicle'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
            const mi = document.getElementById('dpqMatchInfo'); if (mi) mi.textContent = '';
            const b = document.getElementById('dpqEditBadge'); if (b) b.classList.add('hidden');
            const c = document.getElementById('dpqCancel'); if (c) c.classList.add('hidden');
            const h = document.getElementById('dpqHeading'); if (h) h.textContent = "Add Today's Work";
        }
        let dpqMatchTimer = null;
        function dpqMatchPreview() {
            clearTimeout(dpqMatchTimer);
            dpqMatchTimer = setTimeout(async () => {
                const info = document.getElementById('dpqMatchInfo'); if (!info) return;
                const vehicle = ((document.getElementById('dpqVehicle') || {}).value || '').trim();
                const dateISO = (document.getElementById('dpViewDate') || {}).value || dpTodayISO();
                if ((document.getElementById('dpqJob') || {}).value) { info.innerHTML = '<span class="text-slate-400">Using the selected job (override).</span>'; return; }
                if (!vehicle) { info.textContent = ''; return; }
                try {
                    const data = await (await fetch('/api/jobcards/match?vehicle=' + encodeURIComponent(vehicle) + '&dateISO=' + encodeURIComponent(dateISO))).json();
                    if (data.match) info.innerHTML = '→ matches <span class="text-emerald-600 dark:text-emerald-400 font-bold">' + jcEsc(data.match.jobNo) + '</span>';
                    else info.innerHTML = '→ <span class="text-amber-600 font-bold">no job in window — will file under DW-' + jcEsc(vehicle.replace(/\s+/g, '').toUpperCase()) + '</span>';
                } catch (e) { info.textContent = ''; }
            }, 300);
        }
        function editDailyEntry(id) {
            const e = (window.__todayProgramme || {})[id]; if (!e) return;
            document.getElementById('dpqEditId').value = e.id;
            loadJobOptions(e.jobCardId);
            document.getElementById('dpqHours').value = e.hours || '';
            document.getElementById('dpqOutside').value = e.outsideValue || '';
            document.getElementById('dpqMechanics').value = e.mechanics || '';
            document.getElementById('dpqWork').value = e.workDescription || '';
            const b = document.getElementById('dpqEditBadge'); if (b) b.classList.remove('hidden');
            const c = document.getElementById('dpqCancel'); if (c) c.classList.remove('hidden');
            const h = document.getElementById('dpqHeading'); if (h) h.textContent = 'Edit Entry';
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        async function saveDailyEntry() {
            const err = document.getElementById('dpqError'); if (err) err.classList.add('hidden');
            const editId = document.getElementById('dpqEditId').value;
            const jobCardId = document.getElementById('dpqJob').value;
            const vehicle = ((document.getElementById('dpqVehicle') || {}).value || '').trim();
            const dateISO = (document.getElementById('dpViewDate') || {}).value || dpTodayISO();
            if (!editId && !jobCardId && !vehicle) { if (err) { err.textContent = 'Enter a vehicle (or pick a job).'; err.classList.remove('hidden'); } return; }
            const payload = {
                entryDate: dateISO,
                hours: document.getElementById('dpqHours').value,
                outsideValue: document.getElementById('dpqOutside').value,
                mechanics: document.getElementById('dpqMechanics').value,
                workDescription: document.getElementById('dpqWork').value,
            };
            try {
                let res;
                if (editId) res = await fetch('/api/programme/' + editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                else if (jobCardId) res = await fetch('/api/jobcards/' + jobCardId + '/programme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                else res = await fetch('/api/programme/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, payload, { vehicle })) });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not save.'; err.classList.remove('hidden'); } return; }
                resetDailyForm(); renderProgramme();
            } catch (e) { if (err) { err.textContent = 'Network error.'; err.classList.remove('hidden'); } }
        }
        async function deleteTodayEntry(id) {
            if (!confirm('Delete this daily entry?')) return;
            try { await fetch('/api/programme/' + id, { method: 'DELETE' }); renderProgramme(); } catch (e) {}
        }

        // ---- Mechanics & rates ----
        async function loadMechanicDatalist() {
            let data; try { data = await (await fetch('/api/mechanics')).json(); } catch (e) { return; }
            const active = (data.mechanics || []).filter((m) => m.active);
            window.__mechanics = active.map((m) => m.name);          // cached for the daily-programme pick-select
            const dl = document.getElementById('mechanicDatalist');
            if (dl) dl.innerHTML = active.map((m) => `<option value="${jcEsc(m.name)}">`).join('');
        }
        // All distinct item/consumable names — fills the searchable datalist used by
        // the job modal's Item/part and Consumable name fields.
        async function loadItemNameDatalist() {
            let data; try { data = await (await fetch('/api/item-names')).json(); } catch (e) { return; }
            const dl = document.getElementById('jobItemOptions');
            if (dl) dl.innerHTML = (data.names || []).map((n) => `<option value="${jcEsc(n)}">`).join('');
        }
        function openMechanicsModal() { const m = document.getElementById('mechanicsModal'); if (m) m.classList.remove('hidden'); renderMechanicsList(); }
        function closeMechanicsModal() { const m = document.getElementById('mechanicsModal'); if (m) m.classList.add('hidden'); }
        async function renderMechanicsList() {
            const body = document.getElementById('mechanicsListBody'); if (!body) return;
            let data; try { data = await (await fetch('/api/mechanics')).json(); } catch (e) { return; }
            body.innerHTML = (data.mechanics || []).map((m) => `
                <div class="flex items-center gap-2">
                    <span class="flex-grow text-sm font-semibold text-slate-700 dark:text-slate-300 ${m.active ? '' : 'line-through opacity-50'}">${jcEsc(m.name)}</span>
                    <input id="mrate-${m.id}" type="number" step="any" value="${m.hourlyRate == null ? '' : m.hourlyRate}" placeholder="—" class="w-24 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                    <button onclick="saveMechanic(${m.id}, ${m.active ? 1 : 0})" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700">Save</button>
                </div>`).join('') || '<div class="text-sm text-slate-400">No mechanics.</div>';
        }
        async function saveMechanic(id, active) {
            const rate = document.getElementById('mrate-' + id).value;
            try { await fetch('/api/mechanics/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hourlyRate: rate, active }) }); await loadMechanicDatalist(); } catch (e) {}
        }
        async function addMechanic() {
            const name = document.getElementById('newMechName').value;
            const rate = document.getElementById('newMechRate').value;
            if (!name.trim()) return;
            try {
                const res = await fetch('/api/mechanics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, hourlyRate: rate }) });
                if (res.ok) { document.getElementById('newMechName').value = ''; document.getElementById('newMechRate').value = ''; renderMechanicsList(); loadMechanicDatalist(); }
                else { const d = await res.json(); alert(d.error || 'Could not add.'); }
            } catch (e) {}
        }

        // Populate mechanic + item-name datalists once the page is ready.
        function loadJobModalLookups() { loadMechanicDatalist(); loadItemNameDatalist(); }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadJobModalLookups);
        else loadJobModalLookups();
// ===== extracted from item_tracker.html lines 8009-8180 =====
        let jcCurrentVehicle = '';
        function renderJobMrns(jc) {
            const mount = document.getElementById('jcMrnMount');
            if (!mount) return;
            jcCurrentVehicle = jc.vehicleMachinery || '';
            const items = jc.linkedItems || [];
            const rows = items.map((it) => {
                const rowCls = it.notReceived ? 'bg-amber-50/70 dark:bg-amber-950/10' : '';
                const badges =
                    (it.notReceived ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wider bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">Pending ${it.recQty || 0}/${it.reqQty || 0}</span>` : '') +
                    (it.unpriced ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wider bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">No price</span>` : '');
                return `
                <div class="flex items-start justify-between gap-3 py-2.5 px-2 -mx-2 rounded-lg border-b border-slate-100 dark:border-slate-800/60 last:border-0 ${rowCls}">
                    <div class="min-w-0">
                        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${jcEsc(it.mrnNum || '—')} · ${jcEsc(it.itemName || '')}</div>
                        <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">Received ${it.recQty || 0} of ${it.reqQty || 0} ${badges}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-xs font-extrabold ${it.lineCost > 0 ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400'}">${it.lineCost > 0 ? jcCur(it.lineCost) : '—'}</span>
                        <button onclick="unlinkItem(${it.id}, ${jc.id})" class="text-[11px] font-bold text-rose-500">Unlink</button>
                    </div>
                </div>`;
            }).join('');
            const counts =
                (jc.pendingCount ? ` · <span class="text-amber-600">${jc.pendingCount} pending</span>` : '') +
                (jc.unpricedItems ? ` · <span class="text-rose-500">${jc.unpricedItems} no price</span>` : '');
            mount.innerHTML = `
                <div class="mb-5 rounded-2xl border border-slate-150 dark:border-slate-800 overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-150 dark:border-slate-800">
                        <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">Items / Parts (${items.length})${counts}</span>
                        <span class="text-xs font-bold text-slate-600 dark:text-slate-300">Parts: ${jcCur(jc.partsCost || 0)}</span>
                    </div>
                    <div class="px-4 py-2">${rows || '<div class="py-3 text-xs text-slate-400 italic">No items linked yet.</div>'}</div>
                    <div class="px-4 py-3 bg-slate-50/60 dark:bg-slate-800/20 border-t border-slate-150 dark:border-slate-800">
                        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Add item</div>
                        <div class="grid grid-cols-12 gap-2">
                            <input id="jiName" list="jobItemOptions" placeholder="Item / part name" class="col-span-12 sm:col-span-5 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <input id="jiQty" type="number" step="any" min="0" value="1" placeholder="Qty" class="col-span-4 sm:col-span-2 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <input id="jiPrice" type="number" step="any" min="0" placeholder="Unit Rs. (optional)" class="col-span-5 sm:col-span-3 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <button onclick="addJobItem(${jc.id})" class="col-span-3 sm:col-span-2 px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-indigo-700 text-white text-xs font-bold">Add</button>
                        </div>
                        <div id="jiError" class="hidden mt-2 text-xs font-semibold text-rose-500"></div>
                    </div>
                    <div class="px-4 py-3 bg-slate-50/60 dark:bg-slate-800/20 border-t border-slate-150 dark:border-slate-800 flex flex-wrap gap-2 items-center">
                        <select id="jcLinkMrnInput" class="flex-grow px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <option value="">— Select an MRN to link —</option>
                        </select>
                        <button onclick="linkMrnToJob(${jc.id})" class="px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-indigo-700 text-white text-xs font-bold">Link MRN</button>
                        <button onclick="autoLinkJob(${jc.id})" class="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold border border-slate-200 dark:border-slate-700" title="Pull in all items/issues dated within this job (start −2d … end +2d)">Auto-link matching</button>
                    </div>
                    <div id="jcLinkMrnError" class="hidden px-4 pb-3 text-xs font-semibold text-rose-500"></div>
                </div>`;
            loadLinkableMrns(jc.id);
        }
        // Fill the "Link MRN" select with this job's vehicle's unlinked MRNs.
        async function loadLinkableMrns(jobCardId) {
            const sel = document.getElementById('jcLinkMrnInput');
            if (!sel) return;
            let data; try { data = await (await fetch('/api/jobcards/' + jobCardId + '/linkable-mrns')).json(); } catch (e) { return; }
            const opts = (data.mrns || []).map((m) => `<option value="${jcEsc(m.mrnNum)}">${jcEsc(m.mrnNum)}${m.itemName ? ' · ' + jcEsc(m.itemName) : ''}</option>`).join('');
            sel.innerHTML = `<option value="">${(data.mrns || []).length ? '— Select an MRN to link —' : '— No unlinked MRNs for this vehicle —'}</option>` + opts;
        }
        async function addJobItem(jobCardId) {
            const name = ((document.getElementById('jiName') || {}).value || '').trim();
            const qty = Number((document.getElementById('jiQty') || {}).value) || 0;
            const price = (document.getElementById('jiPrice') || {}).value;
            const err = document.getElementById('jiError');
            if (err) err.classList.add('hidden');
            if (!name) { if (err) { err.textContent = 'Item name is required.'; err.classList.remove('hidden'); } return; }
            try {
                const today = new Date().toISOString().slice(0, 10);
                const res = await fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemName: name, reqQty: qty || 1, vehicleMachinery: jcCurrentVehicle, reqDate: today, jobCardId }) });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not add item.'; err.classList.remove('hidden'); } return; }
                if (price && Number(price) > 0) {
                    await fetch('/api/items/' + data.id + '/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: qty || 1, transactionType: 'Receive', unitPrice: Number(price), deliveryDate: today, purchaseSource: 'Local Purchase' }) });
                }
                openJobCardDetail(jobCardId);
            } catch (e) { if (err) { err.textContent = 'Network error.'; err.classList.remove('hidden'); } }
        }
        async function autoLinkJob(jobCardId) {
            try {
                const res = await fetch('/api/jobcards/' + jobCardId + '/auto-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                await res.json().catch(() => ({}));
                openJobCardDetail(jobCardId);
            } catch (e) {}
        }
        async function autoLinkAllMrns(btn) {
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = 'Linking…'; }
            try {
                const res = await fetch('/api/jobcards/auto-link-mrns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) alert(data.error || 'Could not auto-link.');
                else { alert('Linked ' + data.linked + ' MRNs and ' + (data.issuesLinked || 0) + ' issued items to their jobs by vehicle + date.'); if (typeof renderJobCards === 'function') renderJobCards(); }
            } catch (e) { alert('Network error.'); }
            finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
        }
        function renderJobIssues(jc) {
            const mount = document.getElementById('jcIssuesMount');
            if (!mount) return;
            const issues = jc.linkedIssues || [];
            const rows = issues.map((it) => `
                <div class="flex items-center justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
                    <div class="min-w-0">
                        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${jcEsc(it.itemName || '—')}</div>
                        <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${jcDate(it.issueDateISO)}${it.category ? ' · ' + jcEsc(it.category) : ''}${it.unitPrice != null ? ' · Qty ' + (it.qty || 0) + ' @ ' + jcCur(it.unitPrice) : ''}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-xs font-extrabold ${it.lineCost > 0 ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400'}">${it.unitPrice != null ? jcCur(it.lineCost) : 'Qty ' + (it.qty || 0) + ' · no price'}</span>
                        <button onclick="unlinkIssue(${it.id}, ${jc.id})" class="text-[11px] font-bold text-rose-500">Unlink</button>
                    </div>
                </div>`).join('');
            const issCounts = jc.unpricedIssues ? ` · <span class="text-rose-500">${jc.unpricedIssues} no price</span>` : '';
            mount.innerHTML = `
                <div class="mb-5 rounded-2xl border border-slate-150 dark:border-slate-800 overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-150 dark:border-slate-800">
                        <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">Issued Items / Consumables (${issues.length})${issCounts}</span>
                        <span class="text-xs font-bold text-slate-600 dark:text-slate-300">Issued: ${jcCur(jc.issuesCost || 0)}</span>
                    </div>
                    <div class="px-4 py-2">${rows || '<div class="py-3 text-xs text-slate-400 italic">No issued items linked yet.</div>'}</div>
                    <div class="px-4 py-3 bg-slate-50/60 dark:bg-slate-800/20 border-t border-slate-150 dark:border-slate-800">
                        <div class="grid grid-cols-12 gap-2">
                            <input id="jisName" list="jobItemOptions" placeholder="Issue a consumable to this job…" class="col-span-12 sm:col-span-7 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <input id="jisQty" type="number" step="any" min="0" value="1" placeholder="Qty" class="col-span-6 sm:col-span-3 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                            <button onclick="addJobIssue(${jc.id})" class="col-span-6 sm:col-span-2 px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-indigo-700 text-white text-xs font-bold">Issue</button>
                        </div>
                        <div id="jisError" class="hidden mt-2 text-xs font-semibold text-rose-500"></div>
                    </div>
                    <div class="px-4 py-2.5 bg-slate-50/60 dark:bg-slate-800/20 border-t border-slate-150 dark:border-slate-800 flex justify-end">
                        <button onclick="autoLinkJob(${jc.id})" class="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold border border-slate-200 dark:border-slate-700" title="Pull in all items/issues dated within this job (start −2d … end +2d)">Auto-link matching</button>
                    </div>
                </div>`;
        }
        async function addJobIssue(jobCardId) {
            const name = ((document.getElementById('jisName') || {}).value || '').trim();
            const qty = Number((document.getElementById('jisQty') || {}).value) || 0;
            const err = document.getElementById('jisError'); if (err) err.classList.add('hidden');
            if (!name) { if (err) { err.textContent = 'Item name is required.'; err.classList.remove('hidden'); } return; }
            try {
                const today = new Date().toISOString().slice(0, 10);
                const res = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemName: name, qty: qty || 1, vehicleMachinery: jcCurrentVehicle, issueDate: today, jobCardId }) });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not add.'; err.classList.remove('hidden'); } return; }
                openJobCardDetail(jobCardId);
            } catch (e) { if (err) { err.textContent = 'Network error.'; err.classList.remove('hidden'); } }
        }
        async function unlinkIssue(issueId, jobCardId) {
            try { await fetch('/api/issues/' + issueId + '/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: null }) }); openJobCardDetail(jobCardId); } catch (e) {}
        }
        async function linkMrnToJob(jobCardId) {
            const input = document.getElementById('jcLinkMrnInput');
            const err = document.getElementById('jcLinkMrnError');
            const mrnNum = ((input && input.value) || '').trim();
            if (!mrnNum) return;
            try {
                const res = await fetch('/api/jobcards/' + jobCardId + '/link-mrn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mrnNum }) });
                const data = await res.json();
                if (!res.ok) { if (err) { err.textContent = data.error || 'Could not link.'; err.classList.remove('hidden'); } return; }
                openJobCardDetail(jobCardId);
            } catch (e) { if (err) { err.textContent = 'Network error.'; err.classList.remove('hidden'); } }
        }
        async function unlinkItem(itemId, jobCardId) {
            try { await fetch('/api/items/' + itemId + '/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: null }) }); openJobCardDetail(jobCardId); } catch (e) {}
        }
        async function populateJobLinkSelect() {
            const sel = document.getElementById('jcLinkSelect'); if (!sel) return;
            let data; try { data = await (await fetch('/api/jobcards?limit=300')).json(); } catch (e) { return; }
            const active = (data.jobcards || []).filter((j) => j.status !== 'CLOSED');
            const cur = sel.value;
            sel.innerHTML = '<option value="">— No job card —</option>' + active.map((j) => `<option value="${j.id}">${jcEsc(j.jobNo)} · ${jcEsc(j.vehicleMachinery || '')}</option>`).join('');
            sel.value = cur;
        }
// ===== extracted from item_tracker.html lines 8185-8372 =====
        let dashSupplierChartInstance = null;
        let dashDebTimer = null;
        let dashCatsLoaded = false;
        let dashActivePreset = 'all';
        const DASH_COLORS = ['#12b389', '#0d906e', '#32cc9e', '#0b7c5e', '#67e2ba', '#105945', '#a0f0d4', '#0e7055', '#cff9ea', '#114a3a', '#94a3b8', '#cbd5e1'];
        const dMonthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
        const dYearStart = () => `${new Date().getFullYear()}-01-01`;
        const dToday = () => new Date().toISOString().slice(0, 10);
        const dCur = (n) => (typeof formatCurrency === 'function') ? formatCurrency(n) : ('Rs. ' + Number(n || 0).toLocaleString());

        async function loadDashCategories() {
            if (dashCatsLoaded) return; dashCatsLoaded = true;
            try {
                const data = await (await fetch('/api/categories')).json();
                const sel = document.getElementById('dashCategory'); if (!sel) return;
                (data.categories || []).forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
            } catch (e) { dashCatsLoaded = false; }
        }
        function dashSetPresetUI() {
            ['Month', 'Year', 'All'].forEach((p) => {
                const el = document.getElementById('dashPreset' + p); if (!el) return;
                const on = dashActivePreset === p.toLowerCase();
                el.className = 'dash-preset px-3 py-2 text-xs font-bold ' + (on ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300') + (p !== 'Month' ? ' border-l border-slate-200 dark:border-slate-700' : '');
            });
        }
        function dashPreset(p) {
            const start = document.getElementById('dashStart'), end = document.getElementById('dashEnd');
            if (p === 'month') { start.value = dMonthStart(); end.value = dToday(); }
            else if (p === 'year') { start.value = dYearStart(); end.value = dToday(); }
            else { start.value = ''; end.value = ''; }
            dashActivePreset = p; dashSetPresetUI(); renderUnifiedDashboard();
        }
        function dashClearPreset() { dashActivePreset = null; dashSetPresetUI(); }
        function dashReset() {
            ['dashStart', 'dashEnd', 'dashSource', 'dashCategory', 'dashVehicle', 'dashSupplier'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
            dashActivePreset = 'all'; dashSetPresetUI(); renderUnifiedDashboard();
        }
        function dashDebounced() { clearTimeout(dashDebTimer); dashDebTimer = setTimeout(renderUnifiedDashboard, 350); }

        function dashQuery() {
            const g = (id) => (document.getElementById(id) || {}).value || '';
            const q = new URLSearchParams();
            if (g('dashStart')) q.set('startDate', g('dashStart'));
            if (g('dashEnd')) q.set('endDate', g('dashEnd'));
            if (g('dashSource')) q.set('source', g('dashSource'));
            if (g('dashCategory')) q.set('category', g('dashCategory'));
            if (g('dashVehicle')) q.set('vehicle', g('dashVehicle').trim());
            if (g('dashSupplier')) q.set('supplier', g('dashSupplier').trim());
            return q;
        }

        async function renderUnifiedDashboard() {
            loadDashCategories();
            dashSetPresetUI();
            let o; try { o = await (await fetch('/api/dashboard?' + dashQuery().toString())).json(); } catch (e) { return; }
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('kpiMtd', dCur(o.spend.mtd));
            set('kpiYtd', dCur(o.spend.ytd));
            const hasRange = !!(o.filters.startDate || o.filters.endDate);
            set('kpiPeriodLabel', hasRange ? 'Spend · Selected Period' : 'Spend · All Time');
            set('kpiPeriod', dCur(o.spend.period));
            set('kpiJobs', o.jobs.active);
            set('kpiJobCost', dCur(o.jobs.totalCost));

            // Local vs Head Office split
            const rc = o.received; const tot = rc.total || 0;
            const pct = (v) => tot > 0 ? Math.round((v / tot) * 100) : 0;
            const bHo = document.getElementById('dashBarHo'), bLo = document.getElementById('dashBarLocal'), bOt = document.getElementById('dashBarOther');
            if (bHo) bHo.style.width = pct(rc.headOffice) + '%';
            if (bLo) bLo.style.width = pct(rc.local) + '%';
            if (bOt) bOt.style.width = pct(rc.other) + '%';
            set('dashHo', dCur(rc.headOffice)); set('dashLocal', dCur(rc.local)); set('dashOther', dCur(rc.other));

            // Supplier distribution
            const sup = o.suppliers || [];
            const listEl = document.getElementById('dashSupplierList');
            if (listEl) listEl.innerHTML = sup.length ? sup.slice(0, 6).map((s, i) => `
                <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="flex items-center gap-1.5 min-w-0"><span class="w-2 h-2 rounded-full shrink-0" style="background:${DASH_COLORS[i % DASH_COLORS.length]}"></span><span class="font-semibold text-slate-600 dark:text-slate-300 truncate">${jcEsc(s.supplier)}</span></span>
                    <span class="font-bold text-slate-800 dark:text-slate-100 shrink-0">${dCur(s.spend)} <span class="text-slate-400 font-semibold">${s.pct}%</span></span>
                </div>`).join('') : '<div class="text-xs text-slate-400 italic">No priced receipts in range.</div>';
            const ctx = document.getElementById('dashSupplierChart');
            if (ctx && typeof Chart !== 'undefined') {
                if (dashSupplierChartInstance) dashSupplierChartInstance.destroy();
                dashSupplierChartInstance = new Chart(ctx, {
                    type: 'doughnut',
                    data: { labels: sup.map((s) => s.supplier), datasets: [{ data: sup.map((s) => s.spend), backgroundColor: sup.map((s, i) => DASH_COLORS[i % DASH_COLORS.length]), borderWidth: 0 }] },
                    options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { display: false } } }
                });
            }

            // Daily split table
            const body = document.getElementById('dashDailyBody');
            const daily = o.daily || [];
            if (body) body.innerHTML = daily.length ? daily.map((d) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td class="px-6 py-2.5 font-bold text-slate-700 dark:text-slate-200">${jcDate(d.day)}</td>
                    <td class="px-6 py-2.5 text-right text-indigo-700 dark:text-indigo-400 font-semibold">${d.headOffice ? dCur(d.headOffice) : '—'}</td>
                    <td class="px-6 py-2.5 text-right text-emerald-600 dark:text-emerald-400 font-semibold">${d.local ? dCur(d.local) : '—'}</td>
                    <td class="px-6 py-2.5 text-right text-slate-500 font-semibold">${d.other ? dCur(d.other) : '—'}</td>
                    <td class="px-6 py-2.5 text-right font-extrabold text-slate-900 dark:text-white">${dCur(d.total)}</td>
                </tr>`).join('') : '<tr><td colspan="5" class="px-6 py-8 text-center text-sm font-semibold text-slate-400">No received deliveries in range.</td></tr>';
            const hint = document.getElementById('dashDailyHint');
            if (hint) hint.textContent = daily.length ? `${daily.length} day${daily.length !== 1 ? 's' : ''}` : '';

            // Today's purchase totals (fixed windows, independent of the date range filter)
            if (o.todays) {
                set('kpiTodayLocal', dCur(o.todays.today.local));
                set('kpiTodayHo', dCur(o.todays.today.headOffice));
                set('kpiYdayLocal', 'Yesterday: ' + dCur(o.todays.yesterday.local));
                set('kpiYdayHo', 'Yesterday: ' + dCur(o.todays.yesterday.headOffice));
            }

            // Monthly expenses (chart + table)
            const monthly = (o.monthly || []).slice().reverse(); // oldest -> newest for the chart
            const mctx = document.getElementById('dashMonthlyChart');
            if (mctx && typeof Chart !== 'undefined') {
                if (dashMonthlyChartInstance) dashMonthlyChartInstance.destroy();
                dashMonthlyChartInstance = new Chart(mctx, {
                    type: 'bar',
                    data: {
                        labels: monthly.map((m) => m.month),
                        datasets: [
                            { label: 'Local Purchase', data: monthly.map((m) => m.local), backgroundColor: '#10b981', stack: 's' },
                            { label: 'Head Office Purchase', data: monthly.map((m) => m.headOffice), backgroundColor: '#4f46e5', stack: 's' },
                            { label: 'Other', data: monthly.map((m) => m.other), backgroundColor: '#94a3b8', stack: 's' },
                        ],
                    },
                    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } }
                });
            }
            const mBody = document.getElementById('dashMonthlyBody');
            if (mBody) mBody.innerHTML = (o.monthly || []).length ? o.monthly.map((m) => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td class="px-6 py-2.5 font-bold text-slate-700 dark:text-slate-200">${m.month}</td>
                    <td class="px-6 py-2.5 text-right text-indigo-700 dark:text-indigo-400 font-semibold">${m.headOffice ? dCur(m.headOffice) : '—'}</td>
                    <td class="px-6 py-2.5 text-right text-emerald-600 dark:text-emerald-400 font-semibold">${m.local ? dCur(m.local) : '—'}</td>
                    <td class="px-6 py-2.5 text-right text-slate-500 font-semibold">${m.other ? dCur(m.other) : '—'}</td>
                    <td class="px-6 py-2.5 text-right font-extrabold text-slate-900 dark:text-white">${dCur(m.total)}</td>
                </tr>`).join('') : '<tr><td colspan="5" class="px-6 py-8 text-center text-sm font-semibold text-slate-400">No priced deliveries yet.</td></tr>';

            // Pending items split
            dashPendingData = o.pending || { local: [], headOffice: [], unspecified: [], counts: { local: 0, headOffice: 0, unspecified: 0 } };
            set('kpiPendingLocal', dashPendingData.counts.local);
            set('kpiPendingHo', dashPendingData.counts.headOffice);
            set('pendCountLocal', dashPendingData.counts.local);
            set('pendCountHo', dashPendingData.counts.headOffice);
            set('pendCountUnspec', dashPendingData.counts.unspecified);
            renderPendingTable();
        }

        // ---- Pending-items tabs ------------------------------------------------
        let dashMonthlyChartInstance = null;
        let dashPendingData = null;
        let dashPendingTab = 'headOffice';
        function setPendingTab(tab) {
            dashPendingTab = tab;
            [['pendTabHeadOffice', 'headOffice'], ['pendTabLocal', 'local'], ['pendTabUnspecified', 'unspecified']].forEach(([id, key], i) => {
                const el = document.getElementById(id); if (!el) return;
                el.className = 'px-3 py-1.5 text-xs font-bold ' + (dashPendingTab === key ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300') + (i > 0 ? ' border-l border-slate-200 dark:border-slate-700' : '');
            });
            renderPendingTable();
        }
        function gotoPendingItem(mrn) {
            window.location.hash = '#tracker';
            const si = document.getElementById('searchInput');
            if (si && mrn) { si.value = mrn; si.dispatchEvent(new Event('input')); }
        }
        function renderPendingTable() {
            const body = document.getElementById('dashPendingBody');
            if (!body || !dashPendingData) return;
            const rows = dashPendingData[dashPendingTab] || [];
            const count = (dashPendingData.counts || {})[dashPendingTab] || 0;
            body.innerHTML = rows.length ? rows.map((p) => {
                const overdue = (p.ageDays || 0) > 7;
                const age = (p.ageDays === null || p.ageDays === undefined || p.ageDays < 0 || p.ageDays > 3000) ? '—' : p.ageDays;
                return `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer" onclick="gotoPendingItem(this.dataset.mrn)" data-mrn="${jcEsc(p.mrnNum || '')}">
                    <td class="px-6 py-2.5 font-extrabold text-indigo-700 dark:text-indigo-400">${jcEsc(p.mrnNum || '—')}</td>
                    <td class="px-6 py-2.5 font-semibold text-slate-700 dark:text-slate-200">${jcEsc(p.itemName || '')}</td>
                    <td class="px-6 py-2.5 text-slate-500 font-semibold">${jcEsc(p.vehicleMachinery || '')}</td>
                    <td class="px-6 py-2.5 text-slate-500 font-semibold">${jcEsc(p.reqDate || '')}</td>
                    <td class="px-6 py-2.5 text-right font-extrabold text-slate-900 dark:text-white">${p.outstandingQty} <span class="text-[10px] text-slate-400 font-semibold">of ${p.reqQty}</span></td>
                    <td class="px-6 py-2.5 text-right font-bold ${overdue ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}">${age}</td>
                </tr>`;
            }).join('') + (count > rows.length ? `<tr><td colspan="6" class="px-6 py-3 text-center text-xs font-semibold text-slate-400">Showing first ${rows.length} of ${count} — use the MRN Tracker "Pending Delivery" tab for the full list.</td></tr>` : '')
                : '<tr><td colspan="6" class="px-6 py-8 text-center text-sm font-semibold text-slate-400">Nothing pending in this bucket. 🎉</td></tr>';
        }
// ===== extracted from item_tracker.html lines 8377-8418 =====
        (function () {
            // Any API call that reports an expired/missing session sends us back to login.
            const _fetch = window.fetch;
            window.fetch = function (...args) {
                return _fetch.apply(this, args).then((res) => {
                    if (res && res.status === 401) { window.location.href = '/login'; }
                    return res;
                });
            };
            const initials = (name, username) => {
                const base = (name || username || '?').trim();
                const parts = base.split(/\s+/).filter(Boolean);
                const a = (parts[0] || '?')[0] || '?';
                const b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
                return (a + b).toUpperCase();
            };
            const titleCase = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
            fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((data) => {
                if (!data || !data.user) return;
                const u = data.user;
                window.__me = u;                                  // shared with the Operations module
                const av = document.getElementById('userAvatar');
                const nm = document.getElementById('userName');
                const rl = document.getElementById('userRole');
                if (av) av.textContent = initials(u.name, u.username);
                if (nm) nm.textContent = u.name || u.username;
                if (rl) rl.textContent = (u.roles && u.roles[0]) ? titleCase(u.roles[0]) : '';
                // Operations module hooks (defined in operations.js, loaded after this).
                if (typeof applyRoleScopedNav === 'function') applyRoleScopedNav(u);
                if (typeof startNotifications === 'function') startNotifications();
            }).catch(() => {});
        })();

        function toggleUserDropdown() {
            const d = document.getElementById('userDropdown');
            if (d) d.classList.toggle('hidden');
        }
        document.addEventListener('click', function (e) {
            const c = document.getElementById('userMenuContainer');
            const d = document.getElementById('userDropdown');
            if (c && d && !c.contains(e.target)) d.classList.add('hidden');
        });
        async function logout() {
            try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
            window.location.href = '/login';
        }
