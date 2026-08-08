const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/:sectionKey', asyncHandler(async (req, res) => {
  await db.upsert('user_nav_prefs', {
    user_id: req.session.userId,
    section_key: req.params.sectionKey,
    collapsed: req.body.collapsed ? 1 : 0,
  }, ['user_id', 'section_key']);

  res.json({ ok: true });
}));

module.exports = router;
