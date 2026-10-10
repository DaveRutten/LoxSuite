// Finding a heat pump / inverter in the Loxone structure (energyDiscovery.js), like Home Connect
// appliances: the Modbus outputs of one device are loose controls with a shared uuid start.
const test = require('node:test');
const assert = require('node:assert/strict');
const ed = require('../src/energyDiscovery');
const et = require('../src/energyTypes');
const hp = require('../src/heatPumpTypes');

const io = (name, state, extra = {}) => ({ name, type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: state }, ...extra });
const structure = {
  rooms: { r: { name: 'Technische ruimte' } }, cats: { c: { name: 'Verwarming' } },
  controls: {
    // the Ecodan: sensors, and two actuators visible in the app (they have a uuidAction)
    '20aa0001-0001-0001-ffff1': io('Tank Water Temp Actual', 's-tank'),
    '20aa0001-0002-0001-ffff1': io('Tank Water Temp Target', 's-target'),
    '20aa0001-0003-0001-ffff1': io('Set Tank Water Temperature', 's-set', { uuidAction: 'a-set' }),
    '20aa0001-0004-0001-ffff1': io('Force DHW', 's-force', { uuidAction: 'a-force' }),
    '20aa0001-0005-0001-ffff1': io('DHW Temperature Drop', 's-drop'),
    '20aa0001-0006-0001-ffff1': io('Booster Heater 1', 's-boost'),
    '20aa0001-0007-0001-ffff1': io('Heat Pump On-Off', 's-run'),
    '20aa0001-0008-0001-ffff1': io('Flow Temp', 's-flow'),
    // something else with a few outputs
    '30bb0001-0001-0001-ffff1': io('Vochtigheid', 'x1'),
    '30bb0001-0002-0001-ffff1': io('CO2', 'x2'),
    '30bb0001-0003-0001-ffff1': io('Temperatuur', 'x3'),
  },
};

test('finds the heat pump in Loxone, its sensor and "Set …" actuator as one role', () => {
  const [c, ...rest] = ed.fromStructure('heatpump', structure);
  assert.equal(rest.length, 0, 'the air-quality sensor is no heat pump');
  assert.equal(c.room, 'Technische ruimte');
  assert.deepEqual(c.roles.tankTemp, { read: { uuid: 's-tank', name: 'Tank Water Temp Actual', control: '20aa0001-0001-0001-ffff1' } });
  assert.deepEqual(c.roles.dhwSetpoint, { read: { uuid: 's-target', name: 'Tank Water Temp Target', control: '20aa0001-0002-0001-ffff1' }, write: { uuid: 'a-set', name: 'Set Tank Water Temperature' } });
  assert.equal(c.roles.forceDhw.write.uuid, 'a-force');
  assert.equal(c.check.ok, true);
});

test('recognises the known type by its names, and says what Loxone does not show yet', () => {
  const [c] = ed.fromStructure('heatpump', structure);
  assert.equal(c.known.key, 'mitsubishi-ecodan-a1m');
  assert.equal(c.name, 'Mitsubishi Ecodan (MelcoBEMS MINI A1M)');
  assert.ok(c.missingFromLoxone.some((m) => m.role === 'valveDhw' && m.reg === 152));
  assert.deepEqual(et.byRole(c.type, 'boosterHeater').map, { 0: 'Uit', 1: 'Aan' }, 'meaning taken from the known type');
});

test('writes go straight to the Loxone control, no virtual input needed', () => {
  const [c] = ed.fromStructure('heatpump', structure);
  const now = et.fromRaw(c.type, { tankTemp: 42, dhwSetpoint: 48, dhwDrop: 5, forceDhw: 0 });
  const w = hp.writesFor({ type: c.type, plan: { mode: 'dhw' }, now, settings: { targetC: 50 } });
  assert.deepEqual(w.map((x) => [x.role, x.action, x.value, x.vi]), [['dhwSetpoint', 'a-set', 50, undefined], ['forceDhw', 'a-force', 1, undefined]]);
});

