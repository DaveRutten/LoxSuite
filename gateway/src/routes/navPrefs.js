const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/:sectionKey', asyncHandler(async (req, res) => {
  await db.prepare(
    `INSERT INTO user_nav_prefs (user_id, section_key, collapsed) VALUES (?, ?, ?)
     ON CONFLICT(user_id, section_key) DO UPDATE SET collapsed = excluded.collapsed`
  ).run(req.session.userId, req.params.sectionKey, req.body.collapsed ? 1 : 0);

  res.json({ ok: true });
}));

module.exports = router;
