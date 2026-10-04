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

// The VAPID "subject" is a contact for the push services. Apple's push service rejects a made-up one
// (403 BadJwtToken) — the old default 'mailto:admin@loxsuite.local' is exactly that — so it is taken
// from the https address LoxSuite is opened on when a device switches push on, unless one is set by hand.
const OLD_SUBJECTS = new Set(['mailto:admin@loxsuite.local', '', null, undefined]);

function validSubject(s) {
  const v = String(s || '').trim();
  if (/^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v) && !/\.(local|lan|home|internal)$/i.test(v)) return v;
  if (/^https:\/\/[^\s/]+/i.test(v)) return v.replace(/\/+$/, '');
  return null;
}

async function keys() {
  const webpush = require('web-push');
  let cfg = await settings.get('push', null);
  if (!cfg?.public_key || !cfg?.private_key) {
    const k = webpush.generateVAPIDKeys();
    cfg = { public_key: k.publicKey, private_key: encrypt(k.privateKey), subject: null };
    await settings.set('push', cfg);
  }
  return { publicKey: cfg.public_key, privateKey: decrypt(cfg.private_key), subject: validSubject(cfg.subject) || 'mailto:push@loxsuite.app' };
}

// Remember the https address LoxSuite is used on as the push contact (only when none was set by hand).
async function adoptOrigin(origin) {
  const o = validSubject(origin);
  if (!o || !/^https:/i.test(o)) return;
  const cfg = await settings.get('push', null);
  if (!cfg || (!OLD_SUBJECTS.has(cfg.subject) && validSubject(cfg.subject))) return;
  await settings.set('push', { ...cfg, subject: o });
}

async function setSubject(subject) {
  const v = validSubject(subject);
  if (!v) throw new Error('Use an e-mail address (mailto:you@example.com) or the https address of LoxSuite.');
  const cfg = await settings.get('push', null) || {};
  await settings.set('push', { ...cfg, subject: v });
  return v;
}

// A push service's refusal, in words.
function explainError(err) {
  const code = err?.statusCode;
  const body = String(err?.body || '').slice(0, 160).trim();
  if (!code) return err?.message || String(err);
  let hint = '';
  if (code === 403 && /BadJwtToken/i.test(body)) hint = ' — Apple rejects the push contact; set it under "Push contact" below (your e-mail or the https address of LoxSuite).';
  else if (code === 403 || code === 401) hint = ' — the device was registered with other keys; switch push off and on again on that device.';
  else if (code === 400) hint = ' — the push service refused the message; switch push off and on again on that device.';
  else if (code === 413) hint = ' — the message is too long.';
  else if (code === 429) hint = ' — too many messages, try again later.';
  return `Push service answered HTTP ${code}${body ? ` (${body})` : ''}${hint}`;
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
      if (s.last_error) await db.prepare('UPDATE push_subscriptions SET last_error = NULL WHERE id = ?').run(s.id).catch(() => {});
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await unsubscribe(s.endpoint); // device gone
      else {
        const why = explainError(err);
        errors.push(why);
        await db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(why.slice(0, 200), s.id).catch(() => {});
      }
    }
  }
  if (!ok && errors.length) throw new Error(errors[0]);
  return { sent: ok, failed: errors.length, errors };
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

module.exports = { keys, publicKey, adoptOrigin, setSubject, validSubject, explainError, subjectSetting: async () => (await settings.get('push', null))?.subject || null, subscribe, unsubscribe, parseTarget, isPushUrl, send, eventToPayload, listDevices };
