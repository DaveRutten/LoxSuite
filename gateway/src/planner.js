// Smart charging (Wallbox > Planner). Two halves:
//
//   makePlan()   — pure: given the time until the car must be ready, how much energy it needs, the
//                  price per interval and the expected solar surplus, pick the cheapest way to get
//                  there. Solar energy is valued at what exporting it would earn (with net metering /
//                  "saldering" that is the price of that moment; without it a fixed feed-in tariff),
//                  grid energy at the all-in price. A price cap (your own, or for a plug-in hybrid the
//                  price above which driving on fuel is cheaper) keeps expensive intervals out.
//   controlStep() — pure: every 30 s, the charging power to ask for right now, from the mode, the
//                  plan and the live meters (solar surplus with start/stop delays, grid limit).
//
// The runtime part (bottom) gathers the inputs from the vehicle, the learned departures, the
// agenda, prices, the solar forecast and the house profile; recalculates the plan every 15 minutes
// or when something changes; and — in "Live" output mode — writes the setpoint to Loxone virtual
// inputs. In "Advise" mode it only shows what it would do.
const settings = require('./wallboxSettings');

const MODES = ['off', 'now', 'pv', 'minpv', 'plan'];
const DEFAULTS = {
  mode: 'plan',
  output: 'advise',               // 'advise' (show only) | 'live' (write to Loxone)
  vi_setpoint: '',                // Loxone virtual input receiving the charging power in kW (0 = stop)
  vi_enable: '',                  // optional virtual input receiving 1/0 (charging allowed)
  vi_miniserver_id: null,         // Miniserver holding the virtual inputs (null = the first one)
  min_kw: 4.16,                   // 6 A x 3 phases
  max_kw: 11,
  grid_limit_kw: 17.3,            // 3 x 25 A
  pv_start_kw: null,              // default: min_kw
  pv_start_delay_s: 120,
  pv_stop_delay_s: 300,
  pv_allowed_import_kw: 0.5,      // grid import tolerated while solar charging before the stop timer runs
  pv_opportunistic: true,         // in "plan" mode also use solar surplus outside the planned intervals
  min_topup_kwh: 1,               // "plan" mode: don't start a session for less than this (a nearly full battery)
  min_on_s: 300,                  // once charging, keep going at least this long (no on/off flapping)
  min_off_s: 300,                 // once stopped, wait at least this long before starting again
  full_hold: 'release',           // battery full and still plugged in: 'release' = keep the Wallbox open at the
                                  // minimum so the car tops itself up (pre-heating from the grid), 'off' = 0
  solar_trust: 'low',             // 'low' (p10 of the forecast band) | 'expected' | 'bonus' (ignore solar when planning)
  max_price_eur_kwh: null,
  insufficient: 'charge',         // too few cheap intervals: 'charge' anyway | 'stop' at the price cap
  feed_in: 'saldering',           // value of exported solar: 'saldering' (= price of that moment) | 'fixed'
  feed_in_eur_kwh: 0.05,
  target_policy: 'full',          // after a trip: 'full' again before the next departure | 'needed' (what that departure
                                  // usually needs + reserve + buffer)
  buffer_km: 40,                  // always this much range soon after plugging in (an unexpected trip), within buffer_h
  buffer_h: 3,
  early_value_eur: 0.03,          // a kWh in the battery a day earlier is worth this much (€/kWh per day): an hour that
                                  // costs at most that much more is taken earlier, so the car is ready for the unexpected
  ready_margin_min: 15,
  depart_certainty: 'normal',     // learned departures: 'safe' (ready before 9 in 10) | 'normal' (3 in 4) | 'relaxed' (half)
  fuel_eur_l: 2.10,
  fuel_auto: false,
  default_kwh_per_km: 0.2,
};

const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------ plan (pure)

// slots: [{ start, end (ISO), price (all-in €/kWh), pvKw (expected solar surplus, kW) }]
function makePlan({
  nowMs, readyAtMs = null, needKwh, slots, mode = 'plan', minKw = 4.16, maxKw = 11,
  solarTrust = 'low', priceCap = null, insufficient = 'charge', feedIn = 'saldering', feedInEur = 0.05, horizonH = 24,
  earlyValue = 0,
}) {
  const end = readyAtMs || nowMs + horizonH * 3600000;
  const trust = solarTrust === 'bonus' ? 0 : solarTrust === 'expected' ? 1 : 0.7;
  const win = slots
    .map((s) => ({ ...s, s: Math.max(Date.parse(s.start), nowMs), e: Math.min(Date.parse(s.end), end) }))
    .filter((s) => s.e - s.s > 60000);
  const need = Math.max(0, Number(needKwh) || 0);
  const notes = [];
  const chunks = [];
  for (const s of win) {
    const h = (s.e - s.s) / 3600000;
    const pv = Math.max(0, (s.pvKw || 0) * trust);
    const price = Number.isFinite(s.price) ? s.price : null;
    const pvValue = feedIn === 'fixed' ? feedInEur : (price ?? feedInEur);
    if (pv >= minKw) {
      const kwA = Math.min(maxKw, pv);
      chunks.push({ slot: s, kw: kwA, h, cost: pvValue, source: 'pv', pvKw: kwA });
      if (kwA < maxKw && price !== null) chunks.push({ slot: s, kw: maxKw - kwA, h, cost: price, source: 'grid', topUp: true, pvKw: 0 });
    } else if (price !== null) {
      // Not enough solar for the minimum on its own: the first part (up to the minimum power) uses the
      // little solar there is, the rest is grid at the price. Picking the cheapest kWh then fills the
      // cheapest intervals first — at full power where needed, so the car is full at the lowest cost.
      const base = Math.min(minKw, maxKw);
      const blended = (pv * pvValue + (base - pv) * price) / base;
      chunks.push({ slot: s, kw: base, h, cost: blended, source: pv > 0.3 ? 'mixed' : 'grid', pvShare: pv / base, pvKw: pv > 0.3 ? pv : 0 });
      if (maxKw > base) chunks.push({ slot: s, kw: maxKw - base, h, cost: price, source: 'grid', topUp: true, pvKw: 0 });
    }
  }

  let picked = [];
  if (mode === 'now') {
    picked = chunks.filter((c) => !c.topUp).sort((a, b) => a.slot.s - b.slot.s).map((c) => ({ ...c, kw: maxKw }));
  } else if (mode === 'pv') {
    picked = chunks.filter((c) => c.source === 'pv').sort((a, b) => a.slot.s - b.slot.s);
  } else if (mode === 'minpv') {
    picked = win.map((s) => {
      const pv = Math.max(0, (s.pvKw || 0) * trust);
      return { slot: s, kw: Math.min(maxKw, Math.max(minKw, pv)), h: (s.e - s.s) / 3600000, cost: s.price, source: pv >= minKw ? 'pv' : pv > 0.3 ? 'mixed' : 'grid', pvKw: pv };
    });
  } else if (mode === 'plan') {
    // An extra part on top of an interval's base can only run together with that base (the Wallbox
    // can't charge below its minimum): a top-up that sorts before its base waits until the base is in.
    // Earlier is worth a little (earlyValue €/kWh per day): an hour that costs only slightly more now is
    // taken before a slightly cheaper one much later, so the car is ready sooner for an unexpected trip.
    const eff = (c) => c.cost + (earlyValue > 0 ? earlyValue * Math.max(0, c.slot.s - nowMs) / 86400000 : 0);
    const byCost = [...chunks].sort((a, b) => eff(a) - eff(b) || a.slot.s - b.slot.s || (a.topUp ? 1 : 0) - (b.topUp ? 1 : 0));
    const sorted = [];
    const baseIn = new Set();
    const waiting = new Map();
    for (const c of byCost) {
      if (c.topUp && !baseIn.has(c.slot.s) && byCost.some((x) => !x.topUp && x.slot === c.slot)) { waiting.set(c.slot.s, c); continue; }
      sorted.push(c);
      if (!c.topUp) { baseIn.add(c.slot.s); if (waiting.has(c.slot.s)) { sorted.push(waiting.get(c.slot.s)); waiting.delete(c.slot.s); } }
    }
    const under = sorted.filter((c) => priceCap === null || c.cost <= priceCap);
    const over = sorted.filter((c) => priceCap !== null && c.cost > priceCap);
    picked = [...under];
    if (insufficient === 'charge') picked = [...under, ...over];
    else if (over.length) notes.push('Intervals above the price cap are skipped.');
  }

  // Take chunks in order until the need is met (the last one partly).
  const result = [];
  let remaining = mode === 'off' ? 0 : need;
  const sequential = mode !== 'plan';
  for (const c of picked) {
    if (remaining <= 0.01) break;
    const kwh = c.kw * c.h;
    if (kwh <= 0) continue;
    const take = Math.min(kwh, remaining);
    // A partial interval: lower power for longer (never below the minimum) rather than full power for
    // a minute or two — fewer start/stops for the car and the Wallbox.
    // An extra (top-up) part on top of a base: spread over the whole interval as extra kW.
    const kwUse = take >= kwh || mode === 'now' ? c.kw : c.topUp ? take / c.h : Math.max(Math.min(c.kw, minKw), take / c.h);
    const frac = Math.min(1, take / (kwUse * c.h));
    result.push({
      start: new Date(c.slot.s).toISOString(), end: new Date(c.slot.s + (c.slot.e - c.slot.s) * frac).toISOString(),
      kw: round2(kwUse), kwh: round3(take), source: c.source, price: c.slot.price ?? null, cost: round3(take * c.cost), topUp: !!c.topUp,
      // the expected solar part of it (the rest comes from the grid)
      pvAvailKw: Math.max(0, (c.slot.pvKw || 0) * trust),
    });
    remaining -= take;
    if (sequential && mode === 'pv' && remaining <= 0) break;
  }
  // Merge pv + top-up in the same interval and sort by time.
  const bySlot = new Map();
  for (const r of result) {
    const k = r.start;
    const prev = bySlot.get(k);
    if (prev) {
      prev.kw = round2(prev.kw + r.kw); prev.kwh = round3(prev.kwh + r.kwh); prev.cost = round3(prev.cost + r.cost);
      prev.source = prev.source === 'grid' && r.source === 'grid' ? 'grid' : 'mixed'; if (r.end > prev.end) prev.end = r.end;
    } else bySlot.set(k, { ...r });
  }
  const planSlots = [...bySlot.values()].sort((a, b) => a.start.localeCompare(b.start));
  // The solar part, as it physically goes: while the car charges, the expected surplus of that
  // interval goes into it first, whatever the price ordering picked.
  for (const r of planSlots) {
    const h = (Date.parse(r.end) - Date.parse(r.start)) / 3600000;
    r.pvKwh = round3(Math.min(r.kwh, (r.pvAvailKw || 0) * h));
    if (r.pvKwh > 0.05 && r.source === 'grid') r.source = 'mixed';
    if (r.pvKwh >= r.kwh - 0.05 && r.kwh > 0) r.source = 'pv';
    delete r.pvAvailKw;
  }
  const kwh = round3(planSlots.reduce((s, r) => s + r.kwh, 0));
  const cost = round3(planSlots.reduce((s, r) => s + r.cost, 0));
  const pvKwh = round3(planSlots.reduce((s, r) => s + (r.pvKwh || 0), 0));
  // Some solar, but less than the Wallbox's minimum power: the rest of those intervals is grid.
  if (mode !== 'off' && planSlots.some((r) => r.source === 'mixed')) notes.push(`Expected solar surplus is below the Wallbox minimum of ${round2(minKw)} kW, so part of it comes from the grid (in the cheapest hours).`);
  const shortfall = round3(Math.max(0, need - kwh));
  if (mode !== 'off' && shortfall > 0.05) {
    notes.push(mode === 'pv'
      ? `Expected solar covers ${kwh.toFixed(1)} of ${need.toFixed(1)} kWh before the deadline.`
      : `${shortfall.toFixed(1)} kWh does not fit before the deadline${priceCap !== null && insufficient === 'stop' ? ' within the price cap' : ''}.`);
  }

  // What charging straight away would cost, for comparison.
  let left = need;
  let nowCost = 0;
  for (const s of [...win].sort((a, b) => a.s - b.s)) {
    if (left <= 0 || s.price === null || s.price === undefined) continue;
    const k = Math.min(left, maxKw * (s.e - s.s) / 3600000);
    nowCost += k * s.price;
    left -= k;
  }
  const nowKwh = need - Math.max(0, left);
  return {
    mode, slots: planSlots, needKwh: round3(need), kwh, pvKwh, gridKwh: round3(kwh - pvKwh), cost,
    avgPrice: kwh > 0 ? round3(cost / kwh) : null, feasible: shortfall <= 0.05, shortfallKwh: shortfall,
    compare: nowKwh > 0 ? { cost: round3(nowCost), avgPrice: round3(nowCost / nowKwh), saving: round3(nowCost * (kwh / nowKwh) - cost) } : null,
    readyAt: readyAtMs ? new Date(readyAtMs).toISOString() : null, notes,
  };
}

