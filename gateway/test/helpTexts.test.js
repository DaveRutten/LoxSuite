// Explanations use the names the menu uses: no pages that were renamed (Live Traffic, Client Activity) and no
// "SQLite" where any database is meant. Where SQLite itself is the subject (the import, the database choice,
// the backup file) it stays.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', 'src', 'views');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(VIEWS).filter((x) => x.endsWith('.ejs'));
const keys = [];
for (const f of files) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) keys.push({ f: path.relative(VIEWS, f), k: m[1].replace(/\\'/g, "'") });
}

test('no renamed page names in the texts', () => {
  const old = keys.filter((x) => /Live Traffic|Client Activity couldn|Learning dashboard\b/.test(x.k));
  assert.deepEqual(old.map((x) => `${x.f}: ${x.k.slice(0, 60)}`), []);
});

test('"SQLite" only where SQLite itself is the subject', () => {
  const FILES = /^(admin-general|admin-tech-report|setup-import|partials[\\/]head)\.ejs$/;
  const hits = keys.filter((x) => /SQLite/.test(x.k) && !FILES.test(x.f) && !/gateway\.db|Existing SQLite|backup API/.test(x.k));
  assert.deepEqual(hits.map((x) => `${x.f}: ${x.k.slice(0, 60)}`), []);
});

test('a "What is this?" link opens a part of the help that exists', () => {
  const help = fs.readFileSync(path.join(VIEWS, 'partials', 'help-content.ejs'), 'utf8');
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/include\('partials\/page-intro', \{[^}]*help: '([a-z-]+)'/g)) {
      assert.ok(help.includes(`id="help-${m[1]}"`), `${path.relative(VIEWS, f)}: help-${m[1]}`);
    }
  }
});
