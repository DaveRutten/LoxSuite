// Seeds the energy & charging side of the screenshot instance (Wallbox menu, Energy manager, OCPP):
// meters, eight weeks of charging sessions and car readings with a weekday routine, four weeks of
// hourly energy and solar forecasts, two cars, a calendar, trips, three managed loads and an OCPP
// bridge with sessions and a tariff. Run after seed-screenshot-data.js. Every value is invented.
const path = require('path');
const crypto = require('crypto');

const APP_DIR = process.env.APP_DIR || '/app';
process.env.DB_PATH = process.env.DB_PATH || '/data/screenshot.db';
const db = require(path.join(APP_DIR, 'src/db'));
const settings = require(path.join(APP_DIR, 'src/wallboxSettings'));
const { encrypt } = require(path.join(APP_DIR, 'src/secretCrypto'));

const FAKE_MS_PORT = Number(process.env.FAKE_MS_PORT || 7701);
const FAKE = `http://127.0.0.1:${FAKE_MS_PORT}`;
const H = 3600000;
const D = 24 * H;
const TZ_OFFSET_H = 2; // the demo pretends to be in the Netherlands in summer time

// Same uuid scheme as fake-miniserver.js: the n-th control there is fakeUuid(`control-${n}`).
function fakeUuid(seed) {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 32)}`;
}
let outC = () => null;
let hdd = () => 8;
const CTL = { grid: fakeUuid('control-6'), pv: fakeUuid('control-7'), wallbox: fakeUuid('control-8'), hp: fakeUuid('control-9'), dhw: fakeUuid('control-10'), wm: fakeUuid('control-11') };

// deterministic pseudo-random, so every run gives the same pictures
let rnd = 42;
const rand = () => { rnd = (rnd * 16807) % 2147483647; return (rnd - 1) / 2147483646; };
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const iso = (ms) => new Date(ms).toISOString();
const localHour = (ms) => (new Date(ms).getUTCHours() + TZ_OFFSET_H) % 24;
const localDay = (ms) => new Date(ms + TZ_OFFSET_H * H).getUTCDay(); // 0 = Sunday
const localMidnight = (ms) => { const d = new Date(ms + TZ_OFFSET_H * H); d.setUTCHours(0, 0, 0, 0); return d.getTime() - TZ_OFFSET_H * H; };

async function main() {
  await db.init();
  const now = Date.now();
  const nowIso = iso(now);
  const ms = await db.prepare("SELECT id FROM miniservers WHERE name = 'Main House'").get();
  const msId = ms.id;

  // ---- modules: everything on except the AI assistant; Dutch available as second language ----
  for (const key of ['mqtt', 'monitor', 'loxone_logs', 'energy', 'vehicles', 'charging', 'ocpp', 'energy_manager']) {
    await db.upsert('app_modules', { module_key: key, enabled: 1, updated_at: nowIso }, ['module_key']);
  }

  // ---- settings (the demo lives in the Netherlands) ----
  await db.prepare("UPDATE gateway_settings SET display_timezone = 'Europe/Amsterdam' WHERE id = 1").run();
  await settings.set('site', { lat: 52.1561, lon: 5.3878 });
  await settings.set('solar', { enabled: true, kwp: 8.4, tilt: 35, azimuth: 0, efficiency: 0.85, learn_days: 28 });
  await settings.set('prices', { source: 'energyzero', entsoe_zone: '10YNL----------L', markup_eur_kwh: 0.021, energy_tax_eur_kwh: 0.1108, vat_pct: 21, fixed_eur_kwh: 0.28, calibrate_loxone: false, price_interval: 'hour' });
  await settings.set('planner', { mode: 'plan', output: 'advise', min_kw: 4.16, max_kw: 11, grid_limit_kw: 17.3, solar_trust: 'low', insufficient: 'charge', feed_in: 'saldering', feed_in_eur_kwh: 0.05, fuel_auto: true, fuel_type: 'euro95', fuel_markup_eur_l: 0, fuel_eur_l: 2.05, default_kwh_per_km: 0.2, min_topup_kwh: 2, full_hold: 'min' });
  await settings.set('agenda', { tags: ['🚗', '#auto', '#car'], margin_km: 20, geo: true, ready_margin_min: 15, default_kwh_per_km: 0.2, sync_minutes: 15, window_days_back: 35, window_days_ahead: 120, climate_mode: 'log', climate_lead_min: 20, climate_on_battery: true });

  // ---- meters ----
  for (const [role, uuid] of [['grid', CTL.grid], ['pv', CTL.pv], ['wallbox', CTL.wallbox]]) {
    await db.upsert('energy_meters', { role, miniserver_id: msId, control_uuid: uuid, invert: 0, enabled: 1, updated_at: nowIso }, ['role']);
  }

  // ---- vehicles: a plug-in hybrid reading its own data, and a second car without a source ----
  const homeLat = 52.1561; const homeLon = 5.3878;
  const phevId = await db.insertReturningId(
    `INSERT INTO vehicles (name, type, battery_kwh, charge_limit_pct, reserve_pct, kwh_per_km, fuel_l_per_100km, enabled, source_type, source_config, home_lat, home_lon, home_radius_m, created_at, id_tags, ocpp_report)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'http', ?, ?, ?, 150, ?, ?, 1)`,
    ['Family car', 'phev', 25.7, 100, 0, null, 6.2, JSON.stringify({
      url: `${FAKE}/car.json`, interval_s: 300, stale_after_h: 24,
      fields: { soc: { path: 'battery.soc' }, range_km: { path: 'battery.range_km' }, total_range_km: { path: 'total_range_km' }, plugged: { path: 'plugged' }, charging: { path: 'charging' }, limit_soc: { path: 'limit' }, odometer_km: { path: 'odometer' }, latitude: { path: 'position.lat' }, longitude: { path: 'position.lon' }, location: { path: 'place' } },
    }), homeLat, homeLon, iso(now - 120 * D), '04A2B3C4D5E680']
  );
  await db.insertReturningId(
    `INSERT INTO vehicles (name, type, battery_kwh, charge_limit_pct, reserve_pct, enabled, source_type, home_lat, home_lon, home_radius_m, created_at, id_tags, ocpp_report)
     VALUES (?, 'bev', 58, 90, 15, 1, 'none', ?, ?, 150, ?, ?, 0)`,
    ['City EV', homeLat, homeLon, iso(now - 60 * D), '04F1E2D3C4B580']
  );

  // ---- eight weeks of routine: work on weekdays (car out 07:30–17:40), a longer trip on Saturday ----
  const days = 56;
  const start = localMidnight(now - days * D);
  const readings = [];
  const sessions = [];
  const wallboxByHour = new Map();
  let odo = 22650;
  let soc = 92;
  const kwhPerKm = 0.19;
  const cap = 25.7;
  const push = (t, o) => readings.push({ ts: iso(t), soc: Math.round(soc), odometer_km: r2(odo), plugged: o.plugged ? 1 : 0, charging: o.charging ? 1 : 0, home: o.home ? 1 : 0 });
  const drive = (t, km, mins) => {
    push(t, { home: false }); // standing still until the start, so trips don't run together
    const steps = Math.max(2, Math.round(mins / 10));
    for (let i = 1; i <= steps; i++) {
      odo += km / steps;
      soc = Math.max(14, soc - (km / steps) * kwhPerKm / cap * 100);
      push(t + (i * mins / steps) * 60000, { home: false });
    }
  };
  for (let day = 0; day < days; day++) {
    const m = start + day * D;
    if (m + 8 * H > now) break;
    const wd = localDay(m + 12 * H);
    const at = (h, min = 0) => m + (h - TZ_OFFSET_H) * H + min * 60000;
    push(at(6), { plugged: true, home: true });
    let trip = 0;
    if (wd >= 1 && wd <= 5 && !(wd === 3 && day % 14 === 3)) {
      const out = 7 * 60 + 25 + Math.round(rand() * 15);
      const km = 22 + rand() * 6;
      drive(at(0, out), km, 32);
      const back = 17 * 60 + Math.round(rand() * 40);
      if (at(0, back) < now) drive(at(0, back), km, 35);
      trip = 2 * km;
      if (wd === 3) { drive(at(19, 0), 6, 12); trip += 6; }
    } else if (wd === 6) {
      drive(at(10, 5), 38, 45);
      if (at(15, 30) < now) drive(at(15, 30), 38, 45);
      trip = 76;
    }
    // home in the evening, plugged in until the next morning
    const plugAt = at(wd >= 1 && wd <= 5 ? 18 : 16, 5 + Math.round(rand() * 20));
    if (plugAt > now) continue;
    const kwh = r3(Math.max(1.5, Math.min(cap * (100 - soc) / 100, trip * kwhPerKm)));
    push(plugAt, { plugged: true, home: true });
    // charged in the cheap hours after 22:00 (the plan), 3.7 kW … 11 kW
    let left = kwh;
    for (let h = 22; left > 0.05 && h < 30; h++) {
      const hs = at(h);
      if (hs > now) break;
      const k = Math.min(left, 7.4);
      wallboxByHour.set(hs, (wallboxByHour.get(hs) || 0) + k);
      left -= k;
      soc = Math.min(100, soc + k / cap * 100);
      push(hs + 50 * 60000, { plugged: true, charging: left > 0.05, home: true });
    }
    const unplug = at(31, 20 + Math.round(rand() * 15)) - 24 * H + 24 * H; // next morning ~07:20
    sessions.push({ connect_at: iso(plugAt), disconnect_at: unplug < now ? iso(unplug) : null, kwh, vehicle_id: phevId, id_tag: '04A2B3C4D5E680', source: 'loxone' });
  }
  for (const r of readings) {
    await db.prepare('INSERT INTO vehicle_readings (vehicle_id, ts, soc, range_km, plugged, charging, home, odometer_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(phevId, r.ts, r.soc, Math.round(r.soc / 100 * cap / kwhPerKm), r.plugged, r.charging, r.home, r.odometer_km);
  }
  for (const s of sessions) {
    await db.prepare('INSERT INTO charging_sessions (connect_at, disconnect_at, kwh, vehicle_id, id_tag, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.connect_at, s.disconnect_at, s.kwh, s.vehicle_id, s.id_tag, s.source);
  }
  // The charge log of the newest session (the "Last session" tile on Smart charging): plugged in, the
  // night's charging at 7.4 kW, the battery going up, unplugged in the morning (or still plugged in).
  const lastS = sessions[sessions.length - 1];
  if (lastS) {
    const plug = Date.parse(lastS.connect_at);
    const end = lastS.disconnect_at ? Date.parse(lastS.disconnect_at) : now - 60000;
    const key = `s${plug}`;
    const socStart = Math.max(5, Math.round(100 - (lastS.kwh / cap) * 100));
    const log = (t, event, d) => db.prepare('INSERT INTO charge_log (ts, session_key, event, data) VALUES (?, ?, ?, ?)')
      .run(iso(t), key, event, JSON.stringify({ connected: 1, enabled: 1, active: d.kw > 0 ? 1 : 0, limit: d.kw, mode: 1, sentKw: d.kw, sentEnable: 1, sentSource: 'live', advisedKw: d.kw, output: 'live', car: 'Family car', plugged: true, ...d }));
    await log(plug, 'Car plugged in', { kw: 0, sessionKwh: 0, soc: socStart, charging: false });
    let done = 0;
    for (const hs of [...wallboxByHour.keys()].filter((t) => t >= plug && t < end).sort((a, b) => a - b)) {
      const k = wallboxByHour.get(hs);
      await log(hs + 60000, 'Live: sent 7.4 kW', { kw: 7.4, sessionKwh: r2(done), soc: Math.round(socStart + (done / cap) * 100), charging: true });
      done += k;
      await log(hs + Math.round((k / 7.4) * H), null, { kw: k < 7.3 ? 0 : 7.4, sessionKwh: r2(done), soc: Math.min(100, Math.round(socStart + (done / cap) * 100)), charging: k >= 7.3 });
    }
    if (lastS.disconnect_at) await db.prepare('INSERT INTO charge_log (ts, session_key, event, data) VALUES (?, ?, ?, ?)')
      .run(iso(end), key, 'Car unplugged', JSON.stringify({ connected: 0, kw: 0, sessionKwh: r2(done), soc: Math.min(100, Math.round(socStart + (done / cap) * 100)), car: 'Family car' }));
    else await log(end, null, { kw: 0, sessionKwh: r2(done), soc: Math.min(100, Math.round(socStart + (done / cap) * 100)), charging: false });
  }

  // ---- four weeks of hourly energy (grid / solar / Wallbox / house) and the solar forecast of then ----
  const pvKwp = 8.4;
  const houseProfile = [0.32, 0.28, 0.26, 0.25, 0.26, 0.3, 0.45, 0.7, 0.62, 0.48, 0.42, 0.45, 0.55, 0.5, 0.44, 0.46, 0.6, 0.85, 1.15, 1.05, 0.9, 0.72, 0.55, 0.4];
  const hourStart = Math.floor((now - 28 * D) / H) * H;
  let cloud = 1;
  // outdoor temperature: a mild autumn with colder and warmer spells, a little warmer in the afternoon
  const dayMean = (t) => Math.round((9 + 5 * Math.sin(Math.floor(t / D) / 4.5)) * 10) / 10;
  outC = (t) => Math.round((dayMean(t) + 3 * Math.sin(((localHour(t) - 9) / 24) * 2 * Math.PI)) * 10) / 10;
  hdd = (t) => Math.max(0, 18 - dayMean(t));
  for (let t = hourStart; t < Math.floor(now / H) * H; t += H) {
    const lh = localHour(t);
    if (lh === 0) cloud = 0.35 + rand() * 0.65;
    const sun = Math.max(0, Math.sin(((lh + 0.5 - 7.5) / 11) * Math.PI));
    const pv = r3(pvKwp * 0.62 * sun * cloud * (0.9 + rand() * 0.2));
    const weekend = [0, 6].includes(localDay(t));
    const house = r3(houseProfile[lh] * (weekend ? 1.15 : 1) * (0.85 + rand() * 0.3));
    const wb = r3(wallboxByHour.get(t) || 0);
    const net = house + wb - pv;
    await db.prepare('INSERT INTO energy_hourly (hour, role, import_kwh, export_kwh, source) VALUES (?, ?, ?, ?, ?)').run(iso(t), 'grid', r3(Math.max(0, net)), r3(Math.max(0, -net)), 'live');
    await db.prepare('INSERT INTO energy_hourly (hour, role, import_kwh, export_kwh, source) VALUES (?, ?, ?, ?, ?)').run(iso(t), 'pv', pv, 0, 'live');
    await db.prepare('INSERT INTO energy_hourly (hour, role, import_kwh, export_kwh, source) VALUES (?, ?, ?, ?, ?)').run(iso(t), 'wallbox', wb, 0, 'live');
    await db.prepare('INSERT INTO energy_hourly (hour, role, import_kwh, export_kwh, source) VALUES (?, ?, ?, ?, ?)').run(iso(t), 'house', house, 0, 'live');
    const fc = sun > 0 ? r3(pv / (0.88 + rand() * 0.15)) : 0;
    await db.prepare('INSERT INTO solar_forecast (hour, raw_kwh, dayahead_raw_kwh, corrected_kwh, made_at, temp_c) VALUES (?, ?, ?, ?, ?, ?)').run(iso(t), fc, fc, r3(fc * 0.92), iso(t - D), outC(t));
  }
  // the last hours per 5 minutes, for the live charts
  for (let t = Math.floor((now - 10 * H) / 300000) * 300000; t < now; t += 300000) {
    const lh = localHour(t) + new Date(t).getUTCMinutes() / 60;
    const sun = Math.max(0, Math.sin(((lh - 7.5) / 11) * Math.PI));
    const pv = r3(pvKwp * 0.62 * sun * (0.9 + rand() * 0.15));
    const house = r3(houseProfile[Math.floor(lh) % 24] * (0.8 + rand() * 0.4));
    for (const [role, kw] of [['pv', pv], ['wallbox', 0], ['grid', r3(house - pv)]]) {
      await db.prepare('INSERT INTO energy_samples (ts, role, power_kw, import_kwh, export_kwh) VALUES (?, ?, ?, ?, ?)').run(iso(t), role, kw, null, null);
    }
  }

  // ---- day-ahead prices of the last two months (for costs per session / month) ----
  const market = (t) => {
    const h = localHour(t);
    const base = 0.085 + 0.045 * Math.sin(((h - 3) / 24) * 2 * Math.PI);
    return r3(base + (h >= 17 && h <= 21 ? 0.07 : 0) + (h >= 7 && h <= 9 ? 0.04 : 0) + (h >= 11 && h <= 15 ? -0.05 : 0) + (rand() - 0.5) * 0.03);
  };
  for (let t = Math.floor((now - 60 * D) / H) * H; t < localMidnight(now); t += H) {
    const m = market(t);
    await db.prepare('INSERT INTO energy_prices (start_at, end_at, market_eur_kwh, allin_eur_kwh, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(iso(t), iso(t + H), m, r3((m + 0.021) * 1.21 + 0.1108), 'energyzero', iso(t - D));
  }

  // ---- agenda: the demo calendar (served by the fake Miniserver) and two trips ----
  await db.prepare('INSERT INTO calendars (name, url, color, vehicle_id, enabled, created_at, kind) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('Family', encrypt(`${FAKE}/calendar.ics`), '#3b82c4', null, iso(now - 30 * D), 'ics');
  const nextTue = (() => { let t = localMidnight(now) + D; while (localDay(t + 12 * H) !== 2) t += D; return t; })();
  await db.prepare('INSERT INTO trips (vehicle_id, title, depart_at, return_at, location, own_value, weekly, climate_c, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(phevId, 'Grandma', iso(nextTue + (17 - TZ_OFFSET_H) * H), iso(nextTue + (21 - TZ_OFFSET_H) * H), null, '90 km', 1, 20, iso(now - 20 * D));

  // ---- energy manager: hot water, heat pump, washing machine (shadow) with history ----
  const addLoad = (name, kind, priority, uuid, s) => db.insertReturningId(
    'INSERT INTO energy_loads (name, kind, enabled, priority, miniserver_id, meter_uuid, status_uuid, settings, output, created_at) VALUES (?, ?, 1, ?, ?, ?, NULL, ?, ?, ?)',
    [name, kind, priority, msId, uuid, JSON.stringify(s), 'shadow', iso(now - 40 * D)]
  );
  const dhw = await addLoad('Hot water', 'dhw', 1, CTL.dhw, { kw: 2.4, duration_h: 1.5, buffer_setpoint: 60 });
  const hp = await addLoad('Heat pump', 'heatpump', 2, CTL.hp, { season: 'heating', kw: 1.6,
    src: { onoff: fakeUuid('hp-on'), temp: fakeUuid('living-temp-actual'), status: fakeUuid('hp-mode'), status_map: '0=Off\n1=Space heating\n2=Hot water\n3=Defrost', status_on: '1,2,3' } });
  const wm = await addLoad('Washing machine', 'appliance', 4, CTL.wm, {
    src: { status: fakeUuid('wm-status'), status_map: '0=Off\n1=Washing\n2=Spinning\n3=Done', status_on: '1,2' } });
  // what was learned from those signals: minutes and kWh per status, and the changes of the last 2 days
  let roomC = 20.5;
  const addStatus = (id, t, status, minutes, kwh) => db.prepare('INSERT INTO load_status_hourly (load_id, hour, status, minutes, kwh, measured) VALUES (?, ?, ?, ?, ?, 1)').run(id, iso(t), status, minutes, kwh);
  const addEvent = (id, t, on, status, label, kw) => db.prepare('INSERT INTO load_events (load_id, ts, on_state, status, label, kw) VALUES (?, ?, ?, ?, ?, ?)').run(id, iso(t), on, status, label, kw);
  for (let t = Math.floor((now - 21 * D) / H) * H; t < Math.floor(now / H) * H; t += H) {
    const lh = localHour(t);
    const heatMin = lh < 7 || lh > 21 ? 40 : (lh >= 10 && lh < 16 ? 0 : 20);
    const dhwMin = lh === 13 ? 25 : 0;
    await addStatus(hp, t, 'Space heating', heatMin, r3(heatMin / 60 * 1.45));
    if (dhwMin) await addStatus(hp, t, 'Hot water', dhwMin, r3(dhwMin / 60 * 2.3));
    if (lh === 5 && rand() < 0.5) await addStatus(hp, t, 'Defrost', 6, 0.05);
    await addStatus(hp, t, 'Off', 60 - heatMin - dhwMin, 0);
    // the living room: warms while heating, cools 3% of the difference with outside per hour while off
    roomC = Math.min(22, Math.max(19, roomC + heatMin / 60 * 0.9 - 0.03 * (roomC - outC(t))));
    await db.prepare('INSERT INTO load_temp_hourly (load_id, hour, temp_sum, temp_n, on_min) VALUES (?, ?, ?, 1, ?)').run(hp, iso(t), Math.round(roomC * 100) / 100, heatMin + dhwMin);
    if (t >= now - 49 * H) {
      await addEvent(hp, t, 1, '1', 'Space heating', 1.45);
      if (dhwMin) { await addEvent(hp, t + heatMin * 60000, 1, '2', 'Hot water', 2.3); await addEvent(hp, t + (heatMin + dhwMin) * 60000, 0, '0', 'Off', 0); }
      else await addEvent(hp, t + heatMin * 60000, 0, '0', 'Off', 0);
    }
  }
  for (let t = Math.floor((now - 21 * D) / H) * H; t < Math.floor(now / H) * H; t += H) {
    const lh = localHour(t);
    if (lh === 13) await db.prepare('INSERT INTO load_hourly (load_id, hour, kwh, source) VALUES (?, ?, ?, ?)').run(dhw, iso(t), r3(2.1 + rand() * 0.6), 'live');
    const hpK = r3((lh < 7 || lh > 21 ? 0.55 : (lh >= 10 && lh < 16 ? 0.02 : 0.3)) * (0.35 + 0.09 * hdd(t)) * (0.9 + rand() * 0.2));
    await db.prepare('INSERT INTO load_hourly (load_id, hour, kwh, source) VALUES (?, ?, ?, ?)').run(hp, iso(t), hpK, 'live');
  }
  for (let day = 20; day >= 1; day--) {
    const m = localMidnight(now - day * D);
    const wd = localDay(m + 12 * H);
    if (![1, 3, 6].includes(wd)) continue;
    const s = m + (wd === 6 ? 10 : 11 - TZ_OFFSET_H + 2) * H - TZ_OFFSET_H * H + 15 * 60000;
    const kwh = r3(0.9 + rand() * 0.4);
    await db.prepare('INSERT INTO load_hourly (load_id, hour, kwh, source) VALUES (?, ?, ?, ?)').run(wm, iso(Math.floor(s / H) * H), kwh, 'live');
    await db.prepare('INSERT INTO load_runs (load_id, start_at, end_at, kwh, cost_eur, best_start, best_cost_eur, ready_by, duration_h, label, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(wm, iso(s), iso(s + 1.6 * H), kwh, r2(kwh * 0.21), iso(s + 2 * H), r2(kwh * 0.12), null, 1.6, null, 'run');
    await addStatus(wm, Math.floor(s / H) * H, 'Washing', 80, r3(kwh * 0.85));
    await addStatus(wm, Math.floor(s / H) * H + H, 'Spinning', 16, r3(kwh * 0.15));
    if (day <= 2) { await addEvent(wm, s, 1, '1', 'Washing', 1.9); await addEvent(wm, s + 80 * 60000, 1, '2', 'Spinning', 0.6); await addEvent(wm, s + 96 * 60000, 0, '3', 'Done', 0); }
  }

  // ---- how good the predictions were (forecast_log): three weeks of solar, house and consumers, departures ----
  const flog = (kind, target, horizon, predicted, actual) => db.prepare('INSERT INTO forecast_log (kind, target, horizon, predicted, actual, made_at) VALUES (?, ?, ?, ?, ?, ?)').run(kind, target, horizon, predicted, actual, iso(Date.parse(target) - (horizon === 'd1' ? D : H)));
  {
    const rows = await db.prepare("SELECT hour, role, import_kwh FROM energy_hourly WHERE role IN ('pv', 'house') AND hour >= ?").all(iso(now - 21 * D));
    for (const r of rows) {
      const noise = (w) => 1 + (rand() - 0.5) * w;
      if (r.role === 'pv' && r.import_kwh > 0) { await flog('pv', r.hour, 'd1', r3(r.import_kwh * noise(0.5) * 1.06), r.import_kwh); await flog('pv', r.hour, 'h1', r3(r.import_kwh * noise(0.2)), r.import_kwh); }
      if (r.role === 'house') { await flog('house', r.hour, 'd1', r3(r.import_kwh * noise(0.6) * 0.93), r.import_kwh); await flog('house', r.hour, 'h1', r3(r.import_kwh * noise(0.35)), r.import_kwh); }
    }
    const hpRows = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(hp, iso(now - 21 * D));
    for (const r of hpRows) await flog(`load:${hp}`, r.hour, 'd1', r3(r.kwh * (1 + (rand() - 0.5) * 0.5)), r.kwh);
    for (let day = 20; day >= 1; day--) {
      const m = localMidnight(now - day * D);
      if ([0, 6].includes(localDay(m + 12 * H))) continue;
      const ready = m + (7 - TZ_OFFSET_H) * H + 15 * 60000;
      const left = ready + Math.round((rand() * 40 - 6) * 60000);
      await flog('depart', iso(Math.floor(left / 60000) * 60000).replace(/\.\d{3}Z$/, '.000Z'), 'event', ready, left);
      const exp = m + (17 - TZ_OFFSET_H) * H + 30 * 60000;
      await flog('arrive', iso(exp + D / 3), 'event', exp, exp + Math.round((rand() * 50 - 15) * 60000));
    }
  }

  // ---- OCPP bridge (dry run) with eight weeks of sessions, a tariff and finance settings ----
  const bridgeId = await db.insertReturningId(
    `INSERT INTO ocpp_bridges (name, miniserver_id, control_uuid, enabled, mode, server_url, charge_point_id, id_tag, serial, ean, meter_interval_s, stop_delay_s, created_at, updated_at, id_tag_mode, finance)
     VALUES (?, ?, ?, 0, 'dry', ?, ?, ?, ?, ?, 60, 60, ?, ?, 'vehicle', ?)`,
    ['Company car reimbursement', msId, CTL.wallbox, 'wss://ocpp.example.com/ocpp', 'LOXSUITE-DEMO-01', 'DEMO1234', 'LX-0001', '871685900000000000', iso(now - 90 * D), nowIso,
      JSON.stringify({ cost_mode: 'hourly', solar_value: 'saldering', tariff_vat: true, show_vat: true, vat_pct: 21 })]
  );
  await db.prepare('INSERT INTO ocpp_tariffs (bridge_id, valid_from, eur_per_kwh, note) VALUES (?, ?, ?, ?)').run(bridgeId, iso(now - 200 * D).slice(0, 10), 0.35, 'Employer rate');
  let meter = 4_210_000;
  let n = 0;
  for (const s of sessions) {
    if (!s.disconnect_at) continue;
    const wh = Math.round(s.kwh * 1000);
    await db.prepare(`INSERT INTO ocpp_bridge_sessions (bridge_id, local_id, transaction_id, mode, started_at, stopped_at, meter_start_wh, meter_stop_wh, energy_loxone_kwh, stop_reason, id_tag, id_tag_source, vehicle_id)
      VALUES (?, ?, ?, 'dry', ?, ?, ?, ?, ?, 'EVDisconnected', ?, 'vehicle', ?)`)
      .run(bridgeId, ++n, 1000 + n, s.connect_at, s.disconnect_at, meter, meter + wh, s.kwh, s.id_tag, s.vehicle_id);
    meter += wh;
  }

  console.log(`Energy seed complete: ${sessions.length} sessions, ${readings.length} car readings.`);
  await db.close();
}

main().catch((err) => {
  console.error('Energy seed failed:', err);
  process.exit(1);
});
