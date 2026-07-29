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
  return value;
}

// Looks up a mapping by its token. If none exists and auto-create is enabled
// in Settings, the incoming token/topic string is treated as a literal MQTT
// topic and a new passthrough mapping is created for it on the fly — this is
// opt-in and off by default, since a mistyped token would otherwise silently
// spawn a mapping instead of failing loudly.
function findOrAutoCreateLoxoneMapping(token, transport) {
  const existing = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE token = ? AND enabled = 1').get(token);
  if (existing) return existing;

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
