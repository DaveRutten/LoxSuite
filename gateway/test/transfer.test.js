// Fast, SQLite-only regression guard for the SQLite -> Postgres/MySQL transfer CLI (gateway/src/db/
// transfer.js, Phases 4b/5 of the project's own db-backend plan). The end-to-end transfer itself
// (real Postgres/MySQL targets, dry-run/orphan-scan/--prune-orphans/sequence-or-auto_increment-
// reset/--force behavior) was verified manually against real containers of both — see those
// phases' own notes — and belongs in the slow/CI container loop per the plan's own testing
// strategy, not here. What CAN run fast, without any DB at all, is checked here: that TABLES/
// FOREIGN_KEYS stay a faithful, internally consistent mirror of db/migrations/001_baseline.js's own
// schema (the single biggest risk of hand-maintaining this list, per that file's own comment, is it
// silently drifting out of sync with a future schema change), and that the CLI's own flag parsing
// behaves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TABLES, FOREIGN_KEYS, parseArgs } = require('../src/db/transfer');

test('TABLES lists every table in FK-safe order (each FK only points at an earlier or the same table)', () => {
  const indexOf = new Map(TABLES.map((t, i) => [t.name, i]));
  for (const fk of FOREIGN_KEYS) {
    assert.ok(indexOf.has(fk.table), `FOREIGN_KEYS references unknown table "${fk.table}" — TABLES is out of sync`);
    assert.ok(indexOf.has(fk.refTable), `FOREIGN_KEYS references unknown refTable "${fk.refTable}" — TABLES is out of sync`);
    // Same-table (self) references — e.g. miniservers.gateway_client_of -> miniservers.id — are
    // fine: rowViolatesAnyFk() checks the copied rows' actual values regardless of insert order
    // within one table, not a strict "earlier row" requirement, and every such column in the
    // baseline schema is nullable (ON DELETE SET NULL) rather than a hard ordering dependency.
    // Cross-table references genuinely do need refTable inserted first, though.
    if (fk.refTable === fk.table) continue;
    assert.ok(
      indexOf.get(fk.refTable) < indexOf.get(fk.table),
      `${fk.table}.${fk.column} -> ${fk.refTable}.id: ${fk.refTable} must come BEFORE ${fk.table} in TABLES (FK-safe insert order)`
    );
  }
});

test('TABLES has no duplicate table names', () => {
  const names = TABLES.map((t) => t.name);
  assert.deepEqual(names, [...new Set(names)]);
});

test('FOREIGN_KEYS has no duplicate (table, column) pairs', () => {
  const keys = FOREIGN_KEYS.map((fk) => `${fk.table}.${fk.column}`);
  assert.deepEqual(keys, [...new Set(keys)]);
});

test('parseArgs reads --from-sqlite/--to, defaults --backend to postgres, and defaults the boolean flags off', () => {
  const args = parseArgs(['--from-sqlite', '/data/gateway.db', '--to', 'postgres://x']);
  assert.equal(args.fromSqlite, '/data/gateway.db');
  assert.equal(args.to, 'postgres://x');
  assert.equal(args.backend, 'postgres');
  assert.equal(args.dryRun, false);
  assert.equal(args.pruneOrphans, false);
  assert.equal(args.force, false);
});

test('parseArgs accepts --backend mysql', () => {
  const args = parseArgs(['--backend', 'mysql']);
  assert.equal(args.backend, 'mysql');
});

test('parseArgs rejects an unknown --backend value', () => {
  const originalExit = process.exit;
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__process_exit__'); };
  try {
    assert.throws(() => parseArgs(['--backend', 'sqlite']), /__process_exit__/);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

test('parseArgs recognizes --dry-run/--prune-orphans/--force', () => {
  const args = parseArgs(['--dry-run', '--prune-orphans', '--force']);
  assert.equal(args.dryRun, true);
  assert.equal(args.pruneOrphans, true);
  assert.equal(args.force, true);
});

test('parseArgs rejects an unknown flag rather than silently ignoring it', () => {
  // parseArgs itself calls process.exit(1) on an unknown flag (see its own console.error + exit) —
  // stubbed here so the test process doesn't actually die, and to prove exit(1) really is what a
  // typo'd flag triggers rather than it being silently swallowed into the returned args object.
  const originalExit = process.exit;
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('__process_exit__'); };
  try {
    assert.throws(() => parseArgs(['--totally-made-up-flag']), /__process_exit__/);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});
