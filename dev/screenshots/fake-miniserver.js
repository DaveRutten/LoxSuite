// Minimal fake Loxone Miniserver — HTTP (getPublicKey, LoxAPP3.json) + the exact websocket
// handshake gateway/src/loxoneWebSocket.js's real client performs, enough to get the Live Data
// page rendering real, populated (but entirely synthetic) room/category/state data for a
// screenshot, with no real Miniserver involved. Mirrors the handshake steps in loxoneWebSocket.js
// step for step; see that file's own comments for the protocol reference.
//
// Deliberately NOT cryptographically faithful beyond what the real client actually checks: getkey2
// returns *some* key/salt (the client hashes with it, but this server never verifies that hash —
// gettoken always succeeds). Only the RSA key-exchange decrypt (needed to recover the client's own
// AES session key so later encrypted commands are readable) and the AES-CBC decrypt of those
// commands are done for real.
//
// Run with --security-revert=CVE-2023-46809 (see run.sh) — Node 20+ disables RSA_PKCS1_PADDING for
// PRIVATE decryption by default (the Marvin-attack/Bleichenbacher mitigation); Loxone's own
// handshake uses PKCS#1v1.5 throughout and there's no other padding to switch to on either side.
// Safe here specifically because this is a local, throwaway dev/screenshot tool, never exposed to
// real network traffic or real credentials.
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const HTTP_PORT = Number(process.env.FAKE_MS_PORT || 7701);

