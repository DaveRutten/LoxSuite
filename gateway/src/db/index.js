// The async facade every route/service in the app talks to instead of a raw driver — backed by
// Knex (see knex.js), but deliberately exposing the SAME shape the old direct better-sqlite3
// handle had (`db.prepare(sql).get/.all/.run(...params)`), just with the terminal methods made
// `async`. That's the whole point: converting a call site is "add one `await`", not rewriting the
// statement — see the project's own db-backend plan for why. `db.transaction(fn)` and
// `db.insertReturningId(sql, params)` are the two real shape changes call sites need (transactions
// are inherently async against a real connection pool; `.lastInsertRowid` isn't portable — see
// their own comments below).
//
// SQLite and Postgres are both wired up (see db/config.js's resolveDbConfig() for how DB_BACKEND
// picks one); MySQL/MariaDB is Phase 5 of the project's own db-backend plan and isn't reachable —
// resolveDbConfig() itself refuses DB_BACKEND=mysql before anything here has to care.
const path = require('path');
const fs = require('fs');
const { createKnex } = require('./knex');
const { resolveDbConfig, describeConfig } = require('./config');
const runLegacySqliteSchema = require('./legacy-sqlite-schema');

let knex = null;
let dbConfig = null;

// Logs any query taking longer than this to the System log — "sometimes slow" reports (e.g. on
// Unraid, where a query can stall on array spin-up or shfs overhead depending on how appdata is
// mapped) are otherwise near-impossible to diagnose remotely; this turns "it happened again" into
// "here's which statement and how long, and when." Ported from the old db.js's own db.prepare
// monkey-patch — ports the SAME threshold/behavior, ONLY around real, post-boot queries now (the
// legacy schema/migration run in init() below is a one-shot boot-time pass through
// legacy-sqlite-schema.js's own plain, unwrapped db.prepare/db.exec, exactly as it always was,
// deliberately not routed through this timer at all — a migration function running slowly once at
// boot isn't the "sometimes slow in production" signal this exists to catch).
// Raised from the original 200ms: verified in practice that a brief burst right after boot
// (retention purges + MQTT/websocket reconnects all firing at once, see startMonitorCollector()/
// startLiveConnections()) routinely pushes even trivial single-row lookups into the hundreds-of-ms
// range for a few seconds — real, but not "structurally slow", and it drowned out the genuinely
// slow queries (multi-second ones) this log exists to surface at all.
const SLOW_QUERY_MS = 3000;
function logSlowQuery(sql, durationMs) {
  // Fire-and-forget — the caller that triggered this already got its own result; logging the fact
  // it was slow shouldn't make it wait even longer. Errors here (e.g. log_entries mid-restore) are
  // swallowed the same way the original wrapper did.
  knex
    .raw(
      'INSERT INTO log_entries (source, source_label, line, recorded_at) VALUES (?, ?, ?, ?)',
      ['system', null, `Slow query (${durationMs}ms): ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`, new Date().toISOString()]
    )
    .catch(() => {});
}

async function execTimed(executor, sql, params) {
  const start = Date.now();
  const result = await executor.raw(sql, params || []);
  const duration = Date.now() - start;
  if (duration >= SLOW_QUERY_MS) logSlowQuery(sql, duration);
  return result;
}

// Normalizes each driver's own raw response shape into a plain row array. SQLite (via Knex's
// better-sqlite3 dialect): a SELECT's raw() result IS already a plain array of row objects.
// Postgres (`pg`): the raw driver result object, rows under `.rows`. MySQL/MariaDB (`mysql2`): raw()
// always returns a 2-element `[rowsOrResultHeader, fieldsMetaOrNull]` tuple — for a SELECT,
// element 0 is itself the rows array (checked via Array.isArray so this never collides with
// SQLite's own bare-rows-array shape, whose first element is always a plain row object, never an
// array). All three verified directly against the installed driver, not assumed (see the project's
// own db-backend plan, Phases 4/5). This is only ever fed a SELECT's raw() result in practice —
// makeStatement's own .all()/.get() are for SELECT, .run() (below) handles INSERT/UPDATE/DELETE.
function normalizeRows(raw) {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0])) return raw[0];
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  return [];
}

