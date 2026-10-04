// Guards public/style.css against unbalanced braces. A single stray "}" makes the browser drop the
// rule that follows it, which is how the phone tab bar once showed up on desktop with giant icons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('style.css has balanced braces at every point', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (c) => c.replace(/[{}]/g, ' '));
  let depth = 0;
  css.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; assert.ok(depth >= 0, `stray "}" on style.css line ${i + 1}`); }
    }
  });
  assert.equal(depth, 0, 'style.css ends with an unclosed "{"');
});
