#!/usr/bin/env node
// One-time SQLite -> Postgres/MySQL data transfer — the thing that makes an external-database
// backend actually usable to an existing user, not just to a brand-new install (see the project's
// own db-backend plan, Phase 4b: "without this, Postgres support is unusable to every existing
// user" — the same reasoning applies to Phase 5's MySQL/MariaDB support). Reachable two ways: this
// file run directly as a CLI (see main() below), or its scanSource()/hasImportableData()/
// runTransfer() exports called from the setup wizard's own "existing SQLite data found" step (see
// routes/setup.js) — same logic either way, just a different source of inputs and a different sink
// for progress lines (console.log vs. a streamed HTTP response).
//
// CLI usage (unchanged from before the wizard reused this logic):
//   node src/db/transfer.js --from-sqlite /data/gateway.db --to "postgres://user:pass@host:5432/db" [options]
//   node src/db/transfer.js --from-sqlite /data/gateway.db --to "mysql://user:pass@host:3306/db" --backend mysql [options]
//
// Options:
//   --from-sqlite <path>   Source SQLite file. Falls back to DB_PATH / .env if omitted.
//   --to <url>             Target DATABASE_URL. Falls back to DATABASE_URL / .env if omitted.
//   --backend <name>       Target backend: "postgres" (default) or "mysql".
//   --dry-run              Report what WOULD happen (row counts, orphan scan) without touching the
//                          target at all — no connection to it is even required to be reachable yet.
//   --prune-orphans        Skip rows that would violate a foreign key the target backend enforces
//                          unconditionally but SQLite never has (see db/migrations/001_baseline.js's
//                          own comment on this). Without this flag, ANY orphan found aborts the
//                          transfer — silently dropping someone's data is never the default.
//   --force                Required if the target already has non-default data in it (see
//                          assertTargetIsBlank below) — this tool overwrites, not merges.
//
// What it does, in order: (1) scans the source for orphan rows against every FK the baseline schema
// declares — SQLite itself never enforced these, so a long-lived install can easily have some;
// (2) runs the target's migrations to build a fresh schema (idempotent — a schema that's already
// there is left alone); (3) truncates every app table on the target (the migration's own
// seedFreshInstall() already populated default roles/settings/the shared Dashboard — this transfer
// replaces that with the SOURCE's real data instead, in the same tables); (4) copies every table,
// in FK-safe order, preserving explicit primary keys; (5) resets every Postgres SERIAL sequence past
// the highest id just inserted — skipping this is the single easiest thing to get wrong here (see
// the plan's own risk-ranking): the copied rows were inserted with explicit ids that never touched
// the sequence, so the very next app-level insert (which doesn't specify one) would collide with an
// id the transfer just used; (6) reports a per-table source-vs-target row count.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { createKnex } = require('./knex');
const { resolveDbConfig, describeConfig } = require('./config');

// Every app table the baseline schema creates, in FK-safe dependency order — this is deliberately
// the SAME order db/migrations/001_baseline.js's own `exports.up` creates them in (a table only
// ever references one created before it), so copying data in this order never hits a dangling FK on
// the way in. `hasSerialId: true` marks the tables whose `id` is a real auto-increment column (Knex
// `t.increments('id')`) that needs its Postgres sequence reset after a copy with explicit ids;
// singleton settings tables (`t.integer('id').primary()`, always id=1, never auto-incrementing) and
// pure join tables (composite primary key, no surrogate id at all) don't have one.
// Kept as a hand-maintained mirror of that migration rather than introspected from it at runtime —
// simpler, and this file already needs updating in lockstep with any schema change of that shape
// (the FK list below is the same tradeoff).
const TABLES = [
  { name: 'access_roles', hasSerialId: true },
  { name: 'users', hasSerialId: true },
  { name: 'access_role_permissions', hasSerialId: false },
  { name: 'miniservers', hasSerialId: true },
  { name: 'mqtt_settings', hasSerialId: false },
  { name: 'gateway_settings', hasSerialId: false },
  { name: 'sso_settings', hasSerialId: false },
  { name: 'backup_settings', hasSerialId: false },
  { name: 'command_catalog_overrides', hasSerialId: false },
  { name: 'mappings_mqtt_to_loxone', hasSerialId: true },
  { name: 'mapping_translations', hasSerialId: true },
  { name: 'mappings_loxone_to_mqtt', hasSerialId: true },
  { name: 'loxone_mapping_translations', hasSerialId: true },
  { name: 'user_table_prefs', hasSerialId: false },
  { name: 'user_nav_prefs', hasSerialId: false },
  { name: 'monitors', hasSerialId: true },
  { name: 'monitor_history', hasSerialId: true },
  { name: 'custom_dashboards', hasSerialId: true },
  { name: 'dashboard_panels', hasSerialId: true },
  { name: 'dashboard_panel_monitors', hasSerialId: false },
  { name: 'panel_type_defaults', hasSerialId: false },
  { name: 'dashboard_shares', hasSerialId: false },
  { name: 'dashboard_role_shares', hasSerialId: false },
  { name: 'dashboard_favorites', hasSerialId: false },
  { name: 'log_entries', hasSerialId: true },
  { name: 'notification_channels', hasSerialId: true },
  { name: 'notification_rules', hasSerialId: true },
  { name: 'notification_rule_channels', hasSerialId: false },
  { name: 'notification_rule_subscribers', hasSerialId: false },
  { name: 'notification_events', hasSerialId: true },
  { name: 'notification_dismissals', hasSerialId: false },
  { name: 'loxone_hardware_devices', hasSerialId: true },
];

