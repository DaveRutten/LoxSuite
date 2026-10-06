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
router.get('/states/:miniserverId', asyncHandler(async (req, res) => {
  const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(Number(req.params.miniserverId));
  if (!ms) return res.status(404).json({ error: 'Miniserver not found' });
  try { res.json({ states: await require('../loxoneStructure').getMonitorableStates(ms, { forceRefresh: req.query.refresh === '1' }) }); } catch (err) { res.status(502).json({ error: err.message }); }
}));

// One consumer in detail: its state now, the timeline, kWh per hour and per status, runs.
router.get('/loads/:id', asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  if (!load) return res.redirect('/energy-manager');
  res.render('energy-load', { load, kinds: em.KINDS, src: em.sourcesOf(load.settings), learned: await em.learned(load), detail: await em.loadDetail(load) });
}));
router.get('/loads/:id/detail.json', asyncHandler(async (req, res) => {
  const load = (await em.listLoads()).find((l) => l.id === Number(req.params.id));
  if (!load) return res.status(404).json({ error: 'not found' });
  res.json({ load: { id: load.id, name: load.name, kind: load.kind }, learned: await em.learned(load), detail: await em.loadDetail(load) });
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
      reason: rt.signals.find((x) => x.id === l.id)?.reason || null, signals, learned: await em.learned(l),
      plan: plan ? plan.hours.map((h) => ({ hour: h.hour, values: h.values, reason: h.reason })) : [],
      requests: (plan?.requests || []).map((q) => ({ id: q.id, expected: !!q.expected, usualStart: q.usualStart || null, readyBy: q.readyBy, label: q.label, plannedStart: q.plannedStart || null, plannedCost: q.plannedCost ?? null, kwh: q.kwh, durationH: q.durationH })),
      patterns, follows, expected, patternDays: lp.profile?.days || 0, ignoredPatterns: lp.ignoredPatterns || 0, usePatterns: l.settings.use_patterns !== false,
      daily: await em.dailyReport(l, 14),
      runs: runs.filter((r) => r.kind === 'run').slice(0, 15),
    });
  }
  res.json({ loads: out, hours: rt.plan?.hours || [], carKwh: rt.plan?.carKwh || {}, status: rt.status, live: rt.plan?.live || null, planAt: rt.plan?.at || null, cfg: await em.getConfig() });
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
  };
  return src.onoff || src.status || src.power || src.energy ? src : null;
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
  if (b.s_use_patterns_sent) s.use_patterns = !!b.s_use_patterns;
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
  res.redirect('/energy-manager?saved=load');
}));

router.post('/loads/:id/delete', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  for (const t of ['em_log', 'load_runs', 'load_hourly', 'load_status_hourly', 'load_events']) await db.prepare(`DELETE FROM ${t} WHERE load_id = ?`).run(id).catch(() => {});
  await db.prepare('DELETE FROM energy_loads WHERE id = ?').run(id);
  em.invalidate();
  res.redirect('/energy-manager?saved=deleted');
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

router.post('/settings', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  await em.saveConfig({ car_priority: Math.max(1, Math.min(9, num(req.body.car_priority, 3))), solar_bonus_eur: Math.max(0, num(req.body.solar_bonus_eur, 0.05)) });
  res.redirect('/energy-manager?saved=settings');
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

router.post('/import.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  try { res.json({ ok: true, report: await em.importHistory(Number(req.body?.days) || 30) }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));
router.post('/recalc.json', requirePermission('energy_manager', 'edit'), asyncHandler(async (req, res) => {
  try { await em.recalc(); await em.tick(); res.json({ ok: true }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));

module.exports = router;
