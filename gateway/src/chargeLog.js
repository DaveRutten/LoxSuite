// Smart charging > Charge log: a flight recorder for the Wallbox. While a car is connected (and for a
// few minutes around every value LoxSuite sends) it keeps, every 10 s when something changes and at
// least once a minute: what the Wallbox reports (connected, enabled, active, power, limit, mode,
// session kWh), what LoxSuite sent to the virtual inputs (test button or Live output), what the
// planner advised, and what the car itself says (battery %, plugged, charging state as delivered).
// Per session it then checks the things that matter before trusting Live control:
//   - at 0 kW the Wallbox doesn't charge, and the car waits without an error;
//   - after a request it starts within 2 minutes (also after waiting 10+ minutes: the car woke up);
//   - the power follows the value sent; at 0 it stops within a minute.
// Everything stays in LoxSuite (charge_log table, 45 days) so a test can be done any time and
// looked at — or downloaded and shared — later.
const db = require('./db');

const SAMPLE_MS = 10 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const AFTER_EVENT_MS = 3 * 60 * 1000;
const KEEP_DAYS = 45;
const START_WITHIN_S = 120;
const STOP_WITHIN_S = 60;
const ON_KW = 1.0;   // the Wallbox counts as charging above this
const OFF_KW = 0.3;  // ... and as not charging below this

let timer = null;
let last = null;           // last stored sample (for change detection)
let lastStoredAt = 0;
let lastEventAt = 0;
let session = null;        // current session key
const sent = { kw: null, enable: null, at: null, source: null };

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

// --------------------------------------------------------------------------- recording

// Called by the test button and the Live output whenever a value is written to Loxone.
async function recordSent({ kw, enable = null, source, ok = true, error = null, miniserver = null }) {
  const now = Date.now();
  if (ok) Object.assign(sent, { kw: num(kw), enable, at: now, source });
  lastEventAt = now;
  await insert(now, ok ? `${source === 'test' ? 'Test' : 'Live'}: sent ${kw} kW${enable !== null ? ` (charging allowed ${enable})` : ''}${miniserver ? ` to ${miniserver}` : ''}`
    : `${source === 'test' ? 'Test' : 'Live'}: sending ${kw} kW FAILED — ${error}`, await snapshot()).catch(() => {});
}

async function snapshot() {
  const planner = require('./planner');
  const wb = await planner.wallboxLive().catch(() => null);
  const rt = planner.getRuntime();
  const s = {
    connected: wb ? (wb.connected ? 1 : 0) : null, enabled: wb ? num(wb.enabled) : null, active: wb ? (wb.active ? 1 : 0) : null,
    kw: wb ? r2(wb.kw) : null, limit: wb ? num(wb.limit) : null, mode: wb ? num(wb.mode) : null, sessionKwh: wb ? r2(wb.sessionKwh) : null,
    sentKw: sent.kw, sentEnable: sent.enable, sentSource: sent.source,
    advisedKw: num(rt.status?.setpointKw), reason: rt.status?.reason || null, output: rt.status?.output || null,
  };
  // The car: the one that says it's plugged in, otherwise the first enabled one.
  try {
    const vehicles = require('./vehicles');
    const list = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id').all();
    const withStatus = list.map((v) => ({ v, st: vehicles.getVehicleStatus(v) }));
    const car = withStatus.find((x) => x.st.reading?.plugged === true) || withStatus[0];
    if (car) {
      const rd = car.st.reading || {};
      Object.assign(s, {
        car: car.v.name, soc: num(rd.soc), plugged: rd.plugged ?? null, charging: rd.charging ?? null,
        carState: car.st.raw?.charging !== undefined ? String(car.st.raw.charging) : (car.st.raw?.plugged !== undefined ? String(car.st.raw.plugged) : null),
      });
    }
  } catch { /* no vehicles */ }
  return s;
}

async function insert(t, event, s) {
  const key = session || (s.connected ? `s${t}` : 'idle');
  await db.prepare('INSERT INTO charge_log (ts, session_key, event, data) VALUES (?, ?, ?, ?)')
    .run(new Date(t).toISOString(), key, event, JSON.stringify(s));
  last = s;
  lastStoredAt = t;
}

function changed(a, b) {
  if (!a) return true;
  for (const k of ['connected', 'enabled', 'active', 'limit', 'mode', 'sentKw', 'sentEnable', 'plugged', 'charging', 'carState', 'advisedKw', 'output']) {
    if (a[k] !== b[k]) return true;
  }
  return Math.abs((a.kw || 0) - (b.kw || 0)) >= 0.3;
}

