// Import a Loxone Modbus template (from the Loxone Library: a .LxAddon zip with the XML and a
// desc.json, or the bare .xml that Loxone Config saves) as an energy-manager device type (energyTypes.js).
//
// A template is a list of <ModbusCmd>: a sensor (ModbusCmd 3/4, read) or an actuator (6/16, write)
// on a register, with Loxone's own scaling (SourceValHigh -> DestValHigh) and unit. The same register
// as sensor and actuator becomes one read/write register. Every register gets a suggested role by its
// name (English, Dutch, German); what isn't recognised stays without a role, for the user to assign.
// The names are exactly those of the objects in Loxone, so linking them to the Loxone states later is
// a match on name.
//
// SunSpec devices (SolarEdge) give a raw value and a scale factor as two registers (X_RAW + X_SF): the
// value is RAW × 10^SF. The raw register gets sf: <key of the SF register>.
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { ROLES } = require('./energyTypes');

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'x';

// Suggestions per kind: [role, regex on the title (+ comment)], the first that fits wins; every role
// once, every register once. 'w' = only for a writable register, 'r' = only for a read one.
const SUGGEST = {
  heatpump: [
    ['forceDhw', /force ?dhw|tapwater forceren|warmwasser.*(zwang|sofort)/i, 'w'],
    ['dhwSetpoint', /set tank water temp|tank water temp(erature)? target|dhw.*(setpoint|target)|setpoint tapwater|tapwater.?setpoint|warmwasser.?soll/i],
    ['tankTemp', /tank water temp(erature)?( actual)?$|tapwater ?temp|boiler ?temp|dhw temp(erature)?$|warmwasser.?(ist|temp)/i, 'r'],
    ['dhwDrop', /dhw temperature drop|tapwater.*(hysterese|drop)/i, 'r'],
    ['heatingBlock', /^holiday$|vakantie|vrijgave blokkering|urlaub/i, 'w'],
    ['dhwMode', /(set )?dhw mode|operating mode dhw|tapwater ?modus/i],
    ['heatingMode', /(set )?zone 1 heating mode|heating mode.*zone 1|bedrijfsmodus|betriebsart/i],
    ['roomSetpoint', /zone 1 thermostat|thermostat target.*zone 1|kamer.*setpoint|raum.?soll/i, 'w'],
    ['roomTemp', /room temp(erature)?.*zone 1|ruimtetemp|kamertemp|raumtemp/i, 'r'],
    ['flowSetpoint', /flow temp(erature)? setpoint.*zone 1|aanvoer.*setpoint|vorlauf.?soll/i],
    ['flowSetpointZone2', /flow temp(erature)? setpoint.*zone 2/i],
    ['valveDhw', /3-?way valve|3-?wegklep|3-?wege/i, 'r'],
    ['boosterHeater', /booster heater 1|booster ?heater$|bijverwarming|heizstab/i, 'r'],
    ['immersionHeater', /immersion|dompelaar|elektrisch element/i, 'r'],
    ['heatSource', /heat source (status|phase)|warmtebron/i, 'r'],
    ['compressorHz', /compressor.*(freq|hz)|frequen/i, 'r'],
    ['systemOn', /(ecodan|system|systeem) on-?off|systeem aan|anlage ein/i],
    ['running', /heat pump( master)? on-?off|bedrijfsmelding|in bedrijf/i, 'r'],
    ['defrost', /defrost|ontdooi|abtau/i, 'r'],
    ['errorCode', /fault code|storingscode|error code digit 1|fehlercode/i, 'r'],
    ['fault', /^(heat pump |warmtepomp )?(fault|storing|error)( ?(1\/0|status|melding))?$|^störung$/i, 'r'],
    ['refrigerantTemp', /refrigerant (liquid )?temp|koudemiddel|kältemittel/i, 'r'],
    ['bufferFlowTemp', /buffer.*(flow|aanvoer)|(aanvoer|flow).*buffer|puffer.*vorlauf/i, 'r'],
    ['bufferReturnTemp', /buffer.*(return|retour)|(retour|return).*buffer|puffer.*rücklauf/i, 'r'],
    ['operatingHours', /operating hours|draaiuren|bedrijfsuren|betriebsstunden/i, 'r'],
    ['dhwFlowTemp', /(tapwater|dhw|warm ?water).*(aanvoer|flow ?temp)/i, 'r'],
    ['dhwReturnTemp', /(tapwater|dhw|warm ?water).*(retour|return)/i, 'r'],
    ['dhwFlowRate', /(tapwater|dhw|warm ?water).*(flow|debiet|doorstroming)(?!.*temp)/i, 'r'],
    ['outdoorTemp', /outdoor ambient|^outdoor temp|buiten ?temp|temperatuur buiten|au(ss|ß)entemp/i, 'r'],
    ['flowRate', /flow rate|actuele flow|durchfluss/i, 'r'],
    ['flowTemp', /^flow temp(erature)?( up)?$|^aanvoertemp|^vorlauf(temp)?$/i, 'r'],
    ['returnTemp', /^return temp(erature)?$|^retourtemp|^rücklauf/i, 'r'],
    ['pumpOn', /water pump 1|circulatiepomp|umwälzpumpe/i, 'r'],
    ['legionella', /legionella/i, 'r'],
    ['electricPower', /consumed power|opgenomen vermogen|leistungsaufnahme/i, 'r'],
    ['thermalPower', /produced power|afgegeven vermogen|heizleistung/i, 'r'],
    ['powerLimit1', /(warmtepomp )?vermogen (begrenzing )?1$|power limit 1$|(vermogen|power).*(begrenz|limit|stap|step).*1$/i],
    ['powerLimit2', /(warmtepomp )?vermogen (begrenzing )?2$|power limit 2$|(vermogen|power).*(begrenz|limit|stap|step).*2$/i],
    ['powerStep', /^warmtepomp vermogen$|power step|vermogensstap/i, 'r'],
    ['ntcRelay1', /weerstand.*1$|ntc.*1$/i],
    ['ntcRelay2', /weerstand.*2$|ntc.*2$/i],
    ['ntcMode', /^warmtepomp weerstand$|ntc ?(stand|mode)/i, 'r'],
    ['logicFlowC', /setpoint ?ta$|ntc.*setpoint/i, 'r'],
    ['outdoorRh', /buitenluchtvochtigheid|luchtvochtigheid buiten|outdoor humidity|au(ss|ß)enfeuchte/i, 'r'],
    ['dhwPipeTemp', /leiding.*(badkamer|tapwater|warm ?water)|(tapwater|warm ?water).*leiding|hot.?water pipe|circulatieleiding/i, 'r'],
    ['heatMeterPower', /(kamstrup|warmtemeter|heat ?meter|wärmezähler).*(vermogen|power|leistung)/i, 'r'],
    ['heatMeterFlowTemp', /impulsion|(kamstrup|warmtemeter|heat ?meter).*(aanvoer|flow ?temp)/i, 'r'],
    ['heatMeterEnergy', /(kamstrup|warmtemeter|heat ?meter|wärmezähler).*(energie|energy|kwh|zähler)/i, 'r'],
  ],
  solar: [
    ['powerLimitPct', /active power limit|power limit|vermogen.*(limiet|begrenz)|leistungsbegrenz/i, 'w'],
    ['powerControlEnable', /advanced ?pwr ?control ?en|advanced ?power ?control|(enable|activeer).*power control|dynamic power control|regeling aan/i, 'w'],
    ['reactivePowerConfig', /reactive ?pwr ?config|reactive ?power ?config/i, 'w'],
    ['acPower', /^i_ac_power(_raw)?$|^ac power|omvormer.*vermogen/i, 'r'],
    ['dcPower', /^i_dc_power(_raw)?$|dc power/i, 'r'],
    ['gridPower', /^m_ac_power(_raw)?$|grid power|netvermogen/i, 'r'],
    ['exportEnergy', /exported[ _]energy|teruggeleverd/i, 'r'],
    ['importEnergy', /imported[ _]energy|afgenomen/i, 'r'],
    ['status', /^i_status$|inverter status/i, 'r'],
    ['batterySoc', /^b1_state_of_energy|battery.*(soc|storage[ _]level)/i, 'r'],
    ['batteryPower', /^b1_instant|battery 1 power/i, 'r'],
  ],
};

