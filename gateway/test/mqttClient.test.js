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