// Normalizes each driver's own write-result shape into { changes, lastInsertRowid }. SQLite (via
// Knex's better-sqlite3 dialect): raw() already returns better-sqlite3's own { changes,
// lastInsertRowid } object directly. Postgres has no lastInsertRowid concept at all (needs
// `RETURNING id`, see insertReturningId below) and counts affected rows as `.rowCount` instead of
// `.changes` — lastInsertRowid stays `undefined` there. MySQL/MariaDB's raw() returns
// `[ResultSetHeader, null]` for INSERT/UPDATE/DELETE — affected rows live at `[0].affectedRows`;
// lastInsertRowid stays `undefined` here too (MySQL has no RETURNING at all, MariaDB only ≥10.5 —
// don't rely on it) — every real call site that needs an id uses insertReturningId()/
// tx.insertReturningId() instead (enforced by test/sqlDialect.test.js's own source scan, so nothing
// in application code actually reads this field on any backend).
function normalizeWriteResult(raw) {
  if (Array.isArray(raw) && raw.length === 2 && raw[0] && typeof raw[0].affectedRows === 'number') {
    return { changes: raw[0].affectedRows, lastInsertRowid: undefined };
  }
  if (raw && typeof raw.rowCount === 'number') return { changes: raw.rowCount, lastInsertRowid: undefined };
  return { changes: raw.changes, lastInsertRowid: raw.lastInsertRowid };
}

// executor is a live Knex/transaction instance for a transaction's own tx.prepare(sql) (always
// created fresh per transaction() call, always after init() has run) — passed directly, fixed for
// that transaction's own lifetime. For the top-level prepare() below it's null instead: a
// module-load-time `const stmt = db.prepare(sql)` cache (~12 of these across the app, e.g.
// auditLog.js's insertLogEntry) runs at plain require() time, before db.init() has assigned the
// module-level `knex` variable below (still null then) — capturing that value here would freeze
// every such cached statement onto a permanently-null executor forever, throwing "Cannot read
// properties of null" on its very first real call after boot (caught this exact way, empirically,
// before it shipped). `executor || knex` instead re-reads the live module-level `knex` at CALL
// time, not at prepare() time, so it's whatever init() has since assigned by the time a query
// actually runs.
function makeStatement(executor, sql) {
  return {
    sql,
    async all(...params) {
      return normalizeRows(await execTimed(executor || knex, sql, params));
    },
    async get(...params) {
      const rows = await this.all(...params);
      return rows[0];
    },
    async run(...params) {
      return normalizeWriteResult(await execTimed(executor || knex, sql, params));
    },
  };
}

// db.prepare(sql) — same call shape as before, `.get/.all/.run` are just async now. `prepare()`
// itself does no I/O (matches the old better-sqlite3 behavior closely enough for the ~12
// module-load-time `const stmt = db.prepare(...)` caches elsewhere in the app to keep working
// unchanged), so this is safe to call before init() as long as nothing actually awaits a result
// until after it. No `.iterate()` — confirmed zero call sites for it anywhere outside the old
// db.js itself; every real consumer used `.all()`.
function prepare(sql) {
  return makeStatement(null, sql);
}

// db.insertReturningId(sql, params) — replaces reading `.lastInsertRowid` off a `.run()` result,
// which was a better-sqlite3-specific property with no Postgres/MySQL equivalent. On SQLite/
// Postgres, appends ` RETURNING id` to the given SQL and reads `rows[0].id` back via
// normalizeRows() — verified empirically that this exact clause produces the identical `[{id: N}]`
// shape on SQLite (3.35+, which better-sqlite3 bundles) and Postgres alike via Knex's raw(), so one
// code path covers both rather than branching per backend. Every real call site is a plain `INSERT
// INTO t (...) VALUES (...)` with nothing after it (no trailing semicolon, no ON CONFLICT) —
// confirmed when these were converted (Phase 3), so appending the clause is always syntactically
// safe. MySQL/MariaDB genuinely has no equivalent at all to rely on (MySQL: none, ever; MariaDB:
// only ≥10.5 — see the project's own db-backend plan) — instead reads `.insertId` straight off
// mysql2's own `[ResultSetHeader, null]` raw() result, verified empirically against a real MariaDB
// server. Takes an executor (knex itself, or a transaction's own trx) so transaction() below can
// expose the exact same helper scoped to `tx` instead of the outer `db` — see its own comment for
// why using the wrong one matters.
async function insertReturningIdVia(executor, sql, params) {
  if (getBackend() === 'mysql') {
    const raw = await execTimed(executor, sql, params);
    return raw[0].insertId;
  }
  const rows = normalizeRows(await execTimed(executor, `${sql} RETURNING id`, params));
  return rows[0].id;
}
async function insertReturningId(sql, params) {
  return insertReturningIdVia(knex, sql, params);
}

