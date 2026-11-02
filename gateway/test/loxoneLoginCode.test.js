// The live connection (src/loxoneWebSocket.js) against a simulated Miniserver (helpers/fakeMiniserver.js): the
// login code of Loxone Config 17.3 (Multi-Factor Authentication) end to end, a wrong password that stays a wrong
// password, and the brake on refused logins — a Miniserver with the login code locks the user after 10 failed
// logins and mails him each time.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const { createFakeMiniserver } = require('./helpers/fakeMiniserver');
const { encrypt } = require('../src/secretCrypto');
const live = require('../src/loxoneWebSocket');

const sims = [];
const ids = [];

before(async () => { await initTestDb(); live._tuning.authRetryMs = 20; });
afterEach(async () => {
  ids.splice(0).forEach((id) => live.resetConnection(id));
  await Promise.all(sims.splice(0).map((s) => s.close()));
});
after(async () => { live._tuning.authRetryMs = 60000; await db.close(); });

async function startSim(opts) {
  const sim = await createFakeMiniserver(opts).listen();
  sims.push(sim);
  return sim;
}

async function addMiniserver(sim, { username = 'loxsuite', password = 'geheim' } = {}) {
  const id = await db.insertReturningId(
    'INSERT INTO miniservers (name, host, http_port, username, password, use_https) VALUES (?, ?, ?, ?, ?, ?)',
    [`Sim ${sim.port}`, '127.0.0.1', sim.port, username, encrypt(password), 0]
  );
  ids.push(id);
  return row(id);
}
const row = (id) => db.prepare('SELECT * FROM miniservers WHERE id = ?').get(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(15);
  }
}

test('a user without the login code logs in with the password as before: getjwt (web permission), no Basic auth, nothing kept', async () => {
  const sim = await startSim();
  const ms = await addMiniserver(sim);
  const result = await live.testConnection(ms);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(sim.tokenRequests, [{ user: 'loxsuite', permission: 2, otp: false }]);
  assert.equal(sim.basicAuthSeen, 0, 'getPublicKey and the websocket upgrade carry no password');
  const saved = await row(ms.id);
  assert.equal(saved.live_token, null);
  assert.equal(saved.live_needs_code, 0);
});

test('login code: the Miniserver mails a code, a wrong one is said, the right one gives a token that later logins use without a code', async () => {
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim);

  const asked = await live.testConnection(ms);
  assert.equal(asked.ok, false);
  assert.equal(asked.status, 'code_required');
  assert.match(asked.error, /asks for a login code/);
  assert.equal(asked.tech, 'getjwt 460 {otp{mail=sent, to=(text, 16), length=6, expiresIn=600, resendIn=30}}', 'the shape of the answer, not the address');
  assert.ok(asked.otp.sentAt && asked.otp.until && asked.otp.resendAt);
  assert.equal(asked.otp.to, 'l***@example.com', 'the masked address, for the code step');
  assert.equal(sim.mails.length, 1);
  assert.equal((await row(ms.id)).live_needs_code, 1);

  const wrong = sim.mails[0].code === '123456' ? '654321' : '123456';
  const wrongRes = await live.loginWithCode(await row(ms.id), wrong);
  assert.equal(wrongRes.status, 'code_required');
  assert.equal(wrongRes.error, 'Wrong code. 4 attempts left.');
  assert.equal(wrongRes.otp.until, asked.otp.until, 'the mailed code stays the one to use');
  assert.equal(wrongRes.otp.to, 'l***@example.com');
  assert.equal(sim.mails.length, 1, 'a wrong code mails nothing');

  const ok = await live.loginWithCode(await row(ms.id), sim.mails[0].code);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.status, 'open');
  assert.deepEqual(sim.tokenRequests.at(-1), { user: 'loxsuite', permission: 4, otp: true });
  // As the Miniserver's own web interface: an HMAC-SHA256 of the digits, never the code itself.
  assert.ok(sim.otpParams.every((x) => /^[0-9a-f]{64}$/.test(x)), sim.otpParams.join());
  const saved = await row(ms.id);
  assert.match(saved.live_token, /^enc:v1:/, 'the token is kept encrypted');
  assert.ok(new Date(saved.live_token_valid_until) > new Date(Date.now() + 20 * 86400000));

  // A restart of LoxSuite (or a dropped connection): in with the token, no code, no mail.
  live.resetConnection(ms.id);
  const again = await live.testConnection(await row(ms.id));
  assert.equal(again.ok, true, again.error);
  assert.equal(sim.tokenLogins, 1);
  assert.equal(sim.mails.length, 1);
  assert.equal(sim.tokenRequests.length, 3);
});

