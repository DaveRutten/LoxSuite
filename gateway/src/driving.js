// Wallbox > Driving: what the car's own readings (vehicle_readings: odometer + state of charge) say
// about how it is driven, and what that costs.
//
//   - Trips: runs of readings in which the odometer moves, separated by a parked spell.
//   - Electric consumption (kWh/100 km), learned from the drop in state of charge per km driven over
//     stretches where the battery did NOT run empty and wasn't charged in between. It replaces the
//     manual/default kWh per km in the planner, agenda and reminders unless one is set by hand.
//   - For a plug-in hybrid: km on electricity vs. km on fuel. Electric km of a stretch = energy taken
//     from the battery / kWh per km (capped at the km driven); the rest was driven on fuel. The level
//     at which the hybrid switches to fuel ("empty") is learned from the lowest SoC it reaches.
//   - Costs: € per kWh charged (from the Wallbox and grid meters per hour: grid part at the all-in
//     price of that hour, solar part at its feed-in value — the same valuation as the planner), €/km
//     electric vs. €/km on fuel (l/100 km x fuel price), and what driving electric saved.
// Pure functions first (tested in test/driving.test.js), DB loaders below.
const db = require('./db');

const MIN_KM_SAMPLE = 3;          // a stretch shorter than this says little about consumption
const PARK_BREAK_MS = 15 * 60000; // parked at least this long = the trip ended
const MAX_STEP_KM = 1500;         // odometer jumps larger than this are glitches
const KPK_MIN = 0.08;
const KPK_MAX = 0.6;

const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function confidence(km, n) {
  if (km >= 300 && n >= 8) return 'high';
  if (km >= 100 && n >= 4) return 'medium';
  if (km >= 20 && n >= 1) return 'low';
  return 'none';
}

