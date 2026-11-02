// A simulated Miniserver for tests of the live connection (src/loxoneWebSocket.js): getPublicKey over HTTP, then
// the websocket handshake the client performs — key exchange, encrypted getkey2/getjwt, getkey/authwithtoken,
// refreshjwt, enablebinstatusupdate, keepalive. Passwords and tokens are checked for real, so a wrong password and a
// refused token are testable. Unlike dev/screenshots/fake-miniserver.js this one runs without --security-revert:
// the RSA key exchange is decrypted by hand (Node refuses PKCS#1 v1.5 padding for private decryption by default).
//
// mfa: { user: true } plays a user with the login code (Multi-Factor Authentication, Loxone Config 17.3): getjwt
// without ?otp= mails a code (into `mails`) and answers with the fields Loxone Config reads (ticket, length,
// expiresIn, resendIn); a wrong code costs one of 5 attempts. The real Miniserver's answer is not known yet (see
// loxoneWebSocket.js), this follows the fields Loxone Config 17.3 knows.
// tokenAnswer: a code getjwt answers with for every login (to play a Miniserver that keeps refusing).
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const LOXONE_EPOCH_MS = Date.UTC(2009, 0, 1);
const nowLoxone = () => Math.floor((Date.now() - LOXONE_EPOCH_MS) / 1000);
const hmacHex = (alg, keyHex, msg) => crypto.createHmac(alg === 'SHA256' ? 'sha256' : 'sha1', Buffer.from(keyHex, 'hex')).update(msg, 'utf8').digest('hex');
const shaUpper = (alg, msg) => crypto.createHash(alg === 'SHA256' ? 'sha256' : 'sha1').update(msg, 'utf8').digest('hex').toUpperCase();

function rsaDecryptPkcs1(privateKey, data) {
  const raw = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, data);
  return raw.subarray(raw.indexOf(0, 2) + 1);
}