test('a wrong password stays a wrong password, also for a user with the login code, and is not tried again', async () => {
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim, { password: 'fout' });
  const result = await live.testConnection(ms);
  assert.equal(result.status, 'auth_failed');
  assert.match(result.error, /rejected the username or password \(code 401\)/);
  assert.equal(result.otp, null);
  assert.equal(result.tech, 'getjwt 401 {lastEdit, unix}');
  await sleep(200);
  assert.equal(sim.tokenRequests.length, 1);
  assert.equal(sim.mails.length, 0);
});

test('a refused token request is tried AUTH_TRIES times, slowly, and then left alone', async () => {
  const sim = await startSim({ tokenAnswer: 403 });
  const ms = await addMiniserver(sim);
  live.ensureConnection(ms);
  await waitUntil(() => live.getStatus(ms.id).status === 'auth_failed');
  await sleep(300);
  assert.equal(sim.tokenRequests.length, live.AUTH_TRIES, 'no more tries after that');
  const { error } = live.getStatus(ms.id);
  assert.match(error, /refused the login \(code 403\).*login code/);
  assert.match(error, /stopped trying by itself, so the Loxone user does not get locked/);
});

test('a refused saved login is tried AUTH_TRIES times and forgotten; then LoxSuite waits for "Send login code" instead of mailing', async () => {
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim);
  await live.testConnection(ms);
  assert.equal((await live.loginWithCode(await row(ms.id), sim.mails[0].code)).ok, true);

  sim.revokeTokens('loxsuite');
  live.resetConnection(ms.id);
  live.ensureConnection(await row(ms.id));
  await waitUntil(() => live.getStatus(ms.id).status === 'auth_failed');
  await sleep(300);
  assert.equal(sim.tokenLogins, live.AUTH_TRIES);
  assert.match(live.getStatus(ms.id).error, /no longer accepts LoxSuite's saved login \(code 401\)/);
  assert.equal(live.getStatus(ms.id).tech, 'authwithtoken 401');
  assert.equal((await row(ms.id)).live_token, null);

  // Test now / a restart: no login of its own (that would mail a code), but the code step.
  const sockets = sim.sockets;
  live.resetConnection(ms.id);
  const waiting = await live.testConnection(await row(ms.id));
  assert.equal(waiting.status, 'code_required');
  assert.match(waiting.error, /Send login code/);
  assert.equal(sim.sockets, sockets, 'the Miniserver was not contacted');
  assert.equal(sim.mails.length, 1);

  const sent = await live.sendLoginCode(await row(ms.id));
  assert.equal(sent.status, 'code_required');
  assert.equal(sim.mails.length, 2, 'a new code on request only');
  assert.equal((await live.loginWithCode(await row(ms.id), sim.mails[1].code)).ok, true);
});

test('the kept token is refreshed before it runs out', async () => {
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim);
  await live.testConnection(ms);
  assert.equal((await live.loginWithCode(await row(ms.id), sim.mails[0].code)).ok, true);
  sim.expireTokensIn(3600);
  live.resetConnection(ms.id);
  assert.equal((await live.testConnection(await row(ms.id))).ok, true);
  await waitUntil(() => sim.refreshes === 1);
  await waitUntil(async () => new Date((await row(ms.id)).live_token_valid_until) > new Date(Date.now() + 20 * 86400000));
});

