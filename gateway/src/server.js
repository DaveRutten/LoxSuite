require('dotenv').config();

// Both the session-cookie signing key (below) and every secret-at-rest's encryption key
// (secretCrypto.js) derive from this, and BOTH silently fall back to a hardcoded dev string if
// it's missing — deliberately, so a fresh checkout still runs without any setup. In a real
// deployment that fallback is exactly the wrong thing to do silently: every already-encrypted
// Miniserver/MQTT/SSO/rclone secret instantly stops decrypting, and the resulting errors (MQTT
// "not authorised", a Miniserver's HTTP 403, ...) look nothing like "SESSION_SECRET is wrong" —
// confirmed the hard way when an Unraid container edit blanked this field out from under a working
// install and it took real diagnostic effort to trace those symptoms back to this. Loud and early
// (before anything else even has a chance to log something more confusing first), not a hard
// refusal to start — an already-broken production instance shouldn't ALSO become unreachable.
if (!process.env.SESSION_SECRET) {
  console.error('='.repeat(78));
  console.error('WARNING: SESSION_SECRET is not set.');
  console.error('Falling back to an insecure, hardcoded development value — session cookies');
  console.error('and every secret already encrypted at rest (Miniserver passwords, the MQTT');
  console.error('broker password, SSO client secret, saved rclone.conf) will now fail with');
  console.error('errors that look unrelated (MQTT "not authorised", a Miniserver HTTP 403, ...).');
  console.error('Set SESSION_SECRET to a stable random value (e.g. `openssl rand -hex 32`) and');
  console.error('restart, then re-enter each affected password/secret once through the web UI.');
  console.error('='.repeat(78));
}

// docker-entrypoint.sh treats either of its two supervised processes (this one, Mosquitto) exiting
// as fatal for the whole container — so an uncaught error anywhere in here used to take Mosquitto
// down with it too, on what should have been just one failed request. Node's own default response
// to an unhandled promise rejection (any throw inside an async route handler that isn't its own
// try/catch — Express 4 doesn't catch those for you the way it does a synchronous throw) is to
// crash the process outright; confirmed the hard way when a bug in one dashboard route did exactly
// that. Logging and continuing is the correct tradeoff for a web server: a broken request should
// surface as a 500, not end the process every other request is also relying on.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (recovered, not crashing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (recovered, not crashing):', err);
});

const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const path = require('path');

const db = require('./db');
const mqttClient = require('./mqttClient');
const { runBootstrap } = require('./dynsecBootstrap');
const { startHealthchecks } = require('./healthcheck');
const { startTailing, getClients } = require('./mosquittoLog');
const { startUdpServer } = require('./loxoneUdpServer');
const { startMonitorCollector } = require('./monitorCollector');
const { startLogCollector } = require('./logCollector');
const { startHardwarePolling } = require('./loxoneHardware');
const { startLiveConnections } = require('./loxoneWebSocket');
const requireAuth = require('./middleware/requireAuth');
const loadUserContext = require('./middleware/loadUserContext');
const { requirePermission, requireAdmin } = require('./middleware/requirePermission');
const { attachCsrfToken, verifyCsrfToken } = require('./middleware/csrf');