// readings: [{ ts (ISO) | t (ms), soc, odometer_km, charging, plugged }] in any order.
function normalize(readings) {
  return (readings || [])
    .map((r) => ({
      t: r.t ?? Date.parse(r.ts),
      soc: r.soc === null || r.soc === undefined || r.soc === '' ? null : Number(r.soc),
      odo: r.odometer_km === null || r.odometer_km === undefined || r.odometer_km === '' ? null : Number(r.odometer_km),
      charging: r.charging === 1 || r.charging === true,
    }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}

// SoC at which a plug-in hybrid has switched to fuel: the lowest level it is seen at (a hybrid keeps a
// small buffer it never shows below). Only meaningful when the car regularly gets that low; a car that
// never gets below 25 % never ran empty, so then 0. A full-electric car never switches: always 0.
function emptyLevel(points, type) {
  if (type !== 'phev') return 0;
  const socs = points.map((p) => p.soc).filter((x) => x !== null && Number.isFinite(x));
  if (!socs.length) return 0;
  const min = Math.min(...socs);
  return min <= 25 ? min : 0;
}

// The core analysis. opts: { capacityKwh, type ('bev'|'phev'), kwhPerKm (fallback when nothing
// learned yet), monthOf (ms -> 'YYYY-MM') }
function analyze(readings, { capacityKwh = null, type = 'bev', kwhPerKm = 0.2, monthOf = (t) => new Date(t).toISOString().slice(0, 7) } = {}) {
  const all = normalize(readings);
  const empty = emptyLevel(all, type);
  const cap = Number(capacityKwh) > 0 ? Number(capacityKwh) : null;

  // Odometer points; any charging seen between two of them marks the stretch as charged.
  const pts = [];
  let chargedSince = false;
  for (const r of all) {
    if (r.charging) chargedSince = true;
    if (r.odo === null || !Number.isFinite(r.odo)) continue;
    pts.push({ ...r, chargedBefore: chargedSince });
    chargedSince = false;
  }

  // Stretches between consecutive odometer points.
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const km = b.odo - a.odo;
    if (!(km >= 0) || km > MAX_STEP_KM) continue;
    const socKnown = a.soc !== null && b.soc !== null;
    const rise = socKnown ? b.soc - a.soc : 0;
    const charged = b.chargedBefore || a.charging || rise > 2;
    const drop = socKnown && !charged ? Math.max(0, a.soc - b.soc) : null;
    segs.push({
      from: a.t, to: b.t, km, moving: km >= 0.5, socFrom: a.soc, socTo: b.soc, charged,
      kwh: drop !== null && cap ? (drop / 100) * cap : null,
      // Whole stretch on electricity when the battery still had charge at its end.
      allElectric: type !== 'phev' || (b.soc !== null && b.soc > empty + 3),
    });
  }

  // Learned consumption: stretches long enough, all-electric, not charged, with a real SoC drop.
  const samples = segs.filter((s) => s.moving && s.km >= MIN_KM_SAMPLE && !s.charged && s.kwh > 0 && s.allElectric)
    .map((s) => ({ ...s, ratio: s.kwh / s.km }))
    .filter((s) => s.ratio >= KPK_MIN && s.ratio <= KPK_MAX);
  const med = median(samples.map((s) => s.ratio));
  const kept = med === null ? [] : samples.filter((s) => s.ratio >= med * 0.4 && s.ratio <= med * 1.8);
  const keptKm = kept.reduce((a, s) => a + s.km, 0);
  const learned = keptKm > 0 ? kept.reduce((a, s) => a + s.kwh, 0) / keptKm : null;
  const conf = confidence(keptKm, kept.length);
  const kpk = learned && conf !== 'none' ? learned : kwhPerKm;

  // Electric vs. fuel km per stretch.
  for (const s of segs) {
    if (!s.moving) { s.elecKm = 0; s.fuelKm = 0; s.unknownKm = 0; continue; }
    if (type !== 'phev' || s.allElectric) { s.elecKm = s.km; s.fuelKm = 0; s.unknownKm = 0; }
    else if (s.kwh !== null && kpk > 0) { s.elecKm = Math.min(s.km, s.kwh / kpk); s.fuelKm = s.km - s.elecKm; s.unknownKm = 0; }
    else { s.elecKm = 0; s.fuelKm = 0; s.unknownKm = s.km; }
  }

  // Trips: consecutive moving stretches; a parked stretch of PARK_BREAK_MS or more ends a trip.
  const trips = [];
  let cur = null;
  for (const s of segs) {
    if (s.moving) {
      if (!cur) cur = { start: s.from, end: s.to, km: 0, elecKm: 0, fuelKm: 0, unknownKm: 0, kwh: 0, kwhKnown: true, socFrom: s.socFrom, socTo: s.socTo };
      cur.end = s.to; cur.km += s.km; cur.elecKm += s.elecKm; cur.fuelKm += s.fuelKm; cur.unknownKm += s.unknownKm; cur.socTo = s.socTo;
      if (s.kwh === null) cur.kwhKnown = false; else cur.kwh += s.kwh;
    } else if (cur && s.to - s.from >= PARK_BREAK_MS) {
      trips.push(cur); cur = null;
    }
  }
  if (cur) trips.push(cur);
  for (const t of trips) {
    const ratio = t.kwhKnown && t.km >= MIN_KM_SAMPLE && t.fuelKm < 0.05 ? t.kwh / t.km : null;
    // Outside a plausible range = readings missing in between (source offline, a charge not seen).
    t.kwhPer100 = ratio !== null && ratio >= KPK_MIN && ratio <= KPK_MAX ? r1(ratio * 100) : null;
    t.km = r1(t.km); t.elecKm = r1(t.elecKm); t.fuelKm = r1(t.fuelKm); t.unknownKm = r1(t.unknownKm);
    t.kwh = t.kwhKnown ? r1(t.kwh) : null;
    t.minutes = Math.round((t.end - t.start) / 60000);
  }

  // Per month.
  const months = new Map();
  const month = (t) => {
    const k = monthOf(t);
    if (!months.has(k)) months.set(k, { month: k, km: 0, elecKm: 0, fuelKm: 0, unknownKm: 0, trips: 0, longestKm: 0, sKwh: 0, sKm: 0 });
    return months.get(k);
  };
  for (const s of segs) {
    if (!s.moving) continue;
    const m = month(s.to);
    m.km += s.km; m.elecKm += s.elecKm; m.fuelKm += s.fuelKm; m.unknownKm += s.unknownKm;
  }
  for (const s of kept) { const m = month(s.to); m.sKwh += s.kwh; m.sKm += s.km; }
  for (const t of trips) { const m = month(t.end); m.trips++; m.longestKm = Math.max(m.longestKm, t.km); }
  const byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    month: m.month, km: r1(m.km), elecKm: r1(m.elecKm), fuelKm: r1(m.fuelKm), unknownKm: r1(m.unknownKm),
    elecShare: m.km > 0 && m.unknownKm < m.km ? Math.round((m.elecKm / (m.km - m.unknownKm)) * 100) : null,
    trips: m.trips, avgTripKm: m.trips ? r1(m.km / m.trips) : null, longestKm: r1(m.longestKm),
    kwhPer100: m.sKm >= 20 ? r1((m.sKwh / m.sKm) * 100) : null,
  }));

  return {
    emptyLevel: empty,
    hasOdometer: pts.length > 0,
    hasSoc: all.some((r) => r.soc !== null),
    consumption: { kwhPerKm: r3(learned), kwhPer100: learned ? r1(learned * 100) : null, km: r1(keptKm), samples: kept.length, confidence: conf },
    kwhPerKmUsed: r3(kpk),
    trips,
    byMonth,
  };
}

