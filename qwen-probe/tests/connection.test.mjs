import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnection, createDraft } from '../public/connection.mjs';

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.frames = [];
    this.listeners = {};
    FakeSocket.instances.push(this);
  }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  emit(name, data = {}) { for (const listener of this.listeners[name] ?? []) listener(data); }
  open() { this.readyState = 1; this.emit('open'); }
  message(event) { this.emit('message', { data: JSON.stringify(event) }); }
  send(frame) { this.frames.push(JSON.parse(frame)); }
  close() { this.readyState = 3; this.emit('close'); }
}

function setup(options = {}) {
  const events = [];
  const delays = [];
  const connection = createConnection({
    WebSocketImpl: FakeSocket,
    url: 'ws://127.0.0.1:8787/ws',
    onEvent: event => events.push(event),
    sleep: async delay => { delays.push(delay); },
    ...options,
  });
  return { connection, events, delays };
}

function ready(connection, mode = 'manual') {
  connection.connect({ apiKey: 'test-secret', workspace: 'workspace-test', mode });
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.message({ type: 'ready' });
  return socket;
}

test('exports connection and local draft constructors', () => {
  assert.equal(typeof createConnection, 'function');
  assert.equal(typeof createDraft, 'function');
});

test('only explicit connect creates a socket, credentials are first, ready is server driven', () => {
  const initialCount = FakeSocket.instances.length;
  const { connection } = setup();
  assert.equal(connection.state, 'disconnected');
  assert.equal(FakeSocket.instances.length, initialCount);
  connection.connect({ apiKey: 'test-secret', workspace: 'workspace-test', mode: 'manual' });
  const socket = FakeSocket.instances.at(-1);
  assert.equal(connection.state, 'connecting');
  assert.equal(socket.frames.length, 0);
  socket.open();
  assert.deepEqual(socket.frames, [{ type: 'connect', apiKey: 'test-secret', workspace: 'workspace-test', mode: 'manual' }]);
  assert.equal(connection.state, 'connecting');
  assert.equal(connection.send('audio', { audio: 'AA==' }), false);
  socket.message({ type: 'ready' });
  assert.equal(connection.state, 'ready');
  assert.equal(connection.mode, 'manual');
  assert.equal(Object.keys(connection).some(key => /key|workspace/i.test(key)), false);
  connection.disconnect();
  assert.equal(connection.state, 'disconnected');
  assert.equal(FakeSocket.instances.length, initialCount + 1);
});

test('draft recording, stopping and discarding stay local and expose copied samples', () => {
  const { connection } = setup();
  const socket = ready(connection);
  const draft = createDraft({ maxSamples: 4 });
  const input = new Int16Array([1, 2]);
  draft.push(input);
  input[0] = 9;
  draft.push(new Int16Array([3, 4]));
  assert.equal(draft.length, 4);
  assert.throws(() => draft.push(new Int16Array([5])), /limit|maximum|long/i);
  draft.stop();
  assert.equal(draft.state, 'stopped');
  assert.deepEqual([...draft.samples], [1, 2, 3, 4]);
  const copy = draft.samples;
  copy[0] = 99;
  assert.equal(draft.samples[0], 1);
  assert.throws(() => draft.push(new Int16Array([5])), /stopped|recording/i);
  draft.discard();
  assert.equal(draft.state, 'discarded');
  assert.equal(draft.length, 0);
  assert.equal(draft.samples.length, 0);
  assert.equal(socket.frames.length, 1);
});

test('manual submission is paced, little endian, ordered and limited to once per sample object', async () => {
  const { connection, delays } = setup();
  const socket = ready(connection);
  const samples = new Int16Array(8000);
  samples.set([0x1234, -2, -32768, 32767]);
  await connection.submitDraft(samples);
  assert.deepEqual(socket.frames.map(frame => frame.type), ['connect', 'start_turn', 'audio', 'audio', 'audio', 'submit']);
  assert.deepEqual(delays, [200, 200, 100]);
  assert.deepEqual([...Buffer.from(socket.frames[2].audio, 'base64').subarray(0, 8)], [0x34, 0x12, 0xfe, 0xff, 0x00, 0x80, 0xff, 0x7f]);
  assert.deepEqual(socket.frames.slice(2, 5).map(frame => Buffer.from(frame.audio, 'base64').length), [6400, 6400, 3200]);
  await assert.rejects(connection.submitDraft(samples), /already|duplicate/i);
  assert.equal(socket.frames.length, 6);
});

