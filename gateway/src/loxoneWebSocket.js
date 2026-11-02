// Real-time value updates straight from a Miniserver's websocket push feed, instead of polling
// /jdev/sps/io/<uuid> one state at a time. That HTTP endpoint turns out to only answer for a small
// slice of a control's states (~8% on this project's own installation, empirically measured) — the
// rest (sub-states like "active"/"numOpen"/"lockedUntil") only ever get pushed over the websocket,
// which is exactly what Node-RED's Loxone nodes and the official app use, and why they show data
// this HTTP polling never could. See docs/ (or ask) for the full writeup; the short version is this
// isn't a speed problem, it's that most states have no HTTP-pollable equivalent at all.
//
// The handshake below (RSA key exchange -> AES-encrypted getkey2/getjwt -> enablebinstatusupdate)
// mirrors the well-established open-source Loxone integrations (e.g. Home Assistant's PyLoxone) —
// reverse-engineering this from scratch would be needlessly risky when the protocol is already
// documented in working code; verified end to end against a real Miniserver before relying on it.
//
// The token request is getjwt (Loxone's documented successor of gettoken since 10.2, same arguments
// and answer): Loxone Config 17.3 itself uses it, and only getjwt takes the login code below.
//
// Login code (Multi-Factor Authentication, Loxone Config 17.3): for a Loxone user with it on, getjwt
// gives no token but answers 460 and mails a 6-digit code to that user; the same getjwt with
// ?otp=<HMAC-SHA256 of the digits, keyed with getkey2's one-time key> then gives it, and a new login
// without a code mails a new one. Not in Loxone's protocol document (v17.0): taken from the
// Miniserver's own web interface (17.3: LxCommunicator.requestToken, computeOtpHash and its two-step
// module) and seen on a real Miniserver. The answer codes 460-467 are in OTP below; the details in
// the field otp: mail (sent, alreadySent, pending, failed), to (the address, masked), reason,
// expiresIn, resendIn, attemptsLeft, retryAfter, length. Turning the code on for a user makes the
// Miniserver refuse a token it gave before. A password login on every reconnect would mail a new code
// each time, so the token that comes with the code is kept (encrypted) and used with authwithtoken
// from then on; refreshjwt keeps it valid, no code needed.
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const { fetchMiniserver } = require('./loxone');
const { encrypt, decrypt } = require('./secretCrypto');

const RESCAN_TICK_MS = 60000;

const KEEPALIVE_MS = 4 * 60 * 1000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 8000;
// A refused login is tried this many times, slowly (AUTH_RETRY_MS, then twice that), and then left alone until
// someone saves the Miniserver or clicks Test now: a Miniserver with the login code locks the user after 10 failed
// logins and mails him each time.
const AUTH_TRIES = 3;
const AUTH_RETRY_MS = 60 * 1000;
const tuning = { authRetryMs: AUTH_RETRY_MS }; // tests shorten it
// Loxone's own permission numbers for getjwt: 2 = web (short-lived), 4 = app (weeks, refreshable). The app
// token is only asked for with the login code, since that is the one LoxSuite keeps.
const PERMISSION_WEB = 2;
const PERMISSION_APP = 4;
const CLIENT_UUID = 'aaaabbbb-cccc-dddd-eeeeffff0000';
const LOXONE_EPOCH_MS = Date.UTC(2009, 0, 1); // Loxone's times count seconds from 2009-01-01
const REFRESH_BEFORE_MS = 3 * 24 * 3600 * 1000;
const REFRESH_CHECK_MS = 12 * 3600 * 1000;
const CODE_VALID_MS = 10 * 60 * 1000; // what Loxone says a mailed code is valid for, when the answer doesn't say

const NEEDS_CODE = 'This Loxone user logs in with a login code (Multi-Factor Authentication). Click "Send login code" on the Miniserver\'s Edit page; the Miniserver then mails a new code.';

const connections = new Map(); // miniserver id -> MiniserverLiveConnection
// miniserver id -> what the Miniserver said when it asked for the login code ({ reason, attemptsLeft, ..., until }).
// Kept here, not on the connection, because every code and every "send a new code" is a new connection. No
// password or code in it, and gone once the code is no longer valid or the login worked.
const codeWaits = new Map();

