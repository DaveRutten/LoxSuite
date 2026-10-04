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
    kinds: em.KINDS, meters, cfg: await em.getConfig(), saved: req.query.saved || null, error: req.query.error || null,
  });
}));

router.get('/data.json', asyncHandler(async (req, res) => {
  const loads = await em.listLoads();
  const rt = em.getRuntime();
  const out = [];
  for (const l of loads) {
    const plan = rt.plan?.loads.find((p) => p.id === l.id) || null;
    const signals = (em.KINDS[l.kind]?.signals || []).map((s) => ({ key: s.key, vi: em.viName(l, s), unit: s.unit, hint: s.hint, value: rt.signals.find((x) => x.id === l.id)?.values?.[s.key] ?? null }));
    const runs = l.kind === 'appliance' ? await db.prepare("SELECT * FROM load_runs WHERE load_id = ? ORDER BY start_at DESC").all(l.id) : [];
    out.push({
      id: l.id, name: l.name, kind: l.kind, kindLabel: em.KINDS[l.kind]?.label, priority: l.priority, enabled: !!l.enabled, output: l.output,
      settings: l.settings, live: rt.samples[l.id] || null, running: rt.runs[l.id]?.running || false,
      reason: rt.signals.find((x) => x.id === l.id)?.reason || null, signals, learned: await em.learned(l),
      plan: plan ? plan.hours.map((h) => ({ hour: h.hour, values: h.values, reason: h.reason })) : [],
      requests: (plan?.requests || []).map((q) => ({ id: q.id, readyBy: q.readyBy, label: q.label, plannedStart: q.plannedStart || null, plannedCost: q.plannedCost ?? null, kwh: q.kwh, durationH: q.durationH })),
      daily: await em.dailyReport(l, 14),
      runs: runs.filter((r) => r.kind === 'run').slice(0, 15),
    });
  }
  res.json({ loads: out, hours: rt.plan?.hours || [], carKwh: rt.plan?.carKwh || {}, status: rt.status, planAt: rt.plan?.at || null, cfg: await em.getConfig() });
}));

function readLoadForm(b) {
  const kind = em.KINDS[b.kind] ? b.kind : 'appliance';
  const [msId, uuid] = String(b.meter || '').split('|');
  const s = {};
  for (const k of Object.keys(em.KINDS[kind].defaults)) {
    if (b[`s_${k}`] === undefined) continue;
    s[k] = k === 'season' ? (['heating', 'cooling', 'off'].includes(b.s_season) ? b.s_season : 'heating') : num(b[`s_${k}`], em.KINDS[kind].defaults[k]);
  }
  if (b.s_kw_fixed) s.kw_fixed = true;
  const vi = {};
  for (const sig of em.KINDS[kind].signals) { const v = String(b[`vi_${sig.key}`] || '').trim(); if (v) vi[sig.key] = v; }
  if (Object.keys(vi).length) s.vi = vi;
  return {
    name: String(b.name || '').trim() || em.KINDS[kind].label, kind, enabled: b.enabled ? 1 : 0, priority: Math.max(1, Math.min(9, num(b.priority, 5))),
    miniserver_id: msId ? Number(msId) : null, meter_uuid: uuid || null, settings: JSON.stringify(s),
  };
}

router.post('/loads', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
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

router.post('/loads/:id/delete', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  for (const t of ['em_log', 'load_runs', 'load_hourly']) await db.prepare(`DELETE FROM ${t} WHERE load_id = ?`).run(id);
  await db.prepare('DELETE FROM energy_loads WHERE id = ?').run(id);
  em.invalidate();
  res.redirect('/energy-manager?saved=deleted');
}));

router.post('/settings', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  await em.saveConfig({ car_priority: Math.max(1, Math.min(9, num(req.body.car_priority, 3))), solar_bonus_eur: Math.max(0, num(req.body.solar_bonus_eur, 0.05)) });
  res.redirect('/energy-manager?saved=settings');
}));

// "Ready by": plan a run of an appliance (shadow: LoxSuite shows and notifies the best start).
router.post('/loads/:id/request.json', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const readyBy = Date.parse(String(req.body?.readyBy || ''));
  if (!Number.isFinite(readyBy) || readyBy < Date.now() + 30 * 60000) return res.json({ ok: false, message: 'Choose a "ready by" time at least 30 minutes from now.' });
  await db.prepare("INSERT INTO load_runs (load_id, start_at, ready_by, kwh, duration_h, label, kind) VALUES (?, ?, ?, ?, ?, ?, 'request')")
    .run(Number(req.params.id), new Date().toISOString(), new Date(readyBy).toISOString(), num(req.body?.kwh), num(req.body?.durationH), String(req.body?.label || '').slice(0, 60) || null);
  await em.recalc().catch(() => {});
  res.json({ ok: true });
}));
router.post('/requests/:id/delete.json', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare("DELETE FROM load_runs WHERE id = ? AND kind = 'request'").run(Number(req.params.id));
  await em.recalc().catch(() => {});
  res.json({ ok: true });
}));

router.post('/import.json', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  try { res.json({ ok: true, report: await em.importHistory(Number(req.body?.days) || 30) }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));
router.post('/recalc.json', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  try { await em.recalc(); await em.tick(); res.json({ ok: true }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));

module.exports = router;
