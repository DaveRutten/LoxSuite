// Builds the Knex instance for whichever backend is configured. SQLite (via the `better-sqlite3`
// dialect — the same driver this app always used, so the file format/WAL mode/location are
// unchanged) is the only backend actually wired up right now; Postgres/MySQL client branches land
// in later phases of the multi-backend rollout (see the project's own db-backend plan) as
// additional cases in buildKnexConfig, not a rewrite of this file.
const Knex = require('knex');

function buildKnexConfig(dbPath) {
  return {
    client: 'better-sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
    // Exactly one physical connection. better-sqlite3 is a single, synchronous, in-process
    // connection to begin with — pooling more than one against the same file buys nothing and only
    // risks two callers interleaving statements against what SQLite itself treats as one
    // connection's own transaction/statement state. It also has a deliberate side effect relied on
    // elsewhere (see index.js's transaction()): a caller inside a wrapped transaction that forgets
    // to use the transaction's own `tx` handle and calls the outer `db` instead deadlocks
    // immediately and loudly in dev/CI, instead of quietly running outside the transaction it was
    // supposed to be part of.
    pool: {
      min: 1,
      max: 1,
      afterCreate(conn, cb) {
        conn.pragma('journal_mode = WAL');
        cb();
      },
    },
  };
}

function createKnex(dbPath) {
  return Knex(buildKnexConfig(dbPath));
}

module.exports = { createKnex, buildKnexConfig };
