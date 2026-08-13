// A second, LoxSuite-native set of read-only "tools" for the AI Assistant feature (see llm/*.js),
// alongside the Miniserver's own native MCP server (mcpClient.js). Unlike every MCP tool call —
// which is a real network round trip to the Miniserver (through Loxone's Remote Connect/Cloud
// relay when mcp_url points there, as it typically does once a Miniserver's been through the
// one-time OAuth authorization flow) — these read straight out of data LoxSuite already keeps
// warm in memory for its own Live Data/Monitor features, with zero network call on a cache hit:
// loxoneStructure.js's indefinitely-cached room/control/state metadata (one HTTP fetch, ever,
// unless refreshed) and loxoneWebSocket.js's continuously-updated live value cache (populated by
// the same persistent per-Miniserver connection startLiveConnections() already keeps open
// regardless of whether the AI Assistant is even enabled). Measured MCP round trips average
// several hundred ms to a few seconds each; these are sub-millisecond in-memory reads. The system
// prompt (routes/aiChat.js) tells the model to prefer these first — falling back to the slower MCP
// tools only for what these two don't cover (writes, history/statistics, anything not yet
// reflected in the websocket cache).
const loxoneStructure = require('./loxoneStructure');
const loxoneWebSocket = require('./loxoneWebSocket');

// Kept short enough to survive ollama.js's own MAX_TOOL_DESCRIPTION_CHARS cap (220) without losing
// the "try this first" framing mid-sentence — that instruction matters most for exactly the weaker
// local models that cap applies to, so it can't be the part that gets truncated away.
const LOCAL_TOOLS = [
  {
    name: 'local_find',
    description: 'Search LoxSuite\'s own cached room/control/state list by word(s) — instant, no network round trip (unlike control_find). Try this first for read-only lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against "Room / Control / State" (case-insensitive substring match; matches if any word matches). Empty matches everything, subject to room/limit.' },
        room: { type: 'string', description: 'Optional room name substring to narrow results.' },
        limit: { type: 'integer', description: 'Max matches to return. Default 20.' },
      },
    },
  },
  {
    name: 'local_state',
    description: 'Current value(s) of state uuid(s), from LoxSuite\'s own live cache — instant, no network round trip (unlike control_state). Try this first; cached:false means fall back to control_state for that uuid.',
    inputSchema: {
      type: 'object',
      properties: {
        uuids: { type: 'array', items: { type: 'string' }, description: 'One or more state uuids (from local_find) to read.' },
      },
      required: ['uuids'],
    },
  },
];

function isLocalTool(name) {
  return LOCAL_TOOLS.some((t) => t.name === name);
}

async function listLocalTools() {
  return LOCAL_TOOLS;
}

async function localFind(miniserver, { query, room, limit }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const roomFilter = room ? String(room).toLowerCase() : null;
  const cap = Number(limit) > 0 ? Number(limit) : 20;

  const states = await loxoneStructure.getMonitorableStates(miniserver);
  const matches = states.filter((s) => {
    const label = s.label.toLowerCase();
    if (roomFilter && !label.includes(roomFilter)) return false;
    if (words.length && !words.some((w) => label.includes(w))) return false;
    return true;
  });

  return {
    matches: matches.slice(0, cap).map((s) => ({ uuid: s.uuid, label: s.label })),
    total: matches.length,
    truncated: matches.length > cap,
  };
}

// Loxone's own value-memory uuids are consistently 8-4-4-16 hex (not the standard 8-4-4-4-12 RFC
// 4122 grouping) — every uuid this app has ever seen from a Miniserver's structure file matches
// this shape. Used to catch a model passing something that obviously isn't a real uuid (seen in
// practice: a smaller model skipping local_find and inventing a "uuid" like room/state names
// instead) with a message pointing it back at local_find, rather than a silent, uninformative
// cached:false that a weaker model is more likely to just give up on instead of retrying correctly.
function looksLikeUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/i.test(value);
}

function localState(miniserver, { uuids }) {
  const list = Array.isArray(uuids) ? uuids : [uuids].filter(Boolean);
  return {
    states: list.map((uuid) => {
      if (!looksLikeUuid(uuid)) {
        return { uuid, value: null, cached: false, error: `"${uuid}" is not a real state uuid — call local_find first to get one, then pass its exact "uuid" field here.` };
      }
      const value = loxoneWebSocket.getLiveValue(miniserver.id, uuid);
      return { uuid, value: value === undefined ? null : value, cached: value !== undefined };
    }),
  };
}

