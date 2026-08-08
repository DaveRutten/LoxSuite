// Regression guard for the whole db-backend async-facade conversion: a `db.prepare(sql).get(...)`
// (or `.all(`/`.run(`) call that's missing its `await` doesn't throw or fail a build — it silently
// hands back a pending Promise object instead of a real row/array/write-result, which then either
// renders as "[object Promise]" (see httpSmoke.test.js, the other half of this safety net) or
// blows up somewhere much harder to trace back to the actual missing keyword. This scans every
// source file's own text for that exact shape and fails loudly, at the cheapest possible point
// (no server boot, no HTTP round trip needed), if one ever slips back in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// legacy-sqlite-schema.js is the one deliberate exception: it's the frozen, verbatim body of the
// old synchronous better-sqlite3 schema/migrations, run once at boot directly against a raw
// (genuinely synchronous) driver connection — not the async facade — via its own `db` PARAMETER,
// which just happens to share the same identifier as every other file's `require('../db')` import.
// See db/index.js's init() for why it's called this way on purpose.
const EXCLUDED_FILES = new Set([
  path.join(SRC_DIR, 'db', 'legacy-sqlite-schema.js'),
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

// Finds the index right after the closing ')' that matches the '(' at openIndex, by plain
// depth-counting — good enough here since every db.prepare(...) call in this codebase is a SQL
// string (or a template literal), and SQL always balances its own parentheses too.
function findMatchingClose(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Collapsing all whitespace runs to a single space is what makes a multi-line call
// (`db.prepare(\`...\`)\n  .all(id)`, common throughout this codebase for longer SQL) matchable at
// all without a real parser — this is a source-text SCAN, not a syntax check (node --check already
// covers that elsewhere), so losing line numbers in exchange for catching the multi-line shape is
// the right tradeoff. Reported violations include a text snippet instead of a line number.
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

const PREPARE_RE = /\b(db|tx)\.prepare\(/g;

function findViolations(filePath, rawText) {
  const text = collapseWhitespace(rawText);
  const violations = [];
  let match;
  PREPARE_RE.lastIndex = 0;
  while ((match = PREPARE_RE.exec(text))) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingClose(text, openParen);
    if (closeParen === -1) continue; // unbalanced — shouldn't happen in valid JS, skip rather than false-positive

    const afterClose = text.slice(closeParen + 1, closeParen + 6);
    const chainedCallMatch = afterClose.match(/^\.(get|all|run)\(/);
    if (!chainedCallMatch) continue; // a bare `db.prepare(sql)` cache with no immediately-chained terminal call — fine, see db/index.js's own comment on why

    // What comes right before "db.prepare(" / "tx.prepare(" — awaited, returned (an async
    // function's `return db.prepare(...).get(...)` correctly propagates as a promise to its own
    // caller), or an arrow function's own implicit expression-body return (e.g.
    // `Promise.all(ids.map((id) => db.prepare(sql).get(id)))` — the promise still correctly
    // propagates up through .map()/Promise.all() to whatever DOES await the overall result) all
    // count as fine.
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const precededByAwaitReturnOrArrow = /(\b(await|return)\s+|=>\s*)$/.test(before);

    if (!precededByAwaitReturnOrArrow) {
      const snippetStart = Math.max(0, match.index - 30);
      const snippet = text.slice(snippetStart, closeParen + chainedCallMatch[0].length + 15);
      violations.push(`${path.relative(SRC_DIR, filePath)}: ...${snippet}...`);
    }
  }
  return violations;
}

test('no db.prepare(...).get/all/run(...) call site is missing its await (or return)', () => {
  const files = listJsFiles(SRC_DIR).filter((f) => !EXCLUDED_FILES.has(f));
  const allViolations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    allViolations.push(...findViolations(file, text));
  }
  assert.deepEqual(allViolations, [], `Found ${allViolations.length} db call(s) missing await/return:\n${allViolations.join('\n')}`);
});
