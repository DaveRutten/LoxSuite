// Wallbox > Learned (learning.js, solarForecast.js): what LoxSuite learned from your own data,
// viewable and — for departures — overridable per weekday.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const learning = require('../learning');
const solar = require('../solarForecast');
const settings = require('../wallboxSettings');
const { localMidnight, localParts, displayTz } = require('../localTime');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.render('learned', { saved: !!req.query.saved });
}));

// How good are the predictions (forecastLog.js), and what LoxSuite corrects because of it.
router.get('/accuracy.json', asyncHandler(async (req, res) => {
  res.json(await require('../forecastLog').summary(Date.now(), 28));
}));

router.get('/data.json', asyncHandler(async (req, res) => {
  const vehicle = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id LIMIT 1').get().catch(() => null);
  const sessions = await learning.loadSessions(180, null);
  const departures = await learning.learnedDepartures(null);
  const trips = await learning.learnedTrips(vehicle);
  const house = await learning.learnedHouse();
  const now = Date.now();
  const tomorrow = localMidnight(now, undefined, 1) + 12 * 3600000;
  const fc = await solar.forecastForDay(tomorrow);
  const history = await solar.dailyHistory(now, 28);
  // Expected surplus tomorrow = sum over hours of max(0, solar - house).
  let surplus = 0;
  let from = null;
  let to = null;
  const tz = displayTz();
  for (const h of fc.hours) {
    const houseKwh = learning.expectedHouseKwh(house, Date.parse(h.hour), { tz }) ?? 0.4;
    const s = (h.corrected_kwh || 0) - houseKwh;
    if (s > 0.2) { surplus += s; if (!from) from = h.hour; to = new Date(Date.parse(h.hour) + 3600000).toISOString(); }
  }
  const houseTomorrow = (localParts(tomorrow, tz).weekday >= 5 ? house.weekend : house.workday);
  // Driving per weekday from each car's odometer (the planner uses it while the car is out).
  const driving = [];
  for (const v of await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id').all().catch(() => [])) {
    const dp = await require('../driving').drivePattern(v).catch(() => null);
    if (dp) driving.push({ name: v.name, kwhPerKm: require('../driving').effectiveKwhPerKm(v, 0.2), kmToday: dp.kmToday, days: dp.days });
  }
  const firstSession = sessions.length ? new Date(sessions[0].connect).toISOString() : null;
  res.json({
    sessions: sessions.length, firstSession, departures, driving, trips: { classes: trips.classes, fallback: trips.fallback, count: trips.trips.length },
    house, houseWeather: await require('../temperature').houseModel().catch(() => null), solar: { tomorrow: fc, history, status: await settings.get('solar_status', null), config: await solar.getConfig() },
    surplus: { kwh: Math.round(surplus * 10) / 10, from, to, houseDay: Math.round((houseTomorrow || []).filter((x, i) => i >= 8 && i < 18).reduce((a, b) => a + (b || 0), 0) * 10) / 10 },
    vehicle: vehicle ? { name: vehicle.name, type: vehicle.type, battery_kwh: vehicle.battery_kwh } : null,
  });
}));

router.post('/overrides', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const o = {};
  for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    // a time, or '-' / 'none' / 'geen': no usual departure on that weekday
    const v = learning.cleanReady(req.body[`ready_${k}`]);
    if (v) o[k] = v;
  }
  await learning.setOverrides(o);
  res.redirect('/learned?saved=1');
}));

router.post('/sync.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const added = await learning.syncSessions().catch((e) => ({ error: e.message }));
  res.json({ ok: true, added });
}));

module.exports = router;
