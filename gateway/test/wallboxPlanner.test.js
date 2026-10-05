const { test } = require('node:test');
const assert = require('node:assert/strict');
const prices = require('../src/prices');
const solar = require('../src/solarForecast');
const planner = require('../src/planner');
const learning = require('../src/learning');
const agenda = require('../src/agenda');
const reminders = require('../src/reminders');
const fuel = require('../src/fuelPrice');
const webPush = require('../src/webPush');
const vehicles = require('../src/vehicles');
const { buildQuarterRows } = require('../src/ocppExport');
const { localTimeOn, localMidnight, localParts } = require('../src/localTime');

const TZ = 'Europe/Amsterdam';

// ------------------------------------------------------------------ prices

test('allinPrice: tariff formula and calibration', () => {
  assert.equal(prices.allinPrice(0.10, { markup_eur_kwh: 0.02, vat_pct: 21, energy_tax_eur_kwh: 0.10 }), 0.2452);
  assert.equal(prices.allinPrice(0.10, {}, { a: 1.2, b: 0.15 }), 0.27);
  assert.equal(prices.allinPrice(null, {}), null);
});

test('fitLinear recovers a tariff from samples and rejects nonsense', () => {
  const pairs = [];
  for (let i = 0; i < 40; i++) { const x = 0.05 + i * 0.005; pairs.push({ x, y: 1.21 * x + 0.142 }); }
  const f = prices.fitLinear(pairs);
  assert.equal(f.a, 1.21);
  assert.equal(f.b, 0.142);
  assert.equal(prices.fitLinear(pairs.slice(0, 5)), null);
  assert.equal(prices.fitLinear(pairs.map((p) => ({ x: p.x, y: 0.3 }))), null); // slope 0
});

test('parseEnergyZero: hourly and 15-minute prices become intervals', () => {
  const hourly = prices.parseEnergyZero({ Prices: [{ price: 0.1, readingDate: '2026-10-04T22:00:00Z' }, { price: 0.08, readingDate: '2026-10-04T23:00:00Z' }] });
  assert.deepEqual(hourly, [
    { start: '2026-10-04T22:00:00.000Z', end: '2026-10-04T23:00:00.000Z', market: 0.1 },
    { start: '2026-10-04T23:00:00.000Z', end: '2026-10-05T00:00:00.000Z', market: 0.08 },
  ]);
  const q = prices.parseEnergyZero({ Prices: [{ price: 0.1, readingDate: '2026-10-04T22:00:00Z' }, { price: 0.09, readingDate: '2026-10-04T22:15:00Z' }] });
  assert.equal(q[1].end, '2026-10-04T22:30:00.000Z');
});

test('parseEntsoe: positions, resolution and repeated prices', () => {
  const xml = `<Publication_MarketDocument><TimeSeries><Period><timeInterval><start>2026-10-04T22:00Z</start><end>2026-10-05T01:00Z</end></timeInterval><resolution>PT60M</resolution>
    <Point><position>1</position><price.amount>95.5</price.amount></Point><Point><position>3</position><price.amount>80</price.amount></Point></Period></TimeSeries></Publication_MarketDocument>`;
  assert.deepEqual(prices.parseEntsoe(xml).map((x) => [x.start.slice(11, 16), x.market]), [['22:00', 0.0955], ['23:00', 0.0955], ['00:00', 0.08]]);
  assert.equal(prices.entsoeTime(Date.parse('2026-10-04T22:00:00Z')), '202610042200');
});

// ------------------------------------------------------------------ solar

test('parseOpenMeteo shifts preceding-hour values and scales by kWp', () => {
  const rows = solar.parseOpenMeteo({ hourly: { time: ['2026-10-05T10:00', '2026-10-05T11:00'], global_tilted_irradiance: [500, 0] } }, { kwp: 10, efficiency: 0.8 });
  assert.deepEqual(rows, [{ hour: '2026-10-05T09:00:00.000Z', raw_kwh: 4 }, { hour: '2026-10-05T10:00:00.000Z', raw_kwh: 0 }]);
});

