// Shared Turso connection for the maintenance scripts.
// Mirrors the client setup in server.js so scripts hit the same database.
require('dotenv').config();
const { createClient } = require('@libsql/client');

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    console.error('Missing required environment variables: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN');
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
}

const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// libsql returns Row objects; JSON needs plain ones. BigInt has no JSON
// representation, so integer columns are narrowed to Number here.
function toRows(result) {
    return result.rows.map(row =>
        Object.fromEntries(result.columns.map((col, i) => {
            const v = row[i];
            return [col, typeof v === 'bigint' ? Number(v) : v];
        }))
    );
}

module.exports = { db, toRows };
