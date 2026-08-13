const express = require('express');
const db = require('../db');
const { checkMiniserver, runDetailedCheck } = require('../healthcheck');
const { miniserverGenerationLabel, formatHeapStatus, plcStateLabel } = require('../format');
const { formatDateTime } = require('../dateFormat');
const { fetchMiniserver } = require('../loxone');
const { testConnection: testLiveConnection, resetConnection: resetLiveConnection } = require('../loxoneWebSocket');
const { requirePermission } = require('../middleware/requirePermission');
const { logSystemEvent, describeChanges } = require('../auditLog');
const { encrypt } = require('../secretCrypto');
const mcpClient = require('../mcpClient');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Same bundle quick-add-diag/the Miniservers-page "Add to Monitor" button pins in one click (see
// routes/dashboards.js's own QUICK_ADD_DIAG_FIELDS) — kept as its own copy rather than exported
// from there, matching that file's own comment on why DIAG_FIELD_LABELS is the one thing shared
// instead: this list is a UI decision (which 3 of the 4 diag fields get a one-click bundle),
// duplicating a 3-item array is cheaper than a cross-route-file dependency for it.
const DIAG_MONITOR_BUNDLE_FIELDS = ['cpu_load', 'heap_value_kb', 'num_tasks'];

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const nameById = new Map(rows.map((ms) => [ms.id, ms.name]));
  // Whether THIS Miniserver's "Add to Monitor" bundle button has anything left to add — grey it
  // out once all 3 fields already have their own monitor, same "don't invite creating a
  // functionally identical row" reasoning as Live Data's own per-state +Monitor button
  // (routes/liveData.js). findOrCreateDiagMonitor already makes clicking it again harmless (it
  // reuses whichever of the 3 already exist rather than duplicating them), so this is purely a
  // clarity improvement, not a correctness fix the way that one was.
  const diagMonitorCounts = new Map();
  (await db.prepare("SELECT miniserver_id, COUNT(DISTINCT diag_field) AS n FROM monitors WHERE source_type = 'miniserver_diag' AND diag_field IN (?, ?, ?) GROUP BY miniserver_id")
    .all(...DIAG_MONITOR_BUNDLE_FIELDS)).forEach((r) => diagMonitorCounts.set(r.miniserver_id, r.n));
  // Client count per Gateway — every OTHER row whose own gateway_client_of points here — so a
  // Gateway's own row can show "Gateway · N clients" without a second query per row.
  const clientCountByGatewayId = new Map();
  rows.forEach((ms) => {
    if (!ms.gateway_client_of) return;
    clientCountByGatewayId.set(ms.gateway_client_of, (clientCountByGatewayId.get(ms.gateway_client_of) || 0) + 1);
  });
  const decoratedRows = rows.map((ms) => ({
    ...ms,
    gatewayClientOfName: ms.gateway_client_of ? nameById.get(ms.gateway_client_of) || null : null,
    gatewayClientCount: clientCountByGatewayId.get(ms.id) || 0,
    diagFullyMonitored: (diagMonitorCounts.get(ms.id) || 0) >= DIAG_MONITOR_BUNDLE_FIELDS.length,
  }));

  // Every Client immediately follows its own Gateway in the rendered list, regardless of what its
  // own raw sort_order number happens to be — a plain ORDER BY sort_order alone can't guarantee
  // that (a Client's sort_order can drift relative to its Gateway's own after enough drag
  // reordering, e.g. an unrelated Miniserver getting moved in between them), and the page's own
  // <tr> structure (see partials/miniserver-row.ejs) assumes a Client's row — and its diagnostics
  // row right after it — always sits directly under its Gateway's own. Built from the already
  // sort_order-ordered rows above, so both the top-level rows and each Gateway's own Clients stay
  // in their existing relative order — this only fixes which GROUP a Client renders inside, never
  // reshuffles anyone within one.
  const clientsByGatewayId = new Map();
  decoratedRows.forEach((ms) => {
    if (!ms.gateway_client_of) return;
    if (!clientsByGatewayId.has(ms.gateway_client_of)) clientsByGatewayId.set(ms.gateway_client_of, []);
    clientsByGatewayId.get(ms.gateway_client_of).push(ms);
  });
  const miniservers = [];
  decoratedRows.forEach((ms) => {
    if (ms.gateway_client_of) return; // placed via its own Gateway's own entry below, not here
    miniservers.push(ms);
    (clientsByGatewayId.get(ms.id) || []).forEach((client) => miniservers.push(client));
  });

  res.render('miniservers', { miniservers, error: null });
}));

