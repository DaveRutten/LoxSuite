const express = require('express');
const db = require('../db');
const { fetchMiniserver } = require('../loxone');
const { getRoomSummaries, getRoomDetail } = require('../loxoneStructure');
const { ensureConnection, getLiveValue, getStatus } = require('../loxoneWebSocket');
const { suggestForRoom, BUCKET_BY_KEY } = require('../dashboardSuggestions');
const { requirePermission } = require('../middleware/requirePermission');
const { resolveRange } = require('./monitor');
const { PANEL_TYPES, SINGLE_MONITOR_TYPES, buildConfig } = require('./dashboards');
const asyncHandler = require('../middleware/asyncHandler');

const POLL_INTERVALS_MS = [5000, 10000, 30000, 60000, 300000];

const router = express.Router();

// A Miniserver's HTTP server handles only a small number of simultaneous connections well — firing
// off a Promise.all() for every state in a category (some have 30+) either queues most of them
// behind the few open slots or gets some dropped outright, so a "big" category could take
// forever or silently come back with gaps. A small fixed concurrency instead keeps a steady few
// requests in flight without asking for more than the Miniserver can actually handle at once.
const CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function pickMiniserver(miniservers, requestedId) {
  if (requestedId) return miniservers.find((m) => m.id === requestedId) || null;
  // Prefer one already known to be online over just picking whichever sorts first — otherwise
  // adding a second, currently-unreachable Miniserver silently changes which one loads by default,
  // and the visible symptom is just "it's slow"/"empty" rather than anything pointing at why.
  return miniservers.find((m) => m.status === 'online') || miniservers[0] || null;
}

router.get('/', asyncHandler(async (req, res) => {
  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const requestedId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const miniserver = pickMiniserver(miniservers, requestedId);

  if (!miniserver) {
    return res.render('live-data', { miniservers, miniserverId: null, rooms: [], error: null, liveStatus: null });
  }

  ensureConnection(miniserver);
  const liveStatus = getStatus(miniserver.id);
  const gatewaySettings = await db.prepare('SELECT dashboard_suggestions_enabled FROM gateway_settings WHERE id = 1').get();
  const suggestionsEnabled = !!gatewaySettings?.dashboard_suggestions_enabled && res.locals.canEdit('dashboard');

  try {
    // The structure file (LoxAPP3.json) is cached indefinitely per Miniserver (see
    // loxoneStructure.js) since it rarely changes and re-fetching it on every page load would
    // undercut the whole point of caching it — but "rarely" isn't "never": adding a room/control
    // in Loxone Config would otherwise never show up here short of a gateway restart. ?refresh=1
    // (the page's own Refresh button) is the explicit way around that.
    const forceRefresh = req.query.refresh === '1';
    const rooms = await getRoomSummaries(miniserver, { forceRefresh });
    res.render('live-data', { miniservers, miniserverId: miniserver.id, rooms, error: null, liveStatus, suggestionsEnabled });
  } catch (err) {
    res.render('live-data', { miniservers, miniserverId: miniserver.id, rooms: [], error: `Could not read the structure from this Miniserver: ${err.message}`, liveStatus, suggestionsEnabled });
  }
}));

// Polled client-side every few seconds to keep the "Live connection" line honest — connecting on
// first load, then flips to open (or reports an error) without the user needing to refresh the page.
router.get('/status', (req, res) => {
  const miniserverId = Number(req.query.miniserver_id);
  res.json(getStatus(miniserverId));
});

