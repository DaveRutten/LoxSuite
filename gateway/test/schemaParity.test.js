// The safety net for the whole Phase 2 baseline-schema rewrite (see the project's own db-backend
// plan): rather than hand-writing gateway/src/db/migrations/001_baseline.js and hoping it matches
// what 45 hand-written migrations produce, this test mechanically dumps BOTH paths' actual
// resulting schema and asserts they're structurally identical. Written and run red BEFORE
// 001_baseline.js was built, exactly as the plan itself calls for — the baseline was built against
// this test failing, not the other way around.
//
// Deliberately does not compare CHECK constraint text (see schemaDump.js's own comment on why
// index NAMEs are ignored too) — SQLite only exposes a CHECK constraint's presence via its raw
// CREATE TABLE SQL, which legitimately differs in punctuation/quoting/whitespace between
// hand-written SQL and Knex's own generated SQL even when semantically identical, making a text
// comparison here needlessly brittle. checkConstraints.test.js (this same directory) instead
// verifies every CHECK constraint functionally, by attempting the exact insert that should fail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { dumpSchema } = require('./helpers/schemaDump');
const runLegacySqliteSchema = require('../src/db/legacy-sqlite-schema');
const { createKnex } = require('../src/db/knex');
const baseline = require('../src/db/migrations/001_baseline');

test('the Knex baseline (001_baseline.js) produces the exact same schema as the frozen legacy migration path', async () => {
  // Side A: the frozen legacy path, run directly against a fresh :memory: connection — exactly
  // what an upgrading pre-Phase-2 SQLite install still walks through today.
  const legacyConn = new Database(':memory:');
  runLegacySqliteSchema(legacyConn, ':memory:');
  const legacySchema = dumpSchema(legacyConn);
  legacyConn.close();

  // Side B: 001_baseline.js's own up() called directly — not knex.migrate.latest(), which (now
  // that migrations after 001_baseline exist, e.g. 002_scheduled_device_commands.js) would also
  // run every one of THOSE, comparing "the baseline plus everything since" against the frozen
  // legacy path instead of the baseline alone. This is what 001_baseline.js produces truly on its
  // own, unaided by any legacy function — matching what this test actually claims to check.
  const knex = createKnex(':memory:');
  await baseline.up(knex);
  const baselineConn = await knex.client.acquireConnection();
  const baselineSchema = dumpSchema(baselineConn);
  knex.client.releaseConnection(baselineConn);
  await knex.destroy();

  const legacyTables = Object.keys(legacySchema).sort();
  const baselineTables = Object.keys(baselineSchema).sort();
  assert.deepEqual(baselineTables, legacyTables, 'the baseline must create exactly the same set of tables as the legacy path ends up with');

  for (const table of legacyTables) {
    assert.deepEqual(
      baselineSchema[table],
      legacySchema[table],
      `table "${table}" differs between the legacy path and the baseline:\n` +
      `  legacy:   ${JSON.stringify(legacySchema[table])}\n` +
      `  baseline: ${JSON.stringify(baselineSchema[table])}`
    );
  }
});
