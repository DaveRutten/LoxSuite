#!/usr/bin/env node
// Collects the texts that the BROWSER builds (JavaScript in the views and in public/*.js) and the
// messages the server sends back (error/message strings), for the Translations page and the
// in-browser translator (public/i18n.js). The texts in the views' HTML are found at runtime
// (t('...') calls, see i18n.js); these can't be, because finding them needs a JavaScript parser.
//
// Writes src/locales/_client-catalog.json. Run after changing visible texts in scripts:
//   npm i --no-save acorn acorn-walk && node scripts/i18n-extract.js
//
// A string built from pieces ('Learned: ' + n + ' runs') becomes one text with placeholders
// ("Learned: {0} runs"); HTML tags split it into the separate texts the browser shows.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const PUBLIC = path.join(ROOT, 'public');
const ENT = { amp: '&', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', nbsp: ' ', gt: '>', lt: '<', quot: '"', '#39': "'", times: '×', middot: '·', deg: '°', euro: '€', le: '≤', ge: '≥', bull: '•', minus: '−' };
const decode = (s) => s.replace(/&(#?[a-z0-9]+);/gi, (m, n) => (ENT[n] !== undefined ? ENT[n] : /^#\d+$/.test(n) ? String.fromCodePoint(Number(n.slice(1))) : m));

function prose(k) {
  const lit = k.replace(/\{\d+\}/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(lit)) return false;
  if (UI_WORDS.has(lit)) return true; // known one-word UI texts (yes, no, unknown, ...)
  if (/@@|prefers-/.test(k)) return false; // markers, media queries
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|PRAGMA)\b/.test(lit)) return false; // SQL
  // '=' only as prose (" = "), not code (a=b)
  if (/[{}\\`$|]|;(?! )|=>|[^ ]=|=[^ ]|\/\/|^\.|^#|^\/|https?:|var\(--|rgba?\(|\bpx\b|^\w+\(|\.(js|css|json|svg|png)\b/.test(lit)) return false;
  if (/^[a-z0-9_.:\-/]+$/i.test(lit) && !/^[A-Z][a-z]+$/.test(lit)) return false; // identifiers, classes, ids
  if (/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(lit) && lit.split(' ').filter((w) => w.includes('-')).length * 2 >= lit.split(' ').length) return false; // css class lists
  if (/^[A-Z0-9_]+$/.test(lit)) return false; // CONSTANTS
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD)\b/.test(lit)) return false;
  if (/^(Content-Type|Accept|Authorization|X-[A-Z])/i.test(lit)) return false;
  if (/^(application|text|image)\//.test(lit)) return false;
  if (/^[a-z]+$/.test(lit) && lit.length < 3) return false;
  // a single lower-case word is usually a key/state, not something shown — unless it's a known UI word
  if (/^[a-z]+$/.test(lit) && !UI_WORDS.has(lit)) return false;
  return true;
}
const UI_WORDS = new Set(['on', 'off', 'yes', 'no', 'charging', 'unknown', 'driving', 'home', 'away', 'working', 'failing', 'ok', 'week', 'month', 'year', 'day', 'today', 'tomorrow', 'yesterday', 'now', 'never', 'none', 'running', 'remove', 'export', 'incomplete', 'balance', 'cost', 'back', 'live', 'shadow', 'dry', 'error', 'ok', 'waiting', 'full', 'sessions', 'session', 'charging', 'plugged', 'unplugged', 'solar', 'grid', 'expected', 'loading', 'saved', 'edit', 'delete', 'save', 'cancel', 'close', 'open', 'show', 'hide', 'all', 'more', 'less', 'free', 'fixed', 'auto', 'manual', 'online', 'offline', 'unknown', 'connected', 'disconnected', 'enabled', 'disabled', 'active', 'inactive', 'idle', 'done', 'failed', 'pending', 'paused', 'stopped', 'started', 'finished', 'weekly', 'daily', 'monthly', 'hourly', 'min', 'max', 'average', 'total', 'trips', 'trip', 'days', 'hours', 'minutes', 'from', 'until', 'to', 'at', 'by', 'and', 'or', 'of', 'in', 'kept']);

// Text pieces of a built string: split on HTML tags, decode entities, collapse spaces.
function segments(str) {
  const out = [];
  for (const part of str.split(/<[^>]*>/g)) {
    const k = decode(part).replace(/\s+/g, ' ').trim();
    if (k && prose(k)) out.push(k);
  }
  return out;
}

// Flattens a + chain (or template literal) into a string with {n} for the non-literal parts.
function build(node, src) {
  const parts = [];
  let n = 0;
  const visit = (x) => {
    if (x.type === 'BinaryExpression' && x.operator === '+') { visit(x.left); visit(x.right); return; }
    if (x.type === 'Literal' && typeof x.value === 'string') { parts.push(x.value); return; }
    if (x.type === 'TemplateLiteral') {
      x.quasis.forEach((q, i) => { parts.push(q.value.cooked ?? q.value.raw); if (i < x.expressions.length) parts.push(`{${n++}}`); });
      return;
    }
    if (x.type === 'Literal') { parts.push(String(x.value)); return; }
    parts.push(`{${n++}}`);
  };
  visit(node);
  void src;
  return parts.join('');
}
// Renumber placeholders per segment so every text starts at {0}.
const renumber = (k) => { let i = 0; const map = {}; return k.replace(/\{(\d+)\}/g, (m, d) => `{${map[d] ?? (map[d] = i++)}}`); };

function fromJs(code, where, add) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true }); } catch (e) {
    console.warn(`  ! ${where}: ${e.message}`); return;
  }
  const inChain = new Set();
  walk.fullAncestor(ast, (node, ancestors) => {
    const isStr = (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+');
    if (!isStr || inChain.has(node)) return;
    const parent = ancestors[ancestors.length - 2];
    if (parent && parent.type === 'BinaryExpression' && parent.operator === '+') return; // the top of the chain handles it
    if (parent && parent.type === 'Property' && ['keywords', 'insertText', 'icon', 'color', 'type', 'key', 'id', 'name', 'value', 'class', 'className', 'href', 'url', 'method'].includes(parent.key?.name || parent.key?.value)) return;
    if (parent && (parent.type === 'ImportDeclaration' || (parent.type === 'Property' && parent.key === node) || parent.type === 'MemberExpression' && parent.property === node)) return;
    if (parent && parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && ['require', 'querySelector', 'getElementById', 'querySelectorAll', 'fetch', 'getAttribute', 'setAttribute', 'addEventListener', 'removeEventListener', 'matchMedia', 'getItem', 'setItem'].includes(parent.callee.name)) return;
    if (parent && parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && ['querySelector', 'querySelectorAll', 'getElementById', 'getAttribute', 'setAttribute', 'addEventListener', 'removeEventListener', 'closest', 'matches', 'getItem', 'setItem', 'removeItem', 'add', 'remove', 'toggle', 'contains', 'split', 'join', 'replace', 'startsWith', 'endsWith', 'indexOf', 'includes', 'getPropertyValue', 'setProperty', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'padStart', 'createElement', 'append', 'json', 'fetch', 'test', 'match'].includes(parent.callee.property?.name)) {
      if (!(parent.callee.property?.name === 'append')) return;
    }
    if (node.type === 'BinaryExpression') {
      // only chains that contain at least one string
      let hasStr = false;
      walk.simple(node, { Literal(l) { if (typeof l.value === 'string') hasStr = true; }, TemplateLiteral() { hasStr = true; } });
      if (!hasStr) return;
    }
    const str = build(node, code);
    for (const seg of segments(str)) add(renumber(seg), where);
  });
}

// <script> blocks of a view, with the EJS tags replaced by something neutral.
function scriptsOf(ejsSrc) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(ejsSrc))) {
    if (/\bsrc=/.test(m[1]) || /type="(?!text\/javascript|module)[^"]+"/.test(m[1])) continue;
    out.push(m[2].replace(/<%[-=]?([\s\S]*?)%>/g, (all, inner) => (/^\s*(if|}|for|else|const|let|var|\/\/)/.test(inner) && !all.startsWith('<%=') && !all.startsWith('<%-') ? '' : '(0)')));
  }
  return out;
}

// Server messages that reach the page: error/message/reason strings and new Error('...').
const SKIP_CALLS = new Set(['log', 'warn', 'error', 'info', 'debug', 'logSystemEvent', 'logRejected', 'logAccepted', 'prepare', 'require', 'exec', 'execFile', 'spawn', 'raw', 'query', 'run', 'get', 'all', 'setHeader', 'set', 'header', 'redirect', 'createHash', 'readFileSync', 'writeFileSync', 'join', 'resolve', 'test', 'match', 'replace', 'split', 'startsWith', 'endsWith', 'includes', 'indexOf', 'on', 'emit', 'publish', 'subscribe', 'connect', 'fetch', 'upsert', 'insertReturningId', 'transaction']);
function fromServer(code, where, add) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true }); } catch (e) { console.warn(`  ! ${where}: ${e.message}`); return; }
  walk.fullAncestor(ast, (node, ancestors) => {
    const isStr = (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+');
    if (!isStr) return;
    const parent = ancestors[ancestors.length - 2];
    if (!parent) return;
    if (parent.type === 'BinaryExpression' && parent.operator === '+') return;
    if (parent.type === 'TaggedTemplateExpression') return;
    if (parent.type === 'Property' && parent.key === node) return;
    if (parent.type === 'MemberExpression' && parent.property === node) return;
    if (parent.type === 'ImportDeclaration') return;
    // skip strings inside logging / db / header / regex-ish calls anywhere up the chain
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'CallExpression') {
        const name = a.callee.type === 'Identifier' ? a.callee.name : a.callee.property?.name;
        if (SKIP_CALLS.has(name)) return;
        if (a.callee.type === 'MemberExpression' && a.callee.object?.name === 'console') return;
        break;
      }
      if (a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') break;
    }
    if (node.type === 'BinaryExpression') {
      let hasStr = false;
      walk.simple(node, { Literal(l) { if (typeof l.value === 'string') hasStr = true; }, TemplateLiteral() { hasStr = true; } });
      if (!hasStr) return;
    }
    for (const seg of segments(build(node, code))) {
      if (!/[A-Za-z]{2,}[^{]*\s[^{]*[A-Za-z]{2,}/.test(seg.replace(/\{\d+\}/g, ' ')) && !/^[A-Z][a-z]+$/.test(seg)) continue; // at least two words (or a capitalised word)
      add(renumber(seg), where);
    }
  });
}

// String literals inside the EJS code of a view (<%= cond ? 'Text' : 'Other' %>, option arrays...).
function fromEjsCode(src, where, add) {
  const re = /<%([=-]?)([\s\S]*?)[-_]?%>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2].trim().startsWith('#')) continue;
    const code = m[1] ? `(${m[2]})` : m[2];
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); } catch {
      // a code fragment that only parses together with the next tag (forEach(... => { ) — take its quoted strings
      for (const q of m[2].matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
        const v = q[1].replace(/\\'/g, "'");
        if (/^[A-Z]/.test(v) && /\s/.test(v) && prose(v)) add(v, where);
        else if (/^[A-Z][a-z]+$/.test(v) && prose(v)) add(v, where);
      }
      continue;
    }
    walk.fullAncestor(ast, (node, ancestors) => {
      if (!(node.type === 'Literal' && typeof node.value === 'string')) return;
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && ['t', 'include', 'icon', 'canView', 'canEdit', 'moduleOn', 'mod', 'em', 'require'].includes(parent.callee.name)) return;
      if (parent && parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && ['includes', 'replace', 'split', 'join', 'startsWith', 'toLocaleString', 'padStart', 'slice'].includes(parent.callee.property?.name)) return;
      if (parent && parent.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) return;
      if (parent && parent.type === 'Property' && parent.key === node) return;
      for (const seg of segments(node.value)) if (/\s/.test(seg) || /^[A-Z][a-z]+/.test(seg)) add(seg, where);
    });
  }
}

const VIEW_MODULE = (rel) => {
  const map = [[/^(planner|agenda|learned)/, 'charging'], [/^(vehicle|driving)/, 'vehicles'], [/^energy-manager|^partials\/energy-load/, 'energy_manager'], [/^energy/, 'energy'], [/^ocpp|^partials\/ocpp/, 'ocpp'], [/^(monitor|dashboard)/, 'monitor'], [/^(mappings|incoming|mqtt-|transformations|logs-mqtt|logs-loxone-commands)/, 'mqtt'], [/^logs-loxone/, 'loxone_logs'], [/^(ai|admin-ai)/, 'ai']];
  return (map.find(([re]) => re.test(rel)) || [null, 'core'])[1];
};
const SRC_MODULE = (rel) => {
  const map = [[/(planner|chargeLog|agenda|learning|reminders|fuelPrice)/, 'charging'], [/(vehicles|driving)/, 'vehicles'], [/(energyManager|energyPatterns)/, 'energy_manager'], [/(energyMeters|prices|solarForecast|energy\.js)/, 'energy'], [/ocpp/i, 'ocpp'], [/monitor|dashboard/i, 'monitor'], [/(mqtt|mapping|transformation|incoming|loxoneInbound|dynsec)/i, 'mqtt'], [/(ai|mcp|llm)/i, 'ai']];
  return (map.find(([re]) => re.test(rel)) || [null, 'core'])[1];
};

const found = new Map();
const add = (module) => (key, where) => {
  if (key.length > 400 || (/^\p{Extended_Pictographic}/u.test(key) && /admin-notifications/.test(where))) return; // emoji picker entries
  const e = found.get(key) || { key, module, where: new Set() };
  if (e.module === 'core' && module !== 'core') e.module = module;
  e.where.add(where);
  found.set(key, e);
};

const walkDir = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'vendor' || e.name === 'locales' || e.name === 'db' ? [] : walkDir(p, ext);
  return p.endsWith(ext) ? [p] : [];
});

for (const f of walkDir(VIEWS, '.ejs')) {
  const rel = path.relative(VIEWS, f).replace(/\\/g, '/').replace(/\.ejs$/, '');
  const src = fs.readFileSync(f, 'utf8');
  for (const code of scriptsOf(src)) fromJs(code, `${rel} (script)`, add(VIEW_MODULE(rel)));
  fromEjsCode(src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), rel, add(VIEW_MODULE(rel)));
}
for (const f of walkDir(PUBLIC, '.js')) {
  const rel = path.relative(PUBLIC, f).replace(/\\/g, '/');
  if (rel === 'i18n.js' || rel === 'sw.js') continue;

  fromJs(fs.readFileSync(f, 'utf8'), `public/${rel}`, add(/monitor|panel|dashboard|threshold|range-picker/.test(rel) ? 'monitor' : /mapping|transformation|topic/.test(rel) ? 'mqtt' : /ai-chat/.test(rel) ? 'ai' : 'core'));
}
for (const f of walkDir(path.join(ROOT, 'src'), '.js')) {
  const rel = path.relative(path.join(ROOT, 'src'), f).replace(/\\/g, '/');
  if (rel === 'countries.js') continue; // shown via Intl.DisplayNames in the user's language
  if (/^llm\/|^localDataTools|^aiPrompt|^aiTools/.test(rel)) continue; // texts for the AI model, not the page
  fromServer(fs.readFileSync(f, 'utf8'), `src/${rel}`, add(SRC_MODULE(rel)));
}

const list = [...found.values()].map((e) => ({ key: e.key, module: e.module, where: [...e.where].sort().slice(0, 5) })).sort((a, b) => a.key.localeCompare(b.key));
fs.writeFileSync(path.join(ROOT, 'src', 'locales', '_client-catalog.json'), `${JSON.stringify(list, null, 1)}\n`);
console.log(`${list.length} texts → src/locales/_client-catalog.json`);