// Every FK the baseline schema declares (mirrors each `.references('id').inTable(...)` call in
// 001_baseline.js) — used only for the pre-flight orphan scan below. `notification_events.rule_id`/
// `notification_dismissals.notification_event_id` are deliberately NOT here, matching that
// migration's own comment on why a real FK there would be wrong (it'd let deleting a rule or an
// event silently erase persisted history).
const FOREIGN_KEYS = [
  { table: 'users', column: 'role_id', refTable: 'access_roles' },
  { table: 'access_role_permissions', column: 'role_id', refTable: 'access_roles' },
  { table: 'miniservers', column: 'gateway_client_of', refTable: 'miniservers' },
  { table: 'sso_settings', column: 'default_role_id', refTable: 'access_roles' },
  { table: 'mappings_mqtt_to_loxone', column: 'miniserver_id', refTable: 'miniservers' },
  { table: 'mapping_translations', column: 'mapping_id', refTable: 'mappings_mqtt_to_loxone' },
  { table: 'mappings_loxone_to_mqtt', column: 'miniserver_id', refTable: 'miniservers' },
  { table: 'loxone_mapping_translations', column: 'mapping_id', refTable: 'mappings_loxone_to_mqtt' },
  { table: 'user_table_prefs', column: 'user_id', refTable: 'users' },
  { table: 'user_nav_prefs', column: 'user_id', refTable: 'users' },
  { table: 'monitors', column: 'miniserver_id', refTable: 'miniservers' },
  { table: 'monitor_history', column: 'monitor_id', refTable: 'monitors' },
  { table: 'custom_dashboards', column: 'user_id', refTable: 'users' },
  { table: 'dashboard_panels', column: 'dashboard_id', refTable: 'custom_dashboards' },
  { table: 'dashboard_panel_monitors', column: 'panel_id', refTable: 'dashboard_panels' },
  { table: 'dashboard_panel_monitors', column: 'monitor_id', refTable: 'monitors' },
  { table: 'panel_type_defaults', column: 'dashboard_id', refTable: 'custom_dashboards' },
  { table: 'dashboard_shares', column: 'dashboard_id', refTable: 'custom_dashboards' },
  { table: 'dashboard_shares', column: 'user_id', refTable: 'users' },
  { table: 'dashboard_role_shares', column: 'dashboard_id', refTable: 'custom_dashboards' },
  { table: 'dashboard_role_shares', column: 'role_id', refTable: 'access_roles' },
  { table: 'dashboard_favorites', column: 'user_id', refTable: 'users' },
  { table: 'dashboard_favorites', column: 'dashboard_id', refTable: 'custom_dashboards' },
  { table: 'notification_rules', column: 'owner_user_id', refTable: 'users' },
  { table: 'notification_rule_channels', column: 'rule_id', refTable: 'notification_rules' },
  { table: 'notification_rule_channels', column: 'channel_id', refTable: 'notification_channels' },
  { table: 'notification_rule_subscribers', column: 'rule_id', refTable: 'notification_rules' },
  { table: 'notification_rule_subscribers', column: 'user_id', refTable: 'users' },
  { table: 'notification_dismissals', column: 'user_id', refTable: 'users' },
  { table: 'loxone_hardware_devices', column: 'miniserver_id', refTable: 'miniservers' },
];