// Price above which a plug-in hybrid is cheaper on fuel: fuel €/km divided by kWh/km (+10% losses).
function fuelBreakEven({ fuelEurL, lPer100km, kwhPerKm }) {
  if (!(fuelEurL > 0) || !(lPer100km > 0) || !(kwhPerKm > 0)) return null;
  return round3((fuelEurL * lPer100km / 100) / (kwhPerKm * 1.1));
}

// The planned interval that covers `nowMs`, if any.
function activeSlot(plan, nowMs) {
  return (plan?.slots || []).find((s) => Date.parse(s.start) <= nowMs && Date.parse(s.end) > nowMs) || null;
}

// ------------------------------------------------------------------ control (pure)

// live: { connected, gridKw (+ import), wallboxKw, houseKw }; state carries the solar timers.
// Returns { kw, reason, state }.
function controlStep({ nowMs, mode, cfg, plan, live, state = {}, done = false, override = null }) {
  const min = Number(cfg.min_kw) || 4.16;
  const max = Number(cfg.max_kw) || 11;
  const st = { ...state };
  const effMode = override || mode;
  if (!live.connected) return { kw: 0, reason: 'No car connected.', state: { } };
  if (done) return { kw: 0, reason: 'Target reached (the car stopped charging).', state: st };
  // Solar surplus available to the car: what is exported now plus what the car already uses.
  const surplus = round3(-(live.gridKw ?? 0) + (live.wallboxKw ?? 0));
  const startKw = Number(cfg.pv_start_kw) || min;
  const pvSetpoint = () => {
    if (st.pvCharging) {
      if (surplus >= min - (Number(cfg.pv_allowed_import_kw) || 0)) st.pvLowSince = null;
      else if (st.pvLowSince == null) st.pvLowSince = nowMs;
      if (st.pvLowSince != null && nowMs - st.pvLowSince >= (cfg.pv_stop_delay_s ?? 300) * 1000) { st.pvCharging = false; st.pvLowSince = null; }
    } else {
      if (surplus >= startKw) { if (st.pvHighSince == null) st.pvHighSince = nowMs; } else st.pvHighSince = null;
      if (st.pvHighSince != null && nowMs - st.pvHighSince >= (cfg.pv_start_delay_s ?? 120) * 1000) { st.pvCharging = true; st.pvHighSince = null; }
    }
    return st.pvCharging ? Math.min(max, Math.max(min, surplus)) : 0;
  };
  let kw = 0;
  let reason = '';
  if (effMode === 'off') { reason = 'Mode Off.'; }
  else if (effMode === 'now') { kw = max; reason = 'Charging now at full power.'; }
  else if (effMode === 'pv') { kw = pvSetpoint(); reason = kw ? `Solar surplus ${surplus.toFixed(2)} kW.` : `Waiting for solar surplus (now ${surplus.toFixed(2)} kW, start at ${startKw.toFixed(2)} kW).`; }
  else if (effMode === 'minpv') { kw = Math.min(max, Math.max(min, surplus)); reason = surplus > min ? `Minimum + solar (${surplus.toFixed(2)} kW surplus).` : 'Minimum power.'; }
  else if (effMode === 'plan') {
    const slot = activeSlot(plan, nowMs);
    const pv = cfg.pv_opportunistic ? pvSetpoint() : 0;
    if (slot) { kw = Math.max(slot.kw, pv); reason = `Planned interval until ${require('./localTime').hhmm(Date.parse(slot.end))} (${slot.source === 'pv' ? 'solar' : slot.source === 'mixed' ? 'solar + grid' : 'grid'}).`; }
    else if (pv) { kw = pv; reason = `Extra solar surplus ${surplus.toFixed(2)} kW.`; }
    else { const next = (plan?.slots || []).find((s) => Date.parse(s.start) > nowMs); reason = next ? `Waiting for the next planned interval at ${require('./localTime').hhmm(Date.parse(next.start))}.` : 'Nothing planned.'; }
  }
  // Never exceed the grid connection: house load + car <= limit.
  const limit = Number(cfg.grid_limit_kw) || 0;
  if (kw > 0 && limit > 0 && live.houseKw !== null && live.houseKw !== undefined) {
    const room = limit - live.houseKw;
    if (room < kw) {
      kw = room >= min ? room : 0;
      reason += kw ? ` Limited to ${kw.toFixed(2)} kW by the grid connection.` : ' Paused: the grid connection is fully used.';
    }
  }
  if (kw > 0) kw = Math.min(max, Math.max(min, round2(kw)));
  return { kw: round2(kw), reason: reason.trim(), state: st, surplus };
}

// ------------------------------------------------------------------ runtime

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function getConfig() { return settings.get('planner', DEFAULTS); }
async function saveConfig(v) {
  const cur = await getConfig();
  const next = { ...cur, ...v };
  if (!MODES.includes(next.mode)) next.mode = 'plan';
  await settings.set('planner', next);
  return next;
}

