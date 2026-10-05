// Translations (i18n.js): translate LoxSuite into the languages switched on under Administration >
// Languages. View = see the page, Edit = save translations (permission area 'translations').
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const i18n = require('../i18n');
const modules = require('../modules');

const router = express.Router();

function moduleLabel(key, t) {
  if (key === 'core') return t('Core');
  const m = modules.MODULES.find((x) => x.key === key);
  return m ? t(m.label) : key;
}

router.get('/', asyncHandler(async (req, res) => {
  const langs = i18n.listLanguages().filter((l) => l.code !== i18n.BASE);
  const lang = langs.some((l) => l.code === req.query.lang) ? req.query.lang : (langs.find((l) => l.code === req.lang) || langs[0] || {}).code;
  const t = res.locals.t;
  const progress = lang ? i18n.progress(lang) : null;
  if (progress) progress.modules = progress.modules.map((p) => ({ ...p, label: moduleLabel(p.module, t), on: p.module === 'core' || modules.isOn(p.module) })).sort((a, b) => (a.module === 'core' ? -1 : b.module === 'core' ? 1 : a.label.localeCompare(b.label)));
  res.render('translations', { langs, lang, progress, entries: lang ? i18n.entries(lang) : [] });
}));

// One translation (JSON, CSRF-exempt like the other *.json endpoints).
router.post('/save.json', requirePermission('translations', 'edit'), asyncHandler(async (req, res) => {
  try {
    const { lang, key, text } = req.body || {};
    if (!i18n.catalog().some((e) => e.key === key)) return res.json({ ok: false, error: 'Unknown text.' });
    const saved = await i18n.saveTranslation(String(lang || ''), key, text, req.user.username);
    res.json({ ok: true, text: saved, effective: i18n.translate(lang, key) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
}));

module.exports = router;