// JSON feed for the Tabulator-backed table (see miniservers.ejs) — Tabulator builds its own DOM
// from a data array + column defs rather than taking over server-rendered <tr>s, so unlike every
// plain-<table> page in this app, this one needs an actual data endpoint alongside the page route
// above (which still renders the page shell/toolbar/scripts, just no <table> HTML of its own).
// Nested via _children (Tabulator's own dataTree shape) — a Gateway's Clients underneath it,
// mirroring the same grouping the plain-table version built via clientsByGatewayId/sort_order.
router.get('/data.json', asyncHandler(async (req, res) => {
  const canEdit = res.locals.canEdit('miniservers');
  const rows = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const nameById = new Map(rows.map((ms) => [ms.id, ms.name]));
  const clientCountByGatewayId = new Map();
  rows.forEach((ms) => {
    if (!ms.gateway_client_of) return;
    clientCountByGatewayId.set(ms.gateway_client_of, (clientCountByGatewayId.get(ms.gateway_client_of) || 0) + 1);
  });
  // Same "Add to Monitor" already-covered check as the plain page route above — this Tabulator
  // JSON feed is what the page actually renders (see miniservers.ejs's own PILOT comment), the
  // plain route's own rendering of miniserver-diagnostics.ejs isn't reachable from here at all.
  const diagMonitorCounts = new Map();
  (await db.prepare("SELECT miniserver_id, COUNT(DISTINCT diag_field) AS n FROM monitors WHERE source_type = 'miniserver_diag' AND diag_field IN (?, ?, ?) GROUP BY miniserver_id")
    .all(...DIAG_MONITOR_BUNDLE_FIELDS)).forEach((r) => diagMonitorCounts.set(r.miniserver_id, r.n));

  function toRow(ms) {
    const plc = plcStateLabel(ms.plc_state);
    return {
      id: ms.id,
      diagFullyMonitored: (diagMonitorCounts.get(ms.id) || 0) >= DIAG_MONITOR_BUNDLE_FIELDS.length,
      status: ms.status,
      statusLabel: ms.status === 'online' ? 'Online' : ms.status === 'offline' ? 'Offline' : ms.status === 'auth_failed' ? 'Auth failed' : 'Unknown',
      stateLabel: plc ? plc[0] : null,
      stateBadgeClass: plc ? plc[1] : null,
      firmwareVersion: ms.firmware_version,
      generationLabel: miniserverGenerationLabel(ms.miniserver_type),
      cpuLoad: ms.cpu_load,
      heapStatus: formatHeapStatus(ms.heap_status),
      numTasks: ms.num_tasks,
      firmwareDate: ms.firmware_date,
      updateLevel: ms.update_level,
      name: ms.name,
      gatewayRole: ms.gateway_client_of ? 'client' : ((clientCountByGatewayId.get(ms.id) || 0) > 0 ? 'gateway' : 'standalone'),
      gatewayClientOfName: ms.gateway_client_of ? nameById.get(ms.gateway_client_of) || null : null,
      gatewayClientCount: clientCountByGatewayId.get(ms.id) || 0,
      host: ms.host,
      httpPort: ms.http_port,
      useHttps: !!ms.use_https,
      udpPort: ms.udp_port,
      externalUrl: ms.external_url,
      username: ms.username,
      lastCheckedAt: ms.last_checked_at ? formatDateTime(ms.last_checked_at) : null,
      lastSuccessAt: ms.last_success_at ? formatDateTime(ms.last_success_at) : null,
      lastError: ms.last_error,
      canEdit,
    };
  }

  const clientsByGatewayId = new Map();
  rows.forEach((ms) => {
    if (!ms.gateway_client_of) return;
    if (!clientsByGatewayId.has(ms.gateway_client_of)) clientsByGatewayId.set(ms.gateway_client_of, []);
    clientsByGatewayId.get(ms.gateway_client_of).push(ms);
  });

  const tree = [];
  rows.forEach((ms) => {
    if (ms.gateway_client_of) return;
    const row = toRow(ms);
    const clients = clientsByGatewayId.get(ms.id);
    if (clients && clients.length) row._children = clients.map(toRow);
    tree.push(row);
  });

  res.json(tree);
}));

