const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'expenses.db');
const db = new Database(dbPath);

console.log('All expenses with notes:');
const rows = db.prepare("SELECT id, what, notes FROM expenses WHERE notes IS NOT NULL AND notes != ''").all();
console.log(rows);

console.log('\nDistinct notes:');
const distinctNotes = db.prepare("SELECT DISTINCT notes FROM expenses WHERE notes != '' ORDER BY notes").all();
console.log(distinctNotes);

console.log('\nAll expenses:');
const allRows = db.prepare('SELECT id, what, notes FROM expenses ORDER BY id DESC LIMIT 5').all();
console.log(allRows);

db.close();
