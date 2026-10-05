// Administration > Modules (modules.js): switch parts of LoxSuite on or off.
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const modules = require('../modules');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.render('admin-modules', { groups: modules.overview(), changed: req.query.changed ? String(req.query.changed).split(',').filter(Boolean) : [] });
}));

router.post('/:key', asyncHandler(async (req, res) => {
  const on = req.body.enabled === '1' || req.body.enabled === 'on' || req.body.enabled === true;
  const changed = await modules.setEnabled(req.params.key, on, { by: req.session?.username || null });
  const list = changed.map((c) => `${c.key}:${c.enabled ? 1 : 0}`).join(',');
  res.redirect(`/admin/modules?changed=${encodeURIComponent(list)}#mod-${encodeURIComponent(req.params.key)}`);
}));

module.exports = router;
