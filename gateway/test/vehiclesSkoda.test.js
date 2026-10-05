const test = require('node:test');
const assert = require('node:assert');
const v = require('../src/vehicles');

const SAMPLE = {
  vehicle: {
    vin: 'TMBJB9NY5RF999999', name: 'My Superb', licensePlate: 'AB-123-C',
    fuelStatus: {
      carType: 'HYBRID', totalRangeInKm: 780,
      primaryEngineRange: { engineType: 'GASOLINE', currentFuelLevelInPercent: 64, remainingRangeInKm: 690 },
      secondaryEngineRange: { engineType: 'ELECTRIC', currentSoCInPercent: 81, remainingRangeInKm: 90 },
      carCapturedTimestamp: '2026-10-05T08:00:00Z',
    },
    odometer: { mileageInKm: 23456, carCapturedTimestamp: '2026-10-05T08:01:00Z' },
    parkingPosition: { state: 'PARKED', gpsCoordinates: { latitude: 52.1, longitude: 5.1 }, formattedAddress: 'Thuis 1, Utrecht' },
    charging: {
      status: { state: 'CHARGING', chargePowerInKw: 3.6, remainingTimeToFullyChargedInMinutes: 75, plugConnectionState: 'CONNECTED', battery: { stateOfChargeInPercent: 82, remainingCruisingRangeInMeters: 91000 } },
      settings: { targetStateOfChargeInPercent: 100 }, carCapturedTimestamp: '2026-10-05T08:02:00Z',
    },
  },
  errors: [],
};

test('parseSkoda maps the official API onto the vehicle fields (PHEV: electric range from the battery)', () => {
  const { raw, updatedAt, extra } = v.parseSkoda(SAMPLE);
  assert.deepEqual(raw, { soc: 82, range_km: 91, total_range_km: 780, plugged: true, charging: true, limit_soc: 100, odometer_km: 23456, latitude: 52.1, longitude: 5.1, location: 'Thuis 1, Utrecht' });
  assert.equal(updatedAt, '2026-10-05T08:02:00Z');
  assert.equal(extra.fuelPct, 64);
  assert.equal(extra.chargePowerKw, 3.6);
  const r = v.normalizeReading(raw, { battery_kwh: 26, home_lat: 52.1, home_lon: 5.1 });
  assert.equal(r.energy_kwh, 21.3);
  assert.equal(r.home, true);
});

test('readSkoda sends the API key, reads the rate-limit headers and explains problems', async () => {
  const headers = (h) => ({ get: (n) => h[n] ?? null });
  let seen = null;
  const ok = async (url, opts) => { seen = { url, key: opts.headers['X-API-Key'] }; return { ok: true, status: 200, headers: headers({ 'X-API-Key-Expires-At': '2027-01-01T00:00:00Z', 'RateLimit-Remaining': '17' }), text: async () => JSON.stringify(SAMPLE) }; };
  const res = await v.readSkoda({ vin: 'tmbjb9ny5rf999999' }, 'k123', { fetchFn: ok });
  assert.equal(seen.url, 'https://public.api.connect.skoda-auto.cz/api/v1/vehicles/TMBJB9NY5RF999999');
  assert.equal(seen.key, 'k123');
  assert.equal(res.meta.rateRemaining, 17);
  assert.equal(res.meta.keyExpiresAt, '2027-01-01T00:00:00Z');
  const limited = async () => ({ ok: false, status: 429, headers: headers({ 'Retry-After': '1200' }), text: async () => JSON.stringify({ type: 'https://public.api.connect.skoda-auto.cz/problems/rate-limit-exceeded' }) });
  await assert.rejects(v.readSkoda({ vin: 'TMBJB9NY5RF999999' }, 'k', { fetchFn: limited }), (e) => /rate limit/.test(e.message) && e.meta.retryAfterS === 1200);
  const expired = async () => ({ ok: false, status: 401, headers: headers({}), text: async () => JSON.stringify({ type: 'https://public.api.connect.skoda-auto.cz/problems/api-key-expired' }) });
  await assert.rejects(v.readSkoda({ vin: 'TMBJB9NY5RF999999' }, 'k', { fetchFn: expired }), /expired/);
  await assert.rejects(v.readSkoda({ vin: 'SHORT' }, 'k', { fetchFn: ok }), /VIN/);
});

test('Škoda: stored as http + provider, polled within the 20/h limit', () => {
  const car = { source_type: 'http', source_config: JSON.stringify({ provider: 'skoda', vin: 'TMBJB9NY5RF999999' }) };
  assert.equal(v.sourceKind(car), 'skoda');
  assert.equal(v.pollIntervalS(car), 600);
  assert.equal(v.pollIntervalS(car, undefined, { fast: true }), 240);
  assert.equal(v.pollIntervalS({ ...car, source_config: JSON.stringify({ provider: 'skoda', interval_s: 60 }) }), 600);
  assert.equal(v.sourceKind({ source_type: 'http', source_config: '{}' }), 'http');
});
