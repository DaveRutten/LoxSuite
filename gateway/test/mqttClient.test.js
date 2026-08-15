// Regression guard for a second bug found alongside loxoneUdpServer.js's own missing await (same
// investigation, same root cause class): mqttClient.js's recordMessage() called the async
// recordMqttValue() (a monitor_history DB write) without awaiting OR catching it. Any rejection
// there used to become a bare, hard-to-trace "unhandled promise rejection" warning instead of a
// clear log line — this asserts recordMessage() now catches that failure itself (via
// monitorCollector.recordMqttValue's own .catch(), see mqttClient.js) rather than letting it
// escape as an unhandled rejection.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb } = require('./helpers/testDb');
const monitorCollector = require('../src/monitorCollector');
const mqttClient = require('../src/mqttClient');

let db;

before(async () => {
  db = await initTestDb();
});

after(async () => {
  await db.close();
});

// Fails the test if anything escapes as an unhandled rejection while `fn` runs — the exact failure
// mode this regression guard exists to catch.
async function assertNoUnhandledRejection(fn) {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // Give any fire-and-forget promise queued by fn() a chance to actually reject and be reported
    // before we check — a bare `await fn()` only waits for fn's own return, not for a detached
    // promise it kicked off without awaiting.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

test('recordMessage does not produce an unhandled rejection when recordMqttValue fails', async () => {
  const originalRecordMqttValue = monitorCollector.recordMqttValue;
  monitorCollector.recordMqttValue = async () => { throw new Error('simulated DB failure'); };
  try {
    const unhandled = await assertNoUnhandledRejection(() => {
      mqttClient.recordMessage('shellies/test/status', Buffer.from('42'));
    });
    assert.deepEqual(unhandled, [], 'recordMessage should catch recordMqttValue failures itself, not leak them as unhandled rejections');
  } finally {
    monitorCollector.recordMqttValue = originalRecordMqttValue;
  }
});

test('recordMessage still updates its own in-memory topic overview even when recordMqttValue fails', async () => {
  const originalRecordMqttValue = monitorCollector.recordMqttValue;
  monitorCollector.recordMqttValue = async () => { throw new Error('simulated DB failure'); };
  try {
    mqttClient.recordMessage('shellies/test/status', Buffer.from('42'));
    await new Promise((resolve) => setImmediate(resolve));
    const overview = mqttClient.getTopicOverview().find((o) => o.topic === 'shellies/test/status');
    assert.ok(overview, 'expected a topic overview entry even though the DB write failed');
    assert.equal(overview.value, '42');
  } finally {
    monitorCollector.recordMqttValue = originalRecordMqttValue;
  }
});

// A device replaying its last-known state as a retained message on (re)connect (Shelly,
// Zigbee2MQTT, ...) needs to read as visibly different from a genuinely fresh publish on Incoming
// Messages — see recordMessage's own comment on why. Two messages on the same topic, only the
// second retained, confirms the flag reflects THAT message and isn't stuck once set.
test('recordMessage tracks the retained flag per message, not just once true', () => {
  mqttClient.recordMessage('retain-test/topic', Buffer.from('fresh'), false);
  let overview = mqttClient.getTopicOverview().find((o) => o.topic === 'retain-test/topic');
  assert.equal(overview.retained, false);

  mqttClient.recordMessage('retain-test/topic', Buffer.from('replayed'), true);
  overview = mqttClient.getTopicOverview().find((o) => o.topic === 'retain-test/topic');
  assert.equal(overview.retained, true);
});

// A caller (attachHandlers) that forgets to pass mqtt.js's own `retain` flag at all shouldn't crash
// or silently mark everything retained — recordMessage's own `!!retained` coercion should read an
// omitted third argument as false, the same "not confirmed retained" default a message from a
// broker too old to report it correctly falls back to.
test('recordMessage treats a missing retained argument as false, not undefined/truthy', () => {
  mqttClient.recordMessage('retain-test/no-flag', Buffer.from('x'));
  const overview = mqttClient.getTopicOverview().find((o) => o.topic === 'retain-test/no-flag');
  assert.equal(overview.retained, false);
});

// getBrokerStats() parses Mosquitto's own $SYS/broker/* tree — values captured verbatim from a
// real, running Mosquitto 2.1.2 broker (including the literal space in "retained messages/count",
// the one topic in this tree that isn't slash-only) rather than guessed at, so this doubles as a
// regression guard against ever assuming a cleaner shape than the broker actually publishes.
test('getBrokerStats parses a real Mosquitto $SYS/broker/* snapshot into typed fields', () => {
  const snapshot = {
    version: 'mosquitto version 2.1.2',
    uptime: '17415 seconds',
    'clients/connected': '2',
    'clients/total': '2',
    'clients/maximum': '2',
    'messages/received': '298',
    'messages/sent': '384',
    'bytes/received': '1134',
    'bytes/sent': '5070',
    'retained messages/count': '55',
    'subscriptions/count': '3',
    'load/messages/received/1min': '3.08',
    'load/messages/sent/1min': '57.42',
  };
  for (const [suffix, value] of Object.entries(snapshot)) {
    mqttClient.recordBrokerStat(`$SYS/broker/${suffix}`, Buffer.from(value));
  }

  const stats = mqttClient.getBrokerStats();
  assert.deepEqual(stats, {
    version: 'mosquitto version 2.1.2',
    uptimeSeconds: 17415,
    clientsConnected: 2,
    clientsTotal: 2,
    clientsMaximum: 2,
    messagesReceived: 298,
    messagesSent: 384,
    bytesReceived: 1134,
    bytesSent: 5070,
    retainedMessageCount: 55,
    subscriptionsCount: 3,
    load1minMessagesReceived: 3.08,
    load1minMessagesSent: 57.42,
  });
});

// getBrokerStats() only ever returns this fixed, curated field list (see its own comment on why —
// deliberately not "whatever happens to be in the raw $SYS map today"), e.g. heap/current is a real
// key Mosquitto publishes (only when compiled with heap tracking) but isn't one of them — a broker
// publishing an unrecognized $SYS key, or not publishing heap stats at all, can't change this shape
// either way.
// clearRetained's own "publish an empty retained message" is the MQTT spec's own well-established
// way to purge a topic's retained value from the broker — not something worth re-deriving in a
// unit test (see routes/incoming.js's own comment). What IS worth covering here, the same way
// requestDeviceAnnounce's identical `if (client && state.connected)` guard already protects against
// a stray click while genuinely disconnected: this must never throw, and must never wipe a topic's
// still-relevant overview entry, when there's no live connection to actually publish the clear
// through in the first place.
test('clearRetained is a safe no-op (does not throw, does not touch topicOverview) while disconnected', () => {
  const wasConnected = mqttClient.state.connected;
  mqttClient.state.connected = false;
  try {
    mqttClient.recordMessage('clear-retained-test/topic', Buffer.from('still here'));
    assert.doesNotThrow(() => mqttClient.clearRetained('clear-retained-test/topic'));
    const overview = mqttClient.getTopicOverview().find((o) => o.topic === 'clear-retained-test/topic');
    assert.ok(overview, 'the topic overview entry should be untouched — nothing was actually cleared on a broker we are not connected to');
  } finally {
    mqttClient.state.connected = wasConnected;
  }
});

test('getBrokerStats always returns exactly its own curated field list, nothing more or less', () => {
  const stats = mqttClient.getBrokerStats();
  assert.deepEqual(Object.keys(stats).sort(), [
    'bytesReceived', 'bytesSent', 'clientsConnected', 'clientsMaximum', 'clientsTotal',
    'load1minMessagesReceived', 'load1minMessagesSent', 'messagesReceived', 'messagesSent',
    'retainedMessageCount', 'subscriptionsCount', 'uptimeSeconds', 'version',
  ]);
});
