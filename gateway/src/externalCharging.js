// Charging away from home: sessions from a charge card (E-Flux and others) or a public charger, so
// Driving & costs counts what charging really cost. E-Flux has no public API, so the sessions come from
// the export in its dashboard (CSV or Excel) — read here by recognising the columns by name, in Dutch or
// English, so other providers' exports work too — or are added by hand.
const crypto = require('crypto');
const db = require('./db');

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Column names (lower case, without punctuation) per field, the best match first.
const COLUMNS = {
  id: ['session id', 'sessie id', 'sessieid', 'transaction id', 'transactie id', 'cdr id', 'id'],
  start: ['start time', 'starttijd', 'start datum', 'startdatum', 'started at', 'start date', 'start', 'begin', 'datum', 'date'],
  end: ['end time', 'eindtijd', 'stop time', 'stoptijd', 'ended at', 'end date', 'einddatum', 'end', 'eind', 'stop'],
  kwh: ['kwh', 'energy kwh', 'energie kwh', 'volume kwh', 'verbruik kwh', 'energy', 'energie', 'volume', 'verbruik', 'consumption'],
  cost: ['price incl vat', 'prijs incl btw', 'total incl vat', 'totaal incl btw', 'kosten incl btw', 'amount incl vat', 'bedrag incl btw', 'total price', 'totaalprijs', 'totaal', 'total', 'kosten', 'cost', 'costs', 'price', 'prijs', 'amount', 'bedrag'],
  location: ['location', 'locatie', 'address', 'adres', 'location name', 'locatienaam', 'city', 'plaats', 'evse id'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[()€.,:/_-]+/g, ' ').replace(/\s+/g, ' ').trim();

// Pure: header row -> { field: column index }. An exact name wins over one that only contains it;
// "excl" columns never count as the cost.
function mapColumns(header) {
  const h = header.map(norm);
  const out = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    let idx = -1;
    for (const n of names) { idx = h.findIndex((x, i) => x === n && !Object.values(out).includes(i)); if (idx >= 0) break; }
    // then a column that has the name as whole words — not for the id: "EVSE ID" or "Card ID" is the
    // same for many sessions and would merge them
    if (idx < 0 && field !== 'id') {
      for (const n of names) {
        const re = new RegExp(`(^| )${n.replace(/ /g, ' ')}( |$)`);
        idx = h.findIndex((x, i) => re.test(x) && !Object.values(out).includes(i)
          && !(field === 'cost' && /excl|kwh|duur|duration/.test(x)) && !(field === 'kwh' && /prijs|price|cost|kosten|tarief|rate/.test(x)));
        if (idx >= 0) break;
      }
    }
    if (idx >= 0) out[field] = idx;
  }
  return out;
}

// Pure: "1.234,56" / "1,234.56" / "12,5" / "€ 3,10" -> number.
function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Pure: a date as the export writes it -> epoch ms. localToMs(y, m, d, hh, mm) turns a local wall-clock
// time into ms (the display time zone). An Excel serial number (days since 1899-12-30) works too.
function parseDate(v, localToMs) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const serial = Number(v);
    if (serial > 20000 && serial < 80000) {
      const day = Math.floor(serial);
      const mins = Math.round((serial - day) * 1440);
      const d = new Date(Date.UTC(1899, 11, 30) + day * 86400000);
      return localToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(mins / 60), mins % 60);
    }
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return localToMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return localToMs(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0));
  return null;
}

// Pure: CSV text -> rows (arrays). ; , or tab, whichever the header uses most; quotes with "" inside.
function parseCsv(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const sep = [';', ',', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

// An Excel file (.xlsx) -> rows of its first sheet (shared strings, inline strings, numbers).
function parseXlsx(buffer) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const text = (name) => { const e = zip.getEntry(name); return e ? e.getData().toString('utf8') : ''; };
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const sheetName = zip.getEntries().map((e) => e.entryName).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) return [];
  const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const rows = [];
  for (const rm of text(sheetName).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else if (type === 'str' || type === 'b') val = unxml(v ?? '');
      else val = v === undefined ? '' : Number(v);
      row[ref ? colIdx(ref) : row.length] = val;
    }
    if (row.some((x) => x !== undefined && String(x).trim() !== '')) rows.push(Array.from(row, (x) => (x === undefined ? '' : x)));
  }
  return rows;
}

