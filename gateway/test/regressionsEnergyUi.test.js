// Regression tests for the Smart charging / agenda / admin changes of v0.34–v0.36: each one pins a
// behaviour that was reported broken or asked for, so it stays that way.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const { planSplit, sameTrip, withRest, makePlan } = require('../src/planner');
const { analyze } = require('../src/driving');
const { textOn, lanes } = require('../public/agenda-layout');
const { energyCfg } = require('../src/routes/settingsEnergy');
const { compareVersions, newestTag } = require('../src/versionCheck');
const { addressCandidates } = require('../src/agenda');
const { decodeEntities } = require('../src/caldav');

const H = 3600000;

// ---------------------------------------------------------------- Smart charging: split around a trip

test('split: only the trip + reserve before leaving (Kodiaq at 4%, 8.8 kWh trip)', () => {
  const ready = Date.parse('2026-10-06T04:30:00Z');
  const s = planSplit({ needKwh: 25, batteryKwh: 25.7, soc: 4, reservePct: 15, readyAtMs: ready, trip: { kwh: 8.8, backAtMs: ready + 2 * H, leaveMs: ready, title: 'Sev' } });
  assert.ok(s, 'expected a split');
  assert.ok(Math.abs(s.mustKwh - (8.8 + 3.855 - 1.028)) < 0.05, `must ${s.mustKwh}`);
  // before leaving there is room for what is left of the 25 kWh; the trip itself uses 8.8 kWh, so after
  // it is back the car needs that much more to be full again (v0.42: it used to stop at the 25 kWh)
  assert.ok(Math.abs(s.preMaxKwh - (25 - s.mustKwh)) < 0.01);
  assert.ok(Math.abs(s.energyAfterKwh - 3.855) < 0.05, `after the trip ${s.energyAfterKwh}`);
  assert.ok(Math.abs(s.restKwh - (1.028 + 25 - 3.855)) < 0.05, `rest ${s.restKwh}`);
  assert.deepEqual(s.away, [[ready, ready + 2 * H]]);
});

test('split: a trip that needs it all — all of it before leaving, what it used back after it is back', () => {
  const ready = Date.parse('2026-10-06T04:30:00Z');
  const trip = { kwh: 20, backAtMs: ready + H, title: 'Long' };
  // v0.56: this was "no split", so the plan stopped at leaving and planned nothing for after the trip
  const s = planSplit({ needKwh: 10, batteryKwh: 25.7, soc: 40, readyAtMs: ready, trip });
  assert.equal(s.mustKwh, 10);
  assert.equal(s.preMaxKwh, 0);
  assert.ok(Math.abs(s.restKwh - 20) < 0.01, `rest ${s.restKwh}`);
  // nothing left over before and nothing to make up after: one plan to the deadline, as before
  assert.equal(planSplit({ needKwh: 0.5, batteryKwh: 25.7, soc: 90, reservePct: 0, readyAtMs: ready, trip: { ...trip, kwh: 0.3 } }), null);
});

test('split: none when the car is not back after the deadline, or its level is unknown', () => {
  const ready = Date.parse('2026-10-06T04:30:00Z');
  const trip = { kwh: 20, backAtMs: ready + H, title: 'Long' };
  assert.equal(planSplit({ needKwh: 25, batteryKwh: 25.7, soc: 4, readyAtMs: ready, trip: { ...trip, kwh: 5, backAtMs: ready - H } }), null);
  assert.equal(planSplit({ needKwh: 25, batteryKwh: 25.7, soc: null, readyAtMs: ready, trip }), null);
});

test('split: your own departure time a little before the appointment counts as the same trip', () => {
  const ready = Date.parse('2026-10-06T04:30:00Z');
  assert.equal(sameTrip({ readyAt: ready + 11 * 60000 }, ready), true); // 06:41 vs 06:30
  assert.equal(sameTrip({ readyAt: ready + 4 * H }, ready), false);
  assert.equal(sameTrip(null, ready), false);
});

