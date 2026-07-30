// Proxies a user's SSO-provided avatar through this gateway's own origin instead of the browser
// hot-linking Pocket ID directly. Loading it cross-origin from the account menu/Administration >
// Users failed in a real browser with net::ERR_BLOCKED_BY_ORB (Chrome's Opaque Response Blocking)
// even though the same URL was fetchable fine outside a browser context (plain curl) — Pocket ID
// evidently answers an actual <img> fetch differently than a bare HTTP client. Since the browser
// only ever talks to LoxSuite's own origin here, no cross-origin request happens at all.
const express = require('express');
const db = require('../db');

const router = express.Router();
const FETCH_TIMEOUT_MS = 5000;

router.get('/:userId', async (req, res) => {
  const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.params.userId);
  if (!user || !user.avatar_url) return res.status(404).end();

  try {
    const upstream = await fetch(user.avatar_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!upstream.ok || !upstream.body) return res.status(502).end();

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    // Private (this is fetched with no auth of its own, so treat it as potentially
    // account-specific) but fine to cache client-side for a while — an avatar changing is rare
    // enough that re-fetching on every single page load would just be wasted upstream requests.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).end();
  }
});

module.exports = router;