const rt = {
  plan: null, planAt: 0, planKey: '', ctrl: { state: {} }, lastWrite: { kw: null, at: 0 }, override: null,
  session: null, status: null, readyOverride: null, doneSince: null, lowDrawSince: null,
  socBase: null, onSince: null, offSince: null,
};

// The car this session is for: the only one, or identified by NFC tag / Loxone user / its own data
// source, or the answer to the "which car is plugged in?" push question. Otherwise the first car,
// and the question is asked (once per session).
async function primaryVehicle(wb = null) {
  const db = require('./db');
  const list = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id').all().catch(() => []);
  if (list.length <= 1 || !wb?.connected) return list[0] || null;
  if (rt.sessionVehicle) { const v = list.find((x) => x.id === rt.sessionVehicle); if (v) return v; }
  let idTag = null;
  try {
    const bridges = await db.prepare('SELECT id FROM ocpp_bridges WHERE enabled = 1').all();
    for (const b of bridges) {
      const st = require('./ocppBridge').getBridgeStatus(b.id);
      if (st?.transaction?.idTag && st.transaction.idTagSource !== 'fixed' && st.transaction.idTagSource !== 'fallback') idTag = st.transaction.idTag;
    }
  } catch { /* no bridge */ }
  const vehicles = require('./vehicles');
  const plugged = list.filter((v) => vehicles.getVehicleStatus(v).reading?.plugged === true).map((v) => v.id);
  const hit = vehicles.identifyVehicle(list, { idTag, loxoneUser: wb.sessionUser, pluggedIds: plugged });
  if (hit) return hit;
  require('./notifications').fireCarEvent('car_reminder', `which|${wb.connectAt || 'now'}`, {
    title: 'Which car is plugged in?', message: 'LoxSuite can\'t tell which car is connected; tap the right one so the plan is made for it.',
    fields: [], url: '/planner', tag: 'which',
    actions: list.slice(0, 2).map((v) => ({ action: `vehicle:${v.id}`, title: v.name })), data: { kind: 'which' },
  }).catch(() => {});
  return list[0];
}

// The car's live state from its data source, if fresh (< 6 h).
function freshReading(vehicle) {
  if (!vehicle) return null;
  const st = require('./vehicles').getVehicleStatus(vehicle);
  const r = st.reading;
  const at = st.sourceUpdatedAt ? Date.parse(st.sourceUpdatedAt) : null;
  if (!r || r.soc === null || r.soc === undefined) return null;
  if (at && Date.now() - at > 6 * 3600000) return null;
  return r;
}

// Live Wallbox values (connected, power, session energy) via the configured wallbox meter.
async function wallboxLive() {
  const learning = require('./learning');
  const wb = await learning.wallboxControl();
  if (!wb) return null;
  const ws = require('./loxoneWebSocket');
  ws.ensureConnection(wb.miniserver);
  const read = (n) => (wb.control.states?.[n] ? ws.getLiveValue(wb.miniserver.id, wb.control.states[n]) : undefined);
  let session = null;
  try { session = JSON.parse(read('session') || 'null'); } catch { session = null; }
  return {
    name: wb.control.name, connected: Number(read('connected')) === 1, active: Number(read('active')) === 1,
    kw: Number(read('actual')) || 0, total: Number(read('total')) || null, mode: read('mode'), limit: read('limit'), enabled: read('enabled'),
    sessionKwh: session ? Number(session.energy) || 0 : null, connectAt: session?.connect ? session.connect * 1000 : null, miniserver: wb.miniserver,
    sessionUser: session?.user || null,
  };
}

