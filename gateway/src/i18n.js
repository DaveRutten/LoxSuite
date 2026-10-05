// Languages and translations.
//
// English is the base language: the views call t('English text') and get the translation for the
// user's language, or the English text itself when there is none yet (so a half-translated
// language still works). Placeholders: t('{n} sessions', { n: 3 }).
//
// Where translations come from, later wins:
//   src/locales/<code>.json   shipped with LoxSuite (Dutch first)
//   table translations        made by users on the Translations page (or imported as JSON)
//
// The list of texts to translate (the "catalog") is collected from the views themselves: every
// t('...') call and every pageTitle, plus the module names and descriptions (modules.js). Each text
// belongs to a module (by the view it is in), so the Translations page can show progress per module.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const LOCALE_DIR = path.join(__dirname, 'locales');
const VIEW_DIR = path.join(__dirname, 'views');
const BASE = 'en';

let languages = [{ code: BASE, name: 'English', enabled: 1, is_default: 1 }];
const shipped = new Map(); // lang -> Map(key -> text)  (locale files)
const custom = new Map(); // lang -> Map(key -> { text, by, at })  (DB)
let catalogCache = null;
const clientKeys = new Set(); // texts translated in the browser (public/i18n.js)
let version = 1; // bumps on every change, for the browser's cached dictionary

const hash = (key) => crypto.createHash('sha1').update(String(key)).digest('hex');
const CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

function loadShipped() {
  shipped.clear();
  let files = [];
  try { files = fs.readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { files = []; }
  for (const f of files) {
    try { shipped.set(f.replace(/\.json$/, ''), new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'))))); } catch (e) { console.error(`[i18n] ${f}: ${e.message}`); }
  }
}

async function loadDb() {
  try { const rows = await db.prepare('SELECT * FROM languages ORDER BY is_default DESC, name').all(); if (rows.length) languages = rows; } catch { /* before migration */ }
  custom.clear();
  try {
    for (const r of await db.prepare('SELECT lang, msg_key, text, updated_by, updated_at FROM translations').all()) {
      if (!custom.has(r.lang)) custom.set(r.lang, new Map());
      custom.get(r.lang).set(r.msg_key, { text: r.text, by: r.updated_by, at: r.updated_at });
    }
  } catch { /* before migration */ }
}

// Installation-wide display options: the clock (24 h by default — the usual in the Netherlands and
// most of Europe; 12 h for those who want am/pm).
let options = { clock: '24' };
async function loadOptions() {
  try { const v = await require('./wallboxSettings').get('i18n', {}); options = { clock: '24', ...(v && typeof v === 'object' ? v : {}) }; } catch { /* defaults */ }
}
async function setClock(clock) {
  options = { ...options, clock: clock === '12' ? '12' : '24' };
  await require('./wallboxSettings').set('i18n', options);
}
const clock12 = () => options.clock === '12';
// BCP 47 locale for dates and numbers in the browser: nl -> nl-NL, en -> en-GB (day-month order), other codes as is.
const LOCALES = { nl: 'nl-NL', en: 'en-GB', de: 'de-DE', fr: 'fr-FR' };
const localeOf = (lang) => LOCALES[lang] || lang || 'en-GB';

async function init() { loadShipped(); await loadDb(); await loadOptions(); version = Date.now(); }

// The browser's dictionary for a language: only the texts its scripts build and server messages.
function clientDict(lang) {
  catalog();
  const out = {};
  if (!lang || lang === BASE) return out;
  // every translated text: also catches English that reaches the page from server data and scripts
  for (const e of catalogCache || []) { const v = lookup(lang, e.key); if (v && v !== e.key) out[e.key] = v; }
  return out;
}
const dictVersion = () => version;

function listLanguages() { return languages.map((l) => ({ code: l.code, name: l.name, enabled: !!l.enabled, isDefault: !!l.is_default })); }
function enabledLanguages() { return listLanguages().filter((l) => l.enabled); }
function defaultLanguage() { return (languages.find((l) => l.is_default && l.enabled) || { code: BASE }).code; }
function resolveLanguage(userLang) {
  if (userLang && languages.some((l) => l.code === userLang && l.enabled)) return userLang;
  return defaultLanguage();
}

function lookup(lang, key) {
  if (!lang || lang === BASE) return null;
  const c = custom.get(lang)?.get(key);
  if (c && c.text) return c.text;
  const s = shipped.get(lang)?.get(key);
  return s || null;
}

function fill(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

function translate(lang, key, vars) {
  if (key === undefined || key === null) return '';
  const k = String(key);
  return fill(lookup(lang, k) ?? k, vars);
}
const translator = (lang) => (key, vars) => translate(lang, key, vars);

// ------------------------------------------------------------------------- catalog

// The module a view belongs to (for progress per module); everything else is 'core'.
const VIEW_MODULE = [
  [/^(planner|agenda|learned)/, 'charging'],
  [/^(vehicle|driving)/, 'vehicles'],
  [/^energy-manager|^partials\/energy-load/, 'energy_manager'],
  [/^energy/, 'energy'],
  [/^ocpp|^partials\/ocpp/, 'ocpp'],
  [/^(monitor|dashboard)/, 'monitor'],
  [/^(mappings|incoming|mqtt-|transformations|logs-mqtt|logs-loxone-commands|settings-broker)/, 'mqtt'],
  [/^logs-loxone/, 'loxone_logs'],
  [/^(ai|admin-ai)/, 'ai'],
];
const moduleOfView = (rel) => (VIEW_MODULE.find(([re]) => re.test(rel)) || [null, 'core'])[1];

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p)); else if (e.name.endsWith('.ejs')) out.push(p);
  }
  return out;
}
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

