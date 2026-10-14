import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createConnection } from '../public/connection.mjs';
const api = await import('../server.mjs').catch(() => ({}));
test('Host and Origin must exactly match the actual loopback port', () => {
  assert.equal(typeof api.isAllowedRequest, 'function', 'loopback boundary implementation required');
  assert.equal(api.isAllowedRequest('127.0.0.1:53217', 'http://127.0.0.1:53217', 53217), true);
  assert.equal(api.isAllowedRequest('localhost:53217', 'http://localhost:53217', 53217), true);
  for (const [host, origin] of [['evil.test:53217', 'http://evil.test:53217'], ['localhost:1', 'http://localhost:1'], ['localhost:53217', undefined], ['localhost:53217', 'https://localhost:53217'], ['localhost:53217', 'http://evil.test'], ['localhost:53217', 'http://127.0.0.1:53217']]) assert.equal(api.isAllowedRequest(host, origin, 53217), false);
});
async function fixture(t, options = {}) {
  let count = 0;
  const local = api.createLocalServer({ port: 0, upstreamFactory: () => { count++; const fake = new EventEmitter(); fake.readyState = 1; fake.bufferedAmount = 0; fake.send = () => {}; fake.close = () => {}; return fake; }, fetchImpl: () => { throw new Error('offline only'); }, ...options });
  const address = await local.listen(); t.after(() => local.close());
  const origin = `http://127.0.0.1:${address.port}`;
  return { local, origin, url: origin.replace('http:', 'ws:') + '/connect', count: () => count };
}
function open(url, origin) { return new Promise((resolve, reject) => { const ws = new WebSocket(url, { origin }); ws.once('open', () => resolve(ws)); ws.once('error', reject); }); }
test('local HTTP server enforces method, Host, static whitelist and security headers', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/server.mjs'); assert.equal(response.status, 404);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(f.origin + '/', { method: 'POST' })).status, 405);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(f.origin + '/', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  assert.equal(f.count(), 0);
});
test('wrong Origin and missing first credentials never create upstream', async t => {
  const f = await fixture(t);
  await assert.rejects(open(f.url, 'https://evil.test'));
  const ws = await open(f.url, f.origin); const closed = new Promise(resolve => ws.once('close', resolve));
  ws.send(JSON.stringify({ type: 'connect', workspace: 'ws-example', mode: 'manual' })); await closed;
  assert.equal(f.count(), 0);
});
test('first connect deadline, single client and oversized frames are bounded offline', async t => {
  const f = await fixture(t, { connectTimeoutMs: 50 });
  const ws = await open(f.url, f.origin); const closed = new Promise(resolve => ws.once('close', resolve));
  await assert.rejects(open(f.url, f.origin)); await closed; assert.equal(f.count(), 0);
  const large = await open(f.url, f.origin); const ended = new Promise(resolve => large.once('close', resolve)); large.on('error', () => {});
  large.send('a'.repeat(70000)); await ended; assert.equal(f.count(), 0);
});

test('an explicit draft reaches automatic recognition and feedback across the real local socket offline', async t => {
  const modelRequests = [], upstreamFrames = [], events = [];
  let upstream, origin, readyResolve, feedbackResolve, timer;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const received = new Promise(resolve => { feedbackResolve = resolve; });
  const f = await fixture(t, {
    upstreamFactory: () => {
      upstream = new EventEmitter(); upstream.readyState = 1; upstream.bufferedAmount = 0;
      upstream.close = () => {};
      const event = value => queueMicrotask(() => upstream.emit('message', Buffer.from(JSON.stringify(value))));
      upstream.send = raw => {
        const frame = JSON.parse(raw); upstreamFrames.push(frame);
        if (frame.type === 'session.update') event({ type: 'session.updated' });
        if (frame.type === 'input_audio_buffer.commit') {
          event({ type: 'input_audio_buffer.committed', item_id: 'offline-user-1' });
          event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'offline-user-1', transcript: 'I very like podcasts.' });
        }
        if (frame.type === 'response.create') {
          event({ type: 'response.created', response: { id: 'offline-ai' } });
          event({ type: 'response.audio_transcript.done', response_id: 'offline-ai', transcript: 'What do you like about them?' });
          event({ type: 'response.done', response: { id: 'offline-ai', status: 'completed', usage: {} } });
        }
      };
      event({ type: 'session.created' }); return upstream;
    },
    fetchImpl: async (url, request) => {
      modelRequests.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ assessment: 'suggestions', summary: '调整一个搭配会更自然。', suggestions: [{ original: 'very like', suggestion: 'really like', reason: '用 really 修饰 like。' }] }) } }], usage: { total_tokens: 20 } }) };
    },
  });
  origin = f.origin;
  class LocalSocket extends WebSocket { constructor(url) { super(url, { origin }); } }
  const connection = createConnection({ WebSocketImpl: LocalSocket, url: f.url, sleep: async () => {}, onEvent(event) { events.push(event); if (event.type === 'ready') readyResolve(); if (event.type === 'feedback.result') feedbackResolve(event); } });
  t.after(() => { clearTimeout(timer); connection.disconnect(); });
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('offline integration timed out')), 2000); });
  connection.connect({ apiKey: 'OFFLINE_ONLY_NOT_A_KEY', workspace: 'ws-offline', mode: 'manual' });
  await Promise.race([ready, deadline]);
  assert.equal(modelRequests.length, 0); assert.equal(upstreamFrames.some(frame => frame.type === 'input_audio_buffer.append'), false);
  await connection.submitDraft(new Int16Array(1600));
  const result = await Promise.race([received, deadline]);
  assert.equal(events.find(event => event.type === 'user.transcript').text, 'I very like podcasts.');
  assert.equal(modelRequests.length, 1); assert.equal(modelRequests[0].messages[1].content, 'I very like podcasts.');
  assert.equal(result.itemId, 'offline-user-1'); assert.equal(result.source, 'transcript');
  assert.equal(result.result.suggestions[0].suggestion, 'really like'); assert.equal(result.usage.total_tokens, 20);
});
