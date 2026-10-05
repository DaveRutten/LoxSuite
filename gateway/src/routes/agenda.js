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
    vehicles: await db.prepare('SELECT id, name, source_type, source_config FROM vehicles ORDER BY name').all(),
    climateRuns: await require('../carClimate').recent(8),
    skodaCars: (await db.prepare('SELECT id, source_type, source_config FROM vehicles').all()).some((v) => require('../vehicles').sourceKind(v) === 'skoda'),
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
  // Climate at departure: which cars can (Škoda API) and what happened per departure.
  const vehiclesMod = require('../vehicles');
  const carClimate = require('../carClimate');
  const cars = await db.prepare('SELECT id, source_type, source_config, enabled FROM vehicles ORDER BY id').all();
  const skoda = new Set(cars.filter((v) => vehiclesMod.sourceKind(v) === 'skoda').map((v) => v.id));
  const firstCar = cars.find((v) => v.enabled !== 0);
  const runs = await db.prepare('SELECT item_key, status, message, updated_at FROM climate_runs WHERE depart_at >= ? AND depart_at < ?').all(new Date(from - 86400000).toISOString(), toIso);
  const runOf = new Map(runs.map((r) => [r.item_key, r]));
  for (const it of items) {
    const vid = it.vehicle_id || firstCar?.id;
    it.climateOk = !!vid && skoda.has(vid);
    const r = runOf.get(carClimate.itemKey(it));
    if (r) it.climateRun = { status: r.status, message: r.message, at: r.updated_at };
    it.climateOff = r?.status === 'off';
  }
  const acfg = await agenda.getConfig();
  res.json({ items, learned, plan: plan ? plan.slots : [], sessions, climate: { mode: acfg.climate_mode, leadMin: carClimate.clampLead(acfg.climate_lead_min) } });
}));

// One or more ICS links (one per line). With several, or without a name, each calendar is named
// after its own name in the ICS (X-WR-CALNAME), else after the host.
router.post('/calendars', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const urls = String(req.body.url || '').split(/[\r\n]+|\s+(?=(?:https?|webcal):\/\/)/i).map((u) => u.trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return res.redirect(`/settings/energy?error=${encodeURIComponent('Fill in a name and the ICS address.')}#calendars`);
  const errors = [];
  let added = 0;
  for (const u of urls) {
    try {
      let name = urls.length === 1 ? String(req.body.name || '').trim() : '';
      if (!name) {
        const text = await agenda.fetchIcs(agenda.icsUrl(u)).catch(() => null);
        name = agenda.icsName(text) || (() => { try { return new URL(agenda.icsUrl(u)).host; } catch { return 'Calendar'; } })();
      }
      const id = await agenda.addCalendar({ name, url: u, color: req.body.color, vehicle_id: req.body.vehicle_id ? Number(req.body.vehicle_id) : null });
      const cal = await db.prepare('SELECT * FROM calendars WHERE id = ?').get(id);
      const r = await agenda.syncCalendar(cal);
      added++;
      if (!r.ok) errors.push(`${cal.name}: ${r.message}`);
      await logSystemEvent(`Agenda: calendar "${cal.name}" added by ${req.session?.username || 'unknown user'}`).catch(() => {});
    } catch (err) { errors.push(err.message); }
  }
  if (!errors.length) return res.redirect('/settings/energy?saved=1#calendars');
  return res.redirect(`/settings/energy?error=${encodeURIComponent((added ? `Added ${added}; ` : '') + errors.join(' · '))}#calendars`);
}));

