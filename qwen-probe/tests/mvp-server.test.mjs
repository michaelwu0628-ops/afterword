import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
const api = await import('../mvp-server.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });

async function fixture(t, options = {}) {
  const calls = [], upstreamStarted = new EventEmitter();
  const local = api.createMvpServer({ port: 0, rootFile: 'coach.html',
    upstreamFactory: () => { const socket = new EventEmitter(); socket.readyState = 1; socket.bufferedAmount = 0; socket.send = () => {}; socket.close = () => {}; calls.push('voice'); upstreamStarted.emit('created'); return socket; },
    resolveMaterialImpl: async url => { calls.push(url); return { title: 'Offline material', url, mediaUrl: null, kind: 'audio', duration: null, cues: [], status: 'needs_transcript' }; },
    translateCuesImpl: async input => { calls.push('translate'); return input.cues.map(cue => ({ ...cue, zh: '译文' })); }, ...options });
  const address = await local.listen(); t.after(() => local.close()); const origin = `http://127.0.0.1:${address.port}`;
  const post = (path, value, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { local, origin, post, calls, upstreamStarted };
}
const cue = { start: 0, end: 2, text: 'This is a test.' };
test('MVP server exports a separate entry without listening on import', () => assert.equal(typeof api.createMvpServer, 'function'));

test('MVP serves only fixed browser files and browsing makes zero provider calls', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/')).status, 200);
  for (const path of ['/audio.mjs', '/coach-connection.mjs', '/turn-detector.mjs']) assert.equal((await fetch(f.origin + path)).status, 200);
  for (const path of ['/material.mjs', '/mvp-server.mjs', '/provider.mjs', '/audio.mjs?secret=1']) assert.equal((await fetch(f.origin + path)).status, 404);
  assert.deepEqual(f.calls, []);
});

test('same-origin material and translation POSTs return bounded real service data', async t => {
  const f = await fixture(t);
  const material = await f.post('/api/material', { url: 'https://www.ted.com/talks/example' }); assert.equal(material.status, 200); assert.equal((await material.json()).title, 'Offline material');
  const translated = await f.post('/api/translate', { workspace: 'ws-test', apiKey: 'OFFLINE_KEY', cues: [cue] }); assert.equal(translated.status, 200); assert.deepEqual(await translated.json(), { cues: [{ ...cue, zh: '译文' }] });
  assert.equal(translated.headers.get('cache-control'), 'no-store'); assert.equal(translated.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(f.origin + '/api/material')).status, 405);
});

test('API rejects foreign origins, wrong content types, unknown fields, credentials and oversized input before service calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/material', { url: 'https://www.ted.com' }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.post('/api/material', { url: 'https://www.ted.com' }, { 'Content-Type': 'text/plain' })).status, 415);
  for (const value of [null, [], {}, { url: 'https://www.ted.com', endpoint: 'https://evil.invalid' }, { url: 'x'.repeat(3001) }]) assert.equal((await f.post('/api/material', value)).status, 400);
  for (const value of [{ workspace: 'https://evil.invalid', apiKey: 'KEY', cues: [cue] }, { workspace: 'ws-test', apiKey: 'KEY\n', cues: [cue] }, { workspace: 'ws-test', apiKey: 'KEY', cues: [{ ...cue, text: 'x'.repeat(12001) }] }, { workspace: 'ws-test', apiKey: 'KEY', cues: [cue], endpoint: 'https://evil.invalid' }]) assert.equal((await f.post('/api/translate', value)).status, 400);
  assert.equal((await f.post('/api/material', { url: 'x'.repeat(70000) })).status, 413); assert.deepEqual(f.calls, []);
});

test('API validates exact loopback Host and bounds incomplete request bodies', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 30 });
  const request = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request(f.origin + '/api/material', { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.write(body); if (!headers['Content-Length']) req.end(); t.after(() => req.destroy());
  });
  assert.equal(await request({ Host: 'evil.invalid', Origin: f.origin, 'Content-Type': 'application/json' }, '{}'), 403);
  assert.equal(await request({ Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': 200 }, '{'), 408); assert.deepEqual(f.calls, []);
});

test('upstream errors and timeouts never echo a key or upstream error text', async t => {
  let signal;
  const f = await fixture(t, { apiTimeoutMs: 30, translateCuesImpl: async input => { signal = input.signal; return new Promise(() => {}); }, resolveMaterialImpl: async () => { throw new Error('OFFLINE_KEY private upstream text'); } });
  const failed = await f.post('/api/material', { url: 'https://www.ted.com' }); assert.equal(failed.status, 502); assert.deepEqual(await failed.json(), { code: 'MATERIAL_FAILED', message: '素材解析暂时失败，请检查链接或补充字幕。' });
  const timeout = await f.post('/api/translate', { workspace: 'ws-test', apiKey: 'OFFLINE_KEY', cues: [cue] }); assert.equal(timeout.status, 504); assert.equal(signal.aborted, true); assert.equal((await timeout.text()).includes('OFFLINE_KEY'), false);
});

test('validated practice may cross connect while prompt and unknown fields cannot', async t => {
  const f = await fixture(t);
  const connect = async (practice, expectAccepted = false) => {
    // Validation failure sends an error before the server finishes closing its
    // single active socket. Wait for that actual close before reconnecting.
    const serverClosed = new Promise(resolve => f.local.server.once('upgrade', (_req, socket) => socket.once('close', resolve)));
    const result = await new Promise((resolve, reject) => {
      const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/connect', { origin: f.origin });
      let response = null;
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', authType: 'api-key', apiKey: 'OFFLINE_KEY', practice })));
      ws.on('message', raw => { response = JSON.parse(raw); });
      ws.on('close', () => resolve(response));
      t.after(() => ws.terminate());
      if (expectAccepted) f.upstreamStarted.once('created', () => { response = 'accepted'; ws.close(); });
    });
    await serverClosed;
    return result;
  };
  assert.equal((await connect({ mode: 'material', title: 'Talk', sourceText: 'valid source', prompt: 'override' })).code, 'INVALID_CONNECT');
  assert.deepEqual(f.calls, []); assert.equal(await connect({ mode: 'material', title: 'Talk', sourceText: 'valid source' }, true), 'accepted'); assert.deepEqual(f.calls, ['voice']);
});
