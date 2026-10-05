// Quarterly charging-session export for a bridged Wallbox (Laadloon / ERE registration).
//
// The fallback when sessions can't (or may not) go over OCPP: one spreadsheet per quarter with
// every charging session and the MID meter reading at its start and end — the same shape a
// Laadloon-accepted export from a Loxone installation already uses (title row, header row 3,
// sessie / starttijd / eindtijd / startwaarde / eindwaarde / verbruik_kWh, totals row).
//
// Sources, best first:
//  1. ocpp_bridge_sessions — sessions the bridge itself recorded (live OR dry mode: the meter
//     values are real either way). These have true MID readings at plug-in and (delayed) unplug.
//  2. The Wallbox's own session Tracker (control.subControls[*/history].states.entries — Loxone
//     keeps the last ~100 sessions as "YYYY-MM-DD HH:MM:SS {json}|..."). Each entry has connect /
//     disconnect epochs and the session's energy, but no meter readings; for those, the readings
//     are derived by walking back from the current MID total through the session energies. That
//     derivation is marked per row ("afgeleid") so it's never mistaken for a direct reading.
// A tracker session that matches a recorded bridge session (connect within MATCH_S) uses the
// bridge's readings instead.
const AdmZip = require('adm-zip');

const MATCH_S = 180;