// db.transaction(async (tx) => { ... await tx.prepare(sql).run(...); ... }) — replaces
// better-sqlite3's synchronous db.transaction(fn); fn() pattern. The one thing every call site
// converting to this MUST do: use the `tx` passed into the callback for every query inside it, not
// the outer `db` — see knex.js's own comment on why the SQLite pool is pinned to exactly one
// connection, which is what turns a missed rebind into an immediate, loud deadlock instead of a
// silent correctness bug (Postgres's own real pool doesn't have that same safety net — see knex.js
// again). `tx.insertReturningId`/`tx.upsert`/`tx.insertIgnore` mirror the top-level db.* helpers of
// the same name, scoped to this same transaction connection.
async function transaction(fn) {
  return knex.transaction((trx) => fn({
    prepare: (sql) => makeStatement(trx, sql),
    insertReturningId: (sql, params) => insertReturningIdVia(trx, sql, params),
    upsert: (table, row, conflictColumns) => upsertVia(trx, table, row, conflictColumns),
    insertIgnore: (table, row, conflictColumns) => insertIgnoreVia(trx, table, row, conflictColumns),
  }));
}

// db.upsert(table, row, conflictColumns) — the query-builder equivalent of a hand-written
// `INSERT ... ON CONFLICT(...) DO UPDATE SET col = excluded.col, ...` — replaces every such
// raw-SQL upsert (Phase 3 of the project's own db-backend plan): the exact ON CONFLICT syntax
// genuinely differs enough across SQLite/Postgres/MySQL (MySQL has no ON CONFLICT at all — it needs
// `ON DUPLICATE KEY UPDATE`) that Knex's query builder, not raw SQL text, is what actually needs to
// paper over the difference. `row` sets every column (including the conflict target columns
// themselves, same as the raw SQL this replaces); every non-conflict-target column in `row` is what
// gets updated on conflict, matching `DO UPDATE SET col = excluded.col` for each one.
async function upsertVia(executor, table, row, conflictColumns) {
  return execTimedBuilder(executor(table).insert(row).onConflict(conflictColumns).merge());
}
async function upsert(table, row, conflictColumns) {
  return upsertVia(knex, table, row, conflictColumns);
}

// db.insertIgnore(table, row, conflictColumns) — the query-builder equivalent of SQLite's own
// `INSERT OR IGNORE`. Unlike plain `INSERT OR IGNORE` (which silently no-ops on ANY constraint
// violation, whichever one it happens to hit), this targets the SPECIFIC conflictColumns — every
// call site this replaces only ever had one real unique constraint in play to begin with (a
// composite PRIMARY KEY or a single UNIQUE), so this is behaviorally identical for all of them
// while also being what Postgres/MySQL both actually require (they have no equivalent of a
// constraint-agnostic "ignore anything that collides").
async function insertIgnoreVia(executor, table, row, conflictColumns) {
  return execTimedBuilder(executor(table).insert(row).onConflict(conflictColumns).ignore());
}
async function insertIgnore(table, row, conflictColumns) {
  return insertIgnoreVia(knex, table, row, conflictColumns);
}

// Shared timing/slow-query-log wrapper for the two query-builder helpers above — same treatment
// execTimed() gives every raw-SQL call, just around a Knex query-builder promise (`.toString()`
// for the logged SQL text) instead of a SQL string this facade was handed directly.
async function execTimedBuilder(builder) {
  const start = Date.now();
  const result = await builder;
  const duration = Date.now() - start;
  if (duration >= SLOW_QUERY_MS) logSlowQuery(builder.toString(), duration);
  return result;
}

// Direct escape hatch for anything that doesn't fit the get/all/run shape (used sparingly).
async function raw(sql, params) {
  return execTimed(knex, sql, params);
}

function getBackend() {
  return dbConfig ? dbConfig.backend : 'sqlite';
}

