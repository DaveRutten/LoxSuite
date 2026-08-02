const express = require('express');
const db = require('../db');
const { checkMiniserver, runDetailedCheck } = require('../healthcheck');
const { miniserverGenerationLabel } = require('../format');
const { fetchMiniserver } = require('../loxone');
const { testConnection: testLiveConnection, resetConnection: resetLiveConnection } = require('../loxoneWebSocket');
const { requirePermission } = require('../middleware/requirePermission');
const { logSystemEvent } = require('../auditLog');
const { encrypt } = require('../secretCrypto');

const router = express.Router();

router.get('/', (req, res) => {
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY id').all();
  res.render('miniservers', { miniservers, error: null });
});

router.post('/', requirePermission('miniservers', 'edit'), async (req, res) => {
  const { name, host, http_port, udp_port, username, password, use_https, external_url } = req.body;
  if (!name || !host || !username || !password) {
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY id').all();
    return res.render('miniservers', { miniservers, error: 'Name, host, username and password are required.' });
  }

  const result = db.prepare(
    `INSERT INTO miniservers (name, host, http_port, udp_port, username, password, use_https, external_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, host, Number(http_port) || 80, udp_port ? Number(udp_port) : null, username, encrypt(password), use_https ? 1 : 0, external_url ? external_url.trim().replace(/\/+$/, '') : null);

  logSystemEvent(`"${req.user.username}" added Miniserver "${name}" (${host}).`);

  // Otherwise this sits on "Unknown" (badge-neutral) until the next periodic healthcheck sweep
  // (up to 60s later, see startHealthchecks) — awaited here so the very next page load already
  // shows Online/Offline instead of a status that reads as broken right after adding one.
  const inserted = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(result.lastInsertRowid);
  await checkMiniserver(inserted);

  res.redirect('/miniservers');
});

// Tests connectivity against whatever's currently typed into the Add-Miniserver form, before it's
// been saved — a plain functional check (no miniserver.id yet to key a DB write or a persistent
// live-websocket connection against, see loxoneWebSocket.js's ensureConnection), so this only runs
// the stateless HTTP probes runDetailedCheck already does for the saved-row "Test now" button, not
// the live-connection one.
router.post('/test', requirePermission('miniservers', 'edit'), async (req, res) => {
  const { host, http_port, username, password, use_https, external_url } = req.body;
  if (!host || !username || !password) {
    return res.status(400).json({ error: 'Host, username and password are required to test.' });
  }
  const candidate = {
    host,
    http_port: Number(http_port) || 80,
    username,
    password,
    use_https: !!use_https,
    external_url: external_url ? external_url.trim().replace(/\/+$/, '') : null,
  };
  const detail = await runDetailedCheck(candidate);
  res.json(detail);
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
  const newPassword = password ? encrypt(password) : existing?.password;

  db.prepare(
    `UPDATE miniservers SET name = ?, host = ?, http_port = ?, udp_port = ?, username = ?, password = ?, use_https = ?, external_url = ?
     WHERE id = ?`
  ).run(name, host, Number(http_port) || 80, udp_port ? Number(udp_port) : null, username, newPassword, use_https ? 1 : 0, external_url ? external_url.trim().replace(/\/+$/, '') : null, req.params.id);
  resetLiveConnection(Number(req.params.id));

  logSystemEvent(`"${req.user.username}" updated Miniserver "${name}" (${host}).`);
  res.redirect('/miniservers');
});

router.post('/:id/delete', requirePermission('miniservers', 'edit'), (req, res) => {
  const miniserver = db.prepare('SELECT name, host FROM miniservers WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM miniservers WHERE id = ?').run(req.params.id);
  resetLiveConnection(Number(req.params.id));
  logSystemEvent(`"${req.user.username}" deleted Miniserver "${miniserver?.name}" (${miniserver?.host}).`);
  res.redirect('/miniservers');
});

router.post('/:id/check', requirePermission('miniservers', 'edit'), async (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  const [, detail, live] = await Promise.all([
    checkMiniserver(miniserver),
    runDetailedCheck(miniserver),
    testLiveConnection(miniserver),
  ]);
  const updated = db.prepare('SELECT status, last_checked_at, firmware_version, device_monitor_status, miniserver_type FROM miniservers WHERE id = ?').get(miniserver.id);
  res.json({
    ...detail,
    live,
    status: updated.status,
    lastCheckedAt: updated.last_checked_at,
    firmwareVersion: updated.firmware_version,
    deviceMonitorStatus: updated.device_monitor_status,
    generationLabel: miniserverGenerationLabel(updated.miniserver_type),
  });
});

// /jdev/sys/updatecheck — undocumented, found the same way as the diagnostics endpoints (grepped
// out of the Miniserver's own /admin JS bundle), tells the Miniserver to check its own update
// server. Returns 200 with an empty value over plain HTTP even when a newer release genuinely
// exists (verified against a real Miniserver) — there's no synchronous "yes/no, here's the
// version" answer available this way, so this only reports the Miniserver's own current
// version/update-channel (jdev/cfg/updatelevel — e.g. "Alpha" vs the stable channel) rather than
// claiming to know whether an update is actually available.
router.post('/:id/check-update', requirePermission('miniservers', 'edit'), async (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    await fetchMiniserver(miniserver, '/jdev/sys/updatecheck', { timeoutMs: 8000 });
    const levelRes = await fetchMiniserver(miniserver, '/jdev/cfg/updatelevel', { timeoutMs: 8000 });
    const levelBody = levelRes.ok ? await levelRes.json() : null;
    const updateLevel = levelBody?.LL?.value || null;
    if (updateLevel) db.prepare('UPDATE miniservers SET update_level = ? WHERE id = ?').run(updateLevel, miniserver.id);
    res.json({ updateLevel, checked: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// /dev/sys/updatetolatestrelease — undocumented, found the same way as the above. Triggers a REAL
// firmware update + reboot on this specific Miniserver; nothing about this route is a dry run.
// Gated on the same edit permission as delete/update above, and every call is logged via
// logSystemEvent regardless of outcome — this is exactly the kind of action that needs an audit
// trail. The confirm dialog lives client-side (data-confirm, miniservers.ejs) since this route has
// no way to know a human deliberately clicked it vs. any other POST to this URL.
router.post('/:id/update-firmware', requirePermission('miniservers', 'edit'), async (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const result = await fetchMiniserver(miniserver, '/jdev/sys/updatetolatestrelease', { timeoutMs: 15000 });
    const body = result.ok ? await result.json() : null;
    logSystemEvent(`"${req.user.username}" triggered a firmware update on Miniserver "${miniserver.name}" (${miniserver.host}).`);
    res.json({ triggered: true, response: body?.LL?.value ?? null });
  } catch (err) {
    // A timeout/connection-drop here is expected once the Miniserver actually reboots into the
    // update — not necessarily a failure, just the point where it stops answering HTTP requests.
    logSystemEvent(`"${req.user.username}" triggered a firmware update on Miniserver "${miniserver.name}" (${miniserver.host}) — connection ended before a response came back (expected if it's now rebooting): ${err.message}`);
    res.json({ triggered: true, response: null, note: 'Connection ended before a response came back — expected if the Miniserver is now rebooting into the update.' });
  }
});

module.exports = router;