// Pure: rows (the first with column names somewhere in the first 10) -> sessions
// [{ ext_id, start_at, end_at, kwh, cost_eur, location }] + what was skipped and why.
function sessionsFromRows(rows, { localToMs, provider = 'E-Flux' }) {
  const hi = rows.slice(0, 10).findIndex((r) => { const m = mapColumns(r); return m.start !== undefined && m.kwh !== undefined; });
  if (hi < 0) return { sessions: [], skipped: rows.length, error: 'No columns for the start time and kWh found — is this the export of your charging sessions?' };
  const col = mapColumns(rows[hi]);
  const sessions = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const start = parseDate(r[col.start], localToMs);
    const kwh = num(r[col.kwh]);
    if (!start || !(kwh > 0)) { skipped++; continue; }
    const end = col.end !== undefined ? parseDate(r[col.end], localToMs) : null;
    const cost = col.cost !== undefined ? num(r[col.cost]) : null;
    const own = col.id !== undefined ? String(r[col.id] || '').trim() : '';
    const ext = own ? `${provider}:${own}` : `${provider}:${crypto.createHash('sha1').update(`${start}|${r3(kwh)}|${cost ?? ''}`).digest('hex').slice(0, 20)}`;
    sessions.push({
      ext_id: ext.slice(0, 128), start_at: new Date(start).toISOString(), end_at: end ? new Date(end).toISOString() : null,
      kwh: r3(kwh), cost_eur: cost === null ? null : r2(cost), location: col.location !== undefined ? String(r[col.location] || '').trim().slice(0, 200) || null : null,
    });
  }
  return { sessions, skipped, columns: Object.keys(col) };
}

function localToMsFactory() {
  const { displayTz, localTimeOn } = require('./localTime');
  const tz = displayTz();
  return (y, m, d, hh, mm) => localTimeOn(Date.UTC(y, m - 1, d, 12), `${hh}:${mm}`, tz);
}

// An uploaded export (buffer + file name) -> stored; sessions already there (same ext_id) are skipped.
async function importFile(buffer, name, { vehicleId = null, provider = 'E-Flux' } = {}) {
  const isXlsx = /\.xlsx$/i.test(name || '') || (buffer[0] === 0x50 && buffer[1] === 0x4b);
  const rows = isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString('utf8'));
  const res = sessionsFromRows(rows, { localToMs: localToMsFactory(), provider });
  if (res.error) return { ok: false, message: res.error, added: 0, known: 0, skipped: res.skipped };
  let added = 0, known = 0;
  const now = new Date().toISOString();
  for (const s of res.sessions) {
    const exists = await db.prepare('SELECT id FROM external_charges WHERE ext_id = ?').get(s.ext_id);
    if (exists) { known++; continue; }
    await db.prepare('INSERT INTO external_charges (vehicle_id, start_at, end_at, kwh, cost_eur, provider, location, source, ext_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(vehicleId, s.start_at, s.end_at, s.kwh, s.cost_eur, provider, s.location, 'import', s.ext_id, now);
    added++;
  }
  return { ok: true, added, known, skipped: res.skipped, total: res.sessions.length };
}

async function addManual({ vehicleId = null, date, time = '12:00', kwh, costEur, provider = '', location = '' }) {
  const k = num(kwh);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m || !(k > 0)) throw new Error('Fill in a date and the kWh.');
  const [hh, mm] = String(time || '12:00').split(':').map(Number);
  const start = localToMsFactory()(+m[1], +m[2], +m[3], hh || 0, mm || 0);
  const cost = costEur === '' || costEur === null || costEur === undefined ? null : num(costEur);
  await db.prepare('INSERT INTO external_charges (vehicle_id, start_at, end_at, kwh, cost_eur, provider, location, source, ext_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(vehicleId, new Date(start).toISOString(), null, r3(k), cost === null ? null : r2(cost), String(provider || '').slice(0, 64) || null, String(location || '').slice(0, 200) || null, 'manual', `manual:${crypto.randomUUID()}`, new Date().toISOString());
}

async function remove(id) { await db.prepare('DELETE FROM external_charges WHERE id = ?').run(Number(id)); }

// The sessions of a car (and those not tied to a car, when it is the only one) since `days` ago.
async function list(vehicleId, { days = 400, includeUnassigned = true } = {}) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`SELECT * FROM external_charges WHERE start_at >= ? AND (vehicle_id = ?${includeUnassigned ? ' OR vehicle_id IS NULL' : ''}) ORDER BY start_at DESC`).all(from, vehicleId);
}

// Pure: sessions -> per month { kwh, eur, n, eurKnownKwh } (eur only over sessions with a cost).
function byMonth(sessions, monthOf) {
  const out = new Map();
  for (const s of sessions || []) {
    const k = monthOf(Date.parse(s.start_at));
    const g = out.get(k) || { month: k, kwh: 0, eur: 0, n: 0, eurKwh: 0 };
    g.kwh += Number(s.kwh) || 0; g.n++;
    if (Number.isFinite(s.cost_eur) && s.cost_eur !== null) { g.eur += Number(s.cost_eur); g.eurKwh += Number(s.kwh) || 0; }
    out.set(k, g);
  }
  return new Map([...out].map(([k, g]) => [k, { month: k, kwh: r2(g.kwh), eur: r2(g.eur), n: g.n, eurPerKwh: g.eurKwh > 0 ? r3(g.eur / g.eurKwh) : null }]));
}

module.exports = { mapColumns, num, parseDate, parseCsv, parseXlsx, sessionsFromRows, importFile, addManual, remove, list, byMonth };
