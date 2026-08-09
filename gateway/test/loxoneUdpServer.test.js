// Regression guard for a real production bug (found live, not in this suite): loxoneUdpServer.js's
// handleMessage() called the newly-async splitUdpMessage() without await when it was converted in
// Phase 1 of the db-backend plan — `parsed` became a Promise (always truthy, so the malformed-
// message check never fired) and `{ token, rawValue }` destructured to undefined, which made
// findOrAutoCreateLoxoneMapping(undefined, ...) throw ("Undefined binding(s) detected" — the
// facade's own bound-parameter check) for every single UDP-transport Loxone command. That throw was
// silently swallowed by startUdpServer's own outer `.catch(err => console.error(...))`: no MQTT
// publish, no command-log entry, nothing visible anywhere except a console line easy to miss —
// exactly what made every Shelly (RGBW/dimmer/relay, any UDP mapping) stop responding to Loxone
// while the app otherwise looked healthy. Neither noSyncDbCalls.test.js (only checks .get(/.all(/
// .run() calls) nor any other test in this suite exercised handleMessage() at all before this file.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb } = require('./helpers/testDb');
const mqttClient = require('../src/mqttClient');
const { handleMessage } = require('../src/loxoneUdpServer');

let db;

before(async () => {
  db = await initTestDb();
});

after(async () => {
  await db.close();
});

// A fake MQTT client capturing publish() calls instead of needing a real broker — handleMessage()
// only ever calls getClient().publish(...), nothing else on the client.
function stubMqttClient() {
  const published = [];
  const originalGetClient = mqttClient.getClient;
  mqttClient.getClient = () => ({
    publish: (topic, value, opts, cb) => {
      published.push({ topic, value, opts });
      cb(null);
    },
  });
  return { published, restore: () => { mqttClient.getClient = originalGetClient; } };
}

beforeEach(async () => {
  await db.prepare('DELETE FROM mappings_loxone_to_mqtt').run();
  await db.prepare('DELETE FROM log_entries').run();
});

async function lastCommandLogEntry() {
  return db.prepare("SELECT * FROM log_entries WHERE source = 'loxone_commands' ORDER BY id DESC LIMIT 1").get();
}

test('handleMessage publishes a well-formed UDP command to the right topic and logs it as accepted', async () => {
  await db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, transport, qos, retain, value_transform)
     VALUES (NULL, 'reg-test-token', 'shellies/reg-test/relay/0/command', 'udp', 0, 0, 'passthrough')`
  ).run();

  const stub = stubMqttClient();
  try {
    await handleMessage(Buffer.from('reg-test-token=1'), { address: '10.0.0.5', port: 12345 });
  } finally {
    stub.restore();
  }

  assert.equal(stub.published.length, 1, 'expected exactly one MQTT publish');
  assert.equal(stub.published[0].topic, 'shellies/reg-test/relay/0/command');
  assert.equal(stub.published[0].value, '1');

  const entry = await lastCommandLogEntry();
  assert.ok(entry, 'expected a command-log entry');
  assert.equal(entry.line, 'OK');
  assert.equal(entry.command_topic, 'shellies/reg-test/relay/0/command');
  assert.equal(entry.value_to, '1');
});

test('handleMessage applies the shelly_rgbw transform before publishing (Loxone HSV -> Shelly RGB JSON)', async () => {
  await db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, transport, qos, retain, value_transform, transform_arg)
     VALUES (NULL, 'reg-rgbw-token', 'shellies/reg-rgbw/color/0/set', 'udp', 0, 0, 'shelly_rgbw', 'rgb')`
  ).run();

  const stub = stubMqttClient();
  try {
    await handleMessage(Buffer.from('reg-rgbw-token=210,100,50'), { address: '10.0.0.5', port: 12345 });
  } finally {
    stub.restore();
  }

  assert.equal(stub.published.length, 1, 'expected exactly one MQTT publish');
  assert.equal(stub.published[0].topic, 'shellies/reg-rgbw/color/0/set');
  const payload = JSON.parse(stub.published[0].value);
  assert.equal(payload.turn, 'on');
  assert.ok(Number.isInteger(payload.red) && Number.isInteger(payload.green) && Number.isInteger(payload.blue));
});

test('handleMessage rejects (and logs) an unrecognized token instead of throwing', async () => {
  const stub = stubMqttClient();
  try {
    await handleMessage(Buffer.from('no-such-token=1'), { address: '10.0.0.5', port: 12345 });
  } finally {
    stub.restore();
  }

  assert.equal(stub.published.length, 0, 'nothing should have been published');
  const entry = await lastCommandLogEntry();
  assert.ok(entry, 'expected a rejected command-log entry');
  assert.match(entry.line, /^Rejected:/);
});

test('handleMessage rejects a malformed message instead of throwing', async () => {
  const stub = stubMqttClient();
  try {
    // No "=" and no matching token/topic substring at all — splitUdpMessage() can't find a boundary.
    await handleMessage(Buffer.from('   '), { address: '10.0.0.5', port: 12345 });
  } finally {
    stub.restore();
  }

  assert.equal(stub.published.length, 0);
  const entry = await lastCommandLogEntry();
  assert.ok(entry, 'expected a rejected command-log entry');
  assert.match(entry.line, /^Rejected: malformed message/);
});
