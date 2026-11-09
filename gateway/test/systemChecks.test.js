// LoxSuite about itself (systemChecks.js): down time, disk, live connections, quiet MQTT topics, the Loxone
// program, security — the pure checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/systemChecks');

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 9, 8);

test('down time: only when LoxSuite was away for more than 5 minutes', () => {
  assert.deepEqual(sc.downtimeCheck(T0 - 3 * MIN, T0), []);
  const d = sc.downtimeCheck(T0 - 95 * MIN, T0);
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warning');
  assert.match(d[0].message, /for 95 min/);
  assert.deepEqual(sc.downtimeCheck(NaN, T0), [], 'first start: nothing');
});

test('disk: warning below 10 %, error below 5 % or 1 GB; a large database', () => {
  assert.deepEqual(sc.diskCheck({ freeBytes: 50e9, totalBytes: 100e9 }, 1e8, T0), []);
  assert.equal(sc.diskCheck({ freeBytes: 8e9, totalBytes: 100e9 }, null, T0)[0].severity, 'warning');
  assert.equal(sc.diskCheck({ freeBytes: 0.5e9, totalBytes: 100e9 }, null, T0)[0].severity, 'error');
  assert.equal(sc.diskCheck({}, 3e9, T0)[0].title, 'LoxSuite: the database is large');
});

test('live connection: only after 10 minutes not open, forgotten when it is back', () => {
  const mem = {};
  const list = [{ id: 1, name: 'MS1', status: 'connecting', error: 'timeout' }, { id: 2, name: 'MS2', status: 'open' }];
  assert.deepEqual(sc.connectionChecks(list, mem, T0), []);
  const c = sc.connectionChecks(list, mem, T0 + 11 * MIN);
  assert.equal(c.length, 1);
  assert.match(c[0].message, /11 minutes \(timeout\)/);
  assert.deepEqual(sc.connectionChecks([{ id: 1, name: 'MS1', status: 'open' }], mem, T0 + 12 * MIN), []);
  assert.equal(mem.wsDownSince[1], undefined);
});

test('MQTT topics that normally come every minute and have been quiet for long', () => {
  const mons = [
    { id: 1, label: 'Plug', topic: 'shellies/plug/power', lastMs: T0 - 47 * MIN, medianGapMs: MIN },
    { id: 2, label: 'Weather', topic: 'weather/daily', lastMs: T0 - 5 * 60 * MIN, medianGapMs: 60 * MIN },
    { id: 3, label: 'Fresh', topic: 'x/y', lastMs: T0 - 2 * MIN, medianGapMs: MIN },
  ];
  const c = sc.staleTopicChecks(mons, T0);
  assert.equal(c.length, 1);
  assert.match(c[0].message, /shellies\/plug\/power \(Plug, last 47 min ago\)/);
  assert.doesNotMatch(c[0].message, /weather/, 'an hourly topic is no "every minute" topic');
});

test('Loxone program: a newer program, app changes in /sys/custom', () => {
  const ms = { id: 1, name: 'MS1' };
  assert.deepEqual(sc.programChecks(ms, { name: 'sps_1.zip' }, null, 0, T0), [], 'first look: only remembered');
  const c = sc.programChecks(ms, { name: 'sps_2.zip' }, { name: 'sps_1.zip' }, 3, T0);
  assert.deepEqual(c.map((x) => x.key.split('|')[0]), ['prog', 'custom']);
});

test('the database unreachable: said once it is back, only when it was away for more than 2 minutes', () => {
  assert.deepEqual(sc.databaseCheck(T0, T0 + MIN), []);
  const d = sc.databaseCheck(T0, T0 + 22 * MIN, 'ECONNREFUSED');
  assert.equal(d[0].severity, 'warning');
  assert.match(d[0].message, /for 22 min LoxSuite could not reach its database \(ECONNREFUSED\)/);
});

test('the HTTPS certificate: a month ahead info, a week ahead warning, expired error', () => {
  const DAY = 86400000;
  assert.deepEqual(sc.certificateCheck(T0 + 60 * DAY, T0), []);
  assert.equal(sc.certificateCheck(T0 + 20 * DAY, T0)[0].severity, 'info');
  assert.equal(sc.certificateCheck(T0 + 5 * DAY, T0)[0].severity, 'warning');
  const x = sc.certificateCheck(T0 - DAY, T0)[0];
  assert.equal(x.severity, 'error');
  assert.match(x.title, /expired/);
});

test('notification texts are templates: made in the user\'s language, nested parts too', () => {
  const { fillText } = require('../src/energyChecks');
  const nl = require('../src/locales/nl.json');
  const tr = (k) => nl[k] ?? k;
  const c = sc.staleTopicChecks([{ id: 1, label: 'Plug', topic: 'shellies/p', lastMs: T0 - 47 * MIN, medianGapMs: MIN }], T0)[0];
  assert.equal(fillText(c.i18n.title.t, c.i18n.title.p, tr), 'MQTT: topics stil gevallen');
  assert.match(fillText(c.i18n.message.t, c.i18n.message.p, tr), /^shellies\/p \(Plug, laatst 47 min geleden\) — normaal/);
  assert.match(c.message, /^shellies\/p \(Plug, last 47 min ago\)/, 'the English text is kept as well');
  // every template of these checks has a Dutch text
  const all = [...sc.downtimeCheck(T0 - 95 * MIN, T0), ...sc.databaseCheck(T0, T0 + 30 * MIN, 'x'), ...sc.certificateCheck(T0 - 1, T0),
    ...sc.diskCheck({ freeBytes: 0.5e9, totalBytes: 100e9 }, 3e9, T0), ...sc.programChecks({ id: 1, name: 'MS' }, { name: 'b' }, { name: 'a' }, 2, T0),
    ...sc.securityChecks({ ssoEnabled: true, localLoginOutside: true, defaultAdminPassword: true, usersWithoutSso: ['a'] }, T0)];
  for (const x of all) for (const part of ['title', 'message']) assert.ok(x.i18n[part].t in nl, `${x.key} ${part}: ${x.i18n[part].t}`);
});

test('security: the first admin password, local login from outside, users without SSO', () => {
  const c = sc.securityChecks({ ssoEnabled: true, localLoginOutside: true, defaultAdminPassword: true, usersWithoutSso: ['admin'] }, T0);
  assert.deepEqual(c.map((x) => x.key.split('|')[0]), ['defpw', 'local', 'nosso']);
  assert.deepEqual(sc.securityChecks({ ssoEnabled: false, localLoginOutside: false, defaultAdminPassword: false, usersWithoutSso: [] }, T0), []);
});