// Pure: the XML text of a template -> { title, minVersion, cmds: [...] }.
function parseXml(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, trimValues: false });
  const doc = p.parse(String(xml).replace(/^﻿/, ''));
  const root = doc.Modbus || doc.ModbusDevice || null;
  if (!root) throw new Error('not a Loxone Modbus template (no <Modbus>)');
  const list = [].concat(root.ModbusCmd || []);
  if (!list.length) throw new Error('the template has no Modbus commands');
  const num = (x) => (x === undefined || x === '' ? null : Number(x));
  return {
    title: root.Title || 'Modbus template',
    minVersion: root.Info?.minVersion || null,
    serial: root.Baudrate ? { baud: num(root.Baudrate), stopBits: num(root.Stopbits) } : null,
    cmds: list.map((c) => ({
      title: String(c.Title || '').trim(), comment: String(c.Comment || '').trim(), hint: String(c.HintText || '').trim(),
      address: num(c.ModbusAddress), fn: num(c.ModbusCmd), dataType: num(c.ModbusDataType),
      sensor: String(c.Sensor) !== 'false' && ![5, 6, 15, 16].includes(num(c.ModbusCmd)),
      unit: String(c.Unit || '').replace(/<v(\.\d)?>/g, '').trim() || null,
      src: num(c.SourceValHigh) ?? 100, dst: num(c.DestValHigh) ?? 100,
    })),
  };
}

