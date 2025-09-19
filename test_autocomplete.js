const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'expenses.db');
const db = new Database(dbPath);

// Test the notes autocomplete query with a simple test
console.log('Testing notes autocomplete with query "tra":');
const query = 'tra';
const rows = db.prepare("SELECT DISTINCT notes FROM expenses WHERE notes LIKE ? AND notes != '' ORDER BY notes").all(`%${query}%`);
console.log(rows.map(row => row.notes));

console.log('\nTesting notes autocomplete with query "trip":');
const query2 = 'trip';
const rows2 = db.prepare("SELECT DISTINCT notes FROM expenses WHERE notes LIKE ? AND notes != '' ORDER BY notes").all(`%${query2}%`);
console.log(rows2.map(row => row.notes));

db.close();
