const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  parseNumber, parseBool, getPath, normalizeReading, readingChanged, guessHomeyFields, guessHaFields,
  readHaFromStates, readMqtt, sourceHealth, parseHeaderLines, homeyBase, haBase, listHomeyDevices, listHaEntities,
  readVehicle, vehicleTopics, pollIntervalS, staleAfterH,
} = require('../src/vehicles');
const { encrypt } = require('../src/secretCrypto');
const { parseForm } = require('../src/routes/vehicles');

test('parseNumber reads the shapes sources send', () => {
  assert.equal(parseNumber('78'), 78);
  assert.equal(parseNumber('78 %'), 78);
  assert.equal(parseNumber('78,5'), 78.5);
  assert.equal(parseNumber(64), 64);
  assert.equal(parseNumber({ value: 12 }), 12);
  assert.equal(parseNumber('unavailable'), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(''), null);
});

test('parseBool knows plug/charge states per field', () => {
  assert.equal(parseBool(true), true);
  assert.equal(parseBool('on'), true);
  assert.equal(parseBool('off'), false);
  assert.equal(parseBool(0), false);
  assert.equal(parseBool('unknown'), null);
  // Homey ev_charging_state
  assert.equal(parseBool('plugged_in', 'plugged'), true);
  assert.equal(parseBool('plugged_in', 'charging'), false);
  assert.equal(parseBool('plugged_in_charging', 'plugged'), true);
  assert.equal(parseBool('plugged_in_charging', 'charging'), true);
  assert.equal(parseBool('plugged_in_paused', 'charging'), false);
  assert.equal(parseBool('plugged_out', 'plugged'), false);
  assert.equal(parseBool('plugged_in_discharging', 'charging'), false);
  // Skoda / VW style texts
  assert.equal(parseBool('Connected', 'plugged'), true);
  assert.equal(parseBool('Disconnected', 'plugged'), false);
  assert.equal(parseBool('Charging', 'charging'), true);
  assert.equal(parseBool('Not charging', 'charging'), false);
  assert.equal(parseBool('ready_for_charging', 'charging'), false);
  // MySkoda charging-state enums: CONNECT_CABLE = no cable yet; the rest means the cable is in
  assert.equal(parseBool('CONNECT_CABLE', 'plugged'), false);
  assert.equal(parseBool('CONNECT_CABLE', 'charging'), false);
  assert.equal(parseBool('READY_FOR_CHARGING', 'plugged'), true);
  assert.equal(parseBool('CONSERVING', 'plugged'), true);
  assert.equal(parseBool('CONSERVING', 'charging'), false);
  assert.equal(parseBool('CHARGING', 'plugged'), true);
  assert.equal(parseBool('plugged_in_discharging', 'plugged'), true);
});

test('local sources are polled every minute while a car is (probably) at the Wallbox', () => {
  const homey = { source_type: 'homey', source_config: JSON.stringify({ interval_s: 300 }) };
  const ha = { source_type: 'homeassistant', source_config: JSON.stringify({ interval_s: 30 }) };
  const http = { source_type: 'http', source_config: JSON.stringify({ interval_s: 300 }) };
  assert.equal(pollIntervalS(homey), 300);
  assert.equal(pollIntervalS(homey, undefined, { fast: true }), 60);
  assert.equal(pollIntervalS(ha, undefined, { fast: true }), 60);
  assert.equal(pollIntervalS(http, undefined, { fast: true }), 300);
});

test('getPath picks values out of JSON, also from a string payload', () => {
  const o = { data: { battery: { soc: 81 } }, cars: [{ range: 40 }] };
  assert.equal(getPath(o, 'data.battery.soc'), 81);
  assert.equal(getPath(o, 'cars[0].range'), 40);
  assert.equal(getPath(JSON.stringify(o), 'data.battery.soc'), 81);
  assert.equal(getPath('42', ''), '42');
  assert.equal(getPath('not json', 'a.b'), undefined);
  assert.equal(getPath(o, 'data.nope.x'), undefined);
});

test('normalizeReading: values, energy and home by coordinates', () => {
  const v = { battery_kwh: 26, home_lat: 51.6, home_lon: 5.5, home_radius_m: 150 };
  const r = normalizeReading({ soc: '50', range_km: '60 km', plugged: 'plugged_out', latitude: 51.6005, longitude: 5.5005 }, v);
  assert.equal(r.soc, 50);
  assert.equal(r.energy_kwh, 13);
  assert.equal(r.range_km, 60);
  assert.equal(r.plugged, false);
  assert.equal(r.home, true);
  assert.ok(r.distance_m > 0 && r.distance_m < 150);
  const away = normalizeReading({ latitude: 52.09, longitude: 5.12 }, v);
  assert.equal(away.home, false);
  assert.ok(away.distance_m > 50000);
});

