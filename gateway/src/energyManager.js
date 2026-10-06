// Energy manager: the other big consumers next to the car, planned together with it.
//
// Shadow mode first. LoxSuite measures every load (its own Loxone meter), makes a plan over the
// next ~24-36 hours from the prices, the solar forecast and the learned house load, and works out
// per minute what it WOULD send to Loxone (the "shadow signals"). Nothing is written to Loxone until
// a load's output is switched to Live — that comes later, once the wiring is in place. Meanwhile the
// page shows, per load and per day, what happened, what it cost, how much fell in the hours LoxSuite
// would have chosen and what that could have saved.
//
// Kinds (and the virtual inputs they would drive later):
//   dhw        tap water: the best block of the day for heating the tank (solar surplus first, else the
//              cheapest hours) -> <name>_Nu (1/0) and a buffer setpoint (°C) for cheap/solar hours.
//   heatpump   space heating/cooling, the living room leads: release (1/0) in the cheapest hours and
//              whenever there is surplus, never blocked longer than max_block_h, plus a setpoint
//              correction (°C): pre-heat (or pre-cool) in cheap/solar hours, ease off in expensive ones.
//   appliance  washing machine, dryer...: measured runs (kWh, duration, cost, the best start in
//              hindsight); "ready by" requests get a planned start -> <name>_Start / <name>_Pauze.
// The surplus is shared in priority order, with the car (Smart charging) at its own place in that order.
const db = require('./db');

const KINDS = {
  dhw: {
    label: 'Tap water',
    defaults: { kw: 2.5, duration_h: 1, earliest: 9, latest: 21, normal_setpoint: 52, buffer_setpoint: 58 },
    signals: [
      { key: 'now', suffix: 'Nu', unit: '1/0', hint: 'extra condition for the tap-water sequencer (next to Sun_Power)' },
      { key: 'setpoint', suffix: 'Setpoint', unit: '°C', hint: 'instead of the fixed tap-water setpoint (optional)' },
    ],
  },
  heatpump: {
    label: 'Heat pump (heating/cooling)',
    defaults: { kw: 1.5, season: 'heating', release_share: 0.6, max_block_h: 3, up: 1, down: 0.5 },
    signals: [
      { key: 'release', suffix: 'Vrijgave', unit: '1/0', hint: 'next to (OR) or instead of the "grid < −0.6 kW" release' },
      { key: 'correction', suffix: 'Correctie', unit: '°C', hint: 'added to the living-room setpoint' },
    ],
  },
  appliance: {
    label: 'Appliance (washer, dryer…)',
    defaults: { kw: 1.0, flex_h: 8, max_pause_h: 0, max_pauses: 2 },
    signals: [
      { key: 'start', suffix: 'Start', unit: 'pulse', hint: 'Home Connect start' },
      { key: 'pause', suffix: 'Pauze', unit: 'pulse', hint: 'Home Connect pause (only when pausing is allowed)' },
      { key: 'resume', suffix: 'Verder', unit: 'pulse', hint: 'Home Connect resume ("Verder")' },
    ],
  },
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const HOUR = 3600000;

function parseSettings(load) {
  let s = {};
  try { s = JSON.parse(load.settings || '{}') || {}; } catch { s = {}; }
  return { ...(KINDS[load.kind]?.defaults || {}), ...s };
}

// The Loxone signals of a consumer (all optional, next to its meter): state uuids on its Miniserver.
//   onoff   on/off state (≠ 0 = on, or inverted)
//   status  an enumerator state; status_map "0=Off\n1=Washing\n2=Spinning", status_on "1,2" = the values
//           that count as running (empty: everything except 0 / off)
//   power   power in W or kW
//   energy  an energy counter in kWh or Wh (when there is no Loxone meter block)
//   start_in  time until a scheduled (delayed) start, in h / min / s (0 = not scheduled)
//   ready   1 = ready to be started remotely (Home Connect "remote start allowed"); also read from the
//           status text ("Startklaar", "Klaar voor start", "Op afstand starten")
function sourcesOf(settings = {}) {
  const src = settings.src || {};
  return {
    onoff: src.onoff || null, onoffInvert: !!src.onoff_invert,
    status: src.status || null, statusMap: parseStatusMap(src.status_map), statusOn: parseList(src.status_on),
    power: src.power || null, powerUnit: src.power_unit === 'kW' ? 'kW' : 'W',
    energy: src.energy || null, energyUnit: src.energy_unit === 'Wh' ? 'Wh' : 'kWh',
    temp: src.temp || null,
    ready: src.ready || null,
    startIn: src.start_in || null, startInUnit: ['min', 's'].includes(src.start_in_unit) ? src.start_in_unit : 'h',
  };
}

// Pure: "0=Off\n1=Washing, 2 = Spinning" -> { '0': 'Off', '1': 'Washing', '2': 'Spinning' }.
function parseStatusMap(text) {
  const out = {};
  for (const part of String(text || '').split(/[\n;,]+/)) {
    const m = /^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/.exec(part);
    if (m) out[m[1]] = m[2].slice(0, 40);
  }
  return out;
}
// Pure: a status text from Loxone (a Status block's textAndIcon) cleaned up to book per status: the
// consumer's own name in front ("Wasmachine uitgeschakeld" -> "Uitgeschakeld") and a countdown or
// clock time ("Wassen - nog 45 min", "klaar om 14:30") left off, so one step doesn't become a new
// status every minute.
function cleanStatusText(text, name = '') {
  const orig = String(text ?? '').trim();
  let t = orig;
  const n = String(name || '').trim();
  if (n && t.toLowerCase().startsWith(n.toLowerCase())) t = t.slice(n.length);
  const named = t;
  t = t.replace(/\b(nog|rest(erend)?|resterende tijd|remaining)\b.*$/i, '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')
    .replace(/\b\d+([.,]\d+)?\s*(%|min(uten|utes)?|uur|h|kwh|kw|w)(?![a-z])/gi, '')
    .replace(/\s+(om|at|in|over)\s*$/i, '')
    .replace(/^[\s\-–—·:,|()]+|[\s\-–—·:,|()]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!t) t = named.replace(/^[\s\-–—·:,|()]+|[\s\-–—·:,|()]+$/g, '').trim() || orig;
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 40);
}
// Pure: does a status (text or label) mean it is not running (off, idle, done, paused, waiting)?
const OFF_TEXT = /(^|[^a-zà-ÿ])(uitgeschakeld|uit|off|switched off|idle|stand-?by|klaar|gereed|beëindigd|beeindigd|einde|afgelopen|finished|done|ready|offline|niet verbonden|disconnected|gepauzeerd|pauze|paused|uitgesteld|uitgestelde|delayed|wacht|wachten|waiting|ingepland|gepland|scheduled|startklaar|start gereed|startgereed|voltooid|afgebroken|fout|error|actie vereist|action required|aborted|aborting|inactief|inactive)($|[^a-zà-ÿ])/i;
function isOffText(t) { return OFF_TEXT.test(String(t ?? '')); }
// Pure: a scheduled (delayed) start in a status text — "Ingepland", "Uitgestelde start", "Start over
// 2 uur 30 min", "start om 14:30" — as { scheduled, startMs } (startMs null when the text has no time).
const SCHEDULED_TEXT = /(ingepland|gepland|uitgesteld|uitgestelde start|scheduled|delayed start|start over|starts in|start om|starts at|starttijd)/i;
function scheduledFromText(text, nowMs = Date.now(), tz) {
  const t = String(text ?? '');
  if (!SCHEDULED_TEXT.test(t)) return { scheduled: false, startMs: null };
  const lt = require('./localTime');
  const dur = /(?:over|in|nog)\s+(?:(\d+)\s*(?:uur|u|h|hours?)\b)?\s*(?:(\d+)\s*(?:min|minuten|minutes|m)\b)?/i.exec(t);
  if (dur && (dur[1] || dur[2])) return { scheduled: true, startMs: nowMs + ((Number(dur[1]) || 0) * 60 + (Number(dur[2]) || 0)) * 60000 };
  const hm = /(?:over|in|nog)\s+(\d{1,2}):(\d{2})\b/i.exec(t);
  if (hm) return { scheduled: true, startMs: nowMs + (Number(hm[1]) * 60 + Number(hm[2])) * 60000 };
  const clock = /(?:om|at|start(?:tijd)?:?)\s*(\d{1,2})[:.](\d{2})\b/i.exec(t);
  if (clock) {
    let at = lt.localTimeOn(nowMs, `${clock[1]}:${clock[2]}`, tz);
    if (at < nowMs - 5 * 60000) at = lt.localTimeOn(nowMs + DAY_MS, `${clock[1]}:${clock[2]}`, tz);
    return { scheduled: true, startMs: at };
  }
  return { scheduled: true, startMs: null };
}

// Pure: does a status text say the appliance is loaded and may be started remotely?
const READY_TEXT = /(start ?gereed|startklaar|klaar (voor|om te) start|gereed (voor|om te) start|ready to start|remote start|op afstand start|start op afstand|^\s*(gereed|ready)\s*$)/i;
// Home Connect's operation state (BSH.Common.Status.OperationState) as Loxone gives it: a number.
const HOME_CONNECT_STATUS = '0=Inactief\n1=Gereed\n2=Uitgestelde start\n3=Programma loopt\n4=Programma gepauzeerd\n5=Actie vereist\n6=Programma voltooid\n7=Fout\n8=Programma afgebroken';
const HOME_CONNECT_RUNNING = '3';
function isReadyText(t) { return READY_TEXT.test(String(t ?? '')); }

// Pure: words that just mean "off" ("Uitgeschakeld", "Off", "Stand-by") are booked as 'off' — the same
// bucket as the on/off signal's off. Done, paused or waiting stay their own (not running) status.
const OFF_SYNONYM = /^(0|off|uit|uitgeschakeld|switched off|turned off|stand-?by|standby|idle|inactief|inactive)$/i;
function bucket(key) { return key === null || key === undefined ? key : OFF_SYNONYM.test(String(key).trim()) ? 'off' : String(key); }

