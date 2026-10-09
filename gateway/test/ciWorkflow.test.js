// The image the Unraid template pulls (:latest) must be the newest main, whatever order the runs of
// a batch of version tags finish in (pushing v0.36.4 … v0.41.0 together left :latest on v0.39.0).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '..', '.github', 'workflows', 'docker-publish.yml');

test('docker image: :latest only when the commit is where main is, one build at a time in order', { skip: !fs.existsSync(file) && 'workflow not in this checkout' }, () => {
  const y = fs.readFileSync(file, 'utf8');
  const latest = y.split('\n').find((l) => /type=raw,value=latest/.test(l)) || '';
  // built on the tag of a release: :latest only when that commit is the newest main (an older tag pushed
  // afterwards must not move it back)
  assert.match(latest, /enable=\$\{\{ steps\.latest\.outputs\.ok == 'true' \}\}/, ':latest follows the "is this main" check');
  assert.ok(!/is_default_branch/.test(latest), 'not {{is_default_branch}} (true for tags on main too)');
  assert.match(y, /git fetch --no-tags --depth=1 origin main/, 'the check compares with the current main');
  assert.match(y, /"\$\(git rev-parse HEAD\)" = "\$\(git rev-parse FETCH_HEAD\)"/, '... commit against commit');
  assert.match(y, /concurrency:\s*\n\s*group: docker-publish\s*\n\s*cancel-in-progress: false/, 'one build at a time, a newer one waits instead of cancelling');
});