// Texts in one view: t('...') / t("...") and pageTitle: '...'.
function extract(source) {
  const keys = [];
  const re = /\bt\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")|pageTitle:\s*'((?:[^'\\\n]|\\.)*)'/g;
  let m;
  while ((m = re.exec(source))) { const k = unescape(m[1] ?? m[2] ?? m[3] ?? ''); if (k.trim() && k.trim() === k) keys.push(k); } // (not prefixes like 'Vehicle: ' + name)
  return keys;
}

function catalog() {
  if (catalogCache) return catalogCache;
  const map = new Map(); // key -> { key, module, where:Set }
  const add = (key, module, where) => {
    const e = map.get(key) || { key, module, where: new Set() };
    if (e.module === 'core' && module !== 'core') e.module = module;
    e.where.add(where);
    map.set(key, e);
  };
  let files = [];
  try { files = walk(VIEW_DIR); } catch { files = []; }
  for (const f of files) {
    const rel = path.relative(VIEW_DIR, f).replace(/\\/g, '/').replace(/\.ejs$/, '');
    for (const k of extract(fs.readFileSync(f, 'utf8'))) add(k, moduleOfView(rel), rel);
  }
  try {
    const { MODULES, GROUPS } = require('./modules');
    for (const g of GROUPS) add(g.label, 'core', 'modules');
    for (const m of MODULES) { add(m.label, m.key, 'modules'); add(m.description, m.key, 'modules'); for (const p of m.parts || []) add(p, m.key, 'modules'); }
  } catch { /* modules not loadable */ }
  // Texts the browser builds and server messages (scripts/i18n-extract.js -> _client-catalog.json).
  try {
    for (const e of JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, '_client-catalog.json'), 'utf8'))) {
      for (const w of e.where) add(e.key, e.module, w);
      clientKeys.add(e.key);
    }
  } catch { /* not generated */ }
  try { for (const a of require('./permissionAreas').AREAS) add(a.label, a.module || 'core', 'permissionAreas'); } catch { /* none */ }
  // Labels in moduleInfo.js (status tables, Getting started checklist), per module block.
  try {
    let current = 'core';
    const keys = new Set(require('./modules').MODULES.map((m) => m.key));
    for (const line of fs.readFileSync(path.join(__dirname, 'moduleInfo.js'), 'utf8').split('\n')) {
      const head = /^ {2}(\w+): (\[|async)/.exec(line);
      if (head) current = keys.has(head[1]) ? head[1] : 'core';
      for (const m of line.matchAll(/label: '((?:[^'\\]|\\.)*)'/g)) add(unescape(m[1]), current, 'moduleInfo');
    }
  } catch { /* no moduleInfo */ }
  catalogCache = [...map.values()].map((e) => ({ key: e.key, module: e.module, where: [...e.where] })).sort((a, b) => a.key.localeCompare(b.key));
  return catalogCache;
}

// Per module: how many texts there are and how many have a translation in `lang`.
function progress(lang) {
  const out = new Map();
  for (const e of catalog()) {
    const p = out.get(e.module) || { module: e.module, total: 0, done: 0 };
    p.total += 1; if (lookup(lang, e.key)) p.done += 1;
    out.set(e.module, p);
  }
  const list = [...out.values()];
  const total = list.reduce((a, p) => a + p.total, 0); const done = list.reduce((a, p) => a + p.done, 0);
  return { modules: list, total, done, pct: total ? Math.round((done / total) * 100) : 100 };
}