// How much the car needs and by when. Returns { needKwh, needSource, readyAtMs, readySource, vehicle, ... }.
async function computeTarget(nowMs, wb) {
  const cfg = await getConfig();
  const learning = require('./learning');
  const { displayTz } = require('./localTime');
  const tz = displayTz();
  const vehicle = await primaryVehicle(wb);
  const usable = vehicle?.battery_kwh ? vehicle.battery_kwh * ((vehicle.charge_limit_pct || 100) / 100) : null;
  const reading = freshReading(vehicle);
  let needKwh = null;
  let needSource = '';
  // Driving per weekday from the car's odometer (driving.js): while the car is out, the km it
  // usually still drives today count too, so the plan for "when it's back" is about the right size.
  let drive = null;
  try { drive = await require('./driving').drivePattern(vehicle, { nowMs }); } catch { drive = null; }
  const away = !wb?.connected && reading?.home !== true;
  const kpkNow = require('./driving').effectiveKwhPerKm(vehicle, cfg.default_kwh_per_km);
  const todayPat = drive && vehicle ? drive.days[require('./localTime').localParts(nowMs, tz).weekday] : null;
  const usualToday = away && todayPat?.usual && todayPat.kmMedian ? todayPat : null;
  if (reading && vehicle?.battery_kwh) {
    const limitPct = reading.limit_soc ?? vehicle.charge_limit_pct ?? 100;
    needKwh = Math.max(0, vehicle.battery_kwh * (limitPct - reading.soc) / 100);
    needSource = `car reports ${reading.soc}%`;
    // The car's own data often lags (cloud updates every few minutes or only when it wakes up):
    // subtract what this session charged since that reading came in.
    const readAt = require('./vehicles').getVehicleStatus(vehicle).sourceUpdatedAt || null;
    const sessKwh = wb?.sessionKwh ?? null;
    if (sessKwh !== null) {
      if (!rt.socBase || rt.socBase.readAt !== readAt || rt.socBase.session !== rt.session || sessKwh < rt.socBase.kwh) rt.socBase = { readAt, kwh: sessKwh, session: rt.session };
      const since = Math.max(0, sessKwh - rt.socBase.kwh);
      if (since > 0.05) { needKwh = Math.max(0, needKwh - since); needSource += `, minus ${since.toFixed(1)} kWh charged since`; }
    }
    if (usualToday) {
      const moreKm = Math.max(0, Math.round(usualToday.kmMedian - (drive.kmToday || 0)));
      const room = usable !== null ? Math.max(0, usable - needKwh) : Infinity;
      const extra = Math.min(room, moreKm * kpkNow);
      if (moreKm >= 2 && extra > 0.1) { needKwh += extra; needSource += ` · about ${moreKm} km more today (learned: ${usualToday.kmMedian} km on a ${WEEKDAY_NAMES[usualToday.weekday]})`; }
    }
  } else if (usualToday) {
    // Out, and no state of charge from the car: what it usually drives on this weekday (odometer).
    needKwh = Math.min(usable ?? Infinity, usualToday.kmMedian * kpkNow);
    needSource = `estimated from the usual ${usualToday.kmMedian} km on a ${WEEKDAY_NAMES[usualToday.weekday]} (learned from the odometer)`;
  } else {
    // Estimate: energy of the trip the car just came back from (learned), minus what this session charged.
    const sessions = await learning.loadSessions(60, vehicle?.id || null);
    const last = sessions.filter((s) => s.disconnect && (!wb?.connectAt || s.disconnect < wb.connectAt)).pop();
    const awayH = last && wb?.connectAt ? (wb.connectAt - last.disconnect) / 3600000 : 8;
    const trips = await learning.learnedTrips(vehicle);
    const exp = last ? learning.expectedTripKwh(trips, last.disconnect, awayH, { tz }) : null;
    let est = exp?.kwh ?? (usable ? usable * 0.6 : 15);
    if (usable) est = Math.min(est, usable);
    needKwh = Math.max(0, est - (wb?.sessionKwh || 0));
    needSource = exp ? `estimated from ${exp.source} (${exp.n}x, ${exp.kwh} kWh) minus ${(wb?.sessionKwh || 0).toFixed(1)} kWh charged` : 'estimate (no history yet)';
  }
  // Deadline: a manual "ready by" for this session, the agenda, the learned weekday pattern.
  let readyAtMs = null;
  let readySource = '';
  let tripItem = null;
  let agendaTrip = null;
  if (rt.readyOverride && rt.readyOverride > nowMs) {
    readyAtMs = rt.readyOverride; readySource = 'set by you';
    // with a distance or amount: make sure that much is in the battery (like a trip in the agenda)
    if (rt.readyOverrideOwn && usable) {
      const agenda = require('./agenda');
      const acfg = await agenda.getConfig().catch(() => agenda.DEFAULTS);
      const kpk = require('./driving').effectiveKwhPerKm(vehicle, cfg.default_kwh_per_km);
      const tn = agenda.tripNeedKwh({ own: agenda.parseOwnValue(rt.readyOverrideOwn), marginKm: Number(acfg.margin_km) || 0, kwhPerKm: kpk, usableKwh: usable });
      if (tn.kwh) {
        const energyNow = reading && vehicle?.battery_kwh ? vehicle.battery_kwh * reading.soc / 100 : (usable - needKwh);
        const want = Math.max(0, Math.min(usable, tn.kwh) - energyNow);
        if (want > needKwh) needKwh = want;
        readySource += ` · ${rt.readyOverrideOwn} (${tn.kwh.toFixed(1)} kWh)`;
      }
    }
  }
  try {
    const agenda = require('./agenda');
    const trip = await agenda.nextCarTrip(nowMs, vehicle);
    agendaTrip = trip || null;
    if (trip && (!readyAtMs || trip.readyAt < readyAtMs)) {
      readyAtMs = trip.readyAt; readySource = `agenda: ${trip.title}`; tripItem = trip;
      if (trip.needKwh && usable && trip.needKwh > needKwh) {
        // A long trip from the agenda: make sure that much is in the battery.
        const energyNow = reading && vehicle?.battery_kwh ? vehicle.battery_kwh * reading.soc / 100 : (usable - needKwh);
        needKwh = Math.max(needKwh, Math.min(usable, trip.needKwh) - energyNow);
        needSource += ` · trip needs ${trip.needKwh.toFixed(1)} kWh`;
      }
    }
  } catch { /* agenda not configured */ }
  // The learned weekday pattern counts too: whichever comes first (unless set by hand).
  let learnedNext = null;
  let learnedShift = 0;
  if (!rt.readyOverride || rt.readyOverride <= nowMs) {
    const stats = await learning.learnedDepartures(vehicle?.id || null);
    // away or a public holiday (dayType.js): that day has no usual departure
    const dts = await require('./dayType').typesBetween(nowMs, nowMs + 8 * 86400000).catch(() => new Map());
    const { localParts: lp } = require('./localTime');
    // working from home: no usual commute either
    const skip = (ms) => { const p = lp(ms, tz); const t = dts.get(`${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`)?.type; return t === 'away' || t === 'holiday' || t === 'home'; };
    learnedNext = (fromMs) => {
      const n = learning.nextReadyTime(stats, fromMs, { tz, skip });
      return n ? { ...n, at: n.at - (n.source === 'override' ? 0 : learnedShift) * 60000 } : null;
    };
    const nx = learning.nextReadyTime(stats, nowMs, { tz, skip });
    // it often left before it was ready: the learned time moves earlier (forecastLog.js)
    learnedShift = (await require('./forecastLog').corrections(nowMs).catch(() => ({}))).departShiftMin || 0;
    const shift = nx && nx.source !== 'override' ? learnedShift : 0;
    const nxAt = nx ? nx.at - shift * 60000 : null;
    if (nx && nxAt > nowMs && (!readyAtMs || nxAt < readyAtMs)) {
      const day = WEEKDAY_NAMES[WEEKDAY_KEYS.indexOf(nx.weekday)] || nx.weekday;
      readyAtMs = nxAt;
      readySource = nx.source === 'override' ? `your departure time on ${day}` : `learned departure on ${day} (${nx.confidence} confidence)`;
      if (shift) readySource += ' · ' + `${shift} min earlier: it often left before it was ready`;
    }
  }
  if (readyAtMs) readyAtMs -= 0; // ready time already includes the learned margin
  // Plugged in before an appointment in the agenda: only what that trip needs (plus the reserve) has to
  // be in by then; the rest may come after it is back — with solar, or in whichever hours are cheapest.
  let split = null;
  // The appointment the deadline belongs to: the one that set it, or one within 3 hours of it (your own
  // or the learned departure time for the same trip, a few minutes earlier).
  const near = sameTrip(agendaTrip, readyAtMs) ? agendaTrip : null;
  const trip0 = tripItem || near;
  const it = trip0?.item;
  let tripPart = null; // { kwh, backAtMs, leaveMs, title }
  if (it && !it.allDay && it.end && trip0.needKwh) {
    tripPart = { kwh: trip0.needKwh, backAtMs: Date.parse(it.end) + (it.travelMin || 0) * 60000, leaveMs: Math.min(readyAtMs, Date.parse(it.leaveAt || it.start)), title: trip0.title };
  } else if (readyAtMs && drive && vehicle && !tripItem) {
    // No appointment: what the car usually drives on that weekday (odometer) and when it is usually back.
    const { localParts, localTimeOn } = require('./localTime');
    const d = drive.days?.[localParts(readyAtMs, tz).weekday];
    if (d?.usual && d.kmMedian && d.back) {
      const back = localTimeOn(readyAtMs, d.back, tz);
      const marginKm = Number((await require('./agenda').getConfig().catch(() => ({}))).margin_km) || 0;
      if (back > readyAtMs) tripPart = { kwh: (d.kmMedian + marginKm) * kpkNow, backAtMs: back, leaveMs: readyAtMs, title: `usual ${d.kmMedian} km` };
    }
  }
  const agendaCar = async (fromMs, toMs) => {
    try {
      const list = await require('./agenda').items(new Date(fromMs).toISOString(), new Date(toMs).toISOString());
      return list.filter((n) => n.needsCar && !n.allDay && n.end && !(n.vehicle_id && vehicle && n.vehicle_id !== vehicle.id)).map((n) => ({
        kwh: n.needKwh || 0, leaveMs: Date.parse(n.leaveAt || n.start), backAtMs: Date.parse(n.end) + (n.travelMin || 0) * 60000,
        readyAtMs: Date.parse(n.readyAt || n.leaveAt || n.start), title: n.title,
      }));
    } catch { return []; }
  };
  if (!away && tripPart && vehicle?.battery_kwh && reading) {
    // appointments right after each other are one trip (the car doesn't come home in between)
    if (it) {
      const firstLeave = Date.parse(it.leaveAt || it.start);
      const nextOnes = (await agendaCar(tripPart.leaveMs, tripPart.backAtMs + 6 * 3600000)).filter((n) => n.leaveMs > firstLeave + 60000);
      tripPart = mergeTrips(tripPart, nextOnes);
    }
    const fullKwh = vehicle.battery_kwh * ((reading.limit_soc ?? vehicle.charge_limit_pct ?? 100) / 100);
    const energyNowKwh = Math.max(0, fullKwh - needKwh);
    // when it is needed again after it is back: its next learned departure (or within 24 hours)
    let restByMs = tripPart.backAtMs + 24 * 3600000;
    let restBySource = null;
    const nxt = learnedNext ? learnedNext(tripPart.backAtMs + 30 * 60000) : null;
    if (nxt && nxt.at > tripPart.backAtMs + 3600000 && nxt.at < restByMs) { restByMs = nxt.at; restBySource = nxt.source; }
    // 'needed': after it is back only what that next departure usually needs (+ reserve + buffer)
    let restTargetKwh = null;
    if (cfg.target_policy === 'needed' && drive) {
      const d = drive.days?.[require('./localTime').localParts(restByMs, tz).weekday];
      if (d?.usual && d.kmMedian) {
        const marginKm = Number((await require('./agenda').getConfig().catch(() => ({}))).margin_km) || 0;
        restTargetKwh = (d.kmMedian + marginKm) * kpkNow + vehicle.battery_kwh * (Number(vehicle.reserve_pct) || 0) / 100 + (Number(cfg.buffer_km) || 0) * kpkNow;
      }
    }
    split = planSplit({ needKwh, batteryKwh: vehicle.battery_kwh, soc: reading.soc, reservePct: vehicle.reserve_pct ?? 15, readyAtMs, trip: tripPart, energyNowKwh, restTargetKwh });
    if (split) {
      split.restByMs = restByMs; split.restBySource = restBySource;
      // the car's next trips in the agenda (between being back and being needed again): it is away
      // then, and each needs its own energy in the battery before it leaves
      for (const n of await agendaCar(split.backAtMs, restByMs)) {
        if (n.leaveMs < split.backAtMs) continue;
        split.away.push([n.leaveMs, n.backAtMs]);
        if (split.later.length < 3) split.later.push({ title: n.title, readyAtMs: n.readyAtMs, kwh: n.kwh });
      }
    }
  }
  // Ready for the unexpected: soon after plugging in (or coming home) at least buffer_km of range.
  let bufferKwh = 0;
  if (vehicle?.battery_kwh && Number(cfg.buffer_km) > 0) {
    const fullKwh = usable ?? vehicle.battery_kwh;
    const want = Math.min(fullKwh, Number(cfg.buffer_km) * kpkNow);
    const energyNow = Math.max(0, fullKwh - (needKwh || 0));
    bufferKwh = round3(Math.max(0, Math.min(needKwh || 0, want - energyNow)));
  }
  let zeroed = false;
  if (rt.fullKey && rt.fullKey === rt.session) { needKwh = 0; needSource = 'battery full (not unplugged since)'; zeroed = true; }
  const minTopup = Number(cfg.min_topup_kwh) || 0;
  if ((rt.override || cfg.mode) === 'plan' && needKwh > 0 && needKwh < minTopup) {
    needSource += ` — less than the ${minTopup} kWh minimum top-up, so no grid charging (solar surplus still counts)`;
    needKwh = 0; zeroed = true;
  }
  if (zeroed) { split = null; bufferKwh = 0; } // full / minimum top-up: nothing to split or to buffer
  return { needKwh: round3(needKwh || 0), needSource, readyAtMs, readySource, vehicle, usable, reading, drive, away, split, bufferKwh, bufferKm: Number(cfg.buffer_km) || 0 };
}

