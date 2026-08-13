// Builds the Knex instance for whichever backend is configured (see db/config.js's own
// resolveDbConfig() for how DB_BACKEND/DATABASE_URL/DB_* env vars turn into the `config` object
// every function here takes). SQLite (via the `better-sqlite3` dialect — the same driver this app
// always used, so the file format/WAL mode/location are unchanged), Postgres (via `pg`, a pure JS
// driver, no native compile step), and MySQL/MariaDB (via `mysql2`, works against either server)
// are all wired up here.
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

// node-postgres returns BIGINT columns (COUNT(*), SUM() over an integer, ...) as a STRING by
// default — a real, driver-level precision-safety default (a bigint can exceed
// Number.MAX_SAFE_INTEGER, which a plain JS number can't represent exactly), but one this app never
// needs: every count/sum here is a row tally or similar, nowhere near that range. Left at the
// driver's default, a genuine bug surfaced twice already once Postgres was actually exercised for
// real: "0" is a non-empty string, so JS's own falsy check (`if (!count)`, e.g. foot.ejs's
// notification badge) treats a real zero as truthy, and a strict `===` comparison against a plain
// number (e.g. routes/monitor.js's own `panelCount === 0` unused-monitor filter) never matches at
// all regardless of the actual count — both silently correct on SQLite (better-sqlite3 returns a
// real number there) and silently wrong on Postgres. Fixed once, globally, at the driver level
// (pg's own type-parser registry, OID 20 = int8/bigint) rather than auditing/patching every
// individual call site this could affect. Guarded so calling buildPostgresKnexConfig() more than
// once (the app's own knex instance, transfer.js's separate one, ...) only registers it once.
let pgBigintParserSet = false;
function ensurePgBigintParser() {
  if (pgBigintParserSet) return;
  require('pg').types.setTypeParser(20, (val) => parseInt(val, 10));
  pgBigintParserSet = true;
}

function buildPostgresKnexConfig(config) {
  ensurePgBigintParser();
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

function buildMysqlKnexConfig(config) {
  return {
    client: 'mysql2',
    connection: {
      host: config.connection.host,
      port: config.connection.port,
      database: config.connection.database,
      user: config.connection.user,
      password: config.connection.password,
      ssl: config.connection.ssl,
      // utf8mb4, not MySQL's own default utf8 (which only supports up to 3-byte characters — real
      // 4-byte emoji/astral-plane text silently mangles). timezone 'Z' stores/reads DATETIME as
      // UTC through the driver rather than the server's own local timezone setting, matching this
      // app's own convention everywhere else (every timestamp column is ISO-8601 UTC text — see
      // 001_baseline.js's own comment on why booleans/timestamps stay backend-neutral primitives).
      charset: 'utf8mb4',
      timezone: 'Z',
    },
    migrations: {
      directory: MIGRATIONS_DIR,
    },
    pool: { min: 1, max: config.poolMax },
  };
}

// Accepts either a plain dbPath string (SQLite — the shape every existing caller/test already
// uses, kept working unchanged) or a full config object from db/config.js's resolveDbConfig()
// (any backend: `{ backend: 'sqlite', dbPath }`, `{ backend: 'postgres', connection, ... }`, or
// `{ backend: 'mysql', connection, ... }`).
function buildKnexConfig(configOrDbPath) {
  const config = typeof configOrDbPath === 'string' ? { backend: 'sqlite', dbPath: configOrDbPath } : configOrDbPath;
  if (config.backend === 'postgres') return buildPostgresKnexConfig(config);
  if (config.backend === 'mysql') return buildMysqlKnexConfig(config);
  return buildSqliteKnexConfig(config.dbPath);
}

function createKnex(configOrDbPath) {
  return Knex(buildKnexConfig(configOrDbPath));
}

module.exports = { createKnex, buildKnexConfig };
