// Wallbox > Energy manager (energyManager.js): the other big consumers, planned with the car — shadow
// mode (shows what it would do, sends nothing).
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const em = require('../energyManager');

const router = express.Router();
const num = (v, def = null) => { if (v === undefined || v === null || String(v).trim() === '') return def; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : def; };

router.get('/', asyncHandler(async (req, res) => {
  const loads = await em.listLoads();
  let meters = [];
  try { meters = (await require('../energyMeters').candidateMeters()).filter((m) => m.type === 'Meter'); } catch { meters = []; }
  res.render('energy-manager', {
    loads: loads.map((l) => ({ ...l, signals: (em.KINDS[l.kind]?.signals || []).map((s) => ({ ...s, vi: em.viName(l, s) })) })),
    kinds: em.KINDS, meters, miniservers: await db.prepare('SELECT id, name FROM miniservers ORDER BY sort_order, id').all().catch(() => []), cfg: await em.getConfig(), saved: req.query.saved || null, error: req.query.error || null,
  });
}));

// The readable states of a Miniserver, for the signal pickers of a consumer.
// The Miniserver's devices (controls) with which of their states is which signal — "link a device".
router.get('/devices/:miniserverId', asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(req.params.miniserverId));
  if (!ms) return res.status(404).json({ error: 'Miniserver not found' });
  try {
    const s = await require('../loxoneStructure').getStructure(ms, { forceRefresh: req.query.refresh === '1' });
    res.json({ devices: em.devicesFromStructure(s).map(({ members, ...d }) => d) });
  } catch (err) { res.status(502).json({ error: err.message }); }
}));
// One device as the Miniserver describes it (type, states, details, sub-controls) — to see what it offers.
router.get('/devices/:miniserverId/:uuid', asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(req.params.miniserverId));
  if (!ms) return res.status(404).json({ error: 'Miniserver not found' });
  const s = await require('../loxoneStructure').getStructure(ms).catch(() => null);
  if (String(req.params.uuid).startsWith('group:')) {
    const g = em.devicesFromStructure(s).find((d) => d.uuid === req.params.uuid);
    if (!g) return res.status(404).json({ error: 'Device not found' });
    return res.type('application/json').send(JSON.stringify({ ...g, members: g.members.map((m) => ({ ...m, ...s.controls[m.uuid] })) }, null, 2));
  }
  const c = s?.controls?.[req.params.uuid];
  if (!c) return res.status(404).json({ error: 'Device not found' });
  res.type('application/json').send(JSON.stringify({ uuid: req.params.uuid, ...c, signals: em.mapDeviceStates(c) }, null, 2));
}));

router.get('/states/:miniserverId', asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(req.params.miniserverId));
  if (!ms) return res.status(404).json({ error: 'Miniserver not found' });
  try {
    const states = await require('../loxoneStructure').getMonitorableStates(ms, { forceRefresh: req.query.refresh === '1' });
    // with the value now, so a Status block's text ("Wasmachine uitgeschakeld") is recognisable in the list
    const ws = require('../loxoneWebSocket');
    ws.ensureConnection(ms);
    res.json({ states: states.map((s) => { const v = ws.getLiveValue(ms.id, s.uuid); return v === undefined || v === null ? s : { ...s, value: typeof v === 'number' ? Math.round(v * 1000) / 1000 : String(v).slice(0, 60) }; }) });
  } catch (err) { res.status(502).json({ error: err.message }); }
}));

// One consumer in detail: its state now, the timeline, kWh per hour and per status, runs.
router.get('/loads/:id', asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  if (!load) return res.redirect('/energy-manager');
  const lp = (em.getRuntime().loads || []).find((x) => x.id === load.id) || {};
  const weather = lp.weather ? { model: lp.weather.model, todayC: lp.weather.todayC, factorToday: lp.weather.factorToday, factorTomorrow: lp.weather.factorTomorrow } : null;
  const daily = load.kind === 'appliance' ? [] : await em.dailyReport(load, 14).catch(() => []);
  res.render('energy-load', { load, kinds: em.KINDS, src: em.sourcesOf(load.settings), learned: { ...(await em.learned(load)), weather, cooling: lp.cooling || null }, detail: { ...(await em.loadDetail(load)), daily } });
}));
router.get('/loads/:id/detail.json', asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  if (!load) return res.status(404).json({ error: 'not found' });
  const daily = load.kind === 'appliance' ? [] : await em.dailyReport(load, 14).catch(() => []);
  res.json({ load: { id: load.id, name: load.name, kind: load.kind }, learned: await em.learned(load), detail: { ...(await em.loadDetail(load)), daily } });
}));

