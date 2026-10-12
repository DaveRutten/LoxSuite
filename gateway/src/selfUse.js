// Own energy: how much of the solar power you use yourself (self-consumption), how much of what you
// use comes from your own panels (self-sufficiency), what went to the car and what to the house — and
// from the same hours, concrete suggestions to use more of it yourself.
//
// Everything comes from the hourly meter rows (energy_hourly, see energyMeters.js): grid import/export,
// solar, Wallbox, home battery and the derived house. Per hour:
//   self used = solar − export   (what never left the house, also into a home battery)
//   used      = import + self used + battery discharge − battery charge   (house + car)
// Texts are English templates with {params}; the page translates them (t() with an array).
const db = require('./db');
const { localParts, displayTz } = require('./localTime');
const { NET_METERING_ENDS_MS } = require('./solarValue');

const HOUR = 3600000;
const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const KWH_PER_KM = 0.18; // only to say what a kWh is in km of driving

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function quantile(arr, q) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * q + 0.5))];
}

// Pure. hours: [{ hour (ISO UTC), pv, imp, exp, wallbox, batIn, batOut }] (kWh), loads: [{ id, name,
// kind, hourly: { [hourIso]: kWh } }], prices: { [hourIso]: { allin, market } }.
// Options: localHourOf(ms) -> 0..23, dayOf(ms) -> 'YYYY-MM-DD', days (length of the period),
// hasBattery, hasCar, planner ({ mode }), nowMs. Suggestions: [{ key, t (template), p ({ name: value }), kwh, eur?, icon, link }].
function compute({ hours = [], loads = [], prices = {}, localHourOf, dayOf, days = 30, hasBattery = false, hasCar = false, planner = null, nowMs = Date.now() }) {
  const t = { pv: 0, self: 0, exp: 0, imp: 0, use: 0, car: 0, carSolar: 0, house: 0, houseSolar: 0 };
  const perDay = new Map();
  const expByHour = Array(24).fill(0);
  const surplusHours = new Set();      // hours with solar to spare (something went to the grid)
  let expNoCar = 0, expNoCarHours = 0, worth2027 = 0, worthKwh = 0;
  const night = [];                     // import in the small hours, for the base load
  for (const h of hours) {
    const ms = Date.parse(h.hour);
    const pv = Math.max(0, h.pv || 0), exp = Math.max(0, h.exp || 0), imp = Math.max(0, h.imp || 0);
    const car = Math.max(0, h.wallbox || 0), batIn = Math.max(0, h.batIn || 0), batOut = Math.max(0, h.batOut || 0);
    const self = Math.max(0, Math.min(pv, pv - exp));
    const use = Math.max(0, imp + self + batOut - batIn);
    const house = Math.max(0, use - car);
    // the own solar used in this hour, shared over the car and the house by what they used
    const carSolar = use > 0 ? Math.min(car, (self - Math.min(self, batIn)) * car / use) : 0;
    t.pv += pv; t.self += self; t.exp += exp; t.imp += imp; t.use += use; t.car += car; t.carSolar += carSolar;
    t.house += house; t.houseSolar += Math.max(0, self - Math.min(self, batIn) - carSolar);
    const day = dayOf(ms);
    const d = perDay.get(day) || { day, pv: 0, self: 0, exp: 0, imp: 0, use: 0, lastExpMs: null, impByMs: [] };
    d.pv += pv; d.self += self; d.exp += exp; d.imp += imp; d.use += use;
    if (exp > 0.05) d.lastExpMs = ms;
    d.impByMs.push([ms, imp]);
    perDay.set(day, d);
    const lh = localHourOf(ms);
    expByHour[lh] += exp;
    if (exp > 0.2) surplusHours.add(h.hour);
    if (exp > 0.2 && car < 0.1) { expNoCar += exp; expNoCarHours++; }
    if (lh >= 1 && lh < 5 && pv < 0.01) night.push(imp + batOut);
    const p = prices[h.hour];
    if (exp > 0 && p && Number.isFinite(p.allin) && Number.isFinite(p.market)) { worth2027 += exp * Math.max(0, p.allin - p.market); worthKwh += exp; }
  }
  const nDays = Math.max(1, perDay.size || days);
  const totals = {
    pvKwh: r1(t.pv), selfKwh: r1(t.self), exportKwh: r1(t.exp), importKwh: r1(t.imp), useKwh: r1(t.use),
    carKwh: r1(t.car), carSolarKwh: r1(t.carSolar), houseKwh: r1(t.house), houseSolarKwh: r1(t.houseSolar),
    selfRate: t.pv > 0.5 ? r2(t.self / t.pv) : null,               // of the solar, used yourself
    autarky: t.use > 0.5 ? r2(Math.min(1, Math.max(0, 1 - t.imp / t.use))) : null, // of what you used, from own solar
    carSolarRate: t.car > 0.5 ? r2(t.carSolar / t.car) : null,
    days: perDay.size,
  };
  const daysOut = [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, pv: r2(d.pv), self: r2(d.self), exp: r2(d.exp), imp: r2(d.imp), use: r2(d.use) }));

  // ---------------------------------------------------------------- suggestions
  const tips = [];
  const perYear = (kwh) => kwh * 365 / nDays;
  // the hours of the day with the most solar to spare: the block around the peak with at least half of it
  const avgExp = expByHour.map((x) => x / nDays);
  const peak = Math.max(...avgExp);
  let win = null;
  if (peak > 0.05) {
    const at = avgExp.indexOf(peak);
    let a = at, b = at;
    while (a > 0 && avgExp[a - 1] >= peak / 2) a--;
    while (b < 23 && avgExp[b + 1] >= peak / 2) b++;
    win = { from: a, to: b + 1 };
  }
  const winText = win ? `${String(win.from).padStart(2, '0')}:00–${String(win.to).padStart(2, '0')}:00` : null;

  // 1. the car: solar went to the grid while the car did not charge
  if (hasCar && expNoCar >= Math.max(3, 0.1 * t.exp)) {
    const solarMode = planner && ['pv', 'minpv'].includes(planner.mode);
    tips.push({
      key: 'car', kwh: r1(expNoCar), icon: 'car',
      t: solarMode
        ? 'In {h} hours {k} kWh went to the grid while the car was not charging (≈ {km} km of driving). Plug the car in on sunny days when it is home — Smart charging is already on solar.'
        : 'In {h} hours {k} kWh went to the grid while the car was not charging (≈ {km} km of driving). Plug the car in on sunny days and use the mode Solar or Min + Solar, or raise ‘prefer own solar’ in Smart charging.',
      p: { h: expNoCarHours, k: r1(expNoCar), km: Math.round(expNoCar / KWH_PER_KM) }, link: '/planner',
    });
  }
  // 2. appliances and tap water: how much of their use fell in the hours with solar to spare
  for (const l of loads) {
    if (!['appliance', 'dhw', 'heatpump'].includes(l.kind)) continue;
    let all = 0, sun = 0;
    for (const [hour, kwh] of Object.entries(l.hourly || {})) { all += kwh || 0; if (surplusHours.has(hour)) sun += kwh || 0; }
    if (all < 2 || !win) continue;
    const share = sun / all;
    if (share >= 0.6) continue;
    const movable = (all - sun) * (l.kind === 'heatpump' ? 0.3 : 0.6); // not everything can move to the day
    if (movable < 1) continue;
    tips.push({
      key: `load.${l.id}`, kwh: r1(movable), icon: l.kind === 'appliance' ? 'drop' : 'heat',
      t: l.kind === 'appliance'
        ? '{n} used {p}% of its power on own solar. Start it between {w} (when most goes to the grid) — or let the energy manager pick the start — and about {k} kWh more comes from your panels.'
        : '{n} used {p}% of its power on own solar. Heat it up between {w} — the energy manager can do that on solar surplus — and about {k} kWh more comes from your panels.',
      p: { n: l.name, p: Math.round(share * 100), w: winText, k: r1(movable) }, link: l.id ? `/energy-manager/loads/${l.id}` : '/energy-manager',
    });
  }
  // 3. a home battery: per day what was exported and imported again after the sun went
  if (!hasBattery) {
    const shift = [];
    for (const d of perDay.values()) {
      if (d.exp < 0.5 || d.lastExpMs === null) continue;
      const evening = d.impByMs.filter(([ms]) => ms > d.lastExpMs).reduce((a, [, k]) => a + k, 0);
      shift.push(Math.min(d.exp, evening));
    }
    const med = median(shift);
    const sum = shift.reduce((a, b) => a + b, 0);
    if (shift.length >= 5 && med >= 1.5) {
      const cap = Math.max(3, Math.ceil(quantile(shift, 0.75) / 0.9));
      tips.push({
        key: 'battery', kwh: r1(sum), icon: 'battery',
        t: 'On {d} of {n} days solar went to the grid in the day and power came back from the grid in the evening — usually {k} kWh a day. A home battery of about {c} kWh would have covered most of that (≈ {y} kWh a year).',
        p: { d: shift.length, n: nDays, k: r1(med), c: cap, y: Math.round(perYear(sum)) }, link: null,
      });
    }
  }
  // 4. the end of net metering: what the exported power is worth less from 2027
  if (nowMs < NET_METERING_ENDS_MS + 365 * DAY && worthKwh > 5 && worth2027 > 1) {
    const eurYear = perYear(worth2027);
    tips.push({
      key: 'netmetering', kwh: r1(t.exp), eur: Math.round(eurYear), icon: 'euro',
      t: 'Net metering ends on 1 January 2027: from then on your export earns the market price instead of what you pay. For your export that is about € {e} a year less — every kWh you use yourself instead is worth about € {d} more.',
      p: { e: Math.round(eurYear), d: r2(worth2027 / worthKwh).toFixed(2).replace('.', ',') }, link: '/settings/energy',
    });
  }
  // 5. the base load: what the house always uses (at night), never from the sun without a battery
  if (night.length >= 12) {
    const w = Math.round(median(night) * 1000);
    if (w >= 150) {
      tips.push({
        key: 'baseload', kwh: r1(w / 1000 * 24 * nDays * 0.1), icon: 'gauge',
        t: 'At night the house always uses about {w} W — {k} kWh a year, and at night that never comes from your panels. Look for devices that stay on (NAS, network, standby): every 10 W less is 88 kWh a year.',
        p: { w, k: Math.round(w / 1000 * 24 * 365) }, link: '/energy-manager',
      });
    }
  }
  tips.sort((a, b) => (b.eur || 0) - (a.eur || 0) || b.kwh - a.kwh);
  return { totals, days: daysOut, exportByHour: avgExp.map(r2), window: win, suggestions: tips.slice(0, 5) };
}

