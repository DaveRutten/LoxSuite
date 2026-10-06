// What kind of day it is — not every Tuesday is a normal Tuesday. Per local day:
//   'away'     nobody home: an appointment with an "away" word (vakantie, holiday…), the period you set, or
//              the presence signal from Loxone said nobody was home most of the day
//   'holiday'  a Dutch public holiday (Easter, King's Day, Ascension, Whitsun, Christmas…)
//   'home'     an appointment with a "home" word (thuiswerken…)
//   'weekend' / 'workday'
// Away days are left out of what is learned (they would make the normal pattern look emptier), and in the
// plan an away day expects no tap water, no appliance runs, no learned departure and only the house's base
// load. A holiday is planned like a weekend day.
const settings = require('./wallboxSettings');

const DAY = 86400000;
const DEFAULTS = {
  away_words: 'vakantie, holiday, vacation, op reis, weg, afwezig, away',
  home_words: 'thuiswerken, thuiswerk, wfh, home office, thuis',
  away_from: '', away_to: '',
  presence_ms: null, presence_uuid: '', presence_home_value: '1',
  holidays: true,
};

async function getConfig() { return { ...DEFAULTS, ...(await settings.get('day_types', {})) }; }
async function saveConfig(c) { await settings.set('day_types', { ...(await getConfig()), ...c }); cache = null; }

const words = (text) => String(text || '').split(/[,;\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Pure: Easter Sunday (Gregorian, anonymous algorithm) -> { m, d }.
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return { m: month, d: ((h + l - 7 * m + 114) % 31) + 1 };
}

// Pure: Dutch public holidays of a year -> Map 'YYYY-MM-DD' -> name.
function dutchHolidays(y) {
  const out = new Map();
  const add = (m, d, name) => out.set(key(y, m, d), name);
  const e = easter(y);
  const eMs = Date.UTC(y, e.m - 1, e.d);
  const rel = (days, name) => { const t = new Date(eMs + days * DAY); out.set(key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), name); };
  add(1, 1, 'New Year');
  rel(0, 'Easter'); rel(1, 'Easter Monday'); rel(39, 'Ascension'); rel(49, 'Whitsun'); rel(50, 'Whit Monday');
  // King's Day: 27 April, the 26th when the 27th is a Sunday
  add(4, new Date(Date.UTC(y, 3, 27)).getUTCDay() === 0 ? 26 : 27, "King's Day");
  add(5, 5, 'Liberation Day');
  add(12, 25, 'Christmas'); add(12, 26, 'Boxing Day');
  return out;
}

// Pure: the type of one local day.
//   ctx: { weekday (0 = Monday), items: agenda items touching that day [{ title, allDay }], awayFrom, awayTo,
//          presenceAway (true when Loxone said nobody was home most of the day), holiday (name|null), cfg }
function typeOf(day, ctx) {
  const cfg = ctx.cfg || DEFAULTS;
  const has = (list) => (ctx.items || []).some((i) => list.some((w) => String(i.title || '').toLowerCase().includes(w)));
  if ((cfg.away_from && cfg.away_to && day >= cfg.away_from && day <= cfg.away_to) || ctx.presenceAway || has(words(cfg.away_words))) return 'away';
  if (cfg.holidays !== false && ctx.holiday) return 'holiday';
  if (has(words(cfg.home_words))) return 'home';
  return ctx.weekday >= 5 ? 'weekend' : 'workday';
}

let cache = null;

// Day types for local days between fromMs and toMs: Map 'YYYY-MM-DD' -> { type, why }.
async function typesBetween(fromMs, toMs) {
  const ck = `${Math.floor(fromMs / 3600000)}|${Math.floor(toMs / 3600000)}`;
  if (cache && cache.key === ck && Date.now() - cache.at < 10 * 60000) return cache.value;
  const { localParts, localMidnight } = require('./localTime');
  const cfg = await getConfig();
  let items = [];
  try { items = await require('./agenda').items(new Date(fromMs).toISOString(), new Date(toMs).toISOString()); } catch { items = []; }
  const presence = (await settings.get('presence_days', {})) || {};
  const out = new Map();
  for (let t = localMidnight(fromMs); t < toMs; t = localMidnight(t, undefined, 1)) {
    const p = localParts(t + 12 * 3600000);
    const day = key(p.y, p.m, p.d);
    const end = localMidnight(t, undefined, 1);
    const touching = items.filter((i) => Date.parse(i.start) < end && Date.parse(i.end) > t);
    const holiday = dutchHolidays(p.y).get(day) || null;
    const presenceAway = presence[day] !== undefined && presence[day] >= 20 * 60;
    const type = typeOf(day, { weekday: p.weekday, items: touching, holiday, presenceAway, cfg });
    const why = type === 'away' ? (presenceAway ? 'presence' : (cfg.away_from && day >= cfg.away_from && day <= cfg.away_to ? 'period' : 'agenda'))
      : type === 'holiday' ? holiday : type === 'home' ? 'agenda' : null;
    out.set(day, { type, why });
  }
  cache = { key: ck, at: Date.now(), value: out };
  return out;
}

// The days that were away in the learning window (to leave out of what is learned): Set of day keys.
async function awayDays(nowMs = Date.now(), days = 56) {
  const types = await typesBetween(nowMs - days * DAY, nowMs + DAY).catch(() => new Map());
  return new Set([...types].filter(([, v]) => v.type === 'away').map(([d]) => d));
}

// Every minute (energy manager): book the minutes nobody was home, per day, from the presence signal.
async function samplePresence(nowMs = Date.now(), dtMin = 1) {
  const cfg = await getConfig();
  if (!cfg.presence_ms || !cfg.presence_uuid) return null;
  const db = require('./db');
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(cfg.presence_ms));
  if (!ms) return null;
  const ws = require('./loxoneWebSocket');
  ws.ensureConnection(ms);
  const v = ws.getLiveValue(ms.id, cfg.presence_uuid);
  if (v === undefined || v === null || v === '') return null;
  const home = String(Number.isFinite(Number(v)) ? Number(v) : v) === String(cfg.presence_home_value ?? '1');
  if (home) return true;
  const { localParts } = require('./localTime');
  const p = localParts(nowMs);
  const day = key(p.y, p.m, p.d);
  const map = (await settings.get('presence_days', {})) || {};
  map[day] = (map[day] || 0) + dtMin;
  for (const k of Object.keys(map)) if (k < key(p.y - 1, p.m, p.d)) delete map[k];
  await settings.set('presence_days', map);
  return false;
}

module.exports = { DEFAULTS, getConfig, saveConfig, easter, dutchHolidays, typeOf, typesBetween, awayDays, samplePresence, words };
