// LoxSuite's MCP server (src/mcp/): tokens and switches, the trace steps, plan → apply → undo with the role
// and write checks, and a real MCP round trip over HTTP with the SDK's own client.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { initTestDb, db } = require('./helpers/testDb');
const tokens = require('../src/mcp/tokens');
const { traceFrom } = require('../src/mcp/diagnose');
const { planChange, applyChange, undoChange } = require('../src/mcp/setup');

let adminUser; let viewerUser; let msId; let msNoUdpId;

async function role(name, isAdmin, perms = {}) {
  const id = await db.insertReturningId('INSERT INTO access_roles (name, is_admin) VALUES (?, ?)', [name, isAdmin ? 1 : 0]);
  for (const [area, [v, e]] of Object.entries(perms)) {
    await db.prepare('INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, ?, ?)').run(id, area, v ? 1 : 0, e ? 1 : 0);
  }
  return id;
}

async function user(name, roleId) {
  const id = await db.insertReturningId("INSERT INTO users (username, role_id, auth_provider) VALUES (?, ?, 'local')", [name, roleId]);
  return tokens.loadUser(id);
}

const ctxFor = (u, scopes = ['read', 'setup']) => ({ token: { id: null, name: 'test', scopes }, user: u });
const setWrite = (write) => tokens.saveSettings({ enabled: true, remote: false, write, minutes: 60 });

before(async () => {
  await initTestDb();
  adminUser = await user('mcp-admin', await role('MCP test admin', true));
  viewerUser = await user('mcp-viewer', await role('MCP test viewer', false, { loxone_to_mqtt: [1, 0], monitor: [1, 0], incoming: [1, 0] }));
  msId = await db.insertReturningId("INSERT INTO miniservers (name, host, http_port, udp_port, username, password) VALUES ('Woonhuis', '10.11.15.10', 80, 7000, 'u', 'p')", []);
  msNoUdpId = await db.insertReturningId("INSERT INTO miniservers (name, host, http_port, username, password) VALUES ('Garage', '10.11.15.11', 80, 'u', 'p')", []);
});

after(() => db.close());

test('tokens: only the hash is stored, revoked tokens and disabled users stop working, read is always in', async () => {
  const { token } = await tokens.createToken({ userId: adminUser.id, name: 'laptop', scopes: ['setup'] });
  assert.match(token, /^lxs_/);
  const row = await db.prepare('SELECT * FROM mcp_tokens WHERE name = ?').get('laptop');
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, tokens.hash(token));
  assert.equal(row.scopes, 'read,setup');
  const found = await tokens.verifyToken(token);
  assert.equal(found.user.username, 'mcp-admin');
  assert.deepEqual(found.token.scopes, ['read', 'setup']);
  assert.equal(await tokens.verifyToken('lxs_wrong'), null);
  await tokens.revokeToken(row.id);
  assert.equal(await tokens.verifyToken(token), null);

  const other = await tokens.createToken({ userId: viewerUser.id, name: 'viewer', scopes: [] });
  assert.deepEqual((await tokens.verifyToken(other.token)).token.scopes, ['read']);
  await db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), viewerUser.id);
  assert.equal(await tokens.verifyToken(other.token), null);
  await db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(viewerUser.id);
});

test('writing: off, on, and on for a while that runs out', () => {
  assert.equal(tokens.writeAllowed({ write: 'off' }), false);
  assert.equal(tokens.writeAllowed({ write: 'on' }), true);
  const now = Date.now();
  assert.equal(tokens.writeAllowed({ write: 'timed', writeUntil: new Date(now + 60000).toISOString() }, now), true);
  assert.equal(tokens.writeAllowed({ write: 'timed', writeUntil: new Date(now - 1).toISOString() }, now), false);
});

