const fs = require('fs');
let html = fs.readFileSync('item_tracker.html', 'utf8');
html = html.replace(/<button[^>]+onclick="setupAutoSave\(\)"[^>]*>[\s\S]*?<\/button>/, '');
fs.writeFileSync('item_tracker.html', html);
console.log('Removed setupAutoSave button');