function createFakeMiniserver({ users = { loxsuite: 'geheim' }, mfa = {}, tokenDays = 30, tokenAnswer = null } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = `-----BEGIN CERTIFICATE-----${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}-----END CERTIFICATE-----`;
  const salts = Object.fromEntries(Object.keys(users).map((u) => [u, crypto.randomBytes(8).toString('hex')]));
  const tokens = new Map(); // token -> { user, validUntil }
  const codes = new Map(); // user -> { code, until, attempts }
  const sim = {
    mails: [], // [{ user, code, at }] — the codes "mailed" to users with mfa
    tokenRequests: [], // [{ user, permission, otp: boolean }] — every getjwt
    tokenLogins: 0, // authwithtoken requests
    refused: 0, // getjwt/authwithtoken answered with something other than 200
    refreshes: 0,
    sockets: 0,
    basicAuthSeen: 0, // requests (HTTP or websocket upgrade) that carried an Authorization header
  };

  const server = http.createServer((req, res) => {
    if (req.headers.authorization) sim.basicAuthSeen += 1;
    if (req.url === '/jdev/sys/getPublicKey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ LL: { control: 'dev/sys/getPublicKey', value: certPem, Code: '200' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocket.Server({ server, path: '/ws/rfc6455' });

  wss.on('connection', (ws, req) => {
    sim.sockets += 1;
    if (req.headers.authorization) sim.basicAuthSeen += 1;
    const c = { aesKey: null, iv: null, key: null, user: null };
    const ll = (control, value, code = '200') => ws.send(JSON.stringify({ LL: { control, value, Code: code } }));

    ws.on('message', (data) => {
      let cmd = data.toString();
      if (cmd.startsWith('jdev/sys/keyexchange/')) {
        const [k, iv] = rsaDecryptPkcs1(privateKey, Buffer.from(decodeURIComponent(cmd.slice('jdev/sys/keyexchange/'.length)), 'base64')).toString('utf8').split(':');
        c.aesKey = Buffer.from(k, 'hex');
        c.iv = Buffer.from(iv, 'hex');
        ll('jdev/sys/keyexchange/', 'ok');
        return;
      }
      if (cmd.startsWith('jdev/sys/enc/')) {
        const d = crypto.createDecipheriv('aes-256-cbc', c.aesKey, c.iv);
        d.setAutoPadding(false);
        const plain = Buffer.concat([d.update(Buffer.from(decodeURIComponent(cmd.slice('jdev/sys/enc/'.length)), 'base64')), d.final()]);
        cmd = plain.subarray(0, plain.length - plain[plain.length - 1]).toString('utf8').replace(/^salt\/[0-9a-f]+\//, '').replace(/\0+$/, '');
      }
      const parts = cmd.split('/');

      if (cmd.startsWith('jdev/sys/getkey2/')) {
        const user = decodeURIComponent(parts[3]);
        c.key = crypto.randomBytes(16).toString('hex');
        // An unknown user gets a key too, as the real Miniserver: getjwt then refuses the hash.
        ll(cmd, JSON.stringify({ key: c.key, salt: salts[user] || crypto.randomBytes(8).toString('hex'), hashAlg: 'SHA256' }));
        return;
      }
      if (cmd === 'jdev/sys/getkey') {
        c.key = crypto.randomBytes(16).toString('hex');
        ll(cmd, c.key);
        return;
      }
      if (cmd.startsWith('jdev/sys/getjwt/')) {
        const [, , , hash, userEnc, permission, , infoAndOtp] = parts;
        const user = decodeURIComponent(userEnc);
        const otp = (infoAndOtp.match(/\?otp=(\d+)$/) || [])[1];
        sim.tokenRequests.push({ user, permission: Number(permission), otp: Boolean(otp) });
        const control = `jdev/sys/getjwt/${hash}/${userEnc}`;
        const refuse = (value, code = '401') => { sim.refused += 1; ll(control, value, code); };
        if (tokenAnswer) { refuse('', String(tokenAnswer)); return; }
        const expected = user in users ? hmacHex('SHA256', c.key, `${user}:${shaUpper('SHA256', `${users[user]}:${salts[user]}`)}`) : null;
        // A wrong password, as a real Miniserver answers it.
        if (!expected || expected !== hash) { refuse({ lastEdit: 1, unix: Math.floor(Date.now() / 1000) }); return; }
        if (mfa[user]) {
          const sent = codes.get(user);
          if (!otp) {
            // Without a code: mail one (a new login replaces the previous code). With a code: 5 tries, 10 minutes.
            const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
            codes.set(user, { code, until: Date.now() + 600000, attempts: 5 });
            sim.mails.push({ user, code, at: Date.now() });
            refuse({ ticket: crypto.randomBytes(8).toString('hex'), length: 6, expiresIn: 600, resendIn: 30 });
            return;
          }
          if (!sent || sent.until < Date.now()) { refuse({ reason: 'expired', length: 6 }); return; }
          if (sent.code !== otp) {
            sent.attempts -= 1;
            refuse(sent.attempts > 0 ? { attemptsLeft: sent.attempts, length: 6 } : { retryAfter: 300 });
            if (sent.attempts <= 0) codes.delete(user);
            return;
          }
          codes.delete(user);
        }
        const token = crypto.randomBytes(24).toString('hex');
        const validUntil = nowLoxone() + tokenDays * 86400;
        tokens.set(token, { user, validUntil });
        c.user = user;
        ll(control, { token, key: crypto.randomBytes(8).toString('hex'), validUntil, tokenRights: Number(permission), unsecurePass: false });
        return;
      }
      if (cmd.startsWith('authwithtoken/') || cmd.startsWith('jdev/sys/refreshjwt/')) {
        const refresh = cmd.startsWith('jdev/sys/refreshjwt/');
        const hash = refresh ? parts[3] : parts[1];
        const user = decodeURIComponent(refresh ? parts[4] : parts[2]);
        const control = refresh ? 'jdev/sys/refreshjwt' : 'authwithtoken';
        if (!refresh) sim.tokenLogins += 1;
        const hit = [...tokens.entries()].find(([t, v]) => v.user === user && v.validUntil > nowLoxone() && hmacHex('SHA256', c.key, t) === hash);
        if (!hit) { sim.refused += 1; ll(control, '', '401'); return; }
        if (refresh) {
          sim.refreshes += 1;
          hit[1].validUntil = nowLoxone() + tokenDays * 86400;
          ll(control, { token: hit[0], validUntil: hit[1].validUntil, tokenRights: 4 });
        } else {
          c.user = user;
          ll(control, { validUntil: hit[1].validUntil, tokenRights: 4 });
        }
        return;
      }
      if (cmd === 'jdev/sps/enablebinstatusupdate') {
        ll(cmd, c.user ? '1' : '', c.user ? '200' : '401');
        return;
      }
      if (cmd === 'keepalive') ll('keepalive', 'ok');
    });
  });

  return Object.assign(sim, {
    // Revokes a user's tokens (password changed, user removed): authwithtoken is refused from then on.
    revokeTokens(user) { for (const [t, v] of tokens) if (v.user === user) tokens.delete(t); },
    // Lets a token run out soon, so the client refreshes it.
    expireTokensIn(seconds) { for (const v of tokens.values()) v.validUntil = nowLoxone() + seconds; },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { sim.port = server.address().port; resolve(sim); }));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      return new Promise((resolve) => { wss.close(); server.close(() => resolve()); });
    },
  });
}

module.exports = { createFakeMiniserver };
