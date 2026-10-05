// Wallbox > Agenda (agenda.js): calendars, the day/week/month/year views, "car needed" per
// appointment and LoxSuite's own trips.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const agenda = require('../agenda');
const settings = require('../wallboxSettings');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.render('agenda', {
    calendars: await agenda.listCalendars(), cfg: await agenda.getConfig(),
    vehicles: await db.prepare('SELECT id, name FROM vehicles ORDER BY name').all(),
    trips: await db.prepare('SELECT * FROM trips ORDER BY depart_at DESC').all(),
    site: await settings.get('site', { lat: null, lon: null }),
    error: req.query.error || null, saved: !!req.query.saved,
  });
}));

router.get('/items.json', asyncHandler(async (req, res) => {
  const from = Date.parse(req.query.from);
  const to = Date.parse(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * 86400000) return res.status(400).json({ error: 'Bad range.' });
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const items = await agenda.items(fromIso, toIso);
  // Learned departures (as "ready by" markers), planned charging and past sessions for context.
  const learning = require('../learning');
  const deps = await learning.learnedDepartures(null).catch(() => []);
  const { localMidnight, localTimeOn, localParts } = require('../localTime');
  const learned = [];
  if (to - from <= 45 * 86400000) {
    for (let t = localMidnight(from); t < to; t = localMidnight(t, undefined, 1)) {
      const st = deps[localParts(t + 12 * 3600000).weekday];
      if (st?.ready) learned.push({ at: new Date(localTimeOn(t + 12 * 3600000, st.ready)).toISOString(), departure: st.departure, source: st.override ? 'own' : 'learned', confidence: st.confidence });
    }
  }
  const plan = require('../planner').getRuntime().plan;
  const sessions = await db.prepare('SELECT connect_at, disconnect_at, kwh FROM charging_sessions WHERE connect_at < ? AND (disconnect_at IS NULL OR disconnect_at > ?) ORDER BY connect_at').all(toIso, fromIso);
  res.json({ items, learned, plan: plan ? plan.slots : [], sessions });
}));

router.post('/calendars', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  try {
    const id = await agenda.addCalendar({ name: req.body.name, url: req.body.url, color: req.body.color, vehicle_id: req.body.vehicle_id ? Number(req.body.vehicle_id) : null });
    const cal = await db.prepare('SELECT * FROM calendars WHERE id = ?').get(id);
    const r = await agenda.syncCalendar(cal);
    await logSystemEvent(`Agenda: calendar "${cal.name}" added by ${req.session?.username || 'unknown user'}`).catch(() => {});
    return res.redirect(r.ok ? '/agenda?saved=1' : `/agenda?error=${encodeURIComponent(`Added, but the first sync failed: ${r.message}`)}`);
  } catch (err) {
    return res.redirect(`/agenda?error=${encodeURIComponent(err.message)}`);
  }
}));

router.post('/calendars/:id/delete', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM event_overrides WHERE calendar_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM calendars WHERE id = ?').run(req.params.id);
  res.redirect('/agenda');
}));

router.post('/calendars/:id/update', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE calendars SET name = ?, color = ?, vehicle_id = ?, enabled = ? WHERE id = ?')
    .run(String(req.body.name || 'Calendar').slice(0, 80), req.body.color || '#3b82c4', req.body.vehicle_id ? Number(req.body.vehicle_id) : null, req.body.enabled ? 1 : 0, req.params.id);
  res.redirect('/agenda?saved=1');
}));

router.post('/sync.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  res.json({ ok: true, results: await agenda.syncAll() });
}));

router.post('/settings', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const tags = String(req.body.tags || '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  await settings.patch('agenda', {
    tags: tags.length ? tags : agenda.DEFAULTS.tags,
    margin_km: Math.max(0, Math.min(500, Number(req.body.margin_km) || 0)),
    geo: !!req.body.geo,
    ready_margin_min: Math.max(0, Math.min(180, Number(req.body.ready_margin_min) || 0)),
  }, agenda.DEFAULTS);
  res.redirect('/agenda?saved=1#settings');
}));

router.post('/override.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.calendar_id || !b.uid || !b.start_at) return res.json({ ok: false, message: 'Missing event.' });
  await agenda.setOverride(b);
  require('../planner').recalc().catch(() => {});
  res.json({ ok: true });
}));

router.post('/distance.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const r = await agenda.distanceFromHome(req.body?.location);
  res.json({ ok: !!r && !r.error, ...(r || {}) });
}));

router.post('/trips', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body;
  const depart = Date.parse(b.depart_at);
  if (!b.title || !Number.isFinite(depart)) return res.redirect(`/agenda?error=${encodeURIComponent('A trip needs a name and a departure time.')}`);
  const back = b.return_at ? Date.parse(b.return_at) : null;
  await db.prepare('INSERT INTO trips (vehicle_id, title, depart_at, return_at, location, own_value, weekly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.vehicle_id ? Number(b.vehicle_id) : null, String(b.title).slice(0, 120), new Date(depart).toISOString(), Number.isFinite(back) ? new Date(back).toISOString() : null,
      String(b.location || '').slice(0, 300) || null, String(b.own_value || '').slice(0, 60) || null, b.weekly ? 1 : 0, new Date().toISOString());
  require('../planner').recalc().catch(() => {});
  res.redirect('/agenda?saved=1');
}));

router.post('/trips/:id/delete', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.redirect('/agenda');
}));

module.exports = router;