const parseList = (text) => String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

// Pure: one reading of a consumer from its signals -> { kw, total, on, status, label, measured }.
//   meter: { kw, total } of the Loxone meter block (or nulls); raw: { onoff, status, power, energy }.
// "on" comes from the on/off state, else from the status (running values), else from the power.
function loadState({ meter = {}, raw = {}, src = sourcesOf({}), onKw = 0.05, name = '', nowMs = Date.now() }) {
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let kw = num(meter.kw);
  if (kw === null && src.power) { const p = num(raw.power); kw = p === null ? null : (src.powerUnit === 'kW' ? p : p / 1000); }
  let total = num(meter.total);
  if (total === null && src.energy) { const e = num(raw.energy); total = e === null ? null : (src.energyUnit === 'Wh' ? e / 1000 : e); }
  let status = null;
  let label = null;
  if (src.status && raw.status !== undefined && raw.status !== null && raw.status !== '') {
    const n = num(raw.status);
    status = n !== null ? String(Math.round(n * 1000) / 1000) : cleanStatusText(raw.status, name);
    label = src.statusMap[status] || (n === null ? status : null);
  }
  let on = null;
  if (src.onoff && raw.onoff !== undefined && raw.onoff !== null && raw.onoff !== '') {
    const v = num(raw.onoff);
    const b = v !== null ? v !== 0 : /^(on|aan|true|1)$/i.test(String(raw.onoff));
    on = src.onoffInvert ? !b : b;
  } else if (status !== null) {
    on = src.statusOn.length ? src.statusOn.includes(status) || (label !== null && src.statusOn.includes(label)) : !(status === '0' || isOffText(label || status));
  } else if (kw !== null) on = kw >= onKw;
  const temp = src.temp ? num(raw.temp) : null;
  // a scheduled start: from its own "start in" signal, else from the status text
  let startAt = null;
  const sIn = src.startIn ? num(raw.startIn) : null;
  if (sIn !== null && sIn > 0) startAt = nowMs + sIn * (src.startInUnit === 'min' ? 60000 : src.startInUnit === 's' ? 1000 : HOUR);
  else if (src.status && !on && (typeof raw.status === 'string' || label)) { const sc = scheduledFromText(typeof raw.status === 'string' ? raw.status : label, nowMs); if (sc.startMs) startAt = sc.startMs; }
  // ready to be started remotely: its own signal, else the status text
  let readyToStart = false;
  if (src.ready && raw.ready !== undefined && raw.ready !== null && raw.ready !== '') { const v = num(raw.ready); readyToStart = v !== null ? v !== 0 : /^(on|aan|true|1)$/i.test(String(raw.ready)); }
  else if (src.status && (typeof raw.status === 'string' || label)) readyToStart = isReadyText(typeof raw.status === 'string' ? raw.status : label);
  if (on || startAt) readyToStart = false; // running, or already scheduled on the machine itself
  return { kw, total, on, status, label, measured: total !== null || kw !== null, temp, startAt, readyToStart };
}

// Pure: the key a minute is booked under — the status label/value, else 'on'/'off'.
function statusKey(st) {
  if (st.status !== null && st.status !== undefined) return bucket(String(st.label || st.status).slice(0, 64));
  if (st.on === true) return 'on';
  if (st.on === false) return 'off';
  return null;
}

function viName(load, signal) {
  const s = parseSettings(load);
  if (s.vi && s.vi[signal.key]) return s.vi[signal.key];
  const base = String(load.name || load.kind).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `LoxSuite_${base}_${signal.suffix}`;
}

