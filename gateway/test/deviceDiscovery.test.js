// Regression guard for activeTopics()'s own topicBelongsToPrefix() — the mqtt_topic autocomplete
// on the mapping "Add" forms is only useful if it actually recognizes a RENAMED device's own
// topics (no "shellies/" namespace left at all once renamed), not just a still-factory-default
// one (which needs that namespace, per its CATALOG topicPrefixPattern) — an earlier version of
// this used discoverDevices()'s own pattern-matching directly, which silently couldn't match a
// renamed device's topics at all.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-device-discovery-'));
const logPath = path.join(tmpDir, 'mosquitto.log');

// Two connected devices — one renamed (custom topic prefix "badkamer-verwarming", factory client
// ID still "shellydimmer2-A4A2A2" — the 6 hex digits after the dash are the device's own MAC's
// last 6, same convention deviceDiscovery.js's own comment documents), one still at its
// factory-default topic prefix (topics published under the "shellies/" namespace, per its own
// CATALOG entry) — plus one that never connects at all, to prove its topics get excluded.
fs.writeFileSync(
  logPath,
  [
    "1000000000: New client connected from 10.0.0.5:11111 as shellydimmer2-A4A2A2 (p2, c1, k60, u'shelly-renamed').",
    "1000000001: New client connected from 10.0.0.6:22222 as shellydimmer2-DEFAULT1 (p2, c1, k60, u'shelly-default').",
    '',
  ].join('\n')
);

process.env.MOSQUITTO_LOG_PATH = logPath;
const { initTestDb, db } = require('./helpers/testDb');
const mosquittoLog = require('../src/mosquittoLog');
const mqttClient = require('../src/mqttClient');
const { activeTopics } = require('../src/deviceDiscovery');

before(async () => {
  await initTestDb();
});

after(async () => {
  // Knex's own connection pool (tarn) doesn't unref its internal handles — left open, this test's
  // process never exits on its own once its assertions are done, it just hangs forever (verified:
  // no leftover application timer/stream, only db.close() fixed it). Every other test file in this
  // suite happens to get away without this same call; this one apparently doesn't, and closing is
  // the correct thing regardless.
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitUntil() timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('activeTopics() suggests a renamed device\'s own topics, a still-factory-default device\'s namespaced topics, and excludes a never-connected device', async () => {
  await mosquittoLog.startTailing(60000);
  await waitUntil(() => mosquittoLog.getClients().length === 2);

  // The renamed device's own announce is what teaches resolveTopicPrefix() its real prefix — the
  // mac's last 6 hex digits ("A4A2A2") match the suffix embedded in its own client ID above.
  mqttClient.recordMessage('badkamer-verwarming/announce', Buffer.from(JSON.stringify({ id: 'badkamer-verwarming', mac: '3C6105A4A2A2' })));
  mqttClient.recordMessage('badkamer-verwarming/status', Buffer.from('on'));

  // Still at its factory default — topics live under the "shellies/" namespace its own
  // topicPrefixPattern expects, client ID and topic prefix are the same string.
  mqttClient.recordMessage('shellies/shellydimmer2-DEFAULT1/relay/0', Buffer.from('on'));
  mqttClient.recordMessage('shellies/shellydimmer2-DEFAULT1/relay/0/power', Buffer.from('12.3'));

  // Never connected — its topics (from some earlier session, or a device on the network LoxSuite
  // hasn't actually seen connect) must not show up as a suggestion.
  mqttClient.recordMessage('shellies/shellyplug-s-OFFLINE1/relay/0/power', Buffer.from('0'));

  const topics = activeTopics();

  assert.ok(topics.includes('badkamer-verwarming/status'), 'a renamed device\'s own topic should be suggested');
  assert.ok(!topics.some((t) => t.includes('shellydimmer2-A4A2A2')), 'the raw MQTT client ID should never appear as topic text, only the resolved prefix');
  assert.ok(topics.includes('shellies/shellydimmer2-DEFAULT1/relay/0/power'), 'a still-factory-default device\'s namespaced topic should also be suggested');
  assert.ok(!topics.includes('shellies/shellyplug-s-OFFLINE1/relay/0/power'), 'a never-connected device\'s topic should not be suggested');
});
