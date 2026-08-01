const { Issuer } = require('openid-client');
const db = require('./db');
const { decrypt } = require('./secretCrypto');

// Discovery is a network round-trip, so the built openid-client Client is cached and only
// rebuilt when the stored SSO settings (or the gateway's own base URL) actually change.
let cachedClient = null;
let cachedKey = null;

function loadSettings() {
  const settings = db.prepare('SELECT * FROM sso_settings WHERE id = 1').get();
  return settings ? { ...settings, client_secret: decrypt(settings.client_secret) } : settings;
}

function isEnabled() {
  const settings = loadSettings();
  return !!(settings && settings.enabled && settings.issuer_url && settings.client_id);
}

function getButtonLabel() {
  return loadSettings()?.button_label || 'Pocket ID';
}

// The break-glass local-login restriction only ever applies while SSO itself is actually usable —
// toggling it on with SSO otherwise unconfigured/disabled would just lock everyone out.
function isLocalLoginDisabled() {
  return isEnabled() && !!loadSettings()?.local_login_disabled;
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

module.exports = { getClient, isEnabled, getButtonLabel, isLocalLoginDisabled };