router.get('/data.json', asyncHandler(async (req, res) => {
  const loads = await em.listLoads();
  const rt = em.getRuntime();
  const ep = require('../energyPatterns');
  const names = Object.fromEntries(loads.map((l) => [l.id, l.name]));
  const out = [];
  for (const l of loads) {
    const plan = rt.plan?.loads.find((p) => p.id === l.id) || null;
    const signals = (em.KINDS[l.kind]?.signals || []).map((s) => ({ key: s.key, vi: em.viName(l, s), unit: s.unit, hint: s.hint, value: rt.signals.find((x) => x.id === l.id)?.values?.[s.key] ?? null }));
    const lp = rt.loads.find((x) => x.id === l.id) || {};
    const patterns = (lp.patterns || []).map((p) => ({ ...p, key: ep.patternKey(p), text: ep.describe(p, names) }));
    const follows = rt.follows.filter((f) => f.from === l.id || f.to === l.id).map((f) => ({ ...f, text: ep.describe(f, names) }));
    // expected use, corrected with how far off the expectation was for this consumer (forecastLog.js)
    const lf = (await require('../forecastLog').corrections().catch(() => ({ loadFactors: {} }))).loadFactors?.[l.id] || 1;
    const expected = lp.profile && rt.localOf ? (rt.plan?.hours || []).slice(0, 24).map((h) => { const k = ep.expectedKwh(lp.profile, h.ms, rt.localOf); return { ms: h.ms, kwh: k === null || k === undefined ? k : Math.round(k * lf * 1000) / 1000 }; }) : [];
    const runs = l.kind === 'appliance' ? await db.prepare("SELECT * FROM load_runs WHERE load_id = ? ORDER BY start_at DESC").all(l.id) : [];
    out.push({
      id: l.id, name: l.name, kind: l.kind, kindLabel: em.KINDS[l.kind]?.label, priority: l.priority, enabled: !!l.enabled, output: l.output,
      settings: l.settings, live: rt.samples[l.id] || null, running: rt.runs[l.id]?.running || false,
      progress: await (async () => {
        const run = rt.runs[l.id];
        if (l.kind !== 'appliance' || !run?.running) return null;
        const lr0 = await em.learned(l);
        const live = rt.samples[l.id];
        const used = live && live.total !== null && live.total !== undefined && run.startTotal !== null && run.startTotal !== undefined ? live.total - run.startTotal : null;
        return em.runProgress({ sinceMs: run.since, nowMs: Date.now(), typicalH: lr0.durationH, typicalKwh: lr0.kwh, usedKwh: used });
      })(),
      reason: rt.signals.find((x) => x.id === l.id)?.reason || null, signals, learned: await em.learned(l),
      plan: plan ? plan.hours.map((h) => ({ hour: h.hour, values: h.values, reason: h.reason })) : [],
      requests: (plan?.requests || []).map((q) => ({ id: q.id, expected: !!q.expected, usualStart: q.usualStart || null, readyBy: q.readyBy, label: q.label, plannedStart: q.plannedStart || null, plannedCost: q.plannedCost ?? null, kwh: q.kwh, durationH: q.durationH })),
      patterns, follows, expected, patternDays: lp.profile?.days || 0, ignoredPatterns: lp.ignoredPatterns || 0,
      weather: lp.weather ? { model: lp.weather.model, todayC: lp.weather.todayC, factorToday: lp.weather.factorToday, factorTomorrow: lp.weather.factorTomorrow } : null,
      cooling: lp.cooling || null, effective: lp.kind === 'heatpump' ? { release_share: lp.settings?.release_share, max_block_h: lp.settings?.max_block_h } : null, usePatterns: l.settings.use_patterns !== false,
      daily: await em.dailyReport(l, 14),
      runs: runs.filter((r) => r.kind === 'run').slice(0, 15),
    });
  }
  res.json({ unknown: rt.unknown || [], dayTypes: rt.plan?.dayTypes || {}, loads: out, hours: rt.plan?.hours || [], carKwh: rt.plan?.carKwh || {}, quarters: rt.plan?.hours?.length ? await require('../prices').chartQuarters(new Date(rt.plan.hours[0].ms).toISOString(), new Date(rt.plan.hours[rt.plan.hours.length - 1].ms + 3600000).toISOString()).catch(() => null) : null, status: rt.status, live: rt.plan?.live || null, planAt: rt.plan?.at || null, cfg: await em.getConfig() });
}));

