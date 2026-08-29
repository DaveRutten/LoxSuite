// The one thing the rest of the suite can't cover: the migrations AND the async db facade run
// against a REAL Postgres and MariaDB, not just SQLite. Everything DB-touching elsewhere uses an
// in-memory better-sqlite3, so a dialect bug in a migration or a facade helper (node-postgres
// returning BIGINT COUNT(*) as a string, insertReturningId's RETURNING-vs-lastInsertRowid split,
// utf8mb4, transactions on a real pool — all called out in db/knex.js's own comments) only ever
// surfaced on a user's live server. This runs the true production path (db.init() with DB_BACKEND
// set) against a throwaway server the CI db-backends jobs provide.
//
// Skips entirely unless TEST_DB_BACKEND is set, so the normal sqlite CI job and local dev are
// unaffected. CI sets TEST_DB_BACKEND=postgres|mysql and TEST_DATABASE_URL alongside a real
// service container.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const backend = process.env.TEST_DB_BACKEND;

if (!backend) {
  test('db backend smoke (skipped — set TEST_DB_BACKEND=postgres|mysql to run)', { skip: true }, () => {});
} else {
  // Point the real config resolver at the target backend BEFORE requiring the db facade, so
  // db.init() below connects to it exactly the way production does.
  process.env.DB_BACKEND = backend;
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = require('../src/db');

  before(async () => { await db.init(); });
  after(async () => { await db.close(); });

  test(`(${backend}) every migration applied and singletons seeded`, async () => {
    assert.equal(db.getBackend(), backend);
    const settings = await db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
    assert.ok(settings, 'gateway_settings row 1 exists');
    // Columns from this session's own migrations, proven on the real dialect too:
    assert.ok('heartbeat_url' in settings, 'migration 016 heartbeat_url');
    assert.equal(Number(settings.heartbeat_interval_minutes), 0, 'migration 016 default');
    assert.ok(Number(settings.notification_retention_days) > 0);
    const roles = await db.prepare('SELECT name FROM access_roles ORDER BY name').all();
    assert.deepEqual(roles.map((r) => r.name), ['Administrator', 'Viewer']);
  });

  test(`(${backend}) the async facade's dialect-sensitive ops work on a real server`, async () => {
    // COUNT(*) must come back a real number — node-postgres hands back BIGINT as a string without
    // db/knex.js's own coercion; this proves that coercion against a live server.
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM access_roles').get();
    assert.equal(typeof counted.n, 'number', 'COUNT(*) coerced to a number');
    assert.ok(counted.n >= 2);

    // insertReturningId (RETURNING id on Postgres, lastInsertRowid-equivalent on MySQL) yields a
    // numeric id; a transaction commits its write.
    const id = await db.insertReturningId(
      'INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, 1, ?)',
      ['smoke-channel', 'json://localhost/', new Date().toISOString()]
    );
    assert.equal(typeof id, 'number', 'insertReturningId returns a number');
    await db.transaction(async (tx) => {
      await tx.prepare('UPDATE notification_channels SET name = ? WHERE id = ?').run('smoke-channel-renamed', id);
    });
    const row = await db.prepare('SELECT name FROM notification_channels WHERE id = ?').get(id);
    assert.equal(row.name, 'smoke-channel-renamed', 'transaction committed');
    await db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
  });

  test(`(${backend}) this session's new columns (migrations 015/016) are writable`, async () => {
    const ruleId = await db.insertReturningId(
      "INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at) VALUES (?, ?, 1, ?, '{}', ?)",
      ['device_offline', 'smoke-rule', '{}', new Date().toISOString()]
    );
    await db.prepare('UPDATE notification_rules SET last_sent_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?')
      .run(new Date().toISOString(), ruleId);
    await db.prepare('INSERT INTO notification_events (event_type, severity, title, message, source_id, source_label, source_ref, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('device_offline', 'warning', 't', 'm', 1, 'dev', 'tree:dev', ruleId, new Date().toISOString());
    const ev = await db.prepare('SELECT source_ref FROM notification_events WHERE rule_id = ?').get(ruleId);
    assert.equal(ev.source_ref, 'tree:dev', 'migration 015 source_ref round-trips');
    await db.prepare('DELETE FROM notification_events WHERE rule_id = ?').run(ruleId);
    await db.prepare('DELETE FROM notification_rules WHERE id = ?').run(ruleId);
  });
}
