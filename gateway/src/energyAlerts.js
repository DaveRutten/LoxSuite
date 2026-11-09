// What the energy manager's devices should tell the user (notification trigger 'energy_device').
// Pure: the status of this minute + a small memory of how long something has been going on ->
// alerts { key, title, message, severity, i18n }. The key makes each one go out once (notifications.js keeps
// the sent keys per rule for two weeks). Texts are English templates with {params} (energyChecks.made), made
// in the user's language when the notification is sent.
//   mem: { defrostSince, limitSince } — kept by the caller between minutes, updated here
const { made } = require('./energyChecks');

const MIN = 60000;
const HOUR = 3600000;
const r1 = (x) => Math.round(x * 10) / 10;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
// local time of day; localParts(ms) from localTime.js (the display time zone)
const clockOf = (ms, localParts) => { if (!localParts) return new Date(ms).toISOString().slice(11, 16); const p = localParts(ms); return `${pad(p.hour)}:${pad(p.minute)}`; };

function heatpumpAlerts(st, mem, nowMs, { defrostMaxMin = 30, localParts = null } = {}) {
  const out = [];
  const L = st.legionella;
  if (L && L.overdue) {
    const last = L.lastDoneMs ? new Date(L.lastDoneMs).toISOString().slice(0, 10) : null;
    const msg = last
      ? (L.block ? 'The tank was not held hot enough in time (last time {d}). A block is planned.' : 'The tank was not held hot enough in time (last time {d}). No block fits today: check the times.')
      : (L.block ? 'The tank was not held hot enough in time. A block is planned.' : 'The tank was not held hot enough in time. No block fits today: check the times.');
    out.push(made(`leg|${dayKey(L.due || nowMs)}`, 'warning', ['Heat pump: legionella overdue'], [msg, { d: last }]));
  }
  const min = Number(st.limits?.comfortMinC);
  const low = (st.plan || []).find((h) => Number.isFinite(h.predC) && h.predC < min - 0.5);
  if (Number.isFinite(min) && low) {
    out.push(made(`tank|${dayKey(low.ms)}`, 'warning', ['Heat pump: tank expected too cold'],
      ['The tank is expected to drop to {c} °C around {t}, below your minimum of {m} °C.', { c: r1(low.predC), t: clockOf(low.ms, localParts), m: min }]));
  }
  const code = Number(st.values?.errorCode);
  if (Number.isFinite(code) && code !== 0) {
    out.push(made(`fault|${code}|${dayKey(nowMs)}`, 'error', ['Heat pump: fault'], ['The unit reports error code {c}.', { c: code }]));
  }
  const defrosting = st.state?.mode === 'defrost';
  if (defrosting && !mem.defrostSince) mem.defrostSince = nowMs;
  if (!defrosting) mem.defrostSince = null;
  if (mem.defrostSince && nowMs - mem.defrostSince >= defrostMaxMin * MIN) {
    out.push(made(`defrost|${mem.defrostSince}`, 'warning', ['Heat pump: defrosting does not end'],
      ['It has been defrosting for {m} minutes (usually a few).', { m: Math.round((nowMs - mem.defrostSince) / MIN) }]));
  }
  return out;
}

function solarAlerts(st, mem, nowMs, { limitMaxH = 3 } = {}) {
  const out = [];
  const limited = st.limit && Number(st.limit.pct) < 100;
  if (limited && !mem.limitSince) mem.limitSince = nowMs;
  if (!limited) mem.limitSince = null;
  if (mem.limitSince && nowMs - mem.limitSince >= limitMaxH * HOUR) {
    out.push(made(`limit|${dayKey(mem.limitSince)}`, 'info', ['Solar panels: limited for hours'],
      ['The inverter has been limited to {p}% for {h} hours: exporting costs money now.', { p: st.limit.pct, h: r1((nowMs - mem.limitSince) / HOUR) }]));
  }
  return out;
}

// LoxSuite's heartbeat to Loxone failing: Loxone falls back to its own logic, the user should know why.
function heartbeatAlert(kind, hb, nowMs) {
  if (!hb || !hb.error || !hb.failingSince || nowMs - hb.failingSince < 5 * MIN) return [];
  return [made(`hb|${kind}|${hb.failingSince}`, 'error', [kind === 'solar' ? 'Solar panels: heartbeat to Loxone fails' : 'Heat pump: heartbeat to Loxone fails'],
    ['LoxSuite cannot reach the virtual input {vi} ({e}). Loxone falls back to its own logic.', { vi: hb.vi, e: hb.error }])];
}

module.exports = { heatpumpAlerts, solarAlerts, heartbeatAlert };