// Parses the Add-Miniserver form's own clients_json (see miniservers.ejs) — an array of
// {name, host, http_port, use_https} for a Gateway's Client Miniservers, added inline in the same
// form instead of one at a time via separate Add-Miniserver round-trips. Malformed/absent JSON
// (is_gateway off, or no clients actually filled in) just means "no clients," not an error — this
// whole feature is optional on every Miniserver.
function parseClientsJson(raw) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.host === 'string' && c.host.trim())
    .map((c) => ({
      // Only present on the Edit page's own version of this form (an existing Client being
      // edited in place, not a brand new one) — Number.isInteger guards against a stray/forged
      // non-numeric id doing anything other than falling through to "treat as new."
      id: Number.isInteger(c.id) ? c.id : null,
      name: c.name.trim(),
      host: c.host.trim(),
      http_port: Number(c.http_port) || 80,
      use_https: !!c.use_https,
    }));
}

router.post('/', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const { name, host, http_port, udp_port, username, password, use_https, external_url, clients_json } = req.body;
  if (!name || !host || !username || !password) {
    const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
    return res.render('miniservers', { miniservers, error: 'Name, host, username and password are required.' });
  }
  const clients = parseClientsJson(clients_json);

  // Appended to the end of the shared display order (see db.js's migrateMiniserverStatusColumns)
  // rather than defaulting to 0, which would otherwise jump a newly-added Miniserver to the front
  // of every page that lists them.
  const nextSortOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM miniservers').get()).next;
  const encryptedPassword = encrypt(password);
  const insertMiniserverSql = `INSERT INTO miniservers (name, host, http_port, udp_port, username, password, use_https, external_url, sort_order, gateway_client_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const gatewayId = await db.insertReturningId(insertMiniserverSql, [
    name, host, Number(http_port) || 80, udp_port ? Number(udp_port) : null, username, encryptedPassword,
    use_https ? 1 : 0, external_url ? external_url.trim().replace(/\/+$/, '') : null, nextSortOrder, null,
  ]);

  await logSystemEvent(`"${req.user.username}" added Miniserver "${name}" (${host}).`);

  // Each Client Miniserver reuses the Gateway's own credentials — Loxone requires them to be
  // identical across the whole Gateway/Client group (see the Add form's own hint text) — and gets
  // appended to the shared sort order right after the Gateway itself.
  const insertedIds = [gatewayId];
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index];
    const clientId = await db.insertReturningId(insertMiniserverSql, [
      client.name, client.host, client.http_port, null, username, encryptedPassword,
      client.use_https ? 1 : 0, null, nextSortOrder + index + 1, gatewayId,
    ]);
    insertedIds.push(clientId);
    await logSystemEvent(`"${req.user.username}" added Miniserver "${client.name}" (${client.host}) as a Gateway Client of "${name}".`);
  }

  // Otherwise this sits on "Unknown" (badge-neutral) until the next periodic healthcheck sweep
  // (up to 60s later, see startHealthchecks) — awaited here so the very next page load already
  // shows Online/Offline instead of a status that reads as broken right after adding one. All of
  // them, Gateway and Clients alike, not just the Gateway — same reasoning applies to every one.
  const insertedRows = await Promise.all(insertedIds.map((id) => db.prepare('SELECT * FROM miniservers WHERE id = ?').get(id)));
  await Promise.all(insertedRows.map((ms) => checkMiniserver(ms)));

  res.redirect('/miniservers');
}));

// Tests connectivity against whatever's currently typed into the Add-Miniserver form, before it's
// been saved — a plain functional check (no miniserver.id yet to key a DB write or a persistent
// live-websocket connection against, see loxoneWebSocket.js's ensureConnection), so this only runs
// the stateless HTTP probes runDetailedCheck already does for the saved-row "Test now" button, not
// the live-connection one.
router.post('/test', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
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
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).send('Miniserver not found');
  // Candidates for "Gateway Client of" below — every other Miniserver, excluding this one (a
  // Miniserver can't be a Gateway Client of itself) and excluding any Miniserver that's already a
  // Gateway Client of THIS one (a two-hop chain would just be confusing — Loxone's own Gateway
  // Client setup is a single Gateway managing its Clients directly, not a chain of them).
  const otherMiniservers = await db
    .prepare('SELECT id, name FROM miniservers WHERE id != ? AND (gateway_client_of IS NULL OR gateway_client_of != ?) ORDER BY sort_order, id')
    .all(miniserver.id, miniserver.id);
  const existingClients = await db
    .prepare('SELECT id, name, host, http_port, use_https FROM miniservers WHERE gateway_client_of = ? ORDER BY sort_order, id')
    .all(miniserver.id);
  res.render('miniserver-edit', { miniserver, otherMiniservers, existingClients, error: null, saved: req.query.saved === '1', authorized: req.query.authorized === '1' });
}));

router.post('/:id/update', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const { name, host, http_port, udp_port, username, password, use_https, external_url, gateway_client_of, clients_json, ai_enabled, ai_allow_write_commands, mcp_url } = req.body;
  const msId = Number(req.params.id);

  // Full row (not just password) — also feeds the describeChanges() audit line below, so the
  // System log shows what actually changed instead of a bare "updated Miniserver X."
  const existing = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(msId);
  // Blank password field = keep the existing one; the current value is never
  // shown back to the browser, so re-typing is only needed to actually change it.
  const newPassword = password ? encrypt(password) : existing?.password;

  // Empty string ("None"), a self-reference, or the "This miniserver is a client" toggle itself
  // being off all mean "not a Gateway Client of anything" — the dropdown itself already excludes
  // this Miniserver's own id (see GET /:id/edit above), but a stray manual POST shouldn't be able
  // to create a self-referencing loop either. is_client matters here because the <select> it
  // reveals/hides is only ever CSS-hidden while off (see #edit-ms-gateway-of-wrap), never disabled
  // or removed — an unchecked checkbox submits nothing at all, so without this check, turning the
  // toggle off and saving silently kept whichever Gateway the hidden select was still holding.
  const gatewayId = Number(gateway_client_of);
  const gatewayClientOf = req.body.is_client && gateway_client_of && Number.isInteger(gatewayId) && gatewayId !== msId ? gatewayId : null;

  const resolved = {
    name, host,
    http_port: Number(http_port) || 80,
    udp_port: udp_port ? Number(udp_port) : null,
    username, password: newPassword,
    use_https: use_https ? 1 : 0,
    external_url: external_url ? external_url.trim().replace(/\/+$/, '') : null,
    gateway_client_of: gatewayClientOf,
    ai_enabled: ai_enabled ? 1 : 0,
    ai_allow_write_commands: ai_allow_write_commands ? 1 : 0,
    mcp_url: mcp_url ? mcp_url.trim().replace(/\/+$/, '') : null,
  };
  await db.prepare(
    `UPDATE miniservers SET name = ?, host = ?, http_port = ?, udp_port = ?, username = ?, password = ?, use_https = ?, external_url = ?, gateway_client_of = ?,
     ai_enabled = ?, ai_allow_write_commands = ?, mcp_url = ?
     WHERE id = ?`
  ).run(
    resolved.name, resolved.host, resolved.http_port, resolved.udp_port, resolved.username, resolved.password, resolved.use_https,
    resolved.external_url, resolved.gateway_client_of, resolved.ai_enabled, resolved.ai_allow_write_commands, resolved.mcp_url,
    msId
  );
  resetLiveConnection(msId);
  const changes = describeChanges(existing, resolved, [
    { key: 'name', label: 'Name' },
    { key: 'host', label: 'Host' },
    { key: 'http_port', label: 'HTTP port' },
    { key: 'udp_port', label: 'UDP port' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'use_https', label: 'HTTPS' },
    { key: 'external_url', label: 'External URL' },
    { key: 'gateway_client_of', label: 'Gateway' },
    { key: 'ai_enabled', label: 'AI Assistant enabled' },
    { key: 'ai_allow_write_commands', label: 'AI Assistant can send commands' },
    { key: 'mcp_url', label: 'MCP URL override' },
  ]);
  await logSystemEvent(`"${req.user.username}" updated Miniserver "${name}" (${host}).${changes ? ` (${changes})` : ''}`);

  // This Miniserver's own Client Miniservers (see miniserver-edit.ejs) — same shared-credentials
  // reasoning as the Add form. An existing Client (has an id) is updated in place; a new row (no
  // id) is inserted fresh; any Client that HAD this Miniserver as its Gateway but wasn't resubmitted
  // is unlinked (gateway_client_of cleared), not deleted — removing a row here means "no longer a
  // Client of this one," not "delete this Miniserver and everything tied to its id."
  const clients = parseClientsJson(clients_json);
  const existingClientRows = await db.prepare('SELECT id FROM miniservers WHERE gateway_client_of = ?').all(msId);
  const existingClientIds = new Set(existingClientRows.map((r) => r.id));
  const submittedIds = new Set();
  const newClientIds = [];

  for (const client of clients) {
    if (client.id && existingClientIds.has(client.id)) {
      submittedIds.add(client.id);
      await db.prepare('UPDATE miniservers SET name = ?, host = ?, http_port = ?, username = ?, password = ?, use_https = ? WHERE id = ?')
        .run(client.name, client.host, client.http_port, username, newPassword, client.use_https ? 1 : 0, client.id);
      resetLiveConnection(client.id);
    } else {
      const nextSortOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM miniservers').get()).next;
      const newClientId = await db.insertReturningId(
        `INSERT INTO miniservers (name, host, http_port, username, password, use_https, sort_order, gateway_client_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [client.name, client.host, client.http_port, username, newPassword, client.use_https ? 1 : 0, nextSortOrder, msId]
      );
      newClientIds.push(newClientId);
      await logSystemEvent(`"${req.user.username}" added Miniserver "${client.name}" (${client.host}) as a Gateway Client of "${name}".`);
    }
  }
  for (const id of [...existingClientIds].filter((cid) => !submittedIds.has(cid))) {
    await db.prepare('UPDATE miniservers SET gateway_client_of = NULL WHERE id = ?').run(id);
  }

  // Same "don't leave it on Unknown" reasoning as the Add form — only the newly-created Clients
  // need this; an existing (already-checked) Client's status is unaffected by this save.
  const newClients = await Promise.all(newClientIds.map((id) => db.prepare('SELECT * FROM miniservers WHERE id = ?').get(id)));
  await Promise.all(newClients.map((ms) => checkMiniserver(ms)));

  // Back to THIS Miniserver's own edit page, not the list — Save used to bounce you back to the
  // overview, so testing/authorizing a value you just changed meant Edit → change → Save → Edit
  // again before Test/Authorize would even see it (both act on the saved row, not the form's own
  // unsaved state). Staying here means the field you just saved is immediately what Test sees.
  res.redirect(`/miniservers/${msId}/edit?saved=1`);
}));