test('split plan: the rest never lands while the car is away, and the total is what fits', () => {
  const t0 = Date.parse('2026-10-05T16:00:00Z');
  const slots = [];
  for (let i = 0; i < 36; i++) {
    const s = t0 + i * H;
    const h = new Date(s).getUTCHours();
    slots.push({ start: new Date(s).toISOString(), end: new Date(s + H).toISOString(), price: h < 3 ? 0.3 : h >= 9 && h < 13 ? 0.2 : 0.4, pvKw: h >= 9 && h < 13 ? 7 : 0 });
  }
  const ready = Date.parse('2026-10-06T04:30:00Z');
  const back = Date.parse('2026-10-06T06:30:00Z');
  const split = planSplit({ needKwh: 25, batteryKwh: 25.7, soc: 4, readyAtMs: ready, trip: { kwh: 8.8, backAtMs: back, leaveMs: ready, title: 'Sev' } });
  const args = { nowMs: t0, readyAtMs: ready, needKwh: split.mustKwh, slots, mode: 'plan', minKw: 4.16, maxKw: 11, solarTrust: 'expected', priceCap: 0.7, insufficient: 'stop' };
  const plan = withRest(makePlan(args), args, slots, split, ready);
  // must + the rest to be full again after the 8.8 kWh trip
  assert.ok(Math.abs(plan.kwh - (split.mustKwh + split.restKwh)) < 0.1, `planned ${plan.kwh}`);
  for (const s of [...plan.split.restSlots, ...plan.split.preSlots]) assert.ok(!(Date.parse(s.start) < back && Date.parse(s.end) > ready), `charging while away: ${s.start}`);
  // before leaving: the must part, plus at most what still fits (here the night is dearer than the sun after it is back)
  const beforeKwh = [...plan.split.mustSlots, ...plan.split.preSlots].reduce((a, s) => a + s.kwh, 0);
  assert.ok(beforeKwh <= split.mustKwh + split.preMaxKwh + 0.05);
  assert.ok(Math.abs(plan.split.mustSlots.reduce((a, s) => a + s.kwh, 0) - split.mustKwh) < 0.05);
});

// ---------------------------------------------------------------- Driving: battery before odometer

test('driving: an ordinary trip is unchanged by the lag correction', () => {
  const T = (h, m) => Date.parse(`2026-10-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const r = analyze([
    { t: T(8, 0), soc: 100, odometer_km: 500 },
    { t: T(8, 30), soc: 85, odometer_km: 515 },
  ], { capacityKwh: 25.7, type: 'phev' });
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].socFrom, 100);
  assert.equal(r.trips[0].socTo, 85);
  assert.equal(r.trips[0].minutes, 30);
});

test('driving: charging at home before leaving is not mistaken for the drive', () => {
  const T = (h, m) => Date.parse(`2026-10-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const r = analyze([
    { t: T(6, 0), soc: 40, odometer_km: 500 },
    { t: T(7, 0), soc: 90, odometer_km: 500, charging: 1 },
    { t: T(7, 30), soc: 90, odometer_km: 500 },
    { t: T(8, 0), soc: 70, odometer_km: 520 },
  ], { capacityKwh: 25.7, type: 'phev' });
  const last = r.trips[r.trips.length - 1];
  assert.equal(last.socFrom, 90);
  assert.equal(last.socTo, 70);
});

// ---------------------------------------------------------------- Agenda layout

test('agenda: text is black on bright calendar colours and white on dark ones', () => {
  assert.equal(textOn('#66dd33'), '#111'); // the bright green that was unreadable
  assert.equal(textOn('#3b82c4'), '#fff');
  assert.equal(textOn('#ffffff'), '#111');
  assert.equal(textOn('nonsense'), '#fff');
});

test('agenda: overlapping appointments get lanes, separate ones keep the full width', () => {
  const L = lanes([
    { id: 'a', start: '2026-10-06T12:00:00Z', end: '2026-10-06T14:00:00Z' },
    { id: 'b', start: '2026-10-06T13:00:00Z', end: '2026-10-06T17:00:00Z' },
    { id: 'c', start: '2026-10-06T18:00:00Z', end: '2026-10-06T19:00:00Z' },
  ]);
  const by = Object.fromEntries(L.map((x) => [x.item.id, x]));
  assert.equal(by.a.lanes, 2); assert.equal(by.b.lanes, 2);
  assert.notEqual(by.a.lane, by.b.lane);
  assert.equal(by.c.lanes, 1); assert.equal(by.c.lane, 0);
});

test('agenda: an address with a name in front still gets candidates the geocoder finds', () => {
  const c = addressCandidates('Coöperatie VGZ Nieuwe Stationsstraat 12, 6811 KS Arnhem, Nederland');
  assert.ok(c.includes('Nieuwe Stationsstraat 12, 6811 KS Arnhem'));
  assert.ok(c.includes('6811 KS Arnhem'));
  assert.ok(c.length <= 7, 'stays polite to Nominatim');
});

test('agenda: "&amp;" in a calendar name shows as "&"', () => {
  assert.equal(decodeEntities('Dave &amp; Elly'), 'Dave & Elly');
});

// ---------------------------------------------------------------- Settings

test('settings: the agenda ready margin shows its own value, also 0', () => {
  const cfg = energyCfg({ ready_margin_min: 0, margin_km: 10, default_kwh_per_km: 0.2 }, { ready_margin_min: 15, default_kwh_per_km: 0.18 });
  assert.equal(cfg.ready_margin_min, 0);
  assert.equal(cfg.default_kwh_per_km, 0.18);
  assert.equal(cfg.margin_km, 10);
});

test('update notice: several tags at once pick the newest by number', () => {
  assert.equal(newestTag([{ name: 'v0.33.1-alpha.1' }, { name: 'v0.36.3-alpha.1' }, { name: 'v0.34.0-alpha.1' }]), 'v0.36.3-alpha.1');
  assert.ok(compareVersions('0.36.10-alpha.1', '0.36.9-alpha.1') > 0);
});

// ---------------------------------------------------------------- Administration tabs and menu

function renderTabs({ isAdmin, canEditSettings = false, canViewCharging = false, canViewTranslations = false, modulesOn = ['charging', 'ai'], multiLang = true }) {
  const file = path.join(__dirname, '..', 'src', 'views', 'partials', 'tabs-admin.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), {
    active: 'general', t: (k) => k, currentUser: { isAdmin }, multiLang,
    canEdit: (k) => (k === 'settings' ? canEditSettings : false),
    canView: (k) => (k === 'charging' ? canViewCharging : k === 'translations' ? canViewTranslations : false),
    moduleOn: (k) => modulesOn.includes(k),
  }, { filename: file });
}

