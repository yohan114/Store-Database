const fs = require('fs');

let html = fs.readFileSync('item_tracker.html', 'utf8');
const newLayout = fs.readFileSync('new_layout.html', 'utf8');

// Replace everything between </head> and <script>
html = html.replace(/<\/head>[\s\S]*?<script>/, newLayout);

// Add modal functions inside script
const newJsFunctions = `
        const addModal = document.getElementById('addModal');
        function openAddModal() { addModal.classList.remove('hidden'); }
        function closeAddModal() { addModal.classList.add('hidden'); addForm.reset(); document.getElementById('reqDate').valueAsDate = new Date(); }
`;

// Insert the functions right after "// DOM Elements"
html = html.replace(/\/\/ DOM Elements/, '// DOM Elements\n' + newJsFunctions);

// We need to fix the addForm 'submit' event to call closeAddModal() upon success
// Let's replace the fetch block in addForm submit handler
const addFormHandlerRegex = /(addForm\.addEventListener\('submit', async \(e\) => \{[\s\S]*?)(renderTable\(\);)/;
html = html.replace(addFormHandlerRegex, '$1$2\n            closeAddModal();');

// Also update the empty history logic for Receive modal
const openModalRegex = /(function openModal\(id\) \{[\s\S]*?receiptHistoryContainer\.classList\.remove\('hidden'\);)/;
html = html.replace(openModalRegex, '$1\n                document.getElementById("emptyHistoryState").classList.add("hidden");');

const openModalNoReceiptsRegex = /(receiptHistoryContainer\.classList\.add\('hidden'\);)/;
html = html.replace(openModalNoReceiptsRegex, '$1\n                document.getElementById("emptyHistoryState").classList.remove("hidden");');

fs.writeFileSync('item_tracker.html', html);
console.log('HTML Patched successfully!');
