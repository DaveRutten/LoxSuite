// Shared async init helper for any test that touches the database — replaces the old pattern of
// setting process.env.DB_PATH = ':memory:' before a plain `require('../src/db')`, which worked
// when db.js opened its connection and ran every migration synchronously at require() time. The
// async Knex facade (gateway/src/db/) does none of that until init() is explicitly awaited, so
// every DB-touching test file now needs `before(async () => { await initTestDb(); })` (or the
// equivalent) instead of relying on require() alone to leave a ready database behind.
process.env.DB_PATH = ':memory:';

const db = require('../../src/db');

async function initTestDb() {
  await db.init();
  return db;
}

module.exports = { initTestDb, db };
