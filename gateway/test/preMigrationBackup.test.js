// Guards the disk-safety half of the SQLite pre-migration snapshot (db/index.js): every upgrade
// that applies pending migrations drops a timestamped .bak beside gateway.db, so without pruning
// they'd accumulate forever. prunePreMigrationBackups keeps only the newest few. This test is pure
// filesystem (no DB), so it runs everywhere the rest of the suite does.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prunePreMigrationBackups } = require('../src/db');

let dir;
const dbPath = () => path.join(dir, 'gateway.db');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premig-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeBackups(stamps) {
  for (const s of stamps) fs.writeFileSync(`${dbPath()}.pre-migrate-${s}.bak`, 'x');
}
function remaining() {
  return fs.readdirSync(dir).filter((f) => f.includes('.pre-migrate-')).sort();
}

test('keeps only the newest five snapshots, dropping the older ones', () => {
  makeBackups([
    '2026-01-01T00-00-00-000Z', '2026-02-01T00-00-00-000Z', '2026-03-01T00-00-00-000Z',
    '2026-04-01T00-00-00-000Z', '2026-05-01T00-00-00-000Z', '2026-06-01T00-00-00-000Z',
    '2026-07-01T00-00-00-000Z',
  ]);
  prunePreMigrationBackups(dbPath());
  const left = remaining();
  assert.equal(left.length, 5);
  // the five newest survive; the two oldest are gone
  assert.ok(left.every((f) => !f.includes('2026-01-01') && !f.includes('2026-02-01')));
  assert.ok(left.some((f) => f.includes('2026-07-01')));
});

test('leaves five or fewer snapshots untouched', () => {
  makeBackups(['2026-01-01T00-00-00-000Z', '2026-02-01T00-00-00-000Z', '2026-03-01T00-00-00-000Z']);
  prunePreMigrationBackups(dbPath());
  assert.equal(remaining().length, 3);
});

test('ignores unrelated files and never throws on a missing directory', () => {
  fs.writeFileSync(path.join(dir, 'gateway.db'), 'db');
  fs.writeFileSync(path.join(dir, 'gateway.db.restore'), 'r');
  makeBackups(['2026-01-01T00-00-00-000Z']);
  prunePreMigrationBackups(dbPath());
  assert.ok(fs.existsSync(path.join(dir, 'gateway.db')));
  assert.ok(fs.existsSync(path.join(dir, 'gateway.db.restore')));
  assert.doesNotThrow(() => prunePreMigrationBackups(path.join(dir, 'nope', 'gateway.db')));
});
