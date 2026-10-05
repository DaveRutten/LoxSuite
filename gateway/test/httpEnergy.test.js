// The energy pages through the real server, with the energy modules switched on: every page renders
// (no "[object Promise]"), the Administration tabs are there, and saving "ready this long before
// leaving" as 0 shows 0 again (it used to come back as 15).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 15584;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-httpenergy-'));
const DB_PATH = path.join(dir, 'test.db');
let child;

before(async () => {
  // a database with the energy modules on, made before the server starts
  Object.assign(process.env, { DB_PATH, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin12345678', SESSION_SECRET: 'httpEnergy-secret' });
  const db = require('../src/db');
  await db.init();
  const now = new Date().toISOString();
  for (const k of ['energy', 'vehicles', 'charging', 'ocpp', 'energy_manager']) await db.upsert('app_modules', { module_key: k, enabled: 1, updated_at: now }, ['module_key']);
  await db.close();

  child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), SESSION_SECRET: 'httpEnergy-secret', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin12345678', BACKUP_DIR: path.join(dir, 'backups') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 25000);
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; if (buf.includes('LoxSuite listening on port')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${buf}`)); });
  });
});

after(() => { if (child && !child.killed) child.kill('SIGTERM'); });

async function login() {
  const page = await fetch(`${BASE}/login`);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]*)"/)[1];
  const res = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: `username=admin&password=admin12345678&_csrf=${encodeURIComponent(csrf)}` });
  assert.equal(res.status, 302);
  return res.headers.get('set-cookie') ? res.headers.get('set-cookie').split(';')[0] : cookie;
}

test('energy pages render with the modules on', async () => {
  const cookie = await login();
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 7 * 86400000).toISOString();
  const pages = ['/planner', '/planner/status.json', '/agenda', `/agenda/items.json?from=${from}&to=${to}`, '/settings/energy', '/learned', '/vehicles', '/driving', '/energy', '/energy-manager', '/ocpp', '/planner/log', '/translations'];
  const failures = [];
  for (const p of pages) {
    const res = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const body = await res.text();
    if (res.status !== 200) failures.push(`${p} -> HTTP ${res.status}`);
    else if (/\[object Promise\]/.test(body)) failures.push(`${p} -> unresolved Promise`);
  }
  assert.deepEqual(failures, []);
});

test('Administration: Settings and Energy & charging are tabs; the agenda page loads its layout helpers', async () => {
  const cookie = await login();
  const html = await (await fetch(`${BASE}/settings/energy`, { headers: { Cookie: cookie } })).text();
  assert.ok(/<div class="tabs">[\s\S]*href="\/admin\/general"[\s\S]*href="\/settings"[\s\S]*href="\/settings\/energy" class="active"/.test(html));
  const agenda = await (await fetch(`${BASE}/agenda`, { headers: { Cookie: cookie } })).text();
  assert.ok(agenda.includes('/agenda-layout.js'));
  const js = await fetch(`${BASE}/agenda-layout.js`);
  assert.equal(js.status, 200);
});

test('ready this long before leaving: 0 is saved and shown as 0', async () => {
  const cookie = await login();
  const page = await (await fetch(`${BASE}/settings/energy`, { headers: { Cookie: cookie } })).text();
  const csrf = (page.match(/name="_csrf" value="([^"]*)"/) || page.match(/name="csrf-token" content="([^"]*)"/))[1];
  const res = await fetch(`${BASE}/agenda/settings`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}&tags=%23auto&margin_km=10&geo=1&ready_margin_min=0&climate_mode=log&climate_lead_min=20`,
  });
  assert.equal(res.status, 302);
  const again = await (await fetch(`${BASE}/settings/energy`, { headers: { Cookie: cookie } })).text();
  assert.ok(/name="ready_margin_min" value="0"/.test(again), 'expected value="0"');
});