// The catalog with the current translation of each text in `lang`.
function entries(lang) {
  return catalog().map((e) => {
    const c = custom.get(lang)?.get(e.key);
    const s = shipped.get(lang)?.get(e.key) || null;
    return { ...e, text: (c && c.text) || s || '', shipped: s, custom: !!(c && c.text), by: c?.by || null, at: c?.at || null };
  });
}

// ------------------------------------------------------------------------- changes

function assertLang(code) {
  if (!languages.some((l) => l.code === code)) throw new Error(`Unknown language "${code}".`);
  if (code === BASE) throw new Error('English is the base language and is not translated.');
}

// Saves (or, with empty text, removes) a user translation.
async function saveTranslation(lang, key, text, by = null) {
  assertLang(lang);
  const k = String(key);
  const v = String(text ?? '').trim();
  if (!v || v === (shipped.get(lang)?.get(k) || '')) {
    await db.prepare('DELETE FROM translations WHERE lang = ? AND key_hash = ?').run(lang, hash(k));
    custom.get(lang)?.delete(k);
    version += 1;
    return null;
  }
  const at = new Date().toISOString();
  await db.upsert('translations', { lang, key_hash: hash(k), msg_key: k, text: v, updated_by: by, updated_at: at }, ['lang', 'key_hash']);
  if (!custom.has(lang)) custom.set(lang, new Map());
  custom.get(lang).set(k, { text: v, by, at });
  version += 1;
  return v;
}

// Everything that is translated in `lang` (shipped + custom), as { english: translation }.
function exportLanguage(lang) {
  const out = {};
  for (const [k, v] of shipped.get(lang) || []) out[k] = v;
  for (const [k, v] of custom.get(lang) || []) if (v.text) out[k] = v.text;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function importLanguage(lang, data, by = null) {
  assertLang(lang);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object { "English text": "translation" }.');
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string' || !k.trim()) continue;
    await saveTranslation(lang, k, v, by); n += 1;
  }
  return n;
}

async function addLanguage(code, name) {
  const c = String(code || '').trim().toLowerCase();
  const n = String(name || '').trim();
  if (!CODE.test(c)) throw new Error('Use a language code like "de", "fr" or "pt-br".');
  if (!n) throw new Error('Give the language a name, e.g. "Deutsch".');
  if (languages.some((l) => l.code === c)) throw new Error(`Language "${c}" already exists.`);
  await db.prepare('INSERT INTO languages (code, name, enabled, is_default, created_at) VALUES (?, ?, 1, 0, ?)').run(c, n, new Date().toISOString());
  await loadDb();
}

async function setLanguageEnabled(code, on) {
  const l = languages.find((x) => x.code === code);
  if (!l) throw new Error(`Unknown language "${code}".`);
  if (!on && l.is_default) throw new Error('The default language cannot be switched off — choose another default first.');
  await db.prepare('UPDATE languages SET enabled = ? WHERE code = ?').run(on ? 1 : 0, code);
  await loadDb();
}

async function setDefaultLanguage(code) {
  const l = languages.find((x) => x.code === code);
  if (!l) throw new Error(`Unknown language "${code}".`);
  await db.prepare('UPDATE languages SET is_default = 0').run();
  await db.prepare('UPDATE languages SET is_default = 1, enabled = 1 WHERE code = ?').run(code);
  await loadDb();
}

async function removeLanguage(code) {
  if (code === BASE) throw new Error('English is the base language and cannot be removed.');
  const l = languages.find((x) => x.code === code);
  if (!l) throw new Error(`Unknown language "${code}".`);
  if (l.is_default) throw new Error('The default language cannot be removed — choose another default first.');
  await db.prepare('DELETE FROM translations WHERE lang = ?').run(code);
  await db.prepare('DELETE FROM languages WHERE code = ?').run(code);
  await db.prepare('UPDATE users SET language = NULL WHERE language = ?').run(code).catch(() => {});
  await loadDb();
}

function _reset() { clientKeys.clear(); languages = [{ code: BASE, name: 'English', enabled: 1, is_default: 1 }]; shipped.clear(); custom.clear(); catalogCache = null; }
function _set({ langs, files } = {}) { if (langs) languages = langs; if (files) for (const [k, v] of Object.entries(files)) shipped.set(k, new Map(Object.entries(v))); }

module.exports = {
  BASE, init, setClock, clientDict, dictVersion, clock12, localeOf, loadShipped, listLanguages, enabledLanguages, defaultLanguage, resolveLanguage, translate, translator, fill,
  extract, catalog, progress, entries, saveTranslation, exportLanguage, importLanguage,
  addLanguage, setLanguageEnabled, setDefaultLanguage, removeLanguage, moduleOfView, _reset, _set,
};