function quantile(arr, q) {
  const s = arr.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

// --------------------------------------------------------------------------- planning (pure)

// slots (planner.buildSlots) -> hourly [{ hour, ms, price, surplusKwh }]; unknown prices get the median.
function toHours(slots) {
  const map = new Map();
  for (const s of slots || []) {
    const ms = Math.floor(Date.parse(s.start) / HOUR) * HOUR;
    const h = map.get(ms) || { ms, hour: new Date(ms).toISOString(), prices: [], surplusKwh: Math.max(0, Number(s.pvKw) || 0) };
    if (s.price !== null && s.price !== undefined) h.prices.push(Number(s.price));
    map.set(ms, h);
  }
  const hours = [...map.values()].sort((a, b) => a.ms - b.ms);
  const med = quantile(hours.flatMap((h) => h.prices), 0.5);
  return hours.map((h) => ({
    ms: h.ms, hour: h.hour, surplusKwh: r3(h.surplusKwh),
    price: h.prices.length ? r3(h.prices.reduce((a, b) => a + b, 0) / h.prices.length) : med, estimated: !h.prices.length,
  }));
}

// The forecast, corrected with what the meters say right now. The current hour gets the real surplus
// (solar now minus the house now) for the part of the hour that is left; the next three hours get the
// solar forecast scaled towards how far off it is now (70 %, 45 %, 20 % of the deviation — a cloudy
// spell usually lasts a while, but not all day). pvF/houseF: forecast kWh per hour start.
function applyLive(hours, { pvF = {}, houseF = {}, pvKw = null, houseKw = null, nowMs }) {
  if (pvKw === null || pvKw === undefined || !Number.isFinite(Number(pvKw))) return { hours, live: null };
  const cur = Math.floor(nowMs / HOUR) * HOUR;
  const house = houseKw !== null && houseKw !== undefined && Number.isFinite(Number(houseKw)) ? Number(houseKw) : (houseF[cur] ?? 0.4);
  const surplusKw = Math.max(0, Number(pvKw) - house);
  const fPv = pvF[cur];
  const ratio = fPv > 0.3 ? Math.min(2, Math.max(0, Number(pvKw) / fPv)) : null;
  const weights = [0.7, 0.45, 0.2];
  const out = hours.map((h) => {
    if (h.ms === cur) return { ...h, surplusKwh: r3(surplusKw * Math.max(0, (cur + HOUR - nowMs) / HOUR)), live: true };
    const k = Math.round((h.ms - cur) / HOUR) - 1;
    if (ratio !== null && k >= 0 && k < weights.length && pvF[h.ms] !== undefined) {
      const pv = pvF[h.ms] * (1 + (ratio - 1) * weights[k]);
      return { ...h, surplusKwh: r3(Math.max(0, pv - (houseF[h.ms] ?? 0.4))), corrected: true };
    }
    return h;
  });
  return { hours: out, live: { pvKw: r2(Number(pvKw)), houseKw: r2(house), surplusKw: r2(surplusKw), pvForecastKw: fPv !== undefined ? r2(fPv) : null, ratio: ratio !== null ? r2(ratio) : null } };
}

// Cost of using `kwh` in an hour with `surplus` kWh of solar left: solar at its value, the rest at the price.
// Pure: the hours (indices into H, hourly and in order) for a run of `dur` hours between notBefore and
// readyBy (the run done by then) at the lowest cost — in one block, or with pauses of at most maxGapH
// hours (at most maxPauses of them) when the appliance may be paused. costOf(i) = cost of hour i.
function bestSteps(H, { dur, notBefore = 0, readyBy = Infinity, maxGapH = 0, maxPauses = 0, costOf }) {
  const ok = H.map((h) => h.ms >= (notBefore || 0) && h.ms + HOUR <= readyBy + 1);
  const P = maxGapH > 0 ? Math.max(0, maxPauses) : 0;
  // best[i][k][p]: lowest cost with k hours chosen, the last one i, p pauses so far
  const best = H.map(() => Array.from({ length: dur + 1 }, () => new Array(P + 1).fill(null)));
  let end = null;
  for (let i = 0; i < H.length; i++) {
    if (!ok[i]) continue;
    const c = costOf(i);
    best[i][1][0] = { cost: c, prev: null };
    for (let j = i - 1; j >= 0; j--) {
      const gap = Math.round((H[i].ms - H[j].ms) / HOUR) - 1;
      if (gap > (P ? maxGapH : 0)) break;
      if (!ok[j]) continue;
      for (let k = 1; k < dur; k++) for (let p = 0; p <= P; p++) {
        const b = best[j][k][p];
        if (!b) continue;
        const np = p + (gap > 0 ? 1 : 0);
        if (np > P) continue;
        const cand = b.cost + c;
        const cur = best[i][k + 1][np];
        if (!cur || cand < cur.cost - 1e-9 || (Math.abs(cand - cur.cost) <= 1e-9 && np < p)) best[i][k + 1][np] = { cost: cand, prev: [j, k, p] };
      }
    }
    for (let p = 0; p <= P; p++) {
      const b = best[i][dur][p];
      // equal cost: fewer pauses, then earlier
      if (b && (!end || b.cost < end.cost - 1e-9 || (Math.abs(b.cost - end.cost) <= 1e-9 && p < end.p))) end = { cost: b.cost, i, p };
    }
  }
  if (!end) return null;
  const idx = [];
  let node = [end.i, dur, end.p];
  while (node) { idx.unshift(node[0]); node = best[node[0]][node[1]][node[2]].prev; }
  return { idx, cost: end.cost, pauses: end.p };
}

function effCost(h, kwh, surplus, opts) {
  const fromSolar = Math.min(kwh, Math.max(0, surplus));
  const solarValue = opts.feedIn === 'fixed' ? opts.feedInEur : (h.price ?? 0) - (opts.solarBonus || 0);
  return fromSolar * Math.max(0, solarValue) + (kwh - fromSolar) * (h.price ?? 0);
}

// loads: [{ id, kind, name, priority, settings (object), requests: [{ id, readyBy (ms), kwh, durationH }] }]
// carKwh: { [hourMs]: kWh the car plan takes }; localOf(ms) -> { day: 'YYYY-MM-DD', hour: 0..23 }
function planLoads({ hours, loads, carKwh = {}, carPriority = 3, nowMs, localOf, feedIn = 'saldering', feedInEur = 0.05, solarBonus = 0.05, awayDays = new Set() }) {
  const opts = { feedIn, feedInEur, solarBonus };
  const left = new Map(hours.map((h) => [h.ms, h.surplusKwh]));
  const nowHour = Math.floor(nowMs / HOUR) * HOUR;
  const H = hours.filter((h) => h.ms >= nowHour);
  const p25 = quantile(H.map((h) => h.price), 0.25);
  const p85 = quantile(H.map((h) => h.price), 0.85);
  const out = [];
  const order = [...loads].sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  let carDone = false;
  const takeCar = () => { if (carDone) return; carDone = true; for (const h of H) left.set(h.ms, Math.max(0, (left.get(h.ms) || 0) - (carKwh[h.ms] || 0))); };

  for (const load of order) {
    if ((load.priority ?? 5) >= carPriority) takeCar();
    const s = load.settings || {};
    const kw = Math.max(0.1, Number(s.kw) || 1);
    const rows = H.map((h) => ({ hour: h.hour, ms: h.ms, values: {}, reason: null }));
    const at = new Map(rows.map((r) => [r.ms, r]));
    const consume = (ms, kwh) => left.set(ms, Math.max(0, (left.get(ms) || 0) - kwh));

    if (load.kind === 'dhw') {
      const dur = Math.max(1, Math.round(Number(s.duration_h) || 1));
      const days = [...new Set(H.map((h) => localOf(h.ms).day))];
      // Learned pattern: hot before its usual use (the first daily use after the earliest start).
      const usual = s.use_patterns === false ? null : (load.patterns || []).filter((p) => p.type === 'daily' && p.from >= (s.earliest ?? 0) + dur).sort((x, y) => x.from - y.from)[0];
      const latest = usual ? Math.min(s.latest ?? 24, usual.from) : (s.latest ?? 24);
      for (const day of days) {
        const win = H.filter((h) => { const l = localOf(h.ms); return l.day === day && l.hour >= (s.earliest ?? 0) && l.hour < latest; });
        if (load.doneToday && day === localOf(nowMs).day) continue;
        if (awayDays.has(day)) continue; // nobody home: no tap water planned (surplus may still heat it)
        let best = null;
        for (let i = 0; i + dur <= win.length; i++) {
          const block = win.slice(i, i + dur);
          if (block[block.length - 1].ms - block[0].ms !== (dur - 1) * HOUR) continue;
          const cost = block.reduce((a, h) => a + effCost(h, kw, left.get(h.ms), opts), 0);
          if (!best || cost < best.cost - 1e-9) best = { block, cost };
        }
        if (!best) continue;
        for (const h of best.block) {
          const solar = (left.get(h.ms) || 0) >= kw * 0.8;
          const r = at.get(h.ms);
          r.values.now = 1;
          r.values.setpoint = solar || (p25 !== null && h.price <= p25) ? s.buffer_setpoint : s.normal_setpoint;
          const usualAt = String(usual?.from ?? '').padStart(2, '0');
          r.reason = usual && latest === usual.from
            ? (solar ? `solar surplus, hot before the usual use ~${usualAt}:00` : `cheapest block of the day, hot before the usual use ~${usualAt}:00`)
            : (solar ? 'solar surplus' : 'cheapest block of the day');
          consume(h.ms, kw);
        }
      }
      for (const r of rows) { if (r.values.now === undefined) { r.values.now = 0; r.values.setpoint = s.normal_setpoint; } }
    } else if (load.kind === 'heatpump') {
      if (s.season === 'off') {
        for (const r of rows) { r.values.release = 1; r.values.correction = 0; r.reason = 'season off: no influence'; }
      } else {
        const ranked = [...H].sort((a, b) => effCost(a, kw, left.get(a.ms), opts) - effCost(b, kw, left.get(b.ms), opts));
        const n = Math.ceil(H.length * Math.min(1, Math.max(0, Number(s.release_share) || 0.6)));
        const rel = new Set(ranked.slice(0, n).map((h) => h.ms));
        for (const h of H) if ((left.get(h.ms) || 0) >= kw * 0.5) rel.add(h.ms);
        // Never block longer than max_block_h in a row: release the cheapest hour of a long run.
        const maxBlock = Math.max(1, Number(s.max_block_h) || 3);
        for (let guard = 0; guard < H.length; guard++) {
          let run = [];
          let found = null;
          for (const h of H) {
            if (rel.has(h.ms)) { run = []; continue; }
            run.push(h);
            if (run.length > maxBlock) { found = run; break; }
          }
          if (!found) break;
          const cheapest = [...found].sort((a, b) => a.price - b.price)[0];
          rel.add(cheapest.ms);
        }
        for (const h of H) {
          const r = at.get(h.ms);
          const sur = left.get(h.ms) || 0;
          const solar = sur >= kw * 0.8;
          const cheap = p25 !== null && h.price <= p25;
          const dear = p85 !== null && h.price >= p85 && sur < 0.2;
          r.values.release = rel.has(h.ms) ? 1 : 0;
          const sign = s.season === 'cooling' ? -1 : 1;
          r.values.correction = solar || cheap ? sign * (Number(s.up) || 0) : dear ? -sign * (Number(s.down) || 0) : 0;
          r.reason = solar ? (sign > 0 ? 'solar surplus: pre-heat' : 'solar surplus: pre-cool') : cheap ? (sign > 0 ? 'cheap hour: pre-heat' : 'cheap hour: pre-cool')
            : dear ? 'expensive hour: ease off' : rel.has(h.ms) ? 'cheaper half of the day' : 'blocked (expensive)';
          if (rel.has(h.ms)) consume(h.ms, kw);
        }
      }
    } else if (load.kind === 'appliance') {
      for (const r of rows) { r.values.start = 0; r.values.pause = 0; r.values.resume = 0; }
      // No run asked for: expect its usual run(s) (learned pattern) and plan the best start from
      // the usual time up to flex_h later.
      if (!(load.requests || []).length && s.use_patterns !== false && localOf(nowMs).weekday !== undefined) {
        const ep = require('./energyPatterns');
        const end = H.length ? H[H.length - 1].ms + HOUR : nowMs;
        for (const p of (load.patterns || []).filter((x) => x.type === 'run')) {
          const occ = ep.nextOccurrence(p, nowMs, end, localOf);
          if (occ === null || awayDays.has(localOf(occ).day)) continue; // nobody home that day: no usual run
          const dur = Math.max(1, Math.ceil(p.durationH || 2));
          load.requests = [...(load.requests || []), {
            id: null, expected: true, label: `usual run (${ep.describe(p)})`, notBefore: Math.floor(occ / HOUR) * HOUR,
            readyBy: Math.floor(occ / HOUR) * HOUR + ((Number(s.flex_h) || 8) + dur) * HOUR, kwh: p.kwh || kw * dur, durationH: dur, usualStart: occ,
          }];
        }
      }
      for (const q of load.requests || []) {
        const dur = Math.max(1, Math.ceil(Number(q.durationH) || 2));
        const kwh = Number(q.kwh) || kw * dur;
        let best = null;
        if (q.steps && q.steps.length) {
          // a run LoxSuite already started: its hours stay as planned
          const block = q.steps.map((ms) => H.find((h) => h.ms === ms)).filter(Boolean);
          if (block.length) best = { block, cost: block.reduce((a, h) => a + effCost(h, kwh / dur, left.get(h.ms), opts), 0), running: true };
        } else {
          const pauseH = Number(s.max_pause_h) || 0;
          const found = bestSteps(H, { dur, notBefore: q.notBefore, readyBy: q.readyBy, maxGapH: q.ready && pauseH > 0 ? pauseH : 0, maxPauses: Number(s.max_pauses ?? 2), costOf: (i) => effCost(H[i], kwh / dur, left.get(H[i].ms), opts) });
          if (found) best = { block: found.idx.map((i) => H[i]), cost: found.cost, pauses: found.pauses };
        }
        if (!best) continue;
        q.steps = best.block.map((h) => h.ms);
        // pauses between the steps: Pause at the start of a gap, Verder (resume) at the next step
        for (let b = 1; b < best.block.length; b++) {
          const prev = best.block[b - 1].ms, next = best.block[b].ms;
          if (next - prev <= HOUR) continue;
          for (let t = prev + HOUR; t < next; t += HOUR) { const g = at.get(t); if (g) { g.values.pause = 1; g.reason = `paused: cheaper to go on at ${require('./localTime').hhmm(next)}`; } }
          const rn = at.get(next); if (rn) rn.values.resume = 1;
        }
        const r = at.get(best.block[0].ms);
        if (!best.running) r.values.start = 1;
        r.reason = q.ready ? `best start for the waiting run (ready by ${require('./localTime').hhmm(q.readyBy)})` : q.scheduled ? `scheduled on the appliance (start ~${require('./localTime').hhmm(q.usualStart)})` : q.expected ? `best start for the ${q.label}` : `start for "${q.label || 'run'}" (ready by ${new Date(q.readyBy).toISOString()})`;
        q.plannedStart = best.block[0].ms;
        q.pauses = best.pauses || 0;
        q.plannedCost = r2(best.cost);
        for (const h of best.block) consume(h.ms, kwh / dur);
      }
    }
    out.push({ id: load.id, kind: load.kind, name: load.name, hours: rows, requests: load.requests || [] });
  }
  takeCar();
  return { loads: out, surplusLeft: Object.fromEntries([...left.entries()].map(([k, v]) => [k, r3(v)])) };
}

// Shadow signals right now: the plan of the current hour, with a live solar override (surplus now).
function currentSignals(plan, nowMs, { exportKw = 0, importKw = 0, loadsById = {} } = {}) {
  const hourMs = Math.floor(nowMs / HOUR) * HOUR;
  const out = [];
  let spare = Math.max(0, exportKw);
  for (const p of plan?.loads || []) {
    const row = p.hours.find((h) => h.ms === hourMs) || { values: {}, reason: 'no plan for this hour' };
    const load = loadsById[p.id] || {};
    const kw = Number(load.settings?.kw) || 1;
    const values = { ...row.values };
    let reason = row.reason;
    // Planned on solar that isn't there right now (importing, no export): wait for the next re-plan
    // instead of heating on the grid at a price the plan never chose. A cheapest-block plan stays.
    const solarPlanned = /^solar surplus(?! now)/.test(String(row.reason || ''));
    if (solarPlanned && spare < kw * 0.3 && importKw > 0.3) {
      if (p.kind === 'dhw' && values.now === 1) { values.now = 0; reason = `planned on solar, but no surplus now (importing ${importKw.toFixed(1)} kW) — waits`; }
      if (p.kind === 'heatpump' && values.release === 1) { values.release = 0; reason = `planned on solar, but no surplus now (importing ${importKw.toFixed(1)} kW) — waits`; }
    }
    if (p.kind === 'dhw' && values.now !== 1 && !load.doneToday && spare >= kw) { values.now = 1; values.setpoint = load.settings?.buffer_setpoint ?? values.setpoint; reason = `solar surplus now (${spare.toFixed(1)} kW)`; spare -= kw; }
    if (p.kind === 'heatpump' && values.release !== 1 && spare >= kw * 0.5) { values.release = 1; reason = `solar surplus now (${spare.toFixed(1)} kW)`; spare -= kw; }
    out.push({ id: p.id, values, reason });
  }
  return out;
}

// Appliance run detection on minute power samples. state: { running, since, lowSince, startTotal }
function runStep(state, kw, total, nowMs, { onKw = 0.05, offKw = 0.02, endAfterMin = 10 } = {}) {
  const st = { ...state };
  let finished = null;
  if (!st.running) {
    if (kw !== null && kw >= onKw) Object.assign(st, { running: true, since: nowMs, lowSince: null, startTotal: total, peakKw: kw });
  } else {
    st.peakKw = Math.max(st.peakKw || 0, kw || 0);
    if (kw === null || kw < offKw) {
      if (!st.lowSince) st.lowSince = nowMs;
      if (nowMs - st.lowSince >= endAfterMin * 60000) {
        finished = { start: st.since, end: st.lowSince, kwh: total !== null && st.startTotal !== null ? r3(Math.max(0, total - st.startTotal)) : null, peakKw: st.peakKw };
        Object.assign(st, { running: false, since: null, lowSince: null, startTotal: null, peakKw: 0 });
      }
    } else st.lowSince = null;
  }
  return { state: st, finished };
}

// Cost of kWh in an hour: grid share (import / house use that hour) at the price, the rest solar.
function hourCost(kwh, { gridImport = null, houseKwh = null, price = null, solarValue = null }) {
  if (price === null || price === undefined) return null;
  const share = houseKwh > 0 && gridImport !== null ? Math.min(1, Math.max(0, gridImport / houseKwh)) : 1;
  return kwh * (share * price + (1 - share) * (solarValue ?? price));
}

// --------------------------------------------------------------------------- runtime

const rt = { plan: null, planAt: 0, signals: [], last: new Map(), samples: new Map(), runs: new Map(), prevTotals: new Map(), readySince: new Map(), startSent: new Map(), active: new Map(), timer: null, status: null };

// The statuses a consumer has been in (last 60 days, most time first), for "values that mean running".
async function seenStatuses(loadId, nowMs = Date.now()) {
  const rows = await db.prepare('SELECT status, SUM(minutes) AS m FROM load_status_hourly WHERE load_id = ? AND hour >= ? GROUP BY status').all(loadId, new Date(nowMs - 60 * 86400000).toISOString()).catch(() => []);
  return rows.filter((r) => r.status && r.status !== 'on' && bucket(r.status) !== 'off').sort((a, b) => b.m - a.m).slice(0, 16).map((r) => ({ status: r.status, hours: Math.round((Number(r.m) || 0) / 6) / 10 }));
}

async function listLoads() {
  return (await db.prepare('SELECT * FROM energy_loads ORDER BY priority, id').all().catch(() => [])).map((l) => ({ ...l, settings: parseSettings(l) }));
}

async function resolveMeter(load) {
  if (!load.miniserver_id || !load.meter_uuid) return null;
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(load.miniserver_id);
  if (!ms) return null;
  const s = await require('./loxoneStructure').getStructure(ms).catch(() => null);
  const c = s?.controls?.[load.meter_uuid];
  if (!c) return { ms, control: null };
  require('./loxoneWebSocket').ensureConnection(ms);
  return { ms, control: c };
}

async function readLoad(load) {
  const src = sourcesOf(load.settings || parseSettings(load));
  const ws = require('./loxoneWebSocket');
  const m = await resolveMeter(load);
  let meter = {};
  let name = null;
  if (m?.control) {
    const v = (n) => { const u = m.control.states?.[n]; const x = u ? ws.getLiveValue(m.ms.id, u) : undefined; return x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x); };
    meter = { kw: v('actual'), total: v('total') };
    name = m.control.name;
  }
  const raw = {};
  const anySrc = src.onoff || src.status || src.power || src.energy || src.temp || src.startIn || src.ready;
  if (anySrc && load.miniserver_id) {
    const ms = m?.ms || await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(load.miniserver_id);
    if (ms) {
      ws.ensureConnection(ms);
      for (const k of ['onoff', 'status', 'power', 'energy', 'temp', 'startIn', 'ready']) if (src[k]) raw[k] = ws.getLiveValue(ms.id, src[k]);
    }
  }
  const st = loadState({ meter, raw, src, name: load.name });
  return { ...st, found: !!m?.control || Object.values(raw).some((x) => x !== undefined && x !== null), name };
}

