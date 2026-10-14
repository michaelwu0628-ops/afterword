import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const api = await import('../provider.mjs').catch(() => ({}));
const key = 'TEST_SECRET_MUST_NEVER_ECHO';
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; closed = false;
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  event(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function setup(options = {}) {
  assert.equal(typeof api.createProviderSession, 'function', 'provider session implementation required');
  const client = new Socket(); const upstream = new Socket(); const calls = [];
  const session = api.createProviderSession(client, { apiKey: key, workspace: 'ws-example', mode: 'manual', ...options.config }, {
    upstreamFactory: (url, options) => { calls.push({ url, options }); return upstream; },
    fetchImpl: options.fetchImpl || (() => { throw new Error('unexpected fetch'); }),
    ...options.deps,
  });
  return { client, upstream, session, calls, ready() { upstream.event({ type: 'session.created' }); upstream.event({ type: 'session.updated' }); } };
}
test('workspace accepts only raw IDs and exact Beijing control-panel base URLs', () => {
  assert.equal(typeof api.parseWorkspace, 'function', 'workspace validation implementation required');
  assert.equal(api.parseWorkspace('ws-example'), 'ws-example');
  assert.equal(api.parseWorkspace('https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), 'ws-example');
  for (const value of ['https://evil.test', 'https://127.0.0.1', 'https://a.cn-shanghai.maas.aliyuncs.com', 'https://a.cn-beijing.maas.aliyuncs.com:443', 'https://u:p@a.cn-beijing.maas.aliyuncs.com', 'https://a.cn-beijing.maas.aliyuncs.com.evil.test', 'ws/a', '']) assert.throws(() => api.parseWorkspace(value));
});
test('missing credentials and invalid region never create an upstream', () => {
  assert.equal(typeof api.createProviderSession, 'function', 'provider session implementation required');
  let count = 0;
  for (const config of [{}, { apiKey: key, workspace: 'https://evil.test', mode: 'manual' }, { apiKey: '', workspace: 'ws-example', mode: 'manual' }]) assert.throws(() => api.createProviderSession(new Socket(), config, { upstreamFactory: () => count++ }));
  assert.equal(count, 0);
});
test('fixed Beijing models and exact configuration require session.updated before ready', () => {
  const f = setup();
  assert.equal(f.calls[0].url, 'wss://ws-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime');
  assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${key}`);
  f.session.handle({ type: 'audio', audio: 'AAA=' });
  assert.equal(f.client.sent.at(-1).code, 'NOT_READY');
  f.upstream.event({ type: 'session.created', session: { secret: key } });
  assert.deepEqual(f.upstream.sent[0], { type: 'session.update', session: {
    modalities: ['text', 'audio'], audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { voice: 'Tina', format: { type: 'pcm', sample_rate: 24000 } } }, input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, turn_detection: null, max_tokens: 1024,
    instructions: 'You are a friendly English conversation partner. Respond briefly in natural English, usually with one relevant question. Allow the learner to think. Give a keyword or sentence beginning only when asked. Do not give pronunciation scores or claim an IELTS band.',
  } });
  assert.equal(f.client.sent.some(e => e.type === 'ready'), false);
  f.upstream.event({ type: 'session.updated' });
  assert.equal(f.client.sent.at(-1).type, 'ready'); f.session.close();
});
test('manual explicit submit follows clear append commit create once', () => {
  const f = setup(); f.ready();
  f.session.handle({ type: 'start_turn' });
  f.session.handle({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') });
  f.session.handle({ type: 'submit' }); f.session.handle({ type: 'submit' });
  assert.deepEqual(f.upstream.sent.slice(1).map(e => e.type), ['input_audio_buffer.clear', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  f.session.close();
});
test('malformed, arbitrary, oversized and excessive audio are bounded', () => {
  for (const msg of [{ type: 'session.update', apiKey: key }, { type: 'audio', audio: '!' }, { type: 'connect', apiKey: key }]) {
    const f = setup(); f.ready(); f.session.handle(msg); assert.equal(f.upstream.closed, true); assert.equal(f.upstream.sent.length, 1); assert.equal(JSON.stringify(f.client.sent).includes(key), false); f.session.close();
  }
  const f = setup(); f.ready(); f.session.handle({ type: 'feedback', text: 'a'.repeat(6001) }); assert.equal(f.upstream.closed, false);
  f.session.handle({ type: 'start_turn' });
  f.session.handle({ type: 'audio', audio: Buffer.alloc(66000).toString('base64') });
  assert.equal(f.upstream.sent.length, 2);
  assert.equal(JSON.stringify(f.client.sent).includes(key), false); f.session.close();
});
test('an invalid audio frame closes the old turn so its prior audio cannot be submitted', () => {
  const f = setup(); f.ready(); f.session.handle({ type: 'start_turn' }); f.session.handle({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') });
  f.session.handle({ type: 'audio', audio: 'invalid!' }); f.session.handle({ type: 'submit' });
  assert.equal(f.upstream.closed, true); assert.equal(f.upstream.sent.some(e => e.type === 'input_audio_buffer.commit'), false); f.session.close();
});
test('canceled IDs and session/error data cannot leak to browser', () => {
  const f = setup(); f.ready();
  f.upstream.event({ type: 'response.created', response: { id: 'r1' } });
  f.session.handle({ type: 'cancel_response' });
  f.upstream.event({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAA=' });
  f.upstream.event({ type: 'error', error: { code: key, message: key }, apiKey: key });
  assert.equal(f.client.sent.some(e => e.type === 'response.audio.delta'), false);
  assert.equal(JSON.stringify(f.client.sent).includes(key), false); assert.equal(f.upstream.closed, true);
});
test('feedback uses fixed model, validates quoted originals and returns actual usage', async () => {
  let request;
  const f = setup({ fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ assessment: 'suggestions', summary: 'One suggestion', suggestions: [{ original: 'I is', suggestion: 'I am', reason: 'Agreement' }] }) } }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } }) }; } });
  f.ready(); await f.session.handle({ type: 'feedback', text: 'I is ready.' });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(body.model, 'qwen-plus'); assert.equal(body.enable_thinking, false); assert.equal(body.max_tokens, 700);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(f.client.sent.at(-1).type, 'feedback.result'); assert.equal(f.client.sent.at(-1).usage.total_tokens, 21);
  assert.throws(() => api.validateFeedback({ summary: 'x', suggestions: [{ original: 'made up', suggestion: 'x', reason: 'y' }] }, 'I is ready.'));
  assert.throws(() => api.validateFeedback({ summary: '', suggestions: [] }, 'x')); f.session.close();
});
test('disconnect aborts pending feedback and closes upstream', async () => {
  let signal;
  const f = setup({ fetchImpl: (url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(key)))); } });
  f.ready(); const pending = f.session.handle({ type: 'feedback', text: 'I am ready.' });
  f.session.close(); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.upstream.closed, true); assert.equal(JSON.stringify(f.client.sent).includes(key), false);
});
test('handshake and feedback deadlines close/abort without upstream error details', async () => {
  const timers = []; const deps = { setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer: timer => { timer.cleared = true; } };
  const f = setup({ deps }); timers.find(t => t.ms === 15000).fn();
  assert.equal(f.upstream.closed, true); assert.equal(f.client.sent.at(-1).code, 'PROVIDER_TIMEOUT');
  let signal; const g = setup({ deps, fetchImpl: (u, o) => { signal = o.signal; return new Promise((a, b) => signal.addEventListener('abort', () => b(new Error(key)))); } }); g.ready();
  const pending = g.session.handle({ type: 'feedback', text: 'Test' }); timers.findLast(t => t.ms === 30000).fn(); await pending;
  assert.equal(signal.aborted, true); assert.equal(g.client.sent.at(-1).code, 'FEEDBACK_TIMEOUT'); g.session.close();
});
test('malformed upstream JSON values are rejected without throwing or leaking', () => {
  const f = setup();
  assert.doesNotThrow(() => f.upstream.emit('message', Buffer.from('null')));
  assert.equal(f.upstream.closed, true); assert.equal(JSON.stringify(f.client.sent).includes(key), false);
});
test('a submitted manual turn cannot start another before its response arrives', () => {
  const f = setup(); f.ready();
  f.session.handle({ type: 'start_turn' }); f.session.handle({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') }); f.session.handle({ type: 'submit' });
  f.session.handle({ type: 'start_turn' });
  assert.equal(f.upstream.sent.filter(e => e.type === 'input_audio_buffer.clear').length, 1); f.session.close();
});
test('realtime VAD is configured explicitly and the mic may restart after stopping', () => {
  const f = setup({ config: { mode: 'realtime' } }); f.ready();
  assert.deepEqual(f.upstream.sent[0].session.turn_detection, { type: 'server_vad', threshold: 0.5, silence_duration_ms: 5000 });
  f.session.handle({ type: 'start_turn' }); f.session.handle({ type: 'start_turn' });
  assert.equal(f.upstream.sent.filter(e => e.type === 'input_audio_buffer.clear').length, 2); f.session.close();
});
test('slow browser backpressure closes rather than silently losing audio', () => {
  const f = setup(); f.ready(); f.upstream.event({ type: 'response.created', response: { id: 'r1' } });
  f.client.bufferedAmount = 300000;
  f.upstream.event({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAA=' });
  assert.equal(f.upstream.closed, true); assert.equal(f.client.closed, true);
});
test('canceled response keeps real usage without reviving old audio', () => {
  const f = setup(); f.ready(); f.upstream.event({ type: 'response.created', response: { id: 'r1' } }); f.session.handle({ type: 'cancel_response' });
  f.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'cancelled', usage: { total_tokens: 42 } } });
  assert.equal(f.client.sent.at(-1).type, 'response.usage'); assert.equal(f.client.sent.at(-1).usage.total_tokens, 42); f.session.close();
});
test('a secret echoed in an otherwise allowed provider field is never forwarded', () => {
  const f = setup(); f.ready(); f.upstream.event({ type: 'response.created', response: { id: 'r1' } });
  f.upstream.event({ type: 'response.text.delta', response_id: 'r1', delta: `echo ${key}` });
  assert.equal(JSON.stringify(f.client.sent).includes(key), false); assert.equal(f.upstream.closed, true);
});
test('a non-successful text response cancels its unread body and exposes only HTTP status', async () => {
  let canceled = false;
  const f = setup({ fetchImpl: async () => ({ ok: false, status: 403, body: { cancel: async () => { canceled = true; } }, raw: key }) }); f.ready();
  await f.session.handle({ type: 'feedback', text: 'I am here.' });
  assert.equal(canceled, true); assert.equal(f.client.sent.at(-1).code, 'PROVIDER_PERMISSION'); assert.equal(f.client.sent.at(-1).httpStatus, 403); assert.equal(JSON.stringify(f.client.sent).includes(key), false); f.session.close();
});
test('feedback validation, busy, timeout, HTTP and invalid-result failures carry a safe feedback source', async () => {
  const invalid = setup(); invalid.ready(); await invalid.session.handle({ type: 'feedback', text: '' });
  assert.equal(invalid.client.sent.at(-1).request, 'feedback'); invalid.session.close();
  const notReady = setup(); await notReady.session.handle({ type: 'feedback', text: 'I am here.' });
  assert.equal(notReady.client.sent.at(-1).request, 'feedback'); notReady.session.close();
  let signal; const timers = [];
  const busy = setup({ fetchImpl: (url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('offline aborted')))); }, deps: { setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer() {} } }); busy.ready();
  const pending = busy.session.handle({ type: 'feedback', text: 'I am here.' }); await busy.session.handle({ type: 'feedback', text: 'Again.' });
  assert.equal(busy.client.sent.at(-1).code, 'BUSY'); assert.equal(busy.client.sent.at(-1).request, 'feedback');
  timers.find(t => t.ms === 30000).fn(); await pending;
  assert.equal(busy.client.sent.at(-1).code, 'FEEDBACK_TIMEOUT'); assert.equal(busy.client.sent.at(-1).request, 'feedback'); busy.session.close();
  for (const response of [{ ok: false, status: 403 }, { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }]) {
    const f = setup({ fetchImpl: async () => response }); f.ready(); await f.session.handle({ type: 'feedback', text: 'I am here.' }); assert.equal(f.client.sent.at(-1).request, 'feedback'); f.session.close();
  }
});
test('text requests reject redirects rather than forwarding user text to another target', async () => {
  let redirectPolicy;
  const f = setup({ fetchImpl: async (url, options) => { redirectPolicy = options.redirect; throw new TypeError(`redirect blocked ${key}`); } });
  try {
    f.ready(); await f.session.handle({ type: 'feedback', text: 'I enjoy English podcasts.' });
    assert.equal(redirectPolicy, 'error');
    assert.equal(f.client.sent.at(-1).code, 'FEEDBACK_FAILED');
    assert.equal(f.client.sent.some(event => event.type === 'feedback.result'), false);
    assert.equal(JSON.stringify(f.client.sent).includes(key), false);
  } finally { f.session.close(); }
});
