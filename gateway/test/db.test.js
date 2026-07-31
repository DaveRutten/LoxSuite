// Fresh in-memory database per test run — exercises every CREATE TABLE / migration in db.js from
// scratch each time, which is as close as this suite gets to "does a brand new install boot
// cleanly" without actually starting the whole server.
process.env.DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { AREA_KEYS } = require('../src/permissionAreas');

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

test('a fresh database seeds an Administrator and a Viewer role', () => {
  const roles = db.prepare('SELECT name, is_admin FROM access_roles ORDER BY name').all();
  assert.deepEqual(roles.map((r) => r.name), ['Administrator', 'Viewer']);
  assert.equal(roles.find((r) => r.name === 'Administrator').is_admin, 1);
  assert.equal(roles.find((r) => r.name === 'Viewer').is_admin, 0);
});

test('the Administrator role has a permission row for every known area', () => {
  const adminRole = db.prepare('SELECT id FROM access_roles WHERE name = ?').get('Administrator');
  const rows = db.prepare('SELECT area FROM access_role_permissions WHERE role_id = ?').all(adminRole.id);
  const seededAreas = rows.map((r) => r.area).sort();
  assert.deepEqual(seededAreas, [...AREA_KEYS].sort());
});

test('singleton settings tables each have exactly one row', () => {
  for (const table of ['gateway_settings', 'mqtt_settings', 'backup_settings', 'sso_settings']) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    assert.equal(count, 1, `${table} should have exactly one row`);
  }
});

test('gateway_settings starts with a sane default retention/timezone/wizard state', () => {
  const settings = db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
  assert.equal(settings.display_timezone, 'UTC');
  assert.ok(settings.log_retention_days > 0);
  assert.ok(settings.monitor_retention_days > 0);
  assert.equal(settings.setup_wizard_completed, 0);
});

test('the notification tables exist with the expected join table', () => {
  assert.ok(tableExists('notification_channels'));
  assert.ok(tableExists('notification_rules'));
  assert.ok(tableExists('notification_rule_channels'));
});

test('backup_settings carries the rclone columns', () => {
  const columns = db.prepare('PRAGMA table_info(backup_settings)').all().map((c) => c.name);
  for (const col of ['rclone_enabled', 'rclone_remote', 'rclone_config', 'rclone_last_status']) {
    assert.ok(columns.includes(col), `backup_settings is missing column "${col}"`);
  }
});
