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
    defaults: { kw: 1.0, flex_h: 8 },
    signals: [
      { key: 'start', suffix: 'Start', unit: 'pulse', hint: 'Home Connect start' },
      { key: 'pause', suffix: 'Pauze', unit: '1/0', hint: 'Home Connect pause' },
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
function sourcesOf(settings = {}) {
  const src = settings.src || {};
  return {
    onoff: src.onoff || null, onoffInvert: !!src.onoff_invert,
    status: src.status || null, statusMap: parseStatusMap(src.status_map), statusOn: parseList(src.status_on),
    power: src.power || null, powerUnit: src.power_unit === 'kW' ? 'kW' : 'W',
    energy: src.energy || null, energyUnit: src.energy_unit === 'Wh' ? 'Wh' : 'kWh',
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
const parseList = (text) => String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

// Pure: one reading of a consumer from its signals -> { kw, total, on, status, label, measured }.
//   meter: { kw, total } of the Loxone meter block (or nulls); raw: { onoff, status, power, energy }.
// "on" comes from the on/off state, else from the status (running values), else from the power.
function loadState({ meter = {}, raw = {}, src = sourcesOf({}), onKw = 0.05 }) {
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let kw = num(meter.kw);
  if (kw === null && src.power) { const p = num(raw.power); kw = p === null ? null : (src.powerUnit === 'kW' ? p : p / 1000); }
  let total = num(meter.total);
  if (total === null && src.energy) { const e = num(raw.energy); total = e === null ? null : (src.energyUnit === 'Wh' ? e / 1000 : e); }
  let status = null;
  let label = null;
  if (src.status && raw.status !== undefined && raw.status !== null && raw.status !== '') {
    const n = num(raw.status);
    status = n !== null ? String(Math.round(n * 1000) / 1000) : String(raw.status).slice(0, 40);
    label = src.statusMap[status] || (n === null ? status : null);
  }
  let on = null;
  if (src.onoff && raw.onoff !== undefined && raw.onoff !== null && raw.onoff !== '') {
    const v = num(raw.onoff);
    const b = v !== null ? v !== 0 : /^(on|aan|true|1)$/i.test(String(raw.onoff));
    on = src.onoffInvert ? !b : b;
  } else if (status !== null) {
    on = src.statusOn.length ? src.statusOn.includes(status) || (label !== null && src.statusOn.includes(label)) : !(status === '0' || /^(off|uit|idle)$/i.test(label || status));
  } else if (kw !== null) on = kw >= onKw;
  return { kw, total, on, status, label, measured: total !== null || kw !== null };
}

// Pure: the key a minute is booked under — the status label/value, else 'on'/'off'.
function statusKey(st) {
  if (st.status !== null && st.status !== undefined) return String(st.label || st.status).slice(0, 64);
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
function effCost(h, kwh, surplus, opts) {
  const fromSolar = Math.min(kwh, Math.max(0, surplus));
  const solarValue = opts.feedIn === 'fixed' ? opts.feedInEur : (h.price ?? 0) - (opts.solarBonus || 0);
  return fromSolar * Math.max(0, solarValue) + (kwh - fromSolar) * (h.price ?? 0);
}

// loads: [{ id, kind, name, priority, settings (object), requests: [{ id, readyBy (ms), kwh, durationH }] }]
// carKwh: { [hourMs]: kWh the car plan takes }; localOf(ms) -> { day: 'YYYY-MM-DD', hour: 0..23 }
function planLoads({ hours, loads, carKwh = {}, carPriority = 3, nowMs, localOf, feedIn = 'saldering', feedInEur = 0.05, solarBonus = 0.05 }) {
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
      for (const r of rows) { r.values.start = 0; r.values.pause = 0; }
      // No run asked for: expect its usual run(s) (learned pattern) and plan the best start from
      // the usual time up to flex_h later.
      if (!(load.requests || []).length && s.use_patterns !== false && localOf(nowMs).weekday !== undefined) {
        const ep = require('./energyPatterns');
        const end = H.length ? H[H.length - 1].ms + HOUR : nowMs;
        for (const p of (load.patterns || []).filter((x) => x.type === 'run')) {
          const occ = ep.nextOccurrence(p, nowMs, end, localOf);
          if (occ === null) continue;
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
        for (let i = 0; i < H.length; i++) {
          if (q.notBefore && H[i].ms < q.notBefore) continue;
          const block = H.slice(i, i + dur);
          if (block.length < dur || block[block.length - 1].ms + HOUR > q.readyBy + 1) break;
          const cost = block.reduce((a, h) => a + effCost(h, kwh / dur, left.get(h.ms), opts), 0);
          if (!best || cost < best.cost - 1e-9) best = { block, cost };
        }
        if (!best) continue;
        const r = at.get(best.block[0].ms);
        r.values.start = 1;
        r.reason = q.expected ? `best start for the ${q.label}` : `start for "${q.label || 'run'}" (ready by ${new Date(q.readyBy).toISOString()})`;
        q.plannedStart = best.block[0].ms;
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

const rt = { plan: null, planAt: 0, signals: [], last: new Map(), samples: new Map(), runs: new Map(), prevTotals: new Map(), timer: null, status: null };

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
  const anySrc = src.onoff || src.status || src.power || src.energy;
  if (anySrc && load.miniserver_id) {
    const ms = m?.ms || await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(load.miniserver_id);
    if (ms) {
      ws.ensureConnection(ms);
      for (const k of ['onoff', 'status', 'power', 'energy']) if (src[k]) raw[k] = ws.getLiveValue(ms.id, src[k]);
    }
  }
  const st = loadState({ meter, raw, src });
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
  return { kwPeak: active.length ? r2(quantile(active, 0.8)) : null, kwhPerDay, change, hours: rows.length, ...(await learnedStatus(load)) };
}

// Pure: per status (or on/off) from the hourly bookings: hours in it, kWh, the typical kW (only from
// measured kWh) and hours per day.
function statusSummary(rows, days) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.status) || { status: r.status, minutes: 0, kwh: 0, mMin: 0, mKwh: 0 };
    g.minutes += r.minutes; g.kwh += r.kwh;
    if (r.measured) { g.mMin += r.minutes; g.mKwh += r.kwh; }
    by.set(r.status, g);
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
  const on = rows.filter((r) => r.measured && !/^(off|uit|0)$/i.test(r.status));
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
  const last24 = await db.prepare('SELECT status, minutes, kwh FROM load_status_hourly WHERE load_id = ? AND hour >= ?').all(load.id, todayFrom).catch(() => []);
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
    const key = e.status !== null && e.status !== undefined ? String(e.label || e.status) : e.on_state === 1 ? 'on' : e.on_state === 0 ? 'off' : null;
    if (key === null) continue;
    const last = out[out.length - 1];
    if (last && last.key === key && last.to === a) last.to = b;
    else out.push({ from: a, to: b, key, on: e.on_state === null || e.on_state === undefined ? null : !!e.on_state });
  }
  return out;
}

// Learned patterns of one load (energyPatterns.js) from the last 8 weeks.
async function loadPatterns(load, nowMs, localOf) {
  const ep = require('./energyPatterns');
  const from = new Date(nowMs - 56 * 86400000).toISOString();
  const hourly = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(load.id, from).catch(() => []);
  const runs = load.kind === 'appliance' ? await db.prepare("SELECT start_at, end_at, kwh FROM load_runs WHERE load_id = ? AND kind = 'run' AND start_at >= ?").all(load.id, from).catch(() => []) : [];
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
  for (const l of loads) {
    const lr = await learned(l);
    if (l.kind !== 'appliance' && lr.kwPeak && !l.settings.kw_fixed) l.settings.kw = Math.max(0.3, lr.kwPeak);
    if (l.kind === 'appliance') l.requests = (await requestsFor(l.id, nowMs)).map((q) => ({ ...q, kwh: q.kwh || lr.kwh || l.settings.kw * 2, durationH: q.durationH || lr.durationH || 2 }));
    if (l.kind === 'dhw') {
      const from = new Date(require('./localTime').localMidnight(nowMs, tz)).toISOString();
      const row = await db.prepare('SELECT SUM(kwh) AS k FROM load_hourly WHERE load_id = ? AND hour >= ?').get(l.id, from);
      l.doneToday = (row?.k || 0) >= Math.max(0.5, (l.settings.kw || 2) * (l.settings.duration_h || 1) * 0.7);
    }
    l.learned = lr;
    Object.assign(l, await loadPatterns(l, nowMs, localOf));
    // write down the expected kWh per hour, to compare with what it really uses (forecastLog.js)
    if (l.profile) {
      const ep = require('./energyPatterns');
      const exp = hours.slice(0, 36).map((h) => ({ ms: h.ms, kwh: ep.expectedKwh(l.profile, h.ms, localOf) })).filter((x) => x.kwh !== null && x.kwh !== undefined);
      require('./forecastLog').recordLoad(l.id, exp, nowMs).catch(() => {});
    }
  }
  rt.follows = await followsFor(loads);
  const plan = planLoads({ hours, loads, carKwh, carPriority: cfg.car_priority, nowMs, localOf, feedIn: pcfg.feed_in, feedInEur: pcfg.feed_in_eur_kwh, solarBonus: cfg.solar_bonus_eur });
  rt.plan = { ...plan, hours, carKwh, at: new Date(nowMs).toISOString(), today, live: corrected.live, pvF };
  rt.loads = loads;
  rt.localOf = localOf;
  rt.planAt = nowMs;
  return rt.plan;
}

async function tick(nowMs = Date.now()) {
  await sample(nowMs).catch((e) => console.error(`[energy manager] sample: ${e.message}`));
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
  }
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

async function importHistory(days = 30, { callTool } = {}) {
  const mcp = callTool || ((ms, name, input) => require('./mcpClient').callTool(ms, name, input));
  const em = require('./energyMeters');
  const report = [];
  const to = new Date(); to.setUTCMinutes(0, 0, 0);
  const from = new Date(to.getTime() - Math.max(1, Math.min(120, days)) * 86400000);
  for (const l of await listLoads()) {
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
      report.push({ load: l.name, ok: true, hours: added });
    } catch (err) { report.push({ load: l.name, ok: false, message: err.message }); }
  }
  return report;
}

function getRuntime() { return { loads: rt.loads || [], follows: rt.follows || [], localOf: rt.localOf || null, plan: rt.plan, signals: rt.signals, status: rt.status, samples: Object.fromEntries(rt.samples), runs: Object.fromEntries(rt.runs) }; }

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
  applyLive,
  KINDS, parseSettings, viName, toHours, effCost, planLoads, currentSignals, runStep, hourCost, quantile,
  sourcesOf, parseStatusMap, loadState, statusKey, statusSummary, timeline, loadDetail, learnedStatus,
  listLoads, readLoad, sample, recalc, tick, getConfig, saveConfig, dailyReport, importHistory, learned, getRuntime, startEnergyManager, stopEnergyManager, invalidate,
};
