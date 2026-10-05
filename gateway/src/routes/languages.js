// Administration > Languages (i18n.js): which languages users can choose, the installation default,
// adding a language, and import/export of a language's translations as JSON.
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const i18n = require('../i18n');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();
const back = (res, q) => res.redirect(`/admin/languages${q ? `?${q}` : ''}`);

router.get('/', asyncHandler(async (req, res) => {
  const langs = i18n.listLanguages().map((l) => ({ ...l, progress: l.code === i18n.BASE ? null : i18n.progress(l.code) }));
  res.render('admin-languages', { langs, error: req.query.error || null, saved: req.query.saved || null });
}));

const act = (fn, msg) => asyncHandler(async (req, res) => {
  try { await fn(req); await logSystemEvent(`"${req.user.username}" ${msg(req)}.`).catch(() => {}); back(res, 'saved=1'); } catch (err) { back(res, `error=${encodeURIComponent(err.message)}`); }
});

router.post('/add', act((req) => i18n.addLanguage(req.body.code, req.body.name), (req) => `added language ${req.body.code}`));
router.post('/:code/enabled', act((req) => i18n.setLanguageEnabled(req.params.code, req.body.enabled === '1'), (req) => `switched language ${req.params.code} ${req.body.enabled === '1' ? 'on' : 'off'}`));
router.post('/:code/default', act((req) => i18n.setDefaultLanguage(req.params.code), (req) => `made ${req.params.code} the default language`));
router.post('/:code/delete', act((req) => i18n.removeLanguage(req.params.code), (req) => `removed language ${req.params.code}`));

router.get('/:code/export', asyncHandler(async (req, res) => {
  if (!i18n.listLanguages().some((l) => l.code === req.params.code)) return back(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="loxsuite-${req.params.code}.json"`);
  res.send(JSON.stringify(i18n.exportLanguage(req.params.code), null, 2));
}));

// Import: the JSON pasted or picked as a file (read in the browser into the textarea).
router.post('/:code/import', asyncHandler(async (req, res) => {
  try {
    let data;
    try { data = JSON.parse(String(req.body.json || '')); } catch { throw new Error('That is not valid JSON.'); }
    const n = await i18n.importLanguage(req.params.code, data, req.user.username);
    await logSystemEvent(`"${req.user.username}" imported ${n} translations for ${req.params.code}.`).catch(() => {});
    back(res, `saved=${encodeURIComponent(`${n} translations imported`)}`);
  } catch (err) { back(res, `error=${encodeURIComponent(err.message)}`); }
}));

module.exports = router;
