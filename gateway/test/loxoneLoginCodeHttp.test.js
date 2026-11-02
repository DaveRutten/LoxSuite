// The login code step (Multi-Factor Authentication, Loxone Config 17.3) through the real boot and routes: a
// Miniserver added with a user that has the login code, Test on its Edit page, the code step on that page, a wrong
// code, the right code — against the simulated Miniserver in helpers/fakeMiniserver.js. Spawns `node src/server.js`
// like httpSmoke.test.js (see there for why).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createFakeMiniserver } = require('./helpers/fakeMiniserver');

const PORT = 15585;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let sim;

before(async () => {
  sim = await createFakeMiniserver({ mfa: { loxsuite: true } }).listen();
  child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_PATH: ':memory:',
      PORT: String(PORT),
      SESSION_SECRET: 'loginCode-test-secret',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin12345678',
      BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-logincode-backups-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not boot')), 20000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('LoxSuite listening on port')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
});

after(async () => {
  if (child && !child.killed) child.kill('SIGTERM');
  if (sim) await sim.close();
});

const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]*)"/) || html.match(/name="csrf-token" content="([^"]*)"/) || [])[1];

async function login() {
  const page = await fetch(`${BASE}/login`);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `username=admin&password=admin12345678&_csrf=${encodeURIComponent(csrfOf(await page.text()))}`,
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  return res.headers.get('set-cookie') ? res.headers.get('set-cookie').split(';')[0] : cookie;
}

test('Edit page: Test asks for the login code, a wrong code is said, the right one logs in and keeps working without a code', async () => {
  const cookie = await login();
  const get = (p) => fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
  const postJson = async (p, body = {}) => (await fetch(`${BASE}${p}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  const csrf = csrfOf(await (await get('/miniservers')).text());
  const add = await fetch(`${BASE}/miniservers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf, name: 'MFA sim', host: '127.0.0.1', http_port: String(sim.port), username: 'loxsuite', password: 'geheim' }).toString(),
    redirect: 'manual',
  });
  assert.equal(add.status, 302);
  const rows = await (await get('/miniservers/data.json')).json();
  const id = (Array.isArray(rows) ? rows : rows.data).find((r) => r.name === 'MFA sim').id;

  const check = await postJson(`/miniservers/${id}/check`);
  assert.equal(check.live.status, 'code_required');
  assert.match(check.live.error, /login code/);
  assert.ok(sim.mails.length >= 1);

  const edit = await (await get(`/miniservers/${id}/edit`)).text();
  assert.match(edit, /id="edit-ms-login-code">/, 'the code step is shown (not hidden) on the Edit page');
  assert.match(edit, /autocomplete="off" data-bwignore data-1p-ignore data-lpignore="true"/);
  assert.doesNotMatch(edit, /\[object Promise\]/);

  assert.equal((await postJson(`/miniservers/${id}/login-code`, { code: 'abc' })).error, 'Enter the code from the mail of the Miniserver.');
  const code = sim.mails.at(-1).code;
  const wrong = await postJson(`/miniservers/${id}/login-code`, { code: code === '123456' ? '654321' : '123456' });
  assert.equal(wrong.status, 'code_required', JSON.stringify(wrong));
  assert.equal(wrong.error, 'Wrong code. 4 attempts left.');

  const ok = await postJson(`/miniservers/${id}/login-code`, { code });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.status, 'open');
  assert.equal(ok.otp, null);

  // Test again: in with the kept token, no new mail.
  const mails = sim.mails.length;
  const again = await postJson(`/miniservers/${id}/check`);
  assert.equal(again.live.ok, true, again.live.error);
  assert.equal(sim.mails.length, mails);
  assert.match(await (await get(`/miniservers/${id}/edit`)).text(), /id="edit-ms-login-code" hidden>/);

  // Never the code in the System log.
  const log = await (await get('/logs/system')).text();
  assert.match(log, /with the login code from its mail/);
  assert.doesNotMatch(log, new RegExp(code));
});
