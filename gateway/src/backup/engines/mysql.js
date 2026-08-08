// MySQL/MariaDB backup engine — shells out to mysqldump/mysql (same "delegate to the correct
// external tool" philosophy already used for rclone/apprise/pg_dump — see the Dockerfile) rather
// than a JS-native reimplementation. Deliberately never touches the app's own Knex pool: every
// function here builds its own connection args straight from db/config.js's resolveDbConfig() (same
// pattern the Postgres engine and db/transfer.js's CLI already use), so this module has no
// dependency on db/index.js at all — which matters because db/index.js's own initMysql() calls this
// file's applyPendingRestoreAtBoot() below; requiring the app's db facade FROM here would be a
// require cycle.
//
// Unlike pg_dump's compressed custom format (with its own --list table-of-contents parser),
// mysqldump only ever produces a plain SQL text script — there's no equivalent lightweight
// "structurally valid archive" check, so validateAndStage() below does a text-based sanity check
// instead (recognizable mysqldump header + at least one CREATE TABLE) rather than a true parse.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { resolveDbConfig } = require('../../db/config');

const ENTRY_FILENAME = 'gateway.sql';

function connectionArgs(config) {
  const c = config.connection;
  return {
    // --password= as one token (not `--password X`) is mysqldump/mysql's own required form for a
    // non-interactive password — a bare `--password X` treats X as an optional next positional
    // argument instead (mysql client quirk, not this app's own choice) and silently prompts anyway.
    args: ['--host', c.host, '--port', String(c.port), '--user', c.user, `--password=${c.password}`],
    env: {
      ...process.env,
      // MYSQL_PWD is the officially supported non-interactive alternative (avoids the password
      // appearing in `ps`/`/proc` output the --password= form doesn't fully hide on every
      // platform) — set alongside --password= above for belt-and-suspenders, matching mysqldump's
      // own documented precedence (an explicit --password= wins if both are present, so this is
      // purely an extra safety net, not a behavior change).
      MYSQL_PWD: c.password,
    },
    ssl: c.ssl,
  };
}

function run(cmd, args, env, timeoutMs, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        // mysqldump/mysql's own stderr is far more useful here than execFile's generic "Command
        // failed" — trimmed to its last few lines since a connection/auth failure can print a fair
        // amount of preceding diagnostic noise before the actual reason (same trimming the Postgres
        // engine's own run() does for the exact same reason).
        const detail = (stderr || err.message || '').toString().trim().split('\n').slice(-5).join(' ');
        reject(new Error(detail || `${cmd} failed`));
        return;
      }
      resolve(stdout ? stdout.toString() : '');
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// --single-transaction takes a consistent snapshot without locking InnoDB tables for the duration
// (this app's own tables are all InnoDB, MariaDB/MySQL's default engine) — the closest MySQL
// equivalent of pg_dump's own default non-blocking behavior. --routines is a no-op today (this
// schema has none) but costs nothing and avoids silently missing them if that ever changes.
// --add-drop-table makes the dump self-contained for a --clean-style restore into a non-empty
// database (mysqldump's own default omits DROP TABLE statements) — the MySQL equivalent of the
// Postgres engine's own --clean --if-exists pg_restore flags. No --databases/--add-drop-database:
// deliberately dumps table CONTENT only, applied against whatever DB_NAME the target already has
// (which may legitimately differ from the source's own database name) — same reasoning
// db/transfer.js's own table-by-table copy uses for Postgres.
async function addPayloadToZip(zip, tmpDir) {
  const config = resolveDbConfig();
  const { args: connArgs, env } = connectionArgs(config);
  const dumpArgs = [...connArgs, '--single-transaction', '--routines', '--add-drop-table', config.connection.database];
  const output = await run('mysqldump', dumpArgs, env, 10 * 60 * 1000);
  const tmpDumpPath = path.join(tmpDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpDumpPath, output);
  zip.addLocalFile(tmpDumpPath, '', ENTRY_FILENAME);
  fs.rmSync(tmpDumpPath, { force: true });
}

const DUMP_HEADER_RE = /-- (MySQL|MariaDB) dump/i;

// No live-database, parse-only validator exists for a plain mysqldump SQL script the way
// `pg_restore --list` exists for pg_dump's own archive format — this is a best-effort text sanity
// check instead: a recognizable mysqldump/mariadb-dump header comment, and at least one CREATE
// TABLE statement, both of which any genuine dump this engine itself produced always has. A
// malformed or unrelated .sql file still fails loudly at RESTORE time either way (mysql itself
// rejects invalid SQL), same as a hand-edited mosquitto.conf failing loudly at mosquitto's own next
// restart — this just catches the common "wrong file entirely" case earlier, before it's staged.
async function validateAndStage(zip, pendingRestorePath) {
  const dbEntry = zip.getEntry(ENTRY_FILENAME);
  if (!dbEntry) throw new Error(`Backup does not contain ${ENTRY_FILENAME}.`);

  const content = zip.readFile(dbEntry).toString('utf8');
  if (!DUMP_HEADER_RE.test(content) || !/CREATE TABLE/i.test(content)) {
    throw new Error(`Uploaded ${ENTRY_FILENAME} doesn't look like a mysqldump SQL script.`);
  }

  fs.writeFileSync(pendingRestorePath, content);
}

// Called once at boot — see db/index.js's own initMysql(), right after connectivity is confirmed
// but BEFORE knex.migrate.latest() runs (so a restored dump that already contains its own
// knex_migrations state isn't immediately raced by a fresh-install migration run first). Applies a
// restore staged via validateAndStage() above, then deletes the staged file so it's only ever
// applied once — same one-shot handoff as db/index.js's own SQLite `${dbPath}.restore` swap and the
// Postgres engine's own applyPendingRestoreAtBoot(). The dump's own --add-drop-table (see
// addPayloadToZip above) makes a plain `mysql < file.sql` apply cleanly into a non-empty database.
async function applyPendingRestoreAtBoot(pendingRestorePath) {
  if (!fs.existsSync(pendingRestorePath)) return false;
  const config = resolveDbConfig();
  const { args: connArgs, env } = connectionArgs(config);
  console.log(`Applying a staged MySQL/MariaDB restore from ${pendingRestorePath}...`);
  const sql = fs.readFileSync(pendingRestorePath, 'utf8');
  await run('mysql', [...connArgs, config.connection.database], env, 10 * 60 * 1000, sql);
  fs.rmSync(pendingRestorePath, { force: true });
  console.log('MySQL/MariaDB restore applied.');
  return true;
}

module.exports = { backend: 'mysql', entryFilename: ENTRY_FILENAME, addPayloadToZip, validateAndStage, applyPendingRestoreAtBoot };