test('normalizeReading: home by location text, plugged implies home, soc clamped', () => {
  assert.equal(normalizeReading({ location: 'Home' }, { home_value: 'home' }).home, true);
  assert.equal(normalizeReading({ location: 'not_home' }, { home_value: 'home' }).home, false);
  assert.equal(normalizeReading({ plugged: true }, {}).home, true);
  assert.equal(normalizeReading({ soc: 0.62 }, {}).soc, 62);
  assert.equal(normalizeReading({ soc: 140 }, {}).soc, 100);
  assert.equal(normalizeReading({ charging: true }, {}).plugged, true);
  assert.equal(normalizeReading({}, {}).home, null);
  assert.equal(normalizeReading({ soc: 50 }, {}).energy_kwh, null);
});

test('readingChanged only writes history on real changes or after a while', () => {
  const a = { soc: 50, plugged: true, charging: false, home: true };
  assert.equal(readingChanged(null, a, 0, 1000), true);
  assert.equal(readingChanged(a, { ...a, soc: 50.4 }, 0, 60000), false);
  assert.equal(readingChanged(a, { ...a, soc: 51 }, 0, 60000), true);
  assert.equal(readingChanged(a, { ...a, plugged: false }, 0, 60000), true);
  assert.equal(readingChanged(a, a, 0, 16 * 60000), true);
});

test('guessHomeyFields maps typical car-app capabilities', () => {
  const g = guessHomeyFields(['measure_battery', 'ev_charging_state', 'measure_range', 'meter_odometer', 'measure_latitude', 'measure_longitude', 'onoff']);
  assert.equal(g.soc, 'measure_battery');
  assert.equal(g.plugged, 'ev_charging_state');
  assert.equal(g.charging, 'ev_charging_state');
  assert.equal(g.range_km, 'measure_range');
  assert.equal(g.odometer_km, 'meter_odometer');
  assert.equal(g.latitude, 'measure_latitude');
  assert.equal(g.longitude, 'measure_longitude');
});

test('guessHaFields and readHaFromStates (state and attribute)', () => {
  const states = [
    { entity_id: 'sensor.skoda_battery_level', state: '64', attributes: {}, last_updated: '2026-10-04T08:00:00Z' },
    { entity_id: 'sensor.skoda_electric_range', state: '41', attributes: {}, last_updated: '2026-10-04T08:00:00Z' },
    { entity_id: 'binary_sensor.skoda_charger_connected', state: 'on', attributes: {}, last_updated: '2026-10-04T08:05:00Z' },
    { entity_id: 'device_tracker.skoda_position', state: 'home', attributes: { latitude: 51.6, longitude: 5.5 }, last_updated: '2026-10-04T07:00:00Z' },
    { entity_id: 'light.kitchen', state: 'off', attributes: {} },
  ];
  const g = guessHaFields(states.map((s) => s.entity_id));
  assert.equal(g.soc.entity, 'sensor.skoda_battery_level');
  assert.equal(g.range_km.entity, 'sensor.skoda_electric_range');
  assert.equal(g.plugged.entity, 'binary_sensor.skoda_charger_connected');
  assert.deepEqual(g.latitude, { entity: 'device_tracker.skoda_position', attribute: 'latitude' });
  const cfg = { fields: { ...g, odometer_km: { entity: 'sensor.gone' } } };
  const res = readHaFromStates(cfg, states);
  assert.equal(res.raw.soc, '64');
  assert.equal(res.raw.latitude, 51.6);
  assert.equal(res.raw.location, 'home');
  assert.equal(res.updatedAt, '2026-10-04T08:05:00Z');
  assert.deepEqual(res.missing, ['sensor.gone']);
  const r = normalizeReading(res.raw, { battery_kwh: 26, home_value: 'home' });
  assert.equal(r.soc, 64);
  assert.equal(r.plugged, true);
  assert.equal(r.home, true);
});