test('without the actuators in the app: found, but it cannot steer yet', () => {
  const ro = JSON.parse(JSON.stringify(structure));
  delete ro.controls['20aa0001-0003-0001-ffff1'].uuidAction;
  delete ro.controls['20aa0001-0004-0001-ffff1'].uuidAction;
  const [c] = ed.fromStructure('heatpump', ro);
  assert.equal(c.roles.forceDhw, undefined);
  assert.equal(c.roles.dhwSetpoint.write, undefined);
  assert.deepEqual(c.check.notWritable, ['forceDhw / dhwSetpoint']);
});

test('per role the user chooses: direct, a virtual input (own name) or off; read from an own object', () => {
  const [c] = ed.fromStructure('heatpump', structure);
  const t = et.link('heatpump', c.type, {
    dhwSetpoint: { write: { via: 'vi', vi: 'VI_Boiler_Setpoint' } },
    forceDhw: { write: { via: 'off' } },
    tankTemp: { read: { uuid: 'vo-tank', name: 'VO Tapwater gemiddeld' } },
    roomTemp: { read: { uuid: 'vo-room', name: 'Woonkamer temperatuur' } },
  });
  assert.equal(et.byRole(t, 'tankTemp').state, 'vo-tank');
  assert.equal(et.byRole(t, 'roomTemp').added, true);
  assert.equal(et.byRole(t, 'forceDhw').rw, 'r', 'off: still read, never sent');
  const now = { tankTemp: 42, dhwSetpoint: 48, dhwDrop: 5, forceDhw: 0 };
  const w = hp.writesFor({ type: t, plan: { mode: 'dhw' }, now, settings: { targetC: 50 } });
  assert.deepEqual(w.map((x) => [x.role, x.vi, x.action]), [['dhwSetpoint', 'VI_Boiler_Setpoint', undefined]]);
  assert.equal(w[0].value, 50, 'no force: the target, and at least tank + drop so the unit starts by itself');
  const direct = et.link('heatpump', c.type, { dhwSetpoint: { write: { via: 'direct' } } });
  assert.equal(hp.writesFor({ type: direct, plan: { mode: 'dhw' }, now, settings: { targetC: 50 } })[0].action, 'a-set');
});

test('the power steps, NTC and outdoor sensors of the own Loxone logic are found elsewhere in the structure', () => {
  const s = JSON.parse(JSON.stringify(structure));
  const own = (uuid, name, extra = {}) => { s.controls[uuid] = { name, type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: `${uuid}-v` }, ...extra }; };
  own('50ee0001-0001-0001-ffff1', 'Buitentemperatuur');
  own('51ee0001-0001-0001-ffff1', 'Buitenluchtvochtigheid');
  own('52ee0001-0001-0001-ffff1', 'Warmtepomp Vermogen 1', { type: 'Switch', uuidAction: 'q1' });
  own('53ee0001-0001-0001-ffff1', 'Warmtepomp Vermogen 2', { type: 'Switch', uuidAction: 'q2' });
  own('54ee0001-0001-0001-ffff1', 'Warmtepomp Weerstand 1', { type: 'Switch', uuidAction: 'q3' });
  own('55ee0001-0001-0001-ffff1', 'Warmtepomp Vermogen');
  own('56ee0001-0001-0001-ffff1', 'Warmtepomp Weerstand');
  own('57ee0001-0001-0001-ffff1', 'Warmtepomp Setpoint Ta');
  const [c] = ed.fromStructure('heatpump', s);
  assert.equal(c.roles.outdoorTemp.read.uuid, '50ee0001-0001-0001-ffff1-v');
  assert.equal(c.roles.outdoorTemp.elsewhere, true);
  assert.equal(c.roles.outdoorRh.read.name, 'Buitenluchtvochtigheid');
  assert.equal(c.roles.powerLimit1.write.uuid, 'q1');
  assert.equal(c.roles.powerLimit2.write.uuid, 'q2');
  assert.equal(c.roles.ntcRelay1.write.uuid, 'q3');
  assert.equal(c.roles.powerStep.read.name, 'Warmtepomp Vermogen');
  assert.equal(c.roles.ntcMode.read.name, 'Warmtepomp Weerstand');
  assert.equal(c.roles.logicFlowC.read.name, 'Warmtepomp Setpoint Ta');
});