// Driving per weekday, learned from the odometer trips: on how many of each weekday the car is
// driven, how far (median km on a driven day), and when it usually leaves (first trip) and is back
// (end of the last trip). Used by the planner: the km still to come today while the car is out, and
// the time it is expected home. Only the last `days` days count, so it follows changes in routine.
function weekPattern(trips, { tz, nowMs = Date.now(), days = 56, firstMs = null } = {}) {
  const { localParts, localMidnight, WEEKDAYS } = require('./localTime');
  const fromMs = Math.max(nowMs - days * 86400000, firstMs ?? (trips.length ? Math.min(...trips.map((t) => t.start)) : nowMs));
  const todayMs = localMidnight(nowMs, tz); // today isn't over yet: not part of the pattern
  const byDay = new Map();
  for (const t of trips) {
    if (t.start < fromMs || t.start >= todayMs || !(t.km > 0)) continue;
    const p = localParts(t.start, tz);
    const key = `${p.y}-${p.m}-${p.d}`;
    const e = localParts(t.end, tz);
    const d = byDay.get(key) || { weekday: p.weekday, km: 0, first: null, last: null };
    d.km += t.km;
    const sMin = p.hour * 60 + p.minute;
    const eMin = (e.d !== p.d ? 24 * 60 - 1 : e.hour * 60 + e.minute);
    d.first = d.first === null ? sMin : Math.min(d.first, sMin);
    d.last = d.last === null ? eMin : Math.max(d.last, eMin);
    byDay.set(key, d);
  }
  const count = Array(7).fill(0);
  for (let t = localMidnight(fromMs, tz); t < todayMs; t = localMidnight(t, tz, 1)) count[localParts(t + 12 * 3600000, tz).weekday]++;
  const fmt = (m) => (m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
  return WEEKDAYS.map((key, wd) => {
    const list = [...byDay.values()].filter((d) => d.weekday === wd);
    const n = list.length;
    const share = count[wd] ? Math.min(1, n / count[wd]) : 0;
    const kms = list.map((d) => d.km);
    return {
      key, weekday: wd, days: count[wd], drivenDays: n, share: Math.round(share * 100) / 100,
      kmMedian: r1(median(kms)), kmAvg: count[wd] ? r1(kms.reduce((a, b) => a + b, 0) / count[wd]) : null,
      kmHigh: kms.length ? r1([...kms].sort((a, b) => a - b)[Math.min(kms.length - 1, Math.floor(kms.length * 0.75))]) : null,
      depart: fmt(median(list.map((d) => d.first))), back: fmt(median(list.map((d) => d.last))),
      usual: n >= 3 && share >= 0.4,
      confidence: n >= 8 ? 'high' : n >= 4 ? 'medium' : n > 0 ? 'low' : 'none',
    };
  });
}

// km driven since local midnight (trips that started today).
function kmToday(trips, { tz, nowMs = Date.now() } = {}) {
  const { localMidnight } = require('./localTime');
  const from = localMidnight(nowMs, tz);
  return r1(trips.filter((t) => t.start >= from && t.start <= nowMs).reduce((a, t) => a + (t.km || 0), 0));
}

// € per kWh that went into the car per month, from hourly meter data: the grid part of each hour at
// that hour's all-in price, the solar part at its feed-in value ('saldering' = the price of that hour,
// 'fixed' = feedInEur). hours: [{ hour, wallboxKwh, gridImportKwh, price }] (price may be null).
function chargingCost(hours, { feedIn = 'saldering', feedInEur = 0.05, monthOf = (t) => new Date(t).toISOString().slice(0, 7) } = {}) {
  const months = new Map();
  for (const h of hours || []) {
    const wb = Number(h.wallboxKwh) || 0;
    if (wb <= 0.01 || h.price === null || h.price === undefined) continue;
    const grid = Math.min(wb, Math.max(0, Number(h.gridImportKwh) || 0));
    const solar = wb - grid;
    const solarValue = feedIn === 'fixed' ? feedInEur : h.price;
    const k = monthOf(Date.parse(h.hour));
    const m = months.get(k) || { month: k, kwh: 0, solarKwh: 0, eur: 0 };
    m.kwh += wb; m.solarKwh += solar; m.eur += grid * h.price + solar * solarValue;
    months.set(k, m);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    month: m.month, kwh: r1(m.kwh), solarShare: m.kwh ? Math.round((m.solarKwh / m.kwh) * 100) : null,
    eur: Math.round(m.eur * 100) / 100, eurPerKwh: m.kwh ? r3(m.eur / m.kwh) : null,
  }));
}

