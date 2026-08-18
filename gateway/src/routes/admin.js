const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { AREAS, MAIN_AREAS, LOG_AREAS } = require('../permissionAreas');
const { logSystemEvent, describeChanges } = require('../auditLog');
const { reloadLoginLimiter } = require('./auth');
const { encrypt } = require('../secretCrypto');
const { checkForUpdate } = require('../versionCheck');
const { listTemplateSources } = require('../deviceTemplates');
const { reloadDeviceTemplates } = require('../commandCatalog');
const { fetchBuiltinTemplatesFromGitHub } = require('../deviceTemplatesUpdate');
const ollama = require('../llm/ollama');
const ollamaPullState = require('../ollamaPullState');
const techReport = require('../techReport');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

async function listUsers() {
  return db.prepare(
    `SELECT users.id, users.username, users.auth_provider, users.role_id, users.last_login_at,
            users.first_name, users.last_name, users.display_name, users.avatar_url, users.disabled_at,
            access_roles.name AS role_name
     FROM users LEFT JOIN access_roles ON access_roles.id = users.role_id
     ORDER BY users.username`
  ).all();
}

async function listRoles() {
  const roles = await db.prepare('SELECT * FROM access_roles ORDER BY name').all();
  const permStmt = db.prepare('SELECT area, can_view, can_edit FROM access_role_permissions WHERE role_id = ?');
  const userCountStmt = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?');

  return Promise.all(roles.map(async (role) => {
    const rows = await permStmt.all(role.id);
    const permissions = {};
    for (const { key } of AREAS) permissions[key] = { view: false, edit: false };
    for (const row of rows) permissions[row.area] = { view: !!row.can_view, edit: !!row.can_edit };
    return { ...role, permissions, userCount: (await userCountStmt.get(role.id)).c };
  }));
}

// True only when removing/demoting this user would leave zero users with an admin role — the
// server-side backstop against ever locking every administrator out of Administration.
async function isLastAdmin(userId) {
  const adminCount = (await db.prepare(
    `SELECT COUNT(*) AS c FROM users u JOIN access_roles r ON r.id = u.role_id WHERE r.is_admin = 1`
  ).get()).c;
  if (adminCount > 1) return false;

  const user = await db.prepare(
    `SELECT r.is_admin AS "isAdmin" FROM users u LEFT JOIN access_roles r ON r.id = u.role_id WHERE u.id = ?`
  ).get(userId);
  return !!(user && user.isAdmin && adminCount === 1);
}

router.get('/', (req, res) => res.redirect('/admin/general'));

router.get('/general', asyncHandler(async (req, res) => {
  res.render('admin-general', {
    error: null, justChecked: false, dbInfo: await db.getInfo(),
    templateSources: listTemplateSources(), templateResult: null,
  });
}));

// On-demand version of the same check startVersionCheck() already runs once at boot and every 24h
// (see versionCheck.js) — getVersionStatus() alone (already available in every view via
// app.locals, see server.js) only ever re-reads that in-memory state, it never makes the GitHub
// call itself, so a "Check now" button needs this instead.
router.post('/check-update', asyncHandler(async (req, res) => {
  await checkForUpdate();
  res.render('admin-general', {
    error: null, justChecked: true, dbInfo: await db.getInfo(),
    templateSources: listTemplateSources(), templateResult: null,
  });
}));

// Re-scans device-templates/ (bundled + synced + user) without a restart — for when a file was
// just hand-edited under the bind-mounted user/ folder, or right after the fetch-github action
// below. reloadDeviceTemplates (commandCatalog.js) mutates CATALOG/DATA_CATALOG in place so every
// other module already holding that reference (deviceDiscovery.js, ...) sees the refreshed data
// immediately, no restart needed.
router.post('/device-templates/reload', asyncHandler(async (req, res) => {
  const result = reloadDeviceTemplates();
  res.render('admin-general', {
    error: null, justChecked: false, dbInfo: await db.getInfo(),
    templateSources: listTemplateSources(),
    templateResult: { action: 'reload', ...result },
  });
}));