const authRoutes = require('./routes/auth');
const miniserverRoutes = require('./routes/miniservers');
const liveDataRoutes = require('./routes/liveData');
const mappingRoutes = require('./routes/mappings');
const loxoneInboundRoutes = require('./routes/loxoneInbound');
const incomingRoutes = require('./routes/incoming');
const settingsRoutes = require('./routes/settings');
const mqttUsersRoutes = require('./routes/mqttUsers');
const mqttRolesRoutes = require('./routes/mqttRoles');
const transformationsRoutes = require('./routes/transformations');
const tablePrefsRoutes = require('./routes/tablePrefs');
const navPrefsRoutes = require('./routes/navPrefs');
const monitorRoutes = require('./routes/monitor');
const hardwareRoutes = require('./routes/hardware');
const logsRoutes = require('./routes/logs');
const dashboardsRoutes = require('./routes/dashboards');
// Requires routes/dashboards itself (for serializeThresholdLadder/serializeAnnotations) — kept
// below dashboardsRoutes above so that module is already fully loaded first: dashboards.js's own
// top-level require('./monitor') would otherwise see monitor.js's exports still mid-assembly if
// this loaded any earlier, since monitor.js requires dashboards.js lazily inside its own route
// handlers for the exact same reason (see routes/monitor.js's chart-settings route).
const chartFieldHelpers = require('./chartFieldHelpers');
const adminRoutes = require('./routes/admin');
const backupRoutes = require('./routes/backup');
const notificationsRoutes = require('./routes/notifications');
const notificationCenterRoutes = require('./routes/notificationCenter');
const setupRoutes = require('./routes/setup');
const profileRoutes = require('./routes/profile');
const avatarRoutes = require('./routes/avatar');
const { icon } = require('./icons');
const { toggleSwitch } = require('./toggleSwitch');
const backup = require('./backup');
const { formatDateTime, getDisplayTimezone } = require('./dateFormat');
const { formatCount, formatHeapStatus, miniserverGenerationLabel, formatDuration } = require('./format');
const panelTypeDefaults = require('./panelTypeDefaults');
const { getVersionStatus, startVersionCheck } = require('./versionCheck');
const { notificationSourceLink } = require('./notificationLinks');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Cache-busting query string for /style.css, /tables.js, /monitor-chart.js (see head.ejs,
// foot.ejs, monitor-detail.ejs, panel-grid.ejs) — set once at boot rather than per-request, so a
// browser that cached last version's assets picks up this restart's actual files immediately
// instead of needing a manual hard-refresh, while every request within the same run still shares
// one cache-friendly value.
app.locals.assetVersion = Date.now();
app.locals.icon = icon;
app.locals.toggleSwitch = toggleSwitch;
app.locals.formatDateTime = formatDateTime;
app.locals.formatCount = formatCount;
app.locals.formatHeapStatus = formatHeapStatus;
app.locals.miniserverGenerationLabel = miniserverGenerationLabel;
app.locals.formatDuration = formatDuration;
app.locals.getVersionStatus = getVersionStatus;
app.locals.notificationSourceLink = notificationSourceLink;
app.locals.serializeKeyValueLines = dashboardsRoutes.serializeKeyValueLines;
app.locals.serializeThresholdLadder = dashboardsRoutes.serializeThresholdLadder;
app.locals.serializeValueMappings = dashboardsRoutes.serializeValueMappings;
app.locals.serializeAnnotations = dashboardsRoutes.serializeAnnotations;
app.locals.escAttr = chartFieldHelpers.escAttr;
app.locals.unitField = chartFieldHelpers.unitField;
app.locals.thresholdField = chartFieldHelpers.thresholdField;
app.locals.annotationField = chartFieldHelpers.annotationField;
// Exposed as a global for the client-side chart (public/monitor-chart.js) — everything
// server-rendered uses formatDateTime() directly and never needs this.
app.use((req, res, next) => { res.locals.displayTimezone = getDisplayTimezone(); next(); });
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    // sameSite: 'lax' (not 'strict') is deliberate — the Pocket ID SSO callback is a top-level
    // GET redirect back from an external origin, and 'strict' would drop the session cookie on
    // that hop (breaking the codeVerifier/state check in routes/auth.js). 'lax' still excludes
    // the cookie from cross-site POSTs, which is the actual CSRF vector this app cares about.
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// Public: Loxone calls this directly, no login involved.
app.use('/api/loxone-in', loxoneInboundRoutes);

app.use(attachCsrfToken);
app.use(verifyCsrfToken);

// Populates req.user/res.locals.currentUser whenever a session exists; a no-op otherwise, so it's
// safe to run globally ahead of both the public routes above and every authenticated one below.
app.use(loadUserContext);

app.use(authRoutes);

app.get('/', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  const miniserverRows = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  // Same Gateway/Client labeling as the Miniservers page itself (routes/miniservers.js) — shown
  // as its own column here too, so this summary table doesn't look out of sync with the one on
  // the actual Miniservers page for the exact same Miniservers.
  const msNameById = new Map(miniserverRows.map((ms) => [ms.id, ms.name]));
  const msClientCountByGatewayId = new Map();
  miniserverRows.forEach((ms) => {
    if (!ms.gateway_client_of) return;
    msClientCountByGatewayId.set(ms.gateway_client_of, (msClientCountByGatewayId.get(ms.gateway_client_of) || 0) + 1);
  });
  const miniservers = miniserverRows.map((ms) => ({
    ...ms,
    gatewayClientOfName: ms.gateway_client_of ? msNameById.get(ms.gateway_client_of) || null : null,
    gatewayClientCount: msClientCountByGatewayId.get(ms.id) || 0,
  }));
  const mqttToLoxoneCount = db.prepare('SELECT COUNT(*) AS c FROM mappings_mqtt_to_loxone WHERE enabled = 1').get().c;
  const loxoneToMqttCount = db.prepare('SELECT COUNT(*) AS c FROM mappings_loxone_to_mqtt WHERE enabled = 1').get().c;
  const connectedClientCount = getClients().filter((c) => c.status === 'connected').length;

  // The home Dashboard is one ordinary custom_dashboards row with no owner (user_id IS NULL),
  // seeded once by db.js's migrateDashboardWidgetsToSharedPanels — same panel system My
  // Dashboards uses, just shared instead of personal (see routes/dashboards.js). Recreated on the
  // fly if it's somehow missing (defensive only — the migration always seeds it on startup).
  let sharedDashboard = db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!sharedDashboard) {
    const result = db.prepare('INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (NULL, ?, 0, ?)')
      .run('Dashboard', new Date().toISOString());
    sharedDashboard = { id: result.lastInsertRowid };
  }
  const dashboardMonitors = db.prepare('SELECT id, label, source_type FROM monitors ORDER BY label').all();
  const panels = dashboardsRoutes.loadPanelsWithMonitors(sharedDashboard.id, req.query.range);

  res.render('dashboard', {
    username: req.session.username,
    mqttConnected: mqttClient.state.connected,
    miniservers,
    mqttToLoxoneCount,
    loxoneToMqttCount,
    stats: mqttClient.getStats(),
    connectedClientCount,
    dashboard: sharedDashboard,
    panels,
    monitors: dashboardMonitors,
    defaultPanelDecimals: dashboardsRoutes.getDefaultPanelDecimals(),
    panelTypeDefaultsExist: panelTypeDefaults.listDefaultTypes(sharedDashboard.id),
  });
});