async function sample(now = Date.now()) {
  const s = await snapshot();
  const connected = s.connected === 1;
  let event = null;
  if (connected && !session) { session = `s${now}`; event = 'Car plugged in'; }
  if (!connected && session && (last?.connected === 1)) event = 'Car unplugged';
  const active = connected || now - lastEventAt < AFTER_EVENT_MS || event;
  if (!active) { if (session && !connected) session = null; return null; }
  if (!event && !changed(last, s) && now - lastStoredAt < HEARTBEAT_MS) return null;
  await insert(now, event, s);
  if (event === 'Car unplugged') session = null;
  return s;
}

async function prune() {
  await db.prepare('DELETE FROM charge_log WHERE ts < ?').run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
}

function startChargeLog() {
  if (timer) return;
  timer = setInterval(() => { sample().catch(() => {}); }, SAMPLE_MS);
  timer.unref?.();
  const p = setInterval(() => { prune().catch(() => {}); }, 6 * 3600 * 1000);
  p.unref?.();
}

// --------------------------------------------------------------------------- analysis (pure)

// rows: [{ t (ms), event, d: sample }] of one session, oldest first. Returns the checks with
// status 'pass' | 'fail' | 'info' | 'pending' (not tested yet) and a short Dutch-free English text.
function analyzeSession(rows, nowMs = Date.now()) {
  const checks = [];
  const add = (id, status, title, detail) => checks.push({ id, status, title, detail });
  const conn = rows.filter((r) => r.d.connected === 1);
  const requests = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i ? rows[i - 1].d.sentKw : null;
    if (r.d.sentKw !== null && r.d.sentKw !== undefined && r.d.sentKw !== prev && /sent/i.test(r.event || '')) requests.push({ i, t: r.t, kw: r.d.sentKw });
  }
  // Waiting at 0: connected, last sent value 0 (or nothing sent and no charging asked).
  // Skip the first minute after a 0 that stopped a running charge: that's the stop itself (checked below).
  const stopAt = requests.filter((q) => q.kw === 0).map((q) => q.t);
  const zeroRows = conn.filter((r) => r.d.sentKw === 0 && !stopAt.some((t) => r.t >= t && r.t < t + STOP_WITHIN_S * 1000));
  if (zeroRows.length) {
    const maxKw = Math.max(...zeroRows.map((r) => r.d.kw || 0));
    // Time spent at 0 with the car connected: from each zero row to the next row (rows are stored on change).
    let spanMs = 0;
    for (const r of zeroRows) {
      const nx = rows.find((x) => x.t > r.t);
      spanMs += (nx ? nx.t : Date.now()) - r.t;
    }
    const span = spanMs / 60000;
    add('zero', maxKw < OFF_KW ? 'pass' : 'fail', 'At 0 kW the Wallbox does not charge',
      maxKw < OFF_KW ? `Max ${maxKw.toFixed(2)} kW over ${Math.round(span)} min with the car connected.` : `It drew up to ${maxKw.toFixed(1)} kW while 0 was sent — wire "charging allowed" to Ec.`);
    const states = [...new Set(zeroRows.map((r) => r.d.carState).filter(Boolean))];
    const err = states.find((s) => /error|fault|fehler|storing|failure/i.test(s));
    add('wait', err ? 'fail' : states.length ? 'pass' : 'info', 'The car waits without an error',
      err ? `The car reported "${err}" while waiting.` : states.length ? `Car state while waiting: ${states.join(', ')}.` : 'The car reported no charging state (map it under Vehicles to check this).');
  } else {
    add('zero', 'pending', 'At 0 kW the Wallbox does not charge', 'Not tested yet: plug the car in while 0 is sent.');
  }
  // Starts and stops.
  const starts = requests.filter((q) => q.kw >= ON_KW);
  const stops = requests.filter((q) => q.kw === 0 && rows.slice(0, q.i).some((r) => (r.d.kw || 0) >= ON_KW));
  const connectedAt = (t) => { const r = [...rows].reverse().find((x) => x.t <= t); return r?.d.connected === 1; };
  const startResults = starts.filter((q) => connectedAt(q.t)).map((q) => {
    const next = requests.find((x) => x.t > q.t);
    const until = Math.min(q.t + 10 * 60000, next ? next.t - 1 : Infinity);
    const after = rows.filter((r) => r.t >= q.t && r.t <= until);
    const hit = after.find((r) => (r.d.kw || 0) >= ON_KW);
    const waitedMin = (() => { // how long it had been at 0 with the car connected before this request
      let t0 = q.t;
      for (let j = q.i - 1; j >= 0 && rows[j].d.connected === 1 && (rows[j].d.kw || 0) < OFF_KW; j--) t0 = rows[j].t;
      return (q.t - t0) / 60000;
    })();
    // Steady power: the last readings of the window (rows are stored on change, so the ramp-up
    // has few rows and the settled value is the last one).
    const tail = hit ? after.filter((r) => r.t >= hit.t).slice(-3).map((r) => r.d.kw || 0) : [];
    const steady = tail.length ? Math.max(...tail) : null;
    // Battery (nearly) full: a car near 100% often takes nothing at all.
    const socAt = [...rows].reverse().find((r) => r.t <= q.t + 60000 && r.d.soc !== null && r.d.soc !== undefined)?.d.soc ?? null;
    const full = socAt !== null && socAt >= 95;
    // Still within the time it may take to start (the session goes on, nothing more recorded yet).
    const lastT = Math.max(rows[rows.length - 1].t, rows[rows.length - 1].d.connected === 1 ? nowMs : 0);
    const waiting = !hit && lastT - q.t < START_WITHIN_S * 1000 && !next;
    // What the Wallbox itself did with the request: released (limit/enabled) but no power drawn?
    const wbAfter = after.filter((r) => r.t >= q.t);
    const released = wbAfter.some((r) => (r.d.limit ?? 0) >= ON_KW && r.d.enabled !== 0);
    return { q, secs: hit ? Math.round((hit.t - q.t) / 1000) : null, waitedMin, steady, full, socAt, waiting, released };
  });
  if (startResults.length) {
    const ok = startResults.filter((s) => s.secs !== null && s.secs <= START_WITHIN_S);
    const open = startResults.filter((s) => s.secs === null && !s.waiting && !s.full);
    const status = open.length ? 'fail' : ok.length === startResults.length ? 'pass' : startResults.some((s) => s.waiting) ? 'pending' : 'info';
    add('start', status, 'It starts charging when asked', startResults.map((s) => {
      if (s.secs !== null) return `${s.q.kw} kW: started after ${s.secs} s`;
      if (s.waiting) return `${s.q.kw} kW: waiting for it to start (up to ${START_WITHIN_S / 60} min)…`;
      const wb = s.released ? 'the Wallbox released it (limit set), but the car took no power' : 'the Wallbox did not release it (limit/enabled stayed 0)';
      if (s.full) return `${s.q.kw} kW: battery at ${Math.round(s.socAt)}% — ${wb}; normal for a (nearly) full battery, test again with a lower battery`;
      return `${s.q.kw} kW: did not start — ${wb}`;
    }).join('; ') + '.');
    const woke = startResults.filter((s) => s.waitedMin >= 10);
    if (woke.length) {
      add('wake', woke.every((s) => s.secs !== null && s.secs <= START_WITHIN_S) ? 'pass' : 'fail', 'It also starts after waiting 10+ minutes',
        woke.map((s) => `after ${Math.round(s.waitedMin)} min waiting: ${s.secs === null ? 'no start' : `started in ${s.secs} s`}`).join('; ') + '.');
    } else add('wake', 'pending', 'It also starts after waiting 10+ minutes', 'Not tested yet: leave the car at 0 for 10 minutes, then send a value.');
    const follow = startResults.filter((s) => s.steady !== null && s.secs !== null);
    if (follow.length) {
      const bad = follow.filter((s) => Math.abs(s.steady - s.q.kw) > Math.max(0.8, s.q.kw * 0.15));
      // Near full a car tapers its own charging power: lower than asked is then normal.
      const nearFull = bad.length && bad.every((s) => s.socAt !== null && s.socAt >= 90);
      if (nearFull) {
        add('follow', 'info', 'The power follows the value sent',
          follow.map((s) => `${s.q.kw} kW sent → about ${s.steady.toFixed(1)} kW`).join('; ') + ` — battery at ${Math.round(follow[0].socAt)}%: the car tapers near full, test again with a lower battery.`);
      } else
      add('follow', bad.length ? 'fail' : 'pass', 'The power follows the value sent',
        follow.map((s) => `${s.q.kw} kW sent → about ${s.steady.toFixed(1)} kW`).join('; ') + (bad.length ? ' (the car may limit it, e.g. near full or a charge-current setting in the car).' : '.'));
    }
  } else {
    add('start', 'pending', 'It starts charging when asked', 'Not tested yet: send for example 6 kW with the car connected.');
  }
  if (stops.length) {
    const res = stops.map((q) => {
      const hit = rows.find((r) => r.t >= q.t && (r.d.kw || 0) < OFF_KW);
      return hit ? Math.round((hit.t - q.t) / 1000) : null;
    });
    add('stop', res.every((s) => s !== null && s <= STOP_WITHIN_S) ? 'pass' : 'fail', 'It stops at 0',
      res.map((s) => (s === null ? 'did not stop' : `stopped after ${s} s`)).join('; ') + '.');
  } else if (startResults.some((s) => s.secs !== null)) {
    add('stop', 'pending', 'It stops at 0', 'Not tested yet: send 0 while it is charging.');
  }
  const failures = rows.filter((r) => /FAILED/.test(r.event || ''));
  if (failures.length) add('send', 'fail', 'Values reach Loxone', failures.map((r) => r.event.replace(/^.*FAILED — /, '')).slice(0, 3).join(' | '));
  else if (requests.length) add('send', 'pass', 'Values reach Loxone', `${requests.length} value(s) sent without an error.`);
  return checks;
}