async function addHour(loadId, hour, kwh) {
  if (!(kwh > 0)) return;
  const row = await db.prepare('SELECT kwh, source FROM load_hourly WHERE load_id = ? AND hour = ?').get(loadId, hour);
  const base = row && row.source !== 'loxone' ? row.kwh || 0 : 0;
  await db.upsert('load_hourly', { load_id: loadId, hour, kwh: Math.round((base + kwh) * 10000) / 10000, source: 'live' }, ['load_id', 'hour']);
}

async function addStatus(loadId, hour, key, minutes, kwh, measured) {
  if (!key || !(minutes > 0)) return;
  const row = await db.prepare('SELECT minutes, kwh, measured FROM load_status_hourly WHERE load_id = ? AND hour = ? AND status = ?').get(loadId, hour, key);
  await db.upsert('load_status_hourly', {
    load_id: loadId, hour, status: key, minutes: r3((row?.minutes || 0) + minutes), kwh: Math.round(((row?.kwh || 0) + (kwh || 0)) * 10000) / 10000,
    measured: row ? (row.measured && measured ? 1 : 0) : (measured ? 1 : 0),
  }, ['load_id', 'hour', 'status']);
}

// Every minute: read each consumer, book its kWh (meter/counter difference, else power × time, else
// "on" × its kW as an estimate), the minutes per status, every change of on/off or status, and
// appliance runs (from on/off or status when there is one, else from the power).
async function sample(nowMs = Date.now(), { read = readLoad } = {}) {
  const em = require('./energyMeters');
  const loads = await listLoads();
  for (const l of loads) {
    if (!l.enabled) continue;
    const r = await read(l);
    const prevS = rt.samples.get(l.id);
    rt.samples.set(l.id, { ...r, at: nowMs, since: prevS && statusKey(prevS) === statusKey(r) ? prevS.since : nowMs });
    const hour = em.hourStart(nowMs);
    // minutes since the previous sample (a gap of more than 5 minutes counts as 1)
    const dtMin = prevS ? Math.min(5, Math.max(0, (nowMs - prevS.at) / 60000)) || 1 : 1;
    let kwh = null;
    let measured = false;
    const prev = rt.prevTotals.get(l.id);
    if (r.total !== null) {
      if (prev) { const d = em.safeDelta(prev.total, r.total, nowMs - prev.at, 30); if (d !== null && d !== undefined) { kwh = d; measured = true; } }
      rt.prevTotals.set(l.id, { total: r.total, at: nowMs });
    } else if (r.kw !== null) { kwh = Math.max(0, r.kw) * dtMin / 60; measured = true; }
    else if (r.on === true) kwh = (Number(l.settings.kw) || 0) * dtMin / 60;
    if (kwh > 0) await addHour(l.id, hour, kwh);
    const key = statusKey(r);
    await addStatus(l.id, hour, key, dtMin, kwh || 0, measured).catch(() => {});
    // the room / tank temperature, with the minutes it was on (how fast it cools down)
    if (r.temp !== null && r.temp !== undefined) await require('./temperature').addTemp(l.id, hour, r.temp, r.on ? dtMin : 0).catch(() => {});
    if (key !== null && (!prevS || statusKey(prevS) !== key)) {
      await db.prepare('INSERT INTO load_events (load_id, ts, on_state, status, label, kw) VALUES (?, ?, ?, ?, ?, ?)')
        .run(l.id, new Date(nowMs).toISOString(), r.on === null ? null : (r.on ? 1 : 0), r.status, r.label, r.kw).catch(() => {});
    }
    if (l.kind === 'appliance') {
      // with an on/off or status signal the run follows that (ends 2 minutes after it goes off);
      // otherwise the power decides
      const bySignal = r.on !== null && (sourcesOf(l.settings).onoff || sourcesOf(l.settings).status);
      const step = bySignal
        ? runStep(rt.runs.get(l.id) || {}, r.on ? 1 : 0, r.total, nowMs, { onKw: 0.5, offKw: 0.5, endAfterMin: 2 })
        : runStep(rt.runs.get(l.id) || {}, r.kw, r.total, nowMs);
      rt.runs.set(l.id, step.state);
      if (step.finished) await storeRun(l, step.finished).catch((e) => console.error(`[energy manager] ${l.name}: ${e.message}`));
    }
  }
}

