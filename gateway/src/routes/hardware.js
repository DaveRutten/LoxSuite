const express = require('express');
const db = require('../db');

const router = express.Router();

// Matches loxoneHardware.js's own `category` values (plus the synthetic 'miniserver' one
// constructed below, which has no equivalent there since the Miniserver itself isn't part of its
// own /data/status document). Order here is also DISPLAY order — a Miniserver's own hardware is
// most usefully read top-down as "the box itself, then what's plugged into it, then what's
// attached over Tree/Air" rather than alphabetically by category key.
const CATEGORY_LABELS = {
  miniserver: 'Miniserver',
  extension: 'Extension',
  audio_server: 'Audioserver',
  audio_zone: 'Audio zone',
  tree: 'Tree device',
  air: 'Air device',
  onewire: '1-Wire device',
  plugin: 'Plugin device',
  // A Plugin's own GenDev children are the individual devices IT exposes (e.g. each Home Connect
  // appliance under a Home Connect plugin, or whatever a generic MCP-server plugin reports) — a
  // distinct label from the plugin/bridge itself, otherwise the category filter dropdown shows two
  // identically-labeled "Plugin device" options with no way to tell which is which.
  gendev: 'Plugin sub-device',
};
const CATEGORY_ORDER = ['miniserver', 'extension', 'audio_server', 'audio_zone', 'tree', 'air', 'onewire', 'plugin', 'gendev'];

router.get('/', (req, res) => {
  const miniservers = db.prepare('SELECT id, name FROM miniservers ORDER BY sort_order, id').all();
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;

  const msQuery = `SELECT id, name, firmware_version, status FROM miniservers${miniserverId ? ' WHERE id = ?' : ''} ORDER BY sort_order, id`;
  const msRows = miniserverId ? db.prepare(msQuery).all(miniserverId) : db.prepare(msQuery).all();
  // The Miniserver itself, presented as just another row in the same list — its firmware/online
  // status already exists (healthcheck.js), just never alongside the hardware attached to it.
  const miniserverRows = msRows.map((ms) => ({
    category: 'miniserver',
    categoryLabel: CATEGORY_LABELS.miniserver,
    type: 'Miniserver',
    name: ms.name,
    place: null,
    version: ms.firmware_version,
    online: ms.status === 'online' ? 1 : (ms.status === 'offline' ? 0 : null),
    battery: null,
    batt_weak: 0,
    bat_too_weak_for_update: 0,
    quality_ext: null,
    quality_dev: null,
    hops: null,
    time_diff: null,
    miniserver_name: ms.name,
  }));

  const hwQuery = `
    SELECT h.*, m.name AS miniserver_name FROM loxone_hardware_devices h
    JOIN miniservers m ON m.id = h.miniserver_id
    ${miniserverId ? 'WHERE h.miniserver_id = ?' : ''}
    ORDER BY m.sort_order, m.id
  `;
  const hwRows = miniserverId ? db.prepare(hwQuery).all(miniserverId) : db.prepare(hwQuery).all();
  const hardwareRowsRaw = hwRows.map((r) => ({ ...r, categoryLabel: CATEGORY_LABELS[r.category] || r.category }));

  // A Loxone "Gateway Client" setup (loxone.com/enen/kb/gateway-client) lets one Miniserver share
  // its Audioserver with another — the shared Audioserver, and every one of its Stereo Extension
  // zones, then shows up in BOTH Miniservers' own /data/status with the exact same MAC each time,
  // since it's the same physical hardware either way. Keeping every miniserver's own copy would
  // otherwise list the same speakers once per Miniserver that can see them. hwRows is already
  // ordered by miniserver sort_order above, so this keeps whichever Miniserver is listed first and
  // drops the rest — MAC alone is enough since it already only exists on this exact hardware.
  const seenAudioMacs = new Set();
  const hardwareRows = hardwareRowsRaw.filter((r) => {
    if ((r.category !== 'audio_server' && r.category !== 'audio_zone') || !r.mac) return true;
    if (seenAudioMacs.has(r.mac)) return false;
    seenAudioMacs.add(r.mac);
    return true;
  });

  // Sorted here (not in SQL) since the Miniserver rows above come from a separate query — category
  // in CATEGORY_ORDER's own priority order, then place, then name within a category. Miniserver
  // rows are the one exception: they're already in the shared, user-configured display order
  // (sort_order, from the query above) and Array#sort is stable in V8, so returning 0 for two
  // 'miniserver' rows preserves that order instead of re-sorting them alphabetically by name.
  const devices = [...miniserverRows, ...hardwareRows].sort((a, b) => {
    const orderDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (orderDiff !== 0) return orderDiff;
    if (a.category === 'miniserver') return 0;
    return (a.place || '').localeCompare(b.place || '') || (a.name || '').localeCompare(b.name || '');
  });

  const categories = CATEGORY_ORDER.map((key) => ({ key, label: CATEGORY_LABELS[key] }));

  // Enabled/disabled/not-yet-created state per hardware rule type, for the toolbar's own
  // enable/disable toggle buttons (see routes/notifications.js's POST /rules/toggle-hardware) —
  // keyed by trigger_type, first match wins if more than one rule of that type somehow exists
  // (the toggle route makes the same "first by id" choice, so this always matches what a click
  // actually affects).
  const hardwareRuleStates = new Map();
  for (const r of db.prepare(
    "SELECT trigger_type, enabled FROM notification_rules WHERE trigger_type IN ('battery_weak','device_firmware_changed','device_offline') ORDER BY id"
  ).all()) {
    if (!hardwareRuleStates.has(r.trigger_type)) hardwareRuleStates.set(r.trigger_type, !!r.enabled);
  }

  res.render('hardware', { devices, miniservers, miniserverId, categories, hardwareRuleStates });
});

module.exports = router;