// When the car that is out is expected home: an appointment with the car that is going on now (its
// end + travel time), else the learned weekday pattern — the end of the last trip of the day from the
// odometer, or the usual plug-in time from the Wallbox sessions. Null = no idea, or later than the
// deadline (then the plan simply starts now).
async function expectedArrival(nowMs, target, untilMs) {
  if (!target.away) return null;
  const { displayTz, localParts, localMidnight, localTimeOn } = require('./localTime');
  const tz = displayTz();
  // What the car reports now: driving -> set off + the drive home; parked away -> not before the drive.
  const live = await require('./carEta').liveArrival(target.vehicle, nowMs).catch(() => null);
  if (live?.at) return live.at < untilMs ? live : null;
  const notBefore = (r) => {
    if (!r || !live?.minAt || r.at >= live.minAt) return r;
    return live.minAt >= untilMs ? null : { ...r, at: live.minAt, label: live.label };
  };
  try {
    const list = await require('./agenda').items(new Date(nowMs - 12 * 3600000).toISOString(), new Date(nowMs + 3600000).toISOString());
    const cur = list.find((i) => i.needsCar && Date.parse(i.start) <= nowMs && Date.parse(i.end) > nowMs && !i.allDay
      && (!target.vehicle || !i.vehicle_id || i.vehicle_id === target.vehicle.id));
    if (cur) {
      const at = Date.parse(cur.end) + (cur.travelMin || 0) * 60000;
      if (at > nowMs && at < untilMs) return notBefore({ at, source: 'agenda', label: `agenda: ${cur.title}`, confidence: 'set' });
    }
  } catch { /* no agenda */ }
  const sessionsStats = await require('./learning').learnedDepartures(target.vehicle?.id || null).catch(() => []);
  for (let i = 0; i < 3; i++) {
    const dayMs = localMidnight(nowMs, tz, i) + 12 * 3600000;
    const wd = localParts(dayMs, tz).weekday;
    const d = target.drive?.days?.[wd];
    const st = sessionsStats[wd];
    let pick = null;
    if (d?.usual && d.back) pick = { time: d.back, source: 'odometer', confidence: d.confidence, n: d.drivenDays };
    else if (st?.arrival && st.arrivalN >= 3) pick = { time: st.arrival, source: 'wallbox', confidence: st.arrivalN >= 12 ? 'high' : st.arrivalN >= 6 ? 'medium' : 'low', n: st.arrivalN };
    if (!pick) continue;
    const at = localTimeOn(dayMs, pick.time, tz);
    if (at <= nowMs) continue;
    if (at >= untilMs) return null;
    return notBefore({ at, source: pick.source, label: `learned: usually home around ${pick.time} on ${WEEKDAY_NAMES[wd]}`, confidence: pick.confidence });
  }
  return null;
}

// Pure: does this agenda trip belong to the deadline? The trip that set it, or one within 3 hours of
// it (your own or the learned departure time for the same trip).
function sameTrip(trip, readyAtMs) {
  return !!(trip && readyAtMs && Number.isFinite(trip.readyAt) && Math.abs(trip.readyAt - readyAtMs) <= 3 * 3600000);
}

// Pure: what has to be in before leaving (the trip + the reserve, minus what is in the battery) and
// what comes after the car is back. The trip itself empties the battery by its kWh (a plug-in hybrid
// drives on fuel once it is empty), so after it is back the car needs that much more to be full again:
//   mustKwh     before leaving: trip + reserve − energy now
//   preMaxKwh   what may be charged before leaving at all (the room that is left)
//   restKwh     after it is back: to be full again (restTargetKwh: only up to that level instead)
// Null when there is nothing to choose before leaving (less than 1 kWh of room left after the must
// part), or the car isn't back after the deadline.
function planSplit({ needKwh, batteryKwh, soc, reservePct = 15, readyAtMs, trip, energyNowKwh = null, restTargetKwh = null }) {
  if (!trip || !(batteryKwh > 0) || soc === null || soc === undefined || !(needKwh > 0)) return null;
  const energyNow = Number.isFinite(energyNowKwh) ? energyNowKwh : batteryKwh * soc / 100;
  const reserveKwh = batteryKwh * (Number(reservePct) || 0) / 100;
  const must = Math.max(0, Math.min(needKwh, trip.kwh + reserveKwh - energyNow));
  if (!(needKwh - must > 1) || !(trip.backAtMs > readyAtMs)) return null;
  const fullKwh = energyNow + needKwh; // the level the car charges to (its limit)
  const afterTrip = Math.max(0, energyNow + must - trip.kwh);
  const target = Number.isFinite(restTargetKwh) ? Math.min(fullKwh, Math.max(0, restTargetKwh)) : fullKwh;
  const rest = Math.max(0, target - afterTrip);
  return {
    mustKwh: round3(must), restKwh: round3(rest), preMaxKwh: round3(needKwh - must), energyAfterKwh: round3(afterTrip), fullKwh: round3(fullKwh),
    backAtMs: trip.backAtMs, tripKwh: round3(trip.kwh), reserveKwh: round3(reserveKwh),
    title: trip.title, away: [[trip.leaveMs ?? readyAtMs, trip.backAtMs]], later: [], restByMs: null,
  };
}

// Pure: appointments with the car that follow each other (the next one starts before the car is back
// from the previous one, or less than `gapMin` after) are one trip: the car doesn't come home to
// charge in between. trips: [{ kwh, leaveMs, backAtMs, title }] in order -> merged first trip.
function mergeTrips(first, next = [], { gapMin = 45 } = {}) {
  const out = { ...first };
  for (const n of [...next].sort((a, b) => a.leaveMs - b.leaveMs)) {
    if (!(n.leaveMs > out.leaveMs) || n.leaveMs > out.backAtMs + gapMin * 60000) continue;
    out.kwh = round3((out.kwh || 0) + (n.kwh || 0));
    out.backAtMs = Math.max(out.backAtMs, n.backAtMs);
    out.title = `${out.title} + ${n.title}`;
    out.merged = (out.merged || 0) + 1;
  }
  return out;
}

// Pure: the plan for what must be in before the appointment + the rest. The rest is picked from the
// free hours — before the appointment (at most what still fits then), and after the car is back until
// it is needed again (split.restByMs: its next departure, else 24 hours), never while it is away for a
// later trip — and a later trip's own energy comes first, before that trip leaves.
function withRest(must, planArgs, slots, split, untilMs) {
  const taken = [...must.slots];
  const away = split.away || [];
  const restBy = split.restByMs && split.restByMs > split.backAtMs ? split.restByMs : split.backAtMs + 24 * 3600000;
  const freeSlots = (endMs, { pre = true, post = true } = {}) => {
    const out = [];
    for (const s of slots) {
      let a = Math.max(Date.parse(s.start), planArgs.nowMs);
      let b = Date.parse(s.end);
      if (a < untilMs) { if (!pre) continue; b = Math.min(b, untilMs); } else if (a < split.backAtMs || !post) continue;
      b = Math.min(b, endMs);
      if (b - a < 60000) continue;
      if (away.some(([x, y]) => a < y && b > x)) continue;
      if (taken.some((p) => Date.parse(p.start) < b && Date.parse(p.end) > a)) continue;
      out.push({ ...s, start: new Date(a).toISOString(), end: new Date(b).toISOString() });
    }
    return out;
  };
  const sumKwh = (list) => list.reduce((t, r) => t + r.kwh, 0);
  const parts = [];
  let left = split.restKwh;
  let preLeft = Number.isFinite(split.preMaxKwh) ? split.preMaxKwh : Infinity;
  for (const n of split.later || []) {
    if (left <= 0.05) break;
    const want = Math.min(left, n.kwh || 0);
    if (want <= 0.05) continue;
    const p = makePlan({ ...planArgs, needKwh: want, slots: freeSlots(Math.min(n.readyAtMs, restBy), { pre: false }), readyAtMs: Math.min(n.readyAtMs, restBy), insufficient: 'stop' });
    parts.push({ title: n.title, readyAt: new Date(n.readyAtMs).toISOString(), plan: p });
    taken.push(...p.slots);
    left -= p.kwh;
  }
  // The rest in the cheapest free hours; before leaving there is only room for preMaxKwh.
  let restPlan = makePlan({ ...planArgs, needKwh: Math.max(0, left), slots: freeSlots(restBy), readyAtMs: restBy, insufficient: 'stop' });
  let rest = restPlan.slots;
  const preKwh = sumKwh(rest.filter((r) => Date.parse(r.start) < untilMs));
  if (preKwh > preLeft + 0.05) {
    const pre = makePlan({ ...planArgs, needKwh: preLeft, slots: freeSlots(untilMs, { post: false }), readyAtMs: untilMs, insufficient: 'stop' });
    taken.push(...pre.slots);
    const post = makePlan({ ...planArgs, needKwh: Math.max(0, left - pre.kwh), slots: freeSlots(restBy, { pre: false }), readyAtMs: restBy, insufficient: 'stop' });
    rest = [...pre.slots, ...post.slots];
    preLeft -= pre.kwh;
  }
  const restSlots = [...parts.flatMap((x) => x.plan.slots), ...rest].sort((x, y) => x.start.localeCompare(y.start));
  const all = [...must.slots, ...restSlots].sort((x, y) => x.start.localeCompare(y.start));
  const kwh = round3(sumKwh(all));
  const cost = round3(all.reduce((t, r) => t + r.cost, 0));
  const pvKwh = round3(all.reduce((t, r) => t + (r.pvKwh || 0), 0));
  const short = round3(Math.max(0, split.restKwh - sumKwh(restSlots)));
  return {
    ...must, slots: all, needKwh: round3(split.mustKwh + split.restKwh), kwh, cost, pvKwh, gridKwh: round3(kwh - pvKwh),
    avgPrice: kwh > 0 ? round3(cost / kwh) : null, compare: null,
    split: {
      mustKwh: split.mustKwh, restKwh: split.restKwh, preMaxKwh: split.preMaxKwh ?? null, energyAfterKwh: split.energyAfterKwh ?? null, fullKwh: split.fullKwh ?? null,
      tripKwh: split.tripKwh, reserveKwh: split.reserveKwh, title: split.title,
      backAt: new Date(split.backAtMs).toISOString(), restBy: new Date(restBy).toISOString(), restBySource: split.restBySource || null,
      mustSlots: must.slots, restSlots: restSlots.filter((r) => Date.parse(r.start) >= split.backAtMs), preSlots: restSlots.filter((r) => Date.parse(r.start) < untilMs),
      later: parts.map((x) => ({ title: x.title, readyAt: x.readyAt, kwh: x.plan.kwh })),
    },
    notes: [...(must.notes || []), ...(short > 0.05 ? [`${short.toFixed(1)} kWh of the rest finds no free hour below the price cap before it is needed again — it is left for later.`] : [])],
  };
}