// Persists the Miniservers page's own drag-and-drop row reorder in one shot — every other page
// that lists Miniservers queries by this same sort_order column (see db.js's
// migrateMiniserverStatusColumns), so this is authoritative everywhere at once, not just here. JSON
// body (not a form post) so this is exempt from the CSRF token check (see middleware/csrf.js) and
// can fire straight from a drop handler without a full page reload/redirect.
router.post('/reorder', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n));
  await db.transaction(async (tx) => {
    for (let index = 0; index < ids.length; index++) {
      await tx.prepare('UPDATE miniservers SET sort_order = ? WHERE id = ?').run(index, ids[index]);
    }
  });
  res.json({ ok: true });
}));

router.post('/:id/delete', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT name, host FROM miniservers WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM miniservers WHERE id = ?').run(req.params.id);
  resetLiveConnection(Number(req.params.id));
  await logSystemEvent(`"${req.user.username}" deleted Miniserver "${miniserver?.name}" (${miniserver?.host}).`);
  res.redirect('/miniservers');
}));

// One-time browser-based OAuth 2.1 authorization of this Miniserver's own native MCP server
// plugin, for the optional AI Assistant feature — see mcpClient.js's own header comment for why
// this uses @modelcontextprotocol/sdk's auth() orchestrator (RFC 9728/8414-aware) rather than the
// openid-client-based flow routes/auth.js/ssoClient.js use for the unrelated SSO login feature.
router.get('/:id/mcp/authorize', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).send('Miniserver not found');

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const provider = new mcpClient.LoxoneOAuthProvider({ miniserver, baseUrl, session: req.session, res, username: req.user.username });
  try {
    // On success this USUALLY calls provider.redirectToAuthorization() internally, which already
    // sends the response — but verified (via temporary tracing against a real Miniserver) that
    // auth() can ALSO resolve successfully without ever calling it: when the stored refresh token
    // is still good, it silently refreshes and returns instead of redirecting anywhere, since no
    // interactive browser round trip is actually needed. That path used to leave this request with
    // no response ever sent — the click would just hang forever with no error, no redirect,
    // nothing — since res.headersSent was the only signal telling the two cases apart, and nothing
    // here ever checked it. runMcpAuthFlowWithTimeout also bounds the whole thing at a fixed
    // ceiling — see its own comment for why that's a separate concern from the above.
    await mcpClient.runMcpAuthFlowWithTimeout(provider, { serverUrl: mcpClient.deriveMcpUrl(miniserver) });
    if (!res.headersSent) {
      await logSystemEvent(`"${req.user.username}" authorized the AI Assistant's MCP connection to Miniserver "${miniserver.name}".`);
      res.redirect(`/miniservers/${miniserver.id}/edit?authorized=1`);
    }
  } catch (err) {
    await db.prepare('UPDATE miniservers SET mcp_last_error = ? WHERE id = ?').run(err.message, miniserver.id);
    await logSystemEvent(`MCP authorization for Miniserver "${miniserver.name}" failed: ${err.message}`);
    if (!res.headersSent) res.redirect(`/miniservers/${miniserver.id}/edit`);
  }
}));