// The rows of the last `days` days (up to the current hour) and the period's figures.
async function overview(days = 30, nowMs = Date.now()) {
  const tz = displayTz();
  const from = new Date(Math.floor((nowMs - days * DAY) / HOUR) * HOUR).toISOString();
  const rows = await db.prepare('SELECT hour, role, import_kwh, export_kwh FROM energy_hourly WHERE hour >= ? ORDER BY hour').all(from);
  const by = new Map();
  const roles = new Set();
  for (const r of rows) {
    roles.add(r.role);
    const h = by.get(r.hour) || { hour: r.hour, pv: 0, imp: 0, exp: 0, wallbox: 0, batIn: 0, batOut: 0 };
    const i = Number(r.import_kwh) || 0, e = Number(r.export_kwh) || 0;
    if (r.role === 'pv') h.pv += i;
    else if (r.role === 'grid') { h.imp += i; h.exp += e; } else if (r.role === 'wallbox') h.wallbox += i;
    else if (r.role === 'battery') { h.batIn += i; h.batOut += e; }
    by.set(r.hour, h);
  }
  // only hours with both the grid and the solar meter — else self use can't be told
  const gridHours = new Set(rows.filter((r) => r.role === 'grid').map((r) => r.hour));
  const hours = [...by.values()].filter((h) => gridHours.has(h.hour));
  const loadRows = await db.prepare('SELECT l.id, l.name, l.kind, h.hour, h.kwh FROM energy_loads l JOIN load_hourly h ON h.load_id = l.id WHERE l.enabled = 1 AND h.hour >= ?').all(from).catch(() => []);
  const loads = new Map();
  for (const r of loadRows) {
    const l = loads.get(r.id) || { id: r.id, name: r.name, kind: r.kind, hourly: {} };
    l.hourly[r.hour] = (l.hourly[r.hour] || 0) + (Number(r.kwh) || 0);
    loads.set(r.id, l);
  }
  const priceRows = await db.prepare('SELECT start_at, end_at, market_eur_kwh, allin_eur_kwh FROM energy_prices WHERE start_at >= ?').all(from).catch(() => []);
  const prices = {};
  const acc = {};
  for (const p of priceRows) {
    const hour = new Date(Math.floor(Date.parse(p.start_at) / HOUR) * HOUR).toISOString();
    const a = acc[hour] || (acc[hour] = { allin: 0, market: 0, n: 0 });
    if (Number.isFinite(p.allin_eur_kwh) && Number.isFinite(p.market_eur_kwh)) { a.allin += p.allin_eur_kwh; a.market += p.market_eur_kwh; a.n++; }
  }
  for (const [h, a] of Object.entries(acc)) if (a.n) prices[h] = { allin: a.allin / a.n, market: a.market / a.n };
  const nCars = (await db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE enabled = 1').get().catch(() => ({ n: 0 })))?.n || 0;
  const planner = await require('./planner').getConfig().catch(() => null);
  const out = compute({
    hours, loads: [...loads.values()], prices, days, nowMs, planner,
    hasBattery: roles.has('battery'), hasCar: roles.has('wallbox') || nCars > 0,
    localHourOf: (ms) => localParts(ms, tz).hour,
    dayOf: (ms) => { const p = localParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; },
  });
  out.hasSolar = roles.has('pv');
  out.hasGrid = roles.has('grid');
  out.period = days;
  return out;
}

module.exports = { compute, overview };
