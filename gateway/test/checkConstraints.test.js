// schemaParity.test.js deliberately does NOT compare CHECK constraint text (hand-written SQL and
// Knex's own generated SQL differ in punctuation/quoting even when semantically identical — see
// that test's own comment). This is the functional half of that same safety net instead: for every
// CHECK constraint the legacy schema declares, actually attempt the exact insert that should be
// rejected against the new Knex baseline (001_baseline.js), and confirm it genuinely is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createKnex } = require('../src/db/knex');

let knex;

before(async () => {
  knex = createKnex(':memory:');
  await knex.migrate.latest();
});

after(async () => {
  await knex.destroy();
});

async function assertRejected(fn, label) {
  await assert.rejects(fn, /CHECK constraint failed/, `${label} should be rejected by a CHECK constraint`);
}

test('mqtt_settings.id / gateway_settings.id / sso_settings.id / backup_settings.id / command_catalog_overrides.id must be 1', async () => {
  // mqtt_settings.host has no default (NOT NULL, no DEFAULT) — supplied here so the CHECK
  // constraint is genuinely what rejects this insert, not an unrelated NOT NULL failure landing
  // first and masking whether the CHECK itself would have caught it.
  await assertRejected(() => knex('mqtt_settings').insert({ id: 2, host: 'x' }), 'mqtt_settings.id = 2');
  for (const table of ['gateway_settings', 'sso_settings', 'backup_settings', 'command_catalog_overrides']) {
    await assertRejected(() => knex(table).insert({ id: 2 }), `${table}.id = 2`);
  }
});

test('mappings_mqtt_to_loxone.transport only accepts http/udp', async () => {
  const [msId] = await knex('miniservers').insert({ name: 'x', host: 'x', username: 'x', password: 'x' });
  await assertRejected(() => knex('mappings_mqtt_to_loxone').insert({ miniserver_id: msId, mqtt_topic: 't', target: 'v', transport: 'carrier-pigeon' }), 'transport = carrier-pigeon');
  await knex('mappings_mqtt_to_loxone').insert({ miniserver_id: msId, mqtt_topic: 't', target: 'v', transport: 'udp' }); // should not throw
});

test('mappings_mqtt_to_loxone.value_transform rejects an unknown transform', async () => {
  const [msId] = await knex('miniservers').insert({ name: 'x2', host: 'x2', username: 'x', password: 'x' });
  await assertRejected(() => knex('mappings_mqtt_to_loxone').insert({ miniserver_id: msId, mqtt_topic: 't', target: 'v', value_transform: 'telepathy' }), 'value_transform = telepathy');
});

test('mappings_loxone_to_mqtt.qos only accepts 0/1/2', async () => {
  await assertRejected(() => knex('mappings_loxone_to_mqtt').insert({ token: 'tok1', mqtt_topic: 't', qos: 3 }), 'qos = 3');
  await knex('mappings_loxone_to_mqtt').insert({ token: 'tok2', mqtt_topic: 't', qos: 2 }); // should not throw
});

test('monitors.source_type rejects an unknown source', async () => {
  await assertRejected(() => knex('monitors').insert({ source_type: 'carrier-pigeon', label: 'l', created_at: new Date().toISOString() }), 'source_type = carrier-pigeon');
});

test('monitors.diag_field rejects an unknown field but allows NULL', async () => {
  await assertRejected(() => knex('monitors').insert({ source_type: 'miniserver_diag', label: 'l', diag_field: 'nonsense', created_at: new Date().toISOString() }), 'diag_field = nonsense');
  await knex('monitors').insert({ source_type: 'mqtt', label: 'l2', created_at: new Date().toISOString() }); // diag_field NULL, should not throw
});

test('dashboard_panels.panel_type rejects an unknown type', async () => {
  const [dashId] = await knex('custom_dashboards').insert({ name: 'd', created_at: new Date().toISOString() });
  await assertRejected(() => knex('dashboard_panels').insert({ dashboard_id: dashId, panel_type: 'carrier-pigeon' }), 'panel_type = carrier-pigeon');
});

test('log_entries.source rejects an unknown source', async () => {
  await assertRejected(() => knex('log_entries').insert({ source: 'carrier-pigeon', line: 'x', recorded_at: new Date().toISOString() }), 'source = carrier-pigeon');
});

test('notification_rules.trigger_type rejects an unknown trigger', async () => {
  await assertRejected(() => knex('notification_rules').insert({ trigger_type: 'carrier-pigeon', name: 'r', created_at: new Date().toISOString() }), 'trigger_type = carrier-pigeon');
});
