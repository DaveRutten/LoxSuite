// The async facade every route/service in the app talks to instead of a raw driver — backed by
// Knex (see knex.js), but deliberately exposing the SAME shape the old direct better-sqlite3
// handle had (`db.prepare(sql).get/.all/.run(...params)`), just with the terminal methods made
// `async`. That's the whole point: converting a call site is "add one `await`", not rewriting the
// statement — see the project's own db-backend plan for why. `db.transaction(fn)` and
// `db.insertReturningId(sql, params)` are the two real shape changes call sites need (transactions
// are inherently async against a real connection pool; `.lastInsertRowid` isn't portable — see
// their own comments below).
//
// SQLite only, for now. `getBackend()` always returns 'sqlite' until the multi-backend config
// module (Phase 4/5 of the db-backend plan) exists — every other function here is already written
// against the Knex abstraction, not against better-sqlite3 directly, so adding Postgres/MySQL later
// is additive (a `client:'pg'/'mysql2'` branch in knex.js, a per-backend `insertReturningId`/
// row-normalization branch here), not a rewrite of this file.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createKnex } = require('./knex');
const runLegacySqliteSchema = require('./legacy-sqlite-schema');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'gateway.db');
// A restore staged via the Administration > Backups page (see backup.js's stageRestore()) can't
// swap the live database out from under an already-open connection, so it just drops the
// replacement file next to it and waits — this is the other half of that handoff, applied once at
// startup before anything opens DB_PATH for real. Same restart-to-apply model as the MQTT
// dynamic-security.json restore, which mosquitto only re-reads on its own restart.
const PENDING_RESTORE_PATH = `${DB_PATH}.restore`;

let knex = null;

// Logs any query taking longer than this to the System log — "sometimes slow" reports (e.g. on
// Unraid, where a query can stall on array spin-up or shfs overhead depending on how appdata is
// mapped) are otherwise near-impossible to diagnose remotely; this turns "it happened again" into
// "here's which statement and how long, and when." Ported from the old db.js's own db.prepare
// monkey-patch — ports the SAME threshold/behavior, ONLY around real, post-boot queries now (the
// legacy schema/migration run in init() below is a one-shot boot-time pass through
// legacy-sqlite-schema.js's own plain, unwrapped db.prepare/db.exec, exactly as it always was,
// deliberately not routed through this timer at all — a migration function running slowly once at
// boot isn't the "sometimes slow in production" signal this exists to catch).
const SLOW_QUERY_MS = 200;
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
// better-sqlite3 dialect): a SELECT's raw() result IS already a plain array — verified directly
// against the installed driver, not assumed. Postgres (`raw.rows`) / MySQL (`raw[0]`) branches land
// here once those backends exist (Phase 4/5 of the db-backend plan).
function normalizeRows(raw) {
  if (Array.isArray(raw)) return raw;
  return [];
}

// Normalizes each driver's own write-result shape into { changes, lastInsertRowid }. SQLite (via
// Knex's better-sqlite3 dialect): raw() already returns better-sqlite3's own { changes,
// lastInsertRowid } object directly — verified directly against the installed driver. Postgres has
// no lastInsertRowid concept at all (needs `RETURNING id`, see insertReturningId below); MySQL's
// `result.insertId` has a different name/shape. Those branches land here in Phase 4/5.
function normalizeWriteResult(raw) {
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

// db.transaction(async (tx) => { ... await tx.prepare(sql).run(...); ... }) — replaces
// better-sqlite3's synchronous db.transaction(fn); fn() pattern. The one thing every call site
// converting to this MUST do: use the `tx` passed into the callback for every query inside it, not
// the outer `db` — see knex.js's own comment on why the SQLite pool is pinned to exactly one
// connection, which is what turns a missed rebind into an immediate, loud deadlock instead of a
// silent correctness bug.
async function transaction(fn) {
  return knex.transaction((trx) => fn({ prepare: (sql) => makeStatement(trx, sql) }));
}

// db.insertReturningId(sql, params) — replaces reading `.lastInsertRowid` off a `.run()` result,
// which was a better-sqlite3-specific property with no Postgres equivalent (needs `RETURNING id`)
// and a different shape on MySQL (`result.insertId`). SQLite: identical to today, just async and a
// named result field. Postgres/MySQL branches land here in Phase 4/5 of the db-backend plan —
// documented here now so every call site that needs it converts to this helper once, up front,
// rather than needing a second pass later.
async function insertReturningId(sql, params) {
  const result = await prepare(sql).run(...(params || []));
  return result.lastInsertRowid;
}

// Direct escape hatch for anything that doesn't fit the get/all/run shape (used sparingly).
async function raw(sql, params) {
  return execTimed(knex, sql, params);
}

function getBackend() {
  return 'sqlite';
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
// `await conn.backup(tmpPath)` (better-sqlite3's online hot-copy API, see that file). SQLite only —
// this is exactly the kind of driver-specific escape hatch that gets its own per-backend
// implementation once Postgres/MySQL backups exist (Phase 4/5 of the db-backend plan), not extended
// here.
async function withRawConnection(fn) {
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
function stampBaselineAsApplied(conn) {
  conn.exec('CREATE TABLE `knex_migrations` (`id` integer not null primary key autoincrement, `name` varchar(255), `batch` integer, `migration_time` datetime)');
  conn.exec('CREATE TABLE `knex_migrations_lock` (`index` integer not null primary key autoincrement, `is_locked` integer)');
  conn.prepare('INSERT INTO knex_migrations_lock (is_locked) VALUES (0)').run();
  conn.prepare('INSERT INTO knex_migrations (name, batch, migration_time) VALUES (?, 1, ?)').run('001_baseline.js', new Date().toISOString());
}

// Opens the database and brings its schema up to date. Must be awaited before anything else in the
// app touches the DB — see server.js's own async bootstrap.
//
// Three possible states, told apart by what's already in sqlite_master (see the project's own
// db-backend plan, Phase 2, for the full reasoning):
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
async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (fs.existsSync(PENDING_RESTORE_PATH)) {
    fs.renameSync(PENDING_RESTORE_PATH, DB_PATH);
    console.log(`Applied a staged database restore from ${PENDING_RESTORE_PATH}.`);
  }

  knex = createKnex(DB_PATH);

  // Acquires Knex's OWN pooled connection (released back afterward, never destroyed) rather than
  // opening-then-closing an independent `new Database(DB_PATH)` handle — that distinction only
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
        runLegacySqliteSchema(conn, DB_PATH);
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

async function close() {
  if (knex) await knex.destroy();
  knex = null;
}

module.exports = { init, close, prepare, transaction, insertReturningId, raw, getBackend, getKnex, withRawConnection };
