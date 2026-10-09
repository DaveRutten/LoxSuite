// Find a heat pump or an inverter in the Loxone structure itself, the way Home Connect appliances are
// found (energyManager.devicesFromStructure): the outputs of one Modbus device show up as loose
// controls with a shared uuid start. Their names are the names of the Modbus template, so the same
// name suggestions as the template import (loxoneTemplate.SUGGEST) say which output is which.
//
//   fromStructure  candidates per kind, best first: { uuid, name, room, score, roles, check, type }
//                  roles: { role: { read: { uuid, name }, write: { uuid, name } } } — read = a state
//                  uuid, write = the control's uuidAction (LoxSuite sends to it directly, no virtual
//                  input needed); a sensor and its "Set …" actuator are one role
//   type           the known type (built-in or imported) whose names match best, for the meaning of
//                  values (enumerations, limits) and what it could have more; null when none matches
//
// A Modbus output only shows up when it is visible in the Loxone app (in Loxone Config: used in the
// user interface). What is not there can still be added: in Loxone, or by importing the template.
const em = require('./energyManager');
const et = require('./energyTypes');
const { SUGGEST } = require('./loxoneTemplate');

const norm = (s) => String(s || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

// Pure: the members of one device -> { role: { read, write } } by name.
function rolesOf(kind, members) {
  const def = et.ROLES[kind]?.roles || {};
  const out = {};
  const used = new Set();
  for (const [role, re, only] of SUGGEST[kind] || []) {
    if (out[role]) continue;
    const hits = members.filter((m) => !used.has(m.uuid) && re.test(m.name));
    if (!hits.length) continue;
    const reader = hits.find((m) => !m.action && m.state) || hits.find((m) => m.state);
    const writer = /w/.test(def[role]?.rw || '') ? hits.find((m) => m.action) : null;
    if (only === 'w' && !writer) continue;
    if (only === 'r' && !reader) continue;
    const r = {};
    if (reader && only !== 'w') { r.read = { uuid: reader.state, name: reader.name, control: reader.uuid }; used.add(reader.uuid); }
    if (writer) { r.write = { uuid: writer.action, name: writer.name }; used.add(writer.uuid); if (!r.read && writer.state) r.read = { uuid: writer.state, name: writer.name, control: writer.uuid }; }
    if (r.read || r.write) out[role] = r;
  }
  return out;
}

// Pure: the found roles as a type, so check() and writes() work on it the same way. From the known
// type: the meaning of a value (enumeration, limits, unit, register) and, for SunSpec raw values, the
// scale-factor output it needs (found among the device's members by its name).
function asType(kind, device, roles, known) {
  const byName = new Map((known?.registers || []).map((r) => [norm(r.label), r]));
  const regs = Object.entries(roles).map(([role, r]) => {
    const reg = byName.get(norm(r.read?.name)) || byName.get(norm(r.write?.name)) || {};
    return { key: role, role, label: r.read?.name || r.write?.name, rw: r.read && r.write ? 'rw' : r.write ? 'w' : 'r', state: r.read?.uuid || null, control: r.read?.control || null, action: r.write?.uuid || null, ...(reg.map ? { map: reg.map } : {}), ...(reg.min !== undefined ? { min: reg.min, max: reg.max } : {}), ...(reg.unit ? { unit: reg.unit } : {}), ...(reg.reg !== undefined ? { reg: reg.reg } : {}), ...(reg.sf ? { sf: reg.sf, div: reg.div } : {}), ...(reg.onValue !== undefined ? { onValue: reg.onValue } : {}) };
  });
  for (const r of regs.filter((x) => x.sf)) {
    if (regs.some((x) => x.key === r.sf)) continue;
    const sfReg = (known?.registers || []).find((x) => x.key === r.sf);
    const m = sfReg && (device.members || []).find((x) => norm(x.name) === norm(sfReg.label));
    if (m?.state) regs.push({ key: sfReg.key, label: m.name, rw: 'r', state: m.state, control: m.uuid });
    else delete r.sf;
  }
  return { key: `loxone:${device.uuid}`, label: device.name, values: 'loxone', fromLoxone: true, basedOn: known?.key || null, defaults: known?.defaults, registers: regs };
}

// Pure: the known type whose register names cover most of the device's member names.
function bestKnown(members, types) {
  const names = new Set(members.map((m) => norm(m.name)));
  let best = null;
  for (const t of types) {
    if (t.custom) continue;
    const labels = t.registers.flatMap((r) => [r.label, r.writeLabel].filter(Boolean)).map(norm);
    const hit = labels.filter((l) => names.has(l)).length;
    const share = names.size ? hit / names.size : 0;
    if (hit >= 3 && share >= 0.5 && (!best || share > best.share)) best = { type: t, share: Math.round(share * 100) / 100 };
  }
  return best;
}

// Roles that usually are not outputs of the Modbus device but the user's own logic in Loxone (the
// power-limit steps and the NTC of a sequential controller, the outdoor sensors): looked for in the
// whole structure, by name, when the device itself doesn't have them.
const ELSEWHERE = { heatpump: ['outdoorTemp', 'outdoorRh', 'roomTemp', 'dhwPipeTemp', 'heatMeterPower', 'heatMeterEnergy', 'powerStep', 'powerLimit1', 'powerLimit2', 'ntcMode', 'ntcRelay1', 'ntcRelay2', 'logicFlowC'], solar: [] };
function allObjects(structure) {
  const rooms = structure?.rooms || {};
  return Object.entries(structure?.controls || {}).map(([uuid, c]) => ({ uuid, name: c.name, room: rooms[c.room]?.name || null, state: Object.values(c.states || {}).find((x) => typeof x === 'string') || null, action: c.uuidAction || null }));
}

// The candidates in a structure file for a module kind, best first. types: from energyTypes.loadTypes.
function fromStructure(kind, structure, { types = et.loadTypes(kind) } = {}) {
  const raw = em.devicesFromStructure(structure).filter((d) => Array.isArray(d.members) && d.members.length >= 3);
  // the outputs of one Modbus device don't always share one uuid start (added later, copied): groups
  // that match the same known type are one device
  const devices = [];
  const byKnown = new Map();
  for (const d of raw) {
    const k = bestKnown(d.members, types)?.type.key;
    if (k && byKnown.has(k)) { const m = byKnown.get(k); m.members = [...m.members, ...d.members]; m.parts.push(d.uuid); continue; }
    const copy = { ...d, members: [...d.members], parts: [d.uuid] };
    if (k) byKnown.set(k, copy);
    devices.push(copy);
  }
  const out = [];
  for (const d of devices) {
    const roles = rolesOf(kind, d.members);
    const score = Object.keys(roles).length;
    if (score < 2) continue;
    const wanted = (ELSEWHERE[kind] || []).filter((r) => !roles[r]);
    if (wanted.length) {
      const memberIds = new Set(d.members.map((m) => m.uuid));
      const others = allObjects(structure).filter((o) => !memberIds.has(o.uuid));
      const extra = rolesOf(kind, others);
      for (const r of wanted) if (extra[r]) roles[r] = { ...extra[r], elsewhere: true };
    }
    const known = bestKnown(d.members, types);
    const type = asType(kind, d, roles, known?.type);
    const name = /\(\w+\)$/.test(d.name) && known ? known.type.label : d.name;
    // what the known type has that Loxone doesn't show yet (to make visible, or add, in Loxone)
    const missingFromLoxone = known ? known.type.registers.filter((r) => r.role && !roles[r.role]).map((r) => ({ role: r.role, label: r.label, reg: r.reg })) : [];
    out.push({ uuid: d.uuid, parts: d.parts, name, room: d.room, score, roles, check: et.check(kind, type), type, known: known ? { key: known.type.key, label: known.type.label, share: known.share } : null, missingFromLoxone });
  }
  return out.sort((a, b) => Number(b.check.ok) - Number(a.check.ok) || b.score - a.score);
}

// Pure: the room controllers in a structure (Loxone's "Intelligent room controller"), with the states
// the heat pump module reads: actual temperature, target temperature, humidity (its own or a sensor in
// the same room).
function roomControllers(structure) {
  const rooms = structure?.rooms || {};
  const ctrls = Object.entries(structure?.controls || {});
  const out = [];
  for (const [uuid, c] of ctrls) {
    if (!/^IRoomController/i.test(c.type || '')) continue;
    const st = c.states || {};
    const pick = (re) => { const k = Object.keys(st).find((n) => re.test(n)); return k ? st[k] : null; };
    let humidity = pick(/humid/i);
    if (!humidity) {
      const h = ctrls.find(([, x]) => x.room === c.room && /vochtig|humid|feuchte/i.test(x.name || '') && x.states);
      if (h) humidity = Object.values(h[1].states).find((x) => typeof x === 'string') || null;
    }
    out.push({ uuid, name: c.name, room: rooms[c.room]?.name || null, tempActual: pick(/^tempActual$/i), tempTarget: pick(/^tempTarget$/i), comfort: pick(/^comfortTemperature$/i), humidity });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { rolesOf, asType, bestKnown, fromStructure, roomControllers, allObjects, ELSEWHERE };
