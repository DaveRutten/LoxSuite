// The single highest-value test added for the async db-facade conversion (see the project's own
// db-backend plan): a missed `await` doesn't crash anything — it silently renders "[object
// Promise]" into a page or hangs a request forever. Neither of those shows up as a Node exception
// anywhere, so no amount of `node --check`/unit testing catches it; only an actual HTTP round trip
// through the real boot sequence does.
//
// Spawns the real `node src/server.js` as a child process (not supertest against an in-process
// app) — server.js has no exported "build the app without starting workers/listening" entry point
// of its own, and this exercises the exact same boot path (db.init(), every migration, every
// startX() background worker, the real session/CSRF/auth middleware stack) a production container
// actually runs, which is more faithful than reconstructing a partial app in-process would be.
// Points at an isolated :memory: database and a high, unlikely-to-collide port; no real MQTT broker
// is reachable, which is fine — every page below renders regardless of MQTT connection state, the
// same way a genuinely offline broker doesn't break the web UI in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 15582;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20000;

let child;

function waitForBoot() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not log "listening" within ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('LoxSuite listening on port')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server process exited early (code ${code}) before it finished booting:\n${buffer}`));
    });
  });
}

before(async () => {
  child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_PATH: ':memory:',
      PORT: String(PORT),
      SESSION_SECRET: 'httpSmoke-test-secret',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin12345678',
      // No MQTT_ADMIN_PASSWORD — dynamic-security bootstrap just logs a warning and skips itself,
      // same as any install that hasn't set it, rather than needing a real broker for this test.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForBoot();
});

after(() => {
  if (child && !child.killed) child.kill('SIGTERM');
});

function extractCsrf(html, cookieHeaderStyle) {
  const inputMatch = html.match(/name="_csrf" value="([^"]*)"/);
  if (inputMatch) return inputMatch[1];
  const metaMatch = html.match(/name="csrf-token" content="([^"]*)"/);
  return metaMatch ? metaMatch[1] : null;
}

async function loginAndGetCookie() {
  const loginPage = await fetch(`${BASE}/login`);
  const cookie = loginPage.headers.get('set-cookie').split(';')[0];
  const csrf = extractCsrf(await loginPage.text());
  const loginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `username=admin&password=admin12345678&_csrf=${encodeURIComponent(csrf)}`,
    redirect: 'manual',
  });
  assert.equal(loginRes.status, 302, 'login should redirect on success, not render an error page');
  return loginRes.headers.get('set-cookie') ? loginRes.headers.get('set-cookie').split(';')[0] : cookie;
}

test('GET /healthz responds ok without touching auth', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /login renders the login page', async () => {
  const res = await fetch(`${BASE}/login`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Log in'), 'login page should render its own title');
});

test('logging in with the seeded admin account succeeds and redirects', async () => {
  const cookie = await loginAndGetCookie();
  assert.ok(cookie, 'login should set a session cookie');
});

// Every top-level page an authenticated admin can reach, one GET each — the async-conversion
// equivalent of "does npm run build still work": a missed `await` anywhere in a route handler or
// anything it calls renders "[object Promise]" straight into the HTML instead of throwing, so a
// plain 200-status check alone wouldn't have caught the exact bug this test exists for.
const PAGES = [
  '/', '/miniservers', '/miniservers/data.json', '/monitor', '/monitor/series.json?ids=', '/monitor/current.json?ids=',
  '/mappings/mqtt-to-loxone', '/mappings/mqtt-to-loxone/data.json', '/mappings/loxone-to-mqtt', '/mappings/loxone-to-mqtt/data.json',
  '/mappings/commands', '/transformations', '/logs/mqtt', '/logs/loxone', '/logs/loxone-commands', '/logs/system', '/logs/notifications',
  '/dashboards', '/settings', '/settings/broker', '/settings/live-data-state-names', '/admin/general', '/admin/users', '/admin/roles',
  '/admin/security', '/admin/backup', '/admin/notifications', '/live-data', '/hardware', '/incoming/messages', '/incoming/clients',
  '/mqtt-users', '/mqtt-roles', '/profile', '/setup', '/help',
];

test('every top-level page renders 200 with no leaked unresolved promise', async () => {
  const cookie = await loginAndGetCookie();
  const failures = [];
  for (const p of PAGES) {
    const res = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const body = await res.text();
    if (res.status !== 200) failures.push(`${p} -> HTTP ${res.status}`);
    else if (/\[object Promise\]/.test(body)) failures.push(`${p} -> leaked an unresolved Promise into the rendered HTML`);
  }
  assert.deepEqual(failures, [], `Pages that failed:\n${failures.join('\n')}`);
});

test('creating a monitor persists through the async facade', async () => {
  const cookie = await loginAndGetCookie();
  const page = await fetch(`${BASE}/monitor`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await page.text());
  const createRes = await fetch(`${BASE}/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}&source_type=mqtt&label=HttpSmokeMonitor&topic=httpsmoke/test/topic`,
    redirect: 'manual',
  });
  assert.equal(createRes.status, 302);
  const listRes = await fetch(`${BASE}/monitor`, { headers: { Cookie: cookie } });
  const listHtml = await listRes.text();
  assert.ok(listHtml.includes('HttpSmokeMonitor'), 'newly created monitor should show up in the list');
});

test('creating a dashboard and a panel exercises the transaction path end to end', async () => {
  const cookie = await loginAndGetCookie();
  const page = await fetch(`${BASE}/dashboards`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await page.text());

  const createRes = await fetch(`${BASE}/dashboards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}&name=HttpSmokeDashboard`,
    redirect: 'manual',
  });
  assert.equal(createRes.status, 302);
  const dashboardUrl = createRes.headers.get('location');
  assert.ok(dashboardUrl && dashboardUrl.startsWith('/dashboards/'));

  const panelRes = await fetch(`${BASE}${dashboardUrl}/panels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}&panel_type=group_header&range=24h&description=HttpSmokeGroup`,
    redirect: 'manual',
  });
  assert.equal(panelRes.status, 302);

  const dashboardPage = await fetch(`${BASE}${dashboardUrl}`, { headers: { Cookie: cookie } });
  const dashboardHtml = await dashboardPage.text();
  assert.ok(dashboardHtml.includes('HttpSmokeGroup'), 'the panel created inside a db.transaction() should be visible on reload');
});

test('running a backup exercises the withRawConnection escape hatch end to end', async () => {
  const cookie = await loginAndGetCookie();
  const page = await fetch(`${BASE}/admin/backup`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await page.text());
  const runRes = await fetch(`${BASE}/admin/backup/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}`,
    redirect: 'manual',
  });
  assert.equal(runRes.status, 302);
  const listPage = await fetch(`${BASE}/admin/backup`, { headers: { Cookie: cookie } });
  const listHtml = await listPage.text();
  assert.ok(/backup-.*\.zip/.test(listHtml), 'a fresh backup .zip should be listed after running one');
});