test('the answers of a real Miniserver 17.3: 460 to 467 are the two-step codes; 401 {lastEdit, unix} stays a wrong password; the code goes as an HMAC; no secret in the detail', () => {
  const ask = (code, v) => live.otpAsked(v, { code });
  assert.equal(ask('401', { lastEdit: 1793600000, unix: 1793600000 }), null);
  assert.equal(ask('403', ''), null);
  for (const otp of [true, 1, 'email', { mail: 'sent', to: 'd***@example.com' }]) assert.equal(ask('460', { otp }).kind, 'asked', JSON.stringify(otp));
  assert.equal(ask(460, '').kind, 'asked', 'the code alone');
  assert.match(ask('460', { otp: { mail: 'sent' } }).message, /asks for a login code/);
  assert.equal(ask('460', { otp: { mail: 'sent' } }).mailed, true);
  assert.equal(ask('460', { otp: { mail: 'alreadySent' } }).message, 'A code was sent a moment ago. Use the code from that mail.');
  assert.equal(ask('460', { otp: { mail: 'alreadySent' } }).mailed, false);
  assert.match(ask('461', { otp: { reason: 'noMailer' } }).message, /could not mail the login code: no mail server is set up/);
  assert.match(ask('461', { otp: { reason: 'notRegistered' } }).message, /not registered with the Loxone mail service/);
  assert.match(ask('461', { otp: { reason: 'noConnection' } }).message, /no connection to the mail server/);
  assert.match(ask('461', { otp: { reason: 'quota' } }).message, /maximum number of mails/);
  assert.match(ask('461', { otp: { reason: 'smtp5' } }).message, /error smtp5/);
  assert.equal(ask('462', { otp: {} }).again, false, 'no address: back to the password');
  assert.match(ask('462', { otp: {} }).message, /no e-mail address for login codes/);
  assert.equal(ask('463', { otp: { attemptsLeft: 1 } }).message, 'Wrong code. 1 attempt left.');
  assert.equal(ask('463', { otp: { attemptsLeft: 3 } }).message, 'Wrong code. 3 attempts left.');
  assert.equal(ask('463', { otp: { attemptsLeft: 0 } }).message, 'Too many wrong codes. Send a new code.');
  assert.match(ask('463', { otp: {} }).message, /not right/);
  assert.equal(ask('464', { otp: { mail: 'sent' } }).message, 'This code has expired. The Miniserver has mailed a new one.');
  assert.equal(ask('464', { otp: { mail: 'sent' } }).mailed, true);
  assert.match(ask('464', { otp: { mail: 'failed', reason: 'quota' } }).message, /expired, and a new one could not be mailed: the Miniserver has reached/);
  assert.match(ask('465', { otp: {} }).message, /newest mail/);
  assert.equal(ask('466', { otp: { retryAfter: 300 } }).message, 'Too many wrong codes. Try again in 5 minutes.');
  assert.equal(ask('466', { otp: {} }).message, 'Too many wrong codes. Try again in 15 minutes.', 'the web interface waits 15 minutes by default');
  assert.equal(ask('466', { otp: { retryAfter: 30 } }).message, 'Too many wrong codes. Try again in 1 minute.');
  assert.equal(ask('467', { otp: {} }).again, false, 'refused: back to the password');
  // As the Miniserver's own web interface: HMAC-SHA256 of the digits with the getkey2 key, lower-case hex.
  assert.equal(live.otpHash('12 34 56', '3132'), require('crypto').createHmac('sha256', Buffer.from('3132', 'hex')).update('123456').digest('hex'));
  assert.equal(live.shapeOf('460', { otp: { code: '123456', ticket: 'abcdef0123456789', expiresIn: 600, mail: 'sent' } }), '460 {otp{code=(text, 6), ticket=(text, 16), expiresIn=600, mail=sent}}');
  assert.equal(live.shapeOf('200', { token: 'eyJ.secret', validUntil: 523000000 }), '200 {token=(text, 10), validUntil}');
  assert.equal(live.shapeOf('401', { lastEdit: 1793600000, unix: 1793600000 }), '401 {lastEdit, unix}');
  assert.equal(live.shapeOf('500', 'some text'), '500 (text)');
});

