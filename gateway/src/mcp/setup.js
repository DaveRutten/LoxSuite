// Write side of LoxSuite's MCP server (token scope 'setup'): mappings, monitors (the series behind charts)
// and dashboards. Every change goes in two steps: plan_change validates and returns a preview (stored as an
// mcp_changes row, status 'planned'), apply_change carries it out — only while writing is switched on
// (Administration → MCP) — and stores how to put it back; undo_change does that, refusing when the row
// was changed since. Both steps check the token user's role again. Every apply/undo lands in the System log.
const { nanoid } = require('nanoid');
const db = require('../db');
const { logSystemEvent } = require('../auditLog');
const { canEdit, settings, writeAllowed } = require('./tokens');
const { ToolError, miniserverRows } = require('./diagnose');

const PLAN_MINUTES = 30;
const L2M_TRANSFORMS = ['passthrough', 'dimmer', 'translation_table', 'shelly_rgbw'];
const RGBW_MODES = ['white', 'rgb', 'rgb-percent', 'tunablew'];
const M2L_TRANSFORMS = ['passthrough', 'bool_on_off', 'json_path', 'translation_table'];
const PANEL_TYPES = ['value', 'chart', 'gauge', 'table', 'stat_delta', 'state_bar'];

// Which columns an assistant may change, per table; undo only ever touches these too.
const TABLES = {
  mappings_loxone_to_mqtt: { area: 'loxone_to_mqtt', fields: ['enabled', 'miniserver_id', 'mqtt_topic', 'transport', 'qos', 'retain', 'value_transform', 'transform_arg'] },
  mappings_mqtt_to_loxone: { area: 'mqtt_to_loxone', fields: ['enabled', 'miniserver_id', 'mqtt_topic', 'transport', 'target', 'value_transform', 'transform_arg', 'min_interval_ms'] },
  monitors: { area: 'monitor', fields: ['enabled', 'label', 'mqtt_topic', 'loxone_uuid', 'poll_interval_ms'] },
  custom_dashboards: { area: null, fields: ['name'] },
  dashboard_panels: { area: null, fields: ['title', 'panel_type', 'range'] },
};
const DIRECTION_TABLE = { loxone_to_mqtt: 'mappings_loxone_to_mqtt', mqtt_to_loxone: 'mappings_mqtt_to_loxone' };

function needEdit(user, area) {
  if (area && !canEdit(user, area)) throw new ToolError(`No permission: this token's user can't edit "${area}" (Access Roles).`);
}

const text = (v) => String(v ?? '').trim();
const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row ? row[f] ?? null : null]));
const same = (a, b) => String(a ?? '') === String(b ?? '');

async function miniserverOrThrow(id, required) {
  if (id === undefined || id === null || id === '') {
    if (required) throw new ToolError('miniserver_id is required (see the miniservers tool).');
    return null;
  }
  const ms = (await miniserverRows()).find((m) => m.id === Number(id));
  if (!ms) throw new ToolError(`Miniserver ${id} not found.`);
  return ms;
}

