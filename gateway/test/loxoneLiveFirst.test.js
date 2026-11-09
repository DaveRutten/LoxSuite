// Calls to a Miniserver go over its open live connection first, and over HTTP when it isn't open or doesn't
// answer in time (loxone.js fetchMiniserver).
const test = require('node:test');
const assert = require('node:assert');

const ws = require('../src/loxoneWebSocket');
const loxone = require('../src/loxone');

const ms = { id: 9101, host: '192.0.2.10', http_port: 80, username: 'u', password: null };

function stub({ open, live }) {
  const orig = { isOpen: ws.isOpen, fetchViaLive: ws.fetchViaLive, fetch: global.fetch };
  const calls = { live: [], http: [] };
  ws.isOpen = () => open;
  ws.fetchViaLive = async (m, p) => { calls.live.push(p); return live(p); };
  global.fetch = async (url) => { calls.http.push(String(url)); return new Response('{"LL":{"Code":"200","value":"1"}}', { status: 200 }); };
  return { calls, restore: () => { ws.isOpen = orig.isOpen; ws.fetchViaLive = orig.fetchViaLive; global.fetch = orig.fetch; } };
}

test('open live connection: a command and a value write go over it, not over HTTP', async () => {
  const s = stub({ open: true, live: async () => new Response('{"LL":{"Code":"200","value":"ok"}}', { status: 200 }) });
  try {
    await loxone.fetchMiniserver({ ...ms, password: undefined }, '/jdev/cfg/version');
    await loxone.sendHttpVirtualInput(ms, 'VI_heat', 52);
    assert.deepEqual(s.calls.live, ['/jdev/cfg/version', '/dev/sps/io/VI_heat/52']);
    assert.equal(s.calls.http.length, 0);
    const t = loxone.transportStats(ms.id);
    assert.ok(t.live >= 2);
  } finally { s.restore(); }
});

test('the live connection does not answer: the same call over HTTP', async () => {
  const s = stub({ open: true, live: async () => { throw new Error('Timed out'); } });
  try {
    const res = await loxone.fetchMiniserver({ ...ms, id: 9102 }, '/jdev/sps/state');
    assert.equal(res.status, 200);
    assert.equal(s.calls.http.length, 1);
    assert.equal(loxone.transportStats(9102).fallback, 1);
  } finally { s.restore(); }
});

test('not open, anonymous, or a file list: HTTP as before', async () => {
  const s = stub({ open: false, live: async () => { throw new Error('should not be used'); } });
  try {
    await loxone.fetchMiniserver({ ...ms, id: 9103 }, '/jdev/cfg/version');
    ws.isOpen = () => true;
    await loxone.fetchMiniserver({ ...ms, id: 9103 }, '/jdev/sys/getPublicKey', { anonymous: true });
    await loxone.fetchMiniserver({ ...ms, id: 9103 }, '/dev/fslist/prog');
    assert.equal(s.calls.live.length, 0);
    assert.equal(s.calls.http.length, 3);
  } finally { s.restore(); }
});