// Pure: two plans as one (the buffer first, then the rest), totals added up.
function joinPlans(first, second) {
  if (!first || !first.slots.length) return second;
  const all = [...first.slots, ...second.slots].sort((x, y) => x.start.localeCompare(y.start));
  const kwh = round3(all.reduce((t, r) => t + r.kwh, 0));
  const cost = round3(all.reduce((t, r) => t + r.cost, 0));
  const pvKwh = round3(all.reduce((t, r) => t + (r.pvKwh || 0), 0));
  return {
    ...second, slots: all, kwh, cost, pvKwh, gridKwh: round3(kwh - pvKwh), avgPrice: kwh > 0 ? round3(cost / kwh) : null,
    needKwh: round3((second.needKwh || 0) + first.kwh), compare: second.compare && first.kwh ? null : second.compare,
    notes: [...(first.notes || []), ...(second.notes || [])],
  };
}

// Pure: slots with the time a plan already uses taken out (what is left of a partly used interval stays).
function freeOf(slots, used) {
  const out = [];
  for (const s of slots) {
    let parts = [[Date.parse(s.start), Date.parse(s.end)]];
    for (const p of used) {
      const a = Date.parse(p.start); const b = Date.parse(p.end);
      parts = parts.flatMap(([x, y]) => (a >= y || b <= x ? [[x, y]] : [[x, Math.min(y, a)], [Math.max(x, b), y]].filter(([u, v]) => v - u >= 60000)));
    }
    for (const [x, y] of parts) out.push({ ...s, start: new Date(x).toISOString(), end: new Date(y).toISOString() });
  }
  out.priceGapFrom = slots.priceGapFrom;
  return out;
}

// Pure: the whole plan. In the smart plan the buffer comes first — at least bufferKwh within bufferH
// hours of plugging in (or of coming home), in the cheapest of those hours — then what the deadline
// needs and, around a trip, the rest after it is back (withRest).
function planWithBuffer({ args, slots, split = null, untilMs, startMs, bufferKwh = 0, bufferH = 3, bufferKm = 0 }) {
  const a0 = { ...args, nowMs: startMs };
  const smart = args.mode === 'plan';
  let buf = null;
  if (smart && bufferKwh > 0.3) {
    const by = Math.min(untilMs || Infinity, startMs + bufferH * 3600000);
    buf = makePlan({ ...a0, needKwh: bufferKwh, slots, readyAtMs: by, insufficient: 'stop' });
    if (!buf.slots.length) buf = null;
  }
  const bk = buf ? buf.kwh : 0;
  const rest = buf ? freeOf(slots, buf.slots) : slots;
  let plan;
  if (split && smart) {
    const extra = Math.max(0, bk - split.mustKwh); // buffer above the trip's own need stays in the battery
    const s2 = { ...split, mustKwh: round3(Math.max(0, split.mustKwh - bk)), restKwh: round3(Math.max(0, split.restKwh - extra)), preMaxKwh: round3(Math.max(0, (split.preMaxKwh ?? Infinity) - extra)) };
    const must = makePlan({ ...a0, needKwh: s2.mustKwh, slots: rest });
    plan = withRest(must, { ...a0, slots: rest }, rest, s2, untilMs);
    plan.split = { ...plan.split, mustKwh: split.mustKwh, restKwh: split.restKwh, preMaxKwh: split.preMaxKwh ?? null, mustSlots: [...(buf ? buf.slots.filter((x) => Date.parse(x.start) < untilMs) : []), ...plan.split.mustSlots].sort((x, y) => x.start.localeCompare(y.start)) };
    if (buf) plan = { ...joinPlans(buf, plan), split: plan.split };
  } else {
    plan = makePlan({ ...a0, needKwh: Math.max(0, (args.needKwh || 0) - bk), slots: rest });
    if (buf) plan = joinPlans(buf, plan);
  }
  plan.buffer = buf ? { kwh: buf.kwh, km: bufferKm, by: new Date(Math.min(untilMs || Infinity, startMs + bufferH * 3600000)).toISOString(), slots: buf.slots } : null;
  return plan;
}

function planSummary(p) {
  if (!p) return null;
  return { slots: p.slots, kwh: p.kwh, cost: p.cost, avgPrice: p.avgPrice, pvKwh: p.pvKwh };
}

// Price + expected solar surplus per interval from now to the deadline (or 36 h).
async function buildSlots(nowMs, untilMs) {
  const prices = require('./prices');
  const solar = require('./solarForecast');
  const learning = require('./learning');
  const { displayTz } = require('./localTime');
  const tz = displayTz();
  const fromIso = new Date(Math.floor(nowMs / 900000) * 900000).toISOString();
  const toIso = new Date(untilMs).toISOString();
  const rows = await prices.getPrices(fromIso, toIso);
  const pv = await solar.forecastBetween(new Date(Math.floor(nowMs / 3600000) * 3600000).toISOString(), toIso);
  const house = await learning.learnedHouse();
  // learned from the planner's own forecast errors (forecastLog.js): house kWh scaled with what it really used
  const corr = await require('./forecastLog').corrections(nowMs).catch(() => ({ houseFactor: 1 }));
  // and with the weather: a cold day uses more when the house's use follows the temperature (temperature.js)
  if (!rt.houseWeather || nowMs - rt.houseWeather.at > 3600000) {
    const T = require('./temperature');
    rt.houseWeather = { at: nowMs, model: await T.houseModel(nowMs).catch(() => null), means: await T.forecastMeans(nowMs).catch(() => new Map()) };
  }
  const { localParts } = require('./localTime');
  const dayOf = (ms) => { const p = localParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
  const types = await require('./dayType').typesBetween(nowMs, untilMs).catch(() => new Map());
  const weatherFactor = (ms) => require('./temperature').dayFactor(rt.houseWeather.model, rt.houseWeather.means.get(dayOf(ms)) ?? null, { min: 0.6, max: 1.8 });
  const slots = [];
  const covered = rows.length ? Date.parse(rows[rows.length - 1].end_at) : nowMs;
  const pushSlot = (s, e, price) => {
    const hour = new Date(Math.floor(s / 3600000) * 3600000).toISOString();
    const pvKwh = pv.get(hour) || 0;
    // houseRaw: the learned profile with the weather (what the error correction is learned on)
    const houseRaw = round3((learning.expectedHouseKwh(house, s, { tz, dayType: types.get(dayOf(s))?.type || null }) ?? 0.4) * weatherFactor(s));
    const houseKwh = round3(houseRaw * (corr.houseFactor || 1));
    slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), price, pvKw: round3(Math.max(0, pvKwh - houseKwh)), pvKwh, houseKwh, houseRaw });
  };
  for (const r of rows) pushSlot(Date.parse(r.start_at), Date.parse(r.end_at), r.allin_eur_kwh);
  // Hours without a price (beyond the known prices — tomorrow's come out around 13:00 — or a gap,
  // e.g. today's missing): slots without a price, so the chart and the plan still start now.
  const spans = rows.map((r) => [Date.parse(r.start_at), Date.parse(r.end_at)]);
  let missing = null;
  for (let t = Math.floor(nowMs / 3600000) * 3600000; t < untilMs; t += 3600000) {
    const e = t + 3600000;
    if (spans.some(([a, b]) => a < e && b > t)) continue;
    pushSlot(t, e, null);
    if (t < covered && missing === null) missing = t;
  }
  slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  slots.priceGapFrom = missing;
  return slots;
}

