// Guards the dead-man's-switch timing decision (heartbeat.js). The ticker runs once a minute but
// must only actually ping when the configured interval is due, and must stay silent when the
// heartbeat is disabled or misconfigured — a bug either way is bad: a tight loop hammering the
// watchdog, or (worse) no pings at all, which the watchdog reads as "LoxSuite is down".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { heartbeatDue } = require('../src/heartbeat');

const MIN = 60 * 1000;

test('a disabled or misconfigured heartbeat is never due', () => {
  const now = 1_000_000_000;
  assert.equal(heartbeatDue({ url: '', intervalMinutes: 5, lastPingAt: 0, now }), false);
  assert.equal(heartbeatDue({ url: '   ', intervalMinutes: 5, lastPingAt: 0, now }), false);
  assert.equal(heartbeatDue({ url: null, intervalMinutes: 5, lastPingAt: 0, now }), false);
  assert.equal(heartbeatDue({ url: 'https://hc-ping.com/x', intervalMinutes: 0, lastPingAt: 0, now }), false);
  assert.equal(heartbeatDue({ url: 'https://hc-ping.com/x', intervalMinutes: -5, lastPingAt: 0, now }), false);
  assert.equal(heartbeatDue({ url: 'https://hc-ping.com/x', intervalMinutes: 'nope', lastPingAt: 0, now }), false);
});

test('an enabled heartbeat that has never pinged is due immediately', () => {
  // lastPingAt 0 = never pinged; with a real Date.now() (huge) that is always past any interval.
  assert.equal(heartbeatDue({ url: 'https://hc-ping.com/x', intervalMinutes: 5, lastPingAt: 0, now: Date.now() }), true);
});

test('within the interval since the last ping it is not due; at/after the interval it is', () => {
  const url = 'https://hc-ping.com/x';
  const last = 10_000_000;
  assert.equal(heartbeatDue({ url, intervalMinutes: 5, lastPingAt: last, now: last + 4 * MIN }), false);
  assert.equal(heartbeatDue({ url, intervalMinutes: 5, lastPingAt: last, now: last + 5 * MIN }), true);
  assert.equal(heartbeatDue({ url, intervalMinutes: 5, lastPingAt: last, now: last + 9 * MIN }), true);
});
