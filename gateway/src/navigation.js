// The menu as one list: the sidebar, the phone bar, the breadcrumb above the page title and the search
// (Ctrl+K) all read it, so a page has one name and one place everywhere.
//
// Grouped by what you do at home, not by technique: Overview, Energy, Car & charging, Loxone, MQTT
// (folded by default), Administration. Page addresses stay as they were; only the menu changes.
//
// Per item: key, label (English, translated with t()), href, `match` (URL prefixes that belong to it;
// the longest matching prefix over all items wins, so /planner/log is Charge sessions and not Smart
// charging), `settings` (where its settings are: the "Settings" button next to the page title), `show(ctx)` (permission), `module` (the module it belongs to: when that is off the item
// is not in the menu, and search says where to switch it on), `keywords` (extra search words).
//
// ctx: { canView, canEdit, mod, isAdmin, user, mappingsHref, brokerHref, adminHref }

const SECTIONS = [
  {
    key: 'overview', label: 'Overview',
    items: [
      { key: 'home', label: 'Home', href: '/', exact: true, show: (c) => c.canView('dashboard'), keywords: 'dashboard start' },
      { key: 'notifications', label: 'Notifications', href: '/notifications', show: (c) => !!c.user, badge: 'unread', keywords: 'meldingen bel alerts' },
      { key: 'dashboards', label: 'My Dashboards', href: '/dashboards', module: 'monitor', show: () => true },
      { key: 'monitor', label: 'Charts', href: '/monitor', module: 'monitor', show: (c) => c.canView('monitor'), keywords: 'monitor grafieken history' },
    ],
  },
  {
    key: 'energy', label: 'Energy',
    items: [
      { key: 'energy-now', settings: '/settings/energy#energy-manager', label: 'Energy now', href: '/energy-manager', exact: true, match: ['/energy-manager/loads', '/energy-manager/devices', '/energy-manager/states'], module: 'energy_manager', show: (c) => c.canView('energy_manager'), keywords: 'energiemanager verbruikers consumers' },
      { key: 'heatpump', settings: '#instellingen', label: 'Heat pump', href: '/energy-manager/modules/heatpump', module: 'energy_manager', show: (c) => c.canView('energy_manager'), keywords: 'warmtepomp tapwater boiler legionella stooklijn' },
      { key: 'solar', settings: '#instellingen', label: 'Solar panels', href: '/energy-manager/modules/solar', module: 'energy_manager', show: (c) => c.canView('energy_manager'), keywords: 'zon pv omvormer teruglevering' },
      { key: 'own-energy', label: 'Self-consumption', href: '/energy/own', module: 'energy', show: (c) => c.canView('energy'), keywords: 'eigen energie zelfverbruik zelfvoorzienend' },
      { key: 'meters', settings: '/settings/energy#prices', label: 'Meters & consumption', href: '/energy', module: 'energy', show: (c) => c.canView('energy'), keywords: 'meters stroom gas verbruik prijzen' },
      { key: 'learning', label: 'What LoxSuite learned', href: '/energy-manager/learning', module: 'energy_manager', show: (c) => c.canView('energy_manager'), keywords: 'leren leer-dashboard nauwkeurigheid accuracy' },
    ],
  },
  {
    key: 'car', label: 'Car & charging',
    items: [
      { key: 'planner', settings: '/settings/energy#charging', label: 'Smart charging', href: '/planner', module: 'charging', show: (c) => c.canView('charging'), keywords: 'laden wallbox plan' },
      { key: 'agenda', settings: '/settings/energy#calendars', label: 'Agenda & trips', href: '/agenda', module: 'charging', show: (c) => c.canView('charging'), keywords: 'agenda ritten vertrek kalender' },
      { key: 'chargelog', label: 'Charge sessions', href: '/planner/log', module: 'charging', show: (c) => c.canView('charging'), keywords: 'laadlog laadsessies' },
      { key: 'driving', settings: '/settings/energy#prices', label: 'Driving & costs', href: '/driving', module: 'vehicles', show: (c) => c.canView('vehicles'), keywords: 'rijden kosten km verbruik e-flux extern laden' },
      { key: 'learned', label: 'Driving pattern', href: '/learned', module: 'charging', show: (c) => c.canView('charging'), keywords: 'geleerd rijpatroon' },
      { key: 'vehicles', label: 'Vehicles', href: '/vehicles', module: 'vehicles', show: (c) => c.canView('vehicles'), keywords: 'auto voertuigen' },
      { key: 'ocpp', label: 'Charging allowance (OCPP)', href: '/ocpp', module: 'ocpp', show: (c) => c.canView('ocpp'), keywords: 'ocpp laadvergoeding werkgever kosten' },
    ],
  },
  {
    key: 'loxone', label: 'Loxone',
    items: [
      { key: 'miniservers', label: 'Miniservers', href: '/miniservers', show: (c) => c.canView('miniservers') },
      { key: 'live-data', label: 'Loxone values', href: '/live-data', show: (c) => c.canView('live_data'), keywords: 'live data waarden' },
      { key: 'hardware', label: 'Hardware', href: '/hardware', show: (c) => c.canView('hardware'), keywords: 'extensions tree' },
      { key: 'logs-loxone', label: 'Miniserver log', href: '/logs/loxone', module: 'loxone_logs', show: (c) => c.canView('logs_loxone'), keywords: 'logboek log' },
    ],
  },
  {
    key: 'mqtt', label: 'MQTT', foldedByDefault: true,
    items: [
      { key: 'mappings', label: 'Mappings', href: (c) => c.mappingsHref, match: ['/mappings', '/transformations'], module: 'mqtt', show: (c) => !!c.mappingsHref, keywords: 'koppelingen transformaties commando' },
      { key: 'incoming', label: 'MQTT messages', href: '/incoming/messages', match: ['/incoming'], module: 'mqtt', show: (c) => c.canView('incoming'), keywords: 'live data berichten topics' },
      { key: 'incoming-clients', label: 'MQTT devices', href: '/incoming/clients', module: 'mqtt', show: (c) => c.canView('incoming'), keywords: 'clients apparaten activiteit' },
      { key: 'broker', label: 'Broker', href: (c) => c.brokerHref, match: ['/settings/broker', '/mqtt-users', '/mqtt-roles'], module: 'mqtt', show: (c) => !!c.brokerHref, keywords: 'mosquitto gebruikers rollen' },
      { key: 'logs-mqtt', label: 'MQTT log', href: '/logs/mqtt', module: 'mqtt', show: (c) => c.canView('logs_mqtt'), keywords: 'logboek broker' },
      { key: 'logs-loxone-commands', label: 'Command log', href: '/logs/loxone-commands', module: 'mqtt', show: (c) => c.canView('logs_loxone_commands'), keywords: 'loxone commando logboek' },
    ],
  },
  {
    key: 'admin', label: 'Administration',
    items: [
      { key: 'admin', label: 'Administration', href: (c) => c.adminHref, match: ['/admin', '/settings', '/translations', '/setup'], show: (c) => !!c.adminHref, keywords: 'beheer instellingen gebruikers rollen back-up modules' },
      { key: 'logs-system', label: 'System log', href: '/logs/system', show: (c) => c.canView('logs_system'), keywords: 'systeem logboek fouten' },
      { key: 'logs-notifications', label: 'Notification log', href: '/logs/notifications', show: (c) => c.canView('logs_notifications'), keywords: 'meldingen logboek verzonden' },
    ],
  },
];