test('trace: the study plug whose commands reach LoxSuite but the plug listens on another broker', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const r = traceFrom({
    now,
    term: 'shellyplug-WERKWcd',
    denied: [],
    l2m: [{ id: 1, enabled: 1, mqtt_topic: 'shellies/shellyplug-WERKWcd/relay/0/command', transport: 'udp', miniserver_name: 'Woonhuis' }],
    m2l: [{ id: 2, enabled: 1, mqtt_topic: 'shellies/shellyplug-WERKWcd/relay/0', transport: 'udp', miniserver_id: 9, value_transform: 'bool_on_off' }],
    topics: [{ topic: 'shellies/shellyplug-WERKWcd/relay/0/command', value: 'on', lastSeen: '2026-11-23T09:59:00Z' }],
    clients: [],
    commands: [{ at: '2026-11-23T09:59:00Z', result: 'OK', topic: 'shellies/shellyplug-WERKWcd/relay/0/command', value: 'on' }],
    monitors: [],
    miniservers: [{ id: 9, name: 'Woonhuis', host: '10.11.15.10', udp_port: null, status: 'online' }],
    broker: { connected: true },
    udp: { on: true, port: 11885 },
  });
  const byName = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  assert.equal(byName['Loxone → MQTT mapping'].ok, true);
  assert.equal(byName['Commands from Loxone (24 h)'].ok, true);
  assert.equal(byName['Device connected to this broker'].ok, false);
  assert.match(byName['Device connected to this broker'].detail, /another broker/);
  assert.equal(byName['Device reports its state'].ok, false); // only the command topic was seen
  assert.equal(byName['MQTT → Loxone mapping #2'].ok, false);
  assert.match(byName['MQTT → Loxone mapping #2'].detail, /no UDP port/);
  assert.match(r.summary, /3 problem/);
});

test('trace: steps without permission are unknown, not failed', () => {
  const r = traceFrom({ term: 'abc', denied: ['loxone_to_mqtt', 'logs_mqtt', 'logs_loxone_commands', 'incoming', 'mqtt_to_loxone'], l2m: [], m2l: [], topics: [], clients: [], commands: [], monitors: [], miniservers: [], broker: { connected: true }, udp: { on: true, port: 11885 } });
  assert.deepEqual(r.steps.filter((s) => s.ok === false), []);
  assert.ok(r.steps.filter((s) => s.ok === null).length >= 5);
});

test('plan → apply → undo a Loxone → MQTT mapping; nothing changes before apply', async () => {
  await setWrite('on');
  const plan = await planChange(ctxFor(adminUser), { action: 'create_loxone_to_mqtt_mapping', params: { mqtt_topic: 'shellies/test-1/relay/0/command', miniserver_id: msId } });
  assert.ok(plan.plan_id);
  assert.equal(plan.preview.create.transport, 'udp');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM mappings_loxone_to_mqtt WHERE mqtt_topic = ?').get('shellies/test-1/relay/0/command').then((r) => Number(r.n)), 0);

  const applied = await applyChange(ctxFor(adminUser), { plan_id: plan.plan_id });
  assert.equal(applied.status, 'applied');
  const row = await db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE mqtt_topic = ?').get('shellies/test-1/relay/0/command');
  assert.equal(row.token, plan.preview.create.token); // the token shown in the preview is the one stored
  await assert.rejects(applyChange(ctxFor(adminUser), { plan_id: plan.plan_id }), /applied, not planned/);

  await undoChange(ctxFor(adminUser), { change_id: applied.change_id });
  assert.equal(await db.prepare('SELECT id FROM mappings_loxone_to_mqtt WHERE id = ?').get(row.id), undefined);
  const log = await db.prepare("SELECT line FROM log_entries WHERE source = 'system' AND line LIKE 'MCP %' ORDER BY id").all();
  assert.equal(log.length, 2);
});

