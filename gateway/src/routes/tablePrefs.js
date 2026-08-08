const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/:tableKey', asyncHandler(async (req, res) => {
  const row = await db
    .prepare('SELECT * FROM user_table_prefs WHERE user_id = ? AND table_key = ?')
    .get(req.session.userId, req.params.tableKey);

  res.json({
    order: row?.column_order ? JSON.parse(row.column_order) : null,
    hidden: row?.hidden_columns ? JSON.parse(row.hidden_columns) : [],
    widths: row?.column_widths ? JSON.parse(row.column_widths) : {},
  });
}));

router.delete('/:tableKey', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM user_table_prefs WHERE user_id = ? AND table_key = ?').run(req.session.userId, req.params.tableKey);
  res.json({ ok: true });
}));

router.post('/:tableKey', asyncHandler(async (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const hidden = Array.isArray(req.body.hidden) ? req.body.hidden : [];
  const widths = req.body.widths && typeof req.body.widths === 'object' ? req.body.widths : {};

  await db.upsert('user_table_prefs', {
    user_id: req.session.userId,
    table_key: req.params.tableKey,
    column_order: JSON.stringify(order),
    hidden_columns: JSON.stringify(hidden),
    column_widths: JSON.stringify(widths),
  }, ['user_id', 'table_key']);

  res.json({ ok: true });
}));

module.exports = router;