// "Start new login" — for when Re-authorize (above) is stuck silently repeating a failed token
// refresh instead of ever reaching a fresh browser login: the SDK's own auth() orchestrator
// opportunistically tries to refresh whatever's already stored before falling back to a full
// Dynamic-Client-Registration + redirect flow, and if the Miniserver has invalidated our refresh
// token server-side (revoked, already rotated by a concurrent request, etc.), that refresh attempt
// can error out on its own rather than ever reaching that fallback. Wiping every stored credential
// first — tokens AND the client registration — forces auth() to start completely from scratch.
router.get('/:id/mcp/restart-login', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).send('Miniserver not found');

  await db.prepare(
    `UPDATE miniservers SET mcp_access_token = NULL, mcp_refresh_token = NULL, mcp_token_expires_at = NULL,
     mcp_oauth_client_id = NULL, mcp_oauth_client_secret = NULL, mcp_authorized_by = NULL, mcp_last_error = NULL
     WHERE id = ?`
  ).run(miniserver.id);
  mcpClient.resetMcpClient(miniserver.id);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const provider = new mcpClient.LoxoneOAuthProvider({ miniserver, baseUrl, session: req.session, res, username: req.user.username });
  try {
    // Same "auth() can resolve without ever calling redirectToAuthorization(), and the whole thing
    // needs a hard ceiling regardless" reasoning as the plain Authorize route above.
    await mcpClient.runMcpAuthFlowWithTimeout(provider, { serverUrl: mcpClient.deriveMcpUrl(miniserver) });
    if (!res.headersSent) {
      await logSystemEvent(`"${req.user.username}" restarted the AI Assistant's MCP login for Miniserver "${miniserver.name}".`);
      res.redirect(`/miniservers/${miniserver.id}/edit`);
    }
  } catch (err) {
    await db.prepare('UPDATE miniservers SET mcp_last_error = ? WHERE id = ?').run(err.message, miniserver.id);
    await logSystemEvent(`MCP login restart for Miniserver "${miniserver.name}" failed: ${err.message}`);
    if (!res.headersSent) res.redirect(`/miniservers/${miniserver.id}/edit`);
  }
}));

