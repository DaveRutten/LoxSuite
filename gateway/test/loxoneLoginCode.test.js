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
  assert.equal(asked.tech, 'getjwt 401 {ticket, length=6, expiresIn=600, resendIn=30}', 'the shape of the answer, not the ticket');
  assert.ok(asked.otp.sentAt && asked.otp.until && asked.otp.resendAt);
  assert.equal(sim.mails.length, 1);
  assert.equal((await row(ms.id)).live_needs_code, 1);

  const wrong = sim.mails[0].code === '123456' ? '654321' : '123456';
  const wrongRes = await live.loginWithCode(await row(ms.id), wrong);
  assert.equal(wrongRes.status, 'code_required');
  assert.equal(wrongRes.error, 'Wrong code. 4 attempts left.');
  assert.equal(wrongRes.otp.until, asked.otp.until, 'the mailed code stays the one to use');
  assert.equal(sim.mails.length, 1, 'a wrong code mails nothing');

  const ok = await live.loginWithCode(await row(ms.id), sim.mails[0].code);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.status, 'open');
  assert.deepEqual(sim.tokenRequests.at(-1), { user: 'loxsuite', permission: 4, otp: true });
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

test('the code answer is known by its fields; a wrong password (401 {lastEdit, unix}) is not one', () => {
  const ask = (v, withCode = false) => live.otpAsked({ LL: { Code: '401', value: v } }, v, { withCode });
  assert.equal(ask({ lastEdit: 1, unix: 2 }), null);
  assert.equal(ask(''), null);
  assert.match(ask({ ticket: 'x', expiresIn: 600 }).message, /asks for a login code/);
  assert.equal(ask({ ticket: 'x' }).mailed, true);
  assert.equal(ask({ attemptsLeft: 1 }, true).message, 'Wrong code. 1 attempt left.');
  assert.equal(ask({ attemptsLeft: 3 }, true).message, 'Wrong code. 3 attempts left.');
  assert.equal(ask({ attemptsLeft: 0 }, true).message, 'Too many wrong codes. Send a new code.');
  assert.equal(ask({ retryAfter: 300 }, true).message, 'Too many wrong codes. Try again in 5 minutes.');
  assert.equal(ask({ retryAfter: 30 }, true).message, 'Too many wrong codes. Try again in 1 minute.');
  assert.equal(ask({ reason: 'alreadySent' }).message, 'A code was sent a moment ago. Use the code from that mail.');
  assert.equal(ask({ reason: 'alreadySent' }).mailed, false);
  assert.equal(ask({ reason: 'codeExpired' }, true).message, 'This code has expired. Send a new code.');
  assert.match(ask({ reason: 'noMailer' }).message, /could not mail the login code: no mail server is set up/);
  assert.match(ask({ reason: 'notRegistered' }).message, /not registered with the Loxone mail service/);
  assert.match(ask({ reason: 'noConnection' }).message, /no connection to the mail server/);
  assert.match(ask({ reason: 'quota' }).message, /maximum number of mails/);
  assert.match(ask({ reason: 'noEmailAddress' }).message, /no e-mail address for login codes/);
  assert.match(ask({ codeVerified: false }, true).message, /not right/);
  assert.equal(live.shapeOf('401', { ticket: 'secret', token: 'secret', attemptsLeft: 2, reason: 'x' }), '401 {ticket, token, attemptsLeft=2, reason=x}');
  assert.equal(live.shapeOf('500', 'some text'), '500 (text)');
});
