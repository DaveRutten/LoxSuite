// Every object of the Loxone project for a picker ("Other Loxone object…"): on every Miniserver (Gateway
// first, the same object once), or one. { uuid, name, type, room, state, action, ms, msName }.
const db = require('./db');

// Pure: the state that carries the object's value — a Meter's first state is not its power (actual), so
// "the first string state" gave no live value. actual → value → active → the first one.
const PREFERRED_STATES = ['actual', 'value', 'active', 'position', 'tempActual'];
function mainState(states) {
  const st = states || {};
  for (const k of PREFERRED_STATES) if (typeof st[k] === 'string') return st[k];
  return Object.values(st).find((x) => typeof x === 'string') || null;
}

async function listObjects(msFilter = 'all') {
  const all = (await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all()).sort((x, y) => Number(!!x.gateway_client_of) - Number(!!y.gateway_client_of));
  const list = msFilter && msFilter !== 'all' ? all.filter((m) => m.id === Number(msFilter)) : all;
  const out = []; const seen = new Set();
  for (const ms of list) {
    const s = await require('./loxoneStructure').getStructure(ms).catch(() => null);
    const rooms = s?.rooms || {};
    for (const [uuid, c] of Object.entries(s?.controls || {})) {
      if (seen.has(uuid)) continue;
      seen.add(uuid);
      const state = mainState(c.states);
      out.push({ uuid, name: c.name, type: c.type, room: rooms[c.room]?.name || null, state: state || null, action: c.uuidAction || null, ms: ms.id, msName: list.length > 1 ? ms.name : null });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { listObjects, mainState };
