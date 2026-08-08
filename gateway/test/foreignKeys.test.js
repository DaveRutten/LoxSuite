// Confirms the DB_ENFORCE_FOREIGN_KEYS=1 escape hatch (see knex.js's own comment) actually does
// what it says: with it set, SQLite genuinely enforces the CASCADE/SET NULL declared throughout
// 001_baseline.js, instead of the app's own hand-rolled "delete the join-table rows first, then
// the parent" cleanup being the only thing standing between a delete and an orphaned row. Off by
// default everywhere else in this app's history — this is purely a forward-looking regression
// check for Phase 4 of the project's own db-backend plan (a real Postgres transfer enforces these
// same relationships for real), not a behavior change to the app itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createKnex } = require('../src/db/knex');

let knex;

before(async () => {
  process.env.DB_ENFORCE_FOREIGN_KEYS = '1';
  knex = createKnex(':memory:');
  await knex.migrate.latest();
});

after(async () => {
  delete process.env.DB_ENFORCE_FOREIGN_KEYS;
  await knex.destroy();
});

test('foreign key enforcement is genuinely on', async () => {
  const fk = await knex.raw('PRAGMA foreign_keys');
  assert.equal(fk[0].foreign_keys, 1);
});

test('deleting a miniserver cascades to its mappings and monitors instead of erroring or orphaning them', async () => {
  const [msId] = await knex('miniservers').insert({ name: 'fk-test', host: 'x', username: 'u', password: 'p' });
  await knex('mappings_mqtt_to_loxone').insert({ miniserver_id: msId, mqtt_topic: 't', target: 'v' });
  const [monitorId] = await knex('monitors').insert({ source_type: 'loxone', label: 'm', miniserver_id: msId, loxone_uuid: 'u1', created_at: new Date().toISOString() });

  await knex('miniservers').where({ id: msId }).delete();

  assert.equal(await knex('mappings_mqtt_to_loxone').where({ miniserver_id: msId }).first(), undefined);
  assert.equal(await knex('monitors').where({ id: monitorId }).first(), undefined);
});

test('a user delete that manually cleans up its own join-table rows first (as routes/admin.js does) still succeeds under real enforcement', async () => {
  const [roleId] = await knex('access_roles').insert({ name: 'fk-role', is_admin: 0 });
  const [userId] = await knex('users').insert({ username: 'fk-user', role_id: roleId });
  const [dashId] = await knex('custom_dashboards').insert({ user_id: userId, name: 'd', created_at: new Date().toISOString() });
  await knex('dashboard_favorites').insert({ user_id: userId, dashboard_id: dashId });
  const [ruleId] = await knex('notification_rules').insert({ trigger_type: 'backup_failed', name: 'r', created_at: new Date().toISOString(), owner_user_id: userId });
  await knex('notification_rule_subscribers').insert({ rule_id: ruleId, user_id: userId });

  // Same order routes/admin.js's own POST /users/:id/delete already uses.
  await knex('notification_rule_subscribers').where({ user_id: userId }).delete();
  await knex('notification_rule_channels').whereIn('rule_id', knex('notification_rules').select('id').where({ owner_user_id: userId })).delete();
  await knex('notification_rules').where({ owner_user_id: userId }).delete();
  await knex('dashboard_favorites').where({ user_id: userId }).delete();
  await knex('users').where({ id: userId }).delete();

  assert.equal(await knex('users').where({ id: userId }).first(), undefined);
  // custom_dashboards.user_id -> users ON DELETE CASCADE — the dashboard itself goes with the user.
  assert.equal(await knex('custom_dashboards').where({ id: dashId }).first(), undefined);
});