test('readMqtt reads mapped topics from the broker cache, with JSON paths', () => {
  const cache = {
    'nodered/car/soc': { value: '55', lastSeen: '2026-10-04T08:00:00.000Z' },
    'nodered/car/state': { value: '{"plug":"connected","pos":{"lat":51.6}}', lastSeen: '2026-10-04T08:01:00.000Z' },
  };
  const cfg = { fields: { soc: { topic: 'nodered/car/soc' }, plugged: { topic: 'nodered/car/state', path: 'plug' }, latitude: { topic: 'nodered/car/state', path: 'pos.lat' }, range_km: { topic: 'missing/topic' } } };
  const res = readMqtt(cfg, (t) => cache[t] || null);
  assert.equal(res.raw.soc, '55');
  assert.equal(res.raw.plugged, 'connected');
  assert.equal(res.raw.latitude, 51.6);
  assert.equal(res.updatedAt, '2026-10-04T08:01:00.000Z');
  assert.deepEqual(res.missing, ['missing/topic']);
});

test('readVehicle with an MQTT source reports topics not seen yet', async () => {
  const v = { id: 1, source_type: 'mqtt', source_config: JSON.stringify({ fields: { soc: { topic: 'x/soc' } } }) };
  const none = await readVehicle(v, { getTopicValue: () => null });
  assert.equal(none.ok, false);
  assert.match(none.error, /No message seen yet on x\/soc/);
  const ok = await readVehicle({ ...v, battery_kwh: 26 }, { getTopicValue: () => ({ value: '50', lastSeen: '2026-10-04T08:00:00Z' }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.reading.energy_kwh, 13);
});

test('sourceHealth: failing after repeated errors or stale data, MQTT gets a grace period', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const polled = { source_type: 'homey', source_config: JSON.stringify({ stale_after_h: 6 }) };
  assert.equal(sourceHealth(polled, null, now).status, 'unknown');
  assert.equal(sourceHealth(polled, { error: 'HTTP 401', failCount: 1 }, now).status, 'unknown');
  assert.deepEqual(sourceHealth(polled, { error: 'HTTP 401', failCount: 2 }, now), { status: 'failing', detail: 'HTTP 401' });
  assert.equal(sourceHealth(polled, { sourceUpdatedAt: '2026-10-04T09:00:00Z' }, now).status, 'ok');
  const stale = sourceHealth(polled, { sourceUpdatedAt: '2026-10-04T03:00:00Z' }, now);
  assert.equal(stale.status, 'failing');
  assert.match(stale.detail, /no update for 9 h \(limit 6 h\)/);
  const off = { source_type: 'homey', source_config: JSON.stringify({ stale_after_h: 0 }) };
  assert.equal(sourceHealth(off, { sourceUpdatedAt: '2026-09-01T00:00:00Z' }, now).status, 'ok');
  const mqtt = { source_type: 'mqtt', source_config: '{}' };
  assert.equal(sourceHealth(mqtt, { error: 'No message', errorSince: now - 60000, failCount: 5 }, now).status, 'unknown');
  assert.equal(sourceHealth(mqtt, { error: 'No message', errorSince: now - 11 * 60000, failCount: 40 }, now).status, 'failing');
  assert.equal(staleAfterH({}), 24);
});

test('small helpers', () => {
  assert.deepEqual(parseHeaderLines('Authorization: Bearer abc\nX-Key:  1:2 \nbad line'), { Authorization: 'Bearer abc', 'X-Key': '1:2' });
  assert.equal(homeyBase('192.168.15.20/'), 'http://192.168.15.20');
  assert.equal(haBase('http://ha.local:8123/api/'), 'http://ha.local:8123');
  assert.equal(vehicleTopics(3).soc, 'loxsuite/vehicles/3/soc');
  assert.equal(pollIntervalS({ source_config: '{"interval_s":10}' }), 300);
  assert.equal(pollIntervalS({ source_config: '{"interval_s":600}' }), 600);
});

test('route parseForm builds the source config per type', () => {
  const homey = parseForm({ name: 'Skoda', type: 'phev', battery_kwh: '26', source_type: 'homey', homey_url: '192.168.15.20', homey_device_id: 'abc', homey_cap_soc: 'measure_battery', homey_key: 'k', stale_after_h: '12' });
  assert.equal(homey.error, undefined);
  assert.equal(homey.values.reserve_pct, 0);
  const cfg = JSON.parse(homey.values.source_config);
  assert.deepEqual(cfg.fields, { soc: { capability: 'measure_battery' } });
  assert.equal(cfg.stale_after_h, 12);
  assert.equal(cfg.interval_s, 300);
  assert.equal(homey.values.secret, 'k');
  assert.equal(parseForm({ name: 'x', type: 'bev' }).values.reserve_pct, 15);
  assert.match(parseForm({ name: 'x', source_type: 'mqtt' }).error, /at least one MQTT topic/);
  assert.match(parseForm({ name: 'x', source_type: 'http', http_url: 'ftp://x' }).error, /http/);
  assert.match(parseForm({ name: 'x', battery_kwh: '999' }).error, /battery kwh/);
  assert.match(parseForm({ name: 'x', home_lat: '51.6' }).error, /latitude and longitude/);
  assert.match(parseForm({}).error, /Name/);
});

// A fake Homey Pro and Home Assistant on localhost: the real HTTP path end to end.
function fakeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('Homey and Home Assistant sources over HTTP (fake servers)', async () => {
  const homey = await fakeServer((req, res) => {
    if (req.headers.authorization !== 'Bearer homey-key') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    const car = {
      id: 'car1', name: 'Skoda Superb iV', class: 'car', zoneName: 'Oprit',
      capabilities: ['measure_battery', 'ev_charging_state', 'measure_range'],
      capabilitiesObj: {
        measure_battery: { value: 72, lastUpdated: '2026-10-04T08:00:00.000Z' },
        ev_charging_state: { value: 'plugged_in_charging', lastUpdated: '2026-10-04T08:10:00.000Z' },
        measure_range: { value: 44, lastUpdated: '2026-10-04T08:00:00.000Z' },
      },
    };
    const lamp = { id: 'l1', name: 'Lamp', class: 'light', capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/manager/devices/device/') return res.end(JSON.stringify({ l1: lamp, car1: car }));
    if (req.url === '/api/manager/devices/device/car1') return res.end(JSON.stringify(car));
    res.writeHead(404); return res.end('{}');
  });
  const ha = await fakeServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ha-token' || req.url !== '/api/states') { res.writeHead(401); return res.end('401: Unauthorized'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { entity_id: 'sensor.superb_battery_level', state: '72', attributes: { unit_of_measurement: '%', friendly_name: 'Superb battery' }, last_updated: '2026-10-04T08:00:00Z' },
      { entity_id: 'device_tracker.superb_position', state: 'not_home', attributes: { latitude: 52.09, longitude: 5.12 }, last_updated: '2026-10-04T08:00:00Z' },
    ]));
  });
  try {
    const hUrl = `http://127.0.0.1:${homey.address().port}`;
    const devices = await listHomeyDevices(hUrl, 'homey-key');
    assert.equal(devices[0].id, 'car1');
    assert.equal(devices[0].values.measure_battery, 72);
    await assert.rejects(listHomeyDevices(hUrl, 'wrong'), /HTTP 401/);

    const vehicle = {
      id: 9, battery_kwh: 13, source_type: 'homey', secret: encrypt('homey-key'),
      source_config: JSON.stringify({ url: hUrl, device_id: 'car1', fields: { soc: { capability: 'measure_battery' }, plugged: { capability: 'ev_charging_state' }, charging: { capability: 'ev_charging_state' }, range_km: { capability: 'measure_range' } } }),
    };
    const r = await readVehicle(vehicle);
    assert.equal(r.ok, true);
    assert.equal(r.reading.soc, 72);
    assert.equal(r.reading.plugged, true);
    assert.equal(r.reading.charging, true);
    assert.equal(r.reading.home, true);
    assert.equal(r.reading.energy_kwh, 9.4);
    assert.equal(r.sourceUpdatedAt, '2026-10-04T08:10:00.000Z');
    const down = await readVehicle({ ...vehicle, source_config: vehicle.source_config.replace(hUrl, 'http://127.0.0.1:1') });
    assert.match(down.error, /^Cannot reach 127\.0\.0\.1:1 \(.+\)\.$/);
    const bad = await readVehicle({ ...vehicle, secret: encrypt('wrong') });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /401/);

    const aUrl = `http://127.0.0.1:${ha.address().port}`;
    const ents = await listHaEntities(aUrl, 'ha-token');
    assert.ok(ents.every((e) => e.carish));
    const haVehicle = {
      id: 10, source_type: 'homeassistant', secret: encrypt('ha-token'), home_lat: 51.6, home_lon: 5.5,
      source_config: JSON.stringify({ url: aUrl, fields: { soc: { entity: 'sensor.superb_battery_level' }, latitude: { entity: 'device_tracker.superb_position', attribute: 'latitude' }, longitude: { entity: 'device_tracker.superb_position', attribute: 'longitude' } } }),
    };
    const hr = await readVehicle(haVehicle);
    assert.equal(hr.ok, true);
    assert.equal(hr.reading.soc, 72);
    assert.equal(hr.reading.home, false);
  } finally {
    homey.close();
    ha.close();
  }
});
