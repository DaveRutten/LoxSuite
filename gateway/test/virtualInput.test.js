// Smart charging writes the charging power to a Loxone virtual input over HTTP. Guards that the
// function is exported (it once wasn't: "sendHttpVirtualInput is not a function") and that a
// Loxone error code inside an HTTP 200 answer is reported instead of being taken as success.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loxone = require('../src/loxone');
const { encrypt } = require('../src/secretCrypto');

const ms = { name: 'Gateway', host: '127.0.0.1', http_port: 80, username: 'u', password: encrypt('p') };

async function withFetch(body, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(body, { status: 200 }); };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}

test('every Loxone helper the planner uses is exported', () => {
  assert.equal(typeof loxone.sendHttpVirtualInput, 'function');
  assert.equal(typeof loxone.fetchMiniserver, 'function');
});

test('a virtual input write succeeds on Code 200 and reports Loxone errors', async () => {
  await withFetch('<LL control="dev/sps/io/LoxSuite_Vermogen/6" value="6" Code="200"/>', async (calls) => {
    const r = await loxone.sendHttpVirtualInput(ms, 'LoxSuite_Vermogen', '6');
    assert.equal(r.code, 200);
    assert.match(calls[0], /\/dev\/sps\/io\/LoxSuite_Vermogen\/6$/);
  });
  await withFetch('<LL control="dev/sps/io/Nope/6" value="" Code="404"/>', async () => {
    await assert.rejects(loxone.sendHttpVirtualInput(ms, 'Nope', '6'), /does not exist on Gateway/);
  });
  await withFetch('{"LL": {"control": "x", "value": "", "Code": "403"}}', async () => {
    await assert.rejects(loxone.sendHttpVirtualInput(ms, 'X', '1'), /no rights/);
  });
});