router.get('/:id/mcp/callback', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).send('Miniserver not found');

  // Validated here, not left to auth()'s own code-exchange leg (which never re-checks state) —
  // same explicit check ssoClient.js's own callback route does for the unrelated SSO login flow.
  const pending = req.session.mcpOAuth;
  if (!pending || pending.miniserverId !== miniserver.id || pending.state !== req.query.state) {
    return res.status(400).send('Your authorization attempt expired or does not match this Miniserver — please try again from its edit page.');
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const provider = new mcpClient.LoxoneOAuthProvider({ miniserver, baseUrl, session: req.session, res, username: req.user.username });
  try {
    // Same hard ceiling as the other two MCP OAuth routes — this one's own unconditional
    // res.redirect() below would otherwise never run either, on the same kind of network-level
    // hang (see runMcpAuthFlowWithTimeout's own comment).
    await mcpClient.runMcpAuthFlowWithTimeout(provider, { serverUrl: mcpClient.deriveMcpUrl(miniserver), authorizationCode: req.query.code });
    delete req.session.mcpOAuth;
    mcpClient.resetMcpClient(miniserver.id);
    await logSystemEvent(`"${req.user.username}" authorized the AI Assistant's MCP connection to Miniserver "${miniserver.name}".`);
  } catch (err) {
    await db.prepare('UPDATE miniservers SET mcp_last_error = ? WHERE id = ?').run(err.message, miniserver.id);
    await logSystemEvent(`MCP authorization callback for Miniserver "${miniserver.name}" failed: ${err.message}`);
  }
  res.redirect(`/miniservers/${miniserver.id}/edit`);
}));

