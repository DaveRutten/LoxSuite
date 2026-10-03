// OCPP bridges (see ocppBridge.js and migration 018): one row per Loxone Wallbox that LoxSuite
// reports to an OCPP 1.6 backend as a charge point. Gated on the 'miniservers' permission area —
// it's Miniserver-level configuration (and stores a backend secret), so viewing needs
// miniservers/view and every change needs miniservers/edit, same as the Miniservers pages.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const { encrypt } = require('../secretCrypto');
const loxoneStructure = require('../loxoneStructure');
const ocppBridge = require('../ocppBridge');
const { logSystemEvent } = require('../auditLog');
const loxoneWebSocket = require('../loxoneWebSocket');
const ocppExport = require('../ocppExport');
const { getDisplayTimezone } = require('../dateFormat');
const { fetchMiniserver } = require('../loxone');
const ocppStats = require('../ocppStats');
const { reloadMqttMonitors } = require('../monitorCollector');

const router = express.Router();

// Every Wallbox2 control across all Miniservers, for the picker. A Miniserver whose structure
// can't be fetched right now is skipped rather than failing the whole page.
async function wallboxOptions() {
  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  const options = [];
  for (const ms of miniservers) {
    try {
      const structure = await loxoneStructure.getStructure(ms);
      for (const [uuid, c] of Object.entries(structure.controls || {})) {
        if (c.type === 'Wallbox2') options.push({ miniserverId: ms.id, miniserverName: ms.name, uuid, name: c.name });
      }
    } catch { /* unreachable Miniserver: just not listed */ }
  }
  return options;
}

// NFC Code Touch controls, for the automatic-ID-tag picker.
async function nfcOptions() {
  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  const options = [];
  for (const ms of miniservers) {
    try {
      const structure = await loxoneStructure.getStructure(ms);
      for (const [uuid, c] of Object.entries(structure.controls || {})) {
        if (c.type === 'NfcCodeTouch') options.push({ miniserverId: ms.id, miniserverName: ms.name, uuid, name: c.name });
      }
    } catch { /* unreachable Miniserver */ }
  }
  return options;
}

// Serial-number suggestion from the Hardware page's device list (Tree/Air devices with their
// serials) — the Wallbox block itself carries no serial. First device whose type or name mentions
// a Wallbox; null when Hardware polling hasn't seen one.
async function wallboxSerialSuggestion() {
  try {
    const row = await db.prepare(
      "SELECT serial FROM loxone_hardware_devices WHERE serial IS NOT NULL AND serial <> '' AND (LOWER(type) LIKE '%wallbox%' OR LOWER(name) LIKE '%wallbox%') ORDER BY id LIMIT 1"
    ).get();
    return row?.serial || null;
  } catch {
    return null;
  }
}

// Parses + validates the shared create/update form. Returns { values } or { error }.
function parseForm(body, { requirePassword }) {
  const [miniserverId, controlUuid] = String(body.wallbox || '').split('|');
  const values = {
    name: String(body.name || '').trim(),
    miniserver_id: Number(miniserverId),
    control_uuid: String(controlUuid || '').trim(),
    enabled: body.enabled ? 1 : 0,
    mode: body.mode === 'live' ? 'live' : 'dry',
    server_url: String(body.server_url || '').trim().replace(/\/+$/, ''),
    charge_point_id: String(body.charge_point_id || '').trim(),
    id_tag: String(body.id_tag || '').trim(),
    serial: String(body.serial || '').trim() || null,
    ean: String(body.ean || '').trim() || null,
    meter_interval_s: Math.max(10, Math.min(3600, Number(body.meter_interval_s) || 60)),
    stop_delay_s: Math.max(0, Math.min(900, Number(body.stop_delay_s) || 0)),
    password: String(body.password || ''),
    id_tag_mode: body.id_tag_mode === 'auto' ? 'auto' : 'fixed',
    nfc_control_uuid: String(body.nfc_control_uuid || '').trim() || null,
    user_tag_map: String(body.user_tag_map || '').trim() || null,
    auth_wait_s: Math.max(0, Math.min(900, Number(body.auth_wait_s) || 0)),
  };
  if (!values.name) return { error: 'Name is required.' };
  if (!values.miniserver_id || !values.control_uuid) return { error: 'Pick a Wallbox.' };
  if (!/^wss?:\/\/.+/i.test(values.server_url)) return { error: 'Server URL must start with ws:// or wss://.' };
  if (!values.charge_point_id) return { error: 'ChargePoint ID is required.' };
  if (!values.id_tag || values.id_tag.length > 20) return { error: 'ID tag is required (max. 20 characters, OCPP 1.6 limit).' };
  if (requirePassword && values.mode === 'live' && !values.password) return { error: 'Live mode needs the backend password.' };
  return { values };
}

