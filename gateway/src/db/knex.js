// Builds the Knex instance for whichever backend is configured. SQLite (via the `better-sqlite3`
// dialect — the same driver this app always used, so the file format/WAL mode/location are
// unchanged) is the only backend actually wired up right now; Postgres/MySQL client branches land
// in later phases of the multi-backend rollout (see the project's own db-backend plan) as
// additional cases in buildKnexConfig, not a rewrite of this file.
const path = require('path');
const Knex = require('knex');

function buildKnexConfig(dbPath) {
  return {
    client: 'better-sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
    // Every install (any backend) that's never run the legacy SQLite path at all gets its schema
    // from 001_baseline.js onward — see db/index.js's own init() for the fresh-vs-upgrading-install
    // branch, and the project's own db-backend plan (Phase 2) for why the 45 hand-written legacy
    // migrations are frozen rather than folded into this numbered sequence.
    migrations: {
      directory: path.join(__dirname, 'migrations'),
    },
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
        // Off by default (matches this app's entire history — every hand-rolled cascade delete,
        // e.g. admin.js's own user-delete route, explicitly cleans up join-table rows itself rather
        // than relying on ON DELETE CASCADE actually firing). Opt-in only, for the test suite, per
        // the project's own db-backend plan: enforcing it there surfaces any orphan-row assumption
        // this codebase has silently gotten away with before Phase 4's real Postgres transfer has
        // to deal with the exact same rows for real, where the equivalent constraint genuinely is
        // enforced. See test/foreignKeys.test.js.
        if (process.env.DB_ENFORCE_FOREIGN_KEYS === '1') conn.pragma('foreign_keys = ON');
        cb();
      },
    },
  };
}

function createKnex(dbPath) {
  return Knex(buildKnexConfig(dbPath));
}

module.exports = { createKnex, buildKnexConfig };
