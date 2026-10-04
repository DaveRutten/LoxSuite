// Web push: LoxSuite as an app on the phone's home screen that receives notifications (account
// menu > App & push). Standard Web Push with VAPID keys generated once per installation (private key
// encrypted at rest). Any notification channel whose URL is
//   loxsuite-push://all        -> every subscribed device
//   loxsuite-push://user/<id>  -> the devices of that LoxSuite user
// is delivered here instead of through Apprise (see notifications.sendToChannel). Needs LoxSuite to
// be opened over HTTPS with a valid certificate (a browser rule for push and home-screen apps);
// on iPhone it works from iOS 16.4 for LoxSuite added to the home screen.
const db = require('./db');
const settings = require('./wallboxSettings');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./secretCrypto');

const endpointHash = (e) => crypto.createHash('sha256').update(String(e)).digest('hex');

async function keys() {
  const webpush = require('web-push');
  let cfg = await settings.get('push', null);
  if (!cfg?.public_key || !cfg?.private_key) {
    const k = webpush.generateVAPIDKeys();
    cfg = { public_key: k.publicKey, private_key: encrypt(k.privateKey), subject: 'mailto:admin@loxsuite.local' };
    await settings.set('push', cfg);
  }
  return { publicKey: cfg.public_key, privateKey: decrypt(cfg.private_key), subject: cfg.subject || 'mailto:admin@loxsuite.local' };
}

async function publicKey() { return (await keys()).publicKey; }

async function subscribe(userId, sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid subscription.');
  await db.upsert('push_subscriptions', {
    user_id: userId || null, endpoint: sub.endpoint, endpoint_hash: endpointHash(sub.endpoint), keys_json: JSON.stringify(sub.keys),
    user_agent: String(userAgent || '').slice(0, 200), created_at: new Date().toISOString(), last_error: null,
  }, ['endpoint_hash']);
}

async function unsubscribe(endpoint) {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ?').run(endpointHash(endpoint));
}

function parseTarget(url) {
  const m = /^loxsuite-push:\/\/(all|user\/(\d+))\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  return m[2] ? { userId: Number(m[2]) } : { all: true };
}

function isPushUrl(url) { return /^loxsuite-push:\/\//i.test(String(url || '')); }

// payload: { title, body, url, tag, actions: [{action, title}], data }
async function send(target, payload, { sendImpl } = {}) {
  const webpush = require('web-push');
  const k = await keys();
  const subs = target.all
    ? await db.prepare('SELECT * FROM push_subscriptions').all()
    : await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(target.userId);
  if (!subs.length) throw new Error('No device has push notifications switched on yet (account menu > App & push).');
  const doSend = sendImpl || ((sub, body) => webpush.sendNotification(sub, body, {
    vapidDetails: { subject: k.subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600,
  }));
  let ok = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await doSend({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, JSON.stringify(payload));
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await unsubscribe(s.endpoint); // device gone
      else {
        errors.push(err.message);
        await db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 200), s.id).catch(() => {});
      }
    }
  }
  if (!ok && errors.length) throw new Error(errors[0]);
  return { sent: ok };
}

// Notification-center event -> push payload.
function eventToPayload(event) {
  const lines = [event.message, ...(event.fields || []).filter((f) => !String(event.message || '').includes(String(f.value))).slice(0, 3).map((f) => `${f.label}: ${f.value}`)];
  return {
    title: event.title, body: lines.filter(Boolean).join('\n').slice(0, 400), tag: event.tag || event.title,
    url: event.url || '/', actions: event.actions || [], data: event.data || {},
  };
}

async function listDevices() {
  return db.prepare('SELECT s.id, s.user_id, s.user_agent, s.created_at, s.last_error, u.username FROM push_subscriptions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC').all();
}

module.exports = { keys, publicKey, subscribe, unsubscribe, parseTarget, isPushUrl, send, eventToPayload, listDevices };
