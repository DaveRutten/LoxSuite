// Seeds a fresh LoxSuite database with plausible, entirely synthetic data so every one of the 13
// screenshot pages has something realistic to show — run once, before the app itself starts, so
// the very first boot the screenshot Playwright session hits already has everything in place.
// Every value here is invented for this purpose; none of it is real user/device data.
process.env.DB_PATH = process.env.DB_PATH || '/data/screenshot.db';
const fs = require('fs');
const path = require('path');
const db = require('/app/src/db');
const { encrypt } = require('/app/src/secretCrypto');

const FAKE_MS_HOST = process.env.FAKE_MS_HOST || '127.0.0.1';
const FAKE_MS_PORT = Number(process.env.FAKE_MS_PORT || 7701);

function iso(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60000).toISOString();
}

async function main() {
  await db.init();

  // ---- Users / roles (admin already created by the app's own ADMIN_USERNAME/PASSWORD bootstrap
  // on first boot with no users — run this seed AFTER that first boot, see run.sh) ----
  const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  const adminId = admin.id;

  // ---- Miniservers: 1 standalone + 1 Gateway with 2 Clients, matching the existing
  // miniservers-light.png's own composition — all four point at the one fake Miniserver server so
  // they all read as genuinely "online" with live diagnostics, not just a stored status string. ----
  const msPassword = encrypt('demo-password');
  async function addMiniserver(name, extra = {}) {
    return db.insertReturningId(
      `INSERT INTO miniservers
        (name, host, http_port, udp_port, username, password, status, last_checked_at, last_success_at,
         firmware_version, firmware_date, update_level, plc_state, cpu_load, heap_status, num_tasks,
         miniserver_type, sort_order, gateway_client_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, FAKE_MS_HOST, FAKE_MS_PORT, 7777, 'demo', msPassword, 'online', iso(1), iso(1),
        '15.4.11.2', '2026-06-01', '3', '0', '12', '184320/262144kB', '48',
        0, extra.sort_order || 0, extra.gatewayClientOf || null]
    );
  }
  const msStandalone = await addMiniserver('Vacation Home', { sort_order: 0 });
  const msGateway = await addMiniserver('Main House', { sort_order: 1 });
  await addMiniserver('Main House — Guest House', { sort_order: 2, gatewayClientOf: msGateway });
  await addMiniserver('Main House — Garage', { sort_order: 3, gatewayClientOf: msGateway });

  // ---- Mappings ----
  await db.prepare(
    `INSERT INTO mappings_mqtt_to_loxone (miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(msStandalone, 'shellies/livingroom-light/relay/0', 'http', '/dev/sps/io/livingroom-light/<v>', 'bool_on_off', null, 0, 1);
  await db.prepare(
    `INSERT INTO mappings_mqtt_to_loxone (miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(msStandalone, 'zigbee2mqtt/kitchen-sensor/temperature', 'udp', '/dev/sps/io/kitchen-temp/<v>', 'passthrough', null, 5000, 1);
  await db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, enabled) VALUES (?, ?, ?, ?)`
  ).run(msStandalone, 'garage-door-status', 'loxone/garage/door/status', 1);

  // ---- Monitors + history (24h of plausible-looking points, hourly) ----
  async function addMonitor(sourceType, label, extra = {}) {
    return db.insertReturningId(
      `INSERT INTO monitors (source_type, label, mqtt_topic, miniserver_id, loxone_uuid, diag_field, poll_interval_ms, enabled, created_at, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sourceType, label, extra.mqtt_topic || null, extra.miniserver_id || null, extra.loxone_uuid || null,
        extra.diag_field || null, 10000, 1, iso(60 * 24 * 7), '{}']
    );
  }
  const monLivingTemp = await addMonitor('mqtt', 'Living room temperature', { mqtt_topic: 'zigbee2mqtt/livingroom/temperature' });
  const monKitchenTemp = await addMonitor('mqtt', 'Kitchen temperature', { mqtt_topic: 'zigbee2mqtt/kitchen-sensor/temperature' });
  const monPower = await addMonitor('mqtt', 'Total power draw', { mqtt_topic: 'shellies/em/power' });
  const monHumidity = await addMonitor('mqtt', 'Living room humidity', { mqtt_topic: 'zigbee2mqtt/livingroom/humidity' });
  const monCpu = await addMonitor('miniserver_diag', 'Main House — CPU load', { miniserver_id: msGateway, diag_field: 'cpu_load' });

  async function seedHistory(monitorId, points) {
    for (const [minutesAgo, value] of points) {
      await db.prepare('INSERT INTO monitor_history (monitor_id, recorded_at, value, numeric_value) VALUES (?, ?, ?, ?)')
        .run(monitorId, iso(minutesAgo), String(value), value);
    }
  }
  const hours = Array.from({ length: 25 }, (_, i) => 24 - i); // oldest first
  await seedHistory(monLivingTemp, hours.map((h) => [h * 60, Math.round((20 + Math.sin(h / 3) * 2 + Math.random() * 0.4) * 10) / 10]));
  await seedHistory(monKitchenTemp, hours.map((h) => [h * 60, Math.round((19 + Math.sin(h / 4 + 1) * 1.5 + Math.random() * 0.3) * 10) / 10]));
  await seedHistory(monPower, hours.map((h) => [h * 60, Math.round(300 + Math.abs(Math.sin(h / 2)) * 900 + Math.random() * 60)]));
  await seedHistory(monHumidity, hours.map((h) => [h * 60, Math.round(45 + Math.sin(h / 5) * 8)]));
  await seedHistory(monCpu, hours.map((h) => [h * 60, Math.round(8 + Math.abs(Math.sin(h)) * 20)]));

  // ---- Dashboard with varied panel types ----
  // The page at "/" (dashboard-*.png) isn't a personal dashboard at all — it's the one shared,
  // no-owner custom_dashboards row db.init()'s own migrateDashboardWidgetsToSharedPanels already
  // seeds on every fresh database (see server.js's own "/" handler). Adding panels to a NEW,
  // admin-owned row here would only ever show up under My Dashboards, leaving "/" itself looking
  // like an empty fresh install — reusing that already-seeded shared row instead is what actually
  // makes "/" show anything.
  let sharedDashboard = await db.prepare('SELECT id FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  const dashboardId = sharedDashboard
    ? sharedDashboard.id
    : await db.insertReturningId(
      `INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (NULL, ?, ?, ?)`,
      ['Dashboard', 0, iso(60 * 24 * 30)]
    );

  async function addPanel(panelType, title, range, config, monitorIds, colSpan = 4, rowSpan = 3, position = 0) {
    const panelId = await db.insertReturningId(
      `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, col_span, row_span, position, grid_x, grid_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dashboardId, panelType, title, range, JSON.stringify(config), colSpan, rowSpan, position, null, null]
    );
    for (let i = 0; i < monitorIds.length; i++) {
      await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(panelId, monitorIds[i], i);
    }
    return panelId;
  }

  await addPanel('chart', 'Temperatures', '24h', { chartType: 'line' }, [monLivingTemp, monKitchenTemp], 6, 4, 0);
  await addPanel('gauge', 'Living room humidity', '24h', {}, [monHumidity], 3, 3, 1);
  await addPanel('value', 'Power draw', '24h', {}, [monPower], 3, 2, 2);
  await addPanel('state_bar', 'Comfort', '24h', {}, [monLivingTemp, monHumidity], 6, 2, 3);
  await addPanel('stat_delta', 'CPU load trend', '24h', {}, [monCpu], 3, 3, 4);
  await addPanel('chart', 'Room comparison', '24h', { chartType: 'bar_compare' }, [monLivingTemp, monKitchenTemp, monHumidity], 6, 4, 5);
  await addPanel('chart', 'Latest snapshot', '24h', { chartType: 'radar' }, [monLivingTemp, monKitchenTemp, monHumidity, monPower], 4, 4, 6);
  await addPanel('threshold', 'Power alert', '24h', { thresholds: [{ value: 0, color: '#4caf50', label: 'Normal' }, { value: 800, color: '#f44336', label: 'High' }] }, [monPower], 3, 3, 7);

  // ---- A second, personal dashboard purely for the dashboard-chart-types-*.png screenshot — the
  // same 5 monitors as above, shown 6 different ways (line/bar/doughnut/radar/gauge/stat-with-
  // change), matching that screenshot's own long-standing alt text ("Six dashboard panels
  // comparing the same five monitors"). Deliberately its own dashboard rather than reusing "/"
  // above: that one is meant to look like an ordinary, lived-in mixed dashboard, not a curated
  // chart-type showcase, and cramming both intents onto one page well would fight itself.
  const chartTypesDashboardId = await db.insertReturningId(
    `INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (?, ?, ?, ?)`,
    [adminId, 'Chart types', 1, iso(60 * 24 * 10)]
  );
  const fiveMonitors = [monLivingTemp, monKitchenTemp, monPower, monHumidity, monCpu];
  async function addChartTypesPanel(panelType, title, config, monitorIds, colSpan, rowSpan, position) {
    const panelId = await db.insertReturningId(
      `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, col_span, row_span, position, grid_x, grid_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [chartTypesDashboardId, panelType, title, '24h', JSON.stringify(config), colSpan, rowSpan, position, null, null]
    );
    for (let i = 0; i < monitorIds.length; i++) {
      await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(panelId, monitorIds[i], i);
    }
  }
  await addChartTypesPanel('chart', 'Line', { chartType: 'line' }, fiveMonitors, 4, 4, 0);
  await addChartTypesPanel('chart', 'Bar', { chartType: 'bar_compare' }, fiveMonitors, 4, 4, 1);
  await addChartTypesPanel('chart', 'Doughnut', { chartType: 'doughnut' }, fiveMonitors, 4, 4, 2);
  await addChartTypesPanel('chart', 'Radar', { chartType: 'radar' }, fiveMonitors, 4, 4, 3);
  await addChartTypesPanel('gauge', 'Gauge', {}, [monHumidity], 4, 3, 4);
  await addChartTypesPanel('stat_delta', 'Stat with change', {}, [monPower], 4, 3, 5);

  // ---- Notifications ----
  const channelId = await db.insertReturningId(
    `INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, ?, ?)`,
    ['Family Discord', 'discord://webhook_id/webhook_token', 1, iso(60 * 24 * 20)]
  );
  const ruleId = await db.insertReturningId(
    `INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['monitor_threshold', 'Power draw too high', 1, JSON.stringify({ monitor_id: monPower, operator: 'gt', threshold: 1000 }), '{}', iso(60 * 24 * 20), adminId]
  );
  await db.prepare('INSERT INTO notification_rule_channels (rule_id, channel_id) VALUES (?, ?)').run(ruleId, channelId);

  const events = [
    ['miniserver_status', 'warning', 'Main House offline', 'Miniserver "Main House" stopped responding.', iso(45)],
    ['monitor_threshold', 'critical', 'Power draw too high', 'Total power draw reached 1180 W (threshold 1000 W).', iso(90)],
    ['backup_failed', 'critical', 'Backup failed', 'Scheduled backup could not write to /data/backups (disk full).', iso(60 * 5)],
    ['battery_weak', 'warning', 'Battery weak', '"Front door sensor" reports a weak battery (18%).', iso(60 * 20)],
    ['loxsuite_update_available', 'info', 'Update available', 'LoxSuite 0.18.19-alpha.1 is available (currently running 0.18.15-alpha.1).', iso(60 * 30)],
    ['device_firmware_changed', 'info', 'Firmware updated', '"Main House" firmware changed from 15.4.10.1 to 15.4.11.2.', iso(60 * 48)],
  ];
  for (const [type, sev, title, msg, at] of events) {
    await db.prepare('INSERT INTO notification_events (event_type, severity, title, message, source_id, source_label, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(type, sev, title, msg, msGateway, 'Main House', ruleId, at);
  }

  // ---- Hardware inventory (seeded directly — /data/status is deliberately not faked, see
  // fake-miniserver.js's own comment) ----
  async function addHardware(msId, fields) {
    await db.prepare(
      `INSERT INTO loxone_hardware_devices
        (miniserver_id, device_key, category, type, name, place, serial, version, min_version, hw_version,
         online, battery, batt_weak, bat_too_weak_for_update, quality_ext, quality_dev, hops, time_diff, mac, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msId, fields.deviceKey, fields.category, fields.type || null, fields.name || null, fields.place || null,
      fields.serial || null, fields.version || null, fields.minVersion || null, fields.hwVersion || null,
      fields.online == null ? null : (fields.online ? 1 : 0), fields.battery ?? null, fields.battWeak ? 1 : 0, 0,
      fields.qualityExt ?? null, fields.qualityDev ?? null, fields.hops ?? null, fields.timeDiff ?? null, fields.mac || null, iso(2)
    );
  }
  await addHardware(msGateway, { deviceKey: 'EXT-001', category: 'extension', type: 'Relay Extension', name: 'Relay Extension', serial: '50:4F:00:01:AB:CD', version: '15.4.11.2', online: true });
  await addHardware(msGateway, { deviceKey: 'AIR-001', category: 'air', type: 'Air Base Extension', name: 'Front door sensor', place: 'Entrance', serial: '9C:B6:D0:11:22:33', version: '11.2', online: true, battery: 18, battWeak: true, qualityExt: 95, qualityDev: 88, hops: 1 });
  await addHardware(msGateway, { deviceKey: 'AIR-002', category: 'air', type: 'Air Base Extension', name: 'Living room motion', place: 'Living room', serial: '9C:B6:D0:11:22:34', version: '11.2', online: true, battery: 72, qualityExt: 99, qualityDev: 97, hops: 1 });
  await addHardware(msGateway, { deviceKey: 'AUDSRV-001', category: 'audio_server', type: 'Audioserver', name: 'Audioserver', place: 'Basement', mac: '50:4F:94:AA:BB:CC', version: '17.02.08.11', online: true });
  await addHardware(msGateway, { deviceKey: 'AUDZONE-living', category: 'audio_zone', type: 'Audio zone', name: 'Living room', online: true });
  await addHardware(msGateway, { deviceKey: 'AUDZONE-kitchen', category: 'audio_zone', type: 'Audio zone', name: 'Kitchen', online: false });

  // ---- Backup: enabled settings + a real, correctly-named dummy .zip so listBackups() finds one ----
  await db.prepare(
    `UPDATE backup_settings SET enabled = 1, schedule_cron = '0 3 * * *', retention_count = 14,
     last_run_at = ?, last_status = 'ok', rclone_enabled = 1, rclone_remote = 'gdrive:loxsuite-backups',
     rclone_last_run_at = ?, rclone_last_status = 'ok' WHERE id = 1`
  ).run(iso(60 * 20), iso(60 * 20));
  const backupDir = process.env.BACKUP_DIR || '/data/backups';
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(Date.now() - 60 * 20 * 60000).toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `backup-${stamp}.zip`), Buffer.from('PK\x03\x04demo-backup-not-a-real-zip'));

  // ---- Security-ish settings (rate limit already has sane defaults; SSO left disabled but with a
  // filled-in issuer so the form doesn't look totally blank) ----
  await db.prepare('UPDATE gateway_settings SET login_rate_limit_max = 10, login_rate_limit_window_minutes = 15 WHERE id = 1').run();
  await db.prepare("UPDATE sso_settings SET enabled = 0, issuer_url = 'https://id.example.com', client_id = 'loxsuite', button_label = 'Pocket ID' WHERE id = 1").run();

  console.log('Seed complete.');
  await db.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
