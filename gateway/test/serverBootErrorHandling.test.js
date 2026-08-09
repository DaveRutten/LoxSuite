// Regression guard for the third bug found in the same investigation as loxoneUdpServer.js's own
// missing await and mqttClient.js's own missing .catch(): server.js starts several async
// background workers at boot (runBootstrap/startTailing/mqttClient.startMqttClient/
// startMonitorCollector/startLogCollector/startLiveConnections) without awaiting their own initial
// setup work — intentional, so they all start concurrently rather than serially blocking boot — but
// that means a failure during that startup phase (before each settles into its own setInterval
// loop) needs an explicit .catch() or it escapes as a bare, hard-to-trace "unhandled promise
// rejection" warning instead of a clear, named log line. This is a source scan (matches the
// existing noSyncDbCalls.test.js/sqlDialect.test.js convention) rather than a boot test, since
// actually booting server.js pulls in a real Express app + every route/worker module.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Every async worker-starter server.js calls without awaiting its startup — each must be followed
// by `.catch(` on the same call (`name(...)` or `namespace.name(...)`, see loxoneUdpServer.js's own
// comment on why some of these are namespace calls). Deliberately NOT startHealthchecks/
// startUdpServer/startHardwarePolling/backup.startScheduler/startVersionCheck — those are plain
// sync functions themselves (their own async work is already self-contained fire-and-forget with
// its own established handling, see healthcheck.js's/loxoneHardware.js's/versionCheck.js's own
// tick()-style self-rescheduling comments) and were never uncaught promises to begin with.
const ASYNC_WORKER_STARTERS = [
  'runBootstrap',
  'startTailing',
  'mqttClient.startMqttClient',
  'startMonitorCollector',
  'startLogCollector',
  'startLiveConnections',
];

test('every async worker-starter server.js calls at boot has its own .catch()', () => {
  const missing = [];
  for (const name of ASYNC_WORKER_STARTERS) {
    const escaped = name.replace('.', '\\.');
    const callRe = new RegExp(`${escaped}\\(\\)\\.catch\\(`);
    if (!callRe.test(SERVER_JS)) missing.push(name);
  }
  assert.deepEqual(missing, [], `these worker-starters are missing their own .catch(): ${missing.join(', ')}`);
});

test('every ASYNC_WORKER_STARTERS entry is still actually called in server.js (catches a stale test list)', () => {
  const notFound = ASYNC_WORKER_STARTERS.filter((name) => !SERVER_JS.includes(`${name}(`));
  assert.deepEqual(notFound, [], `these names weren't found being called at all — this test's own list is stale: ${notFound.join(', ')}`);
});
