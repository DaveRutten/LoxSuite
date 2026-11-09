// What the search (Ctrl+K, the magnifier in the top bar) can find: every menu item, and the settings
// and sections on the pages where you set things up — read once from the page templates themselves
// (their h2/h3/summary headings), so a new section is findable without anyone keeping a list.
// A result for a section opens the page and jumps to that heading (public/search.js).
// A menu item whose module is off is found too, with where to switch it on.
const fs = require('fs');
const path = require('path');
const nav = require('./navigation');

// Pages with settings and sections worth finding: the template, where it is, who may open it.
const PAGES = [
  { view: 'settings-energy', href: '/settings/energy', where: ['Administration', 'Energy & charging'], module: 'charging', show: (c) => c.canView('charging') },
  { view: 'settings-general', href: '/settings', where: ['Administration', 'Settings'], show: (c) => c.canEdit('settings') },
  { view: 'settings', href: '/settings/broker', where: ['MQTT', 'Broker'], module: 'mqtt', show: (c) => c.canView('settings') },
  { view: 'admin-general', href: '/admin/general', where: ['Administration', 'General'], show: (c) => c.isAdmin },
  { view: 'admin-security', href: '/admin/security', where: ['Administration', 'Security'], show: (c) => c.isAdmin },
  { view: 'admin-notifications', href: '/admin/notifications', where: ['Administration', 'Notifications'], show: (c) => c.isAdmin },
  { view: 'admin-backup', href: '/admin/backup', where: ['Administration', 'Backups'], show: (c) => c.isAdmin },
  { view: 'admin-modules', href: '/admin/modules', where: ['Administration', 'Modules'], show: (c) => c.isAdmin },
  { view: 'profile', href: '/profile', where: ['Profile'], show: (c) => !!c.user },
  { view: 'app', href: '/app', where: ['App & push'], show: (c) => !!c.user },
  { view: 'energy', href: '/energy', where: ['Energy', 'Meters & consumption'], module: 'energy', show: (c) => c.canView('energy') },
  { view: 'planner', href: '/planner', where: ['Car & charging', 'Smart charging'], module: 'charging', show: (c) => c.canView('charging') },
  { view: 'agenda', href: '/agenda', where: ['Car & charging', 'Agenda & trips'], module: 'charging', show: (c) => c.canView('charging') },
  { view: 'vehicles', href: '/vehicles', where: ['Car & charging', 'Vehicles'], module: 'vehicles', show: (c) => c.canView('vehicles') },
  { view: 'driving', href: '/driving', where: ['Car & charging', 'Driving & costs'], module: 'vehicles', show: (c) => c.canView('vehicles') },
  { view: 'ocpp-bridges', href: '/ocpp', where: ['Car & charging', 'Charging allowance (OCPP)'], module: 'ocpp', show: (c) => c.canView('ocpp') },
  { view: 'energy-manager-modules', href: '/energy-manager/modules/heatpump', where: ['Energy', 'Heat pump'], module: 'energy_manager', show: (c) => c.canView('energy_manager') },
];

// Headings in a template: <h2|h3|summary ...> optionally followed by tags/icons, then <%= t('...') %>.
const HEADING = /<(h2|h3|summary)\b[^>]*>(?:\s*<(?!%)[^>]*>|\s*<%-[^%]*%>)*\s*<%=\s*t\('((?:[^'\\]|\\.)+)'/g;

let cache = null;
function headingsOf(view) {
  if (!cache) cache = new Map();
  if (cache.has(view)) return cache.get(view);
  let out = [];
  try {
    const src = fs.readFileSync(path.join(__dirname, 'views', `${view}.ejs`), 'utf8');
    const seen = new Set();
    for (const m of src.matchAll(HEADING)) {
      const key = m[2].replace(/\\'/g, "'");
      if (key.length < 3 || key.length > 70 || /[{}]/.test(key) || seen.has(key)) continue;
      seen.add(key);
      // the heat pump page: the tab a heading is on (data-tab="..." on an enclosing block, nearest before it)
      const before = src.slice(Math.max(0, m.index - 1500), m.index);
      const tab = [...before.matchAll(/data-tab="([a-z]+)"/g)].pop()?.[1] || null;
      out.push({ key, tab });
    }
  } catch { out = []; }
  cache.set(view, out);
  return out;
}

// The index for this user, translated: [{ label, where, href, find?, off? , kw? }]
function forUser(locals) {
  const t = locals.t || ((k) => k);
  const c = nav.context(locals);
  const list = [];
  for (const s of nav.build(locals, { all: true })) {
    for (const it of s.items) {
      if (it.off) {
        if (!c.isAdmin) continue;
        list.push({ label: t(it.label), where: t(s.label), href: `/admin/modules#mod-${it.module}`, off: true, kw: it.keywords });
      } else {
        list.push({ label: t(it.label), where: t(s.label), href: it.href, kw: it.keywords, page: true });
      }
    }
  }
  if (c.user) {
    list.push({ label: t('Profile'), where: '', href: '/profile', page: true, kw: 'profiel taal wachtwoord avatar' });
    list.push({ label: t('App & push'), where: '', href: '/app', page: true, kw: 'push telefoon installeren' });
  }
  for (const p of PAGES) {
    if (!p.show(c) || (p.module && !c.mod(p.module))) continue;
    const where = p.where.map((w) => t(w)).join(' › ');
    for (const h of headingsOf(p.view)) {
      list.push({ label: t(h.key), where, href: p.href + (h.tab ? `#${h.tab}` : ''), find: t(h.key) });
    }
  }
  return list;
}

module.exports = { forUser, headingsOf, PAGES };