// Fetches this project's own device-templates straight from GitHub's main branch (ahead of any
// tagged release — see deviceTemplatesUpdate.js) into device-templates/synced/, then reloads —
// same two-step shape as a manual edit + Reload above, just with the fetch in between.
router.post('/device-templates/fetch-github', asyncHandler(async (req, res) => {
  const fetchResult = await fetchBuiltinTemplatesFromGitHub();
  const reloadResult = reloadDeviceTemplates();
  res.render('admin-general', {
    error: null, justChecked: false, dbInfo: await db.getInfo(),
    templateSources: listTemplateSources(),
    templateResult: { action: 'fetch-github', ...fetchResult, ...reloadResult },
  });
}));

// A single diagnostic snapshot (version/DB info, recent logs, config counts, live MQTT/Miniserver
// status) — see techReport.js's own header for why this exists at all. Viewable here, and
// downloadable as one JSON file below — same data built fresh each time either is requested
// (never cached/stored), so it's never stale by the time someone actually looks at it.
router.get('/tech-report', asyncHandler(async (req, res) => {
  res.render('admin-tech-report', { report: await techReport.buildReport() });
}));

router.get('/tech-report/download', asyncHandler(async (req, res) => {
  const report = await techReport.buildReport();
  const filename = `loxsuite-tech-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(report, null, 2));
}));

router.get('/users', asyncHandler(async (req, res) => {
  res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: null });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { username, password, role_id, first_name, last_name } = req.body;
  try {
    if (!username || !password || !role_id) throw new Error('Username, password, and role are required.');
    const hash = bcrypt.hashSync(password, 10);
    await db.prepare('INSERT INTO users (username, password_hash, role_id, auth_provider, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, role_id, 'local', first_name?.trim() || null, last_name?.trim() || null);
    await logSystemEvent(`"${req.user.username}" created user "${username}".`);
    res.redirect('/admin/users');
  } catch (err) {
    res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: err.message });
  }
}));

// Local users only — an SSO account's name is refreshed from Pocket ID on every login (see
// routes/auth.js), so editing it here would just get overwritten the next time they sign in.
router.post('/users/:id/name', asyncHandler(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.auth_provider !== 'local') {
    return res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'This account signs in via SSO — its name comes from Pocket ID and cannot be edited here.' });
  }
  const firstName = (req.body.first_name || '').trim() || null;
  const lastName = (req.body.last_name || '').trim() || null;
  await db.prepare('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?').run(firstName, lastName, user.id);
  await logSystemEvent(`"${req.user.username}" updated the name on user "${user.username}".`);
  res.redirect('/admin/users');
}));

router.post('/users/:id/role', asyncHandler(async (req, res) => {
  const targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const targetRole = await db.prepare('SELECT * FROM access_roles WHERE id = ?').get(req.body.role_id);
  if (!targetRole) {
    return res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'Role not found.' });
  }
  if (!targetRole.is_admin && (await isLastAdmin(req.params.id))) {
    return res.render('admin-users', {
      users: await listUsers(),
      roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
      error: 'This is the only remaining administrator — assign another user as administrator first.',
    });
  }
  await db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(targetRole.id, req.params.id);
  await logSystemEvent(`"${req.user.username}" changed "${targetUser?.username}"'s role to "${targetRole.name}".`);
  res.redirect('/admin/users');
}));

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const error = !user
    ? 'User not found.'
    : user.auth_provider !== 'local'
      ? 'This account signs in via SSO and has no local password to reset.'
      : !req.body.password || req.body.password.length < 8
        ? 'Password must be at least 8 characters.'
        : null;

  if (error) {
    return res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error });
  }

  const hash = bcrypt.hashSync(req.body.password, 10);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  await logSystemEvent(`"${req.user.username}" reset the password for user "${user.username}".`);
  res.redirect('/admin/users');
}));

// Soft-disable rather than delete — turns off access (checked at login in routes/auth.js and on
// every subsequent request in middleware/loadUserContext.js, so an already-open session is kicked
// out on its very next request rather than staying valid until it happens to expire) while leaving
// the account, its dashboards, and its audit trail intact. Same self/last-admin guards as delete
// below, since the practical effect on the target user is the same: no more access.
router.post('/users/:id/disable', asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'You cannot disable your own account.' });
  }
  if (await isLastAdmin(req.params.id)) {
    return res.render('admin-users', {
      users: await listUsers(),
      roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
      error: 'This is the only remaining administrator and cannot be disabled — assign another user as administrator first.',
    });
  }
  const targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  await db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
  await logSystemEvent(`"${req.user.username}" disabled user "${targetUser?.username}".`);
  res.redirect('/admin/users');
}));

