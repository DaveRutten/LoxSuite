// The image the Unraid template pulls (:latest) must be the newest main, whatever order the runs of
// a batch of version tags finish in (pushing v0.36.4 … v0.41.0 together left :latest on v0.39.0).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '..', '.github', 'workflows', 'docker-publish.yml');

test('docker image: :latest only from main, and one main run at a time', { skip: !fs.existsSync(file) && 'workflow not in this checkout' }, () => {
  const y = fs.readFileSync(file, 'utf8');
  const latest = y.split('\n').find((l) => /type=raw,value=latest/.test(l)) || '';
  assert.match(latest, /enable=\$\{\{ github\.ref == 'refs\/heads\/main' \}\}/, ':latest is enabled only for refs/heads/main');
  assert.ok(!/is_default_branch/.test(latest), 'not {{is_default_branch}} (true for tags on main too)');
  assert.match(y, /concurrency:\s*\n\s*group: docker-publish-\$\{\{ github\.ref \}\}/, 'runs are grouped per ref');
  assert.match(y, /cancel-in-progress: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/, 'a newer main run cancels the older one');
});