test('room controllers: actual, target and a humidity sensor in the same room', () => {
  const s = JSON.parse(JSON.stringify(structure));
  s.rooms.w = { name: 'Woonkamer' };
  s.controls['70aa0001-0001-0001-ffff1'] = { name: 'Woonkamer', type: 'IRoomControllerV2', room: 'w', states: { tempActual: 'ta', tempTarget: 'tt', comfortTemperature: 'ct' } };
  s.controls['71aa0001-0001-0001-ffff1'] = { name: 'Luchtvochtigheid woonkamer', type: 'InfoOnlyAnalog', room: 'w', states: { value: 'hu' } };
  assert.deepEqual(ed.roomControllers(s), [{ uuid: '70aa0001-0001-0001-ffff1', name: 'Woonkamer', room: 'Woonkamer', tempActual: 'ta', tempTarget: 'tt', comfort: 'ct', humidity: 'hu' }]);
});

test('one heat pump whose outputs fell into two uuid groups is found once, complete', () => {
  const io2 = (name, state, extra = {}) => ({ name, type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: state }, ...extra });
  const s = { rooms: { r: { name: 'Visualisatie' } }, cats: { c: { name: 'Verwarming' } }, controls: {
    'aa000001-0001-0001-ffff1': io2('Tank Water Temp Actual', 't1'), 'aa000001-0002-0001-ffff1': io2('Flow Temp', 't2'),
    'aa000001-0003-0001-ffff1': io2('Return Temp', 't3'), 'aa000001-0004-0001-ffff1': io2('DHW Temperature Drop', 't4'),
    'bb000002-0001-0001-ffff1': io2('Force DHW', 'f1', { uuidAction: 'fa' }), 'bb000002-0002-0001-ffff1': io2('Tank Water Temp Target', 'f2'),
    'bb000002-0003-0001-ffff1': io2('Set Tank Water Temperature', 'f3', { uuidAction: 'sa' }), 'bb000002-0004-0001-ffff1': io2('Booster Heater 1', 'f4'),
  } };
  const found = ed.fromStructure('heatpump', s);
  assert.equal(found.length, 1);
  assert.equal(found[0].parts.length, 2);
  assert.equal(found[0].check.ok, true);
  assert.equal(found[0].roles.forceDhw.write.uuid, 'fa');
});

test('a meter in the basement (imported, exported, grid power) is no solar inverter', () => {
  const io3 = (name, state) => ({ name, type: 'InfoOnlyAnalog', room: 'k', cat: 'c', states: { value: state } });
  const s = { rooms: { k: { name: 'Kelder' } }, cats: { c: { name: 'Energie' } }, controls: {
    'cc000001-0001-0001-ffff1': io3('Afgenomen', 'm1'), 'cc000001-0002-0001-ffff1': io3('Teruggeleverd', 'm2'), 'cc000001-0003-0001-ffff1': io3('Netvermogen', 'm3'),
  } };
  assert.deepEqual(ed.fromStructure('solar', s), []);
});