router.get('/', asyncHandler(async (req, res) => {
  const bridges = await db.prepare(
    `SELECT b.*, ms.name AS miniserver_name FROM ocpp_bridges b
     JOIN miniservers ms ON ms.id = b.miniserver_id ORDER BY b.name`
  ).all();
  const rows = [];
  for (const b of bridges) {
    const last = await db.prepare(
      'SELECT stopped_at, meter_start_wh, meter_stop_wh, mode FROM ocpp_bridge_sessions WHERE bridge_id = ? AND stopped_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(b.id);
    rows.push({
      ...b,
      status: ocppBridge.getBridgeStatus(b.id),
      lastSession: last ? { stoppedAt: last.stopped_at, kwh: (last.meter_stop_wh - last.meter_start_wh) / 1000, mode: last.mode } : null,
    });
  }
  res.render('ocpp-bridges', {
    bridges: rows, wallboxes: await wallboxOptions(), nfcs: await nfcOptions(),
    serialSuggestion: await wallboxSerialSuggestion(), error: req.query.error || null,
  });
}));

router.post('/', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const { values, error } = parseForm(req.body, { requirePassword: true });
  if (error) return res.redirect(`/ocpp?error=${encodeURIComponent(error)}`);
  const now = new Date().toISOString();
  const id = await db.insertReturningId(
    `INSERT INTO ocpp_bridges (name, miniserver_id, control_uuid, enabled, mode, server_url, charge_point_id, password, id_tag, serial, ean, meter_interval_s, stop_delay_s, id_tag_mode, nfc_control_uuid, user_tag_map, auth_wait_s, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.miniserver_id, values.control_uuid, values.enabled, values.mode, values.server_url,
      values.charge_point_id, values.password ? encrypt(values.password) : null, values.id_tag, values.serial, values.ean,
      values.meter_interval_s, values.stop_delay_s, values.id_tag_mode, values.nfc_control_uuid, values.user_tag_map, values.auth_wait_s, now, now]
  );
  await logSystemEvent(`OCPP bridge "${values.name}" created (${values.mode}) by ${req.session?.username || 'unknown user'}`).catch(() => {});
  await ocppBridge.syncRunners();
  return res.redirect(`/ocpp/${id}`);
}));

// NFC tags known to the Miniserver's user management (Loxone "getuserlist2" + "getuser/<uuid>"),
// so a tag can be picked as the bridge's ID tag even when it's never used at the Wallbox itself.
// Needs the LoxSuite Miniserver user to have user-management rights; on any failure the picker
// just says so and the tag can still be typed by hand. Field names are read defensively since the
// exact shape differs a little between firmware versions.
function parseLL(body) {
  const v = body?.LL?.value;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
router.get('/loxone-nfc-tags.json', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.query.miniserver_id);
  if (!ms) return res.status(404).json({ ok: false, message: 'Miniserver not found.' });
  try {
    const listRes = await fetchMiniserver(ms, '/jdev/sps/getuserlist2', { timeoutMs: 8000 });
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status} (does the LoxSuite user have user-management rights?)`);
    const users = parseLL(await listRes.json());
    if (!Array.isArray(users)) throw new Error('Unexpected user list from the Miniserver.');
    const tags = [];
    for (const u of users.slice(0, 100)) {
      if (!u?.uuid) continue;
      try {
        const r = await fetchMiniserver(ms, `/jdev/sps/getuser/${encodeURIComponent(u.uuid)}`, { timeoutMs: 8000 });
        if (!r.ok) continue;
        const detail = parseLL(await r.json()) || {};
        const list = detail.nfcTags || detail.nfcTag || detail.tags || [];
        (Array.isArray(list) ? list : []).forEach((t) => {
          const raw = t?.id ?? t?.tagId ?? t?.value;
          if (!raw) return;
          tags.push({ user: u.name || detail.name || '', name: t.name || '', raw: String(raw), idTag: ocppBridge.normalizeNfcTag(raw) });
        });
      } catch { /* skip this user */ }
    }
    return res.json({ ok: true, tags });
  } catch (err) {
    return res.json({ ok: false, message: err.message });
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const bridge = await db.prepare(
    `SELECT b.*, ms.name AS miniserver_name FROM ocpp_bridges b
     JOIN miniservers ms ON ms.id = b.miniserver_id WHERE b.id = ?`
  ).get(req.params.id);
  if (!bridge) return res.status(404).render('forbidden', { message: 'OCPP bridge not found.' });
  const sessions = await db.prepare('SELECT * FROM ocpp_bridge_sessions WHERE bridge_id = ? ORDER BY id DESC LIMIT 25').all(bridge.id);
  return res.render('ocpp-bridge-edit', {
    bridge, sessions, wallboxes: await wallboxOptions(), nfcs: await nfcOptions(), quarters: ocppExport.recentQuarters(),
    serialSuggestion: await wallboxSerialSuggestion(),
    status: ocppBridge.getBridgeStatus(bridge.id),
    error: req.query.error || null, saved: req.query.saved === '1',
  });
}));