function pkcs7pad(buf, blockSize) {
  const padLen = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

function hmacHex(hashAlg, keyHex, message) {
  const nodeAlg = hashAlg === 'SHA256' ? 'sha256' : 'sha1';
  return crypto.createHmac(nodeAlg, Buffer.from(keyHex, 'hex')).update(message, 'utf8').digest('hex');
}

function shaHex(hashAlg, message) {
  const nodeAlg = hashAlg === 'SHA256' ? 'sha256' : 'sha1';
  return crypto.createHash(nodeAlg).update(message, 'utf8').digest('hex').toUpperCase();
}

const llCode = (body) => String(body?.LL?.Code ?? body?.LL?.code);
function llValue(body) {
  const v = body?.LL?.value;
  if (typeof v !== 'string' || !/^\s*[{[]/.test(v)) return v;
  try { return JSON.parse(v); } catch { return v; }
}
const fromLoxoneTime = (s) => (Number(s) > 0 ? new Date(LOXONE_EPOCH_MS + Number(s) * 1000) : null);

// The two-step answers of getjwt (Loxone 17.3), by their code — each with what LoxSuite can do next. A wrong
// password stays Loxone's 401 (a real Miniserver adds { lastEdit, unix }) and is none of these.
const OTP = {
  460: 'asked', 461: 'send-failed', 462: 'no-address', 463: 'wrong-code', 464: 'expired', 465: 'replaced', 466: 'locked', 467: 'refused',
};
const MAIL_FAILED = {
  notRegistered: 'the Miniserver is not registered with the Loxone mail service',
  noConnection: 'the Miniserver has no connection to the mail server',
  quota: 'the Miniserver has reached its maximum number of mails',
  noMailer: 'no mail server is set up on the Miniserver',
};
const SAFE_VALUES = ['reason', 'mail', 'attemptsLeft', 'retryAfter', 'expiresIn', 'resendIn', 'length', 'codeVerified'];

// The code as the Miniserver's own web interface sends it: HMAC-SHA256 of the digits, keyed with the one-time key
// of getkey2 (hex), lower-case hex. A real Miniserver counts the plain digits as a wrong code (463).
const otpHash = (code, keyHex) => crypto.createHmac('sha256', Buffer.from(String(keyHex), 'hex')).update(String(code).replace(/\D/g, ''), 'utf8').digest('hex');

// The shape of an answer, for the log and the Edit page — so what a real Miniserver sends can be learned from it.
// A value is told only when it cannot be a secret: a known field, a yes/no, a short word, a number below 6 digits;
// any other text only by its length (never a token, hash, code or the e-mail address).
function shapeOf(code, v) {
  const tell = (k, x) => {
    if (x && typeof x === 'object') return `${k}{${Object.entries(x).slice(0, 12).map(([kk, xx]) => tell(kk, xx)).join(', ')}}`;
    if (SAFE_VALUES.includes(k) || typeof x === 'boolean' || (typeof x === 'number' && Math.abs(x) < 100000)) return `${k}=${String(x).slice(0, 24)}`;
    if (typeof x === 'string' && /^[A-Za-z]{1,24}$/.test(x)) return `${k}=${x}`;
    return typeof x === 'string' ? `${k}=(text, ${x.length})` : k;
  };
  if (!v || typeof v !== 'object') return `${code}${v ? ' (text)' : ''}`;
  return `${code} {${Object.entries(v).map(([k, x]) => tell(k, x)).join(', ')}}`;
}

// null, or { kind, mail, to, reason, attemptsLeft, retryAfter, expiresIn, resendIn, length, again, mailed, message }
// when the answer is one of the two-step codes. again: the code step stays (a code can still be entered or asked
// for); mailed: a new code just went out. The details are in the field otp (also read at the top level).
function otpAsked(v, { code }) {
  const kind = OTP[Number(code)];
  if (!kind) return null;
  const obj = v && typeof v === 'object' ? v : {};
  const f = obj.otp && typeof obj.otp === 'object' ? obj.otp : obj;
  const num = (k) => (Number.isFinite(Number(f[k])) && f[k] !== '' && f[k] !== null && f[k] !== undefined ? Number(f[k]) : null);
  const str = (k) => (typeof f[k] === 'string' ? f[k] : null);
  const o = {
    kind, mail: str('mail'), to: str('to'), reason: str('reason'), attemptsLeft: num('attemptsLeft'), retryAfter: num('retryAfter'),
    expiresIn: num('expiresIn'), resendIn: num('resendIn'), length: num('length') || 6, again: true, mailed: false,
  };
  const why = (o.reason && MAIL_FAILED[o.reason]) || (o.reason ? `error ${o.reason}` : 'an unknown error');
  if (kind === 'asked') {
    o.mailed = o.mail !== 'alreadySent' && o.mail !== 'failed';
    o.message = o.mail === 'alreadySent' ? 'A code was sent a moment ago. Use the code from that mail.'
      : 'The Miniserver asks for a login code (Multi-Factor Authentication). It has just mailed the code to the e-mail address of this Loxone user.';
  } else if (kind === 'send-failed') o.message = `The Miniserver could not mail the login code: ${why}.`;
  else if (kind === 'no-address') {
    o.again = false;
    o.message = 'This Loxone user has no e-mail address for login codes. Add one to the user in Loxone Config, or switch the login code off for this user.';
  } else if (kind === 'wrong-code') {
    if (o.attemptsLeft === null) o.message = 'This code is not right. Check that it is the code from the newest mail.';
    else if (o.attemptsLeft === 1) o.message = 'Wrong code. 1 attempt left.';
    else o.message = o.attemptsLeft > 0 ? `Wrong code. ${o.attemptsLeft} attempts left.` : 'Too many wrong codes. Send a new code.';
  } else if (kind === 'expired') {
    o.mailed = o.mail !== 'failed';
    o.message = o.mailed ? 'This code has expired. The Miniserver has mailed a new one.' : `This code has expired, and a new one could not be mailed: ${why}.`;
  } else if (kind === 'replaced') o.message = 'A newer login has replaced this code. Use the code from the newest mail.';
  else if (kind === 'locked') {
    const min = Math.max(1, Math.ceil((o.retryAfter || 900) / 60));
    o.message = min === 1 ? 'Too many wrong codes. Try again in 1 minute.' : `Too many wrong codes. Try again in ${min} minutes.`;
  } else {
    o.again = false;
    o.message = 'The Miniserver refused this login. Check the username and password, then click Test on the Miniserver\'s Edit page to try again.';
  }
  return o;
}

function readToken(miniserver) {
  if (!miniserver.live_token) return null;
  try {
    const t = JSON.parse(decrypt(miniserver.live_token));
    if (!t?.token) return null;
    return { token: t.token, hashAlg: t.hashAlg || 'SHA1', validUntil: miniserver.live_token_valid_until ? new Date(miniserver.live_token_valid_until) : null };
  } catch {
    return null; // SESSION_SECRET changed: as good as no token
  }
}

// Loxone's own UUID text format (4-2-2-8 byte grouping) rather than standard RFC4122 (4-2-2-2-6) —
// the wire bytes match the same "first three fields little-endian" layout .NET's Guid uses, since
// Loxone Config is a .NET application. Matches the structure file's own uuid strings byte-for-byte
// (verified against known UUIDs from this project's real LoxAPP3.json).
function uuidBytesToString(buf) {
  const d1 = Buffer.from(buf.subarray(0, 4)).reverse().toString('hex');
  const d2 = Buffer.from(buf.subarray(4, 6)).reverse().toString('hex');
  const d3 = Buffer.from(buf.subarray(6, 8)).reverse().toString('hex');
  const d4 = buf.subarray(8, 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}`;
}

function parseValueStates(buf, onValue) {
  const count = Math.floor(buf.length / 24);
  for (let i = 0; i < count; i++) {
    const rec = buf.subarray(i * 24, i * 24 + 24);
    onValue(uuidBytesToString(rec.subarray(0, 16)), rec.readDoubleLE(16));
  }
}

function parseTextStates(buf, onValue) {
  let offset = 0;
  while (offset + 36 <= buf.length) {
    const stateUuid = uuidBytesToString(buf.subarray(offset, offset + 16));
    // bytes [offset+16, offset+32) are an icon uuid we don't need.
    const textLength = buf.readUInt32LE(offset + 32);
    const textStart = offset + 36;
    if (textStart + textLength > buf.length) break;
    const text = buf.subarray(textStart, textStart + textLength).toString('utf8');
    onValue(stateUuid, text);
    offset += Math.ceil((36 + textLength) / 4) * 4;
  }
}

class MiniserverLiveConnection {
  // firstLogin: { otp } logs in with the login code, { sendCode: true } logs in with the password so the
  // Miniserver mails a new code (see loginWithCode/sendLoginCode below); otherwise the usual login.
  constructor(miniserver, firstLogin = {}) {
    // Decrypted once here rather than at each of this.miniserver.password's use sites below.
    this.miniserver = { ...miniserver, password: decrypt(miniserver.password) };
    this.token = readToken(miniserver);
    this.cache = new Map(); // uuid -> value (number or string)
    this.status = 'connecting';
    this.lastError = null;
    this.lastTech = null; // the shape of the last refused token answer (see shapeOf), never a secret
    this.ws = null;
    this.destroyed = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.refreshTimer = null;
    this.pendingHeader = null;
    this.pending = []; // { match(control): boolean, resolve } — LL answers being waited for
    this.authFails = 0;
    this.waiters = []; // { resolve } — woken on first successful open, for the Test-now check
    this.connect(firstLogin);
  }

  updateStatus(status, error) {
    this.status = status;
    this.lastError = error || null;
    if (status === 'open') {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w.resolve({ ok: true }));
    } else if (status === 'error' || status === 'closed' || status === 'auth_failed' || status === 'code_required') {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w.resolve({ ok: false, error: this.lastError }));
    }
  }

  waitForOpen(timeoutMs) {
    if (this.status === 'open') return Promise.resolve({ ok: true });
    // Settled without a retry coming: no point in waiting for the timeout.
    if (this.status === 'auth_failed' || this.status === 'code_required') return Promise.resolve({ ok: false, error: this.lastError });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve({ ok: false, error: 'Timed out waiting for the live connection to open' });
      }, timeoutMs);
      this.waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); } });
    });
  }

  send(command) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(command);
  }

  sendEncrypted(command) {
    const { aesKey, iv, salt } = this.session;
    const commandString = `salt/${salt}/${command}\0`;
    const padded = pkcs7pad(Buffer.from(commandString, 'utf8'), 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    this.send(`jdev/sys/enc/${encodeURIComponent(encrypted.toString('base64'))}`);
  }

  // Sends a command and waits for the LL answer whose control matches (a substring, or a test on the control).
  request(command, match, { encrypted = true, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const test = typeof match === 'function' ? match : (control) => control.includes(match);
    const answer = new Promise((resolve, reject) => {
      const entry = { match: test };
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new Error('Timed out waiting for a response'));
      }, timeoutMs);
      entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
      this.pending.push(entry);
    });
    if (encrypted) this.sendEncrypted(command);
    else this.send(command);
    return answer;
  }

  onMessage(data, isBinary) {
    if (!isBinary) {
      let body;
      try { body = JSON.parse(data.toString()); } catch { return; }
      const control = String(body?.LL?.control ?? '');
      const idx = this.pending.findIndex((p) => p.match(control));
      if (idx !== -1) this.pending.splice(idx, 1)[0].resolve(body);
      return;
    }
    if (!this.pendingHeader && data.length === 8) {
      this.pendingHeader = { identifier: data.readUInt8(1), length: data.readUInt32LE(4) };
      return;
    }
    if (this.pendingHeader) {
      const { identifier } = this.pendingHeader;
      this.pendingHeader = null;
      if (identifier === 2) parseValueStates(data, (uuid, val) => this.cache.set(uuid, val));
      else if (identifier === 3) parseTextStates(data, (uuid, val) => this.cache.set(uuid, val));
    }
  }

  // Websocket up and the session key exchanged. No Basic auth on getPublicKey or the websocket upgrade: Loxone
  // asks for none there (the login happens inside), and a user with the login code may not be let in by it.
  async openSocket() {
    const pkRes = await fetchMiniserver(this.miniserver, '/jdev/sys/getPublicKey', { timeoutMs: REQUEST_TIMEOUT_MS, anonymous: true });
    const pkBody = await pkRes.json();
    const pem = pkBody.LL.value.trim()
      .replace('-----BEGIN CERTIFICATE-----', '-----BEGIN PUBLIC KEY-----\n')
      .replace('-----END CERTIFICATE-----', '\n-----END PUBLIC KEY-----\n');

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    this.session = { aesKey, iv, salt: crypto.randomBytes(16).toString('hex') };
    const sessionKeyPlain = `${aesKey.toString('hex')}:${iv.toString('hex')}`;
    const encryptedSessionKey = crypto.publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(sessionKeyPlain, 'utf8')
    ).toString('base64');

    const scheme = this.miniserver.use_https ? 'wss' : 'ws';
    const url = `${scheme}://${this.miniserver.host}:${this.miniserver.http_port}/ws/rfc6455`;
    const ws = new WebSocket(url, ['remotecontrol'], { handshakeTimeout: REQUEST_TIMEOUT_MS, rejectUnauthorized: false });
    this.ws = ws;
    this.pending = [];
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode} on websocket handshake`)));
    });

    const keyExchangeResp = await this.request(`jdev/sys/keyexchange/${encryptedSessionKey}`, 'keyexchange', { encrypted: false });
    const keCode = llCode(keyExchangeResp);
    if (keCode !== '200') throw new Error(`Key exchange failed (code ${keCode})`);
  }

  // Password (+ login code) -> token. With the code the token is kept (see the top of this file).
  async loginWithPassword(otp) {
    const { username, password, id } = this.miniserver;
    const keyData = llValue(await this.request(`jdev/sys/getkey2/${username}`, 'getkey2'));
    const { key, salt } = keyData;
    const hashAlg = keyData.hashAlg || 'SHA1';

    const pwHash = shaHex(hashAlg, `${password}:${salt}`);
    const finalHash = hmacHex(hashAlg, key, `${username}:${pwHash}`);

    // The code never leaves as its digits: HMAC-SHA256 with this same one-time key (see otpHash).
    const code6 = otp ? String(otp).replace(/\D/g, '').slice(0, 8) : '';
    const permission = code6 || this.miniserver.live_needs_code ? PERMISSION_APP : PERMISSION_WEB;
    const tokenResp = await this.request(
      `jdev/sys/getjwt/${finalHash}/${username}/${permission}/${CLIENT_UUID}/loxsuite${code6 ? `?otp=${otpHash(code6, key)}` : ''}`,
      'getjwt'
    );
    const tokenCode = llCode(tokenResp);
    const v = llValue(tokenResp);
    if (tokenCode !== '200' || !v?.token) {
      this.lastTech = `getjwt ${shapeOf(tokenCode, v)}`;
      console.warn(`[loxoneWebSocket] Miniserver ${id}: token refused, answer ${this.lastTech}`);
      const asked = otpAsked(v, { code: tokenCode });
      // No e-mail address (462) or a refused login (467): no code can come — like a refused password, not retried.
      if (asked && !asked.again) throw Object.assign(new Error(asked.message), { authRefused: true, final: true });
      if (asked) throw Object.assign(new Error(asked.message), { otp: asked });
      if (isPermanentAuthFailure(tokenCode)) {
        throw Object.assign(new Error(`The Miniserver rejected the username or password (code ${tokenCode}). Check them on the Miniserver's Edit page.`), { authRefused: true, final: true });
      }
      // Only Loxone's own documented "Unauthorized" (401 — the actual credentials being wrong)
      // is treated as deterministic/never-worth-retrying. Confirmed the hard way: a Miniserver
      // and this gateway restarting together (a container restart, e.g. triggered by an
      // unattended backup snapshot) can leave a stale token/session for this exact client UUID
      // (see CLIENT_UUID above — every connection this gateway ever makes identifies itself with
      // the SAME one, never a fresh one per attempt) still considered "logged in" from the
      // Miniserver's own point of view for a little while after the old connection actually died —
      // genuinely temporary, gone within a retry or two. Retried, but no more than AUTH_TRIES times.
      throw Object.assign(new Error(`The Miniserver refused the login (code ${tokenCode}). If the login code (Multi-Factor Authentication) was just switched on for this Loxone user, click Test on the Miniserver's Edit page to log in with the code.`), { authRefused: true });
    }
    this.lastTech = null;
    if (code6) {
      this.token = { token: v.token, hashAlg, validUntil: fromLoxoneTime(v.validUntil) };
      await this.saveToken();
    } else if (this.token || this.miniserver.live_needs_code) {
      // In with the password alone: the login code was switched off for this user.
      this.token = null;
      this.miniserver.live_needs_code = 0;
      await db.prepare('UPDATE miniservers SET live_token = NULL, live_token_valid_until = NULL, live_needs_code = 0 WHERE id = ?').run(id);
    }
  }

  async tokenHash() {
    const key = llValue(await this.request('jdev/sys/getkey', (c) => c.includes('getkey') && !c.includes('getkey2')));
    return hmacHex(this.token.hashAlg, String(key), this.token.token);
  }

  async loginWithToken() {
    const res = await this.request(`authwithtoken/${await this.tokenHash()}/${this.miniserver.username}`, 'authwithtoken');
    const code = llCode(res);
    if (code === '401' || code === '477' || code === '403' || code === '400') {
      this.lastTech = `authwithtoken ${shapeOf(code, llValue(res))}`;
      console.warn(`[loxoneWebSocket] Miniserver ${this.miniserver.id}: saved login refused, answer ${this.lastTech}`);
      throw Object.assign(new Error(`The Miniserver no longer accepts LoxSuite's saved login (code ${code}). Was the Loxone user removed, its password changed or its login code reset? Check the password on the Miniserver's Edit page, then log in again with a new login code.`), { authRefused: true, tokenRefused: true });
    }
    // Anything else (a busy or restarting Miniserver) is not a refusal: retried like an unreachable one.
    if (code !== '200') throw new Error(`The Miniserver did not answer the saved login properly (code ${code})`);
    this.lastTech = null;
    const until = fromLoxoneTime(llValue(res)?.validUntil);
    if (until) this.token.validUntil = until;
  }

  async refreshTokenIfDue() {
    const until = this.token?.validUntil;
    if (!until || until.getTime() - Date.now() > REFRESH_BEFORE_MS) return;
    try {
      const res = await this.request(`jdev/sys/refreshjwt/${await this.tokenHash()}/${this.miniserver.username}`, 'refreshjwt');
      const code = llCode(res);
      const v = llValue(res);
      if (code !== '200') {
        console.warn(`[loxoneWebSocket] Miniserver ${this.miniserver.id}: token refresh refused, answer refreshjwt ${shapeOf(code, v)}`);
        return;
      }
      this.token = { ...this.token, token: v?.token || this.token.token, validUntil: fromLoxoneTime(v?.validUntil) || until };
      await this.saveToken();
    } catch (err) {
      console.warn(`[loxoneWebSocket] Miniserver ${this.miniserver.id}: token refresh failed: ${err.message}`);
    }
  }

  async saveToken() {
    const { token, hashAlg, validUntil } = this.token;
    this.miniserver.live_needs_code = 1;
    await db.prepare('UPDATE miniservers SET live_token = ?, live_token_valid_until = ?, live_needs_code = 1 WHERE id = ?')
      .run(encrypt(JSON.stringify({ token, hashAlg })), validUntil ? validUntil.toISOString() : null, this.miniserver.id);
  }

  async connect({ otp = null, sendCode = false } = {}) {
    if (this.destroyed) return;
    // Asked for the login code before and no token: a login now would mail a new code, so only on request.
    if (!this.token && this.miniserver.live_needs_code && !otp && !sendCode) {
      this.updateStatus('code_required', NEEDS_CODE);
      return;
    }
    this.updateStatus('connecting', null);

    try {
      await this.openSocket();
      if (this.token && !otp && !sendCode) await this.loginWithToken();
      else await this.loginWithPassword(otp);

      const enableResp = await this.request('jdev/sps/enablebinstatusupdate', 'enablebinstatusupdate', { encrypted: false });
      const enableCode = llCode(enableResp);
      if (enableCode !== '200') throw new Error(`enablebinstatusupdate failed (code ${enableCode})`);

      this.reconnectDelay = RECONNECT_BASE_MS;
      this.authFails = 0;
      codeWaits.delete(this.miniserver.id);
      this.updateStatus('open', null);

      this.keepaliveTimer = setInterval(() => this.send('keepalive'), KEEPALIVE_MS);
      if (this.token) {
        this.refreshTokenIfDue();
        this.refreshTimer = setInterval(() => this.refreshTokenIfDue(), REFRESH_CHECK_MS);
      }

      const ws = this.ws;
      ws.on('close', () => {
        clearInterval(this.keepaliveTimer);
        clearInterval(this.refreshTimer);
        this.cache.clear();
        this.updateStatus('closed', this.lastError);
        this.scheduleReconnect();
      });
      ws.on('error', (err) => {
        this.lastError = err.message;
      });
    } catch (err) {
      console.error(`[loxoneWebSocket] Miniserver ${this.miniserver.id} handshake failed:`, err.message);
      try { this.ws?.close(); } catch { /* already closing */ }
      if (err.otp) {
        // Never retried by itself: every login without the code mails a new one.
        const before = codeWaits.get(this.miniserver.id);
        const validMs = (err.otp.expiresIn ? err.otp.expiresIn * 1000 : CODE_VALID_MS);
        codeWaits.set(this.miniserver.id, {
          ...err.otp,
          to: err.otp.to || before?.to || null,
          sentAt: err.otp.mailed ? new Date() : before?.sentAt || null,
          until: err.otp.mailed ? new Date(Date.now() + validMs) : before?.until || null,
          resendAt: err.otp.mailed && err.otp.resendIn ? new Date(Date.now() + err.otp.resendIn * 1000) : before?.resendAt || null,
        });
        if (!this.miniserver.live_needs_code) {
          this.miniserver.live_needs_code = 1;
          await db.prepare('UPDATE miniservers SET live_needs_code = 1 WHERE id = ?').run(this.miniserver.id).catch(() => {});
        }
        this.updateStatus('code_required', err.message);
      } else if (err.authRefused) {
        // A refused login stays refused: tried a few times only (AUTH_TRIES), slowly, so a Miniserver that counts
        // failed logins does not lock the user. A wrong password (401) is not tried again at all. This
        // connection then just sits in 'auth_failed'; ensureConnection() only ever creates a NEW one when none
        // exists yet, so nothing touches it again until resetConnection() (saving the Miniserver's settings or
        // its "Test now" action) destroys it outright.
        this.authFails += 1;
        const giveUp = err.final || this.authFails >= AUTH_TRIES;
        if (!giveUp) {
          this.updateStatus('error', err.message);
          this.scheduleReconnect(tuning.authRetryMs * this.authFails);
        } else {
          if (err.tokenRefused) {
            // A refused token won't come back: without it, the next try asks for "Send login code".
            this.token = null;
            await db.prepare('UPDATE miniservers SET live_token = NULL, live_token_valid_until = NULL WHERE id = ?').run(this.miniserver.id).catch(() => {});
          }
          this.updateStatus('auth_failed', err.final ? err.message : `${err.message} LoxSuite has stopped trying by itself, so the Loxone user does not get locked. Click Test on the Miniserver's Edit page to try again.`);
        }
      } else {
        this.updateStatus('error', err.message);
        this.scheduleReconnect();
      }
    }
  }

  scheduleReconnect(delayMs = null) {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs ?? this.reconnectDelay);
    if (delayMs === null) this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.keepaliveTimer);
    clearInterval(this.refreshTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* already closing */ }
  }
}