async function callLocalTool(miniserver, name, input) {
  if (name === 'local_find') return localFind(miniserver, input || {});
  if (name === 'local_state') return localState(miniserver, input || {});
  throw new Error(`Unknown local tool "${name}"`);
}

// Words that mean "this is a history/trend question, not a right-now one" — a live-cache snapshot
// would be a wrong (or at best misleading) answer to any of these, so tryPrefetch below bails out
// rather than risk handing the model a confidently-labeled but irrelevant "fact". Deliberately not
// exhaustive (matches loxoneStructure.js's own "no fixed list to bake in" stance elsewhere) — this
// only ever SKIPS the shortcut on a false negative, never answers wrong on one, so an occasional
// miss just falls back to the model's own control_history/control_statistics tool calls as before.
const NOT_CURRENT_VALUE_WORDS = ['gisteren', 'geschiedenis', 'historie', 'gemiddelde', 'maximum', 'minimum', 'vorige', 'trend', 'grafiek', 'was het', 'waren', 'yesterday', 'history', 'average', 'trend'];

// Verified end-to-end against a real Miniserver: model-driven tool orchestration for "what's the
// current value of X in room Y" turned out to be unreliable on a small local model — skipping the
// find-then-read step, inventing uuids, or fabricating an answer outright, despite explicit system-
// prompt instructions not to (see routes/aiChat.js's own history of this). Rather than trying to
// prompt-engineer around that further, this resolves the same common case in plain code — no LLM
// tool call involved at all — and hands the model a pre-computed, clearly-labeled fact it only has
// to read and state, not fetch correctly. Deliberately conservative: only returns something when a
// single room and a small, unambiguous set of matching states with a REAL cached value were found;
// anything murkier (no room mentioned, multiple rooms, too many/no matches, nothing cached) returns
// null and the turn proceeds exactly as it did before this existed — the model's own tools (local_*
// or control_*) still handle it, so a miss here is a no-op, never a wrong answer.
async function tryPrefetch(miniserver, questionText) {
  const lower = String(questionText || '').toLowerCase();
  if (NOT_CURRENT_VALUE_WORDS.some((w) => lower.includes(w))) return null;

  const rooms = await loxoneStructure.getRoomSummaries(miniserver);
  const matchedRooms = rooms.filter((r) => r.name && lower.includes(r.name.toLowerCase()));
  if (matchedRooms.length !== 1) return null;

  const room = matchedRooms[0].name;
  // Words left over after removing the room name are the "what" (temperatuur, rolluik, ...) — but
  // localFind's own OR-substring matching means a short glue word ("de", "in", "wat") isn't just
  // ignored, it actively matches almost anything (e.g. "de" is a substring of "Geactiveerd"),
  // blowing the match count past the confidence threshold below for what would otherwise have been
  // an unambiguous single-word query. Real content words in this domain (temperatuur, rolluik,
  // positie, licht, deur) all run 4+ characters, so a length filter is a safe, language-agnostic
  // stand-in for a real stopword list here.
  const queryWords = lower.split(room.toLowerCase()).join(' ').split(/\s+/).filter((w) => w.length > 3);
  const found = await localFind(miniserver, { query: queryWords.join(' '), room, limit: 5 });
  if (!found.matches.length || found.matches.length > 3) return null;

  const read = localState(miniserver, { uuids: found.matches.map((m) => m.uuid) });
  const known = read.states.filter((s) => s.cached);
  if (!known.length) return null;

  const lines = known.map((s) => {
    const label = found.matches.find((m) => m.uuid === s.uuid)?.label || s.uuid;
    return `${label} = ${s.value}`;
  });
  return `LoxSuite's own live cache already has this, right now (no tool call needed to get it):\n${lines.join('\n')}\nIf this answers the question, just state it directly. If the question needs something else instead (history/trend, a different control, or making a change), use your tools as normal — ignore this.`;
}

module.exports = { LOCAL_TOOLS, isLocalTool, listLocalTools, callLocalTool, tryPrefetch };