// Powers Administration > General's own read-only "Database" row — backend, server version,
// host/database name. Deliberately never the password, and deliberately read-only in the UI (see
// that page's own copy) — changing DB_BACKEND/DATABASE_URL/DB_* is a restart, not a live toggle
// (the connection is opened before any settings row can even be read — see the project's own
// db-backend plan for why this could never be a live Settings-page control).
async function getInfo() {
  if (dbConfig.backend === 'postgres') {
    const rows = normalizeRows(await knex.raw('SHOW server_version'));
    return {
      backend: 'postgres',
      version: rows[0]?.server_version || null,
      host: dbConfig.connection.host,
      port: dbConfig.connection.port,
      database: dbConfig.connection.database,
    };
  }
  if (dbConfig.backend === 'mysql') {
    // Reports as e.g. "11.8.8-MariaDB-ubu2404" on MariaDB or "8.4.2" on MySQL — shown as-is (not
    // parsed into a bare number) since the "-MariaDB-..." suffix is itself useful information on
    // this page, same reasoning as Postgres's own SHOW server_version above.
    const rows = normalizeRows(await knex.raw('SELECT VERSION() AS v'));
    return {
      backend: 'mysql',
      version: rows[0]?.v || null,
      host: dbConfig.connection.host,
      port: dbConfig.connection.port,
      database: dbConfig.connection.database,
    };
  }
  const rows = normalizeRows(await knex.raw('SELECT sqlite_version() AS v'));
  return { backend: 'sqlite', version: rows[0]?.v || null, dbPath: dbConfig.dbPath };
}

// Narrow escape hatch for the one caller that genuinely needs the underlying Knex instance itself
// rather than the get/all/run facade — the session store (server.js), since connect-session-knex's
// own API takes a live Knex instance directly (`new KnexStore({ knex: db.getKnex(), ... })`), not a
// SQL string/params pair. Not for general use — everything else should go through prepare()/
// transaction()/raw() above so it stays backend-agnostic.
function getKnex() {
  return knex;
}

// The other narrow escape hatch: hands a caller the SAME live raw connection prepare()/transaction()
// use (acquired from the pool, released back afterward — never a second, independent connection),
// for the one thing that needs the actual driver object rather than a SQL string: backup.js's own
// SQLite engine (`await conn.backup(tmpPath)`, better-sqlite3's online hot-copy API). SQLite only —
// Postgres has its own backup engine that shells out to pg_dump/pg_restore instead (see backup/
// engines/postgres.js), which needs this database's own CONNECTION PARAMETERS to build that command
// line, not a raw driver handle, so it never calls this at all.
async function withRawConnection(fn) {
  if (dbConfig.backend !== 'sqlite') {
    throw new Error(`withRawConnection() is SQLite-only; the current backend is "${dbConfig.backend}".`);
  }
  const conn = await knex.client.acquireConnection();
  try {
    return await fn(conn);
  } finally {
    knex.client.releaseConnection(conn);
  }
}

// Hand-creates Knex's own two bookkeeping tables (verified empirically against this exact
// better-sqlite3 dialect/Knex version — see the project's own db-backend plan) and records
// 001_baseline.js as already applied, batch 1, WITHOUT actually running it — its schema-creation
// half would fail outright against tables that already exist. This is the one-time handoff for an
// upgrading SQLite install that just walked the legacy path (see runLegacySqliteSchema above): from
// this point on, every future boot sees knex_migrations already present and goes straight to the
// knex.migrate.latest() call below, running only whatever numbered migration comes after this one.
// SQLite-only — Postgres never had a legacy (pre-migration-framework) install to upgrade FROM in the
// first place, so it never needs this handoff at all (see initSqlite/initPostgres below).
function stampBaselineAsApplied(conn) {
  conn.exec('CREATE TABLE `knex_migrations` (`id` integer not null primary key autoincrement, `name` varchar(255), `batch` integer, `migration_time` datetime)');
  conn.exec('CREATE TABLE `knex_migrations_lock` (`index` integer not null primary key autoincrement, `is_locked` integer)');
  conn.prepare('INSERT INTO knex_migrations_lock (is_locked) VALUES (0)').run();
  conn.prepare('INSERT INTO knex_migrations (name, batch, migration_time) VALUES (?, 1, ?)').run('001_baseline.js', new Date().toISOString());
}

