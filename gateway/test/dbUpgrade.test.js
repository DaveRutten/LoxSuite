// The other half of Phase 2's own safety net (see schemaParity.test.js/dbSeedBaseline.test.js for
// the "does a FRESH install get the right schema" half): does an EXISTING, pre-Phase-2 SQLite
// database still boot correctly through db/index.js's new dual-path init()? Builds a real on-disk
// fixture the old way (the frozen legacy path directly, exactly what a real installed gateway.db
// from before this migration framework existed would look like), then boots the real facade
// against it twice in a row — once to exercise the upgrade-and-stamp path, once more to confirm the
// stamped state is idempotent (a container restart must never re-run the legacy path or error out
// on tables that already exist).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const runLegacySqliteSchema = require('../src/db/legacy-sqlite-schema');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-db-upgrade-'));
const fixtureDbPath = path.join(fixtureDir, 'gateway.db');

after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('a pre-Phase-2 SQLite file boots via the legacy path, gets stamped, and a second boot is idempotent', async () => {
  // Build the fixture the old way — a real on-disk file, not :memory:, since the whole point is
  // proving this works for what an actual upgrading installation's gateway.db looks like.
  const seedConn = new Database(fixtureDbPath);
  process.env.ADMIN_USERNAME = 'upgrade-test-admin';
  process.env.ADMIN_PASSWORD = 'upgrade-test-password-12345';
  runLegacySqliteSchema(seedConn, fixtureDbPath);
  seedConn.close();

  // Sanity check on the fixture itself: no knex_migrations table yet (a real pre-Phase-2 database
  // has never heard of Knex), but the app tables are there.
  const preCheckConn = new Database(fixtureDbPath, { readonly: true });
  assert.equal(preCheckConn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knex_migrations'").get(), undefined);
  assert.ok(preCheckConn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
  const userCountBefore = preCheckConn.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  preCheckConn.close();
  assert.equal(userCountBefore, 1, 'the fixture should already have the admin user seeded by the legacy path');

  // First real boot through the actual facade, pointed at the fixture file — this is the exact
  // path a real upgrading gateway container takes on its first restart after this ships.
  process.env.DB_PATH = fixtureDbPath;
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/db/knex')];
  const db1 = require('../src/db');
  await db1.init();

  const knex1 = db1.getKnex();
  const stamped = await knex1('knex_migrations').where({ name: '001_baseline.js' }).first();
  assert.ok(stamped, '001_baseline.js should be stamped as already-applied, not actually re-run');
  assert.equal(stamped.batch, 1);

  // The pre-existing data survived the upgrade untouched.
  const users = await db1.prepare('SELECT username FROM users').all();
  assert.deepEqual(users.map((u) => u.username), ['upgrade-test-admin']);
  const roles = await db1.prepare('SELECT name FROM access_roles ORDER BY name').all();
  assert.deepEqual(roles.map((r) => r.name), ['Administrator', 'Viewer']);

  await db1.close();

  // Second boot, same file — simulates a container restart. Must NOT attempt to re-run the legacy
  // path (it isn't idempotent against knex_migrations existing — it doesn't even check for it) and
  // must NOT error on 001_baseline.js's schema-creation half hitting tables that already exist.
  delete require.cache[require.resolve('../src/db')];
  const db2 = require('../src/db');
  await db2.init();
  const usersAfterSecondBoot = await db2.prepare('SELECT username FROM users').all();
  assert.deepEqual(usersAfterSecondBoot.map((u) => u.username), ['upgrade-test-admin'], 'second boot must not duplicate or lose the existing user');
  await db2.close();

  delete process.env.DB_PATH;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
});
