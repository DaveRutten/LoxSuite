// Parses and validates the DB_BACKEND/DATABASE_URL/DB_* environment variables into one plain
// config object db/knex.js's buildKnexConfig() (and backup.js's own per-backend engine) can act on
// directly, and fails LOUD at boot if it doesn't add up — see the project's own db-backend plan for
// why this is the app's first genuinely fail-fast config path. Every other misconfiguration in this
// codebase warns and limps on (see server.js's own SESSION_SECRET check); a database is different —
// there's no degraded mode that does anything useful without one, so a config typo here should
// exit(1) with a clear, boxed diagnostic naming the exact variable, not surface as a confusing
// connection-refused three log lines later.
const path = require('path');

const SUPPORTED_BACKENDS = ['sqlite', 'postgres', 'mysql'];

function fail(message) {
  console.error('='.repeat(78));
  console.error('LoxSuite database configuration error:');
  console.error(message);
  console.error('Fix the environment variable(s) above and restart.');
  console.error('='.repeat(78));
  process.exit(1);
}

// DATABASE_URL is the URL form (postgres://user:pass@host:port/db) — convenient when it's already
// what a hosting platform/secret manager hands you, but URL-encoding traps a password with its own
// "@"/":"/"/" characters, which is exactly why DB_HOST/DB_USER/DB_PASSWORD/... (below) exist as the
// discrete alternative and pair better with Docker secrets besides. Either is accepted; DATABASE_URL
// wins if both happen to be set.
function parseDatabaseUrl(url, expectedProtocols) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`DATABASE_URL is not a valid URL. Expected a form like "${expectedProtocols[0]}://user:password@host:5432/dbname".`);
  }
  const protocol = parsed.protocol.replace(/:$/, '');
  if (!expectedProtocols.includes(protocol)) {
    fail(`DATABASE_URL's scheme is "${protocol}:", but DB_BACKEND expects one of: ${expectedProtocols.map((p) => `${p}:`).join(', ')}.`);
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!parsed.hostname || !database) {
    fail('DATABASE_URL must include both a host and a database name, e.g. "postgres://user:password@host:5432/dbname".');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : null,
    database,
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
  };
}

function parseSsl(raw) {
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1' || raw === 'require') return { rejectUnauthorized: false };
  if (raw === 'verify-full') return { rejectUnauthorized: true };
  fail(`DB_SSL must be one of "false", "require", or "verify-full" — got "${raw}".`);
  return undefined; // unreachable, fail() exits — keeps eslint's consistent-return happy
}

function positiveIntOr(raw, fallback, varName) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`${varName} must be a positive number — got "${raw}".`);
  return n;
}

function resolveNetworkConnection(backend, defaultPort, expectedProtocols) {
  if (process.env.DATABASE_URL) {
    const parsed = parseDatabaseUrl(process.env.DATABASE_URL, expectedProtocols);
    return { host: parsed.host, port: parsed.port || defaultPort, database: parsed.database, user: parsed.user, password: parsed.password };
  }

  const host = process.env.DB_HOST;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  if (!host || !database || !user) {
    fail(
      `DB_BACKEND=${backend} needs connection details — set either DATABASE_URL, or DB_HOST, DB_NAME, and DB_USER ` +
      '(DB_PASSWORD and DB_PORT are also read if set; DB_PORT defaults to ' + defaultPort + ').'
    );
  }
  return {
    host,
    port: positiveIntOr(process.env.DB_PORT, defaultPort, 'DB_PORT'),
    database,
    user,
    password: process.env.DB_PASSWORD || '',
  };
}

// The one function every caller (db/index.js's init(), the transfer CLI, backup.js's per-backend
// engines) should use — parses once, validates everything up front, and either returns a complete,
// ready-to-use config or never returns at all (fail() calls process.exit(1) itself). Kept pure
// (reads process.env, no I/O of its own) so it's cheap to call from a CLI tool too, not just server
// boot.
function resolveDbConfig() {
  const rawBackend = (process.env.DB_BACKEND || 'sqlite').toLowerCase();
  if (!SUPPORTED_BACKENDS.includes(rawBackend)) {
    fail(`DB_BACKEND must be one of ${SUPPORTED_BACKENDS.map((b) => `"${b}"`).join(', ')} — got "${process.env.DB_BACKEND}".`);
  }

  if (rawBackend === 'sqlite') {
    return {
      backend: 'sqlite',
      dbPath: process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'gateway.db'),
    };
  }

  if (rawBackend === 'mysql') {
    // Works against MySQL or MariaDB servers alike — mysql2 (the driver) and mariadb-client (the
    // CLI tools backup/engines/mysql.js shells out to) both speak either wire protocol; nothing in
    // this app distinguishes which one is actually on the other end. DATABASE_URL accepts either
    // scheme for the same reason.
    const connection = resolveNetworkConnection('mysql', 3306, ['mysql', 'mariadb']);
    const ssl = parseSsl(process.env.DB_SSL);
    return {
      backend: 'mysql',
      connection: { ...connection, ssl },
      poolMax: positiveIntOr(process.env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
      connectTimeoutMs: positiveIntOr(process.env.DB_CONNECT_TIMEOUT_MS, 10000, 'DB_CONNECT_TIMEOUT_MS'),
      connectRetries: positiveIntOr(process.env.DB_CONNECT_RETRIES, 30, 'DB_CONNECT_RETRIES'),
    };
  }

  // backend === 'postgres'
  const connection = resolveNetworkConnection('postgres', 5432, ['postgres', 'postgresql']);
  const ssl = parseSsl(process.env.DB_SSL);
  return {
    backend: 'postgres',
    connection: { ...connection, ssl },
    poolMax: positiveIntOr(process.env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
    connectTimeoutMs: positiveIntOr(process.env.DB_CONNECT_TIMEOUT_MS, 10000, 'DB_CONNECT_TIMEOUT_MS'),
    connectRetries: positiveIntOr(process.env.DB_CONNECT_RETRIES, 30, 'DB_CONNECT_RETRIES'),
  };
}

// A safe-to-log summary — never the password, and only what actually helps identify which server/
// database this is (Administration > General's own read-only "Database" row, and the boot log).
function describeConfig(config) {
  if (config.backend === 'sqlite') return `sqlite (${config.dbPath})`;
  const c = config.connection;
  return `${config.backend} (${c.user}@${c.host}:${c.port}/${c.database}${c.ssl ? ', ssl' : ''})`;
}

module.exports = { resolveDbConfig, describeConfig, SUPPORTED_BACKENDS };