// Three possible states for a SQLite database, told apart by what's already in sqlite_master (see
// the project's own db-backend plan, Phase 2, for the full reasoning):
//  1. Genuinely fresh (no app tables at all — a brand new file, or ':memory:') — nothing to do here;
//     knex.migrate.latest() below creates knex's own bookkeeping tables AND runs 001_baseline.js for
//     real, building the whole schema (and seeding roles/settings/the shared Dashboard/the first
//     admin user) from scratch.
//  2. Already has `knex_migrations` — this database has been through this exact handoff (or a fresh
//     install) before; knex.migrate.latest() below is a no-op unless a numbered migration after
//     001_baseline.js has since been added.
//  3. Has app tables (e.g. `users`) but no `knex_migrations` — an upgrading SQLite install that
//     predates this migration framework entirely. Walks the full frozen legacy path exactly as
//     every boot always has, then gets stamped into state 2 so every FUTURE boot skips it.
async function initSqlite(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  // A restore staged via the Administration > Backups page (see backup.js's stageRestore()) can't
  // swap the live database out from under an already-open connection, so it just drops the
  // replacement file next to it and waits — this is the other half of that handoff, applied once at
  // startup before anything opens the real path. Same restart-to-apply model as the MQTT
  // dynamic-security.json restore, which mosquitto only re-reads on its own restart. File-based, so
  // SQLite-only — Postgres's own restore flow (Phase 4c) uses a different staging mechanism, since
  // there's no local file to swap.
  const pendingRestorePath = `${config.dbPath}.restore`;
  if (fs.existsSync(pendingRestorePath)) {
    fs.renameSync(pendingRestorePath, config.dbPath);
    console.log(`Applied a staged database restore from ${pendingRestorePath}.`);
  }

  knex = createKnex(config);

  // Acquires Knex's OWN pooled connection (released back afterward, never destroyed) rather than
  // opening-then-closing an independent `new Database(dbPath)` handle — that distinction only
  // matters for `:memory:` (used by the test suite): a second, independently-opened `:memory:`
  // connection is a WHOLE DIFFERENT empty database, not the same one, so closing the first would
  // silently throw away everything just migrated. Reusing Knex's own connection sidesteps that
  // entirely, for a file-backed DB and `:memory:` alike.
  const conn = await knex.client.acquireConnection();
  let upgradedFromLegacy = false;
  try {
    const hasKnexMigrations = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knex_migrations'").get();
    if (!hasKnexMigrations) {
      const hasLegacyAppTables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (hasLegacyAppTables) {
        runLegacySqliteSchema(conn, config.dbPath);
        stampBaselineAsApplied(conn);
        upgradedFromLegacy = true;
      }
    }
  } finally {
    knex.client.releaseConnection(conn);
  }

  await knex.migrate.latest();
  if (upgradedFromLegacy) {
    console.log('Brought an existing SQLite database up to date via the legacy migration path; future schema changes apply via Knex migrations from here on.');
  }
}

