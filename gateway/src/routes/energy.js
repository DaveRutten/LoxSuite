// Wallbox > Meters (see energyMeters.js): pick the Loxone grid / PV / Wallbox / battery meters,
// see them live and per hour, import the Miniserver's history. Gated like the other Wallbox pages
// (miniservers/view to look, miniservers/edit to change).
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const energy = require('../energyMeters');
const { localMidnight } = require('../localTime');
const { reloadMqttMonitors } = require('../monitorCollector');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const meters = await energy.loadMeters();
  const byRole = Object.fromEntries(meters.map((m) => [m.role, m]));
  const candidates = await energy.candidateMeters();
  const counts = await db.prepare('SELECT role, COUNT(*) AS n, MIN(hour) AS first FROM energy_hourly GROUP BY role').all();
  res.render('energy', {
    roles: energy.ROLES, byRole, candidates, counts: Object.fromEntries(counts.map((c) => [c.role, c])),
    topics: energy.energyTopics(), saved: !!req.query.saved, error: req.query.error || null,
  });
}));

router.get('/live.json', asyncHandler(async (req, res) => {
  const live = await energy.live();
  res.json({ ...live, today: await energy.todayTotals() });
}));

// Hourly kWh for one local day (?day=YYYY-MM-DD, default today) or the last N days (?days=7).
router.get('/series.json', asyncHandler(async (req, res) => {
  let from;
  let to;
  if (req.query.days) {
    const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
    to = localMidnight(Date.now(), undefined, 1);
    from = to - days * 86400000;
  } else {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? Date.parse(`${req.query.day}T12:00:00Z`) : Date.now();
    from = localMidnight(base);
    to = localMidnight(base, undefined, 1);
  }
  res.json(await energy.hourlySeries(new Date(from).toISOString(), new Date(to).toISOString()));
}));

router.post('/meters', requirePermission('energy', 'edit'), asyncHandler(async (req, res) => {
  const now = new Date().toISOString();
  for (const role of energy.ROLE_KEYS) {
    const val = String(req.body[`meter_${role}`] || '');
    const [msId, uuid] = val.split('|');
    await db.upsert('energy_meters', {
      role,
      miniserver_id: msId ? Number(msId) : null,
      control_uuid: uuid || null,
      invert: req.body[`invert_${role}`] ? 1 : 0,
      enabled: uuid ? 1 : 0,
      updated_at: now,
    }, ['role']);
  }
  energy.resetRuntime();
  await logSystemEvent(`Energy meters updated by ${req.session?.username || 'unknown user'}`).catch(() => {});
  res.redirect('/energy?saved=1');
}));

// JSON (CSRF-exempt like the other JSON endpoints).
router.post('/import.json', requirePermission('energy', 'edit'), asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(400, Number(req.body?.days) || 60));
  try {
    const report = await energy.importHistory(days);
    res.json({ ok: report.some((r) => r.ok), report });
  } catch (err) {
    res.json({ ok: false, report: [], message: err.message });
  }
}));

router.post('/monitor', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const topics = energy.energyTopics();
  const wanted = (Array.isArray(req.body?.metrics) ? req.body.metrics : []).filter((k) => topics[k]);
  if (!wanted.length) return res.json({ ok: false, message: 'Pick at least one value.' });
  const created = [];
  const skipped = [];
  for (const key of wanted) {
    const exists = await db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topics[key]);
    if (exists) { skipped.push(key); continue; }
    const [role, ...rest] = key.split('_');
    const label = `${(energy.ROLES.find((r) => r.key === role) || { label: 'House' }).label} – ${rest.join('_') === 'power_kw' ? 'power (kW)' : 'today (kWh)'}`;
    await db.prepare("INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', ?, ?, 1, ?, '{}')")
      .run(label, topics[key], new Date().toISOString());
    created.push(key);
  }
  if (created.length) await reloadMqttMonitors();
  return res.json({ ok: true, created, skipped });
}));

module.exports = router;
