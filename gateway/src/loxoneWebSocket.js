// Real-time value updates straight from a Miniserver's websocket push feed, instead of polling
// /jdev/sps/io/<uuid> one state at a time. That HTTP endpoint turns out to only answer for a small
// slice of a control's states (~8% on this project's own installation, empirically measured) — the
// rest (sub-states like "active"/"numOpen"/"lockedUntil") only ever get pushed over the websocket,
// which is exactly what Node-RED's Loxone nodes and the official app use, and why they show data
// this HTTP polling never could. See docs/ (or ask) for the full writeup; the short version is this
// isn't a speed problem, it's that most states have no HTTP-pollable equivalent at all.
//
// The handshake below (RSA key exchange -> AES-encrypted getkey2/gettoken -> enablebinstatusupdate)
// mirrors the well-established open-source Loxone integrations (e.g. Home Assistant's PyLoxone) —
// reverse-engineering this from scratch would be needlessly risky when the protocol is already
// documented in working code; verified end to end against a real Miniserver before relying on it.
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const { fetchMiniserver } = require('./loxone');
const { decrypt } = require('./secretCrypto');

const RESCAN_TICK_MS = 60000;

const KEEPALIVE_MS = 4 * 60 * 1000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

const connections = new Map(); // miniserver id -> MiniserverLiveConnection

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
  constructor(miniserver) {
    // Decrypted once here rather than at each of this.miniserver.password's two use sites below.
    this.miniserver = { ...miniserver, password: decrypt(miniserver.password) };
    this.cache = new Map(); // uuid -> value (number or string)
    this.status = 'connecting';
    this.lastError = null;
    this.ws = null;
    this.destroyed = false;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.pendingHeader = null;
    this.waiters = []; // { resolve } — woken on first successful open, for the Test-now check
    this.connect();
  }

  updateStatus(status, error) {
    this.status = status;
    this.lastError = error || null;
    if (status === 'open') {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w.resolve({ ok: true }));
    } else if (status === 'error' || status === 'closed' || status === 'auth_failed') {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w.resolve({ ok: false, error: this.lastError }));
    }
  }

  waitForOpen(timeoutMs) {
    if (this.status === 'open') return Promise.resolve({ ok: true });
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

  sendEncrypted(command, aesKey, iv, salt) {
    const commandString = `salt/${salt}/${command}\0`;
    const padded = pkcs7pad(Buffer.from(commandString, 'utf8'), 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    this.send(`jdev/sys/enc/${encodeURIComponent(encrypted.toString('base64'))}`);
  }

  async connect() {
    if (this.destroyed) return;
    this.updateStatus('connecting', null);

    try {
      const pkRes = await fetchMiniserver(this.miniserver, '/jdev/sys/getPublicKey', { timeoutMs: 8000 });
      const pkBody = await pkRes.json();
      const pem = pkBody.LL.value.trim()
        .replace('-----BEGIN CERTIFICATE-----', '-----BEGIN PUBLIC KEY-----\n')
        .replace('-----END CERTIFICATE-----', '\n-----END PUBLIC KEY-----\n');

      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const commandSalt = crypto.randomBytes(16).toString('hex');
      const sessionKeyPlain = `${aesKey.toString('hex')}:${iv.toString('hex')}`;
      const encryptedSessionKey = crypto.publicEncrypt(
        { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(sessionKeyPlain, 'utf8')
      ).toString('base64');

      const scheme = this.miniserver.use_https ? 'wss' : 'ws';
      const url = `${scheme}://${this.miniserver.host}:${this.miniserver.http_port}/ws/rfc6455`;
      const auth = Buffer.from(`${this.miniserver.username}:${this.miniserver.password}`).toString('base64');
      const ws = new WebSocket(url, ['remotecontrol'], {
        headers: { Authorization: `Basic ${auth}` },
        handshakeTimeout: 8000,
        rejectUnauthorized: false,
      });
      this.ws = ws;

      const pending = []; // { match(body): boolean, resolve, reject }
      const waitForLL = (match, timeoutMs = 8000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for a response')), timeoutMs);
        pending.push({ match, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          let body;
          try { body = JSON.parse(data.toString()); } catch { return; }
          const idx = pending.findIndex((p) => p.match(body));
          if (idx !== -1) pending.splice(idx, 1)[0].resolve(body);
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
      });

      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode} on websocket handshake`)));
      });

      const keyExchangePromise = waitForLL((b) => b?.LL?.control?.includes('keyexchange'));
      this.send(`jdev/sys/keyexchange/${encryptedSessionKey}`);
      const keyExchangeResp = await keyExchangePromise;
      const keCode = String(keyExchangeResp?.LL?.Code ?? keyExchangeResp?.LL?.code);
      if (keCode !== '200') throw new Error(`Key exchange failed (code ${keCode})`);

      const getKey2Promise = waitForLL((b) => b?.LL?.control?.includes('getkey2'));
      this.sendEncrypted(`jdev/sys/getkey2/${this.miniserver.username}`, aesKey, iv, commandSalt);
      const getKey2Resp = await getKey2Promise;
      let keyData = getKey2Resp.LL.value;
      if (typeof keyData === 'string') keyData = JSON.parse(keyData);
      const { key, salt } = keyData;
      const hashAlg = keyData.hashAlg || 'SHA1';

      const pwHash = shaHex(hashAlg, `${this.miniserver.password}:${salt}`);
      const finalHash = hmacHex(hashAlg, key, `${this.miniserver.username}:${pwHash}`);

      const tokenPromise = waitForLL((b) => b?.LL?.control?.includes('gettoken'));
      this.sendEncrypted(
        `jdev/sys/gettoken/${finalHash}/${this.miniserver.username}/2/aaaabbbb-cccc-dddd-eeeeffff0000/loxsuite`,
        aesKey, iv, commandSalt
      );
      const tokenResp = await tokenPromise;
      const tokenCode = String(tokenResp?.LL?.Code ?? tokenResp?.LL?.code);
      if (tokenCode !== '200') {
        // Flagged (rather than just a plain Error) so the catch below can tell this apart from a
        // network-level handshake failure — this one is deterministic, the exact same credentials
        // rejection would happen again immediately on retry, unlike a genuine connectivity hiccup.
        const err = new Error(`Authentication failed (code ${tokenCode})`);
        err.authFailed = true;
        throw err;
      }

      const enablePromise = waitForLL((b) => b?.LL?.control?.includes('enablebinstatusupdate'));
      this.send('jdev/sps/enablebinstatusupdate');
      const enableResp = await enablePromise;
      const enableCode = String(enableResp?.LL?.Code ?? enableResp?.LL?.code);
      if (enableCode !== '200') throw new Error(`enablebinstatusupdate failed (code ${enableCode})`);

      this.reconnectDelay = RECONNECT_BASE_MS;
      this.updateStatus('open', null);

      this.keepaliveTimer = setInterval(() => this.send('keepalive'), KEEPALIVE_MS);

      ws.on('close', () => {
        clearInterval(this.keepaliveTimer);
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
      if (err.authFailed) {
        // Deliberately no scheduleReconnect() here — the exact same credentials would be
        // rejected again immediately, forever. This connection object just sits idle in
        // 'auth_failed' from here on; ensureConnection() only ever creates a NEW one when none
        // exists yet, so it won't touch this one again until resetConnection() (called from
        // saving the Miniserver's settings or its "Test now" action) destroys it outright.
        this.updateStatus('auth_failed', err.message);
      } else {
        this.updateStatus('error', err.message);
        this.scheduleReconnect();
      }
    }
  }

  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* already closing */ }
  }
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

function getStatus(miniserverId) {
  const conn = connections.get(miniserverId);
  if (!conn) return { status: 'not_connected', error: null, valueCount: 0 };
  return { status: conn.status, error: conn.lastError, valueCount: conn.cache.size };
}

// Used by the Miniservers "Test now" panel — starts a connection if there isn't one yet, then
// waits (briefly) for it to actually finish the handshake, so the result reflects reality instead
// of always reporting "connecting" the first time a Miniserver is tested.
async function testConnection(miniserver, timeoutMs = 8000) {
  const start = Date.now();
  const conn = ensureConnection(miniserver);
  const result = await conn.waitForOpen(timeoutMs);
  const ms = Date.now() - start;
  return result.ok
    ? { ok: true, ms, error: null }
    : { ok: false, ms, error: result.error || 'Could not open a live connection' };
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

module.exports = { startLiveConnections, ensureConnection, getLiveValue, getStatus, testConnection, resetConnection };