app.use('/miniservers', requireAuth, requirePermission('miniservers', 'view'), miniserverRoutes);
app.use('/live-data', requireAuth, requirePermission('live_data', 'view'), liveDataRoutes);
// mappings.js serves three distinct areas (mqtt_to_loxone/loxone_to_mqtt/commands) under one
// router, so it's gated per-route inside that file instead of once here.
app.use('/mappings', requireAuth, mappingRoutes);
app.use('/incoming', requireAuth, requirePermission('incoming', 'view'), incomingRoutes);
app.use('/settings', requireAuth, requirePermission('settings', 'view'), settingsRoutes);
app.use('/mqtt-users', requireAuth, requirePermission('mqtt_users', 'view'), mqttUsersRoutes);
app.use('/mqtt-roles', requireAuth, requirePermission('mqtt_roles', 'view'), mqttRolesRoutes);
app.use('/transformations', requireAuth, requirePermission('transformations', 'view'), transformationsRoutes);
app.use('/monitor', requireAuth, requirePermission('monitor', 'view'), monitorRoutes);
app.use('/hardware', requireAuth, requirePermission('hardware', 'view'), hardwareRoutes);
// logs.js serves four distinct areas (one per tab: logs_mqtt/logs_loxone/logs_loxone_commands/
// logs_system), so it's gated per-route inside that file instead of once here — same reasoning as
// mappings.js above.
app.use('/logs', requireAuth, logsRoutes);
// Serves both personal My Dashboards (ownership-gated, not part of the Access Roles matrix) and
// the shared home Dashboard's panel mutations (gated internally by the `dashboard` area) — see
// loadAccessibleDashboard/canMutate in routes/dashboards.js.
app.use('/dashboards', requireAuth, dashboardsRoutes);
app.use('/api/table-prefs', requireAuth, tablePrefsRoutes);
app.use('/api/nav-prefs', requireAuth, navPrefsRoutes);
// Mounted before the general '/admin' router below so their routes take precedence without
// relying on that router falling through for a path it doesn't recognize.
app.use('/admin/backup', requireAuth, requireAdmin, backupRoutes);
app.use('/admin/notifications', requireAuth, requireAdmin, notificationsRoutes);
app.use('/admin', requireAuth, requireAdmin, adminRoutes);
// Admin-only, same as the routes just above — the wizard changes global settings (timezone) and
// adds Miniservers, not personal preferences, so it needs the same standing an Administrator's
// own hands-on setup of those would.
app.use('/setup', requireAuth, requireAdmin, setupRoutes);
app.use('/profile', requireAuth, profileRoutes);
app.use('/avatar', requireAuth, avatarRoutes);
// Ambient topbar chrome (the bell's unread-count/mark-read) — any logged-in user, no
// requirePermission gate, same tier as Help/the account menu (see notificationCenter.js's own
// header comment for why). The full historical logbook is /logs/notifications instead, which IS
// gated (see routes/logs.js's requirePermission('logs_notifications', ...)).
app.use('/notifications', requireAuth, notificationCenterRoutes);
app.get('/help', requireAuth, (req, res) => res.render('help'));

runBootstrap();
startHealthchecks();
startTailing();
startUdpServer();
startMonitorCollector();
startLogCollector();
startHardwarePolling();
startLiveConnections();
backup.startScheduler();
startVersionCheck();

const port = process.env.PORT || 5582;
app.listen(port, () => {
  console.log(`LoxSuite listening on port ${port}.`);
});

process.on('SIGTERM', () => {
  const client = mqttClient.getClient();
  if (client) client.end(true, {}, () => process.exit(0));
  else process.exit(0);
});
