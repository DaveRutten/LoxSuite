require('dotenv').config();

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
const logsRoutes = require('./routes/logs');
const dashboardsRoutes = require('./routes/dashboards');
const adminRoutes = require('./routes/admin');
const backupRoutes = require('./routes/backup');
const profileRoutes = require('./routes/profile');
const avatarRoutes = require('./routes/avatar');
const { icon } = require('./icons');
const backup = require('./backup');
const { formatDateTime, getDisplayTimezone } = require('./dateFormat');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.icon = icon;
app.locals.formatDateTime = formatDateTime;
app.locals.serializeKeyValueLines = dashboardsRoutes.serializeKeyValueLines;
app.locals.serializeThresholdLadder = dashboardsRoutes.serializeThresholdLadder;
app.locals.serializeValueMappings = dashboardsRoutes.serializeValueMappings;
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
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
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
  const panels = dashboardsRoutes.loadPanelsWithMonitors(sharedDashboard.id);

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
  });
});

app.use('/miniservers', requireAuth, requirePermission('miniservers', 'view'), miniserverRoutes);
app.use('/live-data', requireAuth, requirePermission('miniservers', 'view'), liveDataRoutes);
// mappings.js serves three distinct areas (mqtt_to_loxone/loxone_to_mqtt/commands) under one
// router, so it's gated per-route inside that file instead of once here.
app.use('/mappings', requireAuth, mappingRoutes);
app.use('/incoming', requireAuth, requirePermission('incoming', 'view'), incomingRoutes);
app.use('/settings', requireAuth, requirePermission('settings', 'view'), settingsRoutes);
app.use('/mqtt-users', requireAuth, requirePermission('mqtt_users', 'view'), mqttUsersRoutes);
app.use('/mqtt-roles', requireAuth, requirePermission('mqtt_roles', 'view'), mqttRolesRoutes);
app.use('/transformations', requireAuth, requirePermission('transformations', 'view'), transformationsRoutes);
app.use('/monitor', requireAuth, requirePermission('monitor', 'view'), monitorRoutes);
app.use('/logs', requireAuth, requirePermission('logs', 'view'), logsRoutes);
// Serves both personal My Dashboards (ownership-gated, not part of the Access Roles matrix) and
// the shared home Dashboard's panel mutations (gated internally by the `dashboard` area) — see
// loadAccessibleDashboard/canMutate in routes/dashboards.js.
app.use('/dashboards', requireAuth, dashboardsRoutes);
app.use('/api/table-prefs', requireAuth, tablePrefsRoutes);
app.use('/api/nav-prefs', requireAuth, navPrefsRoutes);
// Mounted before the general '/admin' router below so its routes take precedence without relying
// on that router falling through for a path it doesn't recognize.
app.use('/admin/backup', requireAuth, requireAdmin, backupRoutes);
app.use('/admin', requireAuth, requireAdmin, adminRoutes);
app.use('/profile', requireAuth, profileRoutes);
app.use('/avatar', requireAuth, avatarRoutes);
app.get('/help', requireAuth, (req, res) => res.render('help'));

runBootstrap();
startHealthchecks(60000);
startTailing();
startUdpServer();
startMonitorCollector();
startLogCollector();
startLiveConnections();
backup.startScheduler();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LoxSuite listening on port ${port}.`);
});

process.on('SIGTERM', () => {
  const client = mqttClient.getClient();
  if (client) client.end(true, {}, () => process.exit(0));
  else process.exit(0);
});
