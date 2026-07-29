// Best-effort severity classification for raw log lines (Mosquitto's own log and Loxone's
// def.log). Neither source tags its lines with an explicit level, so this is a keyword
// heuristic rather than a real parse — same tradeoff already accepted for the CONNECT/DISCONNECT
// regexes in mosquittoLog.js. Order matters: error is checked before warning so a line matching
// both (e.g. "error ... after timeout") is classified by its more severe word.
const ERROR_WORDS = /\b(error|fail(?:ed|ure)?|denied|not authoris(?:ed|zed)|unable|cannot|refused|exception|invalid|reject(?:ed)?)\b/i;
const WARNING_WORDS = /\b(warn(?:ing)?|timeout|timed out|retry(?:ing)?|reconnect(?:ing)?|deprecat(?:ed|ion))\b/i;

function classifyLogLevel(line) {
  if (ERROR_WORDS.test(line)) return 'error';
  if (WARNING_WORDS.test(line)) return 'warning';
  return 'info';
}

module.exports = { classifyLogLevel };
