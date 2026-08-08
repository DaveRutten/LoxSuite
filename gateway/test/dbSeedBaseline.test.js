// Re-runs db.test.js's own seed-data assertions, but against a database built through the Knex
// baseline (001_baseline.js) rather than the legacy path db.test.js itself exercises — a fresh
// install on ANY backend goes through this path, so its seed data needs to match the legacy path's
// own end state exactly (same roles, same permission matrix, same singleton settings rows), not
// just its table STRUCTURE (already covered by schemaParity.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createKnex } = require('../src/db/knex');
const { AREA_KEYS } = require('../src/permissionAreas');

let knex;

before(async () => {
  process.env.ADMIN_USERNAME = 'baseline-test-admin';
  process.env.ADMIN_PASSWORD = 'baseline-test-password-12345';
  knex = createKnex(':memory:');
  await knex.migrate.latest();
});

after(async () => {
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  await knex.destroy();
});

test('a fresh baseline database seeds an Administrator and a Viewer role', async () => {
  const roles = await knex('access_roles').select('name', 'is_admin').orderBy('name');
  assert.deepEqual(roles.map((r) => r.name), ['Administrator', 'Viewer']);
  assert.equal(roles.find((r) => r.name === 'Administrator').is_admin, 1);
  assert.equal(roles.find((r) => r.name === 'Viewer').is_admin, 0);
});

test('the Administrator role has a permission row for every known area', async () => {
  const adminRole = await knex('access_roles').where({ name: 'Administrator' }).first('id');
  const rows = await knex('access_role_permissions').where({ role_id: adminRole.id }).select('area');
  assert.deepEqual(rows.map((r) => r.area).sort(), [...AREA_KEYS].sort());
});

test('singleton settings tables each have exactly one row', async () => {
  for (const table of ['gateway_settings', 'mqtt_settings', 'backup_settings', 'sso_settings']) {
    const count = (await knex(table).count({ c: '*' }).first()).c;
    assert.equal(Number(count), 1, `${table} should have exactly one row`);
  }
});

test('gateway_settings starts with a sane default retention/timezone/wizard state', async () => {
  const settings = await knex('gateway_settings').where({ id: 1 }).first();
  assert.equal(settings.display_timezone, 'UTC');
  assert.ok(settings.log_retention_days > 0);
  assert.ok(settings.monitor_retention_days > 0);
  assert.equal(settings.setup_wizard_completed, 0);
});

test('backup_settings carries the rclone columns', async () => {
  const columns = Object.keys(await knex('backup_settings').columnInfo());
  for (const col of ['rclone_enabled', 'rclone_remote', 'rclone_config', 'rclone_last_status']) {
    assert.ok(columns.includes(col), `backup_settings is missing column "${col}"`);
  }
});

test('the one shared home Dashboard is seeded (user_id NULL)', async () => {
  const shared = await knex('custom_dashboards').whereNull('user_id').select('*');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].name, 'Dashboard');
});

test('ADMIN_USERNAME/ADMIN_PASSWORD seeds the first admin user with the Administrator role', async () => {
  const user = await knex('users').where({ username: 'baseline-test-admin' }).first();
  assert.ok(user, 'expected the seeded admin user to exist');
  const role = await knex('access_roles').where({ id: user.role_id }).first();
  assert.equal(role.name, 'Administrator');
  assert.ok(user.password_hash && user.password_hash.startsWith('$2'), 'password should be bcrypt-hashed, not stored in plain text');
});

test('mqtt_settings is seeded from MQTT_URL (or its own default) rather than left empty', async () => {
  const settings = await knex('mqtt_settings').where({ id: 1 }).first();
  assert.ok(settings.host, 'mqtt_settings.host must not be blank — every write site assumes a row already exists');
  assert.equal(settings.port > 0, true);
});
