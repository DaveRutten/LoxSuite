// What LoxSuite tells about itself and its surroundings (notification trigger 'system_check', always in
// the bell — notifications.notifyBell): it was down, the database was unreachable, the HTTPS certificate runs out, the disk fills up, the live connection to a
// Miniserver is gone, an MQTT topic that normally comes every minute has gone quiet, the Loxone program
// was saved again (and app changes in /sys/custom), and security points. Every 10 minutes; each check
// has a key with its day or week, so it goes out once in that period.
//
// The checks are pure (status in -> { key, severity, title, message, link }); runSystemChecks gathers the
// status. Texts are English, like the other automatic notifications.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./wallboxSettings');
const { weekKey, made } = require('./energyChecks');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// Pure: LoxSuite was not running between lastAliveMs and startMs (more than 5 minutes).
function downtimeCheck(lastAliveMs, startMs) {
  if (!Number.isFinite(lastAliveMs) || startMs - lastAliveMs < 5 * MIN) return [];
  const min = Math.round((startMs - lastAliveMs) / MIN);
  return [made(`down|${lastAliveMs}`, min >= 60 ? 'warning' : 'info', ['LoxSuite was not running'],
    ['From about {from} for {dur} (a restart, an update or the server down). Nothing was measured, sent or learned in that time.', { from: fmt(lastAliveMs), dur: min >= 120 ? `${r1(min / 60)} h` : `${min} min` }], '/logs/system')];
}

// Pure: the database could not be reached from downSinceMs until backMs (more than 2 minutes).
function databaseCheck(downSinceMs, backMs, error = null) {
  if (!Number.isFinite(downSinceMs) || backMs - downSinceMs < 2 * MIN) return [];
  const min = Math.round((backMs - downSinceMs) / MIN);
  return [made(`db|${downSinceMs}`, min >= 15 ? 'warning' : 'info', ['LoxSuite: the database was unreachable'],
    error ? ['From {from} for {dur} LoxSuite could not reach its database ({e}). Settings could not be saved and nothing was stored in that time.', { from: fmt(downSinceMs), dur: min >= 120 ? `${r1(min / 60)} h` : `${min} min`, e: String(error).slice(0, 120) }]
      : ['From {from} for {dur} LoxSuite could not reach its database. Settings could not be saved and nothing was stored in that time.', { from: fmt(downSinceMs), dur: min >= 120 ? `${r1(min / 60)} h` : `${min} min` }], '/logs/system')];
}

// Pure: LoxSuite's own HTTPS certificate (/data/tls/cert.pem) runs out within 30 days, or has.
function certificateCheck(validToMs, nowMs, { file = '/data/tls/cert.pem' } = {}) {
  if (!Number.isFinite(validToMs)) return [];
  const days = Math.floor((validToMs - nowMs) / DAY);
  if (days > 30) return [];
  if (days < 0) return [made(`cert|expired|${dayKey(nowMs)}`, 'error', ['LoxSuite: the HTTPS certificate has expired'], ['The certificate in {f} expired on {d}: browsers and apps refuse the HTTPS address. Remove the file and restart LoxSuite to make a new one, or put your own certificate there.', { f: file, d: new Date(validToMs).toISOString().slice(0, 10) }], '/settings')];
  return [made(`cert|${weekKey(nowMs)}`, days <= 7 ? 'warning' : 'info', ['LoxSuite: the HTTPS certificate runs out soon'], ['The certificate in {f} is valid until {d} ({n} days). Renew it in time, or remove it and restart LoxSuite to make a new one.', { f: file, d: new Date(validToMs).toISOString().slice(0, 10), n: days }], '/settings')];
}

// Pure: free disk space of the data folder. { freeBytes, totalBytes }, dbBytes.
function diskCheck({ freeBytes, totalBytes } = {}, dbBytes = null, nowMs = Date.now()) {
  const out = [];
  if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
    const share = freeBytes / totalBytes, gb = freeBytes / 1e9;
    const p = { gb: r1(gb), pct: Math.round(share * 100) };
    if (share < 0.05 || gb < 1) out.push(made(`disk|${dayKey(nowMs)}`, 'error', ['LoxSuite: disk almost full'], ['Only {gb} GB ({pct} %) free where LoxSuite keeps its data. The database and backups stop when it is full.', p], '/admin/backup'));
    else if (share < 0.1 || gb < 3) out.push(made(`disk|${weekKey(nowMs)}`, 'warning', ['LoxSuite: disk filling up'], ['{gb} GB ({pct} %) free where LoxSuite keeps its data.', p], '/admin/backup'));
  }
  if (Number.isFinite(dbBytes) && dbBytes > 2e9) out.push(made(`dbsize|${weekKey(nowMs)}`, 'info', ['LoxSuite: the database is large'], ['The database is {gb} GB. Shorter retention (Settings → General) keeps it smaller.', { gb: r1(dbBytes / 1e9) }], '/settings'));
  return out;
}