// Pure: a .LxAddon (zip) or .xml as a Buffer -> { xml, desc }.
function unpack(buf, name = '') {
  if (buf.slice(0, 2).toString() === 'PK') {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const descEntry = entries.find((e) => /desc\.json$/i.test(e.entryName));
    let desc = null;
    // desc.json from the Library has a trailing comma: read it leniently
    if (descEntry) try { desc = JSON.parse(descEntry.getData().toString('utf8').replace(/,\s*([}\]])/g, '$1')); } catch { desc = null; }
    const xmlEntry = entries.find((e) => e.entryName === desc?.file) || entries.find((e) => /\.xml$/i.test(e.entryName));
    if (!xmlEntry) throw new Error(`${name || 'the file'} has no template XML inside`);
    return { xml: xmlEntry.getData().toString('utf8'), desc };
  }
  return { xml: buf.toString('utf8'), desc: null };
}

// Pure: suggested role per register (index -> role), each role and register once.
function suggestRoles(kind, regs) {
  const out = new Map();
  const taken = new Set();
  for (const [role, re, only] of SUGGEST[kind] || []) {
    const i = regs.findIndex((r, idx) => !out.has(idx) && !taken.has(role)
      && (re.test(r.label) || (r.comment && re.test(r.comment)))
      && (only !== 'w' || /w/.test(r.rw)) && (only !== 'r' || /r/.test(r.rw)));
    if (i >= 0) { out.set(i, role); taken.add(role); }
  }
  return out;
}

// Pure: the parsed template -> an energy type. Sensor + actuator on one register = 'rw'; values come
// from Loxone already scaled (values: 'loxone'), the scale is kept to show the raw register.
function toType(kind, parsed, { desc = null, key = null } = {}) {
  const byAddr = new Map();
  for (const c of parsed.cmds) {
    if (c.address === null) continue;
    const k = c.address;
    const prev = byAddr.get(k);
    const scale = c.sensor ? (c.dst ? c.src / c.dst : 1) : (c.src ? c.dst / c.src : 1);
    if (prev) {
      prev.rw = prev.rw.includes(c.sensor ? 'r' : 'w') ? prev.rw : 'rw';
      if (!c.sensor) { if (c.title !== prev.label) prev.writeLabel = c.title; } else { if (prev.label !== c.title) prev.writeLabel = prev.label; prev.label = c.title; }
      continue;
    }
    byAddr.set(k, { reg: c.address, label: c.title, comment: c.comment || c.hint.split('\n')[0] || undefined, rw: c.sensor ? 'r' : 'w', unit: c.unit, scale: Math.round(scale * 1e6) / 1e6, fn: c.fn, ...(/\)\s*\/\s*1000/.test(c.hint) ? { div: 1000 } : {}) });
  }
  const regs = [...byAddr.values()];
  // keys: the name, made unique
  const used = new Set();
  for (const r of regs) { let k = slug(r.label); while (used.has(k)) k += `_${r.reg}`; used.add(k); r.key = k; }
  // SunSpec raw + scale factor pairs
  for (const r of regs) {
    const m = /^(.*)_raw$/i.exec(r.label);
    if (!m) continue;
    const base = m[1].replace(/_(power|energy)$/i, '');
    const prefix = m[1].split('_')[0];
    const sf = regs.find((x) => x.label.toLowerCase() === `${m[1].toLowerCase()}_sf`)
      || regs.find((x) => new RegExp(`^${base}_.*sf$`, 'i').test(x.label))
      || (/energy/i.test(m[1]) ? regs.find((x) => new RegExp(`^${prefix}_energy_sf$`, 'i').test(x.label)) : null);
    if (sf) r.sf = sf.key;
  }
  const roles = suggestRoles(kind, regs);
  regs.forEach((r, i) => { if (roles.has(i)) r.role = roles.get(i); r.rw = r.rw === 'w' ? 'w' : r.rw; });
  return {
    key: key || `lox-${slug(desc?.name || parsed.title)}`,
    label: parsed.title,
    source: desc?.id ? `Loxone Library: ${desc.id} v${desc.version || '?'}` : 'Loxone Modbus template',
    imported: { from: 'loxone', library: desc?.id || null, version: desc?.version || null, minConfig: parsed.minVersion },
    values: 'loxone',
    registers: regs.map(({ fn, ...r }) => r),
  };
}

// One call: file contents -> type + what the module still misses.
function importTemplate(kind, buf, { name = '', key = null } = {}) {
  if (!ROLES[kind]) throw new Error(`unknown kind ${kind}`);
  const { xml, desc } = unpack(buf, name);
  const type = toType(kind, parseXml(xml), { desc, key });
  return { type, check: require('./energyTypes').check(kind, type) };
}

module.exports = { parseXml, unpack, suggestRoles, toType, importTemplate, SUGGEST };
