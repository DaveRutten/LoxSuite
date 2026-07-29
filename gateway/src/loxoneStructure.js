const { fetchMiniserver } = require('./loxone');

// miniserver_id -> { fetchedAt, states: [{ uuid, label }] }. LoxAPP3.json can be sizeable (hundreds
// of controls) and rarely changes, so it's fetched once per Miniserver and reused until a caller
// explicitly asks for a refresh.
const structureCache = new Map();

async function fetchStructure(miniserver) {
  const res = await fetchMiniserver(miniserver, '/data/LoxAPP3.json', { timeoutMs: 10000 });
  if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
  return res.json();
}

// Flattens every control's "states" map (state name -> value-memory uuid) into one pickable list,
// since that per-state uuid is what /jdev/sps/io/<uuid> accepts for reading a live value.
function flattenStates(structure) {
  const rooms = structure.rooms || {};
  const controls = structure.controls || {};
  const states = [];

  for (const control of Object.values(controls)) {
    if (!control.states) continue;
    const roomName = control.room && rooms[control.room] ? rooms[control.room].name : null;

    for (const [stateName, uuid] of Object.entries(control.states)) {
      // A control's states can themselves be a list (e.g. multi-value states) — skip those,
      // only single value-memory uuids are readable via /jdev/sps/io/<uuid>.
      if (typeof uuid !== 'string') continue;
      const label = [roomName, control.name, stateName].filter(Boolean).join(' / ');
      states.push({ uuid, label });
    }
  }

  return states.sort((a, b) => a.label.localeCompare(b.label));
}

async function getMonitorableStates(miniserver, { forceRefresh } = {}) {
  const cached = structureCache.get(miniserver.id);
  if (cached && !forceRefresh) return cached.states;

  const structure = await fetchStructure(miniserver);
  const states = flattenStates(structure);
  structureCache.set(miniserver.id, { fetchedAt: Date.now(), states });
  return states;
}

module.exports = { getMonitorableStates };
