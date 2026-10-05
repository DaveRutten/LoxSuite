// Administration > Modules (modules.js): switch parts of LoxSuite on or off.
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const modules = require('../modules');
const moduleInfo = require('../moduleInfo');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.render('admin-modules', { groups: modules.overview(), changed: req.query.changed ? String(req.query.changed).split(',').filter(Boolean) : [], error: req.query.error || null, wiped: req.query.wiped || null });
}));

// Status + Getting started (lazy, per card).
router.get('/:key/status.json', asyncHandler(async (req, res) => {
  if (!modules.MODULES.some((m) => m.key === req.params.key)) return res.status(404).json({ error: 'Unknown module.' });
  const st = await moduleInfo.status(req.params.key);
  const t = res.locals.t || ((k) => k);
  st.checklist = st.checklist.map((c) => ({ ...c, label: t(c.label) }));
  st.tables = st.tables.map((x) => ({ ...x, label: t(x.label) }));
  res.json({ enabled: modules.isOn(req.params.key), ...st });
}));

// Export of the module's data: zip with JSON + CSV per table (secrets removed).
router.get('/:key/export', asyncHandler(async (req, res) => {
  const mod = modules.MODULES.find((m) => m.key === req.params.key);
  if (!mod) return res.redirect('/admin/modules');
  const buf = await moduleInfo.exportZip(mod.key, { version: require('../../package.json').version });
  const { logSystemEvent } = require('../auditLog');
  logSystemEvent(`"${req.user?.username || '?'}" exported the data of module ${mod.label}.`).catch(() => {});
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="loxsuite-${mod.key}-${new Date().toISOString().slice(0, 10)}.zip"`);
  res.send(buf);
}));

// Wipe the module's data — only while it is off, and only after typing its key.
router.post('/:key/wipe', asyncHandler(async (req, res) => {
  const mod = modules.MODULES.find((m) => m.key === req.params.key);
  if (!mod) return res.redirect('/admin/modules');
  const back = (q) => res.redirect(`/admin/modules?${q}#mod-${encodeURIComponent(mod.key)}`);
  if (String(req.body.confirm || '').trim() !== mod.key) return back(`error=${encodeURIComponent(`Type "${mod.key}" to confirm wiping ${mod.label}.`)}`);
  try {
    const done = await moduleInfo.wipe(mod.key);
    const rows = done.reduce((a, d) => a + (d.rows || 0), 0);
    const { logSystemEvent } = require('../auditLog');
    await logSystemEvent(`"${req.user?.username || '?'}" wiped the data of module ${mod.label} (${rows} rows).`).catch(() => {});
    return back(`wiped=${encodeURIComponent(`${mod.label}: ${rows} rows deleted`)}`);
  } catch (err) {
    return back(`error=${encodeURIComponent(err.message)}`);
  }
}));

router.post('/:key', asyncHandler(async (req, res) => {
  const on = req.body.enabled === '1' || req.body.enabled === 'on' || req.body.enabled === true;
  const changed = await modules.setEnabled(req.params.key, on, { by: req.session?.username || null });
  const list = changed.map((c) => `${c.key}:${c.enabled ? 1 : 0}`).join(',');
  res.redirect(`/admin/modules?changed=${encodeURIComponent(list)}#mod-${encodeURIComponent(req.params.key)}`);
}));

module.exports = router;
