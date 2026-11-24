// Administration home (/admin): the parts of Administration as tiles in groups, who may open each
// (the same rules as the old tab bar: admins everything, others only Settings, Energy & charging and
// Translations when their role allows it), and a live status line per tile with a warning when
// something needs attention. The detail pages use the same list for their compact navigation
// (partials/tabs-admin.ejs). Texts here are t() calls with a literal text: i18n.js reads this file for the catalog.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const nav = require('./navigation');

const GROUPS = [
  { key: 'access', icon: '🔐' },
  { key: 'system', icon: '🧰' },
  { key: 'notify', icon: '🔔' },
  { key: 'energy', icon: '⚡' },
  { key: 'ai', icon: '✨' },
];

const energyOn = (c) => (c.mod('charging') && c.canView('charging')) || (c.mod('energy') && c.canView('energy')) || (c.mod('energy_manager') && c.canView('energy_manager'));
const admin = (c) => c.isAdmin;

// kw = extra search words (Dutch and English), so "wachtwoord" finds Users.
const TILES = [
  { key: 'users', group: 'access', href: '/admin/users', icon: '👤', show: admin, kw: 'gebruikers accounts wachtwoord password uitschakelen' },
  { key: 'roles', group: 'access', href: '/admin/roles', icon: '🛡️', show: admin, kw: 'rollen rechten permissions toegang' },
  { key: 'security', group: 'access', href: '/admin/security', icon: '🔒', show: admin, kw: 'beveiliging sso pocket id geo landen blokkeren inlogpogingen' },
  { key: 'general', group: 'system', href: '/admin/general', icon: '🏷️', show: admin, kw: 'algemeen versie update database tech report' },
  { key: 'settings', group: 'system', href: '/settings', icon: '⚙️', show: (c) => c.canEdit('settings'), kw: 'instellingen weergave bewaren retentie heartbeat tijdzone' },
  { key: 'modules', group: 'system', href: '/admin/modules', icon: '🧩', show: admin, kw: 'modules aan uit onderdelen' },
  { key: 'backup', group: 'system', href: '/admin/backup', icon: '💾', show: admin, kw: 'back-up backup herstellen restore rclone' },
  { key: 'languages', group: 'system', href: '/admin/languages', icon: '🌐', show: admin, kw: 'talen taal standaardtaal' },
  { key: 'translations', group: 'system', href: '/translations', icon: '🔤', show: (c) => c.canView('translations') && c.multiLang, kw: 'vertalingen vertalen' },
  { key: 'notifications', group: 'notify', href: '/admin/notifications', icon: '🔔', show: admin, kw: 'meldingen kanalen regels templates push' },
  { key: 'energy', group: 'energy', href: '/settings/energy', icon: '⚡', show: energyOn, kw: 'energie laden prijzen agenda kalenders vakantie zon' },
  { key: 'ai', group: 'ai', href: '/admin/ai', icon: '✨', show: (c) => c.isAdmin && c.mod('ai'), kw: 'ai assistent ollama claude chatgpt gemini' },
  { key: 'mcp', group: 'ai', href: '/admin/mcp', icon: '🔌', show: admin, kw: 'mcp tokens assistent koppeling' },
];

// Labels and one-line descriptions (English keys, translated in the view and here).
function labels(t) {
  return {
    groups: { access: t('Access'), system: t('System'), notify: t('Notifications'), energy: t('Energy & charging'), ai: t('AI & integrations') },
    tiles: {
      users: [t('Users'), t('Accounts, passwords and who may log in.')],
      roles: [t('Access Roles'), t('What each role may see and change.')],
      security: [t('Security'), t('Single sign-on, login attempts and geo-blocking.')],
      general: [t('General'), t('Version, updates and the database.')],
      settings: [t('Settings'), t('Display, data retention and health monitoring.')],
      modules: [t('Modules'), t('Switch parts of LoxSuite on and off.')],
      backup: [t('Backups'), t('Automatic backups, offsite copy and restore.')],
      languages: [t('Languages'), t('Which languages there are and the default.')],
      translations: [t('Translations'), t('Translate the texts of LoxSuite.')],
      notifications: [t('Notifications'), t('Channels, rules and message templates.')],
      energy: [t('Energy & charging'), t('Prices, calendars, smart charging and consumers.')],
      ai: [t('AI Assistant'), t('The AI provider for the chat assistant.')],
      mcp: [t('MCP'), t('Let AI assistants read and set up LoxSuite.')],
    },
  };
}