router.get('/:id/status.json', asyncHandler(async (req, res) => {
  const sessions = await db.prepare('SELECT * FROM ocpp_bridge_sessions WHERE bridge_id = ? ORDER BY id DESC LIMIT 25').all(req.params.id);
  res.json({ status: ocppBridge.getBridgeStatus(req.params.id), log: ocppBridge.getBridgeLog(req.params.id), sessions });
}));

// Quarterly export (xlsx or csv) — see ocppExport.js for sources and layout. Works whether or not
// the bridge itself is enabled: it only needs the Wallbox's session log and current meter total,
// both read from the live websocket cache.
router.get('/:id/export', asyncHandler(async (req, res) => {
  const bridge = await db.prepare('SELECT * FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  if (!bridge) return res.redirect('/ocpp');
  const timeZone = getDisplayTimezone();
  const range = ocppExport.quarterRange(req.query.quarter, timeZone);
  if (!range) return res.redirect(`/ocpp/${bridge.id}?error=${encodeURIComponent('Unknown quarter.')}`);
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(bridge.miniserver_id);
  let ctl;
  try {
    const structure = await loxoneStructure.getStructure(miniserver);
    ctl = structure.controls?.[bridge.control_uuid];
  } catch (err) {
    return res.redirect(`/ocpp/${bridge.id}?error=${encodeURIComponent(`Miniserver structure unavailable: ${err.message}`)}`);
  }
  if (!ctl) return res.redirect(`/ocpp/${bridge.id}?error=${encodeURIComponent('Wallbox not found on the Miniserver.')}`);
  loxoneWebSocket.ensureConnection(miniserver);
  const historyCtl = Object.values(ctl.subControls || {}).find((c) => c.type === 'Tracker');
  const trackerText = historyCtl?.states?.entries ? loxoneWebSocket.getLiveValue(miniserver.id, historyCtl.states.entries) : undefined;
  const total = ctl.states?.total ? loxoneWebSocket.getLiveValue(miniserver.id, ctl.states.total) : undefined;
  if (trackerText === undefined || total === undefined) {
    return res.redirect(`/ocpp/${bridge.id}?error=${encodeURIComponent('Live Wallbox data not available yet (Miniserver connection still starting?). Try again in a minute.')}`);
  }
  const recorded = await db.prepare('SELECT * FROM ocpp_bridge_sessions WHERE bridge_id = ?').all(bridge.id);
  const { rows, incomplete } = ocppExport.buildQuarterRows({
    tracker: ocppExport.parseTrackerEntries(trackerText), recorded, currentTotalKwh: Number(total), start: range.start, end: range.end,
  });
  const fileBase = `laadsessies${range.name}`;
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
    return res.send(ocppExport.buildCsv({ rows, timeZone }));
  }
  const title = [`Gegevens ${ctl.name}`, bridge.serial ? `(SN ${bridge.serial})` : null, bridge.ean ? `– EAN ${bridge.ean}` : null].filter(Boolean).join(' ');
  const { cells } = ocppExport.buildSheetCells({ title, rows, quarterName: range.name, timeZone, incomplete });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
  return res.send(ocppExport.buildXlsx(cells, { colWidths: [8, 21, 21, 13, 13, 14, 10] }));
}));