async function recalc(nowMs = Date.now(), { force = false } = {}) {
  const cfg = await getConfig();
  const wb = await wallboxLive();
  const target = await computeTarget(nowMs, wb);
  const until = target.readyAtMs || nowMs + 24 * 3600000;
  const split = target.split || null;
  const horizon = split ? Math.max(until, split.backAtMs + 24 * 3600000) : until;
  let slots = await buildSlots(nowMs, Math.max(horizon, nowMs + 3600000));
  if (slots.priceGapFrom !== null && slots.priceGapFrom !== undefined && nowMs - (rt.gapRefreshAt || 0) > 30 * 60000) {
    rt.gapRefreshAt = nowMs;
    const ok = await require('./prices').refreshPrices(nowMs).then(() => true).catch(() => false);
    if (ok) slots = await buildSlots(nowMs, Math.max(horizon, nowMs + 3600000));
  }
  const priceGapFrom = slots.priceGapFrom ?? null;
  // write down what is expected, and fill in what really happened (how good the predictions are)
  const flog = require('./forecastLog');
  flog.recordSlots(slots.map((x) => ({ ...x, houseKwh: x.houseRaw ?? x.houseKwh })), nowMs).catch(() => {});
  flog.fillActuals(nowMs).catch(() => {});
  if (!rt.prunedAt || nowMs - rt.prunedAt > 86400000) { rt.prunedAt = nowMs; flog.prune(nowMs).catch(() => {}); }
  const vehicle = target.vehicle;
  let priceCap = cfg.max_price_eur_kwh ? Number(cfg.max_price_eur_kwh) : null;
  let fuel = null;
  if (vehicle?.type === 'phev') {
    const fuelPrice = await require('./fuelPrice').currentFuelPrice();
    fuel = fuelBreakEven({ fuelEurL: fuelPrice?.eur_l ?? cfg.fuel_eur_l, lPer100km: vehicle.fuel_l_per_100km || 6.5, kwhPerKm: require('./driving').effectiveKwhPerKm(vehicle, cfg.default_kwh_per_km) });
    if (fuel !== null) priceCap = priceCap === null ? fuel : Math.min(priceCap, fuel);
  }
  const planArgs = {
    nowMs, readyAtMs: target.readyAtMs, needKwh: split ? split.mustKwh : target.needKwh, slots, mode: rt.override || cfg.mode,
    minKw: cfg.min_kw, maxKw: cfg.max_kw, solarTrust: cfg.solar_trust, priceCap,
    insufficient: vehicle?.type === 'phev' ? 'stop' : cfg.insufficient, feedIn: cfg.feed_in, feedInEur: cfg.feed_in_eur_kwh,
    earlyValue: Math.max(0, Number(cfg.early_value_eur) || 0),
  };
  // The car is out: plan from the moment it is expected home; what it would do if it came home (or
  // another car were plugged in) right now is kept next to it. Plugging in always re-plans from now.
  const arrival = await expectedArrival(nowMs, target, until).catch(() => null);
  const plan = planWithBuffer({ args: planArgs, slots, split: arrival ? null : split, untilMs: until, startMs: arrival ? arrival.at : nowMs, bufferKwh: target.bufferKwh, bufferH: Number(cfg.buffer_h) || 3, bufferKm: target.bufferKm });
  if (arrival) {
    // the expected homecoming, kept to compare with when it really plugs in (made at least 30 min before)
    if (arrival.at - nowMs >= 30 * 60000) rt.arrivalPred = { at: arrival.at, source: arrival.source };
    plan.arrival = { at: new Date(arrival.at).toISOString(), source: arrival.source, label: arrival.label, confidence: arrival.confidence };
    plan.ifNow = planSummary(planWithBuffer({ args: planArgs, slots, split: null, untilMs: until, startMs: nowMs, bufferKwh: target.bufferKwh, bufferH: Number(cfg.buffer_h) || 3, bufferKm: target.bufferKm }));
  }
  plan.target = { ...target, vehicle: vehicle ? { id: vehicle.id, name: vehicle.name, type: vehicle.type } : null, reading: undefined, drive: undefined };
  plan.fuelBreakEven = fuel;
  plan.priceCap = priceCap;
  plan.slotsAll = slots;
  plan.chartPrices = slots.length ? await require('./prices').chartQuarters(slots[0].start, slots[slots.length - 1].end).catch(() => null) : null;
  plan.priceGapFrom = priceGapFrom === null ? null : new Date(priceGapFrom).toISOString();
  plan.madeAt = new Date(nowMs).toISOString();
  rt.plan = plan;
  rt.planAt = nowMs;
  return plan;
}

async function writeOutput(cfg, kw, nowMs) {
  if (cfg.output !== 'live' || !cfg.vi_setpoint) return { written: false };
  const same = rt.lastWrite.kw === kw;
  if (same && nowMs - rt.lastWrite.at < 5 * 60 * 1000) return { written: false };
  const { sendHttpVirtualInput } = require('./loxone');
  const ms = await outputMiniserver(cfg);
  if (!ms) return { written: false, error: 'No Miniserver.' };
  const chargeLog = require('./chargeLog');
  try {
    await sendHttpVirtualInput(ms, cfg.vi_setpoint, String(kw));
    if (cfg.vi_enable) await sendHttpVirtualInput(ms, cfg.vi_enable, kw > 0 ? '1' : '0');
  } catch (err) {
    if (!same) chargeLog.recordSent({ kw, enable: cfg.vi_enable ? (kw > 0 ? 1 : 0) : null, source: 'live', ok: false, error: err.message }).catch(() => {});
    throw err;
  }
  if (!same) chargeLog.recordSent({ kw, enable: cfg.vi_enable ? (kw > 0 ? 1 : 0) : null, source: 'live', miniserver: ms.name }).catch(() => {});
  rt.lastWrite = { kw, at: nowMs };
  if (!same) {
    const { logSystemEvent } = require('./auditLog');
    logSystemEvent(`Planner: charging power set to ${kw} kW`).catch(() => {});
  }
  return { written: true };
}

// The Miniserver that holds the virtual inputs (in a gateway/client project: the one LoxSuite talks
// to; the Wallbox block itself may sit on a client). Default: the first Miniserver.
async function outputMiniserver(cfg) {
  const db = require('./db');
  if (cfg.vi_miniserver_id) {
    const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(cfg.vi_miniserver_id));
    if (ms) return ms;
  }
  return db.prepare('SELECT * FROM miniservers ORDER BY id LIMIT 1').get();
}

// Is the battery full in this plug-in session? Full stays full until the car is unplugged: the car
// stopped taking power while we asked for it, it reports a full battery (a reading from after the
// plug-in), or its own charging state says so. Pure, for tests.
function sessionFull({ sessionKey, fullKey = null, done = false, reading = null, readingAt = null, connectAt = null, limitPct = 100, chargeState = null }) {
  if (!sessionKey || sessionKey === 'none') return false;
  if (fullKey && fullKey === sessionKey) return true;
  if (done) return true;
  if (reading && reading.soc !== null && reading.soc !== undefined && readingAt && connectAt && readingAt >= connectAt && reading.soc >= limitPct - 1) return true;
  if (chargeState && /complete|completed|finished|fully|charged|full|vol/i.test(String(chargeState)) && !/not|un/i.test(String(chargeState))) return true;
  return false;
}