// ---- Structure (LoxAPP3.json) ----------------------------------------------------------------
// Loxone's own 8-4-4-16 hex grouping (see loxoneWebSocket.js's uuidBytesToString) — every state
// uuid below must be shaped like this or the wire encoder below can't round-trip it.
function fakeUuid(seed) {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 32)}`;
}

const rooms = {
  [fakeUuid('room-living')]: { name: 'Living room', uuid: fakeUuid('room-living') },
  [fakeUuid('room-kitchen')]: { name: 'Kitchen', uuid: fakeUuid('room-kitchen') },
};
rooms[fakeUuid('room-utility')] = { name: 'Utility room', uuid: fakeUuid('room-utility') };
const roomUtility = fakeUuid('room-utility');
const roomLiving = fakeUuid('room-living');
const roomKitchen = fakeUuid('room-kitchen');

const cats = {
  [fakeUuid('cat-lights')]: { name: 'Lighting', type: 'lights' },
  [fakeUuid('cat-temp')]: { name: 'Climate', type: 'indoortemperature' },
  [fakeUuid('cat-shading')]: { name: 'Shading', type: 'shading' },
};
cats[fakeUuid('cat-energy')] = { name: 'Energy', type: 'undefined' };
const catEnergy = fakeUuid('cat-energy');
const catLights = fakeUuid('cat-lights');
const catTemp = fakeUuid('cat-temp');
const catShading = fakeUuid('cat-shading');

// [name, room, cat, type, states: {stateName: uuidSeed}]
const controlDefs = [
  ['Ceiling light', roomLiving, catLights, 'Switch', { active: 'living-ceiling-active' }],
  ['Floor lamp', roomLiving, catLights, 'Dimmer', { position: 'living-floorlamp-pos' }],
  ['Room temperature', roomLiving, catTemp, 'IRoomControllerV2', { tempActual: 'living-temp-actual', tempTarget: 'living-temp-target' }],
  ['Living room blinds', roomLiving, catShading, 'Jalousie', { position: 'living-blinds-pos' }],
  ['Counter light', roomKitchen, catLights, 'Switch', { active: 'kitchen-counter-active' }],
  ['Kitchen temperature', roomKitchen, catTemp, 'IRoomControllerV2', { tempActual: 'kitchen-temp-actual', tempTarget: 'kitchen-temp-target' }],
  // Energy (Wallbox → Meters, Smart charging, Energy manager) — fixed plausible values, see FIXED below
  ['Grid meter', roomUtility, catEnergy, 'Meter', { actual: 'grid-actual', total: 'grid-total', totalNeg: 'grid-totalneg' }, { type: 'bidirectional' }],
  ['Solar inverter', roomUtility, catEnergy, 'Meter', { actual: 'pv-actual', total: 'pv-total' }],
  ['Wallbox', roomUtility, catEnergy, 'Wallbox2', { actual: 'wb-actual', total: 'wb-total', connected: 'wb-connected', active: 'wb-active', mode: 'wb-mode', limit: 'wb-limit', enabled: 'wb-enabled' }],
  ['Heat pump', roomUtility, catEnergy, 'Meter', { actual: 'hp-actual', total: 'hp-total' }],
  ['Hot water boiler', roomUtility, catEnergy, 'Meter', { actual: 'dhw-actual', total: 'dhw-total' }],
  ['Washing machine', roomUtility, catEnergy, 'Meter', { actual: 'wm-actual', total: 'wm-total' }],
  // on/off and status signals of the energy manager's consumers (appended: the indices above stay)
  ['Washing machine program', roomUtility, catEnergy, 'InfoOnlyAnalog', { value: 'wm-status' }],
  ['Heat pump compressor', roomUtility, catEnergy, 'Switch', { active: 'hp-on' }],
  ['Heat pump mode', roomUtility, catEnergy, 'InfoOnlyAnalog', { value: 'hp-mode' }],
];

const controls = {};
const stateSeeds = new Map(); // uuid -> { seed }
controlDefs.forEach(([name, room, cat, type, stateMap, details], i) => {
  const states = {};
  for (const [stateName, seed] of Object.entries(stateMap)) {
    const uuid = fakeUuid(seed);
    states[stateName] = uuid;
    stateSeeds.set(uuid, { seed });
  }
  controls[fakeUuid(`control-${i}`)] = { name, room, cat, type, states, ...(details ? { details } : {}) };
});

const structure = { rooms, cats, controls, mediaServer: {} };

// ---- Live value simulation --------------------------------------------------------------------
// Deterministic-ish per-uuid base value + a small wiggle each push, purely so a temperature/dimmer
// reads like a real, slightly-alive install rather than a static 0 across the whole page.
// Energy values: a sunny midday with the car away — exporting, the heat pump idling.
const FIXED = {
  'grid-actual': () => -1.85 + Math.random() * 0.1, 'grid-total': () => 18412.6, 'grid-totalneg': () => 9873.4,
  'pv-actual': () => 4.62 + Math.random() * 0.1, 'pv-total': () => 21307.9,
  'wb-actual': () => 0, 'wb-total': () => 5650.2, 'wb-connected': () => 0, 'wb-active': () => 0, 'wb-mode': () => 1, 'wb-limit': () => 11, 'wb-enabled': () => 1,
  'hp-actual': () => 0.42 + Math.random() * 0.05, 'hp-total': () => 4120.3,
  'dhw-actual': () => 0, 'dhw-total': () => 1388.6,
  'wm-actual': () => 1.92 + Math.random() * 0.05, 'wm-total': () => 412.3,
  'wm-status': () => 1, 'hp-on': () => 1, 'hp-mode': () => 1,
};
function currentValue(uuid) {
  const info = stateSeeds.get(uuid);
  const seed = info ? info.seed : uuid;
  if (FIXED[seed]) return FIXED[seed]();
  const hash = crypto.createHash('md5').update(seed).digest();
  const base = hash.readUInt8(0);
  if (seed.includes('temp-actual')) return 20 + (base % 4) + Math.random() * 0.4;
  if (seed.includes('temp-target')) return 21 + (base % 3);
  if (seed.includes('active')) return base % 2;
  if (seed.includes('pos')) return Math.round((base / 255) * 100) / 100;
  return base;
}

function uuidStringToBytes(uuidStr) {
  const [d1, d2, d3, d4] = uuidStr.split('-');
  const buf = Buffer.alloc(16);
  Buffer.from(d1, 'hex').reverse().copy(buf, 0);
  Buffer.from(d2, 'hex').reverse().copy(buf, 4);
  Buffer.from(d3, 'hex').reverse().copy(buf, 6);
  Buffer.from(d4, 'hex').copy(buf, 8);
  return buf;
}

function buildValueFrame(uuids) {
  const payload = Buffer.alloc(uuids.length * 24);
  uuids.forEach((uuid, i) => {
    uuidStringToBytes(uuid).copy(payload, i * 24);
    payload.writeDoubleLE(currentValue(uuid), i * 24 + 16);
  });
  const header = Buffer.alloc(8);
  header.writeUInt8(3, 0); // fixed marker byte, per the real protocol
  header.writeUInt8(2, 1); // identifier 2 = value states
  header.writeUInt32LE(payload.length, 4);
  return [header, payload];
}

// ---- RSA keypair for the fake key-exchange ------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// Loxone serves this labeled as a CERTIFICATE, as one unbroken base64 blob glued directly onto the
// BEGIN/END marker lines with no line-wrapping and no newline of its own after BEGIN — the real
// client's own connect() (loxoneWebSocket.js) inserts exactly those two newlines itself as part of
// its own replace() calls when converting this into a normal PUBLIC KEY PEM, so matching that exact
// (newline-free) shape here, rather than a normally-formatted multi-line PEM, is what keeps the
// client's own substitution from producing a doubled/malformed newline OpenSSL then rejects.
const publicKeyDerBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const fakeCertPem = `-----BEGIN CERTIFICATE-----${publicKeyDerBase64}-----END CERTIFICATE-----`;

function pkcs7unpad(buf) {
  const padLen = buf[buf.length - 1];
  return buf.subarray(0, buf.length - padLen);
}

// Appointments relative to today (local time of the container): a few with the car (🚗), some without.
function demoCalendar() {
  const pad = (n) => String(n).padStart(2, '0');
  const at = (dayOffset, h, m) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`; };
  const ev = (uid, d, h1, m1, h2, m2, title, loc) => ['BEGIN:VEVENT', `UID:${uid}@demo`, `DTSTART:${at(d, h1, m1)}`, `DTEND:${at(d, h2, m2)}`, `SUMMARY:${title}`, loc ? `LOCATION:${loc}` : null, 'END:VEVENT'].filter(Boolean).join('\r\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LoxSuite demo//EN', 'X-WR-CALNAME:Family',
    ev('e1', 0, 9, 30, 10, 30, 'Team meeting', null),
    ev('e2', 1, 14, 0, 16, 0, '🚗 Customer visit', 'Amersfoort'),
    ev('e3', 2, 19, 0, 21, 0, 'Sports', 'Sports park'),
    ev('e4', 3, 12, 0, 13, 0, 'Lunch', null),
    ev('e8', 3, 8, 0, 17, 0, 'Thuiswerken', null),
    ev('e9', 9, 8, 0, 20, 0, 'Vakantie Texel', 'Texel'),
    ev('e5', 4, 15, 30, 16, 30, 'Dentist', 'High Street 3'),
    ev('e6', 5, 10, 0, 18, 0, '🚗 Birthday party', 'Eindhoven'),
    ['BEGIN:VEVENT', 'UID:e7@demo', `DTSTART:${at(0, 19, 0)}`, `DTEND:${at(0, 20, 0)}`, 'RRULE:FREQ=WEEKLY;COUNT=8', 'SUMMARY:Hockey training kids', 'LOCATION:Sports park', 'END:VEVENT'].join('\r\n'),
    'END:VCALENDAR', ''].join('\r\n');
}