test('correctionFactors per hour of the day, with an overall fallback', () => {
  const pairs = [];
  for (let d = 0; d < 10; d++) { pairs.push({ localHour: 12, forecast: 4, actual: 3 }); pairs.push({ localHour: 9, forecast: 1, actual: 1.2 }); }
  pairs.push({ localHour: 17, forecast: 0.5, actual: 0.1 });
  const f = solar.correctionFactors(pairs);
  assert.equal(f.byHour[12], 0.75);
  assert.equal(f.byHour[9], 1.2);
  assert.equal(f.byHour[17], null); // too few samples
  assert.equal(solar.factorFor(f, 17), f.overall);
  const band = solar.dailyErrorBand(Array.from({ length: 10 }, (_, i) => ({ forecast: 20, actual: 14 + i })));
  assert.ok(band.low < 1 && band.high > band.low && band.mape > 0);
});

// ------------------------------------------------------------------ planner

function hourlySlots(startIso, prices24, pv = []) {
  const t0 = Date.parse(startIso);
  return prices24.map((p, i) => ({ start: new Date(t0 + i * 3600000).toISOString(), end: new Date(t0 + (i + 1) * 3600000).toISOString(), price: p, pvKw: pv[i] || 0 }));
}

test('makePlan picks the cheapest hours before the deadline', () => {
  const now = Date.parse('2026-10-04T20:00:00Z');
  const slots = hourlySlots('2026-10-04T20:00:00Z', [0.40, 0.35, 0.30, 0.25, 0.22, 0.24, 0.28, 0.33, 0.40, 0.45]);
  const plan = planner.makePlan({ nowMs: now, readyAtMs: Date.parse('2026-10-05T04:45:00Z'), needKwh: 20, slots, minKw: 4.16, maxKw: 11 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.kwh, 20);
  assert.deepEqual(plan.slots.map((s) => s.start.slice(11, 16)), ['00:00', '01:00']);
  assert.equal(plan.slots[0].kwh, 11);
  assert.ok(plan.compare.saving > 2);
  // Nothing after the deadline is used.
  const tight = planner.makePlan({ nowMs: now, readyAtMs: Date.parse('2026-10-04T22:00:00Z'), needKwh: 30, slots, maxKw: 11 });
  assert.equal(tight.feasible, false);
  assert.equal(tight.kwh, 22);
});

test('makePlan values solar at the export price and respects the price cap', () => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  const slots = hourlySlots('2026-10-05T08:00:00Z', [0.30, 0.30, 0.30, 0.30, 0.20], [0, 6, 6, 0, 0]);
  const fixed = planner.makePlan({ nowMs: now, needKwh: 10, slots, feedIn: 'fixed', feedInEur: 0.05, solarTrust: 'expected', maxKw: 11 });
  assert.equal(fixed.slots[0].source, 'pv');
  assert.equal(fixed.pvKwh, 10);
  // A plug-in hybrid: nothing above the fuel break-even, even when that means not charging fully.
  const capped = planner.makePlan({ nowMs: now, needKwh: 30, slots, priceCap: 0.25, insufficient: 'stop', solarTrust: 'bonus', maxKw: 11 });
  assert.deepEqual(capped.slots.map((s) => s.price), [0.2]);
  assert.equal(capped.feasible, false);
  assert.equal(planner.fuelBreakEven({ fuelEurL: 2.1, lPer100km: 6.5, kwhPerKm: 0.2 }), 0.62);
});

test('makePlan modes: now charges straight away, pv only uses solar, off nothing', () => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  const slots = hourlySlots('2026-10-05T08:00:00Z', [0.40, 0.20, 0.20], [0, 0, 8]);
  assert.equal(planner.makePlan({ nowMs: now, needKwh: 5, slots, mode: 'now' }).slots[0].start.slice(11, 16), '08:00');
  const pv = planner.makePlan({ nowMs: now, needKwh: 5, slots, mode: 'pv', solarTrust: 'expected' });
  assert.deepEqual(pv.slots.map((s) => s.source), ['pv']);
  assert.equal(planner.makePlan({ nowMs: now, needKwh: 5, slots, mode: 'off' }).kwh, 0);
});

