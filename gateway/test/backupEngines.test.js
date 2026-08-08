// Fast, SQLite-only regression guard for the backup engine split (gateway/src/backup/engines/*.js,
// Phases 4c/5 of the project's own db-backend plan). The SQLite engine's real addPayloadToZip/
// validateAndStage round trip runs here against the same in-memory test DB every other test file
// uses. The Postgres/MySQL engines' own addPayloadToZip/applyPendingRestoreAtBoot need real
// pg_dump+pg_restore/mysqldump+mysql binaries and a live server — that side was verified manually
// end to end for both (backup, stage, cross-backend rejection, boot-time apply, including the
// Postgres engine's own transaction_timeout preamble quirk — see those phases' own notes) and
// belongs in the slow/CI container loop per the plan's own testing strategy. The MySQL engine's own
// validateAndStage() is pure JS with no external process at all (a text-based sanity check, not a
// true parse — see its own comment on why no better tool exists for a plain mysqldump script the
// way pg_restore --list exists for pg_dump's archive format), so it's exercised for real here
// alongside the Postgres engine's module shape (no typo'd export breaking backup.js's own dispatch
// table).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const { initTestDb } = require('./helpers/testDb');
const sqliteEngine = require('../src/backup/engines/sqlite');
const postgresEngine = require('../src/backup/engines/postgres');
const mysqlEngine = require('../src/backup/engines/mysql');

let db;
let tmpDir;

before(async () => {
  db = await initTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxsuite-backup-test-'));
});

after(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('sqlite engine addPayloadToZip produces a real, openable gateway.db entry', async () => {
  const zip = new AdmZip();
  await sqliteEngine.addPayloadToZip(zip, tmpDir);
  const entry = zip.getEntry('gateway.db');
  assert.ok(entry, 'expected a gateway.db entry in the zip');
  assert.ok(entry.getData().length > 0, 'gateway.db entry should not be empty');
  // No leftover .tmp-*.db files in tmpDir once the zip has the payload — addPayloadToZip cleans up
  // after itself (see its own fs.rmSync).
  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.db'));
  assert.deepEqual(leftovers, []);
});

test('sqlite engine validateAndStage stages a valid gateway.db and cleans up its checkpoint file', async () => {
  const zip = new AdmZip();
  await sqliteEngine.addPayloadToZip(zip, tmpDir);
  const pendingPath = path.join(tmpDir, 'staged.restore');
  await sqliteEngine.validateAndStage(zip, pendingPath);
  assert.ok(fs.existsSync(pendingPath), 'expected the staged file to exist at pendingRestorePath');
  const leftoverChecks = fs.readdirSync(tmpDir).filter((f) => f.includes('.check-'));
  assert.deepEqual(leftoverChecks, [], 'no .check-* temp files should be left behind');
});

test('sqlite engine validateAndStage rejects a zip with no gateway.db entry', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  const pendingPath = path.join(tmpDir, 'staged-missing.restore');
  await assert.rejects(() => sqliteEngine.validateAndStage(zip, pendingPath), /does not contain gateway\.db/);
  assert.ok(!fs.existsSync(pendingPath));
});

test('sqlite engine validateAndStage rejects a corrupt gateway.db entry', async () => {
  const zip = new AdmZip();
  zip.addFile('gateway.db', Buffer.from('this is not a real sqlite database'));
  const pendingPath = path.join(tmpDir, 'staged-corrupt.restore');
  await assert.rejects(() => sqliteEngine.validateAndStage(zip, pendingPath), /not valid/);
  assert.ok(!fs.existsSync(pendingPath));
});

test('mysql engine validateAndStage accepts a well-formed mysqldump script', async () => {
  const zip = new AdmZip();
  zip.addFile('gateway.sql', Buffer.from('-- MariaDB dump 10.19\n\nCREATE TABLE `access_roles` (`id` int NOT NULL);\n'));
  const pendingPath = path.join(tmpDir, 'staged-mysql.restore');
  await mysqlEngine.validateAndStage(zip, pendingPath);
  assert.ok(fs.existsSync(pendingPath), 'expected the staged file to exist at pendingRestorePath');
  assert.match(fs.readFileSync(pendingPath, 'utf8'), /CREATE TABLE/);
});

test('mysql engine validateAndStage rejects a zip with no gateway.sql entry', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  const pendingPath = path.join(tmpDir, 'staged-mysql-missing.restore');
  await assert.rejects(() => mysqlEngine.validateAndStage(zip, pendingPath), /does not contain gateway\.sql/);
  assert.ok(!fs.existsSync(pendingPath));
});

test('mysql engine validateAndStage rejects a file with no recognizable dump header', async () => {
  const zip = new AdmZip();
  zip.addFile('gateway.sql', Buffer.from('this is not a mysqldump script at all'));
  const pendingPath = path.join(tmpDir, 'staged-mysql-corrupt.restore');
  await assert.rejects(() => mysqlEngine.validateAndStage(zip, pendingPath), /doesn't look like a mysqldump/);
  assert.ok(!fs.existsSync(pendingPath));
});

test('mysql engine validateAndStage rejects a header with no CREATE TABLE at all', async () => {
  const zip = new AdmZip();
  zip.addFile('gateway.sql', Buffer.from('-- MySQL dump 10.13\n\nSELECT 1;\n'));
  const pendingPath = path.join(tmpDir, 'staged-mysql-no-tables.restore');
  await assert.rejects(() => mysqlEngine.validateAndStage(zip, pendingPath), /doesn't look like a mysqldump/);
  assert.ok(!fs.existsSync(pendingPath));
});

test('postgres and mysql engines export the same shape as the sqlite engine, for backup.js\'s dispatch table', () => {
  for (const key of ['backend', 'entryFilename', 'addPayloadToZip', 'validateAndStage']) {
    assert.ok(key in sqliteEngine, `sqlite engine missing "${key}"`);
    assert.ok(key in postgresEngine, `postgres engine missing "${key}"`);
    assert.ok(key in mysqlEngine, `mysql engine missing "${key}"`);
  }
  assert.equal(sqliteEngine.backend, 'sqlite');
  assert.equal(postgresEngine.backend, 'postgres');
  assert.equal(mysqlEngine.backend, 'mysql');
  const entryFilenames = [sqliteEngine.entryFilename, postgresEngine.entryFilename, mysqlEngine.entryFilename];
  assert.equal(new Set(entryFilenames).size, 3, 'every engine must use a different zip entry name');
  assert.equal(typeof postgresEngine.applyPendingRestoreAtBoot, 'function');
  assert.equal(typeof mysqlEngine.applyPendingRestoreAtBoot, 'function');
});