// CalDAV (iCloud & co.): find the calendars of an account; the password is only used, not stored here.
router.post('/caldav/discover.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  try {
    const calendars = await require('../caldav').discover({ server: b.server || undefined, username: String(b.username || '').trim(), password: String(b.password || '').replace(/\s+/g, '') });
    res.json({ ok: true, calendars });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

// Adds the ticked CalDAV calendars (password stored encrypted) and syncs them.
router.post('/caldav/add.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '').replace(/\s+/g, '');
  const list = Array.isArray(b.calendars) ? b.calendars.slice(0, 20) : [];
  if (!list.length) return res.json({ ok: false, message: 'Choose a calendar of the account.' });
  const errors = [];
  for (const c of list) {
    try {
      const id = await agenda.addCalendar({ kind: 'caldav', name: c.name, url: c.url, color: c.color || b.color, vehicle_id: b.vehicle_id ? Number(b.vehicle_id) : null, username, password });
      const cal = await db.prepare('SELECT * FROM calendars WHERE id = ?').get(id);
      const r = await agenda.syncCalendar(cal);
      if (!r.ok) errors.push(`${c.name}: ${r.message}`);
      await logSystemEvent(`Agenda: CalDAV calendar "${cal.name}" added by ${req.session?.username || 'unknown user'}`).catch(() => {});
    } catch (err) { errors.push(`${c.name}: ${err.message}`); }
  }
  res.json({ ok: !errors.length || errors.length < list.length, message: errors.join(' · ') || null });
}));

router.post('/calendars/:id/delete', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM event_overrides WHERE calendar_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM calendars WHERE id = ?').run(req.params.id);
  res.redirect('/settings/energy#calendars');
}));

router.post('/calendars/:id/update', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE calendars SET name = ?, color = ?, vehicle_id = ?, enabled = ? WHERE id = ?')
    .run(String(req.body.name || 'Calendar').slice(0, 80), req.body.color || '#3b82c4', req.body.vehicle_id ? Number(req.body.vehicle_id) : null, req.body.enabled ? 1 : 0, req.params.id);
  res.redirect('/settings/energy?saved=1#calendars');
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
    climate_mode: ['off', 'log', 'on'].includes(req.body.climate_mode) ? req.body.climate_mode : 'log',
    climate_lead_min: require('../carClimate').clampLead(req.body.climate_lead_min),
    climate_on_battery: !!req.body.climate_on_battery,
  }, agenda.DEFAULTS);
  res.redirect('/settings/energy?saved=1#agenda-settings');
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
  await db.prepare('INSERT INTO trips (vehicle_id, title, depart_at, return_at, location, own_value, weekly, climate_c, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.vehicle_id ? Number(b.vehicle_id) : null, String(b.title).slice(0, 120), new Date(depart).toISOString(), Number.isFinite(back) ? new Date(back).toISOString() : null,
      String(b.location || '').slice(0, 300) || null, String(b.own_value || '').slice(0, 60) || null, b.weekly ? 1 : 0, agenda.parseClimate(b.climate_c), new Date().toISOString());
  require('../planner').recalc().catch(() => {});
  res.redirect('/agenda?saved=1');
}));

router.post('/trips/:id/climate.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE trips SET climate_c = ? WHERE id = ?').run(agenda.parseClimate(req.body?.climate_c), req.params.id);
  res.json({ ok: true });
}));

// Climate off (or back on) for one departure only — e.g. one week of a weekly trip.
router.post('/climate-skip.json', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const leave = Date.parse(b.leave_at || b.start);
  if (!b.start || !Number.isFinite(Date.parse(b.start)) || !Number.isFinite(leave) || !['trip', 'event'].includes(b.kind)) return res.json({ ok: false, message: 'Missing event.' });
  const key = require('../carClimate').itemKey({ kind: b.kind, id: Number(b.id), calendar_id: Number(b.calendar_id), uid: String(b.uid || ''), start: String(b.start) });
  const cur = await db.prepare('SELECT status FROM climate_runs WHERE item_key = ?').get(key);
  if (Number(b.off)) {
    if (cur && cur.status !== 'off') return res.json({ ok: false, message: 'Already handled for this departure.' });
    const now = new Date().toISOString();
    await db.upsert('climate_runs', {
      item_key: key, vehicle_id: null, title: String(b.title || '').slice(0, 120), depart_at: new Date(leave).toISOString(), target_c: agenda.parseClimate(b.target_c),
      status: 'off', message: 'Switched off for this time.', attempts: 0, next_at: null, created_at: now, updated_at: now,
    }, ['item_key']);
  } else if (cur?.status === 'off') {
    await db.prepare("DELETE FROM climate_runs WHERE item_key = ? AND status = 'off'").run(key);
  }
  res.json({ ok: true });
}));

router.post('/trips/:id/delete', requirePermission('charging', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.redirect('/agenda');
}));

module.exports = router;