test('controlStep: solar start/stop delays, plan interval, grid limit', () => {
  const cfg = { ...planner.DEFAULTS, min_kw: 4.16, max_kw: 11, pv_start_delay_s: 120, pv_stop_delay_s: 300, grid_limit_kw: 17.3 };
  let st = {};
  const live = (gridKw, wallboxKw = 0, houseKw = 0.5) => ({ connected: true, gridKw, wallboxKw, houseKw });
  let r = planner.controlStep({ nowMs: 0, mode: 'pv', cfg, live: live(-5), state: st });
  assert.equal(r.kw, 0); st = r.state;
  r = planner.controlStep({ nowMs: 130000, mode: 'pv', cfg, live: live(-5), state: st });
  assert.equal(r.kw, 5); st = r.state;
  // Surplus drops (car uses 5, grid now imports 2): stop only after the stop delay.
  r = planner.controlStep({ nowMs: 200000, mode: "pv", cfg, live: live(2, 5), state: st });
  assert.equal(r.kw, 4.16); st = r.state;
  r = planner.controlStep({ nowMs: 200000 + 301000, mode: "pv", cfg, live: live(2, 5), state: st });
  assert.equal(r.kw, 0);
  const plan = { slots: [{ start: '2026-10-05T00:00:00.000Z', end: '2026-10-05T01:00:00.000Z', kw: 11, source: 'grid' }] };
  r = planner.controlStep({ nowMs: Date.parse('2026-10-05T00:30:00Z'), mode: 'plan', cfg, plan, live: live(0.5, 0, 9) });
  assert.equal(r.kw, 8.3); // 17.3 - 9 house
  r = planner.controlStep({ nowMs: Date.parse('2026-10-05T00:30:00Z'), mode: 'plan', cfg, plan, live: live(0.5, 0, 14) });
  assert.equal(r.kw, 0); // room 3.3 < minimum
  assert.equal(planner.controlStep({ nowMs: 0, mode: 'now', cfg, live: { connected: false } }).kw, 0);
});

// ------------------------------------------------------------------ learning

test('departureStats and nextReadyTime from sessions', () => {
  const sessions = [];
  // 6 Mondays leaving around 07:00, coming back 16:30.
  for (let w = 0; w < 6; w++) {
    const monday = Date.parse('2026-08-31T12:00:00Z') + w * 7 * 86400000;
    sessions.push({ connect: localTimeOn(monday - 86400000, '18:00', TZ), disconnect: localTimeOn(monday, `07:0${w}`, TZ), kwh: 18 + w * 0.5 });
  }
  const stats = learning.departureStats(sessions, { tz: TZ, nowMs: Date.parse('2026-10-10T12:00:00Z') });
  const mon = stats[0];
  assert.equal(mon.usual, true);
  assert.equal(mon.n, 6);
  assert.equal(mon.departure, '07:03');
  assert.equal(mon.ready, '06:45');
  const nx = learning.nextReadyTime(stats, Date.parse('2026-10-10T12:00:00Z'), { tz: TZ });
  assert.equal(nx.weekday, 'mon');
  assert.equal(new Date(nx.at).toISOString(), '2026-10-12T04:45:00.000Z');
  const own = learning.departureStats(sessions, { tz: TZ, nowMs: Date.parse('2026-10-10T12:00:00Z'), overrides: { tue: '08:00' } });
  assert.equal(own[1].ready, '08:00');
});

test('tripStats attributes charged kWh to the trip before it', () => {
  const t = (iso) => Date.parse(iso);
  const sessions = [
    { connect: t('2026-09-27T16:00:00Z'), disconnect: t('2026-09-28T05:00:00Z'), kwh: 5 },
    { connect: t('2026-09-28T14:30:00Z'), disconnect: t('2026-09-29T06:00:00Z'), kwh: 20 },
    { connect: t('2026-09-29T07:00:00Z'), disconnect: t('2026-09-29T08:00:00Z'), kwh: 4 },
  ];
  const s = learning.tripStats(sessions, { tz: TZ, usableKwh: 21 });
  assert.equal(s.trips.length, 2);
  assert.deepEqual([s.trips[0].weekday, s.trips[0].slot, s.trips[0].duration, s.trips[0].kwh, s.trips[0].emptied], ['mon', 'morning', 'long', 20, true]);
  assert.equal(s.trips[1].duration, 'short');
  assert.equal(learning.expectedTripKwh(s, t('2026-10-05T05:00:00Z'), 9, { tz: TZ }).kwh, 20);
});