// The Loxone signals of a consumer (state uuids): on/off, status (+ value labels and which values mean
// "running"), power (W/kW) and an energy counter (kWh/Wh). Null when none is chosen.
function readSources(b) {
  const uuid = (v) => { const x = String(v || '').trim(); return /^[0-9a-f-]{20,}$/i.test(x) ? x : null; };
  const src = {
    onoff: uuid(b.src_onoff), onoff_invert: !!b.src_onoff_invert,
    status: uuid(b.src_status), status_map: String(b.src_status_map || '').slice(0, 600), status_on: String(b.src_status_on || '').slice(0, 120),
    power: uuid(b.src_power), power_unit: b.src_power_unit === 'kW' ? 'kW' : 'W',
    energy: uuid(b.src_energy), energy_unit: b.src_energy_unit === 'Wh' ? 'Wh' : 'kWh',
    temp: uuid(b.src_temp),
    ready: uuid(b.src_ready), remaining: uuid(b.src_remaining), device: /^(group:)?[0-9a-f-]{8,}$/i.test(String(b.src_device || '').trim()) ? String(b.src_device).trim() : null,
    start_in: uuid(b.src_start_in), start_in_unit: ['min', 's'].includes(b.src_start_in_unit) ? b.src_start_in_unit : 'h',
  };
  return src.onoff || src.status || src.power || src.energy || src.temp || src.start_in || src.ready || src.remaining || src.device ? src : null;
}

function readLoadForm(b) {
  const kind = em.KINDS[b.kind] ? b.kind : 'appliance';
  const [msId, uuid] = String(b.meter || '').split('|');
  const s = {};
  for (const k of Object.keys(em.KINDS[kind].defaults)) {
    if (b[`s_${k}`] === undefined) continue;
    s[k] = k === 'season' ? (['heating', 'cooling', 'off'].includes(b.s_season) ? b.s_season : 'heating') : num(b[`s_${k}`], em.KINDS[kind].defaults[k]);
  }
  if (b.s_kw_fixed) s.kw_fixed = true;
  if (b.s_max_block_auto_sent) s.max_block_auto = !!b.s_max_block_auto;
  if (b.s_use_patterns_sent) s.use_patterns = !!b.s_use_patterns;
  if (kind === 'appliance') {
    s.start_mode = ['off', 'log', 'on'].includes(b.s_start_mode) ? b.s_start_mode : 'log';
    s.control_via = b.s_control_via === 'device' ? 'device' : 'vi';
    if (b.s_ready_within_h !== undefined && b.s_ready_within_h !== '') s.ready_within_h = Math.max(1, Math.min(36, num(b.s_ready_within_h, 8)));
  }
  const vi = {};
  for (const sig of em.KINDS[kind].signals) { const v = String(b[`vi_${sig.key}`] || '').trim(); if (v) vi[sig.key] = v; }
  if (Object.keys(vi).length) s.vi = vi;
  const src = readSources(b);
  if (src) s.src = src;
  const srcMs = num(b.src_ms);
  return {
    name: String(b.name || '').trim() || em.KINDS[kind].label, kind, enabled: b.enabled ? 1 : 0, priority: Math.max(1, Math.min(9, num(b.priority, 5))),
    miniserver_id: msId ? Number(msId) : srcMs, meter_uuid: uuid || null, settings: JSON.stringify(s),
  };
}

router.post('/loads', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const v = readLoadForm(req.body);
  if (req.body.id) {
    await db.prepare('UPDATE energy_loads SET name = ?, kind = ?, enabled = ?, priority = ?, miniserver_id = ?, meter_uuid = ?, settings = ? WHERE id = ?')
      .run(v.name, v.kind, v.enabled, v.priority, v.miniserver_id, v.meter_uuid, v.settings, Number(req.body.id));
  } else {
    await db.prepare("INSERT INTO energy_loads (name, kind, enabled, priority, miniserver_id, meter_uuid, settings, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'shadow', ?)")
      .run(v.name, v.kind, v.enabled, v.priority, v.miniserver_id, v.meter_uuid, v.settings, new Date().toISOString());
  }
  em.invalidate();
  res.redirect('/settings/energy?saved=load#energy-manager');
}));