function topicOrThrow(topic, { wildcards }) {
  const t = text(topic);
  if (!t) throw new ToolError('mqtt_topic is required.');
  if (!wildcards && /[+#]/.test(t)) throw new ToolError('Loxone → MQTT publishes to one topic: no + or # wildcards.');
  return t;
}

// ---- actions: validate(user, params) -> { summary, preview, row?... }, apply(tx, plan, user) -> undo list ----

const ACTIONS = {
  create_loxone_to_mqtt_mapping: {
    description: 'Loxone → MQTT: a Virtual Output command from Loxone gets published to an MQTT topic. params: mqtt_topic, transport udp|http (default udp), miniserver_id (optional), qos 0-2, retain, value_transform passthrough|dimmer|shelly_rgbw|translation_table, transform_arg (shelly_rgbw: white|rgb|rgb-percent|tunablew).',
    area: 'loxone_to_mqtt',
    async validate(user, p) {
      const ms = await miniserverOrThrow(p.miniserver_id, false);
      const transform = L2M_TRANSFORMS.includes(p.value_transform) ? p.value_transform : 'passthrough';
      const row = {
        miniserver_id: ms ? ms.id : null,
        token: text(p.token) || nanoid(16),
        mqtt_topic: topicOrThrow(p.mqtt_topic, { wildcards: false }),
        qos: Math.min(2, Math.max(0, Number(p.qos) || 0)),
        retain: p.retain ? 1 : 0,
        transport: p.transport === 'http' ? 'http' : 'udp',
        value_transform: transform,
        transform_arg: transform === 'shelly_rgbw' && RGBW_MODES.includes(p.transform_arg) ? p.transform_arg : null,
      };
      const existing = await db.prepare('SELECT id, enabled FROM mappings_loxone_to_mqtt WHERE mqtt_topic = ?').all(row.mqtt_topic);
      const port = Number(process.env.LOXONE_UDP_PORT) || 11885;
      return {
        summary: `New Loxone → MQTT mapping for ${row.mqtt_topic} (${row.transport})`,
        row,
        preview: {
          create: { table: 'mappings_loxone_to_mqtt', ...row },
          loxone_side: row.transport === 'udp'
            ? `Virtual Output to this LoxSuite on UDP port ${port}; command "${row.mqtt_topic}=<v>" (or "${row.token}=<v>")`
            : `Virtual Output calling /api/loxone-in/${row.token}?value=<v>`,
          ...(existing.length ? { warning: `There already ${existing.length === 1 ? 'is a mapping' : `are ${existing.length} mappings`} for this topic (ids ${existing.map((e) => e.id).join(', ')}).` } : {}),
        },
      };
    },
    async apply(tx, plan) {
      const r = plan.row;
      const id = await tx.insertReturningId(
        'INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, qos, retain, transport, value_transform, transform_arg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [r.miniserver_id, r.token, r.mqtt_topic, r.qos, r.retain, r.transport, r.value_transform, r.transform_arg]
      );
      return [{ op: 'delete', table: 'mappings_loxone_to_mqtt', id, after: pick({ ...r, enabled: 1 }, TABLES.mappings_loxone_to_mqtt.fields) }];
    },
    reload: 'mappings',
  },

  create_mqtt_to_loxone_mapping: {
    description: 'MQTT → Loxone: a topic\'s value is sent to a Miniserver. params: miniserver_id, mqtt_topic (+/# allowed), transport udp|http (default udp: "MQTT:<topic>=<value>" to the Miniserver\'s UDP port), target (http: the Virtual Input name), value_transform passthrough|bool_on_off|json_path|translation_table, transform_arg (json_path: the path), min_interval_ms.',
    area: 'mqtt_to_loxone',
    async validate(user, p) {
      const ms = await miniserverOrThrow(p.miniserver_id, true);
      const transport = p.transport === 'http' ? 'http' : 'udp';
      const transform = M2L_TRANSFORMS.includes(p.value_transform) ? p.value_transform : 'passthrough';
      if (transform === 'json_path' && !text(p.transform_arg)) throw new ToolError('json_path needs transform_arg (the path, e.g. "temperature" or "meters[0].power").');
      if (transport === 'http' && !text(p.target)) throw new ToolError('An HTTP mapping needs target: the name of the Virtual Input in Loxone.');
      const row = {
        miniserver_id: ms.id,
        mqtt_topic: topicOrThrow(p.mqtt_topic, { wildcards: true }),
        transport,
        target: text(p.target) || null,
        value_transform: transform,
        transform_arg: text(p.transform_arg) || null,
        min_interval_ms: Math.max(0, Number(p.min_interval_ms) || 0),
      };
      const { udpTopicFor, commandRecognitionString } = require('../loxone');
      return {
        summary: `New MQTT → Loxone mapping ${row.mqtt_topic} → ${ms.name} (${transport})`,
        row,
        preview: {
          create: { table: 'mappings_mqtt_to_loxone', ...row },
          loxone_side: transport === 'udp'
            ? `Virtual UDP Input on ${ms.name}, port ${ms.udp_port || '(not set!)'}, command recognition ${/[+#]/.test(row.mqtt_topic) ? 'per actual topic' : commandRecognitionString(udpTopicFor(row, row.mqtt_topic))}`
            : `Virtual Input "${row.target}" on ${ms.name}`,
          ...(transport === 'udp' && !ms.udp_port ? { warning: `${ms.name} has no UDP port set in LoxSuite: nothing will be sent until it is (Miniservers page).` } : {}),
        },
      };
    },
    async apply(tx, plan) {
      const r = plan.row;
      const id = await tx.insertReturningId(
        'INSERT INTO mappings_mqtt_to_loxone (miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [r.miniserver_id, r.mqtt_topic, r.transport, r.target, r.value_transform, r.transform_arg, r.min_interval_ms]
      );
      return [{ op: 'delete', table: 'mappings_mqtt_to_loxone', id, after: pick({ ...r, enabled: 1 }, TABLES.mappings_mqtt_to_loxone.fields) }];
    },
    reload: 'mappings',
  },

  update_mapping: {
    description: 'Change or switch a mapping on/off. params: direction loxone_to_mqtt|mqtt_to_loxone, id, changes { enabled, mqtt_topic, transport, target, value_transform, transform_arg, qos, retain, miniserver_id, min_interval_ms }.',
    areaFrom: (p) => TABLES[DIRECTION_TABLE[p.direction]]?.area,
    async validate(user, p) {
      const table = DIRECTION_TABLE[p.direction];
      if (!table) throw new ToolError('direction must be loxone_to_mqtt or mqtt_to_loxone.');
      return updateRow(table, p.id, p.changes, (field, value) => {
        if (field === 'enabled' || field === 'retain') return value ? 1 : 0;
        if (field === 'transport') { if (!['udp', 'http'].includes(value)) throw new ToolError('transport must be udp or http.'); return value; }
        if (field === 'value_transform') {
          const list = table === 'mappings_loxone_to_mqtt' ? L2M_TRANSFORMS : M2L_TRANSFORMS;
          if (!list.includes(value)) throw new ToolError(`value_transform must be one of ${list.join(', ')}.`);
          return value;
        }
        if (field === 'mqtt_topic') return topicOrThrow(value, { wildcards: table === 'mappings_mqtt_to_loxone' });
        if (field === 'qos') return Math.min(2, Math.max(0, Number(value) || 0));
        if (field === 'min_interval_ms') return Math.max(0, Number(value) || 0);
        if (field === 'miniserver_id') return value === null ? null : Number(value);
        return value === '' ? null : value;
      });
    },
    apply: applyUpdate,
    reload: 'mappings',
  },

  create_monitor: {
    description: 'Start recording a value (the series behind a chart). params: source_type mqtt|loxone; mqtt: mqtt_topic; loxone: miniserver_id + loxone_uuid (from loxone_find); label; poll_interval_ms (loxone, default 10000).',
    area: 'monitor',
    async validate(user, p) {
      const label = text(p.label);
      if (p.source_type === 'loxone') {
        const ms = await miniserverOrThrow(p.miniserver_id, true);
        const uuid = text(p.loxone_uuid);
        if (!uuid) throw new ToolError('loxone_uuid is required (see loxone_find).');
        const dup = await db.prepare("SELECT id, label FROM monitors WHERE source_type = 'loxone' AND miniserver_id = ? AND loxone_uuid = ?").get(ms.id, uuid);
        if (dup) throw new ToolError(`Already monitored as #${dup.id} "${dup.label}".`);
        const row = { source_type: 'loxone', label: label || uuid, mqtt_topic: null, miniserver_id: ms.id, loxone_uuid: uuid, poll_interval_ms: Math.max(1000, Number(p.poll_interval_ms) || 10000) };
        return { summary: `New monitor "${row.label}" (Loxone ${ms.name})`, row, preview: { create: { table: 'monitors', ...row } } };
      }
      const topic = topicOrThrow(p.mqtt_topic, { wildcards: false });
      const dup = await db.prepare("SELECT id, label FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
      if (dup) throw new ToolError(`"${topic}" is already monitored as #${dup.id} "${dup.label}".`);
      const { humanizeTopic } = require('../topicName');
      const row = { source_type: 'mqtt', label: label || humanizeTopic(topic), mqtt_topic: topic, miniserver_id: null, loxone_uuid: null, poll_interval_ms: 10000 };
      return { summary: `New monitor "${row.label}" (${topic})`, row, preview: { create: { table: 'monitors', ...row } } };
    },
    async apply(tx, plan) {
      const id = await insertMonitor(tx, plan.row);
      return [{ op: 'delete', table: 'monitors', id, after: pick({ ...plan.row, enabled: 1 }, TABLES.monitors.fields) }];
    },
    reload: 'monitors',
  },

  update_monitor: {
    description: 'Repair a chart\'s series: switch a monitor on/off, rename it, point it at the right topic (e.g. after a device got a new id) or Loxone uuid. params: id, changes { enabled, label, mqtt_topic, loxone_uuid, poll_interval_ms }. Its history stays.',
    area: 'monitor',
    async validate(user, p) {
      const current = await db.prepare('SELECT * FROM monitors WHERE id = ?').get(Number(p.id));
      if (!current) throw new ToolError(`Monitor ${p.id} not found.`);
      return updateRow('monitors', p.id, p.changes, (field, value) => {
        if (field === 'enabled') return value ? 1 : 0;
        if (field === 'mqtt_topic') { if (current.source_type !== 'mqtt') throw new ToolError('Only an MQTT monitor has a topic.'); return topicOrThrow(value, { wildcards: false }); }
        if (field === 'loxone_uuid') { if (current.source_type !== 'loxone') throw new ToolError('Only a Loxone monitor has a uuid.'); return text(value); }
        if (field === 'poll_interval_ms') return Math.max(1000, Number(value) || 10000);
        if (field === 'label') { if (!text(value)) throw new ToolError('label can\'t be empty.'); return text(value); }
        return value;
      });
    },
    apply: applyUpdate,
    reload: 'monitors',
  },

  create_dashboard: {
    description: 'A new personal dashboard for the token\'s user. params: name.',
    area: null,
    async validate(user, p) {
      const name = text(p.name);
      if (!name) throw new ToolError('name is required.');
      return { summary: `New dashboard "${name}"`, row: { name }, preview: { create: { table: 'custom_dashboards', name, owner: user.username } } };
    },
    async apply(tx, plan, user) {
      const id = await insertDashboard(tx, user.id, plan.row.name);
      return [{ op: 'delete', table: 'custom_dashboards', id, after: { name: plan.row.name } }];
    },
  },

  add_panel: {
    description: 'Add a panel to a dashboard (own, or the shared Home with dashboard edit rights). params: dashboard_id, panel_type value|chart|gauge|table|stat_delta|state_bar, title, monitor_ids [...], range (e.g. 24h, 7d), options (chart: chart_type line|bar_compare, unit_chart, fill_area, stepped_line before|after|middle; gauge: gauge_min, gauge_max, unit).',
    area: null,
    async validate(user, p) {
      const dashboard = await dashboardForEdit(user, p.dashboard_id);
      const panel = await panelFrom(p.panel_type, p.monitor_ids, p.title, p.range, p.options);
      return { summary: `New ${panel.panel_type} panel "${panel.title || ''}" on "${dashboard.name}"`, row: { dashboard_id: dashboard.id, ...panel }, preview: { create: { table: 'dashboard_panels', dashboard: dashboard.name, ...panel } } };
    },
    async apply(tx, plan) {
      const id = await insertPanel(tx, plan.row.dashboard_id, plan.row);
      return [{ op: 'delete', table: 'dashboard_panels', id, after: { title: plan.row.title, panel_type: plan.row.panel_type, range: plan.row.range } }];
    },
  },

  build_dashboard: {
    description: 'Build a whole dashboard in one go: a new dashboard, monitors for values not recorded yet, and panels. params: name, items [{ mqtt_topic, label? } | { miniserver_id, loxone_uuid, label? }], layout value (one value panel each, default) | chart (one line chart with all items, max 8 per chart) | both, range (default 24h).',
    area: null,
    async validate(user, p) {
      const name = text(p.name);
      if (!name) throw new ToolError('name is required.');
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) throw new ToolError('items is required: MQTT topics and/or Loxone states (miniserver_id + loxone_uuid).');
      if (items.length > 40) throw new ToolError('At most 40 items per dashboard.');
      const layout = ['value', 'chart', 'both'].includes(p.layout) ? p.layout : 'value';
      const { humanizeTopic } = require('../topicName');
      const resolved = [];
      for (const it of items) {
        if (it.mqtt_topic) {
          const topic = topicOrThrow(it.mqtt_topic, { wildcards: false });
          const m = await db.prepare("SELECT id, label FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
          resolved.push({ existing_monitor_id: m ? m.id : null, label: text(it.label) || (m ? m.label : humanizeTopic(topic)), row: m ? null : { source_type: 'mqtt', label: text(it.label) || humanizeTopic(topic), mqtt_topic: topic, miniserver_id: null, loxone_uuid: null, poll_interval_ms: 10000 } });
        } else if (it.loxone_uuid) {
          const ms = await miniserverOrThrow(it.miniserver_id, true);
          const m = await db.prepare("SELECT id, label FROM monitors WHERE source_type = 'loxone' AND miniserver_id = ? AND loxone_uuid = ?").get(ms.id, text(it.loxone_uuid));
          resolved.push({ existing_monitor_id: m ? m.id : null, label: text(it.label) || (m ? m.label : text(it.loxone_uuid)), row: m ? null : { source_type: 'loxone', label: text(it.label) || text(it.loxone_uuid), mqtt_topic: null, miniserver_id: ms.id, loxone_uuid: text(it.loxone_uuid), poll_interval_ms: 10000 } });
        } else throw new ToolError('Every item needs mqtt_topic, or miniserver_id + loxone_uuid.');
      }
      const range = text(p.range) || '24h';
      return {
        summary: `New dashboard "${name}" with ${resolved.length} item(s) (${layout})`,
        row: { name, layout, range, items: resolved },
        preview: {
          create: { table: 'custom_dashboards', name, owner: user.username },
          new_monitors: resolved.filter((r) => r.row).map((r) => r.row),
          reused_monitors: resolved.filter((r) => r.existing_monitor_id).map((r) => ({ id: r.existing_monitor_id, label: r.label })),
          panels: (layout !== 'chart' ? resolved.length : 0) + (layout !== 'value' ? Math.ceil(resolved.length / 8) : 0),
        },
      };
    },
    async apply(tx, plan, user) {
      const undo = [];
      const dashboardId = await insertDashboard(tx, user.id, plan.row.name);
      const ids = [];
      for (const it of plan.row.items) {
        if (it.existing_monitor_id) { ids.push({ id: it.existing_monitor_id, label: it.label }); continue; }
        const id = await insertMonitor(tx, it.row);
        undo.push({ op: 'delete', table: 'monitors', id, after: pick({ ...it.row, enabled: 1 }, TABLES.monitors.fields) });
        ids.push({ id, label: it.label });
      }
      if (plan.row.layout !== 'chart') {
        for (const m of ids) await insertPanel(tx, dashboardId, { panel_type: 'value', title: m.label, range: plan.row.range, config: { layout: 'stacked' }, monitor_ids: [m.id] });
      }
      if (plan.row.layout !== 'value') {
        const { buildConfig } = require('../routes/dashboards');
        for (let i = 0; i < ids.length; i += 8) {
          const chunk = ids.slice(i, i + 8);
          await insertPanel(tx, dashboardId, { panel_type: 'chart', title: ids.length > 8 ? `${plan.row.name} ${i / 8 + 1}` : plan.row.name, range: plan.row.range, config: buildConfig('chart', {}), monitor_ids: chunk.map((m) => m.id), col_span: 12, row_span: 4 });
        }
      }
      // Dashboard first on undo (its panels go with it), then the monitors made for it.
      return [{ op: 'delete', table: 'custom_dashboards', id: dashboardId, after: { name: plan.row.name } }, ...undo];
    },
    reload: 'monitors',
  },
};

// ---- shared helpers -----------------------------------------------------------------------------

async function updateRow(table, id, changes, normalize) {
  const spec = TABLES[table];
  const current = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!current) throw new ToolError(`${table} row ${id} not found.`);
  const entries = Object.entries(changes || {});
  if (!entries.length) throw new ToolError('changes is empty.');
  const after = {};
  for (const [field, value] of entries) {
    if (!spec.fields.includes(field)) throw new ToolError(`"${field}" can't be changed here. Allowed: ${spec.fields.join(', ')}.`);
    after[field] = normalize(field, value);
  }
  if (after.miniserver_id) await miniserverOrThrow(after.miniserver_id, true);
  const before = pick(current, Object.keys(after));
  const changed = Object.keys(after).filter((f) => !same(before[f], after[f]));
  if (!changed.length) throw new ToolError('Nothing would change: the row already has these values.');
  return {
    summary: `Change ${table} #${current.id}: ${changed.map((f) => `${f} ${before[f] ?? '(none)'} → ${after[f] ?? '(none)'}`).join(', ')}`,
    row: { table, id: current.id, before, after },
    preview: { table, id: current.id, label: current.label || current.mqtt_topic || current.name, before, after },
  };
}

async function applyUpdate(tx, plan) {
  const { table, id, before, after } = plan.row;
  const now = await tx.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!now) throw new ToolError(`${table} row ${id} no longer exists.`);
  const moved = Object.keys(before).filter((f) => !same(now[f], before[f]));
  if (moved.length) throw new ToolError(`Changed since the plan was made (${moved.join(', ')}): make a new plan.`);
  const fields = Object.keys(after);
  await tx.prepare(`UPDATE ${table} SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((f) => after[f]), id);
  return [{ op: 'restore', table, id, before, after }];
}

async function insertMonitor(tx, r) {
  return tx.insertReturningId(
    "INSERT INTO monitors (source_type, label, mqtt_topic, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at, config) VALUES (?, ?, ?, ?, ?, ?, 1, ?, '{}')",
    [r.source_type, r.label, r.mqtt_topic, r.miniserver_id, r.loxone_uuid, r.poll_interval_ms, new Date().toISOString()]
  );
}

async function insertDashboard(tx, userId, name) {
  const maxPos = (await tx.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM custom_dashboards WHERE user_id = ?').get(userId)).m;
  return tx.insertReturningId('INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (?, ?, ?, ?)', [userId, name, maxPos + 1, new Date().toISOString()]);
}

async function insertPanel(tx, dashboardId, p) {
  const maxPos = (await tx.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(dashboardId)).m;
  const id = await tx.insertReturningId(
    'INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position, col_span, row_span) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [dashboardId, p.panel_type, p.title || null, p.range || '24h', JSON.stringify(p.config || {}), maxPos + 1, p.col_span || 4, p.row_span || 3]
  );
  for (let i = 0; i < p.monitor_ids.length; i++) {
    await tx.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(id, p.monitor_ids[i], i);
  }
  return id;
}

async function dashboardForEdit(user, id) {
  const d = await db.prepare('SELECT * FROM custom_dashboards WHERE id = ?').get(Number(id));
  if (!d) throw new ToolError(`Dashboard ${id} not found.`);
  if (d.user_id === user.id) return d;
  if (d.user_id === null && canEdit(user, 'dashboard')) return d;
  const share = await db.prepare('SELECT can_edit FROM dashboard_shares WHERE dashboard_id = ? AND user_id = ?').get(d.id, user.id);
  if (share && share.can_edit) return d;
  throw new ToolError('This user can\'t change that dashboard (only their own, one shared with edit rights, or the shared Home with dashboard edit).');
}

async function panelFrom(type, monitorIds, title, range, options) {
  if (!PANEL_TYPES.includes(type)) throw new ToolError(`panel_type must be one of ${PANEL_TYPES.join(', ')}.`);
  const { buildConfig, SINGLE_MONITOR_TYPES } = require('../routes/dashboards');
  let ids = (Array.isArray(monitorIds) ? monitorIds : [monitorIds]).map(Number).filter(Number.isInteger);
  if (SINGLE_MONITOR_TYPES.includes(type)) ids = ids.slice(0, 1);
  if (!ids.length) throw new ToolError('monitor_ids is required (see chart_health or create_monitor).');
  const found = await db.prepare(`SELECT id FROM monitors WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids);
  const missing = ids.filter((i) => !found.some((f) => f.id === i));
  if (missing.length) throw new ToolError(`Monitor(s) not found: ${missing.join(', ')}.`);
  const { resolveRange } = require('../routes/monitor');
  return { panel_type: type, title: text(title) || null, range: resolveRange(text(range) || '24h'), config: buildConfig(type, options || {}), monitor_ids: ids };
}

// SQLite here runs without enforced foreign keys, so the rows that hang off a deleted row go explicitly.
const CHILDREN = {
  monitors: ['DELETE FROM monitor_history WHERE monitor_id = ?', 'DELETE FROM dashboard_panel_monitors WHERE monitor_id = ?'],
  dashboard_panels: ['DELETE FROM dashboard_panel_monitors WHERE panel_id = ?'],
  custom_dashboards: [
    'DELETE FROM dashboard_panel_monitors WHERE panel_id IN (SELECT id FROM dashboard_panels WHERE dashboard_id = ?)',
    'DELETE FROM dashboard_panels WHERE dashboard_id = ?',
    'DELETE FROM dashboard_favorites WHERE dashboard_id = ?',
    'DELETE FROM dashboard_shares WHERE dashboard_id = ?',
    'DELETE FROM dashboard_role_shares WHERE dashboard_id = ?',
  ],
  mappings_mqtt_to_loxone: ['DELETE FROM mapping_translations WHERE mapping_id = ?'],
  mappings_loxone_to_mqtt: ['DELETE FROM loxone_mapping_translations WHERE mapping_id = ?'],
};

async function deleteRow(tx, table, id) {
  for (const sql of CHILDREN[table] || []) await tx.prepare(sql).run(id);
  await tx.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

async function reload(kind) {
  if (kind === 'mappings') await require('../mqttClient').reloadMappings();
  if (kind === 'monitors') await require('../monitorCollector').reloadMqttMonitors();
}

// ---- plan / apply / undo -----------------------------------------------------------------------

function needSetup(ctx) {
  if (!ctx.token.scopes.includes('setup')) throw new ToolError('This token has no "setup" scope: it can only read. Make a token with setup in Administration → MCP.');
}

function areaOf(action, params) {
  return action.areaFrom ? action.areaFrom(params) : action.area;
}

async function planChange(ctx, { action, params } = {}) {
  needSetup(ctx);
  const a = ACTIONS[action];
  if (!a) throw new ToolError(`Unknown action "${action}". Known: ${Object.keys(ACTIONS).join(', ')}.`);
  const p = params || {};
  needEdit(ctx.user, areaOf(a, p));
  const plan = await a.validate(ctx.user, p);
  const id = await db.insertReturningId(
    "INSERT INTO mcp_changes (token_id, user_id, action, summary, params_json, preview_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)",
    [ctx.token.id, ctx.user.id, action, plan.summary, JSON.stringify({ params: p, row: plan.row }), JSON.stringify(plan.preview), new Date().toISOString()]
  );
  const s = await settings();
  return {
    plan_id: id,
    summary: plan.summary,
    preview: plan.preview,
    expires_in_minutes: PLAN_MINUTES,
    next: writeAllowed(s)
      ? 'Show the preview to the user; after their OK call apply_change with this plan_id.'
      : 'Writing is switched off in LoxSuite (Administration → MCP). The user can switch it on (or on for an hour), then call apply_change with this plan_id.',
  };
}

async function loadChange(id, userId, isAdmin) {
  const c = await db.prepare('SELECT * FROM mcp_changes WHERE id = ?').get(Number(id));
  if (!c || (!isAdmin && c.user_id !== userId)) throw new ToolError(`Change ${id} not found.`);
  return c;
}

async function applyChange(ctx, { plan_id } = {}) {
  needSetup(ctx);
  if (!writeAllowed(await settings())) throw new ToolError('Writing is switched off in LoxSuite (Administration → MCP). Ask the user to switch it on.');
  const c = await loadChange(plan_id, ctx.user.id, false);
  if (c.status !== 'planned') throw new ToolError(`Change ${c.id} is ${c.status}, not planned.`);
  if (Date.now() - Date.parse(c.created_at) > PLAN_MINUTES * 60000) {
    await db.prepare("UPDATE mcp_changes SET status = 'expired' WHERE id = ?").run(c.id);
    throw new ToolError('This plan expired: make a new one with plan_change.');
  }
  const a = ACTIONS[c.action];
  const stored = JSON.parse(c.params_json);
  needEdit(ctx.user, areaOf(a, stored.params));
  let undo;
  await db.transaction(async (tx) => { undo = await a.apply(tx, { row: stored.row, params: stored.params }, ctx.user); });
  await db.prepare("UPDATE mcp_changes SET status = 'applied', undo_json = ?, applied_at = ? WHERE id = ?").run(JSON.stringify(undo), new Date().toISOString(), c.id);
  if (a.reload) await reload(a.reload);
  await logSystemEvent(`MCP "${ctx.token.name}" (${ctx.user.username}) applied change #${c.id}: ${c.summary}`);
  return { change_id: c.id, status: 'applied', summary: c.summary, created: undo.filter((u) => u.op === 'delete').map((u) => ({ table: u.table, id: u.id })), undo: `undo_change ${c.id} puts it back.` };
}

// fromAdmin: the Undo button in Administration → MCP (an admin by hand, not an assistant), so not bound to the write switch.
async function undoChange(ctx, { change_id, force } = {}, { fromAdmin = false } = {}) {
  needSetup(ctx);
  if (!fromAdmin && !writeAllowed(await settings())) throw new ToolError('Writing is switched off in LoxSuite (Administration → MCP). Ask the user to switch it on.');
  const c = await loadChange(change_id, ctx.user.id, ctx.user.isAdmin);
  if (c.status !== 'applied') throw new ToolError(`Change ${c.id} is ${c.status}: only an applied change can be undone.`);
  const steps = JSON.parse(c.undo_json || '[]');
  for (const s of steps) needEdit(ctx.user, TABLES[s.table]?.area);
  const reloads = new Set();
  await db.transaction(async (tx) => {
    for (const s of steps) {
      const spec = TABLES[s.table];
      if (!spec) throw new ToolError(`Unknown table ${s.table}.`);
      const now = await tx.prepare(`SELECT * FROM ${s.table} WHERE id = ?`).get(s.id);
      if (!now) continue; // already gone
      const moved = Object.keys(s.after || {}).filter((f) => !same(now[f], s.after[f]));
      if (moved.length && !force) throw new ToolError(`${s.table} #${s.id} was changed since (${moved.join(', ')}). Undo with force: true to put it back anyway.`);
      if (s.op === 'delete') await deleteRow(tx, s.table, s.id);
      if (s.op === 'restore') {
        const fields = Object.keys(s.before).filter((f) => spec.fields.includes(f));
        await tx.prepare(`UPDATE ${s.table} SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((f) => s.before[f]), s.id);
      }
      if (s.table.startsWith('mappings_')) reloads.add('mappings');
      if (s.table === 'monitors') reloads.add('monitors');
    }
  });
  await db.prepare("UPDATE mcp_changes SET status = 'undone', undone_at = ? WHERE id = ?").run(new Date().toISOString(), c.id);
  for (const r of reloads) await reload(r);
  await logSystemEvent(`MCP "${ctx.token.name}" (${ctx.user.username}) undid change #${c.id}: ${c.summary}`);
  return { change_id: c.id, status: 'undone' };
}

async function listChanges(ctx, { limit } = {}) {
  const cap = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = ctx.user.isAdmin
    ? await db.prepare('SELECT id, action, summary, status, created_at, applied_at, undone_at FROM mcp_changes ORDER BY id DESC LIMIT ?').all(cap)
    : await db.prepare('SELECT id, action, summary, status, created_at, applied_at, undone_at FROM mcp_changes WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(ctx.user.id, cap);
  const s = await settings();
  return { writing: writeAllowed(s) ? (s.write === 'timed' ? `on until ${s.writeUntil}` : 'on') : 'off', changes: rows };
}

const actionList = Object.entries(ACTIONS).map(([k, a]) => `• ${k}: ${a.description}`).join('\n');

const SETUP_TOOLS = [
  {
    name: 'plan_change',
    description: `Plan a change in LoxSuite (needs token scope "setup"). Nothing is changed yet: returns a preview and a plan_id for apply_change. Actions:\n${actionList}`,
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: Object.keys(ACTIONS) }, params: { type: 'object', description: 'Parameters of the action (see the list).' } }, required: ['action', 'params'] },
    ctx: true,
    run: planChange,
  },
  { name: 'apply_change', description: 'Carry out a planned change after the user agreed to the preview. Only works while writing is switched on in LoxSuite.', inputSchema: { type: 'object', properties: { plan_id: { type: 'integer' } }, required: ['plan_id'] }, ctx: true, run: applyChange },
  { name: 'undo_change', description: 'Put an applied change back. Refuses when the row was changed since, unless force: true.', inputSchema: { type: 'object', properties: { change_id: { type: 'integer' }, force: { type: 'boolean' } }, required: ['change_id'] }, ctx: true, run: undoChange },
  { name: 'changes', description: 'Recent changes made through MCP (planned, applied, undone) and whether writing is on.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } }, ctx: true, run: listChanges },
];

module.exports = { SETUP_TOOLS, ACTIONS, planChange, applyChange, undoChange, listChanges };