test('houseProfile splits workdays and weekends', () => {
  const rows = [];
  for (let d = 0; d < 14; d++) {
    const day = localMidnight(Date.parse('2026-09-07T12:00:00Z'), TZ, d);
    for (let h = 0; h < 24; h++) rows.push({ hour: new Date(day + h * 3600000).toISOString(), kwh: localParts(day + 43200000, TZ).weekday >= 5 ? 0.7 : 0.5 });
  }
  const p = learning.houseProfile(rows, { tz: TZ });
  assert.equal(p.workday[10], 0.5);
  assert.equal(p.weekend[10], 0.7);
  assert.equal(p.days, 14);
  assert.equal(p.baseLoadKw, 0.5);
});

// ------------------------------------------------------------------ agenda

test('car markers, hints and the kWh a trip needs', () => {
  assert.equal(agenda.hasCarTag('🚗 Verjaardag'), true);
  assert.equal(agenda.hasCarTag('Lunch #Auto'), true);
  assert.equal(agenda.hasCarTag('Tandarts'), false);
  assert.deepEqual(agenda.parseCarHint('🚗 120 km Utrecht'), { km: 120 });
  assert.deepEqual(agenda.parseCarHint('#auto 30 kWh'), { kwh: 30 });
  assert.deepEqual(agenda.parseCarHint('🚗 vol'), { full: true });
  assert.deepEqual(agenda.tripNeedKwh({ distanceKm: 92, marginKm: 20, kwhPerKm: 0.19 }), { kwh: 38.8, km: 204, basis: '2 × 92 km + 20 km margin' });
  assert.equal(agenda.tripNeedKwh({ own: { full: true }, usableKwh: 23 }).kwh, 23);
  assert.equal(agenda.icsUrl('webcal://cloud.example/cal.ics'), 'https://cloud.example/cal.ics');
});

