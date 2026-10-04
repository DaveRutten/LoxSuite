const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSession, summaryText } = require('../src/chargeLog');

const T0 = Date.parse('2026-10-05T17:00:00Z');
const row = (sec, d, event = null) => ({ t: T0 + sec * 1000, event, d: { connected: 1, limit: d.sentKw, mode: 1, soc: 40, carState: 'READY_FOR_CHARGING', ...d } });
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test('a good test: waits at 0, wakes after 12 min, follows 6 kW, stops at 0', () => {
  const rows = [
    row(0, { sentKw: 0, kw: 0 }, 'Car plugged in'),
    row(60, { sentKw: 0, kw: 0 }),
    row(720, { sentKw: 0, kw: 0 }),
    row(730, { sentKw: 6, kw: 0 }, 'Test: sent 6 kW to Gateway'),
    row(760, { sentKw: 6, kw: 5.9, carState: 'CHARGING' }),
    row(900, { sentKw: 6, kw: 6.0, carState: 'CHARGING' }),
    row(960, { sentKw: 6, kw: 5.95, carState: 'CHARGING' }),
    row(1000, { sentKw: 0, kw: 5.9 }, 'Test: sent 0 kW to Gateway'),
    row(1020, { sentKw: 0, kw: 0.1 }),
  ];
  const c = byId(analyzeSession(rows));
  assert.equal(c.zero.status, 'pass');
  assert.equal(c.wait.status, 'pass');
  assert.equal(c.start.status, 'pass');
  assert.match(c.start.detail, /started after 30 s/);
  assert.equal(c.wake.status, 'pass');
  assert.equal(c.follow.status, 'pass');
  assert.equal(c.stop.status, 'pass');
  assert.match(c.stop.detail, /20 s/);
  assert.equal(c.send.status, 'pass');
  assert.match(summaryText({ from: T0, to: T0 + 1020000 }, analyzeSession(rows), rows), /\[OK\] It stops at 0/);
});

test('charging at 0 kW and a car error are flagged', () => {
  const rows = [
    row(0, { sentKw: 0, kw: 0 }, 'Car plugged in'),
    row(30, { sentKw: 0, kw: 4.1, carState: 'ERROR' }),
  ];
  const c = byId(analyzeSession(rows));
  assert.equal(c.zero.status, 'fail');
  assert.match(c.zero.detail, /Ec/);
  assert.equal(c.wait.status, 'fail');
  assert.equal(c.start.status, 'pending');
});

test('a full battery is reported as untestable, not as a failure', () => {
  const rows = [
    row(0, { sentKw: 0, kw: 0, soc: 100 }, 'Car plugged in'),
    row(10, { sentKw: 6, kw: 0, soc: 100 }, 'Test: sent 6 kW'),
    row(400, { sentKw: 6, kw: 0, soc: 100 }),
    row(700, { sentKw: 6, kw: 0.1, soc: 100 }),
  ];
  const c = byId(analyzeSession(rows));
  assert.equal(c.start.status, 'info');
  assert.match(c.start.detail, /full/);
});

test('a failed send is shown', () => {
  const rows = [row(0, { sentKw: null, kw: 0 }, 'Test: sending 6 kW FAILED — "LoxSuite_Vermogen" does not exist on Client')];
  const c = byId(analyzeSession(rows));
  assert.equal(c.send.status, 'fail');
  assert.match(c.send.detail, /does not exist/);
});
