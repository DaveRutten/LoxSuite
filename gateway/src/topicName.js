// Turns an MQTT topic into a human-friendly label, e.g.
// "shellies/shellyplug-ZWEMBADVerwarming/relay/0/power" -> "Zwembad Verwarming - Power".
// Used as the default title whenever a widget is added without one.
const ROOT_NAMESPACES = new Set(['shellies', 'homeassistant', 'zigbee2mqtt']);
const SKIP_SEGMENTS = new Set(['command', 'set', 'status']);
const BRAND_PREFIX_RE = /^shelly[a-z0-9.]*-/i;

function splitWords(segment) {
  return segment
    .replace(/[-_]+/g, ' ')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ZWEMBADVerwarming -> ZWEMBAD Verwarming
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleCaseWord(word) {
  if (/^\d+$/.test(word)) return word; // keep channel numbers etc. as-is
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanizePart(segment) {
  return splitWords(segment).map(titleCaseWord).join(' ');
}

function humanizeTopic(topic) {
  const segments = topic.split('/').filter(Boolean);
  if (segments.length && ROOT_NAMESPACES.has(segments[0].toLowerCase())) segments.shift();
  if (segments.length === 0) return topic;

  const device = segments[0].replace(BRAND_PREFIX_RE, '');
  const rest = segments.slice(1);

  // Walk back from the end for the most specific segment that isn't a plain
  // index or a structural word like "command" — that's usually the metric.
  let metric = null;
  for (let i = rest.length - 1; i >= 0; i--) {
    const seg = rest[i];
    if (/^\d+$/.test(seg) || SKIP_SEGMENTS.has(seg.toLowerCase())) continue;
    metric = seg;
    break;
  }

  const deviceLabel = humanizePart(device);
  if (!metric) return deviceLabel || topic;
  return `${deviceLabel} - ${humanizePart(metric)}`;
}

module.exports = { humanizeTopic, BRAND_PREFIX_RE, ROOT_NAMESPACES };