async function priceAt(ms) {
  const row = await db.prepare('SELECT allin_eur_kwh AS p FROM energy_prices WHERE start_at <= ? AND end_at > ? ORDER BY start_at DESC').get(new Date(ms).toISOString(), new Date(ms).toISOString());
  return row?.p ?? null;
}

async function hourContext(hourIso) {
  const rows = await db.prepare("SELECT role, import_kwh, export_kwh FROM energy_hourly WHERE hour = ? AND role IN ('grid', 'house', 'pv')").all(hourIso);
  const by = Object.fromEntries(rows.map((r) => [r.role, r]));
  const p = await priceAt(Date.parse(hourIso));
  const pcfg = await require('./planner').getConfig();
  return {
    price: p, gridImport: by.grid ? by.grid.import_kwh : null, gridExport: by.grid ? by.grid.export_kwh || 0 : 0, houseKwh: by.house ? by.house.import_kwh : null,
    solarValue: pcfg.feed_in === 'fixed' ? pcfg.feed_in_eur_kwh : p,
  };
}

// A finished appliance run: what it cost, and the best start within flex_h afterwards in hindsight.
async function storeRun(load, run) {
  const durH = Math.max(1, Math.ceil((run.end - run.start) / HOUR));
  const kwh = run.kwh ?? 0;
  let cost = 0;
  let known = true;
  for (let t = Math.floor(run.start / HOUR) * HOUR; t < run.end; t += HOUR) {
    const ctx = await hourContext(new Date(t).toISOString());
    const c = hourCost(kwh / durH, ctx);
    if (c === null) known = false; else cost += c;
  }
  let best = null;
  const flex = Number(load.settings.flex_h) || 8;
  for (let s = Math.floor(run.start / HOUR) * HOUR; s <= run.start + flex * HOUR; s += HOUR) {
    let c = 0;
    let ok = true;
    for (let i = 0; i < durH; i++) {
      const ctx = await hourContext(new Date(s + i * HOUR).toISOString());
      if (ctx.price === null) { ok = false; break; }
      const fromSolar = Math.min(kwh / durH, ctx.gridExport || 0);
      c += fromSolar * (ctx.solarValue ?? ctx.price) + (kwh / durH - fromSolar) * ctx.price;
    }
    if (ok && (!best || c < best.cost)) best = { start: s, cost: c };
  }
  await db.prepare('INSERT INTO load_runs (load_id, start_at, end_at, kwh, cost_eur, best_start, best_cost_eur, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(load.id, new Date(run.start).toISOString(), new Date(run.end).toISOString(), kwh, known ? r2(cost) : null,
      best ? new Date(best.start).toISOString() : null, best ? r2(best.cost) : null, 'run');
}

async function requestsFor(loadId, nowMs) {
  const rows = await db.prepare("SELECT * FROM load_runs WHERE load_id = ? AND kind = 'request' AND ready_by > ? ORDER BY ready_by").all(loadId, new Date(nowMs).toISOString());
  return rows.map((r) => ({ id: r.id, readyBy: Date.parse(r.ready_by), kwh: r.kwh, durationH: r.duration_h, label: r.label || 'run' }));
}

// Learned typical figures from the measurements: kW while running (dhw/heatpump) and kWh/duration
// of an appliance run.
async function learned(load) {
  if (load.kind === 'appliance') {
    const runs = await db.prepare("SELECT start_at, end_at, kwh FROM load_runs WHERE load_id = ? AND kind = 'run' ORDER BY start_at DESC").all(load.id);
    const recent = runs.slice(0, 20);
    return {
      runs: runs.length,
      kwh: quantile(recent.map((r) => r.kwh), 0.5),
      durationH: quantile(recent.map((r) => (Date.parse(r.end_at) - Date.parse(r.start_at)) / HOUR), 0.5),
    };
  }
  const from = new Date(Date.now() - 28 * 86400000).toISOString();
  const rows = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(load.id, from);
  const active = rows.map((r) => r.kwh).filter((k) => k > 0.1);
  const days = new Set(rows.map((r) => r.hour.slice(0, 10))).size;
  // a clear change in daily use: the last week counts
  const byDay = new Map();
  for (const r of rows) byDay.set(r.hour.slice(0, 10), (byDay.get(r.hour.slice(0, 10)) || 0) + r.kwh);
  const change = require('./learning').detectChange([...byDay.entries()].slice(0, -1).map(([day, kwh]) => ({ day, kwh })));
  const kwhPerDay = change.changed ? change.recent : (days ? r2(rows.reduce((a, r) => a + r.kwh, 0) / days) : null);
  return { kwPeak: active.length ? r2(quantile(active, 0.8)) : null, kwhPerDay, change, hours: rows.length, ...(await learnedStatus(load)), anomalies: await loadAnomalies(load).catch(() => []) };
}

// The weather side of a heat pump / boiler: its kWh against heating degrees (a cold day needs more), and
// with a room/tank temperature how fast it cools down. A heat pump's release share follows the forecast,
// and (unless switched off) the longest block follows how long the room keeps its warmth.
async function weatherFor(load, nowMs, localOf) {
  const T = require('./temperature');
  const model = await T.loadModel(load.id, nowMs).catch(() => null);
  const means = await T.forecastMeans(nowMs).catch(() => new Map());
  const factorOf = (ms) => T.dayFactor(model, means.get(localOf(ms).day) ?? null);
  const cooling = await T.loadCooling(load.id, nowMs).catch(() => ({ k: null }));
  const todayC = means.get(localOf(nowMs).day) ?? null;
  const out = { weather: { model, todayC, factorToday: factorOf(nowMs), factorTomorrow: factorOf(nowMs + DAY_MS), factorOf }, cooling };
  if (load.kind === 'heatpump') {
    const s = load.settings;
    const base = Number(s.release_share) || 0.6;
    if (model?.usable) s.release_share = Math.min(0.95, Math.max(0.3, base * (factorOf(nowMs) + factorOf(nowMs + 12 * HOUR)) / 2));
    if (cooling?.k && s.max_block_auto !== false) {
      const hold = T.holdHours(cooling, cooling.lastTemp ?? 20.5, todayC ?? 8, Number(s.allowed_drop_c) || 0.5);
      if (hold) { out.cooling.holdH = hold; s.max_block_h = Math.max(1, Math.round(hold)); }
    }
  }
  if (load.kind === 'dhw' && cooling?.k) out.cooling.lossPerHourC = Math.round(cooling.k * Math.max(1, (cooling.lastTemp ?? 55) - 20) * 100) / 100;
  return out;
}
const DAY_MS = 86400000;

// Pure: how far a running appliance is, from its usual run: { elapsedMin, remainingMin, remainingKwh, pct }.
function runProgress({ sinceMs, nowMs, typicalH, typicalKwh, usedKwh = null }) {
  if (!sinceMs || !(typicalH > 0)) return null;
  const elapsedMin = Math.max(0, (nowMs - sinceMs) / 60000);
  const totalMin = typicalH * 60;
  const remainingMin = Math.max(0, totalMin - elapsedMin);
  let remainingKwh = null;
  if (typicalKwh > 0) remainingKwh = usedKwh !== null && usedKwh !== undefined ? Math.max(0, typicalKwh - usedKwh) : typicalKwh * (remainingMin / totalMin);
  return { elapsedMin: Math.round(elapsedMin), remainingMin: Math.round(remainingMin), remainingKwh: remainingKwh === null ? null : r2(remainingKwh), pct: Math.min(100, Math.round((elapsedMin / totalMin) * 100)), overdue: elapsedMin > totalMin * 1.3 };
}

// Pure: something off? kW per status in the last 7 days against the 21 before (rows from
// load_status_hourly), and the last 7 days' kWh against what the weather model expects.
//   -> [{ kind: 'status'|'weather', status?, recent, before|expected, ratio }]
function anomalies({ rows = [], nowMs = Date.now(), weatherDays = [], model = null, threshold = 1.3 }) {
  const out = [];
  const cut = new Date(nowMs - 7 * 86400000).toISOString();
  const by = new Map();
  for (const r of rows) {
    if (!r.measured || /^(off|uit|0)$/i.test(r.status)) continue;
    const g = by.get(r.status) || { rMin: 0, rKwh: 0, bMin: 0, bKwh: 0 };
    if (r.hour >= cut) { g.rMin += r.minutes; g.rKwh += r.kwh; } else { g.bMin += r.minutes; g.bKwh += r.kwh; }
    by.set(r.status, g);
  }
  for (const [status, g] of by) {
    if (g.rMin < 60 || g.bMin < 180) continue;
    const recent = g.rKwh / (g.rMin / 60);
    const before = g.bKwh / (g.bMin / 60);
    if (before > 0.05 && recent / before >= threshold) out.push({ kind: 'status', status, recent: r2(recent), before: r2(before), ratio: r2(recent / before) });
  }
  if (model?.usable && weatherDays.length >= 5) {
    const T = require('./temperature');
    let act = 0; let exp = 0;
    for (const d of weatherDays) { act += d.kwh; exp += Math.max(0.05, model.a + model.b * T.heatingDegrees(d.meanC)); }
    if (exp > 1 && act / exp >= threshold) out.push({ kind: 'weather', recent: r2(act / weatherDays.length), expected: r2(exp / weatherDays.length), ratio: r2(act / exp) });
  }
  return out;
}

async function loadAnomalies(load, nowMs = Date.now()) {
  const rows = (await db.prepare('SELECT hour, status, minutes, kwh, measured FROM load_status_hourly WHERE load_id = ? AND hour >= ?').all(load.id, new Date(nowMs - 28 * 86400000).toISOString()).catch(() => [])).map((r) => ({ ...r, status: bucket(r.status) }));
  let weatherDays = [];
  let model = null;
  if (load.kind === 'heatpump') {
    const T = require('./temperature');
    model = await T.loadModel(load.id, nowMs).catch(() => null);
    const hourly = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(load.id, new Date(nowMs - 8 * 86400000).toISOString()).catch(() => []);
    const means = await T.dailyMeans(nowMs - 8 * 86400000, nowMs).catch(() => new Map());
    weatherDays = T.dailyKwh(hourly).map((d) => ({ ...d, meanC: means.get(d.day) })).filter((d) => Number.isFinite(d.meanC)).slice(-7);
  }
  return anomalies({ rows, nowMs, weatherDays, model });
}