test('submission rejects missing readiness, wrong mode and audio duration bounds', async () => {
  const { connection } = setup();
  await assert.rejects(connection.submitDraft(new Int16Array(1600)), /ready/i);
  const socket = ready(connection, 'realtime');
  await assert.rejects(connection.submitDraft(new Int16Array(1600)), /manual/i);
  connection.disconnect();
  const manualSocket = ready(connection);
  await assert.rejects(connection.submitDraft(new Int16Array(1599)), /100|short|minimum/i);
  await assert.rejects(connection.submitDraft(new Int16Array(480001)), /30|long|maximum/i);
  await assert.rejects(connection.submitDraft(new Uint8Array(1600)), /Int16Array/i);
  assert.equal(socket.frames.length, 1);
  assert.equal(manualSocket.frames.length, 1);
});

test('submission does not overlap and stops sending if disconnect happens during pacing', async () => {
  let release;
  const { connection } = setup({ sleep: () => new Promise(resolve => { release = resolve; }) });
  const socket = ready(connection);
  const first = connection.submitDraft(new Int16Array(6400));
  await assert.rejects(connection.submitDraft(new Int16Array(1600)), /progress|flight|submitting/i);
  connection.disconnect();
  release();
  await assert.rejects(first, /disconnect|ready|connection/i);
  assert.deepEqual(socket.frames.map(frame => frame.type), ['connect', 'start_turn', 'audio']);
});

test('backpressure bounds encoded frame and buffered queue, closes rather than queueing more', async () => {
  const { connection, events } = setup({ maxBufferedAmount: 1024 });
  const socket = ready(connection);
  await assert.rejects(connection.submitDraft(new Int16Array(3200)), /buffer|queue|connection/i);
  assert.equal(connection.state, 'disconnected');
  assert.equal(socket.frames.some(frame => frame.type === 'audio'), false);
  assert.equal(events.at(-1).type, 'error');
  const second = ready(connection);
  second.bufferedAmount = 1025;
  assert.equal(connection.send('audio', { audio: 'AA==' }), false);
  assert.equal(connection.state, 'disconnected');
});

test('stale socket events cannot change a newer connection', () => {
  const { connection, events } = setup();
  const first = ready(connection);
  connection.disconnect();
  const second = ready(connection);
  const count = events.length;
  first.message({ type: 'response.text.delta', responseId: 'old', delta: 'stale' });
  first.message({ type: 'error', message: 'test-secret' });
  first.emit('close');
  assert.equal(connection.state, 'ready');
  assert.equal(events.length, count);
  second.message({ type: 'response.created', responseId: 'new' });
  assert.equal(events.at(-1).responseId, 'new');
});

test('cancel applies only to an active response and stale response packets are ignored', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  assert.equal(connection.send('cancel_response'), false);
  socket.message({ type: 'response.created', responseId: 'r1' });
  assert.equal(connection.send('cancel_response'), true);
  assert.deepEqual(socket.frames.at(-1), { type: 'cancel_response' });
  socket.message({ type: 'response.canceled', responseId: 'r1' });
  assert.equal(connection.send('cancel_response'), false);
  socket.message({ type: 'response.created', responseId: 'r2' });
  const count = events.length;
  socket.message({ type: 'response.text.delta', responseId: 'r1', delta: 'old' });
  socket.message({ type: 'response.done', responseId: 'r1' });
  assert.equal(events.length, count);
  socket.message({ type: 'response.done', responseId: 'r2' });
  assert.equal(connection.send('cancel_response'), false);
});

test('feedback is ready guarded and socket failures expose only canned text with no reconnect', () => {
  const { connection, events } = setup();
  assert.equal(connection.feedback('Try again', 'u1'), false);
  const socket = ready(connection);
  socket.message({ type: 'user.transcript', itemId: 'u1', text: 'Try again' });
  assert.equal(connection.feedback('Try again', 'u1'), true);
  assert.deepEqual(socket.frames.at(-1), { type: 'feedback', text: 'Try again', itemId: 'u1' });
  const count = FakeSocket.instances.length;
  socket.emit('error', { message: 'test-secret https://sensitive.example' });
  assert.equal(connection.state, 'disconnected');
  assert.equal(FakeSocket.instances.length, count);
  assert.equal(JSON.stringify(events).includes('test-secret'), false);
  assert.equal(JSON.stringify(events).includes('sensitive.example'), false);
});