// A token answer code that means "these credentials are genuinely wrong — never retry",
// deliberately ONLY Loxone's own documented 401 ("Unauthorized"). Every OTHER non-200 code (a
// stale session right after the gateway and Miniserver restart together, a transient 5xx, a
// malformed/empty code) is treated as temporary so it falls through to a (limited, AUTH_TRIES)
// retry instead of getting permanently stuck in 'auth_failed' — see the throw site above and
// CHANGELOG 0.18.27 for the reported bug this exact distinction fixes. The login code's own
// answers (460-467) are told apart before this (otpAsked). Kept as a tiny pure function (and exported) so
// that contract has a home a unit test can pin down.
function isPermanentAuthFailure(tokenCode) {
  return String(tokenCode) === '401';
}

// Idempotent — safe to call on every page load / values request. Miniservers with no live
// connection yet get one started; an existing (even still-connecting or errored-and-retrying) one
// is left alone rather than restarted, so a request doesn't pile up parallel handshakes.
function ensureConnection(miniserver) {
  let conn = connections.get(miniserver.id);
  if (!conn) {
    conn = new MiniserverLiveConnection(miniserver);
    connections.set(miniserver.id, conn);
  }
  return conn;
}

function getLiveValue(miniserverId, uuid) {
  const conn = connections.get(miniserverId);
  return conn ? conn.cache.get(uuid) : undefined;
}