// Polled client-side every so often (see live-data.ejs's background refresh) to pick up rooms/
// controls added in Loxone Config without a full page reload — a plain re-fetch of getRoomSummaries
// against the ALREADY-cached structure (forceRefresh here would defeat the whole point of caching
// LoxAPP3.json indefinitely; the explicit "Refresh" button still exists for that). Room/category
// counts staying current this way is cheap; the actual per-room control/state lists are still only
// fetched on demand when a room is opened, same as ever.
router.get('/rooms', asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.query.miniserver_id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const rooms = await getRoomSummaries(miniserver);
    res.json({ rooms });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// A room's categories/controls are only fetched once it's actually expanded — same reasoning as
// /values below, one level up: rendering every room's full detail up front is what made the
// initial page load enormous (900KB+/2000+ DOM nodes on a real installation, enough to crash a
// browser tab) even though a user only ever looks at a handful of rooms per visit.
router.get('/room', asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.query.miniserver_id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const room = await getRoomDetail(miniserver, req.query.room_uuid);
    res.json(room || { categories: [] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// Live values for a category are only fetched once it's actually expanded — a structure file can
// have hundreds of controls, so reading every one of them up front just to render the page would
// mean hundreds of Miniserver requests before a user has looked at any of them.
router.get('/values', asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.query.miniserver_id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  const uuids = (req.query.uuids || '').split(',').map((u) => u.trim()).filter(Boolean).slice(0, 200);

  ensureConnection(miniserver);

  // The live websocket cache covers the vast majority of states and needs no round trip to the
  // Miniserver at all — only whatever it hasn't seen yet (still connecting, or one of the few
  // state types it doesn't parse, e.g. daytimer/weather tables) falls back to the old HTTP poll.
  const uncached = [];
  const results = uuids.map((uuid) => {
    const cached = getLiveValue(miniserver.id, uuid);
    if (cached === undefined) { uncached.push(uuid); return null; }
    return [uuid, cached];
  });

  const fetched = await mapWithConcurrency(uncached, CONCURRENCY, async (uuid) => {
    try {
      const r = await fetchMiniserver(miniserver, `/jdev/sps/io/${encodeURIComponent(uuid)}`, { timeoutMs: 5000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      return [uuid, body?.LL?.value ?? null];
    } catch (err) {
      return [uuid, null];
    }
  });

  let fetchedIndex = 0;
  const merged = results.map((r) => (r === null ? fetched[fetchedIndex++] : r));
  res.json(Object.fromEntries(merged));
}));

async function suggestionsAllowed(req, res) {
  const settings = await db.prepare('SELECT dashboard_suggestions_enabled FROM gateway_settings WHERE id = 1').get();
  if (!settings?.dashboard_suggestions_enabled) {
    res.status(403).json({ error: 'Dashboard suggestions are turned off in Settings.' });
    return false;
  }
  return true;
}

// Preview for the "Suggest dashboard" button — grouped panel suggestions for one room, nothing
// created yet. See dashboardSuggestions.js for how a control ends up in a given group.
router.get('/suggest', asyncHandler(async (req, res) => {
  if (!(await suggestionsAllowed(req, res))) return;

  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.query.miniserver_id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const room = await getRoomDetail(miniserver, req.query.room_uuid);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ roomName: room.name, buckets: suggestForRoom(room) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// Creates the hand-picked selection as a new personal dashboard: one monitor per chosen
// control+state (found-or-created, same as the "Widget"/"Monitor" buttons elsewhere on this
// page), one panel per bucket referencing all of that bucket's monitors together. Every item is
// re-validated against the room's own current structure (not just trusted as submitted) — the
// preview is built from that same structure, but a stale form or a tampered request shouldn't be
// able to point a monitor at an arbitrary uuid.
router.post('/suggest', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  if (!(await suggestionsAllowed(req, res))) return;

  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.body.miniserver_id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  const room = await getRoomDetail(miniserver, req.body.room_uuid).catch(() => null);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    // uuid -> { controlName, stateName }, every state of every control actually in this room —
    // the allow-list a submitted item's uuid must appear in.
    const knownStates = new Map();
    room.categories.forEach((cat) => cat.controls.forEach((control) => {
      control.states.forEach((s) => knownStates.set(s.uuid, { controlName: control.name, stateName: s.stateName }));
    }));

    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const selected = rawItems
      .filter((item) => item && typeof item.uuid === 'string' && BUCKET_BY_KEY.has(item.bucketKey) && knownStates.has(item.uuid))
      .map((item) => {
        const known = knownStates.get(item.uuid);
        return { uuid: item.uuid, bucketKey: item.bucketKey, controlName: known.controlName, stateName: known.stateName, label: `${known.controlName} / ${known.stateName}` };
      });
    if (selected.length === 0) return res.status(400).json({ error: 'Nothing selected.' });

    const dashboardName = (req.body.dashboard_name || '').trim() || room.name;
    const range = resolveRange(req.body.range);
    const pollIntervalMs = POLL_INTERVALS_MS.includes(Number(req.body.poll_interval_ms)) ? Number(req.body.poll_interval_ms) : 10000;

    // A brand new monitor otherwise shows nothing until its first scheduled poll (up to
    // pollIntervalMs away) — seeding one reading immediately from the websocket's already-live cache
    // is what makes a freshly-created panel show something right away instead of looking empty.
    // One transaction per item (matching the original better-sqlite3 db.transaction(fn); fn()
    // shape, which also opened one transaction per call, not one covering the whole loop below).
    async function findOrCreateMonitor(item) {
      return db.transaction(async (tx) => {
        const existing = await tx.prepare(
          "SELECT id FROM monitors WHERE source_type = 'loxone' AND miniserver_id = ? AND loxone_uuid = ?"
        ).get(miniserver.id, item.uuid);
        const monitorId = existing
          ? existing.id
          : (await tx.prepare(
              "INSERT INTO monitors (source_type, label, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at) VALUES ('loxone', ?, ?, ?, ?, 1, ?)"
            ).run(item.label, miniserver.id, item.uuid, pollIntervalMs, new Date().toISOString())).lastInsertRowid;

        if (!existing) {
          const liveValue = getLiveValue(miniserver.id, item.uuid);
          if (liveValue !== undefined && liveValue !== null) {
            const numeric = Number(liveValue);
            await tx.prepare('INSERT INTO monitor_history (monitor_id, recorded_at, value, numeric_value) VALUES (?, ?, ?, ?)')
              .run(monitorId, new Date().toISOString(), String(liveValue), Number.isFinite(numeric) ? numeric : null);
          }
        }
        return monitorId;
      });
    }

    const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM custom_dashboards WHERE user_id = ?').get(req.session.userId)).m;
    const dashboardId = await db.insertReturningId(
      'INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (?, ?, ?, ?)',
      [req.session.userId, dashboardName, maxPos + 1, new Date().toISOString()]
    );

    // Each bucket's own suggested panelType (BUCKET_BY_KEY) is only the default — the preview lets
    // it be overridden per bucket (e.g. Climate as a Current value panel instead of a chart), same
    // type list and same single-vs-multi-monitor rule as the regular "Add panel" form uses.
    const panelTypeOverrides = req.body.panel_types && typeof req.body.panel_types === 'object' ? req.body.panel_types : {};

    // Group the flat, hand-picked item list back into one panel per bucket, preserving the bucket
    // order from BUCKET_BY_KEY (insertion order) rather than whatever order items happened to arrive
    // in from the form. A bucketKey with no matching bucket (stale/tampered — never possible from
    // the real UI, but the request body is still just JSON from the client) is skipped rather than
    // trusted, same as an unknown one already is above via BUCKET_BY_KEY.has() when building `selected`.
    const itemsByBucket = new Map();
    selected.forEach((item) => {
      if (!BUCKET_BY_KEY.has(item.bucketKey)) return;
      if (!itemsByBucket.has(item.bucketKey)) itemsByBucket.set(item.bucketKey, []);
      itemsByBucket.get(item.bucketKey).push(item);
    });

    const bucketEntries = Array.from(itemsByBucket.entries());
    for (let position = 0; position < bucketEntries.length; position++) {
      const [bucketKey, items] = bucketEntries[position];
      const bucket = BUCKET_BY_KEY.get(bucketKey);
      const override = panelTypeOverrides[bucketKey];
      const panelType = PANEL_TYPES.includes(override) ? override : bucket.panelType;
      // table/gauge/stat_delta/threshold each show exactly one monitor — same truncation the
      // regular panel form applies (routes/dashboards.js), so switching a multi-item bucket to one
      // of these doesn't try to attach items it can't actually display.
      const pickedItems = SINGLE_MONITOR_TYPES.includes(panelType) ? items.slice(0, 1) : items;
      const monitorIds = await Promise.all(pickedItems.map((item) => findOrCreateMonitor(item)));
      const config = JSON.stringify(buildConfig(panelType, {}));
      const panelId = await db.insertReturningId(
        'INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, ?, ?, ?, ?, ?)',
        [dashboardId, panelType, bucket.label, range, config, position]
      );
      for (let i = 0; i < monitorIds.length; i++) {
        await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(panelId, monitorIds[i], i);
      }
    }

    res.json({ dashboardId });
  } catch (err) {
    // Whatever the actual cause (a bad bucket/panel-type override, a DB constraint, ...), this
    // must come back as a normal 500 — an async handler that throws past this point instead
    // becomes an unhandled promise rejection, and Node's default response to one of those is to
    // kill the whole process (see server.js's own process-level safety net, added after this was
    // caught taking the entire container down over exactly this route).
    console.error('POST /live-data/suggest failed:', err);
    res.status(500).json({ error: 'Something went wrong creating the dashboard.' });
  }
}));

module.exports = router;