test('administration: an admin sees every tab, Settings, Energy & charging and Translations included', () => {
  const html = renderTabs({ isAdmin: true, canEditSettings: true, canViewCharging: true, canViewTranslations: true });
  for (const href of ['/admin/general', '/settings', '/settings/energy', '/admin/users', '/admin/languages', '/translations', '/admin/ai']) {
    assert.ok(html.includes(`href="${href}"`), `missing ${href}`);
  }
});

test('administration: without admin rights only the tabs you may use', () => {
  const html = renderTabs({ isAdmin: false, canViewCharging: true });
  assert.ok(html.includes('href="/settings/energy"'));
  assert.ok(!html.includes('href="/admin/users"'));
  assert.ok(!html.includes('href="/settings"'));
  assert.ok(!html.includes('href="/translations"'));
});

test('administration: Energy & charging only with Smart charging on; Translations only with a second language', () => {
  const html = renderTabs({ isAdmin: true, canEditSettings: true, canViewCharging: true, canViewTranslations: true, modulesOn: [], multiLang: false });
  assert.ok(!html.includes('href="/settings/energy"'));
  assert.ok(!html.includes('href="/translations"'));
});

test('side menu: no Translations and no separate Settings entry; Administration in the account menu', () => {
  const head = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'partials', 'head.ejs'), 'utf8');
  assert.ok(!/<a href="\/translations"/.test(head), 'Translations belongs under Administration');
  assert.ok(!/<a href="\/settings" class=/.test(head), 'Settings is a tab under Administration');
  assert.ok(/adminHref/.test(head) && /t\('Administration'\)/.test(head));
  assert.ok(head.indexOf("'chargelog'") > head.indexOf('logActiveKeys'), 'Charge log sits under Logs');
});

test('agenda page: Sync sits left of Day / Week / Month / Year', () => {
  const v = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'agenda.ejs'), 'utf8');
  const sync = v.indexOf('id="ag-sync-now"');
  const views = v.indexOf('id="ag-views"');
  assert.ok(sync > 0 && views > 0 && sync < views);
});

test('advise/live switches live in Administration → Energy & charging, not on the overview pages', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', f), 'utf8');
  const planner = read('planner.ejs');
  assert.ok(!/Advise mode\./.test(planner), 'no advise banner on Smart charging');
  assert.ok(!/name="output"/.test(planner), 'no output switch on Smart charging');
  const em = read('energy-manager.ejs');
  assert.ok(!/'shadow'/.test(em), 'no shadow/live tag in the energy manager overview');
  assert.ok(!/action="\/energy-manager\/loads"/.test(em) && !/energy-load-form/.test(em), 'consumer settings are not on the overview');
  const se = read('settings-energy.ejs');
  assert.ok(/id="charging"[\s\S]*name="output"/.test(se), 'output (advise/live) under Energy & charging');
  assert.ok(/id="energy-manager"[\s\S]*energy-load-form/.test(se), 'consumers under Energy & charging');
});

// ---------------------------------------------------------------- v0.41: one look on every page