// ---- HTTP + WS server -------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/jdev/sys/getPublicKey') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ LL: { control: 'jdev/sys/getPublicKey', value: fakeCertPem, Code: '200' } }));
    return;
  }
  if (req.url === '/data/LoxAPP3.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(structure));
    return;
  }
  // A car's own data as JSON (vehicle source "HTTP / JSON URL"), for the vehicle pages.
  if (req.url === '/car.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ battery: { soc: 64, range_km: 41 }, total_range_km: 612, plugged: false, charging: false, limit: 100, odometer: 23456.8, position: { lat: 52.0907, lon: 5.1214 }, place: 'Utrecht Centraal' }));
    return;
  }
  // A calendar (ICS) with appointments around today, for the agenda.
  if (req.url === '/calendar.ics') {
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(demoCalendar());
    return;
  }
  // /data/status deliberately not implemented — loxoneHardware.js's periodic poll fails closed
  // (caught, logged, no rows touched) rather than clobbering the hand-seeded loxone_hardware_devices
  // rows the Hardware page screenshot actually uses.
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, path: '/ws/rfc6455' });

wss.on('connection', (ws) => {
  let aesKey = null;
  let iv = null;
  let pushTimer = null;

  function sendLL(control, value, code = '200') {
    ws.send(JSON.stringify({ LL: { control, value, Code: code } }));
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // client never sends binary
    const text = data.toString();

    if (text.startsWith('jdev/sys/keyexchange/')) {
      const encrypted = decodeURIComponent(text.slice('jdev/sys/keyexchange/'.length));
      const decrypted = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(encrypted, 'base64')
      );
      const [aesKeyHex, ivHex] = decrypted.toString('utf8').split(':');
      aesKey = Buffer.from(aesKeyHex, 'hex');
      iv = Buffer.from(ivHex, 'hex');
      sendLL('jdev/sys/keyexchange/ok', 'ok');
      return;
    }

    if (text.startsWith('jdev/sys/enc/')) {
      const encB64 = decodeURIComponent(text.slice('jdev/sys/enc/'.length));
      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      decipher.setAutoPadding(false);
      const padded = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
      const plain = pkcs7unpad(padded).toString('utf8'); // "salt/<salt>/<command>\0"
      const command = plain.replace(/^salt\/[0-9a-f]+\//, '').replace(/\0+$/, '');

      if (command.startsWith('jdev/sys/getkey2/')) {
        sendLL('jdev/sys/getkey2/ok', { key: crypto.randomBytes(16).toString('hex'), salt: crypto.randomBytes(8).toString('hex'), hashAlg: 'SHA1' });
        return;
      }
      if (command.startsWith('jdev/sys/gettoken/')) {
        sendLL('jdev/sys/gettoken/ok', { token: 'fake-token', validUntil: 0, tokenRights: 4, unsecurePass: false });
        return;
      }
      return;
    }

    if (text === 'jdev/sps/enablebinstatusupdate') {
      sendLL('jdev/sps/enablebinstatusupdate', '1');
      const allUuids = [...stateSeeds.keys()];
      // Send an immediate first push (Live Data's own screenshot needs values populated well
      // before Playwright ever gets a chance to click into a room, not just eventually).
      const send = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const [header, payload] = buildValueFrame(allUuids);
        ws.send(header, { binary: true });
        ws.send(payload, { binary: true });
      };
      send();
      pushTimer = setInterval(send, 2000);
      return;
    }

    if (text === 'keepalive') {
      sendLL('keepalive', 'ok');
    }
  });

  ws.on('close', () => { if (pushTimer) clearInterval(pushTimer); });
});

server.listen(HTTP_PORT, () => {
  console.log(`[fake-miniserver] listening on ${HTTP_PORT} (HTTP + ws/rfc6455)`);
});
