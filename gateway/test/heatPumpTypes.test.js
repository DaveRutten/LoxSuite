// Heat pump types (energyTypes.js + heatPumpTypes.js) with the Mitsubishi Ecodan over the MelcoBEMS
// MINI (A1M), the type built from the Loxone Library template. Values come through Loxone, already scaled.
const test = require('node:test');
const assert = require('node:assert/strict');
const hp = require('../src/heatPumpTypes');
const et = require('../src/energyTypes');

const ecodan = et.loadTypes('heatpump').find((t) => t.key === 'mitsubishi-ecodan-a1m');
const read = (byKey) => et.fromRaw(ecodan, byKey);

test('the Ecodan A1M type has what the module needs, with the Loxone names', () => {
  assert.ok(ecodan);
  assert.deepEqual(et.check('heatpump', ecodan), { ok: true, missing: [], unknown: [], notWritable: [] });
  assert.equal(et.byRole(ecodan, 'tankTemp').label, 'Tank Water Temp Actual');
  assert.equal(et.byRole(ecodan, 'forceDhw').rw, 'rw');
  assert.equal(et.byRole(ecodan, 'dhwSetpoint').rw, 'rw');
  assert.equal(et.byRole(ecodan, 'roomSetpoint').rw, 'w');
  assert.equal(et.byRole(ecodan, 'valveDhw').extra, true, 'not in the Library template: add it in Loxone');
  assert.ok(et.loadTypes('heatpump').some((t) => t.key === 'custom'), 'own / other make is always there');
});

test('values from Loxone are not scaled again; enumerations get their text', () => {
  const v = read({ tank_water_temp_actual: 48.7, dhw_temperature_drop: 5, heat_source_phase_dhw: 2, force_dhw: 0 });
  assert.equal(v.tankTemp, 48.7);
  assert.equal(v.dhwDrop, 5);
  assert.equal(v.heatSourceText, 'Bijverwarming');
  assert.equal(v.forceDhwText, 'Normaal');
});

test('reads what it is doing: tap water by the 3-way valve, COP from the unit itself', () => {
  const v = read({ heat_pump_on_off: 1, heat_pump_frequency: 48, '3_way_valve': 1, consumed_power_actual: 1.5, produced_power_actual: 4.8, booster_heater_1: 0, immersion_heater: 0, heat_source_phase_dhw: 0 });
  const st = hp.interpret(v);
  assert.equal(st.mode, 'dhw');
  assert.equal(st.heatingTank, true);
  assert.equal(st.cop, 3.2);
  assert.equal(st.boost, false);
});

test('the booster heater is read from the unit, not guessed', () => {
  const st = hp.interpret(read({ heat_pump_on_off: 1, heat_pump_frequency: 0, booster_heater_1: 1, heat_source_phase_dhw: 2 }));
  assert.equal(st.boost, true);
  assert.match(st.boostWhy, /booster heater, Bijverwarming/);
});

test('without booster registers (own make) the boost is guessed from the power', () => {
  assert.equal(hp.interpret({ running: 1, compressorHz: 0, defrost: 0 }, { electricKw: 2.9 }).boost, true);
  assert.equal(hp.interpret({ running: 1, compressorHz: 0, defrost: 2 }, { electricKw: 1.2 }).boost, false, 'defrosting');
  assert.equal(hp.interpret({ running: 1, compressorHz: 70, defrost: 0 }, { electricKw: 5.2 }).boost, true, 'more than the compressor alone');
  assert.equal(et.check('heatpump', { registers: [] }).ok, false);
});

test('tap water now on the A1M: target setpoint + one Force DHW pulse, then nothing until it is done', () => {
  const now = read({ tank_water_temp_actual: 42, tank_water_temp_target: 48, dhw_temperature_drop: 5, force_dhw: 0 });
  const nowMs = Date.parse('2026-10-09T02:00:00Z');
  const w = hp.writesFor({ type: ecodan, plan: { mode: 'dhw' }, now, nowMs });
  assert.deepEqual(w.map((x) => [x.vi, x.value]), [['WP_Tapwater_Setpoint', 50], ['WP_Tapwater_Nu', 1]]);
  // ten minutes later the unit has put Force DHW back to 0 itself: no new pulse within the hour
  const later = hp.writesFor({ type: ecodan, plan: { mode: 'dhw' }, now: { ...now, dhwSetpoint: 50 }, last: { dhwSetpoint: { value: 50, ms: nowMs }, forceDhw: { value: 1, ms: nowMs } }, nowMs: nowMs + 600000 });
  assert.deepEqual(later, []);
});