// The tiles this user may open, with group, label and description: [{ key, group, href, icon, label, text, kw }]
function visibleTiles(locals) {
  const c = nav.context(locals);
  const t = locals.t || ((k) => k);
  const L = labels(t);
  return TILES.filter((x) => x.show(c)).map((x) => ({ key: x.key, group: x.group, href: x.href, icon: x.icon, label: L.tiles[x.key][0], text: L.tiles[x.key][1], kw: x.kw }));
}

// The groups with their visible tiles, in order; empty groups left out.
function groupsFor(locals) {
  const t = locals.t || ((k) => k);
  const L = labels(t);
  const tiles = visibleTiles(locals);
  return GROUPS.map((g) => ({ key: g.key, icon: g.icon, label: L.groups[g.key], tiles: tiles.filter((x) => x.group === g.key) })).filter((g) => g.tiles.length);
}

function ago(t, iso, nowMs = Date.now()) {
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  if (min < 1) return t('just now');
  if (min < 60) return t('{n} min ago', { n: min });
  if (min < 48 * 60) return t('{n} h ago', { n: Math.round(min / 60) });
  return t('{n} days ago', { n: Math.round(min / 1440) });
}

const count = async (sql, ...args) => Number((await db.prepare(sql).get(...args))?.n || 0);

// The newest backup zip without opening it (backup.listBackups() reads every zip's manifest).
function newestBackup(dir) {
  try {
    const name = fs.readdirSync(dir).filter((f) => /\.zip$/i.test(f)).sort().pop();
    return name ? fs.statSync(path.join(dir, name)).mtime.toISOString() : null;
  } catch { return null; }
}