// € per km on electricity and on fuel, and what the electric km saved compared with fuel.
function costPerKm({ eurPerKwh, kwhPerKm, fuelEurL, lPer100km }) {
  const elec = eurPerKwh !== null && eurPerKwh !== undefined && kwhPerKm ? eurPerKwh * kwhPerKm : null;
  const fuel = fuelEurL && lPer100km ? (fuelEurL * lPer100km) / 100 : null;
  return { elec: r3(elec), fuel: r3(fuel) };
}

// Consumption in kWh/km to plan with: set by hand > learned (enough data) > the planner default.
function effectiveKwhPerKm(vehicle, fallback = 0.2) {
  const own = Number(vehicle?.kwh_per_km);
  if (own > 0) return own;
  const learned = Number(vehicle?.kwh_per_km_learned);
  if (learned > 0) return learned;
  return fallback;
}

// --------------------------------------------------------------------------- DB

async function loadReadings(vehicleId, days = 400) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare('SELECT ts, soc, odometer_km, charging, plugged FROM vehicle_readings WHERE vehicle_id = ? AND ts >= ? ORDER BY ts')
    .all(vehicleId, from);
}

// Hourly Wallbox/grid energy with the price of that hour, limited to hours that belong to this car's
// sessions when there are several cars (a session without a known car counts for the only car).
async function loadChargeHours(vehicle, { days = 400, carCount = 1 } = {}) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await db.prepare("SELECT hour, role, import_kwh FROM energy_hourly WHERE hour >= ? AND role IN ('wallbox', 'grid')").all(from);
  const byHour = new Map();
  for (const r of rows) {
    const h = byHour.get(r.hour) || { hour: r.hour, wallboxKwh: 0, gridImportKwh: 0, price: null };
    if (r.role === 'wallbox') h.wallboxKwh = r.import_kwh || 0; else h.gridImportKwh = r.import_kwh || 0;
    byHour.set(r.hour, h);
  }
  const prices = await db.prepare('SELECT start_at, end_at, allin_eur_kwh FROM energy_prices WHERE start_at >= ? ORDER BY start_at')
    .all(new Date(Date.parse(from) - 86400000).toISOString());
  const pr = prices.map((p) => ({ s: Date.parse(p.start_at), e: Date.parse(p.end_at), v: p.allin_eur_kwh })).filter((p) => p.v !== null);
  const sessions = carCount > 1
    ? (await db.prepare('SELECT connect_at, disconnect_at, vehicle_id FROM charging_sessions WHERE connect_at >= ?').all(from))
      .map((s) => ({ s: Date.parse(s.connect_at), e: s.disconnect_at ? Date.parse(s.disconnect_at) : Date.now(), v: s.vehicle_id }))
    : null;
  const out = [];
  for (const h of byHour.values()) {
    if (!(h.wallboxKwh > 0.01)) continue;
    const t = Date.parse(h.hour);
    if (sessions) {
      const s = sessions.find((x) => x.s < t + 3600000 && x.e > t);
      if (!s || s.v !== vehicle.id) continue;
    }
    const inHour = pr.filter((p) => p.s < t + 3600000 && p.e > t);
    h.price = inHour.length ? inHour.reduce((a, p) => a + p.v, 0) / inHour.length : null;
    out.push(h);
  }
  return out.sort((a, b) => a.hour.localeCompare(b.hour));
}