// Temporary, PR2-only review aid — dumps listTools()'s raw output so this MCP client + OAuth flow
// can be reviewed end-to-end against a real Miniserver before the chat UI (a later PR) exists to
// exercise it any other way. Remove once that UI lands.
router.get('/:id/mcp/debug-tools', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });
  try {
    const tools = await mcpClient.listTools(miniserver);
    res.json({ miniserverId: miniserver.id, allowWriteCommands: !!miniserver.ai_allow_write_commands, toolCount: tools.length, tools });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

router.post('/:id/check', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  // A prior auth rejection leaves its live connection object sitting inertly in 'auth_failed'
  // (see loxoneWebSocket.js) — ensureConnection() only creates a fresh one when none exists yet,
  // so testLiveConnection() below would otherwise just report that same stale rejection straight
  // back without actually retrying anything. "Test now" is exactly the explicit user action this
  // whole flow exists to wait for, so it always gets a real, fresh attempt.
  resetLiveConnection(miniserver.id);

  const [, detail, live, mcp] = await Promise.all([
    checkMiniserver(miniserver),
    runDetailedCheck(miniserver),
    testLiveConnection(miniserver),
    // Only when AI Assistant is actually enabled for this Miniserver — otherwise there's nothing
    // to test, and `null` here (vs. an object) is exactly what the edit page's own script uses to
    // decide whether to render this row at all.
    miniserver.ai_enabled ? mcpClient.testConnection(miniserver) : Promise.resolve(null),
  ]);
  // Also persisted here, not just from loxoneLog.js's own periodic poll (up to a minute behind) —
  // this is the same /dev/fsget/log/def.log probe, so a "Test now" click confirming the Logbook
  // is broken should make /logs/loxone's own blur+notice (see routes/logs.js) reflect that right
  // away rather than waiting for the next background cycle to catch up.
  await db.prepare('UPDATE miniservers SET logbook_error = ? WHERE id = ?').run(detail.logbook.ok ? null : detail.logbook.error, miniserver.id);
  const updated = await db.prepare('SELECT status, last_checked_at, firmware_version, device_monitor_status, miniserver_type FROM miniservers WHERE id = ?').get(miniserver.id);
  res.json({
    ...detail,
    live,
    mcp,
    status: updated.status,
    lastCheckedAt: updated.last_checked_at,
    firmwareVersion: updated.firmware_version,
    deviceMonitorStatus: updated.device_monitor_status,
    generationLabel: miniserverGenerationLabel(updated.miniserver_type),
  });
}));