// The login code wait as the Edit page shows it: no ticket, no code.
function codeWait(miniserverId) {
  const w = codeWaits.get(miniserverId);
  if (!w) return null;
  if (w.until && w.until.getTime() < Date.now() - CODE_VALID_MS) { codeWaits.delete(miniserverId); return null; }
  const iso = (d) => (d ? d.toISOString() : null);
  return {
    message: w.message, kind: w.kind, reason: w.reason, attemptsLeft: w.attemptsLeft, retryAfter: w.retryAfter, length: w.length,
    to: w.to, sentAt: iso(w.sentAt), until: iso(w.until), resendAt: iso(w.resendAt),
  };
}

function getStatus(miniserverId) {
  const conn = connections.get(miniserverId);
  if (!conn) return { status: 'not_connected', error: null, valueCount: 0 };
  return {
    status: conn.status, error: conn.lastError, valueCount: conn.cache.size, tech: conn.lastTech,
    otp: conn.status === 'code_required' ? codeWait(miniserverId) : null,
    loginCode: Boolean(conn.token), tokenValidUntil: conn.token?.validUntil ? conn.token.validUntil.toISOString() : null,
  };
}

// Used by the Miniservers "Test now" panel — starts a connection if there isn't one yet, then
// waits (briefly) for it to actually finish the handshake, so the result reflects reality instead
// of always reporting "connecting" the first time a Miniserver is tested.
async function testConnection(miniserver, timeoutMs = 8000) {
  const start = Date.now();
  const conn = ensureConnection(miniserver);
  const result = await conn.waitForOpen(timeoutMs);
  const ms = Date.now() - start;
  const { status, tech, otp } = getStatus(miniserver.id);
  return result.ok
    ? { ok: true, ms, error: null, status }
    : { ok: false, ms, error: result.error || 'Could not open a live connection', status, tech, otp };
}

