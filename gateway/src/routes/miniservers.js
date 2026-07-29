const express = require('express');
const db = require('../db');
const { checkMiniserver } = require('../healthcheck');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

router.get('/', (req, res) => {
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  res.render('miniservers', { miniservers, error: null });
});

router.post('/', requirePermission('miniservers', 'edit'), (req, res) => {
  const { name, host, http_port, udp_port, username, password, use_https, external_url } = req.body;
  if (!name || !host || !username || !password) {
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
    return res.render('miniservers', { miniservers, error: 'Name, host, username and password are required.' });
  }

  db.prepare(
    `INSERT INTO miniservers (name, host, http_port, udp_port, username, password, use_https, external_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, host, Number(http_port) || 80, udp_port ? Number(udp_port) : null, username, password, use_https ? 1 : 0, external_url ? external_url.trim().replace(/\/+$/, '') : null);

  res.redirect('/miniservers');
});

router.get('/:id/edit', (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).send('Miniserver not found');
  res.render('miniserver-edit', { miniserver, error: null });
});

router.post('/:id/update', requirePermission('miniservers', 'edit'), (req, res) => {
  const { name, host, http_port, udp_port, username, password, use_https, external_url } = req.body;

  // Blank password field = keep the existing one; the current value is never
  // shown back to the browser, so re-typing is only needed to actually change it.
  const existing = db.prepare('SELECT password FROM miniservers WHERE id = ?').get(req.params.id);
  const newPassword = password ? password : existing?.password;

  db.prepare(
    `UPDATE miniservers SET name = ?, host = ?, http_port = ?, udp_port = ?, username = ?, password = ?, use_https = ?, external_url = ?
     WHERE id = ?`
  ).run(name, host, Number(http_port) || 80, udp_port ? Number(udp_port) : null, username, newPassword, use_https ? 1 : 0, external_url ? external_url.trim().replace(/\/+$/, '') : null, req.params.id);

  res.redirect('/miniservers');
});

router.post('/:id/delete', requirePermission('miniservers', 'edit'), (req, res) => {
  db.prepare('DELETE FROM miniservers WHERE id = ?').run(req.params.id);
  res.redirect('/miniservers');
});

router.post('/:id/check', requirePermission('miniservers', 'edit'), async (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (miniserver) await checkMiniserver(miniserver);
  res.redirect('/miniservers');
});

module.exports = router;
