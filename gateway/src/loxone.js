const dgram = require('dgram');
const { Agent } = require('undici');
const db = require('./db');

// Local Loxone Miniservers use a self-signed HTTPS certificate, so the default
// fetch() TLS verification would reject every request to a use_https=1 server.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

function applyTranslationTable(mappingId, value) {
  const row = db
    .prepare('SELECT output_value FROM mapping_translations WHERE mapping_id = ? AND match_value = ?')
    .get(mappingId, value);
  // No match: pass the original value through unchanged rather than failing the mapping.
  return row ? row.output_value : value;
}

function applyTransform(rawValue, mapping) {
  const value = rawValue.toString().trim();

  if (mapping.value_transform === 'bool_on_off') {
    const truthy = ['on', 'true', '1', 'open', 'high'];
    return truthy.includes(value.toLowerCase()) ? '1' : '0';
  }

  if (mapping.value_transform === 'translation_table') {
    return applyTranslationTable(mapping.id, value);
  }

  if (mapping.value_transform === 'json_path' && mapping.transform_arg) {
    try {
      const parsed = JSON.parse(value);
      return mapping.transform_arg
        .split('.')
        .filter(Boolean)
        .reduce((acc, key) => (acc == null ? undefined : acc[key]), parsed);
    } catch (err) {
      throw new Error(`json_path transform failed: ${err.message}`);
    }
  }

  return value;
}

function miniserverBaseUrl(miniserver) {
  const protocol = miniserver.use_https ? 'https' : 'http';
  return `${protocol}://${miniserver.host}:${miniserver.http_port}`;
}