// Pure: live connections to Miniservers that are not open for more than 10 minutes.
//   list [{ id, name, status, error }], mem.wsDownSince { id: ms }
function connectionChecks(list, mem, nowMs) {
  const out = [];
  mem.wsDownSince = mem.wsDownSince || {};
  for (const m of list || []) {
    const down = m.status !== 'open';
    if (!down) { delete mem.wsDownSince[m.id]; continue; }
    if (!mem.wsDownSince[m.id]) mem.wsDownSince[m.id] = nowMs;
    if (nowMs - mem.wsDownSince[m.id] >= 10 * MIN) {
      const p = { ms: m.name, min: Math.round((nowMs - mem.wsDownSince[m.id]) / MIN), e: m.error || '' };
      const msg = m.status === 'code_required'
        ? (m.error ? 'The live connection has been waiting for the login code for {min} minutes ({e}). Live values, the energy modules and smart charging miss its data.' : 'The live connection has been waiting for the login code for {min} minutes. Live values, the energy modules and smart charging miss its data.')
        : (m.error ? 'The live connection has been down for {min} minutes ({e}). Live values, the energy modules and smart charging miss its data.' : 'The live connection has been down for {min} minutes. Live values, the energy modules and smart charging miss its data.');
      out.push(made(`ws|${m.id}|${mem.wsDownSince[m.id]}`, 'warning', ['Miniserver {ms}: no live connection', p], [msg, p], '/miniservers'));
    }
  }
  return out;
}

// Pure: MQTT monitors that normally get a value every few minutes but have been quiet for long.
//   monitors [{ id, label, topic, lastMs, medianGapMs }]
function staleTopicChecks(monitors, nowMs) {
  const stale = (monitors || []).filter((m) => Number.isFinite(m.lastMs) && Number.isFinite(m.medianGapMs) && m.medianGapMs <= 10 * MIN
    && nowMs - m.lastMs > Math.max(30 * MIN, 10 * m.medianGapMs));
  if (!stale.length) return [];
  const parts = stale.slice(0, 5).map((m) => ({ t: '{topic} ({label}, last {min} min ago)', p: { topic: m.topic, label: m.label, min: Math.round((nowMs - m.lastMs) / MIN) } }));
  return [made(`stale|${stale.map((m) => m.id).sort().join(',')}|${dayKey(nowMs)}`, 'warning', ['MQTT: topics gone quiet'],
    stale.length > 5 ? ['{list} and {n} more — normally every few minutes. Is the device or the bridge that publishes them still running?', { list: { join: '; ', parts }, n: stale.length - 5 }]
      : ['{list} — normally every few minutes. Is the device or the bridge that publishes them still running?', { list: { join: '; ', parts } }], '/monitor')];
}

// Pure: the Loxone program in /prog: a newer sps_*.zip than seen before = saved from Loxone Config; files in
// /sys/custom = changes made in the app (they are lost when a program is loaded from a file).
//   prog { name, at } (newest), seen { name } (remembered), customCount
function programChecks(ms, prog, seen, customCount, nowMs) {
  const out = [];
  if (prog?.name && seen?.name && prog.name !== seen.name) {
    out.push(made(`prog|${ms.id}|${prog.name}`, 'info', ['Miniserver {ms}: program saved', { ms: ms.name }],
      ['A new program was loaded ({f}). Check that the objects LoxSuite uses still exist (Energy manager → Data quality, Mappings).', { f: prog.name }], '/miniservers'));
  }
  if (customCount > 0) {
    out.push(made(`custom|${ms.id}|${weekKey(nowMs)}`, 'info', ['Miniserver {ms}: changes made in the app', { ms: ms.name }],
      ['{n} file(s) in /sys/custom: changes made in the Loxone app. They are kept by Loxone Config, but lost when a program is loaded from a file.', { n: customCount }], '/miniservers'));
  }
  return out;
}

