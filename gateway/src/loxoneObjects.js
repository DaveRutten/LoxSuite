// Every object of the Loxone project for a picker ("Other Loxone object…"): on every Miniserver (Gateway
// first, the same object once), or one. { uuid, name, type, room, state, action, ms, msName }.
const db = require('./db');

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
      const state = Object.values(c.states || {}).find((x) => typeof x === 'string');
      out.push({ uuid, name: c.name, type: c.type, room: rooms[c.room]?.name || null, state: state || null, action: c.uuidAction || null, ms: ms.id, msName: list.length > 1 ? ms.name : null });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { listObjects };