// Tries the local host/port first, falling back to external_url (if configured) only when the
// local attempt fails at the network level (timeout, refused, DNS) — a non-2xx HTTP response
// still means the Miniserver was reached, so callers check res.ok themselves and no fallback
// happens in that case. This is what lets a single Miniserver stay usable both on the local
// network and remotely without switching configuration.
async function fetchMiniserver(miniserver, path, options = {}) {
  const auth = Buffer.from(`${miniserver.username}:${miniserver.password}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, ...(options.headers || {}) };
  const { timeoutMs, ...restOptions } = options;

  const candidates = [{ base: miniserverBaseUrl(miniserver), dispatcher: miniserver.use_https ? insecureAgent : undefined }];
  if (miniserver.external_url) {
    candidates.push({ base: miniserver.external_url.replace(/\/+$/, ''), dispatcher: undefined });
  }

  let lastErr;
  for (const { base, dispatcher } of candidates) {
    // A fresh timeout per candidate — reusing one AbortSignal across both attempts would let a
    // local address that hangs (rather than immediately refusing) burn through the whole budget,
    // leaving the external-URL fallback aborted before it even gets to try.
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : restOptions.signal;
    try {
      return await fetch(`${base}${path}`, { ...restOptions, headers, dispatcher, signal });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function sendHttpVirtualInput(miniserver, target, value) {
  const res = await fetchMiniserver(miniserver, `/dev/sps/io/${encodeURIComponent(target)}/${encodeURIComponent(value)}`);

  if (!res.ok) {
    throw new Error(`Miniserver responded with HTTP ${res.status}`);
  }
}

// Matches LoxBerry's convention: send "MQTT:<topic>=<value>" over UDP, and configure
// the Loxone Virtual Input's "Command Recognition" field with commandRecognitionString(topic)
// below so Loxone extracts the value itself — no separate token/name needed.
function sendUdpVirtualInput(miniserver, topic, value) {
  return new Promise((resolve, reject) => {
    if (!miniserver.udp_port) {
      reject(new Error('Miniserver has no udp_port configured'));
      return;
    }
    const message = Buffer.from(`MQTT:${topic}=${value}`);
    const socket = dgram.createSocket('udp4');
    socket.send(message, miniserver.udp_port, miniserver.host, (err) => {
      socket.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function commandRecognitionString(topic) {
  return `MQTT:\\i${topic}=\\i\\v`;
}

// Loxone's RGB virtual output (Lighting Controller / Lumitech's own color half) sends its value
// as a plain "H,S,V" string — Hue 0-360, Saturation 0-100, brightness (Value) 0-100 — a convention
// shared across pretty much every third-party Loxone integration (Home Assistant's own Loxone
// integration, node-red-contrib-loxone, ...), not something specific to this app. Converted here
// to 0-255 RGB since that's what Shelly's own color/N/set JSON body expects.
function loxoneHsvToRgb(raw) {
  const parts = String(raw).split(',').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, s, v] = parts;
  const c = (v / 100) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v / 100 - c;
  let r1;
  let g1;
  let b1;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return {
    red: Math.round((r1 + m) * 255),
    green: Math.round((g1 + m) * 255),
    blue: Math.round((b1 + m) * 255),
  };
}

// Shelly RGBW-family devices (RGBW2/Bulb in color mode) — same conversion LoxBerry's own
// "shelly_rgb&w" UDP transformer does, built natively here instead of needing that separate
// plugin. transform_arg picks which of the three independent Loxone outputs this mapping carries
// (white/rgb/tunablew); each publishes its own partial JSON body to the SAME color/N/set topic,
// same as LoxBerry's own transformer does — Shelly itself is what merges partial updates onto
// whatever it's already showing, this doesn't need to send a complete state every time.
//
// Best-effort against community-documented field names (Shelly's own official RGBW2 API doc isn't
// something this app has direct access to) — verify actual color output against a real device
// before relying on this, and it's easy to adjust once confirmed.
function applyShellyRgbwTransform(mode, rawValue) {
  if (mode === 'white') {
    const pct = Math.max(0, Math.min(100, Math.round(Number(rawValue))));
    if (!Number.isFinite(pct)) return String(rawValue);
    return JSON.stringify({ white: pct, turn: pct > 0 ? 'on' : 'off' });
  }
  if (mode === 'rgb') {
    const rgb = loxoneHsvToRgb(rawValue);
    // Passes the raw value through unchanged rather than sending a malformed color command when
    // it doesn't parse as "H,S,V" — a mapping mid-setup (nothing wired to it yet) shouldn't spam
    // the device with a broken publish.
    if (!rgb) return String(rawValue).trim();
    return JSON.stringify({ ...rgb, turn: 'on' });
  }
  if (mode === 'tunablew') {
    // Loxone's Lumitech output sends "brightness,kelvin" (brightness 0-100, kelvin 2700-6500).
    // Shelly's own tunable-white range is narrower (3000-6500K), so this scales linearly across
    // that instead of just clamping — a clamp would flatten every value below 3000K to the exact
    // same output, losing the low end of Lumitech's range entirely instead of just compressing it.
    const parts = String(rawValue).split(',').map(Number);
    if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return String(rawValue).trim();
    const [brightness, kelvin] = parts;
    const clampedKelvin = Math.max(2700, Math.min(6500, kelvin));
    const scaledTemp = Math.round(3000 + ((clampedKelvin - 2700) / (6500 - 2700)) * (6500 - 3000));
    const pct = Math.max(0, Math.min(100, Math.round(brightness)));
    return JSON.stringify({ white: pct, temp: scaledTemp, turn: pct > 0 ? 'on' : 'off' });
  }
  return String(rawValue).trim();
}

// For the Loxone -> MQTT direction (e.g. Loxone sends a raw 0/1, but a Shelly
// command topic expects the text "off"/"on").
function applyLoxoneToMqttTransform(mapping, rawValue) {
  const value = rawValue.toString().trim();
  if (mapping.value_transform === 'translation_table') {
    const row = db
      .prepare('SELECT output_value FROM loxone_mapping_translations WHERE mapping_id = ? AND match_value = ?')
      .get(mapping.id, value);
    return row ? row.output_value : value;
  }
  if (mapping.value_transform === 'shelly_rgbw') {
    return applyShellyRgbwTransform(mapping.transform_arg, rawValue);
  }
  return value;
}

// Looks up a mapping by its token, falling back to matching the mapping's own
// mqtt_topic — so an existing mapping can be triggered either by its opaque
// token or by sending its real MQTT topic string, without needing auto-create
// and without risking a duplicate mapping. If neither matches and auto-create is
// enabled in Settings, the incoming token/topic string is treated as a literal
// MQTT topic and a new passthrough mapping is created for it on the fly — this
// remains opt-in and off by default, since a mistyped token would otherwise
// silently spawn a mapping instead of failing loudly.
function findOrAutoCreateLoxoneMapping(token, transport) {
  const existing = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE token = ? AND enabled = 1').get(token);
  if (existing) return existing;

  const byTopic = db
    .prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE mqtt_topic = ? AND transport = ? AND enabled = 1')
    .get(token, transport);
  if (byTopic) return byTopic;

  const settings = db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
  if (!settings || !settings.auto_create_loxone_mappings) return null;

  try {
    db.prepare(
      `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, qos, retain, transport, value_transform)
       VALUES (NULL, ?, ?, 0, 0, ?, 'passthrough')`
    ).run(token, token, transport);
    console.log(`Auto-created Loxone -> MQTT mapping for topic "${token}" (${transport}).`);
  } catch (err) {
    // token is globally unique — this same topic string was already auto-created
    // under a different transport, so just reuse that existing mapping's token.
  }

  return db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE token = ?').get(token);
}

async function forwardToLoxone(mapping, rawValue, actualTopic) {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(mapping.miniserver_id);
  if (!miniserver) {
    throw new Error(`Miniserver ${mapping.miniserver_id} not found`);
  }

  const value = applyTransform(rawValue, mapping);

  if (mapping.transport === 'udp') {
    await sendUdpVirtualInput(miniserver, actualTopic || mapping.mqtt_topic, value);
  } else {
    await sendHttpVirtualInput(miniserver, mapping.target, value);
  }

  db.prepare('UPDATE miniservers SET last_success_at = ?, last_error = NULL WHERE id = ?')
    .run(new Date().toISOString(), miniserver.id);
}

module.exports = {
  forwardToLoxone,
  applyTransform,
  applyLoxoneToMqttTransform,
  findOrAutoCreateLoxoneMapping,
  miniserverBaseUrl,
  fetchMiniserver,
  insecureAgent,
  commandRecognitionString,
};