// Unknown consumers: what the house uses beyond the known consumers, above each day's base load —
// recurring blocks of it are patterns ("every day 18:00–19:00, ~1.6 kWh": an oven?) that you can name.
async function unknownPatterns(nowMs = Date.now(), localOf) {
  const from = new Date(nowMs - 42 * 86400000).toISOString();
  const house = await db.prepare("SELECT hour, import_kwh AS kwh FROM energy_hourly WHERE role = 'house' AND hour >= ?").all(from).catch(() => []);
  if (house.length < 24 * 7) return [];
  const known = await db.prepare('SELECT hour, SUM(kwh) AS kwh FROM load_hourly WHERE hour >= ? GROUP BY hour').all(from).catch(() => []);
  const k = new Map(known.map((r) => [r.hour, r.kwh || 0]));
  const residual = house.map((r) => ({ hour: r.hour, kwh: Math.max(0, (r.kwh || 0) - (k.get(r.hour) || 0)) }));
  // minus each day's base (its quietest hours)
  const byDay = new Map();
  for (const r of residual) { const d = localOf(Date.parse(r.hour)).day; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r.kwh); }
  const base = new Map([...byDay].map(([d, xs]) => [d, quantile(xs, 0.2) || 0]));
  const spikes = residual.map((r) => ({ hour: r.hour, kwh: Math.round(Math.max(0, r.kwh - (base.get(localOf(Date.parse(r.hour)).day) || 0)) * 1000) / 1000 }));
  const ep = require('./energyPatterns');
  const prof = ep.profile({ hourly: spikes, localOf, nowMs, threshold: 0.4 });
  const names = (await require('./wallboxSettings').get('unknown_names', {})) || {};
  return ep.hourPatterns(prof, { minProb: 0.5, lift: 0.25 }).filter((p) => p.kwh >= 0.5).slice(0, 8)
    .map((p) => ({ ...p, key: ep.patternKey(p), name: names[ep.patternKey(p)] || null, text: ep.describe(p) }));
}

// Pure: per status (or on/off) from the hourly bookings: hours in it, kWh, the typical kW (only from
// measured kWh) and hours per day.
function statusSummary(rows, days) {
  const by = new Map();
  for (const r of rows) {
    const k = bucket(r.status); // older rows booked "Uitgeschakeld" apart from "off"
    const g = by.get(k) || { status: k, minutes: 0, kwh: 0, mMin: 0, mKwh: 0 };
    g.minutes += r.minutes; g.kwh += r.kwh;
    if (r.measured) { g.mMin += r.minutes; g.mKwh += r.kwh; }
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.minutes - a.minutes).map((g) => ({
    status: g.status, hours: r2(g.minutes / 60), kwh: r2(g.kwh), kw: g.mMin >= 10 ? r2(g.mKwh / (g.mMin / 60)) : null,
    hoursPerDay: days ? r2(g.minutes / 60 / days) : null, measured: g.mMin >= g.minutes * 0.5,
  }));
}

async function learnedStatus(load, nowMs = Date.now()) {
  const from = new Date(nowMs - 28 * 86400000).toISOString();
  const rows = await db.prepare('SELECT hour, status, minutes, kwh, measured FROM load_status_hourly WHERE load_id = ? AND hour >= ?').all(load.id, from).catch(() => []);
  if (!rows.length) return { perStatus: [] };
  const days = Math.max(1, new Set(rows.map((r) => r.hour.slice(0, 10))).size);
  const perStatus = statusSummary(rows, days);
  // the kW while on, learned from measured minutes that aren't "off"
  const on = rows.filter((r) => r.measured && bucket(r.status) !== 'off' && !isOffText(r.status));
  const onMin = on.reduce((a, r) => a + r.minutes, 0);
  return { perStatus, kwOn: onMin >= 30 ? r2(on.reduce((a, r) => a + r.kwh, 0) / (onMin / 60)) : null };
}

// Everything for the consumer's own page: its state now, the timeline of the last 48 hours, kWh per
// hour over 7 days and per status.
async function loadDetail(load, nowMs = Date.now()) {
  const since = new Date(nowMs - 48 * HOUR).toISOString();
  const events = await db.prepare('SELECT ts, on_state, status, label, kw FROM load_events WHERE load_id = ? AND ts >= ? ORDER BY ts').all(load.id, since).catch(() => []);
  const before = await db.prepare('SELECT ts, on_state, status, label, kw FROM load_events WHERE load_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1').get(load.id, since).catch(() => null);
  const hourly = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ? ORDER BY hour').all(load.id, new Date(nowMs - 7 * 86400000).toISOString()).catch(() => []);
  const em = require('./energyMeters');
  const todayFrom = new Date(nowMs - 24 * HOUR).toISOString();
  const last24 = (await db.prepare('SELECT status, minutes, kwh FROM load_status_hourly WHERE load_id = ? AND hour >= ?').all(load.id, todayFrom).catch(() => [])).map((r) => ({ ...r, status: bucket(r.status) }));
  const onMin24 = last24.filter((r) => !/^(off|uit|0)$/i.test(r.status)).reduce((a, r) => a + r.minutes, 0);
  return {
    now: rt.samples.get(load.id) || null, timeline: timeline(before ? [{ ...before, ts: since }, ...events] : events, Date.parse(since), nowMs),
    hourly, perStatus: (await learnedStatus(load, nowMs)).perStatus, last24: { onHours: r2(onMin24 / 60), kwh: r2(last24.reduce((a, r) => a + r.kwh, 0)) },
    runs: load.kind === 'appliance' ? await db.prepare("SELECT * FROM load_runs WHERE load_id = ? AND kind = 'run' ORDER BY start_at DESC").all(load.id).then((x) => x.slice(0, 20)) : [],
    hourStart: em.hourStart(nowMs),
  };
}

// Pure: change events -> segments [{ from, to, key, on }] between fromMs and toMs.
function timeline(events, fromMs, toMs) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const a = Math.max(fromMs, Date.parse(e.ts));
    const b = Math.min(toMs, i + 1 < events.length ? Date.parse(events[i + 1].ts) : toMs);
    if (b <= a) continue;
    const key = e.status !== null && e.status !== undefined ? bucket(String(e.label || e.status)) : e.on_state === 1 ? 'on' : e.on_state === 0 ? 'off' : null;
    if (key === null) continue;
    const last = out[out.length - 1];
    if (last && last.key === key && last.to === a) last.to = b;
    else out.push({ from: a, to: b, key, on: e.on_state === null || e.on_state === undefined ? null : !!e.on_state });
  }
  return out;
}

// Learned patterns of one load (energyPatterns.js) from the last 8 weeks.
async function loadPatterns(load, nowMs, localOf, { away = new Set() } = {}) {
  const ep = require('./energyPatterns');
  const from = new Date(nowMs - 56 * 86400000).toISOString();
  // days nobody was home are left out: they would make the normal pattern look emptier (dayType.js)
  const hourly = (await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(load.id, from).catch(() => [])).filter((r) => !away.has(localOf(Date.parse(r.hour)).day));
  const runs = load.kind === 'appliance' ? (await db.prepare("SELECT start_at, end_at, kwh FROM load_runs WHERE load_id = ? AND kind = 'run' AND start_at >= ?").all(load.id, from).catch(() => [])).filter((r) => !away.has(localOf(Date.parse(r.start_at)).day)) : [];
  const r = ep.findPatterns({ kind: load.kind, hourly, runs, localOf, nowMs });
  // patterns you marked as "not right" are left out (and not planned for)
  const ignored = new Set(load.settings?.ignored_patterns || []);
  return { patterns: r.patterns.filter((p) => !ignored.has(ep.patternKey(p))), ignoredPatterns: r.patterns.filter((p) => ignored.has(ep.patternKey(p))).length, profile: r.profile };
}
async function followsFor(loads) {
  const apps = loads.filter((l) => l.kind === 'appliance');
  if (apps.length < 2) return [];
  const from = new Date(Date.now() - 56 * 86400000).toISOString();
  const byLoad = {};
  for (const l of apps) byLoad[l.id] = await db.prepare("SELECT start_at, end_at FROM load_runs WHERE load_id = ? AND kind = 'run' AND start_at >= ?").all(l.id, from).catch(() => []);
  return require('./energyPatterns').followPatterns(byLoad);
}