test('the Kamstrup is found by "Temp. Impulsion"; its return and flow are its own, not the heat pump\'s "Return Temp"', () => {
  const s = JSON.parse(JSON.stringify(structure));
  s.controls['20aa0001-0009-0001-ffff1'] = { name: 'Return Temp', type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: 's-ret' } };
  s.controls['80aa0001-0001-0001-ffff1'] = { name: 'Temp. Impulsion', type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: 'k-flow' } };
  s.controls['80aa0001-0002-0001-ffff1'] = { name: 'Return Temp.', type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: 'k-ret' } };
  s.controls['80aa0001-0003-0001-ffff1'] = { name: 'Current Water Flow', type: 'InfoOnlyAnalog', room: 'r', cat: 'c', states: { value: 'k-lph' } };
  const [c] = ed.fromStructure('heatpump', s);
  assert.equal(c.roles.heatMeterFlowTemp.read.uuid, 'k-flow');
  assert.equal(c.roles.heatMeterReturnTemp.read.uuid, 'k-ret');
  assert.equal(c.roles.heatMeterFlowRate.read.uuid, 'k-lph');
  assert.equal(c.roles.returnTemp.read.uuid, 's-ret', 'the heat pump keeps its own');
});

test('SolarEdge outputs without _RAW (I_AC_Power + I_AC_Power_SF): scaled to kW, recognised as SolarEdge', () => {
  const io4 = (name, state) => ({ name, type: 'InfoOnlyAnalog', room: 'k', cat: 'c', states: { value: state } });
  const s = { rooms: { k: { name: 'Kelder' } }, cats: { c: { name: 'Energie' } }, controls: {
    '19000001-0001-0001-ffff1': io4('I_AC_Power', 'ac'), '19000001-0002-0001-ffff1': io4('I_AC_Power_SF', 'acsf'),
    '19000001-0003-0001-ffff1': io4('I_DC_Power', 'dc'), '19000001-0004-0001-ffff1': io4('I_DC_Power_SF', 'dcsf'),
    '19000001-0005-0001-ffff1': io4('I_Status', 'st'), '19000001-0006-0001-ffff1': io4('M_AC_Power', 'g'), '19000001-0007-0001-ffff1': io4('M_AC_Power_SF', 'gsf'),
    '19000001-0008-0001-ffff1': io4('M_Exported_Energy', 'ex'), '19000001-0009-0001-ffff1': io4('M_Energy_SF', 'esf'),
  } };
  const [c] = ed.fromStructure('solar', s);
  assert.equal(c.known && c.known.key, 'solaredge');
  const byName = { I_AC_Power: 26373, I_AC_Power_SF: -1, I_DC_Power: 3162, I_DC_Power_SF: -1, M_AC_Power: -1200, M_AC_Power_SF: 0, M_Exported_Energy: 1234567, M_Energy_SF: 0 };
  const raw = {}; for (const r of c.type.registers) raw[r.key] = byName[r.label];
  const v = et.fromRaw(c.type, raw);
  assert.equal(v.acPower, 2.637);
  assert.equal(v.dcPower, 0.316);
  assert.equal(v.gridPower, -1.2);
  assert.equal(v.exportEnergy, 1234.567);
});

test('rebuilding a found device keeps its own objects (scale factors stay linked)', () => {
  const io5 = (name, state) => ({ name, type: 'InfoOnlyAnalog', room: 'k', cat: 'c', states: { value: state } });
  const s = { rooms: { k: { name: 'Kelder' } }, cats: { c: { name: 'Energie' } }, controls: {
    '19000001-0001-0001-ffff1': io5('I_DC_Power', 'dc'), '19000001-0002-0001-ffff1': io5('I_DC_Power_SF', 'dcsf'), '19000001-0003-0001-ffff1': io5('I_Status', 'st'), '19000001-0004-0001-ffff1': io5('M_AC_Power', 'g'),
  } };
  const [c] = ed.fromStructure('solar', s);
  const again = ed.asType('solar', { uuid: c.uuid, name: c.name, members: c.members }, c.roles, et.loadTypes('solar').find((t) => t.key === 'solaredge'));
  assert.ok(et.byRole(again, 'dcPower').sf, 'scale factor kept');
});