// Pure: security. { ssoEnabled, localLoginOutside, defaultAdminPassword, usersWithoutSso: [names] }
function securityChecks(sec, nowMs) {
  const out = [];
  const wk = weekKey(nowMs);
  if (sec.defaultAdminPassword) out.push(made(`defpw|${wk}`, 'error', ['Security: the first admin password is still in use'], ['The administrator still logs in with the password from ADMIN_PASSWORD (the first start). Change it under Profile.'], '/profile'));
  if (sec.ssoEnabled && sec.localLoginOutside) out.push(made(`local|${wk}`, 'info', ['Security: local login allowed from outside'], ['Single Sign-On is on, but users can still log in with a password from outside the local network. Turn that off under Administration → Security when everyone uses SSO.'], '/admin/security'));
  if (sec.ssoEnabled && (sec.usersWithoutSso || []).length) {
    out.push(made(`nosso|${(sec.usersWithoutSso || []).sort().join(',')}|${wk}`, 'info', ['Security: users without SSO'],
      sec.localLoginOutside ? ['{users} log in with a password only. From outside the local network that still works.', { users: sec.usersWithoutSso.join(', ') }]
        : ['{users} log in with a password only. From outside the local network that is blocked.', { users: sec.usersWithoutSso.join(', ') }], '/admin/users'));
  }
  return out;
}

// ------------------------------------------------------------------ gathering the status

const mem = {};
let lastProgCheck = 0;

async function gather(nowMs) {
  const out = [];
  // disk and database size
  try {
    const dbPath = require('./db/config').resolveDbConfig?.()?.dbPath || process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'gateway.db');
    const dir = fs.existsSync(path.dirname(dbPath)) ? path.dirname(dbPath) : process.cwd();
    const st = fs.statfsSync ? fs.statfsSync(dir) : null;
    const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null;
    out.push(...diskCheck(st ? { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize } : {}, dbBytes, nowMs));
  } catch { /* not readable here */ }
  // LoxSuite's own HTTPS certificate (made at the first start, or your own)
  try {
    const certFile = '/data/tls/cert.pem';
    if (fs.existsSync(certFile)) {
      const x = new (require('crypto').X509Certificate)(fs.readFileSync(certFile));
      out.push(...certificateCheck(Date.parse(x.validTo), nowMs, { file: certFile }));
    }
  } catch { /* not readable */ }
  // live connections
  const ws = require('./loxoneWebSocket');
  const mss = await db.prepare('SELECT id, name FROM miniservers').all().catch(() => []);
  out.push(...connectionChecks(mss.map((m) => ({ id: m.id, name: m.name, ...ws.getStatus(m.id) })), mem, nowMs));
  // MQTT topics gone quiet: the monitors of MQTT topics, the median gap of their last 30 values
  const mons = await db.prepare("SELECT id, label, mqtt_topic AS topic FROM monitors WHERE source_type = 'mqtt' AND enabled = 1").all().catch(() => []);
  const rows = [];
  for (const m of mons.slice(0, 200)) {
    const h = await db.prepare('SELECT recorded_at FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT 30').all(m.id).catch(() => []);
    if (h.length < 10) continue;
    const ts = h.map((x) => Date.parse(x.recorded_at)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    rows.push({ ...m, lastMs: ts[ts.length - 1], medianGapMs: gaps[Math.floor(gaps.length / 2)] });
  }
  out.push(...staleTopicChecks(rows, nowMs));
  // the Loxone program (once an hour): newest sps_*.zip in /prog and /sys/custom
  if (nowMs - lastProgCheck >= HOUR) {
    lastProgCheck = nowMs;
    const { fetchMiniserver } = require('./loxone');
    const seenAll = await settings.get('loxone_program_seen', {}).catch(() => ({}));
    for (const ms of await db.prepare('SELECT * FROM miniservers').all().catch(() => [])) {
      try {
        const res = await fetchMiniserver(ms, '/dev/fslist/prog');
        const text = await res.text();
        const names = [...text.matchAll(/sps_[\w.-]+\.zip/g)].map((x) => x[0]);
        if (!names.length) continue;
        const newest = names.sort().slice(-1)[0];
        let customCount = 0;
        try { const r2 = await fetchMiniserver(ms, '/dev/fslist/sys/custom'); customCount = (await r2.text()).split('\n').filter((l) => /\S+\.\w+/.test(l) && !/^\s*(\.|<)/.test(l)).length; } catch { customCount = 0; }
        out.push(...programChecks(ms, { name: newest }, seenAll[ms.id] || null, customCount, nowMs));
        seenAll[ms.id] = { name: newest, at: new Date(nowMs).toISOString() };
      } catch { /* the Miniserver doesn't answer this (firmware, rights): no check */ }
    }
    await settings.set('loxone_program_seen', seenAll).catch(() => {});
  }
  // security (the default password: once a day, bcrypt is slow on purpose)
  try {
    const sso = await db.prepare('SELECT enabled, local_login_disabled FROM sso_settings WHERE id = 1').get();
    const sec = { ssoEnabled: !!sso?.enabled, localLoginOutside: !!sso?.enabled && !sso?.local_login_disabled, usersWithoutSso: [], defaultAdminPassword: false };
    if (sec.ssoEnabled) {
      const users = await db.prepare('SELECT username FROM users WHERE disabled_at IS NULL AND password_hash IS NOT NULL').all().catch(() => []);
      sec.usersWithoutSso = users.map((u) => u.username);
    }
    if (process.env.ADMIN_PASSWORD && (!mem.pwCheckedAt || nowMs - mem.pwCheckedAt > DAY)) {
      mem.pwCheckedAt = nowMs;
      const name = process.env.ADMIN_USERNAME || 'admin';
      const u = await db.prepare('SELECT password_hash FROM users WHERE username = ?').get(name).catch(() => null);
      mem.defaultPw = !!(u?.password_hash && require('bcryptjs').compareSync(process.env.ADMIN_PASSWORD, u.password_hash));
    }
    sec.defaultAdminPassword = !!mem.defaultPw;
    out.push(...securityChecks(sec, nowMs));
  } catch { /* no SSO table yet */ }
  return out;
}

