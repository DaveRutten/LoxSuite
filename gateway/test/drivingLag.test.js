const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../src/driving');

const T = (h, m) => Date.parse(`2026-10-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

test('battery updated before the odometer: the drop counts for the drive, charging afterwards does not', () => {
  const readings = [
    { t: T(6, 0), soc: 100, odometer_km: 1000 },
    { t: T(6, 20), soc: 45, odometer_km: 1054 }, // morning drive
    { t: T(11, 0), soc: 45, odometer_km: 1054 },
    { t: T(14, 50), soc: 1, odometer_km: 1054 }, // SoC already down, odometer still old
    { t: T(14, 52), soc: 1, odometer_km: 1054, charging: 1 },
    { t: T(14, 58), soc: 4, odometer_km: 1108, charging: 1 }, // odometer catches up, charging at home
  ];
  const r = analyze(readings, { capacityKwh: 25.7, type: 'phev', kwhPerKm: 0.26 });
  const last = r.trips[r.trips.length - 1];
  assert.strictEqual(last.km, 54);
  assert.ok(last.minutes >= 50, `minutes ${last.minutes}`);
  assert.strictEqual(last.socFrom, 45);
  assert.strictEqual(last.socTo, 1);
  assert.ok(last.elecKm > 30 && last.fuelKm > 0, `elec ${last.elecKm} fuel ${last.fuelKm}`);
});
