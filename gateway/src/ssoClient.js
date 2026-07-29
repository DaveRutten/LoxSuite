const { Issuer } = require('openid-client');
const db = require('./db');

// Discovery is a network round-trip, so the built openid-client Client is cached and only
// rebuilt when the stored SSO settings (or the gateway's own base URL) actually change.
let cachedClient = null;
let cachedKey = null;

function loadSettings() {
  return db.prepare('SELECT * FROM sso_settings WHERE id = 1').get();
}

function isEnabled() {
  const settings = loadSettings();
  return !!(settings && settings.enabled && settings.issuer_url && settings.client_id);
}

function getButtonLabel() {
  return loadSettings()?.button_label || 'Pocket ID';
}

async function getClient(baseUrl) {
  const settings = loadSettings();
  if (!settings || !settings.enabled || !settings.issuer_url || !settings.client_id) {
    throw new Error('Single Sign-On is not configured.');
  }

  const key = JSON.stringify([settings.issuer_url, settings.client_id, settings.client_secret, baseUrl]);
  if (cachedClient && cachedKey === key) return cachedClient;

  const issuer = await Issuer.discover(settings.issuer_url);
  const client = new issuer.Client({
    client_id: settings.client_id,
    client_secret: settings.client_secret,
    redirect_uris: [`${baseUrl}/auth/sso/callback`],
    response_types: ['code'],
  });

  cachedClient = client;
  cachedKey = key;
  return client;
}

module.exports = { getClient, isEnabled, getButtonLabel };