// /jdev/sys/updatecheck — undocumented, found the same way as the diagnostics endpoints (grepped
// out of the Miniserver's own /admin JS bundle), tells the Miniserver to check its own update
// server. Returns 200 with an empty value over plain HTTP even when a newer release genuinely
// exists (verified against a real Miniserver) — there's no synchronous "yes/no, here's the
// version" answer available this way, so this only reports the Miniserver's own current
// version/update-channel (jdev/cfg/updatelevel — e.g. "Alpha" vs the stable channel) rather than
// claiming to know whether an update is actually available.
router.post('/:id/check-update', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    await fetchMiniserver(miniserver, '/jdev/sys/updatecheck', { timeoutMs: 8000 });
    const levelRes = await fetchMiniserver(miniserver, '/jdev/cfg/updatelevel', { timeoutMs: 8000 });
    const levelBody = levelRes.ok ? await levelRes.json() : null;
    const updateLevel = levelBody?.LL?.value || null;
    if (updateLevel) await db.prepare('UPDATE miniservers SET update_level = ? WHERE id = ?').run(updateLevel, miniserver.id);
    res.json({ updateLevel, checked: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// /dev/sys/updatetolatestrelease — undocumented, found the same way as the above. Triggers a REAL
// firmware update + reboot on this specific Miniserver; nothing about this route is a dry run.
async function triggerFirmwareUpdate(miniserver, username) {
  try {
    const result = await fetchMiniserver(miniserver, '/jdev/sys/updatetolatestrelease', { timeoutMs: 15000 });
    const body = result.ok ? await result.json() : null;
    await logSystemEvent(`"${username}" triggered a firmware update on Miniserver "${miniserver.name}" (${miniserver.host}).`);
    return { miniserverId: miniserver.id, name: miniserver.name, triggered: true, response: body?.LL?.value ?? null };
  } catch (err) {
    // A timeout/connection-drop here is expected once the Miniserver actually reboots into the
    // update — not necessarily a failure, just the point where it stops answering HTTP requests.
    await logSystemEvent(`"${username}" triggered a firmware update on Miniserver "${miniserver.name}" (${miniserver.host}) — connection ended before a response came back (expected if it's now rebooting): ${err.message}`);
    return { miniserverId: miniserver.id, name: miniserver.name, triggered: true, response: null, note: 'Connection ended before a response came back — expected if the Miniserver is now rebooting into the update.' };
  }
}

// Gated on the same edit permission as delete/update above, and every call is logged via
// logSystemEvent regardless of outcome — this is exactly the kind of action that needs an audit
// trail. The confirm dialog lives client-side (data-confirm, miniservers.ejs) since this route has
// no way to know a human deliberately clicked it vs. any other POST to this URL.
router.post('/:id/update-firmware', requirePermission('miniservers', 'edit'), asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.id);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  // Updating a Gateway also updates every Client pointed at it (see the Miniserver edit page) —
  // each is still its own physical box running its own firmware (unlike structure/Live Data, an
  // update is never "shared" the way the merged Loxone Config project is), so it needs its own
  // update command too, not just the Gateway's. Run in parallel, not one-by-one: a Client that's
  // slow to respond (or already rebooting) shouldn't hold up the others.
  const clients = await db.prepare('SELECT * FROM miniservers WHERE gateway_client_of = ?').all(miniserver.id);
  const [primaryResult, ...clientResults] = await Promise.all([
    triggerFirmwareUpdate(miniserver, req.user.username),
    ...clients.map((client) => triggerFirmwareUpdate(client, req.user.username)),
  ]);

  res.json({ ...primaryResult, clients: clientResults });
}));

module.exports = router;