test('figures look the same everywhere: the shared .ls-tile, no hand-styled tiles', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', f), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const c of ['.ls-tiles', '.ls-tile', '.ls-tile-label', '.ls-tile-value', '.ls-tile-sub', '.subhead', '.section-nav', '.form-actions', '.segmented']) assert.ok(css.includes(c + ' {') || css.includes(c + ',') || css.includes(c + ' '), `style.css defines ${c}`);
  for (const f of ['planner.ejs', 'driving.ejs', 'energy.ejs', 'energy-load.ejs', 'energy-manager.ejs', 'vehicle-edit.ejs', 'ocpp-bridge-edit.ejs', 'learned.ejs']) {
    const v = read(f);
    assert.ok(v.includes('ls-tile'), `${f} uses the shared tiles`);
    assert.ok(!/text-transform:uppercase; letter-spacing:0\.04em;">' \+ (esc\()?label/.test(v), `${f} has no hand-styled tile label`);
  }
});

test('delete buttons are red (danger) and the long settings page has jump links', () => {
  const dir = path.join(__dirname, '..', 'src', 'views');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ejs'))) {
    assert.ok(!/class="btn-soft"><%- icon\('trash'\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')), `${f}: a delete button uses class="danger"`);
  }
  const se = fs.readFileSync(path.join(dir, 'settings-energy.ejs'), 'utf8');
  const nav = se.slice(se.indexOf('class="section-nav"'), se.indexOf('</nav>'));
  for (const id of ['prices', 'calendars', 'agenda-settings', 'day-types', 'charging', 'energy-manager']) {
    assert.ok(nav.includes(`href="#${id}"`), `jump link to #${id}`);
    assert.ok(se.includes(`id="${id}"`), `card #${id} exists`);
  }
});

test('energy manager overview stays compact: the day-by-day table lives on the consumer page', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', f), 'utf8');
  const em = read('energy-manager.ejs');
  assert.ok(!/In advised hours/.test(em), 'no per-day table on the overview');
  assert.ok(!/preserveAspectRatio="none"/.test(em), 'charts are drawn at their real width (no stretched text)');
  const el = read('energy-load.ejs');
  assert.ok(/id="el-daily"/.test(el) && /In advised hours/.test(el), 'per-day table on the consumer page');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'energyManager.js'), 'utf8');
  assert.ok(/dailyReport\(load, 14\)/.test(route), 'the consumer page gets the daily report');
});

test('a link to a card unfolds it, and a header row keeps its fold button at the end', () => {
  const cc = fs.readFileSync(path.join(__dirname, '..', 'public', 'card-collapse.js'), 'utf8');
  assert.ok(/hashchange/.test(cc) && /targeted\(card\)/.test(cc), 'unfolds the card a link points to');
  assert.ok(/hd\.head\.appendChild\(btn\)/.test(cc), 'header rows get the chevron at the end of the row');
});

test('split plan: a trip that needs it all — what it uses is planned back after it is back (v0.56)', () => {
  // nearly full (97%) before an 11.9 kWh drive at 08:28, back 10:22; the sun in the afternoon
  const t0 = Date.parse('2026-10-09T04:00:00Z');
  const slots = [];
  for (let i = 0; i < 30; i++) {
    const s = t0 + i * H;
    const h = new Date(s).getUTCHours();
    slots.push({ start: new Date(s).toISOString(), end: new Date(s + H).toISOString(), price: h >= 11 && h < 13 ? 0.21 : 0.35, pvKw: h >= 11 && h < 14 ? 5 : 0 });
  }
  const ready = Date.parse('2026-10-09T06:28:00Z');
  const back = Date.parse('2026-10-09T08:22:00Z');
  const split = planSplit({ needKwh: 0.8, batteryKwh: 26, soc: 97, reservePct: 0, readyAtMs: ready, trip: { kwh: 11.9, leaveMs: ready, backAtMs: back, title: 'Dentist' } });
  assert.ok(split, 'a split, so the plan goes on after the trip');
  const args = { nowMs: t0, readyAtMs: ready, needKwh: split.mustKwh, slots, mode: 'plan', minKw: 4.16, maxKw: 11, solarTrust: 'expected', priceCap: 0.55, insufficient: 'stop' };
  const plan = withRest(makePlan(args), args, slots, split, ready);
  const after = plan.split.restSlots.reduce((a, s) => a + s.kwh, 0);
  assert.ok(Math.abs(after - split.restKwh) < 0.1, `after the trip ${after} of ${split.restKwh}`);
  assert.ok(Math.abs(split.restKwh - 11.9) < 0.9, `what the trip uses (+ what was missing): ${split.restKwh}`);
  assert.ok(plan.split.restSlots.every((s) => Date.parse(s.start) >= back), 'not while it is away');
});