// "2026-07-01 18:59:00 {json}|..." -> [{ connect, disconnect, energy }] (epoch seconds, kWh),
// oldest first. Malformed entries are skipped.
function parseTrackerEntries(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split('|').map((part) => {
    const i = part.indexOf('{');
    if (i === -1) return null;
    try {
      const j = JSON.parse(part.slice(i));
      if (!Number.isFinite(j.connect) || !Number.isFinite(j.disconnect)) return null;
      return { connect: j.connect, disconnect: j.disconnect, energy: Number(j.energy) || 0 };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.connect - b.connect);
}

// UTC epoch (seconds) of local midnight on y-m-d in `timeZone`.
function zonedMidnight(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((guess - (asLocal - guess)) / 1000);
}

// "2026Q3" -> { name, start, end } in epoch seconds ([start, end)), local to timeZone.
function quarterRange(quarter, timeZone) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(quarter || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const end = q === 4 ? zonedMidnight(y + 1, 1, 1, timeZone) : zonedMidnight(y, startMonth + 3, 1, timeZone);
  return { name: `${y}Q${q}`, start: zonedMidnight(y, startMonth, 1, timeZone), end };
}

// The most recent complete quarters, newest first ("2026Q3", "2026Q2", ...).
function recentQuarters(now = new Date(), count = 6) {
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3); // previous quarter (0 = Q4 of last year)
  const out = [];
  for (let i = 0; i < count; i++) {
    if (q === 0) { q = 4; y -= 1; }
    out.push(`${y}Q${q}`);
    q -= 1;
  }
  return out;
}

// Builds the export rows for [start, end).
//   tracker: parseTrackerEntries() output (oldest first)
//   recorded: ocpp_bridge_sessions rows (started_at/stopped_at ISO, meter_*_wh)
//   currentTotalKwh: the Wallbox's current MID total (anchor for derived readings)
// Returns { rows: [{ start, end, meterStart, meterStop, energy, source }], incomplete }.
// meterStart/meterStop in kWh; source 'gemeten' (bridge reading) or 'afgeleid' (derived).
function buildQuarterRows({ tracker, recorded, currentTotalKwh, start, end, excludeVehicleIds = [] }) {
  const excluded = new Set(excludeVehicleIds.map(Number));
  const rec = (recorded || [])
    .filter((r) => r.stopped_at && r.meter_stop_wh != null)
    .map((r) => ({
      skip: r.vehicle_id != null && excluded.has(Number(r.vehicle_id)),
      connect: Math.round(Date.parse(r.started_at) / 1000),
      disconnect: Math.round(Date.parse(r.stopped_at) / 1000),
      meterStart: r.meter_start_wh / 1000,
      meterStop: r.meter_stop_wh / 1000,
    }));

  // Derived readings: walk back from the current total through every tracker session's energy.
  const derived = new Map();
  let anchor = Number(currentTotalKwh);
  for (let i = tracker.length - 1; i >= 0; i--) {
    const s = tracker[i];
    derived.set(s, { meterStop: anchor, meterStart: anchor - s.energy });
    anchor -= s.energy;
  }

  const rows = [];
  const usedRec = new Set();
  for (const s of tracker) {
    if (s.connect < start || s.connect >= end) continue;
    const match = rec.find((r) => !usedRec.has(r) && Math.abs(r.connect - s.connect) <= MATCH_S);
    if (match) {
      usedRec.add(match);
      if (match.skip) continue; // a car whose sessions are not reported (Vehicles)
      rows.push({ start: s.connect, end: s.disconnect, meterStart: match.meterStart, meterStop: match.meterStop, source: 'gemeten' });
    } else {
      const d = derived.get(s);
      rows.push({ start: s.connect, end: s.disconnect, meterStart: d.meterStart, meterStop: d.meterStop, source: 'afgeleid' });
    }
  }
  // Recorded sessions the tracker no longer holds (it keeps only ~100 entries).
  for (const r of rec) {
    if (usedRec.has(r) || r.skip || r.connect < start || r.connect >= end) continue;
    rows.push({ start: r.connect, end: r.disconnect, meterStart: r.meterStart, meterStop: r.meterStop, source: 'gemeten' });
  }
  rows.sort((a, b) => a.start - b.start);
  const out = rows
    .map((r) => ({ ...r, meterStart: round3(r.meterStart), meterStop: round3(r.meterStop), energy: round3(r.meterStop - r.meterStart) }))
    .filter((r) => r.energy > 0);
  const oldest = Math.min(tracker[0]?.connect ?? Infinity, ...rec.map((r) => r.connect));
  return { rows: out, incomplete: !(oldest <= start) };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function formatLocal(epochS, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochS * 1000));
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minimal single-sheet XLSX (no extra dependency — adm-zip is already used by backups).
// cells: array of rows, each an array of { v, bold?, num? } | string | number | null.
function buildXlsx(cells, { sheetName = 'Laadsessies', colWidths = [] } = {}) {
  const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const rowsXml = cells.map((row, r) => {
    const cellsXml = (row || []).map((c, ci) => {
      if (c === null || c === undefined || c === '') return '';
      const cell = typeof c === 'object' ? c : { v: c };
      const ref = `${colLetter(ci)}${r + 1}`;
      const style = cell.bold ? (typeof cell.v === 'number' ? 3 : 1) : (typeof cell.v === 'number' ? 2 : 0);
      if (typeof cell.v === 'number') return `<c r="${ref}" s="${style}"><v>${cell.v}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cellsXml}</row>`;
  }).join('');
  const cols = colWidths.length ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
  zip.addFile('xl/styles.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf fontId="0"/><xf fontId="1" applyFont="1"/><xf fontId="0" numFmtId="164" applyNumberFormat="1"/><xf fontId="1" numFmtId="164" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`));
  return zip.toBuffer();
}

// Sheet layout: title (row 1), header (row 3), one row per session, totals row, source notes.
function buildSheetCells({ title, rows, quarterName, timeZone, incomplete }) {
  const cells = [[{ v: title, bold: true }], [], ['sessie', 'starttijd', 'eindtijd', 'startwaarde', 'eindwaarde', 'verbruik_kWh', 'bron'].map((v) => ({ v, bold: true }))];
  rows.forEach((r, i) => cells.push([i + 1, formatLocal(r.start, timeZone), formatLocal(r.end, timeZone), r.meterStart, r.meterStop, r.energy, r.source]));
  const total = round3(rows.reduce((s, r) => s + r.energy, 0));
  cells.push([{ v: 'Totaal', bold: true }, null, null, null, null, { v: total, bold: true }]);
  cells.push([]);
  cells.push([`Periode ${quarterName}; sessies op starttijd (${timeZone}). Meterstanden in kWh van de MID-meter van de wallbox.`]);
  cells.push(['bron "gemeten": meterstand direct uitgelezen bij in- en uitpluggen door LoxSuite. bron "afgeleid": berekend uit de actuele MID-stand en de sessie-energie uit het sessielog van de Miniserver.']);
  if (incomplete) cells.push(['LET OP: het sessielog gaat niet ver genoeg terug om dit kwartaal volledig te dekken; vroege sessies kunnen ontbreken.']);
  return { cells, total };
}

function buildCsv({ rows, timeZone }) {
  const lines = ['sessie;starttijd;eindtijd;startwaarde;eindwaarde;verbruik_kWh;bron'];
  rows.forEach((r, i) => lines.push([i + 1, formatLocal(r.start, timeZone), formatLocal(r.end, timeZone),
    r.meterStart.toFixed(3), r.meterStop.toFixed(3), r.energy.toFixed(3), r.source].join(';')));
  return lines.join('\r\n') + '\r\n';
}

// The same sessions with cost, reimbursement and balance (ocppFinance.costSessions rows).
const SOURCE_LABEL = { uur: 'uurprijs', vast: 'vast tarief', gem: 'gem. prijs' };
const FIN_HEADER = ['sessie', 'starttijd', 'eindtijd', 'verbruik_kWh', 'tarief_eur_kWh', 'vergoeding_eur', 'kosten_eur', 'saldo_eur', 'zon_pct', 'kostenbron'];
function financeLine(r, i, timeZone) {
  return [i + 1, formatLocal(r.start, timeZone), formatLocal(r.end, timeZone), r.energy, r.tariff, r.reimbursement, r.cost, r.saldo, r.solarShare, SOURCE_LABEL[r.costSource] || ''];
}
function buildFinanceSheetCells({ title, rows, quarterName, timeZone, incomplete }) {
  const cells = [[{ v: `${title} – kosten en vergoeding`, bold: true }], [], FIN_HEADER.map((v) => ({ v, bold: true }))];
  rows.forEach((r, i) => cells.push(financeLine(r, i, timeZone)));
  const sum = (k) => { const xs = rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100 : null; };
  const total = round3(rows.reduce((s, r) => s + r.energy, 0));
  cells.push([{ v: 'Totaal', bold: true }, null, null, { v: total, bold: true }, null, { v: sum('reimbursement'), bold: true }, { v: sum('cost'), bold: true }, { v: sum('saldo'), bold: true }]);
  cells.push([]);
  cells.push([`Periode ${quarterName}; sessies op starttijd (${timeZone}). Kosten: uurprijs = netdeel tegen de all-in uurprijs plus zonnedeel tegen de ingestelde waarde; gem. prijs = gemiddelde prijs tijdens de sessie (geen uurmeting).`]);
  if (incomplete) cells.push(['LET OP: het sessielog gaat niet ver genoeg terug om dit kwartaal volledig te dekken; vroege sessies kunnen ontbreken.']);
  return { cells, total };
}
function buildFinanceCsv({ rows, timeZone }) {
  const f = (v, d) => (v === null || v === undefined ? '' : Number(v).toFixed(d));
  const lines = [FIN_HEADER.join(';')];
  rows.forEach((r, i) => {
    const l = financeLine(r, i, timeZone);
    lines.push([l[0], l[1], l[2], f(r.energy, 3), f(r.tariff, 4), f(r.reimbursement, 2), f(r.cost, 2), f(r.saldo, 2), r.solarShare ?? '', l[9]].join(';'));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  buildFinanceSheetCells, buildFinanceCsv,
  parseTrackerEntries, quarterRange, recentQuarters, buildQuarterRows, buildXlsx, buildSheetCells, buildCsv, formatLocal, zonedMidnight,
};