// Rows are inserted in batches rather than one INSERT per row (network round-trip per row would be
// painfully slow for a table like monitor_history/log_entries, which can easily run into the tens
// of thousands) or all at once (a single multi-thousand-row INSERT statement is its own risk —
// driver/parameter limits, memory). Arbitrary but generous middle ground.
const BATCH_SIZE = 500;

const TARGET_BACKENDS = ['postgres', 'mysql'];

function parseArgs(argv) {
  const args = { dryRun: false, pruneOrphans: false, force: false, backend: 'postgres' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-sqlite') args.fromSqlite = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
    else if (arg === '--backend') args.backend = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--prune-orphans') args.pruneOrphans = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!TARGET_BACKENDS.includes(args.backend)) {
    console.error(`--backend must be one of ${TARGET_BACKENDS.map((b) => `"${b}"`).join(', ')} — got "${args.backend}".`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
SQLite -> Postgres/MySQL data transfer

Usage:
  node src/db/transfer.js --from-sqlite <path> --to <url> [--backend postgres|mysql] [--dry-run] [--prune-orphans] [--force]

Options:
  --from-sqlite <path>   Source SQLite file (default: DB_PATH from the environment)
  --to <url>             Target DATABASE_URL (default: DATABASE_URL from the environment)
  --backend <name>       Target backend: "postgres" (default) or "mysql"
  --dry-run              Report row counts and orphan-row findings; touches only the source
  --prune-orphans        Skip rows that would violate a foreign key the target backend enforces
                          instead of aborting the transfer when any are found
  --force                Proceed even though the target already has non-default data in it
  --help                 Show this message
`);
}

// Every FK's referenced-id set, loaded once up front from the SOURCE database so the orphan scan
// below is a set of in-memory lookups rather than N queries against SQLite per row. Only the tables
// actually named as an FK's refTable need one — every one of those has a real `id` column (nothing
// ever references a pure join table's composite key) — so this doesn't iterate all of TABLES.
async function loadIdSets(sourceKnex) {
  const idSets = {};
  const refTables = [...new Set(FOREIGN_KEYS.map((fk) => fk.refTable))];
  for (const tableName of refTables) {
    const rows = await sourceKnex(tableName).select('id');
    idSets[tableName] = new Set(rows.map((r) => r.id));
  }
  return idSets;
}

// Returns one finding per FK that has at least one orphaned row, for the report main() prints (and,
// via --prune-orphans, for copyTable() to skip the same rows later) — read-only and side-effect-free
// so --dry-run and the real run share identical logic. `fk.table` here can be a plain join table
// with no surrogate `id` at all (composite primary key instead — see TABLES' own hasSerialId note),
// so the sample descriptor falls back to the whole row rather than assuming one exists.
async function scanForOrphans(sourceKnex, idSets) {
  const findings = [];
  for (const fk of FOREIGN_KEYS) {
    const rows = await sourceKnex(fk.table).select('*').whereNotNull(fk.column);
    const refIds = idSets[fk.refTable];
    const orphanRows = rows.filter((r) => !refIds.has(r[fk.column]));
    if (orphanRows.length > 0) {
      const sample = orphanRows.slice(0, 5).map((r) => (r.id !== undefined ? `id=${r.id}` : JSON.stringify(r)));
      findings.push({ table: fk.table, column: fk.column, refTable: fk.refTable, count: orphanRows.length, sample });
    }
  }
  return findings;
}

function rowViolatesAnyFk(table, row, idSets) {
  return FOREIGN_KEYS.some((fk) => {
    if (fk.table !== table) return false;
    const value = row[fk.column];
    if (value === null || value === undefined) return false;
    return !idSets[fk.refTable].has(value);
  });
}

// Refuses to silently overwrite a target that already looks "lived in" — the migration's own
// seedFreshInstall() always creates exactly 2 access_roles (Administrator/Viewer) and 1
// custom_dashboards row (the shared home Dashboard) on a truly fresh install; more than that means
// someone has actually used this database already. --force overrides (e.g. re-running a transfer
// deliberately, onto a target already migrated by a previous attempt of this same tool).
async function assertTargetIsBlank(targetKnex, force, backendLabel) {
  const [{ count: roleCount }] = await targetKnex('access_roles').count({ count: '*' });
  const [{ count: userCount }] = await targetKnex('users').count({ count: '*' });
  const looksUsed = Number(roleCount) > 2 || Number(userCount) > 0;
  if (looksUsed && !force) {
    throw new Error(
      `The target ${backendLabel} database already has non-default data in it (more than the ` +
      'default Administrator/Viewer roles, or an existing user). Refusing to overwrite it — pass ' +
      '--force if this is intentional (e.g. re-running a previous transfer attempt).'
    );
  }
}

// TRUNCATE's own FK-safety story genuinely differs per backend: Postgres's TRUNCATE ... CASCADE
// follows foreign keys itself, so table order doesn't matter. MySQL/MariaDB's plain TRUNCATE
// refuses outright to touch a table any OTHER table's foreign key points at — CASCADE isn't a
// TRUNCATE option there at all — so foreign_key_checks is disabled for the duration instead (the
// same approach mysqldump's own generated restore scripts use), truncating in any order and
// re-enabling checks afterward. RESTART IDENTITY (Postgres) resets every serial sequence back to 1
// as part of the same statement; MySQL's AUTO_INCREMENT resets to 1 on TRUNCATE automatically, no
// separate clause needed.
async function truncateAllTables(targetKnex, backend) {
  if (backend === 'mysql') {
    await targetKnex.raw('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const table of TABLES) await targetKnex.raw('TRUNCATE TABLE ??', [table.name]);
    } finally {
      await targetKnex.raw('SET FOREIGN_KEY_CHECKS = 1');
    }
    return;
  }
  for (const table of TABLES) {
    await targetKnex.raw(`TRUNCATE TABLE ?? RESTART IDENTITY CASCADE`, [table.name]);
  }
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Copies one table's rows from source to target, in FK-safe order relative to every OTHER table
// (see TABLES' own ordering comment), skipping any row an earlier orphan scan flagged. Only ever
// called once the caller has already established that's safe to do unconditionally — either the
// scan found no orphans at all, or the user explicitly passed --prune-orphans (main() aborts before
// reaching here otherwise) — so there's no separate flag to check at this point. Returns { copied,
// skipped, total }.
async function copyTable(sourceKnex, targetKnex, table, idSets) {
  const rows = await sourceKnex(table.name).select('*');
  const toInsert = [];
  let skipped = 0;
  for (const row of rows) {
    if (rowViolatesAnyFk(table.name, row, idSets)) {
      skipped += 1;
      continue;
    }
    toInsert.push(row);
  }
  if (toInsert.length > 0) {
    for (const batch of chunk(toInsert, BATCH_SIZE)) {
      await targetKnex(table.name).insert(batch);
    }
  }
  return { copied: toInsert.length, skipped, total: rows.length };
}

// The step the plan's own risk-ranking explicitly calls out as easy to miss: rows were just inserted
// WITH explicit ids (preserving the source's own primary keys, so every FK reference elsewhere stays
// correct), which never touches an auto-increment column's own counter — that counter only advances
// on inserts that let the DB pick the id. Left alone, the very first ordinary app-level insert after
// this transfer (which does NOT specify an id) starts back at 1 and collides with a row this
// transfer just created. Postgres and MySQL/MariaDB track this counter completely differently, so
// the fix is backend-specific: Postgres's `pg_get_serial_sequence` finds the sequence actually
// attached to this column (rather than assuming a naming convention), and `setval(..., MAX(id),
// true)` advances it to start handing out MAX(id)+1 next — the `COALESCE(MAX(id), 1)` + `false`
// fallback for an empty table avoids advancing an unused sequence at all (setval's own "is_called"
// argument). MySQL/MariaDB has no separate sequence object at all — AUTO_INCREMENT is a per-table
// property set directly via `ALTER TABLE ... AUTO_INCREMENT = N`, where N is the NEXT value to hand
// out (MAX(id)+1, not MAX(id) itself — no "is_called" equivalent needed; an empty table's
// AUTO_INCREMENT is already 1 immediately after TRUNCATE, so this only needs to run when there's
// actually a MAX(id) to advance past).
async function resetSequences(targetKnex, backend) {
  for (const table of TABLES.filter((t) => t.hasSerialId)) {
    if (backend === 'mysql') {
      const [{ maxId }] = await targetKnex(table.name).max({ maxId: 'id' });
      if (maxId !== null) await targetKnex.raw('ALTER TABLE ?? AUTO_INCREMENT = ?', [table.name, maxId + 1]);
      continue;
    }
    await targetKnex.raw(
      `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ??), 1), (SELECT MAX(id) FROM ??) IS NOT NULL)`,
      [table.name, table.name, table.name]
    );
  }
}

// Read-only pre-flight report (row counts + orphan findings) — what --dry-run prints, and what the
// setup wizard's own "existing SQLite data found" step shows before offering to actually run the
// import. Never opens the target at all.
async function scanSource(fromSqlitePath) {
  if (!fs.existsSync(fromSqlitePath)) {
    throw new Error(`Source SQLite file not found: ${fromSqlitePath}`);
  }
  const sourceKnex = createKnex(fromSqlitePath);
  try {
    const idSets = await loadIdSets(sourceKnex);
    const orphanFindings = await scanForOrphans(sourceKnex, idSets);
    const rowCounts = [];
    for (const table of TABLES) {
      const [{ count }] = await sourceKnex(table.name).count({ count: '*' });
      rowCounts.push({ table: table.name, count: Number(count) });
    }
    return { rowCounts, orphanFindings };
  } finally {
    await sourceKnex.destroy();
  }
}

// Cheap existence-and-"has real data" check — just enough to decide whether the setup wizard should
// even mention an import is possible, without the fuller (slower) scan scanSource() above does on
// every FK. "Real data" mirrors assertTargetIsBlank's own "looks used" rule below: more than the two
// seed roles, or an actual user — the same bar a genuinely-fresh SQLite file would never clear.
async function hasImportableData(fromSqlitePath) {
  if (!fromSqlitePath || !fs.existsSync(fromSqlitePath)) return false;
  const knex = createKnex(fromSqlitePath);
  try {
    const [{ count: roleCount }] = await knex('access_roles').count({ count: '*' });
    const [{ count: userCount }] = await knex('users').count({ count: '*' });
    return Number(roleCount) > 2 || Number(userCount) > 0;
  } catch {
    return false; // not a LoxSuite database, or a schema too old for these tables to exist yet
  } finally {
    await knex.destroy();
  }
}

// The write path itself — connects to both databases, validates, truncates, copies, resets
// sequences, verifies. Used identically by main()'s CLI run and by the setup wizard's own streaming
// route (routes/setup.js); onLog is the only thing that differs between them (console.log vs. a
// callback that writes into a chunked HTTP response). Throws on any abort condition (orphans found
// without pruneOrphans, target not blank without force, a connectivity error) instead of exiting the
// process itself — only the CLI wrapper below does that. Returns { report, mismatch }.
async function runTransfer({ fromSqlitePath, targetConfig, backend, pruneOrphans, force, onLog = () => {} }) {
  if (!fs.existsSync(fromSqlitePath)) {
    throw new Error(`Source SQLite file not found: ${fromSqlitePath}`);
  }

  const sourceKnex = createKnex(fromSqlitePath);
  let targetKnex = null;
  try {
    onLog('Scanning source for orphaned foreign-key values (SQLite never enforced these)...');
    const idSets = await loadIdSets(sourceKnex);
    const orphanFindings = await scanForOrphans(sourceKnex, idSets);

    if (orphanFindings.length > 0) {
      onLog('');
      onLog('Found rows whose foreign key points at a row that no longer exists:');
      for (const f of orphanFindings) {
        onLog(`  ${f.table}.${f.column} -> ${f.refTable}.id: ${f.count} row(s), e.g. ${f.sample.join(', ')}`);
      }
      if (!pruneOrphans) {
        throw new Error(
          'Found orphaned foreign-key rows — pass --prune-orphans to skip them and transfer ' +
          'everything else, or clean them up in the source database first.'
        );
      }
      onLog('--prune-orphans given — these rows will be skipped.');
    } else {
      onLog('No orphaned foreign-key values found.');
    }

    onLog('');
    onLog('Row counts (source):');
    for (const table of TABLES) {
      const [{ count }] = await sourceKnex(table.name).count({ count: '*' });
      onLog(`  ${table.name}: ${count}`);
    }

    onLog('');
    onLog('Connecting to target and building schema (migrate.latest)...');
    targetKnex = createKnex(targetConfig);
    await targetKnex.raw('SELECT 1'); // fail fast with a clear error before anything destructive
    // Must run BEFORE assertTargetIsBlank() below — on a genuinely fresh target there's no
    // access_roles/users table to even query yet; migrate.latest() creates them (seeded with the
    // same default rows every fresh install gets) and is a no-op if the schema's already there.
    await targetKnex.migrate.latest();
    await assertTargetIsBlank(targetKnex, force, backend);

    onLog('Clearing default-seeded data from the target so the source data replaces it...');
    await truncateAllTables(targetKnex, backend);

    onLog('');
    onLog('Copying tables...');
    const report = [];
    for (const table of TABLES) {
      const result = await copyTable(sourceKnex, targetKnex, table, idSets);
      report.push({ table: table.name, ...result });
      onLog(`  ${table.name}: copied ${result.copied}/${result.total}${result.skipped ? ` (skipped ${result.skipped} orphaned)` : ''}`);
    }

    onLog('');
    onLog(backend === 'mysql' ? 'Resetting AUTO_INCREMENT counters past the highest transferred id...' : 'Resetting Postgres sequences past the highest transferred id...');
    await resetSequences(targetKnex, backend);

    onLog('');
    onLog('Verifying row counts on target...');
    let mismatch = false;
    for (const row of report) {
      const [{ count }] = await targetKnex(row.table).count({ count: '*' });
      const targetCount = Number(count);
      const ok = targetCount === row.copied;
      if (!ok) mismatch = true;
      onLog(`  ${row.table}: source ${row.total} -> copied ${row.copied} -> target has ${targetCount}${ok ? '' : '  <-- MISMATCH'}`);
    }

    return { report, mismatch };
  } finally {
    await sourceKnex.destroy();
    if (targetKnex) await targetKnex.destroy();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const fromSqlitePath = args.fromSqlite || process.env.DB_PATH;
  if (!fromSqlitePath) {
    console.error('No source given — pass --from-sqlite <path> or set DB_PATH.');
    process.exit(1);
  }
  if (!fs.existsSync(fromSqlitePath)) {
    console.error(`Source SQLite file not found: ${fromSqlitePath}`);
    process.exit(1);
  }

  // Reuses db/config.js's own validation (unknown scheme, missing host/db, bad DB_SSL, ...) instead
  // of re-implementing it — --to just overrides DATABASE_URL for the duration of this process before
  // calling the same resolveDbConfig() the server itself boots with, and forces the backend to
  // whatever --backend says regardless of whatever DB_BACKEND happens to already be set to (this
  // tool's whole job is producing that target; a stray DB_BACKEND=sqlite left in the environment
  // shouldn't silently make it validate the wrong thing).
  if (args.to) process.env.DATABASE_URL = args.to;
  process.env.DB_BACKEND = args.backend;
  const targetConfig = resolveDbConfig();

  console.log(`Source (SQLite): ${fromSqlitePath}`);
  console.log(`Target (${args.backend}): ${describeConfig(targetConfig)}`);
  if (args.dryRun) console.log('DRY RUN — the target will not be touched.');
  console.log('');

  if (args.dryRun) {
    const { rowCounts, orphanFindings } = await scanSource(fromSqlitePath);
    console.log('Scanning source for orphaned foreign-key values (SQLite never enforced these)...');
    if (orphanFindings.length > 0) {
      console.log('');
      console.log('Found rows whose foreign key points at a row that no longer exists:');
      for (const f of orphanFindings) {
        console.log(`  ${f.table}.${f.column} -> ${f.refTable}.id: ${f.count} row(s), e.g. ${f.sample.join(', ')}`);
      }
      console.log('');
      console.log('Re-run without --dry-run and pass --prune-orphans to skip these rows (or clean them up first).');
    } else {
      console.log('No orphaned foreign-key values found.');
    }
    console.log('');
    console.log('Row counts (source):');
    for (const row of rowCounts) console.log(`  ${row.table}: ${row.count}`);
    console.log('');
    console.log('Dry run complete — nothing was written.');
    return;
  }

  try {
    const { mismatch } = await runTransfer({
      fromSqlitePath, targetConfig, backend: args.backend,
      pruneOrphans: args.pruneOrphans, force: args.force, onLog: console.log,
    });
    console.log('');
    if (mismatch) {
      console.log('Transfer finished with row-count mismatches — see above. Do not switch DB_BACKEND to');
      console.log(`${args.backend} for the running app until this is investigated.`);
      process.exitCode = 1;
    } else {
      console.log(`Transfer complete. Set DB_BACKEND=${args.backend} (and DATABASE_URL/DB_* as used above) and`);
      console.log('restart LoxSuite to switch over.');
    }
  } catch (err) {
    console.error('');
    console.error('Transfer failed:', err.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('');
    console.error('Transfer failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { TABLES, FOREIGN_KEYS, parseArgs, scanSource, hasImportableData, runTransfer };
