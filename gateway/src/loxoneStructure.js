const { fetchMiniserver } = require('./loxone');

// miniserver_id -> { fetchedAt, structure }. LoxAPP3.json can be sizeable (hundreds of controls)
// and rarely changes, so it's fetched once per Miniserver and reused until a caller explicitly
// asks for a refresh. Cached as the raw structure (not pre-flattened) so both
// getMonitorableStates (Monitor's "pick a state" list) and getRoomCategoryTree (Live Data) can be
// derived from one fetch instead of each doing their own.
const structureCache = new Map();

async function fetchStructure(miniserver) {
  const res = await fetchMiniserver(miniserver, '/data/LoxAPP3.json', { timeoutMs: 10000 });
  if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
  return res.json();
}

async function getStructure(miniserver, { forceRefresh } = {}) {
  const cached = structureCache.get(miniserver.id);
  if (cached && !forceRefresh) return cached.structure;

  const structure = await fetchStructure(miniserver);
  structureCache.set(miniserver.id, { fetchedAt: Date.now(), structure });
  return structure;
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
  const structure = await getStructure(miniserver, { forceRefresh });
  return flattenStates(structure);
}

// Groups every control with at least one readable state by room, then by category — the same
// grouping Loxone Config's own periphery tree uses (control.room/control.cat are UUIDs into the
// structure file's own rooms/cats maps), so this works for any project's structure rather than
// anything specific to one installation. Powers the Live Data page's room -> category -> control
// drill-down; live values themselves are fetched separately, per category, only once expanded —
// a structure file can have hundreds of controls, so eagerly reading every one of them up front
// would mean hundreds of Miniserver requests just to open the page.
function buildRoomCategoryTree(structure) {
  const rooms = structure.rooms || {};
  const cats = structure.cats || {};
  const controls = structure.controls || {};

  const roomMap = new Map();

  for (const control of Object.values(controls)) {
    if (!control.states) continue;
    const states = Object.entries(control.states)
      .filter(([, uuid]) => typeof uuid === 'string')
      .map(([stateName, uuid]) => ({ stateName, uuid }));
    if (states.length === 0) continue;

    const roomUuid = control.room || '';
    const catUuid = control.cat || '';
    const roomName = rooms[roomUuid]?.name || 'No room';
    const catName = cats[catUuid]?.name || 'No category';
    // One of Loxone's own: lights/indoortemperature/shading/media, or unset. "Unset" is not just
    // a missing/empty field — a real structure file was found to store the literal string
    // "undefined" for uncategorized categories, not JSON null or an absent key. Normalize both.
    const rawType = cats[catUuid]?.type;
    const catType = rawType && rawType !== 'undefined' ? rawType : null;

    if (!roomMap.has(roomUuid)) roomMap.set(roomUuid, { name: roomName, categories: new Map() });
    const room = roomMap.get(roomUuid);

    if (!room.categories.has(catUuid)) room.categories.set(catUuid, { name: catName, type: catType, controls: [] });
    room.categories.get(catUuid).controls.push({ name: control.name, type: control.type, states });
  }

  return Array.from(roomMap.entries())
    .map(([roomUuid, room]) => ({
      roomUuid,
      name: room.name,
      categories: Array.from(room.categories.entries())
        .map(([catUuid, cat]) => ({ catUuid, ...cat }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getRoomCategoryTree(miniserver, { forceRefresh } = {}) {
  const structure = await getStructure(miniserver, { forceRefresh });
  return buildRoomCategoryTree(structure);
}

// Just enough to render the initial room list — name and a couple of counts, nothing per-category
// or per-control. A real installation's full tree can run into the thousands of DOM nodes once
// rendered (rooms * categories * controls * states), which is enough to make a browser tab choke;
// this keeps the first response (and thus first paint) small regardless of installation size. The
// full per-room detail is fetched separately, on demand, only for the one room a user opens (see
// getRoomDetail below) — same lazy-loading idea getRoomCategoryTree's own doc comment describes
// for per-category live values, just one level up.
async function getRoomSummaries(miniserver, { forceRefresh } = {}) {
  const tree = await getRoomCategoryTree(miniserver, { forceRefresh });
  return tree.map((room) => ({
    roomUuid: room.roomUuid,
    name: room.name,
    categoryCount: room.categories.length,
    controlCount: room.categories.reduce((sum, cat) => sum + cat.controls.length, 0),
  }));
}

// One room's categories/controls/states — reuses the already-cached structure (getRoomCategoryTree
// re-fetches nothing from the Miniserver itself if it's already cached), just returns a slice of
// it instead of the whole tree.
async function getRoomDetail(miniserver, roomUuid, { forceRefresh } = {}) {
  const tree = await getRoomCategoryTree(miniserver, { forceRefresh });
  return tree.find((room) => room.roomUuid === roomUuid) || null;
}

module.exports = { getMonitorableStates, getRoomCategoryTree, getRoomSummaries, getRoomDetail };