test('duplicate response-created events do not retire the active response', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  socket.message({ type: 'response.created', responseId: 'r1' });
  socket.message({ type: 'response.created', responseId: 'r1' });
  socket.message({ type: 'response.text.delta', responseId: 'r1', delta: 'current' });
  assert.equal(events.at(-1).delta, 'current');
  assert.equal(connection.send('cancel_response'), true);
});

test('server errors never forward raw provider messages or extra sensitive fields', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  socket.message({ type: 'error', code: 'provider_error', httpStatus: 401, message: 'test-secret', details: 'sensitive.example' });
  assert.deepEqual(Object.keys(events.at(-1)).sort(), ['code', 'httpStatus', 'message', 'type']);
  assert.equal(events.at(-1).code, 'provider_error');
  assert.equal(events.at(-1).httpStatus, 401);
  assert.equal(JSON.stringify(events).includes('test-secret'), false);
  assert.equal(JSON.stringify(events).includes('sensitive.example'), false);
});

test('connect accepts realtime mode and bounds API keys to the server contract', () => {
  const { connection } = setup();
  assert.throws(() => connection.connect({ apiKey: 'k'.repeat(2049), mode: 'manual' }), /API Key|key/i);
  assert.throws(() => connection.connect({ apiKey: 'test-secret', mode: 'auto' }), /mode|模式/i);
  const socket = ready(connection, 'realtime');
  assert.equal(connection.mode, 'realtime');
  assert.equal(socket.frames[0].mode, 'realtime');
});

test('send permits only supported protocol actions', () => {
  const { connection } = setup();
  const socket = ready(connection);
  assert.equal(connection.send('session.update', { instructions: 'forbidden' }), false);
  assert.equal(connection.send('response.create'), false);
  assert.equal(connection.send('connect', { apiKey: 'forbidden' }), false);
  assert.equal(socket.frames.length, 1);
  assert.equal(connection.send('start_turn'), true);
  assert.equal(connection.send('audio', { audio: 'AA==' }), true);
  assert.equal(connection.send('submit'), true);
  socket.message({ type: 'user.transcript', itemId: 'u1', text: 'fine' });
  assert.equal(connection.send('feedback', { text: 'fine', itemId: 'u1' }), true);
  assert.equal(connection.send('disconnect'), true);
});

test('feedback rejects text above 6000 characters without sending', () => {
  const { connection } = setup();
  const socket = ready(connection);
  socket.message({ type: 'user.transcript', itemId: 'u1', text: 'fine' });
  assert.equal(connection.feedback('a'.repeat(6001), 'u1'), false);
  assert.equal(connection.send('feedback', { text: 'a'.repeat(6001), itemId: 'u1' }), false);
  assert.equal(socket.frames.length, 1);
  assert.equal(connection.feedback('a'.repeat(6000), 'u1'), true);
});

test('late canceled-response usage still reaches accounting after response retirement', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  socket.message({ type: 'response.created', responseId: 'r1' });
  socket.message({ type: 'response.canceled', responseId: 'r1' });
  socket.message({ type: 'response.created', responseId: 'r2' });
  const usage = { input_tokens: 33, output_tokens: 7 };
  socket.message({ type: 'response.usage', responseId: 'r1', usage, status: 'cancelled' });
  assert.deepEqual(events.at(-1), { type: 'response.usage', responseId: 'r1', usage, status: 'cancelled' });
  assert.equal(connection.send('cancel_response'), true);
});

for (const terminalEvent of ['close', 'error']) {
  test(`a provider authentication diagnostic survives the following socket ${terminalEvent}`, () => {
    const { connection, events } = setup();
    const socket = ready(connection);
    socket.message({ type: 'error', code: 'PROVIDER_AUTH', httpStatus: 401, message: 'test-secret raw failure' });
    socket.emit(terminalEvent, { message: 'test-secret transport failure' });
    assert.equal(connection.state, 'disconnected');
    assert.equal(connection.send('audio', { audio: 'AA==' }), false);
    const errors = events.filter(event => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'PROVIDER_AUTH');
    assert.equal(errors[0].httpStatus, 401);
    assert.equal(JSON.stringify(events).includes('test-secret'), false);
    assert.equal(socket.readyState, 3);
    const next = ready(connection);
    next.emit('error');
    assert.equal(events.at(-1).code, 'connection_error');
  });
}

