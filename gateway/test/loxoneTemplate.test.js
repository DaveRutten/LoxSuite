// Importing a Loxone Modbus template (.LxAddon from the Loxone Library, or the bare .xml) as an
// energy-manager device type. The templates here are short ones in the same format, written for the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const lt = require('../src/loxoneTemplate');
const et = require('../src/energyTypes');

const HEATPUMP = `﻿<?xml version="1.0" encoding="utf-8"?>
<Modbus Title="Test Heat Pump" Comment="" Baudrate="9600" Stopbits="1" Channel="1">
	<Info templateType="7" minVersion="14000328"/>
	<ModbusCmd Title="Tank Water Temp Actual" Comment="" ModbusAddress="106" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;ºC" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="1"/>
	<ModbusCmd Title="Tank Water Temp Target" Comment="" ModbusAddress="31" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;ºC" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="1"/>
	<ModbusCmd Title="Set Tank Water Temperature" Comment="" ModbusAddress="31" ModbusCmd="6" ModbusPollingCycle="5" Unit="&lt;v&gt;ºC" Analog="true" Sensor="false" SourceValHigh="1" DestValHigh="100"/>
	<ModbusCmd Title="Force DHW" Comment="" ModbusAddress="37" ModbusCmd="6" ModbusPollingCycle="5" Unit="&lt;v&gt;" Analog="true" Sensor="false" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="Holiday" Comment="" ModbusAddress="38" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="Booster Heater 1" Comment="" ModbusAddress="145" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="DHW Temperature Drop" Comment="" ModbusAddress="92" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;ºC" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="10"/>
	<ModbusCmd Title="Modbus Counter" Comment="" ModbusAddress="11" ModbusCmd="3" ModbusPollingCycle="5" Unit="&lt;v&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
</Modbus>`;

const SOLAR = `<?xml version="1.0" encoding="utf-8"?>
<Modbus Title="Test Inverter" Comment="" Channel="1">
	<ModbusCmd Title="I_DC_Power_RAW" Comment="DC Power Raw" HintText="Formula: (RAW*10^SF)/1000 = DC Power in kW" ModbusAddress="40100" ModbusCmd="3" ModbusDataType="1" Unit="&lt;v.1&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="I_DC_Power_SF" Comment="" ModbusAddress="40101" ModbusCmd="3" ModbusDataType="1" Unit="&lt;v.1&gt;x" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="M_Exported_Energy_RAW" Comment="" HintText="Formula: (RAW*10^SF)/1000 = Exported Energy in kWh" ModbusAddress="40226" ModbusCmd="3" ModbusDataType="98" Unit="&lt;v.1&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
	<ModbusCmd Title="M_Energy_SF" Comment="" ModbusAddress="40242" ModbusCmd="3" ModbusDataType="1" Unit="&lt;v.1&gt;" Analog="true" Sensor="true" SourceValHigh="100" DestValHigh="100"/>
</Modbus>`;

function lxaddon(name, xml) {
  const zip = new AdmZip();
  zip.addFile(`${name}.xml`, Buffer.from(xml, 'utf8'));
  // the Library's desc.json has a trailing comma
  zip.addFile('desc.json', Buffer.from(`{ "type": "template", "name": "${name}", "version":"1.2.0", "id": "${name}-42", "file": "${name}.xml", "templateType": "7", }`));
  return zip.toBuffer();
}

test('reads a .LxAddon from the Library: name, version, sensors and actuators', () => {
  const { type, check } = lt.importTemplate('heatpump', lxaddon('test-heat-pump', HEATPUMP), { name: 'Test.LxAddon' });
  assert.equal(type.key, 'lox-test_heat_pump');
  assert.equal(type.label, 'Test Heat Pump');
  assert.equal(type.source, 'Loxone Library: test-heat-pump-42 v1.2.0');
  assert.equal(type.values, 'loxone');
  assert.deepEqual(check, { ok: true, missing: [], unknown: [], notWritable: [] });
});

test('sensor + actuator on one register become one read/write register with the sensor name', () => {
  const { type } = lt.importTemplate('heatpump', Buffer.from(HEATPUMP));
  const sp = type.registers.find((r) => r.reg === 31);
  assert.equal(sp.rw, 'rw');
  assert.equal(sp.label, 'Tank Water Temp Target');
  assert.equal(sp.writeLabel, 'Set Tank Water Temperature');
  assert.equal(sp.scale, 100);
  assert.equal(type.registers.find((r) => r.reg === 92).scale, 10);
});

test('suggests roles by name; a read-only Holiday is no heating block; unknown ones stay open', () => {
  const { type } = lt.importTemplate('heatpump', Buffer.from(HEATPUMP));
  const role = (reg) => type.registers.find((r) => r.reg === reg).role;
  assert.equal(role(106), 'tankTemp');
  assert.equal(role(31), 'dhwSetpoint');
  assert.equal(role(37), 'forceDhw');
  assert.equal(role(145), 'boosterHeater');
  assert.equal(role(92), 'dhwDrop');
  assert.equal(role(38), undefined, 'a sensor only: LoxSuite cannot write it');
  assert.equal(role(11), undefined);
});

test('SunSpec raw values get their scale factor, also the shared energy one', () => {
  const { type, check } = lt.importTemplate('solar', Buffer.from(SOLAR));
  const dc = type.registers.find((r) => r.label === 'I_DC_Power_RAW');
  assert.equal(dc.sf, 'i_dc_power_sf');
  assert.equal(dc.div, 1000);
  assert.equal(type.registers.find((r) => r.label === 'M_Exported_Energy_RAW').sf, 'm_energy_sf');
  assert.deepEqual(check.missing, ['powerLimitPct'], 'the Library template has no power control');
  const v = et.fromRaw(type, { i_dc_power_raw: 5432, i_dc_power_sf: -1, m_exported_energy_raw: 1234567, m_energy_sf: 0 });
  assert.equal(v.dcPower, 0.543);
  assert.equal(v.exportEnergy, 1234.567);
});

test('not a template: a clear error', () => {
  assert.throws(() => lt.importTemplate('heatpump', Buffer.from('<VirtualInOut Title="x"/>')), /not a Loxone Modbus template/);
  assert.throws(() => lt.importTemplate('boiler', Buffer.from(HEATPUMP)), /unknown kind/);
});
