// Builds the Knex instance for whichever backend is configured (see db/config.js's own
// resolveDbConfig() for how DB_BACKEND/DATABASE_URL/DB_* env vars turn into the `config` object
// every function here takes). SQLite (via the `better-sqlite3` dialect — the same driver this app
// always used, so the file format/WAL mode/location are unchanged) and Postgres (via `pg`, a pure
// JS driver, no native compile step) are both wired up; MySQL/MariaDB (`client: 'mysql2'`) is
// Phase 5 of the project's own db-backend plan and isn't reachable yet — db/config.js's own
// resolveDbConfig() already refuses DB_BACKEND=mysql before anything here would need to care.
const path = require('path');
const Knex = require('knex');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function buildSqliteKnexConfig(dbPath) {
  return {
    client: 'better-sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
    // Every install (any backend) that's never run the legacy SQLite path at all gets its schema
    // from 001_baseline.js onward — see db/index.js's own init() for the fresh-vs-upgrading-install
    // branch, and the project's own db-backend plan (Phase 2) for why the 45 hand-written legacy
    // migrations are frozen rather than folded into this numbered sequence.
    migrations: {
      directory: MIGRATIONS_DIR,
    },
    // Exactly one physical connection. better-sqlite3 is a single, synchronous, in-process
    // connection to begin with — pooling more than one against the same file buys nothing and only
    // risks two callers interleaving statements against what SQLite itself treats as one
    // connection's own transaction/statement state. It also has a deliberate side effect relied on
    // elsewhere (see index.js's transaction()): a caller inside a wrapped transaction that forgets
    // to use the transaction's own `tx` handle and calls the outer `db` instead deadlocks
    // immediately and loudly in dev/CI, instead of quietly running outside the transaction it was
    // supposed to be part of. Postgres below gets a REAL pool instead (a genuinely concurrent
    // network database benefits from one, unlike a single in-process SQLite file) — the same
    // missed-rebind bug just no longer deadlocks loudly there, it silently runs outside the
    // transaction on a different pooled connection instead; by Phase 4 every transaction() call
    // site was already converted and tested against the SQLite pool's own strict version of this.
    pool: {
      min: 1,
      max: 1,
      afterCreate(conn, cb) {
        conn.pragma('journal_mode = WAL');
        // Off by default (matches this app's entire history — every hand-rolled cascade delete,
        // e.g. admin.js's own user-delete route, explicitly cleans up join-table rows itself rather
        // than relying on ON DELETE CASCADE actually firing). Opt-in only, for the test suite, per
        // the project's own db-backend plan: enforcing it there surfaces any orphan-row assumption
        // this codebase has silently gotten away with before a real Postgres transfer has to deal
        // with the exact same rows for real, where the equivalent constraint genuinely is enforced
        // unconditionally. See test/foreignKeys.test.js.
        if (process.env.DB_ENFORCE_FOREIGN_KEYS === '1') conn.pragma('foreign_keys = ON');
        cb();
      },
    },
  };
}

function buildPostgresKnexConfig(config) {
  return {
    client: 'pg',
    connection: {
      host: config.connection.host,
      port: config.connection.port,
      database: config.connection.database,
      user: config.connection.user,
      password: config.connection.password,
      ssl: config.connection.ssl,
    },
    migrations: {
      directory: MIGRATIONS_DIR,
    },
    pool: { min: 1, max: config.poolMax },
  };
}

// Accepts either a plain dbPath string (SQLite — the shape every existing caller/test already
// uses, kept working unchanged) or a full config object from db/config.js's resolveDbConfig()
// (either backend, `{ backend: 'sqlite', dbPath }` or `{ backend: 'postgres', connection, ... }`).
function buildKnexConfig(configOrDbPath) {
  const config = typeof configOrDbPath === 'string' ? { backend: 'sqlite', dbPath: configOrDbPath } : configOrDbPath;
  if (config.backend === 'postgres') return buildPostgresKnexConfig(config);
  return buildSqliteKnexConfig(config.dbPath);
}

function createKnex(configOrDbPath) {
  return Knex(buildKnexConfig(configOrDbPath));
}

module.exports = { createKnex, buildKnexConfig };