// One readable block to paste somewhere (or into a chat) to discuss a session.
function summaryText(sessionRow, checks, rows) {
  const icon = { pass: '[OK]', fail: '[FAIL]', info: '[i]', pending: '[--]' };
  const lines = [`LoxSuite charge log — session ${new Date(sessionRow.from).toISOString()} → ${sessionRow.to ? new Date(sessionRow.to).toISOString() : 'now'}`];
  for (const c of checks) lines.push(`${icon[c.status]} ${c.title}: ${c.detail}`);
  lines.push('', 'Events:');
  for (const r of rows.filter((x) => x.event)) {
    lines.push(`${new Date(r.t).toISOString().slice(11, 19)} ${r.event} | wallbox ${r.d.kw ?? '?'} kW, limit ${r.d.limit ?? '?'}, mode ${r.d.mode ?? '?'}, car ${r.d.soc ?? '?'}% ${r.d.carState || ''}`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------- queries

function parseRows(list) {
  return list.map((r) => { let d = {}; try { d = JSON.parse(r.data); } catch { d = {}; } return { t: Date.parse(r.ts), event: r.event || null, d }; });
}

async function sessions(limit = 40) {
  const rows = await db.prepare("SELECT session_key, MIN(ts) AS t0, MAX(ts) AS t1, COUNT(*) AS n FROM charge_log WHERE session_key <> 'idle' GROUP BY session_key ORDER BY MIN(ts) DESC").all();
  const out = [];
  for (const s of rows.slice(0, limit)) {
    const r = parseRows(await db.prepare('SELECT ts, event, data FROM charge_log WHERE session_key = ? ORDER BY ts').all(s.session_key));
    const checks = analyzeSession(r);
    const kwh = Math.max(0, ...r.map((x) => x.d.sessionKwh || 0));
    out.push({ key: s.session_key, from: Date.parse(s.t0), to: Date.parse(s.t1), samples: Number(s.n), kwh: r2(kwh), car: r.find((x) => x.d.car)?.d.car || null, checks });
  }
  return out;
}

async function sessionDetail(key) {
  const rows = parseRows(await db.prepare('SELECT ts, event, data FROM charge_log WHERE session_key = ? ORDER BY ts').all(key));
  if (!rows.length) return null;
  const checks = analyzeSession(rows);
  const info = { key, from: rows[0].t, to: rows[rows.length - 1].t };
  return { ...info, checks, rows, summary: summaryText(info, checks, rows) };
}

// Samples outside a session (tests with no car connected), newest first.
async function idleEvents(limit = 50) {
  return parseRows(await db.prepare("SELECT ts, event, data FROM charge_log WHERE session_key = 'idle' AND event IS NOT NULL ORDER BY ts DESC").all()).slice(0, limit);
}

module.exports = { recordSent, sample, snapshot, startChargeLog, analyzeSession, summaryText, sessions, sessionDetail, idleEvents, prune };