// JSON (so CSRF-exempt, like the Miniservers "Test" button). Tests the SAVED settings.
router.post('/:id/test', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const bridge = await db.prepare('SELECT * FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  if (!bridge) return res.status(404).json({ ok: false, message: 'Not found.' });
  const backend = await ocppBridge.testBackendConnection(bridge);
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(bridge.miniserver_id);
  let wallbox = { ok: false, message: 'Miniserver not found.' };
  if (miniserver) {
    try {
      const structure = await loxoneStructure.getStructure(miniserver);
      const ctl = structure.controls?.[bridge.control_uuid];
      loxoneWebSocket.ensureConnection(miniserver);
      const total = ctl?.states?.total ? loxoneWebSocket.getLiveValue(miniserver.id, ctl.states.total) : undefined;
      wallbox = !ctl ? { ok: false, message: 'Wallbox not found on the Miniserver.' }
        : total === undefined ? { ok: false, message: 'No live data yet (websocket still connecting?).' }
          : { ok: true, message: `${ctl.name}: meter ${Number(total).toFixed(3)} kWh` };
    } catch (err) {
      wallbox = { ok: false, message: err.message };
    }
  }
  return res.json({ backend, wallbox });
}));

router.get('/:id/stats.json', asyncHandler(async (req, res) => {
  const bridge = await db.prepare('SELECT * FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  if (!bridge) return res.status(404).json({ error: 'Not found.' });
  const result = await ocppStats.loadStats(bridge);
  return res.json({ ...result, topics: ocppStats.statTopics(bridge.id), labels: ocppStats.STAT_LABELS });
}));

// Adds the chosen statistics as MQTT monitors (Monitor page / dashboards). JSON, so CSRF-exempt.
// Skips topics that are already monitored; values arrive via the retained loxsuite/ocpp/<id>/*
// topics ocppStats publishes every minute (on change).
router.post('/:id/monitor', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const bridge = await db.prepare('SELECT * FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  if (!bridge) return res.status(404).json({ ok: false, message: 'Not found.' });
  const topics = ocppStats.statTopics(bridge.id);
  const wanted = (Array.isArray(req.body?.metrics) ? req.body.metrics : []).filter((k) => topics[k]);
  if (!wanted.length) return res.json({ ok: false, message: 'Pick at least one value.' });
  const created = [];
  const skipped = [];
  for (const key of wanted) {
    const topic = topics[key];
    const exists = await db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
    if (exists) { skipped.push(key); continue; }
    await db.prepare(
      `INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', ?, ?, 1, ?, '{}')`
    ).run(`${bridge.name} – ${ocppStats.STAT_LABELS[key]}`, topic, new Date().toISOString());
    created.push(key);
  }
  if (created.length) await reloadMqttMonitors();
  ocppStats.publishAllStats().catch(() => {});
  return res.json({ ok: true, created, skipped });
}));

router.post('/:id/update', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/ocpp');
  const { values, error } = parseForm(req.body, { requirePassword: false });
  if (error) return res.redirect(`/ocpp/${existing.id}?error=${encodeURIComponent(error)}`);
  if (values.mode === 'live' && !values.password && !existing.password) {
    return res.redirect(`/ocpp/${existing.id}?error=${encodeURIComponent('Live mode needs the backend password.')}`);
  }
  const password = values.password ? encrypt(values.password) : existing.password;
  await db.prepare(
    `UPDATE ocpp_bridges SET name = ?, miniserver_id = ?, control_uuid = ?, enabled = ?, mode = ?, server_url = ?,
       charge_point_id = ?, password = ?, id_tag = ?, serial = ?, ean = ?, meter_interval_s = ?, stop_delay_s = ?,
       id_tag_mode = ?, nfc_control_uuid = ?, user_tag_map = ?, auth_wait_s = ?, updated_at = ?
     WHERE id = ?`
  ).run(values.name, values.miniserver_id, values.control_uuid, values.enabled, values.mode, values.server_url,
    values.charge_point_id, password, values.id_tag, values.serial, values.ean, values.meter_interval_s, values.stop_delay_s,
    values.id_tag_mode, values.nfc_control_uuid, values.user_tag_map, values.auth_wait_s,
    new Date().toISOString(), existing.id);
  if (existing.mode !== values.mode || existing.enabled !== values.enabled) {
    await logSystemEvent(`OCPP bridge "${values.name}" is now ${values.enabled ? 'enabled' : 'disabled'} (${values.mode})`).catch(() => {});
  }
  await ocppBridge.syncRunners();
  return res.redirect(`/ocpp/${existing.id}?saved=1`);
}));

router.post('/:id/delete', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT name FROM ocpp_bridges WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM ocpp_bridges WHERE id = ?').run(req.params.id);
  if (existing) await logSystemEvent(`OCPP bridge "${existing.name}" deleted`).catch(() => {});
  await ocppBridge.syncRunners();
  res.redirect('/ocpp');
}));

module.exports = router;