async function tick(nowMs = Date.now()) {
  const cfg = await getConfig();
  if (rt.readyLoaded !== true) {
    rt.readyLoaded = true;
    const saved = await settings.get('planner_ready_override', null).catch(() => null);
    if (saved?.at > nowMs) { rt.readyOverride = saved.at; rt.readyOverrideAway = !!saved.away; rt.readyOverrideOwn = saved.own || null; }
  }
  const wb = await wallboxLive();
  const energy = require('./energyMeters');
  const live = await energy.live().catch(() => ({ roles: {}, house_kw: null }));
  const connected = !!wb?.connected;
  // New session / unplug resets per-session choices.
  const key = connected ? String(wb.connectAt || 'c') : 'none';
  if (rt.session !== key) {
    try { require('./vehicles').notifyWallbox(connected); } catch { /* vehicles not loaded */ }
    // how good were the predictions: unplugged vs the deadline it had to be ready by; plugged in vs the
    // expected homecoming
    if (rt.session !== null) {
      const flog = require('./forecastLog');
      if (!connected && rt.session !== 'none' && rt.plan?.target?.readyAtMs && Math.abs(rt.plan.target.readyAtMs - nowMs) <= 3 * 3600000) {
        flog.recordEvent('depart', rt.plan.target.readyAtMs, nowMs, rt.plan.target.readySource || null).then(() => flog.resetCache()).catch(() => {});
      }
      if (connected && rt.arrivalPred) {
        flog.recordEvent('arrive', rt.arrivalPred.at, nowMs, rt.arrivalPred.source || null).catch(() => {});
        rt.arrivalPred = null;
      }
    }
    // A "ready by" set while the car was out is meant for when it comes back: kept for that session.
    // (Right after a start of LoxSuite the stored one is kept as it was.)
    const first = rt.session === null;
    const keepReady = !!rt.readyOverride && rt.readyOverride > nowMs && (first || rt.readyOverrideAway);
    rt.session = key; rt.override = null; rt.readyOverride = keepReady ? rt.readyOverride : null;
    rt.readyOverrideAway = keepReady && !connected;
    if (!keepReady) rt.readyOverrideOwn = null;
    if (!first) settings.set('planner_ready_override', keepReady ? { at: rt.readyOverride, away: rt.readyOverrideAway, own: rt.readyOverrideOwn } : null).catch(() => {}); rt.doneSince = null; rt.lowDrawSince = null; rt.ctrl.state = {}; rt.sessionVehicle = null; rt.onSince = null; rt.offSince = null; rt.socBase = null;
    rt.planAt = 0;
  }
  // The car that is out set off or parked: re-plan now, so "expected home" follows the drive.
  if (!connected && rt.plan?.target?.vehicle?.id) {
    try {
      const veh = await require('./db').prepare('SELECT * FROM vehicles WHERE id = ?').get(rt.plan.target.vehicle.id);
      const st = veh ? require('./vehicles').getVehicleStatus(veh) : null;
      const srcAt = st?.sourceUpdatedAt ? Date.parse(st.sourceUpdatedAt) : null;
      if (st?.reading && require('./carEta').observe(veh.id, st.reading, nowMs, Number.isFinite(srcAt) ? srcAt : null)) rt.planAt = 0;
    } catch { /* no vehicle data */ }
  }
  if (!rt.plan || nowMs - rt.planAt > 15 * 60 * 1000) await recalc(nowMs).catch((err) => { rt.status = { error: err.message }; });
  // "Done": we asked for power but the car took (almost) none for 5 minutes -> it is full.
  const asked = rt.lastSet || 0;
  if (connected && asked > 0 && (wb.kw || 0) < 0.3) { if (!rt.lowDrawSince) rt.lowDrawSince = nowMs; } else rt.lowDrawSince = null;
  if (rt.lowDrawSince && nowMs - rt.lowDrawSince > 5 * 60 * 1000) rt.doneSince = rt.doneSince || nowMs;
  // Full and still plugged in (also after a LoxSuite restart: remembered per Wallbox session).
  if (rt.fullKey === undefined) rt.fullKey = (await settings.get('wallbox_full_session', null))?.key ?? null;
  let full = false;
  if (connected) {
    const vehicle = rt.plan?.target?.vehicle ? await require('./db').prepare('SELECT * FROM vehicles WHERE id = ?').get(rt.plan.target.vehicle.id).catch(() => null) : null;
    const st = vehicle ? require('./vehicles').getVehicleStatus(vehicle) : null;
    full = sessionFull({
      sessionKey: key, fullKey: rt.fullKey, done: !!rt.doneSince, reading: st?.reading || null,
      readingAt: st?.sourceUpdatedAt ? Date.parse(st.sourceUpdatedAt) : null, connectAt: wb.connectAt || null,
      limitPct: st?.reading?.limit_soc ?? vehicle?.charge_limit_pct ?? 100, chargeState: st?.raw?.charging ?? null,
    });
    if (full && rt.fullKey !== key) { rt.fullKey = key; rt.planAt = 0; await settings.set('wallbox_full_session', { key, at: new Date(nowMs).toISOString() }).catch(() => {}); }
  }
  rt.full = full;
  const gridKw = live.roles?.grid?.power_kw ?? null;
  const step = controlStep({
    nowMs, mode: cfg.mode, cfg, plan: rt.plan, override: rt.override, done: !!rt.doneSince, state: rt.ctrl.state,
    live: { connected, gridKw, wallboxKw: wb?.kw ?? 0, houseKw: live.house_kw },
  });
  rt.ctrl.state = step.state;
  const effMode0 = rt.override || cfg.mode;
  if (full && connected && effMode0 !== 'off' && effMode0 !== 'now') {
    const hold = cfg.full_hold === 'off' ? 0 : Number(cfg.min_kw) || 4.16;
    step.kw = hold;
    step.reason = hold
      ? `Battery full and still plugged in: the Wallbox stays open at ${hold} kW so the car tops itself up (e.g. pre-heating from the grid) — no starting and stopping.`
      : 'Battery full and still plugged in: nothing to charge until it is unplugged.';
  }
  // No flapping: once on, keep going for min_on_s; once off, wait min_off_s before starting again —
  // unless the car is gone, the target is reached, or the mode says off/now.
  const effMode = rt.override || cfg.mode;
  const prevKw = rt.lastSet || 0;
  if (connected && !rt.doneSince && effMode !== 'off' && effMode !== 'now') {
    if (prevKw > 0 && step.kw === 0 && rt.onSince && nowMs - rt.onSince < (Number(cfg.min_on_s) || 0) * 1000) {
      step.kw = prevKw; step.reason = `${step.reason} Keeps charging for at least ${Math.round((Number(cfg.min_on_s) || 0) / 60)} min (no on/off flapping).`;
    } else if (prevKw === 0 && step.kw > 0 && rt.offSince && nowMs - rt.offSince < (Number(cfg.min_off_s) || 0) * 1000) {
      step.reason = `${step.reason} Waits ${Math.ceil(((Number(cfg.min_off_s) || 0) * 1000 - (nowMs - rt.offSince)) / 1000)} s before starting again (no on/off flapping).`; step.kw = 0;
    }
  }
  if (step.kw > 0 && prevKw === 0) rt.onSince = nowMs;
  if (step.kw === 0 && prevKw > 0) rt.offSince = nowMs;
  rt.lastSet = step.kw;
  let out = { written: false };
  try { out = await writeOutput(cfg, step.kw, nowMs); } catch (err) { out = { written: false, error: err.message }; }
  rt.status = {
    at: new Date(nowMs).toISOString(), connected, wallbox: wb ? { name: wb.name, kw: wb.kw, sessionKwh: wb.sessionKwh, connectAt: wb.connectAt } : null,
    setpointKw: step.kw, reason: step.reason, surplusKw: step.surplus ?? null, output: cfg.output, outputResult: out,
    mode: rt.override || cfg.mode, override: rt.override, done: !!rt.doneSince,
  };
  publishStatus(rt.status);
  return rt.status;
}

function publishStatus(s) {
  let mqttClient;
  try { mqttClient = require('./mqttClient'); } catch { return; }
  const client = mqttClient.getClient();
  if (!client || !mqttClient.state?.connected) return;
  const pub = (t, v) => client.publish(`loxsuite/planner/${t}`, String(v), { qos: 0, retain: true });
  pub('setpoint_kw', s.setpointKw);
  pub('mode', s.mode);
  if (rt.plan) { pub('need_kwh', rt.plan.needKwh); pub('ready_at', rt.plan.readyAt || ''); pub('plan_cost_eur', rt.plan.cost); }
}

// Buttons on the page: 'now' / 'off' (pause) / null (back to the configured mode) for this session.
function setOverride(mode) {
  rt.override = MODES.includes(mode) ? mode : null;
  rt.planAt = 0;
}
// "Ready by" set by hand: for this session, or — set while the car is out — for when it comes back.
// Stored, so an update or restart of LoxSuite doesn't forget it.
// own: how far / how much ("120 km", "30 kWh", "full"), optional.
function setReadyOverride(ms, own = null) {
  rt.readyOverride = ms || null;
  rt.readyOverrideOwn = ms && own ? String(own).slice(0, 60) : null;
  rt.readyOverrideAway = !!ms && (!rt.session || rt.session === 'none');
  rt.planAt = 0;
  settings.set('planner_ready_override', ms ? { at: ms, away: rt.readyOverrideAway, own: rt.readyOverrideOwn } : null).catch(() => {});
}
function setSessionVehicle(id) { rt.sessionVehicle = Number(id) || null; rt.planAt = 0; }
function houseWeather() { return rt.houseWeather || null; }
function getRuntime() { return { plan: rt.plan, status: rt.status, override: rt.override, readyOverride: rt.readyOverride, readyOverrideAway: !!rt.readyOverrideAway, readyOverrideOwn: rt.readyOverrideOwn || null }; }

let timer = null;
function startPlanner() {
  if (timer) return;
  const run = () => tick().catch((err) => { rt.status = { error: err.message, at: new Date().toISOString() }; });
  timer = setInterval(run, 30000);
  timer.unref?.();
  setTimeout(run, 50000).unref?.();
}

function stopPlanner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  MODES, DEFAULTS, makePlan, withRest, planSplit, sameTrip, mergeTrips, planWithBuffer, joinPlans, freeOf, fuelBreakEven, activeSlot, controlStep,
  houseWeather, getConfig, saveConfig, recalc, tick, outputMiniserver, sessionFull, setOverride, setReadyOverride, setSessionVehicle, primaryVehicle, getRuntime, startPlanner, stopPlanner, buildSlots, computeTarget, wallboxLive,
};
