// What the energy manager's devices should tell the user (notification trigger 'energy_device').
// Pure: the status of this minute + a small memory of how long something has been going on ->
// alerts { key, title, message, severity }. The key makes each one go out once (notifications.js keeps
// the sent keys per rule for two weeks).
//   mem: { defrostSince, limitSince } — kept by the caller between minutes, updated here
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
    out.push({ key: `leg|${dayKey(L.due || nowMs)}`, severity: 'warning', title: 'Heat pump: legionella overdue',
      message: `The tank was not held hot enough in time${L.lastDoneMs ? ` (last time ${new Date(L.lastDoneMs).toISOString().slice(0, 10)})` : ''}. ${L.block ? 'A block is planned.' : 'No block fits today: check the times.'}` });
  }
  const min = Number(st.limits?.comfortMinC);
  const low = (st.plan || []).find((h) => Number.isFinite(h.predC) && h.predC < min - 0.5);
  if (Number.isFinite(min) && low) {
    out.push({ key: `tank|${dayKey(low.ms)}`, severity: 'warning', title: 'Heat pump: tank expected too cold',
      message: `The tank is expected to drop to ${r1(low.predC)} °C around ${clockOf(low.ms, localParts)}, below your minimum of ${min} °C.` });
  }
  const code = Number(st.values?.errorCode);
  if (Number.isFinite(code) && code !== 0) {
    out.push({ key: `fault|${code}|${dayKey(nowMs)}`, severity: 'error', title: 'Heat pump: fault', message: `The unit reports error code ${code}.` });
  }
  const defrosting = st.state?.mode === 'defrost';
  if (defrosting && !mem.defrostSince) mem.defrostSince = nowMs;
  if (!defrosting) mem.defrostSince = null;
  if (mem.defrostSince && nowMs - mem.defrostSince >= defrostMaxMin * MIN) {
    out.push({ key: `defrost|${mem.defrostSince}`, severity: 'warning', title: 'Heat pump: defrosting does not end',
      message: `It has been defrosting for ${Math.round((nowMs - mem.defrostSince) / MIN)} minutes (usually a few).` });
  }
  return out;
}

function solarAlerts(st, mem, nowMs, { limitMaxH = 3 } = {}) {
  const out = [];
  const limited = st.limit && Number(st.limit.pct) < 100;
  if (limited && !mem.limitSince) mem.limitSince = nowMs;
  if (!limited) mem.limitSince = null;
  if (mem.limitSince && nowMs - mem.limitSince >= limitMaxH * HOUR) {
    out.push({ key: `limit|${dayKey(mem.limitSince)}`, severity: 'info', title: 'Solar panels: limited for hours',
      message: `The inverter has been limited to ${st.limit.pct}% for ${r1((nowMs - mem.limitSince) / HOUR)} hours: exporting costs money now.` });
  }
  return out;
}

// LoxSuite's heartbeat to Loxone failing: Loxone falls back to its own logic, the user should know why.
function heartbeatAlert(kind, hb, nowMs) {
  if (!hb || !hb.error || !hb.failingSince || nowMs - hb.failingSince < 5 * MIN) return [];
  return [{ key: `hb|${kind}|${hb.failingSince}`, severity: 'error', title: kind === 'solar' ? 'Solar panels: heartbeat to Loxone fails' : 'Heat pump: heartbeat to Loxone fails',
    message: `LoxSuite cannot reach the virtual input ${hb.vi} (${hb.error}). Loxone falls back to its own logic.` }];
}

module.exports = { heatpumpAlerts, solarAlerts, heartbeatAlert };
