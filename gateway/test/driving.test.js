const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, emptyLevel, chargingCost, costPerKm, effectiveKwhPerKm } = require('../src/driving');

const H = 3600000;
const T0 = Date.parse('2026-09-01T06:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();

test('a full-electric car: trips, learned kWh/100 km, all km electric', () => {
  // 64 kWh: 1% = 0.64 kWh. Trip 1: 40 km, 12% -> 7.68 kWh = 19.2 kWh/100 km. Trip 2: 20 km, 6%.
  const readings = [
    { ts: at(0), soc: 80, odometer_km: 1000 },
    { ts: at(0.5), soc: 74, odometer_km: 1020 },
    { ts: at(1), soc: 68, odometer_km: 1040 },
    { ts: at(5), soc: 68, odometer_km: 1040 },   // parked 4 h
    { ts: at(5.5), soc: 62, odometer_km: 1060 },
    { ts: at(8), soc: 62, odometer_km: 1060 },
  ];
  const a = analyze(readings, { capacityKwh: 64, type: 'bev' });
  assert.equal(a.trips.length, 2);
  assert.equal(a.trips[0].km, 40);
  assert.equal(a.trips[0].kwh, 7.7);
  assert.equal(a.trips[0].kwhPer100, 19.2);
  assert.equal(a.consumption.kwhPer100, 19.2);
  assert.equal(a.consumption.km, 60);
  assert.equal(a.byMonth[0].km, 60);
  assert.equal(a.byMonth[0].elecKm, 60);
  assert.equal(a.byMonth[0].fuelKm, 0);
});

test('charging between readings is never counted as consumption', () => {
  const readings = [
    { ts: at(0), soc: 30, odometer_km: 500 },
    { ts: at(1), soc: 50, odometer_km: 500, charging: 1 },
    { ts: at(2), soc: 90, odometer_km: 500 },
    { ts: at(3), soc: 80, odometer_km: 530 },
  ];
  const a = analyze(readings, { capacityKwh: 64, type: 'bev' });
  assert.equal(a.trips.length, 1);
  assert.equal(a.trips[0].km, 30);
  assert.equal(a.consumption.samples, 1); // only the real drive 90 -> 80
  assert.equal(a.consumption.kwhPer100, 21.3);
});

test('a plug-in hybrid: the empty level is learned and km past it go on fuel', () => {
  // 26 kWh (Skoda PHEV), runs down to 14% and stays there.
  const r = [];
  let odo = 10000;
  for (let day = 0; day < 6; day++) {
    const t = day * 24;
    r.push({ ts: at(t), soc: 100, odometer_km: odo });
    odo += 30; r.push({ ts: at(t + 0.5), soc: 77, odometer_km: odo }); // 30 km, 23% = 5.98 kWh -> ~0.2 kWh/km
    r.push({ ts: at(t + 4), soc: 77, odometer_km: odo });
    odo += 60; r.push({ ts: at(t + 5), soc: 14, odometer_km: odo });   // 63% = 16.4 kWh -> ~82 km possible, 60 driven? capped
    r.push({ ts: at(t + 8), soc: 14, odometer_km: odo });
    odo += 40; r.push({ ts: at(t + 9), soc: 14, odometer_km: odo });   // empty: all fuel
    r.push({ ts: at(t + 12), soc: 14, odometer_km: odo, charging: 1 });
  }
  const a = analyze(r, { capacityKwh: 26, type: 'phev' });
  assert.equal(emptyLevel(r.map((x) => ({ soc: x.soc })), 'phev'), 14);
  assert.equal(a.emptyLevel, 14);
  assert.ok(Math.abs(a.consumption.kwhPerKm - 0.199) < 0.01, `kWh/km ${a.consumption.kwhPerKm}`);
  const m = a.byMonth[0];
  assert.equal(m.km, 6 * 130);
  assert.ok(m.fuelKm >= 6 * 40, `fuel km ${m.fuelKm}`);
  assert.ok(m.elecKm >= 6 * 89 && m.elecKm <= 6 * 90, `elec km ${m.elecKm}`);
  assert.equal(a.trips.length, 18);
});

test('a hybrid that never gets low has no empty level', () => {
  assert.equal(emptyLevel([{ soc: 60 }, { soc: 40 }], 'phev'), 0);
  assert.equal(emptyLevel([{ soc: 3 }], 'bev'), 0);
});

test('odometer glitches and missing battery data', () => {
  const a = analyze([
    { ts: at(0), soc: null, odometer_km: 100 },
    { ts: at(1), soc: null, odometer_km: 99000 }, // glitch: ignored
    { ts: at(2), soc: null, odometer_km: 99010 },
  ], { capacityKwh: 26, type: 'phev' });
  assert.equal(a.byMonth[0].km, 10);
  assert.equal(a.byMonth[0].unknownKm, 10);
  assert.equal(a.consumption.confidence, 'none');
  assert.equal(analyze([], {}).hasOdometer, false);
});

test('charging cost: grid part at the hour price, solar at its feed-in value', () => {
  const hours = [
    { hour: '2026-09-01T10:00:00Z', wallboxKwh: 10, gridImportKwh: 2, price: 0.30 },  // 8 kWh solar
    { hour: '2026-09-01T23:00:00Z', wallboxKwh: 10, gridImportKwh: 11, price: 0.20 }, // all grid
    { hour: '2026-09-02T23:00:00Z', wallboxKwh: 5, gridImportKwh: 5, price: null },   // no price: skipped
  ];
  const fixed = chargingCost(hours, { feedIn: 'fixed', feedInEur: 0.05 });
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].kwh, 20);
  assert.equal(fixed[0].solarShare, 40);
  assert.equal(fixed[0].eur, 2 * 0.30 + 8 * 0.05 + 10 * 0.20);
  const sal = chargingCost(hours, { feedIn: 'saldering' });
  assert.equal(sal[0].eur, 10 * 0.30 + 10 * 0.20);
});

test('cost per km and the consumption to plan with', () => {
  assert.deepEqual(costPerKm({ eurPerKwh: 0.25, kwhPerKm: 0.2, fuelEurL: 2.0, lPer100km: 6 }), { elec: 0.05, fuel: 0.12 });
  assert.deepEqual(costPerKm({ eurPerKwh: null, kwhPerKm: 0.2, fuelEurL: 2, lPer100km: null }), { elec: null, fuel: null });
  assert.equal(effectiveKwhPerKm({ kwh_per_km: 0.18, kwh_per_km_learned: 0.22 }), 0.18);
  assert.equal(effectiveKwhPerKm({ kwh_per_km: null, kwh_per_km_learned: 0.22 }), 0.22);
  assert.equal(effectiveKwhPerKm({}, 0.2), 0.2);
  assert.equal(effectiveKwhPerKm(null, 0.25), 0.25);
});
