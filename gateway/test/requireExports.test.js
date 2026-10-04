// Every `const { a, b } = require('./module')` inside src/ must name functions/values that module
// really exports — a missing export only shows up at runtime as "x is not a function".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('destructured requires of local modules name real exports', () => {
  const missing = [];
  const re = /\{([\w\s,:$]+)\}\s*=\s*require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g;
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const target = require.resolve(path.resolve(path.dirname(file), m[2]));
      let mod;
      try { mod = require(target); } catch { continue; }
      for (const raw of m[1].split(',')) {
        const name = raw.split(':')[0].trim();
        if (!name || name.startsWith('...')) continue;
        if (!(name in mod)) missing.push(`${path.relative(SRC, file)}: ${name} from ${m[2]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