// Postgres never had a pre-migration-framework install to upgrade FROM — this backend didn't exist
// before 001_baseline.js did — so every Postgres boot is either genuinely fresh (migrate.latest()
// runs 001_baseline.js for real) or already-migrated (a no-op unless something after it has since
// been added). No legacy path, no stamping. It DOES have its own restore-staging file to check for
// (see applyPendingPostgresRestore() below) — just not a local db FILE to swap the way SQLite's
// own initSqlite() does, since a pg_dump archive gets applied via pg_restore against the live
// connection instead. A real network database also frequently isn't listening yet the instant this
// container starts (Docker's own `depends_on` has no built-in "wait until actually ready" without
// an explicit healthcheck) — the connectivity preflight below retries a plain `SELECT 1` with
// backoff instead of letting the very first real query fail with a raw, unhelpful "connection
// refused".
async function waitForPostgresReady(config) {
  const deadlineMs = Date.now() + config.connectTimeoutMs * config.connectRetries;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await knex.raw('SELECT 1');
      if (attempt > 1) console.log(`Connected to Postgres after ${attempt} attempt(s).`);
      return;
    } catch (err) {
      if (Date.now() >= deadlineMs || attempt >= config.connectRetries) {
        console.error('='.repeat(78));
        console.error(`Could not connect to Postgres after ${attempt} attempt(s): ${err.message}`);
        console.error(`Tried: ${describeConfig(config)}`);
        console.error('='.repeat(78));
        throw err;
      }
      console.warn(`Postgres not reachable yet (attempt ${attempt}/${config.connectRetries}): ${err.message} — retrying in ${Math.round(config.connectTimeoutMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, config.connectTimeoutMs));
    }
  }
}

// Same path formula backup.js's own PENDING_POSTGRES_RESTORE_PATH uses — recomputed independently
// here rather than imported, same "don't create a cross-module coupling for one shared constant"
// convention this codebase already uses for the SQLite equivalent (initSqlite's own
// `${config.dbPath}.restore`, and see backup.js's own comment on DB_PATH for the same reasoning).
// Postgres has no local db FILE to derive a path from, so this still anchors on DB_PATH purely as
// "wherever backups/ lives" — meaningful even though DB_PATH itself is otherwise unused on this
// backend.
function pendingPostgresRestorePath() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'gateway.db');
  return path.join(path.dirname(dbPath), 'backups', '.pending-restore.pgdump');
}

// Applies a restore staged via Administration > Backups (see backup/engines/postgres.js's own
// validateAndStage()) before anything else touches this connection — pg_restore --clean drops and
// recreates every object the dump contains, so doing this before migrate.latest() below avoids
// migrate.latest() building a fresh baseline schema this immediately throws away again. Delegates
// to backup/engines/postgres.js directly (not backup.js) — backup.js itself requires this module,
// so requiring it back from here would be a cycle; the engine module has no such dependency (see
// its own comment).
async function applyPendingPostgresRestore() {
  // eslint-disable-next-line global-require -- see the comment above on why this can't be a
  // top-level require alongside knex.js/config.js's own.
  const postgresEngine = require('../backup/engines/postgres');
  await postgresEngine.applyPendingRestoreAtBoot(pendingPostgresRestorePath());
}

async function initPostgres(config) {
  knex = createKnex(config);
  await waitForPostgresReady(config);
  await applyPendingPostgresRestore();
  await knex.migrate.latest();
}

// Same reasoning as waitForPostgresReady() above, generalized: MySQL/MariaDB never had a
// pre-migration-framework install to upgrade FROM either (this backend didn't exist before
// 001_baseline.js did), and a real network database frequently isn't listening yet the instant
// this container starts.
async function waitForMysqlReady(config) {
  const deadlineMs = Date.now() + config.connectTimeoutMs * config.connectRetries;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await knex.raw('SELECT 1');
      if (attempt > 1) console.log(`Connected to MySQL/MariaDB after ${attempt} attempt(s).`);
      return;
    } catch (err) {
      if (Date.now() >= deadlineMs || attempt >= config.connectRetries) {
        console.error('='.repeat(78));
        console.error(`Could not connect to MySQL/MariaDB after ${attempt} attempt(s): ${err.message}`);
        console.error(`Tried: ${describeConfig(config)}`);
        console.error('='.repeat(78));
        throw err;
      }
      console.warn(`MySQL/MariaDB not reachable yet (attempt ${attempt}/${config.connectRetries}): ${err.message} — retrying in ${Math.round(config.connectTimeoutMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, config.connectTimeoutMs));
    }
  }
}

// Mirrors pendingPostgresRestorePath() above — see its own comment for why this is a second
// independent formula rather than a shared import with backup.js.
function pendingMysqlRestorePath() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'gateway.db');
  return path.join(path.dirname(dbPath), 'backups', '.pending-restore.sql');
}

// Mirrors applyPendingPostgresRestore() above — same require-cycle reasoning (backup.js requires
// this module, so this module requires the engine directly instead of going back through backup.js).
async function applyPendingMysqlRestore() {
  // eslint-disable-next-line global-require -- see the comment above.
  const mysqlEngine = require('../backup/engines/mysql');
  await mysqlEngine.applyPendingRestoreAtBoot(pendingMysqlRestorePath());
}

async function initMysql(config) {
  knex = createKnex(config);
  await waitForMysqlReady(config);
  await applyPendingMysqlRestore();
  await knex.migrate.latest();
}

// Opens the database and brings its schema up to date. Must be awaited before anything else in the
// app touches the DB — see server.js's own async bootstrap.
async function init() {
  dbConfig = resolveDbConfig();
  console.log(`Database backend: ${describeConfig(dbConfig)}`);
  if (dbConfig.backend === 'postgres') await initPostgres(dbConfig);
  else if (dbConfig.backend === 'mysql') await initMysql(dbConfig);
  else await initSqlite(dbConfig);
}

async function close() {
  if (knex) await knex.destroy();
  knex = null;
}

module.exports = { init, close, prepare, transaction, insertReturningId, upsert, insertIgnore, raw, getBackend, getInfo, getKnex, withRawConnection };