router.post('/users/:id/enable', asyncHandler(async (req, res) => {
  const targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  await db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(req.params.id);
  await logSystemEvent(`"${req.user.username}" re-enabled user "${targetUser?.username}".`);
  res.redirect('/admin/users');
}));

router.post('/users/:id/delete', asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.render('admin-users', { users: await listUsers(), roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'You cannot delete your own account.' });
  }
  if (await isLastAdmin(req.params.id)) {
    return res.render('admin-users', {
      users: await listUsers(),
      roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
      error: 'This is the only remaining administrator and cannot be deleted — assign another user as administrator first.',
    });
  }
  const targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — cleaned up explicitly rather than
  // relying on the schema's own ON DELETE CASCADE to do it. Their own personal notification rules
  // (routes/profile.js's "My rules") go too, not just their subscriptions to admin-wide ones —
  // otherwise an orphaned, still-enabled rule would keep matching readings forever with nobody left
  // to deliver to.
  await db.prepare('DELETE FROM notification_rule_subscribers WHERE user_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM notification_rule_channels WHERE rule_id IN (SELECT id FROM notification_rules WHERE owner_user_id = ?)').run(req.params.id);
  await db.prepare('DELETE FROM notification_rules WHERE owner_user_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM dashboard_favorites WHERE user_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  await logSystemEvent(`"${req.user.username}" deleted user "${targetUser?.username}".`);
  res.redirect('/admin/users');
}));

router.get('/roles', asyncHandler(async (req, res) => {
  res.render('admin-roles', { roles: await listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: null });
}));

router.post('/roles', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  try {
    if (!name) throw new Error('Role name is required.');
    const newRoleId = await db.insertReturningId('INSERT INTO access_roles (name, is_admin) VALUES (?, 0)', [name]);
    for (const { key } of AREAS) {
      await db.prepare('INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, 0, 0)').run(newRoleId, key);
    }
    await logSystemEvent(`"${req.user.username}" created role "${name}".`);
    res.redirect('/admin/roles');
  } catch (err) {
    res.render('admin-roles', { roles: await listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: err.message });
  }
}));

router.post('/roles/:id/rename', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    const oldRole = await db.prepare('SELECT name FROM access_roles WHERE id = ?').get(req.params.id);
    await db.prepare('UPDATE access_roles SET name = ? WHERE id = ?').run(name, req.params.id);
    await logSystemEvent(`"${req.user.username}" renamed role "${oldRole?.name}" to "${name}".`);
  }
  res.redirect('/admin/roles');
}));