test('hold: the unit itself only starts below the comfort minimum (its own drop read from the unit)', () => {
  const now = read({ tank_water_temp_actual: 50, tank_water_temp_target: 50, dhw_temperature_drop: 5 });
  assert.deepEqual(hp.writesFor({ type: ecodan, plan: { mode: 'free' }, now }), []); // 45 + 5 = 50: already there
  const w2 = hp.writesFor({ type: ecodan, plan: { mode: 'free' }, now: { ...now, dhwDrop: 8 } });
  assert.deepEqual(w2.map((x) => [x.role, x.value]), [['dhwSetpoint', 53]]);
});

test('room correction through the zone 1 thermostat; holiday is only a sensor in the Library template', () => {
  const now = read({ tank_water_temp_actual: 50, tank_water_temp_target: 50, dhw_temperature_drop: 5 });
  const w = hp.writesFor({ type: ecodan, plan: { mode: 'free', correctionC: 1, block: true }, now, settings: { baseRoomC: 20.5 } });
  assert.deepEqual(w.map((x) => [x.vi, x.value]), [['WP_Kamer_Setpoint', 21.5]]);
});

test('tap-water setpoint never above what the heat pump reaches alone', () => {
  assert.equal(hp.dhwSetpoint({ mode: 'dhw', tankC: 40, dropC: 10, targetC: 50, hpMaxC: 55 }), 51);
  assert.equal(hp.dhwSetpoint({ mode: 'dhw', tankC: 48, dropC: 10, targetC: 50, hpMaxC: 55 }), 55);
  assert.equal(hp.dhwSetpoint({ mode: 'dhw', tankC: 48, dropC: 10, targetC: 58, hpMaxC: 55, force: true }), 55);
});

test('a heat meter in the heating pipe counts while heating the house, not while making tap water', () => {
  const heating = hp.interpret({ running: 1, compressorHz: 40, valveDhw: 0, heatMeterPower: 4.2, thermalPower: 3.9, electricPower: 1.2 });
  assert.equal(heating.thermalKw, 4.2);
  assert.equal(heating.cop, 3.5);
  const dhw = hp.interpret({ running: 1, compressorHz: 52, valveDhw: 1, heatMeterPower: 0, thermalPower: 4.9, electricPower: 1.7 });
  assert.equal(dhw.thermalKw, 4.9);
});

test('on a fixed flow temperature the thermostat target is the flow: never a room temperature into it', () => {
  const now = read({ tank_water_temp_actual: 50, tank_water_temp_target: 50, dhw_temperature_drop: 5, heating_mode_zone_1: 1 });
  assert.equal(now.heatingMode, 1);
  const w = hp.writesFor({ type: ecodan, plan: { mode: 'free', roomC: 20.5 }, now });
  assert.deepEqual(w.filter((x) => x.role === 'roomSetpoint'), [], 'no 20.5 °C flow temperature');
  const tuned = hp.writesFor({ type: ecodan, plan: { mode: 'free', roomC: 20.5, flowC: 33 }, now });
  assert.deepEqual(tuned.map((x) => [x.vi || x.role, x.value]), [['WP_Kamer_Setpoint', 33]], 'the flow from the tuning, through the same register');
  // on room temperature it is the room plan
  const room = read({ tank_water_temp_actual: 50, tank_water_temp_target: 50, dhw_temperature_drop: 5, heating_mode_zone_1: 0 });
  assert.deepEqual(hp.writesFor({ type: ecodan, plan: { mode: 'free', roomC: 20.5 }, now: room }).map((x) => x.value), [20.5]);
});
