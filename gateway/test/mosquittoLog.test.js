// Regression guard for the "Shellys don't come back as Connected after an update" bug: a device
// quick enough to reconnect before the gateway's very first log replay finishes used to get wiped
// right along with genuinely stale, pre-restart leftovers (see mosquittoLog.js's own BROKER_START_RE
// comment for the full mechanics). Reproduces the exact race by putting a stale pre-restart connect,
// Mosquitto's own restart marker, AND a fresh post-restart connect all in the log BEFORE the
// gateway ever starts tailing it — i.e. all three land in the very first poll() batch, which is
// exactly the scenario the old "wipe everyone still connected once replay finishes" logic couldn't
// tell apart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-mosquitto-log-'));
const logPath = path.join(tmpDir, 'mosquitto.log');

// A stale session (no disconnect line — a killed container never gets to log one) from BEFORE the
// broker restarted, the restart marker itself, and a device that reconnected fast enough to already
// have its own fresh connect line logged by the time anything reads this file for the first time.
fs.writeFileSync(
  logPath,
  [
    "1000000000: New client connected from 10.0.0.5:11111 as shellyplug-old-ABC123 (p2, c1, k60, u'shelly-old').",
    '1000000100: mosquitto version 2.0.18 starting',
    "1000000101: New client connected from 10.0.0.6:22222 as shellyplug-fast-DEF456 (p2, c1, k60, u'shelly-fast').",
    '',
  ].join('\n')
);

process.env.MOSQUITTO_LOG_PATH = logPath;
const { initTestDb, db } = require('./helpers/testDb');
const mosquittoLog = require('../src/mosquittoLog');

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

// startTailing()'s first poll() is fire-and-forget (see its own comment on why it can't be
// awaited directly) — poll for the settled result instead of a fixed sleep, same shape as this
// project's other tests that wait on an async background worker.
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitUntil() timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a device that reconnects before the first replay finishes is not wiped along with genuinely stale pre-restart clients', async () => {
  await mosquittoLog.startTailing(60000); // long interval — this test only cares about the first poll()

  await waitUntil(() => mosquittoLog.getClients().some((c) => c.clientId === 'shellyplug-fast-DEF456'));

  const clients = mosquittoLog.getClients();
  const fast = clients.find((c) => c.clientId === 'shellyplug-fast-DEF456');
  const old = clients.find((c) => c.clientId === 'shellyplug-old-ABC123');

  assert.ok(fast, 'the post-restart reconnect should be present at all');
  assert.equal(fast.status, 'connected', 'a device that reconnected before replay finished should still show as connected, not wiped');
  assert.equal(old, undefined, 'a stale pre-restart session with no disconnect line should be cleared by the restart marker, not linger as "disconnected"');
});
