#!/usr/bin/env node
// One-time SQLite -> Postgres data transfer CLI — the thing that makes Postgres support actually
// usable to an existing user, not just to a brand-new install (see the project's own db-backend
// plan, Phase 4b: "without this, Postgres support is unusable to every existing user").
//
// Usage (matches the plan's own example):
//   node src/db/transfer.js --from-sqlite /data/gateway.db --to "postgres://user:pass@host:5432/db" [options]
//
// Options:
//   --from-sqlite <path>   Source SQLite file. Falls back to DB_PATH / .env if omitted.
//   --to <url>             Target Postgres DATABASE_URL. Falls back to DATABASE_URL / .env if omitted.
//   --dry-run              Report what WOULD happen (row counts, orphan scan) without touching the
//                          target at all — no connection to it is even required to be reachable yet.
//   --prune-orphans        Skip rows that would violate a foreign key Postgres enforces unconditionally
//                          but SQLite never has (see db/migrations/001_baseline.js's own comment on
//                          this). Without this flag, ANY orphan found aborts the transfer — silently
//                          dropping someone's data is never the default.
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

function parseArgs(argv) {
  const args = { dryRun: false, pruneOrphans: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-sqlite') args.fromSqlite = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--prune-orphans') args.pruneOrphans = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
SQLite -> Postgres data transfer

Usage:
  node src/db/transfer.js --from-sqlite <path> --to <postgres-url> [--dry-run] [--prune-orphans] [--force]

Options:
  --from-sqlite <path>   Source SQLite file (default: DB_PATH from the environment)
  --to <url>             Target Postgres DATABASE_URL (default: DATABASE_URL from the environment)
  --dry-run              Report row counts and orphan-row findings; touches only the source
  --prune-orphans        Skip rows that would violate a Postgres-enforced foreign key instead of
                          aborting the transfer when any are found
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
// someone has actually used this Postgres database already. --force overrides (e.g. re-running a
// transfer deliberately, onto a target already migrated by a previous attempt of this same tool).
async function assertTargetIsBlank(targetKnex, force) {
  const [{ count: roleCount }] = await targetKnex('access_roles').count({ count: '*' });
  const [{ count: userCount }] = await targetKnex('users').count({ count: '*' });
  const looksUsed = Number(roleCount) > 2 || Number(userCount) > 0;
  if (looksUsed && !force) {
    throw new Error(
      'The target Postgres database already has non-default data in it (more than the default ' +
      'Administrator/Viewer roles, or an existing user). Refusing to overwrite it — pass --force if ' +
      'this is intentional (e.g. re-running a previous transfer attempt).'
    );
  }
}

async function truncateAllTables(targetKnex) {
  // TRUNCATE ... RESTART IDENTITY CASCADE in one statement per table: RESTART IDENTITY resets every
  // serial sequence back to 1 (harmless no-op on the singleton/join tables that don't have one),
  // CASCADE follows FKs so table order doesn't matter here the way it does for the inserts below.
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
// correct), which never touches a SERIAL column's sequence — the sequence only advances on inserts
// that let Postgres pick the id. Left alone, the very first ordinary app-level insert after this
// transfer (which does NOT specify an id) starts back at 1 and collides with a row this transfer
// just created. `pg_get_serial_sequence` finds the sequence Postgres actually attached to this
// column (rather than assuming a naming convention), and `setval(..., MAX(id), true)` advances it to
// start handing out MAX(id)+1 next; the `COALESCE(MAX(id), 1)` + `false` fallback for an empty table
// avoids advancing an unused sequence at all (setval's own "is_called" argument).
async function resetSequences(targetKnex) {
  for (const table of TABLES.filter((t) => t.hasSerialId)) {
    await targetKnex.raw(
      `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ??), 1), (SELECT MAX(id) FROM ??) IS NOT NULL)`,
      [table.name, table.name, table.name]
    );
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
  // postgres regardless of whatever DB_BACKEND happens to already be set to (this tool's whole job
  // is producing a postgres target; a stray DB_BACKEND=sqlite left in the environment shouldn't
  // silently make it validate the wrong thing).
  if (args.to) process.env.DATABASE_URL = args.to;
  process.env.DB_BACKEND = 'postgres';
  const targetConfig = resolveDbConfig();

  console.log(`Source (SQLite): ${fromSqlitePath}`);
  console.log(`Target (Postgres): ${describeConfig(targetConfig)}`);
  if (args.dryRun) console.log('DRY RUN — the target will not be touched.');
  console.log('');

  const sourceKnex = createKnex(fromSqlitePath);
  let targetKnex = null;

  try {
    console.log('Scanning source for orphaned foreign-key values (SQLite never enforced these)...');
    const idSets = await loadIdSets(sourceKnex);
    const orphanFindings = await scanForOrphans(sourceKnex, idSets);

    if (orphanFindings.length > 0) {
      console.log('');
      console.log('Found rows whose foreign key points at a row that no longer exists:');
      for (const f of orphanFindings) {
        console.log(`  ${f.table}.${f.column} -> ${f.refTable}.id: ${f.count} row(s), e.g. ${f.sample.join(', ')}`);
      }
      if (!args.pruneOrphans) {
        console.log('');
        // A real (non-dry) run without --prune-orphans stops here — silently dropping someone's
        // data is never the default. --dry-run never writes anything regardless, so there's nothing
        // to protect by aborting early; it falls through to the row-count report below instead, same
        // as the --prune-orphans path, so the report always shows the full picture.
        if (!args.dryRun) {
          console.log('Aborting — pass --prune-orphans to skip these rows and transfer everything else,');
          console.log('or clean them up in the source database first.');
          process.exit(1);
        }
        console.log('Re-run without --dry-run and pass --prune-orphans to skip these rows (or clean them up first).');
      } else {
        console.log('--prune-orphans given — these rows will be skipped.');
      }
    } else {
      console.log('No orphaned foreign-key values found.');
    }

    // Row-count report happens even in dry-run mode — it's the other half of "what would happen".
    console.log('');
    console.log('Row counts (source):');
    for (const table of TABLES) {
      const [{ count }] = await sourceKnex(table.name).count({ count: '*' });
      console.log(`  ${table.name}: ${count}`);
    }

    if (args.dryRun) {
      console.log('');
      console.log('Dry run complete — nothing was written.');
      return;
    }

    console.log('');
    console.log('Connecting to target and building schema (migrate.latest)...');
    targetKnex = createKnex(targetConfig);
    await targetKnex.raw('SELECT 1'); // fail fast with a clear error before anything destructive
    // Must run BEFORE assertTargetIsBlank() below — on a genuinely fresh target there's no
    // access_roles/users table to even query yet; migrate.latest() creates them (seeded with the
    // same default rows every fresh install gets) and is a no-op if the schema's already there.
    await targetKnex.migrate.latest();
    await assertTargetIsBlank(targetKnex, args.force);

    console.log('Clearing default-seeded data from the target so the source data replaces it...');
    await truncateAllTables(targetKnex);

    console.log('');
    console.log('Copying tables...');
    const report = [];
    for (const table of TABLES) {
      const result = await copyTable(sourceKnex, targetKnex, table, idSets);
      report.push({ table: table.name, ...result });
      console.log(`  ${table.name}: copied ${result.copied}/${result.total}${result.skipped ? ` (skipped ${result.skipped} orphaned)` : ''}`);
    }

    console.log('');
    console.log('Resetting Postgres sequences past the highest transferred id...');
    await resetSequences(targetKnex);

    console.log('');
    console.log('Verifying row counts on target...');
    let mismatch = false;
    for (const row of report) {
      const [{ count }] = await targetKnex(row.table).count({ count: '*' });
      const targetCount = Number(count);
      const ok = targetCount === row.copied;
      if (!ok) mismatch = true;
      console.log(`  ${row.table}: source ${row.total} -> copied ${row.copied} -> target has ${targetCount}${ok ? '' : '  <-- MISMATCH'}`);
    }

    console.log('');
    if (mismatch) {
      console.log('Transfer finished with row-count mismatches — see above. Do not switch DB_BACKEND to');
      console.log('postgres for the running app until this is investigated.');
      process.exitCode = 1;
    } else {
      console.log('Transfer complete. Set DB_BACKEND=postgres (and DATABASE_URL/DB_* as used above) and');
      console.log('restart LoxSuite to switch over.');
    }
  } finally {
    await sourceKnex.destroy();
    if (targetKnex) await targetKnex.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('');
    console.error('Transfer failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { TABLES, FOREIGN_KEYS, parseArgs };
