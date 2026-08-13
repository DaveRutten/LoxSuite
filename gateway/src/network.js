// Best-effort "is this request coming from our own local network" check — used only for the SSO
// break-glass local-login setting (see routes/auth.js). req.ip (not the raw socket address) so
// this respects the TRUST_PROXY opt-in (see server.js): with it unset (the default), Express's own
// req.ip is identical to the raw socket address, so nothing changes for a direct deployment. Behind
// a reverse proxy/tunnel WITHOUT that opt-in, every request's raw socket address is the proxy's own
// — always "private" regardless of the real client, which silently defeats this whole check by
// making the break-glass exemption permanent. Not X-Forwarded-For read directly here: that's
// trivially spoofable by anyone who can reach the gateway directly, which is exactly why Express's
// own trust-proxy setting (rather than a homegrown header read) gates whether req.ip trusts it at
// all.
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
  return isPrivateAddress(req.ip);
}

module.exports = { isPrivateNetworkRequest, isPrivateAddress };
