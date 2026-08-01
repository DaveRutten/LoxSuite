const crypto = require('crypto');

// Encrypts secrets LoxSuite has to actively USE against something else (Miniserver passwords, the
// MQTT broker password, the SSO client secret, rclone.conf) — unlike a web UI login password
// (users.password_hash, bcrypt), these can't be one-way hashed since the app has to send the real
// value back out. Key is derived from SESSION_SECRET rather than a new required env var, so
// existing installs keep working without touching .env/the Unraid template; rotating
// SESSION_SECRET does mean these values need re-entering, same trade-off the session cookies
// already have today.
const SALT = 'loxsuite-secret-crypto-v1';
const PREFIX = 'enc:v1:';

function getKey() {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  return crypto.scryptSync(secret, SALT, 32);
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Empty/null values pass straight through — an empty password field means "no password", not "an
// empty string to encrypt", and avoids every call site needing its own if-blank guard.
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted — don't double-wrap
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// Returns the value unchanged if it isn't in the enc:v1: form at all — a defensive fallback for a
// value that predates this feature and hasn't been migrated yet, rather than throwing and breaking
// whatever's reading it.
function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncrypted(value)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('secretCrypto: failed to decrypt a stored value (wrong/rotated SESSION_SECRET?):', err.message);
    return value;
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
