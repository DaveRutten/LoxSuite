// Detects, once at boot, whether this install just switched DB_BACKEND away from SQLite onto an
// otherwise-empty Postgres/MySQL database while a real, already-used SQLite file is still sitting
// at DB_PATH — the exact situation that silently loses every user/Miniserver/Monitor/etc. unless
// gateway/src/db/transfer.js is run by hand (see that file's own comment, and the setup wizard's
// own "existing SQLite data found" step in routes/setup.js, which is what actually surfaces this).
// Same in-memory-cache-refreshed-once shape as versionCheck.js's getVersionStatus() — a plain,
// cheap-to-call-per-request getter backed by a one-time (here: once per boot, not on a timer) check,
// since the SQLite file's own content can't change again once nothing but this check still reads it.
const path = require('path');
const db = require('./db');
const { hasImportableData } = require('./db/transfer');

const state = { available: false, sqlitePath: null };

// Recomputed independently here rather than imported from db/config.js — same "don't create a
// cross-module coupling for one shared constant" convention db/index.js's own
// pendingPostgresRestorePath()/pendingMysqlRestorePath() already use for this exact formula.
function defaultSqlitePath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gateway.db');
}

// Called once from server.js's boot sequence, after db.init() — a no-op on a SQLite-backed install
// (there's nothing to import INTO itself) and on one that's already resolved this (imported, or
// explicitly dismissed via the wizard step) so a restart never re-asks.
async function startSqliteImportCheck() {
  if (db.getBackend() === 'sqlite') return;
  const settings = await db.prepare('SELECT sqlite_import_resolved_at FROM gateway_settings WHERE id = 1').get();
  if (settings?.sqlite_import_resolved_at) return;
  state.sqlitePath = defaultSqlitePath();
  state.available = await hasImportableData(state.sqlitePath);
}

function getSqliteImportStatus() {
  return state;
}

// Flips the in-memory flag immediately (so the banner/redirect disappears on this same running
// process without waiting for a restart) and persists it, same two-step shape as every other
// once-ever setup-wizard flag (see routes/setup.js's own markCompleted).
async function markResolved() {
  await db.prepare('UPDATE gateway_settings SET sqlite_import_resolved_at = ? WHERE id = 1').run(new Date().toISOString());
  state.available = false;
}

module.exports = { startSqliteImportCheck, getSqliteImportStatus, markResolved };