// One status per tile: { text, warn }. warn = needs attention (shown in the tile and at the top).
const STATUS = {
  async users(t) {
    const n = await count('SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL');
    const off = await count('SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NOT NULL');
    return { text: [n === 1 ? t('1 user') : t('{n} users', { n }), off ? t('{n} disabled', { n: off }) : null] };
  },
  async roles(t) {
    const n = await count('SELECT COUNT(*) AS n FROM access_roles');
    const full = await count('SELECT COUNT(*) AS n FROM access_roles WHERE is_admin = 1');
    return { text: [n === 1 ? t('1 role') : t('{n} roles', { n }), t('{n} with full access', { n: full })] };
  },
  async security(t) {
    const geoBlock = require('./geoBlock');
    const geo = await geoBlock.loadSettings();
    const sso = await db.prepare('SELECT enabled FROM sso_settings WHERE id = 1').get();
    const codes = geo.countries.slice(0, 3).join(', ') + (geo.countries.length > 3 ? ` +${geo.countries.length - 3}` : '');
    const geoText = geo.mode === 'allowlist' ? t('geo-blocking: only {list}', { list: codes || '—' })
      : geo.mode === 'blocklist' ? t('geo-blocking: {n} countries blocked', { n: geo.countries.length }) : t('geo-blocking off');
    const refused = geoBlock.blockSummary().countries.reduce((a, r) => a + r.count, 0);
    const noDb = geo.mode !== 'off' && !fs.existsSync(geoBlock.mmdbPath());
    return {
      text: [sso?.enabled ? t('SSO on') : t('SSO off'), geoText, refused ? t('{n} refused today', { n: refused }) : null],
      warn: noDb ? t('Geo-blocking is on but there is no country database yet: nobody is blocked.') : null,
    };
  },
  async general(t) {
    const v = require('./versionCheck').getVersionStatus();
    if (v.updateAvailable) return { text: [`v${v.currentVersion}`], warn: t('Update available: v{v}', { v: v.latestVersion }) };
    return { text: [`v${v.currentVersion}`, v.latestVersion ? t('up to date') : null], ok: !!v.latestVersion };
  },
  async settings(t) {
    const s = await db.prepare('SELECT log_retention_days, heartbeat_url FROM gateway_settings WHERE id = 1').get();
    return { text: [t('logs kept {n} days', { n: s?.log_retention_days ?? '?' }), s?.heartbeat_url ? t('heartbeat on') : t('heartbeat off')] };
  },
  async modules(t) {
    const m = require('./modules');
    return { text: [t('{n} of {m} on', { n: m.MODULES.filter((x) => m.isOn(x.key)).length, m: m.MODULES.length })] };
  },
  async backup(t) {
    const backup = require('./backup');
    const s = (await backup.getSettings()) || {};
    const last = newestBackup(backup.BACKUP_DIR);
    const text = [last ? t('last backup {ago}', { ago: ago(t, last) }) : t('no backup yet')];
    let warn = null;
    if (s.last_status === 'error') warn = t('The last backup failed.');
    else if (s.rclone_enabled && s.rclone_last_status === 'error') warn = t('The offsite copy failed.');
    else if (!s.enabled) warn = t('Automatic backups are off.');
    else if (!last || Date.now() - Date.parse(last) > 2 * 86400000) warn = t('No backup in the last 2 days.');
    return { text, warn, ok: !warn };
  },
  async languages(t) {
    const i18n = require('./i18n');
    const on = i18n.enabledLanguages();
    const def = on.find((l) => l.isDefault) || on[0];
    return { text: [on.length === 1 ? t('1 language') : t('{n} languages', { n: on.length }), def ? t('default {name}', { name: def.name }) : null] };
  },
  async translations(t) {
    const i18n = require('./i18n');
    const langs = i18n.enabledLanguages().filter((l) => l.code !== i18n.BASE).map((l) => ({ name: l.name, pct: i18n.progress(l.code).pct }));
    const low = langs.filter((l) => l.pct < 100);
    return { text: langs.length ? langs.map((l) => `${l.name} ${l.pct}%`) : [t('no other languages on')], warn: low.length ? t('{lang} is not fully translated.', { lang: low.map((l) => l.name).join(', ') }) : null };
  },
  async notifications(t) {
    const ch = await count('SELECT COUNT(*) AS n FROM notification_channels WHERE enabled = 1');
    const rules = await count('SELECT COUNT(*) AS n FROM notification_rules WHERE enabled = 1 AND owner_user_id IS NULL');
    return {
      text: [ch === 1 ? t('1 channel') : t('{n} channels', { n: ch }), rules === 1 ? t('1 rule') : t('{n} rules', { n: rules })],
      warn: rules && !ch ? t('There are rules but no channel: nothing is sent.') : null,
    };
  },
  async energy(t, c) {
    const m = require('./modules');
    const on = ['charging', 'energy', 'energy_manager'].filter((k) => c.mod(k) && c.canView(k)).map((k) => t(m.MODULES.find((x) => x.key === k).label));
    return { text: [on.join(' · ')] };
  },
  async ai(t) {
    const s = await db.prepare('SELECT enabled, provider, model FROM ai_settings WHERE id = 1').get();
    if (!s?.enabled) return { text: [t('off')] };
    return { text: [t('on'), [s.provider, s.model].filter(Boolean).join(' · ')], ok: true };
  },
  async mcp(t) {
    const tokens = require('./mcp/tokens');
    const s = await tokens.settings();
    if (!s.enabled) return { text: [t('MCP off')] };
    const n = await count('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL');
    const write = tokens.writeAllowed(s);
    return {
      text: [t('MCP on'), n === 1 ? t('1 token') : t('{n} tokens', { n }), s.remote ? t('also from outside') : null],
      warn: write ? t('Assistants may change things now (writing is on).') : null,
    };
  },
};

// The groups with a status on every tile; a status that fails shows as unknown, never breaks the page.
async function hubFor(locals) {
  const t = locals.t || ((k) => k);
  const c = nav.context(locals);
  const groups = groupsFor(locals);
  await Promise.all(groups.flatMap((g) => g.tiles).map(async (x) => {
    try {
      const st = await STATUS[x.key](t, c);
      x.status = (st.text || []).filter(Boolean).join(' · ');
      x.warn = st.warn || null;
      x.ok = !!st.ok && !st.warn;
    } catch {
      x.status = t('status unknown');
      x.warn = null;
    }
  }));
  return groups;
}

module.exports = { GROUPS, TILES, visibleTiles, groupsFor, hubFor, ago };