test('no e-mail address (462) is said and not tried again: no code can come', async () => {
  const sim = await startSim({ tokenAnswer: 462 });
  const ms = await addMiniserver(sim);
  const result = await live.testConnection(ms);
  assert.equal(result.status, 'auth_failed');
  assert.match(result.error, /no e-mail address for login codes/);
  await sleep(200);
  assert.equal(sim.tokenRequests.length, 1);
});

test('with the login code every other call to the Miniserver goes over the live connection, logged in with the token — never the password as Basic auth', async () => {
  const { fetchMiniserver, sendHttpVirtualInput } = require('../src/loxone');
  const { runDetailedCheck, checkMiniserver } = require('../src/healthcheck');
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim);
  await live.testConnection(ms);
  assert.equal((await live.loginWithCode(await row(ms.id), sim.mails[0].code)).ok, true);
  const logged = await row(ms.id);

  const version = await (await fetchMiniserver(logged, '/jdev/cfg/version', { timeoutMs: 4000 })).json();
  assert.equal(version.LL.value, '17.3.10.28');
  assert.deepEqual(await sendHttpVirtualInput(logged, 'Warmtepomp boost', '1'), { code: 200, value: '1' });
  assert.ok(sim.commands.includes('jdev/sps/io/Warmtepomp%20boost/1'), sim.commands.join());
  assert.equal((await (await fetchMiniserver(logged, '/jdev/sps/io/0f1e2d3c-0000-0000-ffff000000000001', { timeoutMs: 4000 })).json()).LL.value, '42');
  const structure = await (await fetchMiniserver(logged, '/data/LoxAPP3.json', { timeoutMs: 4000 })).json();
  assert.equal(structure.msInfo.miniserverType, 2, 'the structure file, announced twice as a real Miniserver does');
  assert.match(await (await fetchMiniserver(logged, '/dev/fsget/log/def.log', { timeoutMs: 4000 })).text(), /Miniserver started/);
  assert.match(await (await fetchMiniserver(logged, '/data/status', { timeoutMs: 4000 })).text(), /<Status>/);
  assert.equal((await fetchMiniserver(logged, '/data/nothing', { timeoutMs: 4000 })).status, 404, 'a refused file keeps its Loxone code');

  const detail = await runDetailedCheck(logged);
  assert.equal(detail.local.ok, true);
  assert.equal(detail.api.ok, true, detail.api.error);
  assert.equal(detail.api.version, '17.3.10.28');
  assert.equal(detail.logbook.ok, true, detail.logbook.error);
  await checkMiniserver(logged);
  const checked = await row(ms.id);
  assert.equal(checked.status, 'online', checked.last_error);
  assert.equal(checked.firmware_version, '17.3.10.28');

  assert.equal(sim.basicAuthSeen, 0, 'the password never went out as Basic auth');
  assert.equal(sim.mails.length, 1);
});

test('waiting for the login code: calls say LoxSuite is not logged in, the healthcheck says Auth failed, and no password goes out', async () => {
  const { fetchMiniserver } = require('../src/loxone');
  const { checkMiniserver } = require('../src/healthcheck');
  const sim = await startSim({ mfa: { loxsuite: true } });
  const ms = await addMiniserver(sim);
  await live.testConnection(ms);
  const waiting = await row(ms.id);
  await assert.rejects(fetchMiniserver(waiting, '/jdev/sps/io/x/1', { timeoutMs: 2000 }), /not logged in to this Miniserver: .*login code/);
  await checkMiniserver(waiting);
  const checked = await row(ms.id);
  assert.equal(checked.status, 'auth_failed');
  assert.match(checked.last_error, /login code/);
  assert.equal(sim.basicAuthSeen, 0);
  assert.equal(sim.mails.length, 1, 'no new code mailed by the healthcheck');
});