async function runSystemChecks(nowMs = Date.now()) {
  await settings.set('system_alive', { at: new Date(nowMs).toISOString() }).catch(() => {});
  const n = require('./notifications');
  for (const c of await gather(nowMs)) {
    await n.notifyBell('system_check', c.key, { title: c.title, message: c.message, i18n: c.i18n, severity: c.severity, sourceRef: c.link }).catch((e) => console.error(`[system checks] ${e.message}`));
  }
}

let timer = null;
let aliveTimer = null;
// Every minute: the alive mark. While the database can't be reached it fails; the first time it works
// again, the time it was away goes to the bell (the notification itself needs the database).
async function alive(nowMs = Date.now()) {
  try {
    await settings.set('system_alive', { at: new Date(nowMs).toISOString() });
  } catch (e) {
    if (!mem.dbDownSince) { mem.dbDownSince = nowMs; mem.dbError = e.message; }
    return;
  }
  if (mem.dbDownSince) {
    const list = databaseCheck(mem.dbDownSince, nowMs, mem.dbError);
    mem.dbDownSince = null; mem.dbError = null;
    const n = require('./notifications');
    for (const c of list) await n.notifyBell('system_check', c.key, { title: c.title, message: c.message, i18n: c.i18n, severity: c.severity, sourceRef: c.link }).catch(() => {});
  }
}
async function startSystemChecks() {
  if (timer) return;
  // was it down? (the last "alive" mark from before this start)
  const prev = await settings.get('system_alive', null).catch(() => null);
  const startMs = Date.now();
  const n = require('./notifications');
  for (const c of downtimeCheck(prev?.at ? Date.parse(prev.at) : NaN, startMs)) await n.notifyBell('system_check', c.key, { title: c.title, message: c.message, i18n: c.i18n, severity: c.severity, sourceRef: c.link }).catch(() => {});
  await settings.set('system_alive', { at: new Date(startMs).toISOString() }).catch(() => {});
  aliveTimer = setInterval(() => alive().catch(() => {}), MIN);
  aliveTimer.unref?.();
  timer = setInterval(() => runSystemChecks().catch((e) => console.error(`[system checks] ${e.message}`)), 10 * MIN);
  timer.unref?.();
  setTimeout(() => runSystemChecks().catch((e) => console.error(`[system checks] ${e.message}`)), 5 * MIN).unref?.();
}
function stopSystemChecks() { clearInterval(timer); clearInterval(aliveTimer); timer = null; aliveTimer = null; }

module.exports = { downtimeCheck, databaseCheck, certificateCheck, alive, _mem: mem, diskCheck, connectionChecks, staleTopicChecks, programChecks, securityChecks, runSystemChecks, startSystemChecks, stopSystemChecks };