router.post('/roles/:id/permissions', asyncHandler(async (req, res) => {
  const roleId = req.params.id;
  const role = await db.prepare('SELECT * FROM access_roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).send('Role not found');

  // Demoting the sole admin role's is_admin flag is just as dangerous as deleting the role itself.
  const wasOnlyAdminRole = role.is_admin && (await db.prepare('SELECT COUNT(*) AS c FROM access_roles WHERE is_admin = 1').get()).c === 1;
  const stillAdmin = !!req.body.is_admin;
  if (wasOnlyAdminRole && !stillAdmin && (await db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(roleId)).c > 0) {
    return res.render('admin-roles', { roles: await listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: 'This is the only administrator role and still has users on it — assign them elsewhere first.' });
  }

  await db.transaction(async (tx) => {
    await tx.prepare('UPDATE access_roles SET is_admin = ? WHERE id = ?').run(stillAdmin ? 1 : 0, roleId);
    for (const { key } of AREAS) {
      const edit = req.body.perm?.[key]?.edit ? 1 : 0;
      const view = edit || req.body.perm?.[key]?.view ? 1 : 0; // edit implies view
      await tx.upsert('access_role_permissions', { role_id: roleId, area: key, can_view: view, can_edit: edit }, ['role_id', 'area']);
    }
  });

  await logSystemEvent(`"${req.user.username}" updated permissions for role "${role.name}".`);
  res.redirect('/admin/roles');
}));

router.post('/roles/:id/delete', asyncHandler(async (req, res) => {
  const inUse = (await db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(req.params.id)).c;
  if (inUse > 0) {
    return res.render('admin-roles', { roles: await listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: `${inUse} user(s) still have this role — reassign them first.` });
  }
  const role = await db.prepare('SELECT name FROM access_roles WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM access_roles WHERE id = ?').run(req.params.id);
  await logSystemEvent(`"${req.user.username}" deleted role "${role?.name}".`);
  res.redirect('/admin/roles');
}));

// Single Sign-On and the login rate limit are both Administration -> Security cards on one page
// now (used to be a separate "Single Sign-On" tab) — this loads everything both cards need
// regardless of which form was actually just submitted, so either POST handler can re-render the
// same view with fresh data (and the other card's own edits, if any, aren't lost either).
// Surfaces the one documented way "Require SSO from outside the local network" (below) can be a
// silent no-op: without the TRUST_PROXY opt-in (see server.js), req.ip is always the reverse
// proxy/tunnel's own (private) address, so isPrivateNetworkRequest (network.js) treats every real
// visitor as local no matter where they actually are. A request that itself arrives carrying an
// X-Forwarded-For header while Express's own trust-proxy setting is off is exactly that situation
// — the admin loading this very page is going through the same proxy every other visitor does.
// Best-effort like the check it's warning about (a proxy could omit/rename that header), but a
// false negative here just means no banner, not a false sense of security either way.
function proxyTrustMisconfigured(req) {
  return !req.app.get('trust proxy') && !!req.headers['x-forwarded-for'];
}

async function loadSecurityPageData(req) {
  return {
    sso: await db.prepare('SELECT * FROM sso_settings WHERE id = 1').get(),
    roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
    gatewaySettings: await db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get(),
    proxyTrustMisconfigured: proxyTrustMisconfigured(req),
  };
}

router.get('/security', asyncHandler(async (req, res) => {
  res.render('admin-security', { ...(await loadSecurityPageData(req)), error: null, saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
}));

// /admin/sso is kept as the SSO form's own POST target (unchanged from before the merge) rather
// than renaming it to /admin/security/sso — nothing else needed to change to make that work.
router.post('/sso', asyncHandler(async (req, res) => {
  const { enabled, issuer_url, client_id, client_secret, default_role_id, button_label, local_login_disabled } = req.body;

  // Blank secret field = keep the existing one; it's never shown back to the browser, so
  // re-typing is only needed to actually change it (same convention as Miniserver passwords).
  const existing = await db.prepare('SELECT client_secret FROM sso_settings WHERE id = 1').get();
  const newSecret = client_secret ? encrypt(client_secret) : existing?.client_secret;

  await db.prepare(
    `UPDATE sso_settings SET enabled = ?, issuer_url = ?, client_id = ?, client_secret = ?, default_role_id = ?, button_label = ?, local_login_disabled = ?
     WHERE id = 1`
  ).run(
    enabled ? 1 : 0,
    issuer_url || null,
    client_id || null,
    newSecret || null,
    default_role_id || null,
    button_label || 'Pocket ID',
    local_login_disabled ? 1 : 0
  );
  await logSystemEvent(`"${req.user.username}" updated SSO settings.`);
  res.render('admin-security', { ...(await loadSecurityPageData(req)), error: null, saved: true, baseUrl: `${req.protocol}://${req.get('host')}` });
}));

router.post('/security', asyncHandler(async (req, res) => {
  const max = Number(req.body.login_rate_limit_max);
  const windowMinutes = Number(req.body.login_rate_limit_window_minutes);

  if (!Number.isFinite(max) || max < 1) {
    return res.render('admin-security', { ...(await loadSecurityPageData(req)), error: 'Max login attempts must be at least 1.', saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) {
    return res.render('admin-security', { ...(await loadSecurityPageData(req)), error: 'The login attempts time window must be at least 1 minute.', saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
  }

  await db.prepare('UPDATE gateway_settings SET login_rate_limit_max = ?, login_rate_limit_window_minutes = ? WHERE id = 1')
    .run(Math.round(max), Math.round(windowMinutes));
  await reloadLoginLimiter();
  await logSystemEvent(`"${req.user.username}" updated the login rate limit.`);
  res.render('admin-security', { ...(await loadSecurityPageData(req)), error: null, saved: true, baseUrl: `${req.protocol}://${req.get('host')}` });
}));

async function loadAiSettings() {
  return db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
}

router.get('/ai', asyncHandler(async (req, res) => {
  res.render('admin-ai', { settings: await loadAiSettings(), error: null, saved: false });
}));

router.post('/ai', asyncHandler(async (req, res) => {
  const { enabled, provider, model, effort, api_key, base_url, suggestions_mode } = req.body;

  // Full row (not just api_key) — also feeds the describeChanges() audit line below, so the
  // System log shows what actually changed instead of a bare "updated AI Assistant settings."
  const existing = await db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  // Blank key field = keep the existing one; it's never shown back to the browser, same
  // convention as Miniserver/SSO secrets. Meaningful for Ollama too, not just Anthropic — a remote
  // Ollama-compatible server behind a reverse proxy can require a bearer token of its own.
  const newApiKey = api_key ? encrypt(api_key) : existing?.api_key;

  // Deliberately conservative, well-established names rather than a guess at whichever is
  // currently the newest flagship (OpenAI/Google both ship new model names often enough that a
  // guessed "latest" one baked in here would likely be stale or simply wrong by the time this
  // runs) — this is only ever the SILENT fallback for a blank Model field; the picker in
  // admin-ai.ejs lists more choices, and typing a specific one always wins over this.
  const DEFAULT_MODELS = {
    anthropic: 'claude-opus-5',
    ollama: 'llama3.1',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-flash',
  };
  const validProviders = Object.keys(DEFAULT_MODELS);
  const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const suggestionsMode = [0, 1, 2].includes(Number(suggestions_mode)) ? Number(suggestions_mode) : 0;
  const resolvedProvider = validProviders.includes(provider) ? provider : 'ollama';
  const resolvedModel = (model || '').trim() || DEFAULT_MODELS[resolvedProvider];
  const resolvedEffort = validEfforts.includes(effort) ? effort : 'medium';
  // Only meaningful for Ollama — cleared out for every other provider rather than left stale, so
  // the settings row never has a base_url sitting around that nothing reads. Left blank, this
  // defaults to the bundled docker-compose.yml service's own hostname rather than the adapter's
  // own bare-localhost fallback (127.0.0.1, meaningless from inside THIS container, which has no
  // Ollama of its own listening there) — a blank field otherwise silently pointed nowhere, which
  // is exactly what made a first "just enable Ollama and save" attempt fail to pull anything.
  const resolvedBaseUrl = resolvedProvider === 'ollama' ? ((base_url || '').trim() || 'http://ollama:11434') : null;

  await db.prepare(
    `UPDATE ai_settings SET enabled = ?, provider = ?, model = ?, effort = ?, api_key = ?, base_url = ?, suggestions_mode = ? WHERE id = 1`
  ).run(enabled ? 1 : 0, resolvedProvider, resolvedModel, resolvedEffort, newApiKey || null, resolvedBaseUrl, suggestionsMode);

  const changes = describeChanges(existing, {
    enabled: enabled ? 1 : 0, provider: resolvedProvider, model: resolvedModel, effort: resolvedEffort,
    api_key: newApiKey || null, base_url: resolvedBaseUrl, suggestions_mode: suggestionsMode,
  }, [
    { key: 'enabled', label: 'Enabled' },
    { key: 'provider', label: 'Provider' },
    { key: 'model', label: 'Model' },
    { key: 'effort', label: 'Effort' },
    { key: 'api_key', label: 'API key', secret: true },
    { key: 'base_url', label: 'Base URL' },
    { key: 'suggestions_mode', label: 'Suggested dashboards' },
  ]);
  await logSystemEvent(`"${req.user.username}" updated AI Assistant settings.${changes ? ` (${changes})` : ''}`);
  res.render('admin-ai', { settings: await loadAiSettings(), error: null, saved: true });
}));

// Whether the currently-saved model is already pulled into the currently-saved Ollama/OpenWebUI
// instance — polled by admin-ai.ejs's own script on page load (and after a save) to decide whether
// to show "Available", join an already-running pull in progress, or start a new one, without the
// admin ever needing to `docker exec ... ollama pull` by hand. `pulling: true` specifically covers
// the case where a PREVIOUS page load (or a different tab, or an admin who's since navigated away
// entirely) already kicked one off — see ollamaPullState.js for why that keeps running regardless.
router.get('/ai/ollama-status', asyncHandler(async (req, res) => {
  const settings = await loadAiSettings();
  if (settings.provider !== 'ollama' || !settings.model) return res.json({ available: false });
  const pull = ollamaPullState.getState();
  if (pull.status === 'pulling' && pull.model === settings.model) {
    return res.json({ available: false, pulling: true });
  }
  try {
    const available = await ollama.isModelAvailable(settings.base_url, null, settings.model);
    res.json({ available });
  } catch (err) {
    res.json({ available: false, error: err.message });
  }
}));

// Streams the model pull's own progress straight through, same shape as routes/setup.js's own
// import step (a plain chunked text response, __DONE__/__ERROR__ sentinels, consumed by a
// fetch()+ReadableStream reader — see admin-ai.ejs's inline script). The actual pull itself lives
// in ollamaPullState.js, entirely independent of this one request/response — closing this tab, or
// this whole request failing to write (the browser navigated away), only ever stops THIS response
// from hearing about further progress; it does not cancel the download. Safe to call whether this
// is the first request to notice the model is missing (starts a real pull) or a later one joining
// an already-running pull from an earlier page load (just tails it) — startPull() itself tells
// the two apart.
router.post('/ai/ollama-pull', asyncHandler(async (req, res) => {
  const settings = await loadAiSettings();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (settings.provider !== 'ollama' || !settings.model) {
    res.write('Nothing to pull — provider isn\'t Ollama, or no model is set.\n__ERROR__\n');
    return res.end();
  }

  ollamaPullState.startPull({ baseUrl: settings.base_url, model: settings.model });
  // Replay everything that already happened — whether THIS call just started the pull (nothing
  // to replay yet) or it's joining one already partway through from an earlier page load.
  ollamaPullState.getState().lines.forEach((line) => res.write(`${line}\n`));

  const current = ollamaPullState.getState();
  if (current.status !== 'pulling') {
    res.write(current.status === 'done' ? '\n__DONE__\n' : '\n__ERROR__\n');
    return res.end();
  }

  const unsubscribe = ollamaPullState.subscribe(
    (line) => res.write(`${line}\n`),
    (status) => {
      res.write(status === 'done' ? '\n__DONE__\n' : '\n__ERROR__\n');
      res.end();
    }
  );
  req.on('close', unsubscribe);
}));

// Every model currently pulled into the configured Ollama instance, with its on-disk size — for
// admin-ai.ejs's own "Downloaded models" list (a Delete button per row). Independent of which
// model ai_settings.model currently points at; lists everything Ollama itself has, not just the
// one this app happens to be configured to use.
router.get('/ai/ollama-models', asyncHandler(async (req, res) => {
  const settings = await loadAiSettings();
  if (settings.provider !== 'ollama') return res.json({ models: [] });
  try {
    const models = await ollama.listModelsDetailed(settings.base_url, null);
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
}));

// Removes one pulled model from disk via Ollama's own DELETE /api/delete — the UI counterpart to
// `docker exec ollama ollama rm <model>`. Deleting the model ai_settings.model currently points at
// is allowed same as it would be from the CLI — the next /ai/ollama-status check simply reports it
// missing again and admin-ai.ejs's own script offers to re-pull it, no special guard needed here.
router.post('/ai/ollama-models/delete', asyncHandler(async (req, res) => {
  const settings = await loadAiSettings();
  const model = (req.body.model || '').trim();
  if (settings.provider !== 'ollama' || !model) return res.status(400).json({ error: 'Nothing to delete.' });
  try {
    await ollama.deleteModel(settings.base_url, null, model);
    await logSystemEvent(`"${req.user.username}" deleted the Ollama model "${model}".`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