const hrefOf = (it, c) => (typeof it.href === 'function' ? it.href(c) : it.href);

// Where the Administration link goes for this user: the first tab they may use.
function adminHrefFor(c) {
  if (c.isAdmin) return '/admin/general';
  if (c.canEdit('settings')) return '/settings';
  if ((c.mod('charging') && c.canView('charging')) || (c.mod('energy') && c.canView('energy')) || (c.mod('energy_manager') && c.canView('energy_manager'))) return '/settings/energy';
  if (c.canView('translations') && c.multiLang) return '/translations';
  return null;
}

function context(locals) {
  const canView = locals.canView || (() => false);
  const canEdit = locals.canEdit || (() => false);
  const mod = typeof locals.moduleOn === 'function' ? locals.moduleOn : () => true;
  const user = locals.currentUser || null;
  const c = { canView, canEdit, mod, user, isAdmin: !!user?.isAdmin, multiLang: !!locals.multiLang };
  c.mappingsHref = ['/mappings/mqtt-to-loxone', '/mappings/loxone-to-mqtt', '/mappings/commands', '/transformations']
    .find((h, i) => canView(['mqtt_to_loxone', 'loxone_to_mqtt', 'commands', 'transformations'][i])) || null;
  c.brokerHref = ['/settings/broker', '/mqtt-users', '/mqtt-roles'].find((h, i) => canView(['settings', 'mqtt_users', 'mqtt_roles'][i])) || null;
  c.adminHref = adminHrefFor(c);
  return c;
}

// The menu for this user: sections with the items they may see and whose module is on.
// With `all`, also the items whose module is off (marked off: true) — for search.
function build(locals, { all = false } = {}) {
  const c = context(locals);
  return SECTIONS.map((s) => ({
    key: s.key, label: s.label, foldedByDefault: !!s.foldedByDefault,
    items: s.items.filter((it) => it.show(c) && hrefOf(it, c) && (all || !it.module || c.mod(it.module)))
      .map((it) => ({ key: it.key, label: it.label, href: hrefOf(it, c), exact: !!it.exact, match: it.match || [], badge: it.badge || null, settings: it.settings || null, keywords: it.keywords || '', module: it.module || null, off: !!(it.module && !c.mod(it.module)) })),
  })).filter((s) => s.items.length);
}

// The item (and its section) a path belongs to: the longest matching href/prefix wins.
function current(sections, path) {
  let best = null, len = -1;
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  for (const s of sections) {
    for (const it of s.items) {
      const own = it.href.split(/[?#]/)[0];
      const cands = it.exact ? [{ x: own, exact: true }] : [{ x: own }];
      for (const m of it.match) cands.push({ x: m });
      for (const { x, exact } of cands) {
        const hit = exact ? p === x : (x === '/' ? p === '/' : p === x || p.startsWith(`${x}/`));
        if (hit && x.length > len) { best = { section: s, item: it }; len = x.length; }
      }
    }
  }
  return best;
}

module.exports = { SECTIONS, build, current, context };