function monthOfTz(tz) {
  const { localParts } = require('./localTime');
  return (t) => { const p = localParts(t, tz); return `${p.y}-${String(p.m).padStart(2, '0')}`; };
}

async function report(vehicle) {
  const { displayTz } = require('./localTime');
  const planner = require('./planner');
  const pcfg = await planner.getConfig();
  const monthOf = monthOfTz(displayTz());
  const readings = await loadReadings(vehicle.id);
  const a = analyze(readings, {
    capacityKwh: vehicle.battery_kwh, type: vehicle.type, monthOf,
    kwhPerKm: Number(vehicle.kwh_per_km) > 0 ? Number(vehicle.kwh_per_km) : pcfg.default_kwh_per_km,
  });
  // A consumption set by hand wins over the learned one for electric km and costs.
  const kpk = Number(vehicle.kwh_per_km) > 0 ? Number(vehicle.kwh_per_km) : a.kwhPerKmUsed;
  const carCount = (await db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE enabled = 1').get())?.n || 1;
  const cost = chargingCost(await loadChargeHours(vehicle, { carCount: Number(carCount) }), { feedIn: pcfg.feed_in, feedInEur: pcfg.feed_in_eur_kwh, monthOf });
  let fuelEurL = pcfg.fuel_eur_l;
  if (pcfg.fuel_auto) {
    const fp = await require('./fuelPrice').currentFuelPrice().catch(() => null);
    if (fp?.eur_l) fuelEurL = fp.eur_l;
  }
  const lPer100 = Number(vehicle.fuel_l_per_100km) > 0 ? Number(vehicle.fuel_l_per_100km) : (vehicle.type === 'phev' ? 6.5 : null);
  const costByMonth = new Map(cost.map((c) => [c.month, c]));
  const totalKwh = cost.reduce((s, c) => s + c.kwh, 0);
  const avgEurKwh = totalKwh > 0 ? cost.reduce((s, c) => s + c.eur, 0) / totalKwh : null;
  // Without hourly meter data: the average all-in price of the last 30 days as an estimate.
  let estEurKwh = null;
  if (avgEurKwh === null) {
    const row = await db.prepare('SELECT AVG(allin_eur_kwh) AS p FROM energy_prices WHERE start_at >= ?').get(new Date(Date.now() - 30 * 86400000).toISOString());
    estEurKwh = row?.p ? Number(row.p) : null;
  }
  const fuelPerKm = lPer100 ? (fuelEurL * lPer100) / 100 : null;
  // A full-electric car is compared with a petrol car of 6.5 l/100 km unless a fuel use is set.
  const compareFuelPerKm = fuelPerKm ?? (fuelEurL * 6.5) / 100;
  let savedTotal = 0;
  const months = a.byMonth.map((m) => {
    const c = costByMonth.get(m.month) || null;
    const eurKwh = c?.eurPerKwh ?? avgEurKwh ?? estEurKwh;
    const perKm = costPerKm({ eurPerKwh: eurKwh, kwhPerKm: m.kwhPer100 ? m.kwhPer100 / 100 : kpk, fuelEurL, lPer100km: lPer100 || 6.5 });
    const saved = perKm.elec !== null ? Math.round(m.elecKm * (compareFuelPerKm - perKm.elec) * 100) / 100 : null;
    if (saved !== null) savedTotal += saved;
    const fuelEur = lPer100 ? Math.round(m.fuelKm * fuelPerKm * 100) / 100 : null;
    return { ...m, chargedKwh: c?.kwh ?? null, solarShare: c?.solarShare ?? null, chargeEur: c?.eur ?? null, eurPerKwh: eurKwh !== null ? Math.round(eurKwh * 1000) / 1000 : null, eurPerKwhEstimated: !c, elecEurKm: perKm.elec, fuelEurKm: r3(compareFuelPerKm), fuelEur, saved };
  });
  return {
    vehicle: { id: vehicle.id, name: vehicle.name, type: vehicle.type, battery_kwh: vehicle.battery_kwh, kwh_per_km: vehicle.kwh_per_km, fuel_l_per_100km: lPer100, hasOdometerField: hasField(vehicle, 'odometer_km') || a.hasOdometer, hasSocField: hasField(vehicle, 'soc') || a.hasSoc },
    ...a, kwhPerKmUsed: kpk, months,
    prices: { fuelEurL, fuelPerKm: r3(compareFuelPerKm), avgEurKwh: avgEurKwh !== null ? r3(avgEurKwh) : null, estEurKwh: estEurKwh !== null ? r3(estEurKwh) : null, elecPerKm: r3((avgEurKwh ?? estEurKwh ?? 0) * kpk) || null },
    savedTotal: Math.round(savedTotal * 100) / 100,
    trips: a.trips.slice(-25).reverse(),
  };
}

// The weekday pattern + today's km of a car, from its stored readings (cached 30 min per car).
const patternCache = new Map();
async function drivePattern(vehicle, { nowMs = Date.now() } = {}) {
  if (!vehicle?.id) return null;
  const hit = patternCache.get(vehicle.id);
  if (hit && nowMs - hit.at < 30 * 60000) return hit.value;
  const { displayTz } = require('./localTime');
  const tz = displayTz();
  const readings = await loadReadings(vehicle.id, 60);
  const a = analyze(readings, { capacityKwh: vehicle.battery_kwh, type: vehicle.type });
  const value = a.hasOdometer ? {
    days: weekPattern(a.trips, { tz, nowMs, firstMs: readings.length ? Date.parse(readings[0].ts) : null }),
    kmToday: kmToday(a.trips, { tz, nowMs }),
    lastTripEnd: a.trips.length ? a.trips[a.trips.length - 1].end : null,
  } : null;
  patternCache.set(vehicle.id, { at: nowMs, value });
  return value;
}

// Is this value mapped from the car's data source? The Škoda API always gives odometer and battery %;
// Homey/Home Assistant map it in fields, MQTT in topics.
function hasField(vehicle, key) {
  try {
    const c = JSON.parse(vehicle.source_config || '{}');
    if (vehicle.source_type === 'http' && c.provider === 'skoda') return key === 'odometer_km' || key === 'soc';
    return !!(c.fields?.[key] || c.topics?.[key] || c[key]);
  } catch { return false; }
}

// Store the learned consumption on each car (used by the planner, agenda and reminders when no
// consumption is set by hand). Only once there is at least 'medium' confidence.
async function learnAll() {
  const list = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1').all();
  for (const v of list) {
    const a = analyze(await loadReadings(v.id), { capacityKwh: v.battery_kwh, type: v.type });
    const c = a.consumption;
    const value = c.kwhPerKm && (c.confidence === 'medium' || c.confidence === 'high') ? c.kwhPerKm : null;
    if (value !== (v.kwh_per_km_learned ?? null)) {
      await db.prepare('UPDATE vehicles SET kwh_per_km_learned = ?, kwh_per_km_learned_km = ? WHERE id = ?').run(value, value ? c.km : null, v.id);
    }
  }
}

let timer = null;
function startDriving() {
  if (timer) return;
  const run = () => learnAll().catch((err) => console.error(`[driving] ${err.message}`));
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 90 * 1000).unref?.();
}

function stopDriving() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { analyze, emptyLevel, weekPattern, kmToday, drivePattern, chargingCost, costPerKm, effectiveKwhPerKm, loadReadings, loadChargeHours, report, learnAll, startDriving, stopDriving };
