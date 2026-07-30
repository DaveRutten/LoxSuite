// Best-effort "is this request coming from our own local network" check — used only for the SSO
// break-glass local-login setting (see routes/auth.js). Based on the raw socket address, not any
// client-supplied header (X-Forwarded-For etc. would be trivially spoofable by anyone who can
// reach the gateway directly, which defeats the whole point of the check). If the gateway is
// deployed behind a reverse proxy, every request arrives from the proxy's own address — set
// TRUSTED_PROXY_HEADER handling up explicitly there rather than trusting client headers by default.
const PRIVATE_V4_RANGES = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^192\.168\./, // RFC1918
];

function isPrivateAddress(address) {
  if (!address) return false;
  // req.socket.remoteAddress for an IPv4-mapped connection on a dual-stack socket looks like
  // "::ffff:127.0.0.1" — strip the prefix so the plain v4 checks below still match.
  const addr = address.replace(/^::ffff:/, '');

  if (addr === '::1') return true; // IPv6 loopback
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true; // fc00::/7, IPv6 unique local addresses

  return PRIVATE_V4_RANGES.some((re) => re.test(addr));
}

function isPrivateNetworkRequest(req) {
  return isPrivateAddress(req.socket && req.socket.remoteAddress);
}

module.exports = { isPrivateNetworkRequest, isPrivateAddress };
