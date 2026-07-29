const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/:tableKey', (req, res) => {
  const row = db
    .prepare('SELECT * FROM user_table_prefs WHERE user_id = ? AND table_key = ?')
    .get(req.session.userId, req.params.tableKey);

  res.json({
    order: row?.column_order ? JSON.parse(row.column_order) : null,
    hidden: row?.hidden_columns ? JSON.parse(row.hidden_columns) : [],
  });
});

router.post('/:tableKey', (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const hidden = Array.isArray(req.body.hidden) ? req.body.hidden : [];

  db.prepare(
    `INSERT INTO user_table_prefs (user_id, table_key, column_order, hidden_columns)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, table_key) DO UPDATE SET column_order = excluded.column_order, hidden_columns = excluded.hidden_columns`
  ).run(req.session.userId, req.params.tableKey, JSON.stringify(order), JSON.stringify(hidden));

  res.json({ ok: true });
});

module.exports = router;