async function recalc(nowMs = Date.now()) {
  const planner = require('./planner');
  const { localParts, displayTz } = require('./localTime');
  const tz = displayTz();
  const localOf = (ms) => { const p = localParts(ms, tz); return { day: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, hour: p.hour, minute: p.minute, weekday: p.weekday }; };
  const cfg = await getConfig();
  const pcfg = await planner.getConfig();
  const slots = await planner.buildSlots(nowMs, nowMs + 36 * HOUR);
  // forecast solar and house per hour, then corrected with the live meters
  const pvF = {};
  const houseF = {};
  for (const sl of slots) {
    const ms = Math.floor(Date.parse(sl.start) / HOUR) * HOUR;
    if (pvF[ms] === undefined) { pvF[ms] = Number(sl.pvKwh) || 0; houseF[ms] = Number(sl.houseKwh) || 0; }
  }
  const meters = await require('./energyMeters').live().catch(() => null);
  const corrected = applyLive(toHours(slots), { pvF, houseF, pvKw: meters?.roles?.pv?.power_kw ?? null, houseKw: meters?.house_kw ?? null, nowMs });
  const hours = corrected.hours;
  const carKwh = {};
  for (const s of planner.getRuntime().plan?.slots || []) {
    const ms = Math.floor(Date.parse(s.start) / HOUR) * HOUR;
    carKwh[ms] = (carKwh[ms] || 0) + (Number(s.kwh) || (Number(s.kw) || 0) * ((Date.parse(s.end) - Date.parse(s.start)) / HOUR));
  }
  const loads = (await listLoads()).filter((l) => l.enabled);
  const today = localOf(nowMs).day;
  const dt = require('./dayType');
  const awayPast = await dt.awayDays(nowMs).catch(() => new Set());
  const types = await dt.typesBetween(nowMs, nowMs + 36 * HOUR).catch(() => new Map());
  const awayAhead = new Set([...types].filter(([, v]) => v.type === 'away').map(([d]) => d));
  for (const l of loads) {
    const lr = await learned(l);
    if (l.kind !== 'appliance' && lr.kwPeak && !l.settings.kw_fixed) l.settings.kw = Math.max(0.3, lr.kwPeak);
    if (l.kind === 'appliance') {
      l.requests = (await requestsFor(l.id, nowMs)).map((q) => ({ ...q, kwh: q.kwh || lr.kwh || l.settings.kw * 2, durationH: q.durationH || lr.durationH || 2 }));
      // scheduled on the appliance itself ("Ingepland", start in 3 h): that run is known — its kWh go
      // in that hour, and no usual run or best start is planned besides it
      const smp = rt.samples.get(l.id);
      const act = rt.active.get(l.id);
      if (act && nowMs < act.steps[act.steps.length - 1] + HOUR) {
        // a run LoxSuite started (or would have, log only): its steps and pauses stay as planned
        l.requests = [{ id: null, ready: true, label: 'run in progress', notBefore: act.steps[0], readyBy: act.steps[act.steps.length - 1] + HOUR, kwh: act.kwh, durationH: act.steps.length, steps: act.steps }];
      } else if (smp && smp.startAt && smp.startAt > nowMs - 15 * 60000 && smp.startAt < nowMs + 36 * HOUR) {
        const at = Math.floor(smp.startAt / HOUR) * HOUR, dur = Math.max(1, Math.ceil(lr.durationH || 2));
        l.requests = [{ id: null, scheduled: true, label: 'scheduled on the appliance', notBefore: at, readyBy: at + dur * HOUR, kwh: lr.kwh || l.settings.kw * dur, durationH: dur, usualStart: smp.startAt }];
      } else if (smp && smp.readyToStart && !l.requests.length) {
        // loaded and ready for a remote start: the best start from now within "ready within" hours
        const since = rt.readySince.get(l.id) || nowMs;
        const dur = Math.max(1, Math.ceil(lr.durationH || 2));
        const within = Math.max(dur, Number(l.settings.ready_within_h) || Number(l.settings.flex_h) || 8);
        l.requests = [{ id: null, ready: true, label: 'ready to start', notBefore: Math.floor(nowMs / HOUR) * HOUR, readyBy: Math.max(since + within * HOUR, Math.floor(nowMs / HOUR) * HOUR + dur * HOUR), kwh: lr.kwh || l.settings.kw * dur, durationH: dur }];
      }
    }
    if (l.kind === 'dhw') {
      const from = new Date(require('./localTime').localMidnight(nowMs, tz)).toISOString();
      const row = await db.prepare('SELECT SUM(kwh) AS k FROM load_hourly WHERE load_id = ? AND hour >= ?').get(l.id, from);
      l.doneToday = (row?.k || 0) >= Math.max(0.5, (l.settings.kw || 2) * (l.settings.duration_h || 1) * 0.7);
    }
    l.learned = lr;
    Object.assign(l, await loadPatterns(l, nowMs, localOf, { away: awayPast }));
    if (l.kind === 'heatpump' || l.kind === 'dhw') Object.assign(l, await weatherFor(l, nowMs, localOf));
    // write down the expected kWh per hour, to compare with what it really uses (forecastLog.js)
    if (l.profile) {
      const ep = require('./energyPatterns');
      const exp = hours.slice(0, 36).map((h) => ({ ms: h.ms, kwh: awayAhead.has(localOf(h.ms).day) && l.kind !== 'heatpump' ? 0 : ep.expectedKwh(l.profile, h.ms, localOf) * (l.weather?.factorOf?.(h.ms) ?? 1) })).filter((x) => Number.isFinite(x.kwh));
      require('./forecastLog').recordLoad(l.id, exp, nowMs).catch(() => {});
    }
  }
  rt.follows = await followsFor(loads);
  rt.unknown = await unknownPatterns(nowMs, localOf).catch(() => []);
  const plan = planLoads({ hours, loads, carKwh, carPriority: cfg.car_priority, nowMs, localOf, feedIn: pcfg.feed_in, feedInEur: pcfg.feed_in_eur_kwh, solarBonus: cfg.solar_bonus_eur, awayDays: awayAhead });
  rt.plan = { ...plan, hours, carKwh, at: new Date(nowMs).toISOString(), today, live: corrected.live, pvF, dayTypes: Object.fromEntries(types) };
  rt.loads = loads;
  rt.localOf = localOf;
  rt.planAt = nowMs;
  return rt.plan;
}

async function tick(nowMs = Date.now()) {
  await sample(nowMs).catch((e) => console.error(`[energy manager] sample: ${e.message}`));
  await require('./dayType').samplePresence(nowMs, 1).catch(() => {});
  const live = await require('./energyMeters').live().catch(() => ({ roles: {} }));
  // Re-plan every 15 min — every 5 min while the solar forecast is far off from what the meters say.
  const pvNow = live.roles?.pv?.power_kw;
  const fNow = rt.plan?.pvF?.[Math.floor(nowMs / HOUR) * HOUR];
  const off = Number.isFinite(pvNow) && fNow > 0.3 && Math.abs(pvNow / fNow - 1) > 0.35;
  if (!rt.plan || nowMs - rt.planAt > (off ? 5 : 15) * 60000) await recalc(nowMs).catch((e) => { rt.status = { error: e.message }; });
  if (!rt.plan) return;
  const gridKw = live.roles?.grid?.power_kw;
  const exportKw = gridKw !== null && gridKw !== undefined ? Math.max(0, -gridKw) : 0;
  const loadsById = Object.fromEntries((rt.loads || []).map((l) => [l.id, l]));
  rt.signals = currentSignals(rt.plan, nowMs, { exportKw, importKw: gridKw > 0 ? gridKw : 0, loadsById });
  rt.status = { at: new Date(nowMs).toISOString(), exportKw: r2(exportKw), pvKw: Number.isFinite(pvNow) ? r2(pvNow) : null, pvForecastKw: fNow !== undefined ? r2(fNow) : null };
  for (const s of rt.signals) {
    const load = loadsById[s.id];
    for (const [key, value] of Object.entries(s.values)) {
      const k = `${s.id}:${key}`;
      const v = value === undefined || value === null ? null : String(value);
      if (rt.last.get(k) === v) continue;
      rt.last.set(k, v);
      await db.prepare('INSERT INTO em_log (ts, load_id, signal_name, value, reason) VALUES (?, ?, ?, ?, ?)')
        .run(new Date(nowMs).toISOString(), s.id, key, v, s.reason || null).catch(() => {});
      if (load && load.output === 'live') { /* Live output comes in a later version: shadow only. */ }
    }
    if (load && load.kind === 'appliance') await applianceStep(load, s.values, nowMs).catch((e) => { rt.status = { ...rt.status, error: `${load.name}: ${e.message}` }; });
  }
  for (const l of rt.loads || []) {
    const smp = rt.samples.get(l.id);
    if (smp && smp.readyToStart) { if (!rt.readySince.has(l.id)) rt.readySince.set(l.id, nowMs); } else rt.readySince.delete(l.id);
  }
}

// One pulse on an appliance's virtual input (start / pause / resume), or — with Start via LoxSuite on
// "log only" (the default) — just written down. 'off' does nothing.
async function pulse(load, key, why, nowMs) {
  const mode = load.settings?.start_mode || 'log';
  if (mode === 'off') return false;
  const vi = viName(load, KINDS.appliance.signals.find((x) => x.key === key));
  if (mode !== 'on') {
    await db.prepare('INSERT INTO em_log (ts, load_id, signal_name, value, reason) VALUES (?, ?, ?, ?, ?)').run(new Date(nowMs).toISOString(), load.id, `${key}_sent`, 'log', `would ${why} now (${vi} = pulse) — Start via LoxSuite is on "log only"`).catch(() => {});
    return true;
  }
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(load.miniserver_id);
  if (!ms) throw new Error('No Miniserver for this consumer.');
  await require('./loxone').sendHttpVirtualInput(ms, vi, 'pulse');
  await db.prepare('INSERT INTO em_log (ts, load_id, signal_name, value, reason) VALUES (?, ?, ?, ?, ?)').run(new Date(nowMs).toISOString(), load.id, `${key}_sent`, 'pulse', `${why} (${vi} = pulse)`).catch(() => {});
  require('./auditLog').logSystemEvent(`Energy manager: ${why} ${load.name} (${vi} = pulse)`).catch(() => {});
  return true;
}