router.post('/loads/:id/delete', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  for (const t of ['em_log', 'load_runs', 'load_hourly', 'load_status_hourly', 'load_events']) await db.prepare(`DELETE FROM ${t} WHERE load_id = ?`).run(id).catch(() => {});
  await db.prepare('DELETE FROM energy_loads WHERE id = ?').run(id);
  em.invalidate();
  res.redirect('/settings/energy?saved=deleted#energy-manager');
}));

// "Not right": leave a learned pattern out (or put them all back).
router.post('/loads/:id/patterns.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  if (!load) return res.json({ ok: false, message: 'Not found.' });
  const raw = JSON.parse((await db.prepare('SELECT settings FROM energy_loads WHERE id = ?').get(load.id))?.settings || '{}');
  const list = new Set(raw.ignored_patterns || []);
  if (req.body?.restore) list.clear();
  else if (req.body?.ignore) list.add(String(req.body.ignore).slice(0, 60));
  raw.ignored_patterns = [...list].slice(-50);
  await db.prepare('UPDATE energy_loads SET settings = ? WHERE id = ?').run(JSON.stringify(raw), load.id);
  em.invalidate();
  res.json({ ok: true });
}));

// Give an unknown consumer (a recurring block of house use) a name.
router.post('/unknown.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const settings = require('../wallboxSettings');
  const names = (await settings.get('unknown_names', {})) || {};
  const key = String(req.body?.key || '').slice(0, 60);
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!key) return res.json({ ok: false });
  if (name) names[key] = name; else delete names[key];
  await settings.set('unknown_names', names);
  em.invalidate();
  res.json({ ok: true });
}));

router.post('/settings', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  // ("prefer own solar" is set with Smart charging now, for both)
  await em.saveConfig({ car_priority: Math.max(1, Math.min(9, num(req.body.car_priority, 3))) });
  res.redirect('/settings/energy?saved=settings#energy-manager');
}));

// "Ready by": plan a run of an appliance (shadow: LoxSuite shows and notifies the best start).
router.post('/loads/:id/request.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const readyBy = Date.parse(String(req.body?.readyBy || ''));
  if (!Number.isFinite(readyBy) || readyBy < Date.now() + 30 * 60000) return res.json({ ok: false, message: 'Choose a "ready by" time at least 30 minutes from now.' });
  await db.prepare("INSERT INTO load_runs (load_id, start_at, ready_by, kwh, duration_h, label, kind) VALUES (?, ?, ?, ?, ?, ?, 'request')")
    .run(Number(req.params.id), new Date().toISOString(), new Date(readyBy).toISOString(), num(req.body?.kwh), num(req.body?.durationH), String(req.body?.label || '').slice(0, 60) || null);
  await em.recalc().catch(() => {});
  res.json({ ok: true });
}));
router.post('/requests/:id/delete.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare("DELETE FROM load_runs WHERE id = ? AND kind = 'request'").run(Number(req.params.id));
  await em.recalc().catch(() => {});
  res.json({ ok: true });
}));

// Send one command now (start / pause / resume / stop) — a test the user asks for, whatever "Start via
// LoxSuite" says. Logged like every command.
router.post('/loads/:id/command.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  const key = String(req.body?.key || '');
  if (!load || !['start', 'pause', 'resume', 'stop'].includes(key)) return res.status(400).json({ ok: false, message: 'Unknown consumer or command.' });
  try {
    const r = await em.sendCommand(load, key);
    await db.prepare('INSERT INTO em_log (ts, load_id, signal_name, value, reason) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), load.id, `${key}_sent`, 'pulse', `test by ${req.session?.username || 'user'} (${r.target} = pulse)`).catch(() => {});
    require('../auditLog').logSystemEvent(`Energy manager: test command ${key} to ${load.name} (${r.target}) by ${req.session?.username || 'user'}`).catch(() => {});
    res.json({ ok: true, target: r.target });
  } catch (err) { res.json({ ok: false, message: err.message }); }
}));
router.post('/loads/:id/import.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  try {
    const report = await em.importHistory(Number(req.body?.days) || 30, { loadId: Number(req.params.id) });
    em.invalidate();
    res.json({ ok: true, report });
  } catch (err) { res.json({ ok: false, message: err.message }); }
}));
router.post('/import.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  try { res.json({ ok: true, report: await em.importHistory(Number(req.body?.days) || 30) }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));
router.post('/recalc.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  try { await em.recalc(); await em.tick(); res.json({ ok: true }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));

module.exports = router;