test('apply refuses while writing is off, and without the setup scope or edit rights', async () => {
  await setWrite('off');
  const plan = await planChange(ctxFor(adminUser), { action: 'create_monitor', params: { source_type: 'mqtt', mqtt_topic: 'test/off/temperature' } });
  assert.match(plan.next, /switched off/);
  await assert.rejects(applyChange(ctxFor(adminUser), { plan_id: plan.plan_id }), /switched off/);
  await setWrite('on');
  await assert.rejects(planChange(ctxFor(adminUser, ['read']), { action: 'create_monitor', params: { source_type: 'mqtt', mqtt_topic: 'x/y' } }), /no "setup" scope/);
  await assert.rejects(planChange(ctxFor(viewerUser), { action: 'create_monitor', params: { source_type: 'mqtt', mqtt_topic: 'x/y' } }), /can't edit "monitor"/);
  await assert.rejects(planChange(ctxFor(viewerUser), { action: 'create_mqtt_to_loxone_mapping', params: { miniserver_id: msId, mqtt_topic: 'x/y' } }), /can't edit "mqtt_to_loxone"/);
});

test('MQTT → Loxone over UDP to a Miniserver without UDP port: warned in the preview', async () => {
  const plan = await planChange(ctxFor(adminUser), { action: 'create_mqtt_to_loxone_mapping', params: { miniserver_id: msNoUdpId, mqtt_topic: 'shellies/x/relay/0', value_transform: 'bool_on_off' } });
  assert.match(plan.preview.warning, /no UDP port/);
  assert.match(plan.preview.loxone_side, /MQTT:\\ishellies\/x\/relay\/0=\\i\\v/);
});

test('repair a chart: point a monitor at its new topic, undo refuses after a later edit unless forced', async () => {
  await setWrite('on');
  const monitorId = await db.insertReturningId("INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', 'Old', 'shellies/old-id/temperature', 0, ?, '{}')", [new Date().toISOString()]);
  const plan = await planChange(ctxFor(adminUser), { action: 'update_monitor', params: { id: monitorId, changes: { mqtt_topic: 'shellies/new-id/temperature', enabled: true } } });
  assert.deepEqual(plan.preview.before, { mqtt_topic: 'shellies/old-id/temperature', enabled: 0 });
  const done = await applyChange(ctxFor(adminUser), { plan_id: plan.plan_id });
  assert.equal((await db.prepare('SELECT mqtt_topic, enabled FROM monitors WHERE id = ?').get(monitorId)).enabled, 1);

  await db.prepare('UPDATE monitors SET mqtt_topic = ? WHERE id = ?').run('shellies/third/temperature', monitorId);
  await assert.rejects(undoChange(ctxFor(adminUser), { change_id: done.change_id }), /changed since/);
  await undoChange(ctxFor(adminUser), { change_id: done.change_id, force: true });
  const back = await db.prepare('SELECT mqtt_topic, enabled FROM monitors WHERE id = ?').get(monitorId);
  assert.equal(back.mqtt_topic, 'shellies/old-id/temperature');
  assert.equal(back.enabled, 0);
});

test('build a dashboard in one go, and undo removes the dashboard, its panels and the monitors made for it', async () => {
  await setWrite('on');
  const existing = await db.insertReturningId("INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', 'Kept', 'room/kept', 1, ?, '{}')", [new Date().toISOString()]);
  const plan = await planChange(ctxFor(adminUser), { action: 'build_dashboard', params: { name: 'Werkkamer', layout: 'both', items: [{ mqtt_topic: 'room/kept' }, { mqtt_topic: 'room/new', label: 'Nieuw' }] } });
  assert.equal(plan.preview.new_monitors.length, 1);
  assert.equal(plan.preview.panels, 3);
  const done = await applyChange(ctxFor(adminUser), { plan_id: plan.plan_id });
  const dash = await db.prepare('SELECT id FROM custom_dashboards WHERE name = ?').get('Werkkamer');
  const panels = await db.prepare('SELECT id, panel_type FROM dashboard_panels WHERE dashboard_id = ?').all(dash.id);
  assert.deepEqual(panels.map((p) => p.panel_type).sort(), ['chart', 'value', 'value']);
  const created = await db.prepare('SELECT id FROM monitors WHERE mqtt_topic = ?').get('room/new');
  assert.ok(created);

  await undoChange(ctxFor(adminUser), { change_id: done.change_id });
  assert.equal(await db.prepare('SELECT id FROM custom_dashboards WHERE id = ?').get(dash.id), undefined);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM dashboard_panels WHERE dashboard_id = ?').get(dash.id)).n), 0);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM dashboard_panel_monitors WHERE monitor_id IN (?, ?)').get(existing, created.id)).n), 0);
  assert.equal(await db.prepare('SELECT id FROM monitors WHERE id = ?').get(created.id), undefined);
  assert.ok(await db.prepare('SELECT id FROM monitors WHERE id = ?').get(existing)); // reused, so kept
});

test('over HTTP: the SDK client lists the tools a token may use and calls them; bad token 401, switched off 403', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createMcpRouter } = require('../src/mcp/server');
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter());
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = new URL(`http://127.0.0.1:${srv.address().port}/mcp`);
  try {
    await tokens.saveSettings({ enabled: true, remote: false, write: 'off' });
    const readOnly = await tokens.createToken({ userId: viewerUser.id, name: 'http-viewer', scopes: ['read'] });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${readOnly.token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('trace') && names.includes('overview') && names.includes('changes'));
    assert.ok(!names.includes('plan_change'));
    const ov = await client.callTool({ name: 'overview', arguments: {} });
    assert.match(ov.content[0].text, /loxsuite/);
    assert.doesNotMatch(ov.content[0].text, /miniservers/); // the viewer can't view Miniservers
    const denied = await client.callTool({ name: 'miniservers', arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /No permission/);
    const tr = await client.callTool({ name: 'trace', arguments: { term: 'shellyplug-none' } });
    assert.ok(JSON.parse(tr.content[0].text).steps.length);
    await client.close();

    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer lxs_nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(bad.status, 401);
    await tokens.saveSettings({ enabled: false, remote: false, write: 'off' });
    const off = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readOnly.token}` }, body: '{}' });
    assert.equal(off.status, 403);
  } finally {
    srv.close();
  }
});
