// Regression guard for Phase 3 of the project's own db-backend plan (dialect-neutralizing the SQL,
// still SQLite-only): bans the three SQLite-only/non-portable shapes that phase converted away from
// — INSERT OR IGNORE (Postgres has no such syntax at all), a bare case-sensitive-on-Postgres LIKE
// with no LOWER(...) wrapper, and reading `.lastInsertRowid` off a write result (a better-sqlite3-
// specific property; Postgres needs RETURNING, MySQL has `insertId`) — from ever quietly
// reappearing in application code. legacy-sqlite-schema.js is exempt: it's the frozen, SQLite-only
// historical migration path (see its own header comment), not something this phase touches or ever
// will.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const EXCLUDED_FILES = new Set([
  path.join(SRC_DIR, 'db', 'legacy-sqlite-schema.js'),
  // The facade's own implementation, not application code: db/index.js's insertReturningId()/
  // normalizeWriteResult() are the ONE legitimate place `.lastInsertRowid` gets read off a raw
  // driver result at all (see their own comments) — everything else in the app calls THAT helper
  // instead. Its own doc comments also discuss INSERT OR IGNORE/LIKE by name when explaining what
  // db.insertIgnore()/the LOWER(...) convention replace, which would otherwise false-positive here.
  path.join(SRC_DIR, 'db', 'index.js'),
]);

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Lines that are entirely a `//` comment (allowing leading whitespace) don't count — several files
// deliberately name these exact banned strings in prose explaining what replaced them (e.g.
// notificationCenter.js's own comment on why its one remaining raw-SQL upsert uses the SQL-standard
// ON CONFLICT form instead of SQLite's proprietary keyword). Real SQL lives in a string/template
// literal, never a bare comment line, so this loses no real coverage.
function isCommentOnlyLine(line) {
  return /^\/\//.test(line.trim());
}

// A bare `LIKE ?` / `LIKE '...'` not immediately preceded by `LOWER(` on both the column and the
// pattern side is what's banned — matched loosely (just "does LOWER( appear anywhere earlier on
// the same collapsed-whitespace line before this LIKE") rather than a fully precise parse, since
// every real call site in this codebase keeps a LIKE clause on one logical source line and this is
// a source SCAN, not a query planner.
function findLikeViolations(text, relPath) {
  const violations = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!/\bLIKE\b/.test(line) || isCommentOnlyLine(line)) continue;
    if (!/LOWER\(/.test(line)) violations.push(`${relPath}: bare LIKE with no LOWER(...) wrapper: ${line}`);
  }
  return violations;
}

test('no source file reintroduces INSERT OR IGNORE', () => {
  const violations = [];
  for (const file of listJsFiles(SRC_DIR)) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/INSERT OR IGNORE/.test(line) && !isCommentOnlyLine(line)) {
        violations.push(path.relative(SRC_DIR, file));
        break;
      }
    }
  }
  assert.deepEqual(violations, [], `INSERT OR IGNORE found in (use db.insertIgnore()/db.upsert() instead):\n${violations.join('\n')}`);
});

test('no source file reintroduces a bare (non-LOWER-wrapped) LIKE', () => {
  const allViolations = [];
  for (const file of listJsFiles(SRC_DIR)) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    allViolations.push(...findLikeViolations(text, path.relative(SRC_DIR, file)));
  }
  assert.deepEqual(allViolations, [], `Bare LIKE found (wrap both sides in LOWER(...) for cross-backend case-insensitivity):\n${allViolations.join('\n')}`);
});

test('no source file reads .lastInsertRowid off a write result', () => {
  const violations = [];
  for (const file of listJsFiles(SRC_DIR)) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/\.lastInsertRowid\b/.test(line) && !isCommentOnlyLine(line)) {
        violations.push(path.relative(SRC_DIR, file));
        break;
      }
    }
  }
  assert.deepEqual(violations, [], `.lastInsertRowid found (use db.insertReturningId()/tx.insertReturningId() instead):\n${violations.join('\n')}`);
});