test('sanitized errors preserve only the allowlisted feedback request source', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  socket.message({ type: 'error', code: 'PROVIDER_PERMISSION', httpStatus: 403, request: 'feedback', message: 'test-secret' });
  assert.equal(events.at(-1).request, 'feedback');
  assert.equal(events.at(-1).code, 'PROVIDER_PERMISSION');
  assert.equal(events.at(-1).httpStatus, 403);
  for (const request of ['voice', 'test-secret', { secret: 'test-secret' }]) {
    socket.message({ type: 'error', code: 'PROVIDER_ERROR', request, message: 'test-secret' });
    assert.equal(Object.hasOwn(events.at(-1), 'request'), false);
  }
  assert.equal(JSON.stringify(events).includes('test-secret'), false);
});

test('user input transcription passes independently of retired assistant responses and drops raw ASR fields', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  socket.message({ type: 'response.created', responseId: 'retired' });
  socket.message({ type: 'response.canceled', responseId: 'retired' });
  socket.message({ type: 'response.created', responseId: 'current' });
  socket.message({ type: 'user.transcript', responseId: 'retired', itemId: 'user-1', text: 'I very like podcasts.', session: { secret: 'raw-secret' }, usage: { secret: 'raw-secret' } });
  assert.deepEqual(events.at(-1), { type: 'user.transcript', itemId: 'user-1', text: 'I very like podcasts.' });
  socket.message({ type: 'user.transcription_failed', responseId: 'retired', itemId: 'user-2', code: 'ASR_FAILED', error: { message: 'raw-secret' } });
  assert.deepEqual(events.at(-1), { type: 'user.transcription_failed', itemId: 'user-2', code: 'ASR_FAILED' });
  assert.equal(connection.send('cancel_response'), true);
  assert.equal(JSON.stringify(events).includes('raw-secret'), false);
});

test('correction requires a valid recognized item from this connection and is cleared on reconnect', () => {
  const { connection } = setup();
  const socket = ready(connection);
  assert.equal(connection.feedback('Corrected sentence'), false);
  assert.equal(connection.feedback('Corrected sentence', 'unseen'), false);
  for (const itemId of ['', 'x'.repeat(257), null, 8]) {
    socket.message({ type: 'user.transcript', itemId, text: 'Original sentence.' });
    assert.equal(connection.feedback('Corrected sentence', itemId), false);
  }
  socket.message({ type: 'user.transcript', itemId: 'opaque item / 1', text: 'Original sentence.' });
  assert.equal(connection.feedback(' Corrected sentence. ', 'opaque item / 1'), true);
  assert.deepEqual(socket.frames.at(-1), { type: 'feedback', itemId: 'opaque item / 1', text: 'Corrected sentence.' });
  connection.disconnect();
  const next = ready(connection);
  assert.equal(connection.feedback('Corrected sentence.', 'opaque item / 1'), false);
  socket.message({ type: 'user.transcript', itemId: 'old', text: 'Stale' });
  assert.equal(connection.feedback('Corrected sentence.', 'old'), false);
  assert.equal(next.frames.length, 1);
});

test('empty or overlong transcription is ignored and feedback errors retain only safe correlation fields', () => {
  const { connection, events } = setup();
  const socket = ready(connection);
  const count = events.length;
  for (const text of ['', ' ', 'x'.repeat(6001)]) socket.message({ type: 'user.transcript', itemId: 'u1', text });
  assert.equal(events.length, count);
  socket.message({ type: 'feedback.error', itemId: 'u1', source: 'transcript', request: 'feedback', code: 'FEEDBACK_TIMEOUT', httpStatus: 408, message: 'raw-secret', error: { secret: 'raw-secret' }, queued: true });
  assert.deepEqual(events.at(-1), { type: 'feedback.error', itemId: 'u1', source: 'transcript', request: 'feedback', code: 'FEEDBACK_TIMEOUT', httpStatus: 408, message: '请求未完成，请检查连接和配置后重试。' });
  socket.message({ type: 'feedback.error', itemId: 'x'.repeat(257), source: 'raw-secret', code: 'unsafe code raw-secret' });
  assert.deepEqual(events.at(-1), { type: 'feedback.error', code: 'request_error', message: '请求未完成，请检查连接和配置后重试。' });
  assert.equal(JSON.stringify(events).includes('raw-secret'), false);
});