// A fresh connection that logs in a particular way (see the constructor), for the Edit page's login code step.
async function freshLogin(miniserver, firstLogin, timeoutMs) {
  resetConnection(miniserver.id);
  const conn = new MiniserverLiveConnection(miniserver, firstLogin);
  connections.set(miniserver.id, conn);
  const result = await conn.waitForOpen(timeoutMs);
  return { ok: result.ok, ...getStatus(miniserver.id), error: result.ok ? null : result.error };
}

// The code the Miniserver mailed -> a token, kept for the reconnects that follow.
function loginWithCode(miniserver, code, timeoutMs = 10000) {
  return freshLogin(miniserver, { otp: code }, timeoutMs);
}

// A login without the code, which makes the Miniserver mail a new one (only the newest code counts).
function sendLoginCode(miniserver, timeoutMs = 10000) {
  return freshLogin(miniserver, { sendCode: true }, timeoutMs);
}

// Connects to every known Miniserver at boot (rather than waiting for someone to open Live Data
// first) so the Miniservers page's "Test now" panel and Live Data both reflect a live connection
// that's already up, and re-scans periodically to pick up newly-added Miniservers — ensureConnection
// is a no-op for ones already connected/retrying, so this is cheap to just re-run on a timer.
async function startLiveConnections() {
  const scan = async () => {
    const miniservers = await db.prepare('SELECT * FROM miniservers').all();
    miniservers.forEach(ensureConnection);
  };
  await scan();
  setInterval(scan, RESCAN_TICK_MS);
}

// Called when a Miniserver's credentials/host change or it's deleted — otherwise the live
// connection would keep running against stale details until the next gateway restart.
function resetConnection(miniserverId) {
  const conn = connections.get(miniserverId);
  if (!conn) return;
  conn.destroy();
  connections.delete(miniserverId);
}

module.exports = {
  startLiveConnections, ensureConnection, getLiveValue, getStatus, testConnection, resetConnection,
  loginWithCode, sendLoginCode, isPermanentAuthFailure, otpAsked, otpHash, shapeOf, AUTH_TRIES, _tuning: tuning,
};
