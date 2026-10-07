// The "Last session" tile on Smart charging: in the morning, what happened at night.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { summarizeSession } = require('../src/chargeLog');

const T = (h, m = 0, day = 6) => Date.parse(`2026-10-0${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const row = (t, d, event = null) => ({ t, event, d: { connected: 1, ...d } });

test('a night session: plugged in, charged in two blocks (a short pause joined), unplugged in the morning', () => {
  const rows = [
    row(T(16, 10), { kw: 0, sessionKwh: 0, soc: 42, car: 'Kodiaq' }, 'Car plugged in'),
    row(T(23, 0), { kw: 7.4, sessionKwh: 0, soc: 42 }),
    row(T(23, 30), { kw: 7.3, sessionKwh: 3.7, soc: 56 }),
    row(T(23, 58), { kw: 0.1, sessionKwh: 7.2, soc: 70 }), // planned interval boundary
    row(T(0, 1, 7), { kw: 7.4, sessionKwh: 7.2, soc: 70 }),
    row(T(1, 20, 7), { kw: 0, sessionKwh: 16.9, soc: 100 }),
    { t: T(5, 40, 7), event: 'Car unplugged', d: { connected: 0, kw: 0, sessionKwh: 16.9, soc: 100 } },
  ];
  const s = summarizeSession(rows, T(7, 0, 7));
  assert.equal(s.pluggedAt, T(16, 10));
  assert.equal(s.unpluggedAt, T(5, 40, 7));
  assert.equal(s.connected, false);
  assert.equal(s.kwh, 16.9);
  assert.equal(s.spans.length, 1, 'the 3-minute pause at midnight is the same charge');
  assert.equal(s.spans[0].from, T(23, 0));
  assert.equal(s.spans[0].to, T(1, 20, 7));
  assert.equal(s.peakKw, 7.4);
  assert.equal(s.socFrom, 42);
  assert.equal(s.socTo, 100);
  assert.equal(s.car, 'Kodiaq');
});

test('still plugged in and charging now; nothing charged yet', () => {
  const now = T(2, 0, 7);
  const charging = summarizeSession([row(T(22, 0), { kw: 0, sessionKwh: 0 }), row(T(1, 0, 7), { kw: 11, sessionKwh: 0 }), row(now - 30000, { kw: 11, sessionKwh: 11 })], now);
  assert.equal(charging.connected, true);
  assert.equal(charging.chargingNow, true);
  assert.equal(charging.unpluggedAt, null);
  assert.equal(charging.spans[0].to, null);
  const idle = summarizeSession([row(T(22, 0), { kw: 0, sessionKwh: 0 }), row(now - 30000, { kw: 0, sessionKwh: 0 })], now);
  assert.equal(idle.spans.length, 0);
  assert.equal(idle.kwh, 0);
  assert.equal(idle.connected, true);
  assert.equal(summarizeSession([], now), null);
});

test('the Smart charging page shows the tile and the status gives the session', () => {
  const v = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'planner.ejs'), 'utf8');
  assert.match(v, /lastSessionTile\(d\.lastSession\)/);
  assert.match(v, /\/planner\/log\?session=/);
  const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'planner.js'), 'utf8');
  assert.match(r, /lastSession: lastSessionCache\.value/);
});