test('expandEvents: recurrences, exceptions and all-day events', () => {
  const ical = require('node-ical');
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w1', 'DTSTART;TZID=Europe/Amsterdam:20261005T080000', 'DTEND;TZID=Europe/Amsterdam:20261005T170000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3', 'EXDATE;TZID=Europe/Amsterdam:20261012T080000', 'SUMMARY:🚗 Werk', 'LOCATION:Veghel', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b2', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'SUMMARY:Verjaardag #auto', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const occ = agenda.expandEvents(ical.sync.parseICS(ics), Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(occ.map((o) => [o.uid, o.start, o.allDay]), [
    ['w1', '2026-10-05T06:00:00.000Z', false],
    ['b2', '2026-10-10T00:00:00.000Z', true],
    ['w1', '2026-10-19T06:00:00.000Z', false],
  ]);
  assert.equal(occ[0].location, 'Veghel');
});

test('tripOccurrences repeats weekly trips', () => {
  const t = { depart_at: '2026-10-05T05:00:00.000Z', weekly: 1 };
  assert.equal(agenda.tripOccurrences(t, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z')).length, 4);
  assert.equal(agenda.tripOccurrences({ ...t, weekly: 0 }, Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z')).length, 0);
});

// ------------------------------------------------------------------ reminders, fuel, push, vehicles, export

test('plugDecision: hybrid by saving, electric by need', () => {
  assert.equal(reminders.plugDecision({ type: 'phev', deficitKwh: 20, tripNeedKwh: 20, avgPrice: 0.24, breakEven: 0.62, thresholdEur: 1 }).remind, true);
  const small = reminders.plugDecision({ type: 'phev', deficitKwh: 3, tripNeedKwh: 3, avgPrice: 0.30, breakEven: 0.62, thresholdEur: 1 });
  assert.equal(small.remind, false);
  assert.equal(small.saving, 0.96);
  assert.equal(reminders.plugDecision({ type: 'bev', deficitKwh: 40, tripNeedKwh: 25, usableKwh: 60, reserveKwh: 9 }).remind, true);
  assert.equal(reminders.plugDecision({ type: 'bev', deficitKwh: 10, tripNeedKwh: 25, usableKwh: 60, reserveKwh: 9 }).remind, false);
  assert.equal(reminders.inQuiet(23 * 60, 22 * 60 + 30, 7 * 60), true);
  assert.equal(reminders.inQuiet(12 * 60, 22 * 60 + 30, 7 * 60), false);
});

test('parseCbs finds the Euro95 price', () => {
  assert.deepEqual(fuel.parseCbs({ value: [{ Perioden: '20261002', BenzineEuro95_1: 2.087, Diesel_2: 1.79 }] }), { eur_l: 2.087, date: '2026-10-02', field: 'BenzineEuro95_1' });
  assert.equal(fuel.parseCbs({ value: [] }), null);
});

test('push targets', () => {
  assert.deepEqual(webPush.parseTarget('loxsuite-push://all'), { all: true });
  assert.deepEqual(webPush.parseTarget('loxsuite-push://user/3'), { userId: 3 });
  assert.equal(webPush.parseTarget('tgram://x'), null);
  assert.equal(webPush.isPushUrl('loxsuite-push://all'), true);
  const p = webPush.eventToPayload({ title: 'T', message: 'M', fields: [{ label: 'A', value: 'B' }], actions: [{ action: 'skip', title: 'Not today' }] });
  assert.deepEqual([p.title, p.body, p.actions.length], ['T', 'M\nA: B', 1]);
});

test('identifyVehicle by tag, user, plugged state or the only car', () => {
  const list = [{ id: 1, name: 'Skoda', id_tags: 'EC B0 2B 05 8D 41 4C 27 EC', loxone_users: 'Dave Rutten' }, { id: 2, name: 'Other', loxone_users: 'Anne' }];
  assert.equal(vehicles.identifyVehicle(list, { idTag: 'B02B058D414C27' }).id, 1);
  assert.equal(vehicles.identifyVehicle(list, { loxoneUser: 'anne' }).id, 2);
  assert.equal(vehicles.identifyVehicle(list, { pluggedIds: [2] }).id, 2);
  assert.equal(vehicles.identifyVehicle(list, {}), null);
  assert.equal(vehicles.identifyVehicle([list[0]], {}).id, 1);
});

test('quarter export leaves out sessions of cars that are not reported', () => {
  const rows = buildQuarterRows({
    tracker: [{ connect: 1000, disconnect: 2000, energy: 5 }, { connect: 3000, disconnect: 4000, energy: 7 }],
    recorded: [{ started_at: new Date(3000 * 1000).toISOString(), stopped_at: new Date(4000 * 1000).toISOString(), meter_start_wh: 5000, meter_stop_wh: 12000, vehicle_id: 2 }],
    currentTotalKwh: 12, start: 0, end: 10000, excludeVehicleIds: [2],
  }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].energy, 5);
});

test('web push: the VAPID contact must be real (Apple rejects made-up ones) and refusals are explained', () => {
  const w = require('../src/webPush');
  assert.equal(w.validSubject('mailto:admin@loxsuite.local'), null);
  assert.equal(w.validSubject('https://loxsuite.example.nl/'), 'https://loxsuite.example.nl');
  assert.equal(w.validSubject('mailto:me@example.nl'), 'mailto:me@example.nl');
  assert.equal(w.validSubject('http://192.168.1.5:5582'), null);
  assert.match(w.explainError({ statusCode: 403, body: '{"reason":"BadJwtToken"}' }), /403.*BadJwtToken.*Push contact/);
  assert.match(w.explainError({ statusCode: 400, body: 'bad' }), /switch push off and on again/);
  assert.equal(w.explainError(new Error('boom')), 'boom');
});

test('a small top-up runs at the minimum power for longer, never below 4.16 kW and never 11 kW for a minute', () => {
  const now = Date.parse('2026-10-04T14:30:00Z');
  const slots = [{ start: '2026-10-04T14:30:00Z', end: '2026-10-04T14:45:00Z', price: 0.2, pvKw: 0 }, { start: '2026-10-04T14:45:00Z', end: '2026-10-04T15:00:00Z', price: 0.3, pvKw: 0 }];
  const p = planner.makePlan({ nowMs: now, needKwh: 0.26, slots, mode: 'plan', minKw: 4.16, maxKw: 11 });
  assert.equal(p.slots.length, 1);
  assert.equal(p.slots[0].kw, 4.16);
  const min = (Date.parse(p.slots[0].end) - Date.parse(p.slots[0].start)) / 60000;
  assert.ok(min > 3.5 && min < 4, `${min} min`);
  const q = planner.makePlan({ nowMs: now, needKwh: 1.5, slots, mode: 'plan', minKw: 4.16, maxKw: 11 });
  assert.equal(q.slots[0].kw, 6); // 1.5 kWh in a 15-min interval = 6 kW for the whole interval
});

test('a full battery stays full until it is unplugged', () => {
  const f = planner.sessionFull;
  const connectAt = Date.parse('2026-10-04T14:42:00Z');
  assert.equal(f({ sessionKey: 's1', done: true }), true);
  assert.equal(f({ sessionKey: 's1', fullKey: 's1' }), true, 'remembered (also after a restart)');
  assert.equal(f({ sessionKey: 's2', fullKey: 's1' }), false, 'a new plug-in starts fresh');
  assert.equal(f({ sessionKey: 'none', fullKey: 'none', done: true }), false);
  // A battery % only counts when it was reported after the plug-in (a stale 99% from before the trip doesn't).
  assert.equal(f({ sessionKey: 's1', reading: { soc: 99.5 }, readingAt: connectAt + 60000, connectAt, limitPct: 100 }), true);
  assert.equal(f({ sessionKey: 's1', reading: { soc: 99.5 }, readingAt: connectAt - 3600000, connectAt, limitPct: 100 }), false);
  assert.equal(f({ sessionKey: 's1', reading: { soc: 80 }, readingAt: connectAt + 60000, connectAt, limitPct: 80 }), true, 'own charge limit');
  assert.equal(f({ sessionKey: 's1', chargeState: 'CHARGING_COMPLETE' }), true);
  assert.equal(f({ sessionKey: 's1', chargeState: 'plugged_out' }), false);
});

test('without enough solar: the car is filled in the cheapest intervals (full power there), never below the minimum', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const slots = [0.30, 0.18, 0.19, 0.25, 0.20].map((price, i) => ({ start: new Date(now + i * 3600000).toISOString(), end: new Date(now + (i + 1) * 3600000).toISOString(), price, pvKw: 0 }));
  const p = planner.makePlan({ nowMs: now, needKwh: 12, slots, mode: 'plan', minKw: 4.16, maxKw: 11 });
  const at = (price) => p.slots.find((s) => s.price === price);
  assert.equal(at(0.18).kw, 11);                // cheapest hour at full power: 11 kWh
  assert.equal(at(0.19).kw, 4.16);              // the last 1 kWh in the next-cheapest hour, at the minimum
  assert.ok(Math.abs(at(0.19).kwh - 1) < 0.01);
  assert.ok(!p.slots.some((s) => s.price >= 0.20));
  assert.ok(p.slots.every((s) => s.kw >= 4.16));
  // Some solar below the minimum: topped up from the grid to (at least) the minimum, labelled solar + grid
  const r = planner.makePlan({ nowMs: now, needKwh: 3, slots: [{ ...slots[1], pvKw: 2 }], mode: 'plan', minKw: 4.16, maxKw: 11 });
  assert.equal(r.slots[0].kw, 4.16);
  assert.equal(r.slots[0].source, 'mixed');
  // "Now" charges at full power
  const n = planner.makePlan({ nowMs: now, needKwh: 5, slots, mode: 'now', minKw: 4.16, maxKw: 11 });
  assert.equal(n.slots[0].kw, 11);
});

test('agenda.parseClimate: off/empty -> null, else 16–29.5 °C in half degrees', () => {
  const agenda = require('../src/agenda');
  assert.equal(agenda.parseClimate(''), null);
  assert.equal(agenda.parseClimate('off'), null);
  assert.equal(agenda.parseClimate('20'), 20);
  assert.equal(agenda.parseClimate('21,3'), 21.5);
  assert.equal(agenda.parseClimate(12), 16);
  assert.equal(agenda.parseClimate(40), 29.5);
});

test('makePlan counts the solar part of a mixed interval (solar below the Wallbox minimum)', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const slots = hourlySlots('2026-10-05T10:00:00Z', [0.30, 0.15, 0.30], [0, 3, 0]);
  const plan = planner.makePlan({ nowMs: now, needKwh: 11, slots, solarTrust: 'expected', minKw: 4.16, maxKw: 11 });
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0].source, 'mixed');
  assert.equal(plan.slots[0].pvKwh, 3);
  assert.equal(plan.pvKwh, 3);
  assert.equal(plan.gridKwh, 8);
  assert.ok(plan.notes.some((n) => /below the Wallbox minimum/.test(n)));
});