// Runs a waiting appliance by the plan, minute by minute:
//   start   in the planned hour, only while the machine says it is ready (at most once per 30 min);
//           the run's steps are kept from then on (a re-plan doesn't move a running wash)
//   pause   at the start of a planned gap, only while it is running and only if pausing is allowed
//   resume  at the next step — and always once a pause has lasted its maximum (+15 min), never later
// In "log only" the machine's state isn't checked for pause/resume (it was never started): what it
// would do is written down by the plan alone.
async function applianceStep(load, values, nowMs) {
  const s = load.settings || {};
  const mode = s.start_mode || 'log';
  if (mode === 'off') { rt.active.delete(load.id); return; }
  const smp = rt.samples.get(load.id) || {};
  const hour = Math.floor(nowMs / HOUR) * HOUR;
  let act = rt.active.get(load.id);
  if (!act && values.start === 1 && smp.readyToStart && nowMs - (rt.startSent.get(load.id) || 0) >= 30 * 60000) {
    const q = (rt.plan?.loads || []).find((p) => p.id === load.id)?.requests?.find((x) => x.ready && x.steps && x.steps[0] === hour);
    rt.startSent.set(load.id, nowMs);
    if (await pulse(load, 'start', 'start', nowMs)) rt.active.set(load.id, { steps: q ? q.steps : [hour], kwh: q ? q.kwh : null, pausedAt: null });
    return;
  }
  if (!act) return;
  const last = act.steps[act.steps.length - 1];
  const maxPauseMs = (Number(s.max_pause_h) || 0) * HOUR;
  const inStep = act.steps.includes(hour);
  if (act.pausedAt && (inStep || nowMs >= last + HOUR || nowMs - act.pausedAt > maxPauseMs + 15 * 60000)) {
    await pulse(load, 'resume', 'resume', nowMs);
    act.pausedAt = null;
  } else if (!act.pausedAt && !inStep && hour > act.steps[0] && hour < last && maxPauseMs > 0 && (mode !== 'on' || smp.on)) {
    if (await pulse(load, 'pause', 'pause', nowMs)) act.pausedAt = nowMs;
  }
  // done: past the last step and (for real) no longer running
  if (nowMs >= last + HOUR && !act.pausedAt && (mode !== 'on' || !smp.on)) rt.active.delete(load.id);
}

async function getConfig() {
  return { car_priority: 3, solar_bonus_eur: 0.05, ...(await require('./wallboxSettings').get('energy_manager', {})) };
}
async function saveConfig(c) { await require('./wallboxSettings').set('energy_manager', { ...(await getConfig()), ...c }); rt.planAt = 0; }

// Per load, per local day: kWh, cost, solar share, share in the hours LoxSuite would have chosen,
// and an estimate of what moving the rest there would have saved.
async function dailyReport(load, days = 14, nowMs = Date.now()) {
  const { localParts, displayTz } = require('./localTime');
  const tz = displayTz();
  const from = new Date(nowMs - days * 86400000).toISOString();
  const rows = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ? ORDER BY hour').all(load.id, from);
  const signalKey = load.kind === 'dhw' ? 'now' : load.kind === 'heatpump' ? 'release' : null;
  const log = signalKey ? await db.prepare('SELECT ts, value FROM em_log WHERE load_id = ? AND signal_name = ? AND ts >= ? ORDER BY ts').all(load.id, signalKey, new Date(Date.parse(from) - 86400000).toISOString()) : [];
  const onAt = (ms) => { let v = null; for (const r of log) { if (Date.parse(r.ts) > ms) break; v = r.value; } return v === null ? null : v === '1'; };
  const byDay = new Map();
  for (const r of rows) {
    const ms = Date.parse(r.hour);
    const p = localParts(ms, tz);
    const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const ctx = await hourContext(r.hour);
    const cost = hourCost(r.kwh, ctx);
    const d = byDay.get(day) || { day, kwh: 0, cost: 0, costKnown: 0, solarKwh: 0, advisedKwh: 0, knownAdvice: 0, advisedCost: 0, otherCost: 0, otherKwh: 0 };
    d.kwh += r.kwh;
    if (cost !== null) { d.cost += cost; d.costKnown += r.kwh; }
    if (ctx.houseKwh > 0 && ctx.gridImport !== null) d.solarKwh += r.kwh * (1 - Math.min(1, ctx.gridImport / ctx.houseKwh));
    const on = signalKey ? onAt(ms + 30 * 60000) : null;
    if (on !== null) {
      d.knownAdvice += r.kwh;
      if (on) { d.advisedKwh += r.kwh; if (cost !== null) d.advisedCost += cost; } else if (cost !== null) { d.otherCost += cost; d.otherKwh += r.kwh; }
    }
    byDay.set(day, d);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).map((d) => {
    const advisedRate = d.advisedKwh > 0 ? d.advisedCost / d.advisedKwh : null;
    const potential = advisedRate !== null && d.otherKwh > 0 ? Math.max(0, d.otherCost - d.otherKwh * advisedRate) : null;
    return {
      day: d.day, kwh: r2(d.kwh), cost: d.costKnown ? r2(d.cost) : null, eurPerKwh: d.costKnown ? r3(d.cost / d.costKnown) : null,
      solarShare: d.kwh ? Math.round((d.solarKwh / d.kwh) * 100) : null,
      advisedShare: d.knownAdvice ? Math.round((d.advisedKwh / d.knownAdvice) * 100) : null,
      potential: potential !== null ? r2(potential) : null,
    };
  });
}

// Pure: an appliance's runs from its kWh per hour (imported history has no on/off): hours in a row
// using at least minKwh are one run; runs under minTotal kWh (stand-by, a door light) are left out.
function runsFromHourly(rows, { minKwh = 0.05, minTotal = 0.2 } = {}) {
  const out = [];
  let cur = null;
  for (const r of [...rows].sort((a, b) => (a.hour < b.hour ? -1 : 1))) {
    const t = Date.parse(r.hour);
    if ((Number(r.kwh) || 0) >= minKwh) {
      if (cur && cur.endMs === t) { cur.endMs = t + HOUR; cur.kwh += Number(r.kwh); }
      else { if (cur) out.push(cur); cur = { startMs: t, endMs: t + HOUR, kwh: Number(r.kwh) }; }
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.kwh >= minTotal).map((x) => ({ start_at: new Date(x.startMs).toISOString(), end_at: new Date(x.endMs).toISOString(), kwh: r3(x.kwh) }));
}

// History from the Miniserver's own statistics (its meter block, through its MCP server): kWh per hour
// for the last `days` days (up to a year), for every consumer or one (loadId). For an appliance the runs
// are derived from it as well, so its patterns are learned straight away.
async function importHistory(days = 30, { callTool, loadId = null } = {}) {
  const mcp = callTool || ((ms, name, input) => require('./mcpClient').callTool(ms, name, input));
  const em = require('./energyMeters');
  const report = [];
  const to = new Date(); to.setUTCMinutes(0, 0, 0);
  const from = new Date(to.getTime() - Math.max(1, Math.min(366, days)) * 86400000);
  for (const l of await listLoads()) {
    if (loadId && l.id !== loadId) continue;
    const m = await resolveMeter(l);
    const group = em.totalStatGroup(m?.control);
    if (!group) { report.push({ load: l.name, ok: false, message: 'No meter statistics on this control.' }); continue; }
    try {
      const res = await mcp(m.ms, 'control_statistics', { uuid: l.meter_uuid, mode: 'diff', group_id: group.id, dp_unit: 'hour', from: from.toISOString(), to: to.toISOString(), limit: 10000 });
      let added = 0;
      for (const row of em.parseStatisticsResult(res)) {
        if (row.hour >= to.toISOString()) continue;
        const ex = await db.prepare('SELECT source FROM load_hourly WHERE load_id = ? AND hour = ?').get(l.id, row.hour);
        if (ex && ex.source === 'live') continue;
        await db.upsert('load_hourly', { load_id: l.id, hour: row.hour, kwh: row.total ?? 0, source: 'loxone' }, ['load_id', 'hour']);
        added++;
      }
      let runs = 0;
      if (l.kind === 'appliance') {
        const hourly = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ? AND hour < ?').all(l.id, from.toISOString(), to.toISOString());
        const have = await db.prepare("SELECT start_at, end_at FROM load_runs WHERE load_id = ? AND kind = 'run' AND start_at >= ?").all(l.id, new Date(from.getTime() - 86400000).toISOString());
        for (const r of runsFromHourly(hourly)) {
          // a run measured live (minute-exact) wins over the hourly estimate
          if (have.some((h) => Date.parse(h.start_at) < Date.parse(r.end_at) && Date.parse(h.end_at || h.start_at) > Date.parse(r.start_at))) continue;
          await db.prepare("INSERT INTO load_runs (load_id, start_at, end_at, kwh, kind) VALUES (?, ?, ?, ?, 'run')").run(l.id, r.start_at, r.end_at, r.kwh);
          runs++;
        }
      }
      report.push({ load: l.name, ok: true, hours: added, runs });
    } catch (err) { report.push({ load: l.name, ok: false, message: err.message }); }
  }
  return report;
}

function getRuntime() { return { unknown: rt.unknown || [], loads: rt.loads || [], follows: rt.follows || [], localOf: rt.localOf || null, plan: rt.plan, signals: rt.signals, status: rt.status, samples: Object.fromEntries(rt.samples), runs: Object.fromEntries(rt.runs) }; }

function startEnergyManager() {
  if (rt.timer) return;
  rt.timer = setInterval(() => { tick().catch((e) => { rt.status = { error: e.message }; }); }, 60000);
  rt.timer.unref?.();
  setTimeout(() => { tick().catch(() => {}); }, 70000).unref?.();
}

function stopEnergyManager() {
  if (rt.timer) clearInterval(rt.timer);
  rt.timer = null;
}
function invalidate() { rt.planAt = 0; }

module.exports = {
  HOME_CONNECT_STATUS, HOME_CONNECT_RUNNING, cleanStatusText, isOffText, bucket, seenStatuses, runsFromHourly, scheduledFromText, isReadyText, bestSteps, applianceStep,
  applyLive,
  KINDS, parseSettings, viName, toHours, effCost, planLoads, currentSignals, runStep, hourCost, quantile,
  runProgress, anomalies, unknownPatterns, weatherFor, sourcesOf, parseStatusMap, loadState, statusKey, statusSummary, timeline, loadDetail, learnedStatus,
  listLoads, readLoad, sample, recalc, tick, getConfig, saveConfig, dailyReport, importHistory, learned, getRuntime, startEnergyManager, stopEnergyManager, invalidate,
};
