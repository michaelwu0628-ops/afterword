import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const api = await import('../public/app.mjs').catch(() => ({}));
test('controls permit sending only a stopped unsent draft after confirmed ready', () => {
  assert.equal(typeof api.deriveControls, 'function', 'UI state implementation required');
  assert.equal(api.deriveControls({ state: 'connecting', mode: 'manual', draftLength: 1600, draftState: 'stopped' }).send, false);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'manual', draftLength: 1600, draftState: 'stopped' }).send, true);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'manual', draftLength: 1600, draftState: 'recording' }).send, false);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'manual', draftLength: 1600, draftState: 'stopped', submitted: true }).send, false);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'realtime', recording: true }).stopCall, true);
});
test('page explains automatic recognition, optional correction and all three fixed models', async () => {
  let html = ''; try { html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'); } catch {}
  assert.match(html, /type="password"/); assert.match(html, /autocomplete="off"/);
  assert.match(html, /百炼/); assert.match(html, /5 秒/); assert.match(html, /你刚才说的/); assert.match(html, /表达建议/);
  assert.match(html, /qwen3-asr-flash-realtime/); assert.match(html, /qwen3\.8-omni-flash-realtime/); assert.match(html, /qwen-plus/);
  assert.match(html, /北京三模型/); assert.match(html, /识别有误？更正原话/); assert.match(html, /更正后重新分析/);
  assert.match(html, /<details[^>]*id="correction-panel"[^>]*>/); assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /辅助转写已关闭|不会自动提取|不生成你的语音转写|输入自己说过的一句英文/);
  assert.match(html, /发音|IELTS/); assert.match(html, /配置确认/);
});
function appFixture({ deferredUnlock = false, deferredSubmit = false, mode = 'manual' } = {}) {
  class Element {
    disabled = false; value = ''; checked = false; hidden = false; open = false; textContent = ''; events = {}; children = [];
    classList = { toggle() {} };
    addEventListener(type, callback) { this.events[type] = callback; }
    click() { if (!this.disabled) return this.events.click?.(); }
    removeAttribute() {} load() {} pause() {} play() { return Promise.resolve(); }
    append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; }
  }
  const elements = new Map(); const modes = [new Element(), new Element()]; modes[0].value = 'manual'; modes[0].checked = mode === 'manual'; modes[1].value = 'realtime'; modes[1].checked = mode === 'realtime';
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, querySelectorAll() { return modes; }, createElement() { return new Element(); } };
  const pageEvents = {};
  const window = { location: { host: '127.0.0.1:53217' }, addEventListener(type, fn) { pageEvents[type] = fn; } };
  let onEvent, captureOptions, unlockResolve, captures = 0, captureDisposed = 0, playbackDisposed = 0, submits = 0, sends = 0; const revoked = [], feedbackCalls = [];
  const unlock = deferredUnlock ? new Promise(resolve => { unlockResolve = resolve; }) : Promise.resolve(true);
  const pendingSubmits = [];
  const connection = { connect() { onEvent({ type: 'connection_state', state: 'connecting' }); }, disconnect() { onEvent({ type: 'connection_state', state: 'disconnected' }); }, send() { sends++; return true; }, async submitDraft() { submits++; if (deferredSubmit) await new Promise((resolve, reject) => pendingSubmits.push({ resolve, reject })); }, feedback(...args) { sends++; feedbackCalls.push(args); return true; } };
  const app = api.createApp(document, { window,
    connectionFactory(options) { onEvent = options.onEvent; return connection; },
    captureFactory(options) { captures++; captureOptions = options; return { start: async () => ({ sampleRate: 48000 }), stop: async () => { options.onStop({ reason: 'manual', pcm: new Int16Array(1600), wav: new Uint8Array(3244) }); }, dispose: async () => { captureDisposed++; } }; },
    playbackFactory(options = {}) { let playing = false; return { unlock: () => unlock, stop() { playing = false; options.onStateChange?.(); }, activate() {}, enqueue() { playing = true; options.onStateChange?.(); return true; }, get playing() { return playing; }, dispose: async () => { playbackDisposed++; } }; },
    objectURL: { createObjectURL: () => 'blob:local-test', revokeObjectURL: value => revoked.push(value) }, BlobImpl: class {},
  });
  const get = id => elements.get(id); const tick = () => new Promise(resolve => setImmediate(resolve));
  function ready() { get('api-key').value = 'OFFLINE_ONLY'; get('workspace').value = 'ws-example'; get('connect').click(); onEvent({ type: 'connection_state', state: 'ready' }); onEvent({ type: 'ready' }); }
  return { app, get, ready, tick, pageEvents, pendingSubmits, feedbackCalls, emit: event => onEvent(event), unlock: () => unlockResolve?.(true), pcm: () => captureOptions.onPcm(new Int16Array(1600)), stopWith: (reason, length) => captureOptions.onStop({ reason, pcm: new Int16Array(length), wav: new Uint8Array(length * 2 + 44) }), counts: () => ({ captures, captureDisposed, playbackDisposed, submits, sends }), revoked };
}

const suggested = { assessment: 'suggestions', summary: '可以调整一个搭配。', suggestions: [{ original: 'very like', suggestion: 'really like', reason: '这里用 really 修饰 like。' }] };
const collectText = element => [element.textContent, ...element.children.map(collectText)].join(' ');

test('commit order keeps an older final ASR result from replacing a newer pending utterance', () => {
  const f = appFixture(); f.ready();
  f.emit({ type: 'user.transcription_pending', itemId: 'u1' });
  f.emit({ type: 'user.transcription_pending', itemId: 'u2' });
  f.emit({ type: 'user.transcript', itemId: 'u1', text: 'An older utterance.' });
  f.emit({ type: 'feedback.result', itemId: 'u1', source: 'transcript', result: suggested, usage: { total_tokens: 8 } });
  assert.equal(f.get('user-transcript').textContent, '');
  assert.match(f.get('transcript-status').textContent, /识别中/);
  f.emit({ type: 'user.transcript', itemId: 'u2', text: 'The newest utterance.' });
  assert.equal(f.get('user-transcript').textContent, 'The newest utterance.');
  assert.match(f.get('text-usage').textContent, /8/); f.app.dispose();
});

test('recognition and matching automatic feedback appear without typing or a feedback click', () => {
  const f = appFixture(); f.ready();
  f.emit({ type: 'user.transcript', itemId: 'user-1', text: 'I very like podcasts.' });
  assert.equal(f.get('user-transcript').textContent, 'I very like podcasts.');
  assert.equal(f.get('feedback-text').value, 'I very like podcasts.');
  assert.equal(f.get('correction-panel').open, false);
  f.emit({ type: 'feedback.pending', itemId: 'user-1', source: 'transcript', queued: true });
  assert.match(f.get('feedback-status').textContent, /等待点评/);
  f.emit({ type: 'feedback.pending', itemId: 'user-1', source: 'transcript' });
  assert.match(f.get('feedback-status').textContent, /点评中/);
  f.emit({ type: 'feedback.result', itemId: 'user-1', source: 'transcript', result: suggested, usage: { total_tokens: 21 } });
  assert.match(collectText(f.get('feedback-result')), /really like/);
  assert.match(f.get('feedback-status').textContent, /自动识别/);
  assert.deepEqual(f.feedbackCalls, []); assert.equal(f.counts().sends, 0); f.app.dispose();
});

test('correction is explicit, tied to recognized item and retains original transcript', () => {
  const f = appFixture(); f.ready();
  assert.equal(f.get('feedback').disabled, true);
  f.emit({ type: 'user.transcript', itemId: 'u1', text: 'I very like podcasts.' });
  f.get('feedback-text').value = 'I really like podcasts.'; f.get('feedback-text').events.input();
  assert.deepEqual(f.feedbackCalls, []);
  f.get('feedback').click();
  assert.deepEqual(f.feedbackCalls, [['I really like podcasts.', 'u1']]);
  assert.equal(f.get('user-transcript').textContent, 'I very like podcasts.');
  f.emit({ type: 'feedback.result', itemId: 'u1', source: 'transcript', result: suggested, usage: { total_tokens: 21 } });
  assert.equal(f.get('feedback-result').children.length, 0);
  assert.equal(f.app.state.feedbackPending, true);
  f.emit({ type: 'feedback.result', itemId: 'u1', source: 'correction', result: { assessment: 'no_clear_issue', summary: '未发现明显问题。', suggestions: [] }, usage: {} });
  assert.match(f.get('feedback-status').textContent, /无需修改.*更正/);
  assert.match(collectText(f.get('feedback-result')), /未发现明显问题/); f.app.dispose();
});

test('late feedback for an older item records usage but cannot replace latest transcript or review', () => {
  const f = appFixture(); f.ready();
  f.emit({ type: 'user.transcript', itemId: 'u1', text: 'I very like podcasts.' });
  f.emit({ type: 'feedback.pending', itemId: 'u1', source: 'transcript' });
  f.get('correction-panel').open = true;
  f.emit({ type: 'user.transcript', itemId: 'u2', text: 'I listen to podcasts every day.' });
  assert.equal(f.get('correction-panel').open, false);
  f.emit({ type: 'feedback.pending', itemId: 'u2', source: 'transcript' });
  const before = f.get('feedback-status').textContent;
  f.emit({ type: 'feedback.result', itemId: 'u1', source: 'transcript', result: suggested, usage: { total_tokens: 42 } });
  f.emit({ type: 'feedback.error', request: 'feedback', itemId: 'u1', source: 'transcript', code: 'FEEDBACK_TIMEOUT' });
  f.emit({ type: 'user.transcript', itemId: 'u1', text: 'Old duplicate' });
  assert.equal(f.get('user-transcript').textContent, 'I listen to podcasts every day.');
  assert.equal(f.get('feedback-text').value, 'I listen to podcasts every day.');
  assert.equal(f.get('feedback-status').textContent, before);
  assert.equal(f.get('feedback-result').children.length, 0);
  assert.match(f.get('text-usage').textContent, /42/); assert.equal(f.app.state.feedbackPending, true); f.app.dispose();
});

test('ASR and feedback failures show a real failure while preserving active voice locks', () => {
  const f = appFixture(); f.ready(); f.emit({ type: 'response.created', responseId: 'r1' });
  f.emit({ type: 'user.transcription_failed', itemId: 'u1', code: 'ASR_FAILED' });
  assert.match(f.get('transcript-status').textContent, /识别失败/);
  assert.equal(f.get('user-transcript').textContent, ''); assert.equal(f.get('feedback-result').children.length, 0);
  assert.equal(f.get('record').disabled, true); assert.equal(f.app.state.responseActive, true);
  f.emit({ type: 'user.transcript', itemId: 'u2', text: 'I very like podcasts.' });
  f.emit({ type: 'feedback.pending', itemId: 'u2', source: 'transcript' });
  f.emit({ type: 'feedback.error', itemId: 'u2', source: 'transcript', request: 'feedback', code: 'FEEDBACK_TIMEOUT' });
  assert.match(f.get('feedback-status').textContent, /点评失败.*FEEDBACK_TIMEOUT/);
  assert.equal(f.app.state.feedbackPending, false); assert.equal(f.app.state.responseActive, true); assert.equal(f.get('record').disabled, true); f.app.dispose();
});

test('reconnecting clears old transcript, correction, feedback and usage; disconnected events are ignored', () => {
  const f = appFixture(); f.ready();
  f.emit({ type: 'user.transcript', itemId: 'u1', text: 'I very like podcasts.' });
  f.emit({ type: 'feedback.result', itemId: 'u1', source: 'transcript', result: suggested, usage: { total_tokens: 9 } });
  f.get('correction-panel').open = true; f.get('disconnect').click();
  f.emit({ type: 'user.transcript', itemId: 'late', text: 'Stale session' });
  assert.equal(f.get('user-transcript').textContent, '');
  f.ready(); assert.equal(f.get('feedback-text').value, ''); assert.equal(f.get('correction-panel').open, false);
  assert.equal(f.get('feedback-result').children.length, 0); assert.equal(f.get('text-usage').textContent, '尚无服务返回用量'); f.app.dispose();
});

test('30 second local limit leaves an unsent draft with no recognition or feedback request', async () => {
  const f = appFixture(); f.ready(); f.get('record').click(); await f.tick(); f.stopWith('limit', 480000);
  assert.match(f.get('draft-status').textContent, /草稿未发送/); assert.equal(f.counts().sends, 0); assert.equal(f.counts().submits, 0);
  assert.equal(f.get('user-transcript').textContent, ''); assert.equal(f.get('feedback-result').children.length, 0);
  f.get('discard').click(); assert.equal(f.counts().sends, 0); f.app.dispose();
});

test('sending starts recognition state and realtime stop without final transcription stays incomplete', async () => {
  const f = appFixture(); f.ready(); f.get('record').click(); await f.tick(); f.pcm(); f.get('stop').click(); await f.tick();
  f.get('send').click(); await f.tick(); assert.match(f.get('transcript-status').textContent, /识别中/);
  assert.doesNotMatch(f.get('sent-status').textContent, /未生成你的转写/); f.app.dispose();
  const live = appFixture({ mode: 'realtime' }); live.ready(); live.get('start-call').click(); await live.tick(); live.pcm(); live.get('stop-call').click(); await live.tick();
  assert.match(live.get('sent-status').textContent, /尚无完整识别结果|等待最终识别/);
  assert.match(live.get('transcript-status').textContent, /等待.*识别|识别中/);
  assert.equal(live.get('user-transcript').textContent, ''); assert.equal(live.get('feedback-result').children.length, 0); live.app.dispose();
});
test('connect never starts a mic, clears Key, and manual stop/discard sends no audio', async () => {
  const f = appFixture(); f.ready();
  assert.equal(f.get('api-key').value, ''); assert.equal(f.counts().captures, 0);
  f.get('record').click(); await f.tick(); f.pcm(); f.get('stop').click(); await f.tick();
  assert.equal(f.counts().sends, 0); assert.equal(f.get('send').disabled, false);
  f.get('discard').click(); assert.deepEqual(f.revoked, ['blob:local-test']); assert.equal(f.counts().sends, 0); f.app.dispose();
});
test('manual draft submits only once and disconnect releases capture/playback/blob resources', async () => {
  const f = appFixture(); f.ready(); f.get('record').click(); await f.tick(); f.pcm(); f.get('stop').click(); await f.tick();
  f.get('send').click(); f.get('send').click(); await f.tick(); assert.equal(f.counts().submits, 1);
  f.get('disconnect').click(); assert.equal(f.counts().playbackDisposed, 1); assert.deepEqual(f.revoked, ['blob:local-test']); assert.equal(f.app.state.state, 'disconnected'); f.app.dispose();
});
test('stopping while audio unlock is pending prevents a late mic request', async () => {
  const f = appFixture({ deferredUnlock: true }); f.ready(); f.get('record').click(); f.get('stop').click(); f.unlock(); await f.tick();
  assert.equal(f.counts().captures, 0); assert.equal(f.app.state.recording, false); f.app.dispose();
});
test('completed server response leaves queued audio stoppable without canceling an inactive response', async () => {
  const f = appFixture(); f.ready(); f.get('record').click(); await f.tick(); f.get('stop').click(); await f.tick();
  f.emit({ type: 'response.created', responseId: 'r1' }); f.emit({ type: 'response.audio.delta', responseId: 'r1', delta: 'AAA=' });
  f.emit({ type: 'response.done', responseId: 'r1', status: 'completed', usage: {} });
  assert.equal(f.get('cancel').disabled, false); f.get('cancel').click(); assert.equal(f.counts().sends, 0); assert.equal(f.get('cancel').disabled, true); f.app.dispose();
});
test('late failure from an old manual send cannot reset a new session upload', async () => {
  const f = appFixture({ deferredSubmit: true });
  async function draftAndSend() { f.get('record').click(); await f.tick(); f.pcm(); f.get('stop').click(); await f.tick(); f.get('send').click(); await f.tick(); }
  f.ready(); await draftAndSend(); f.get('disconnect').click(); f.ready(); await draftAndSend();
  assert.equal(f.app.state.submitting, true);
  f.pendingSubmits[0].reject(new Error('old session failed')); await f.tick();
  assert.equal(f.app.state.submitting, true); assert.equal(f.app.state.awaitingResponse, true);
  f.pendingSubmits[1].resolve(); await f.tick(); f.app.dispose();
});
test('a specific provider error survives immediate disconnection and resets only on user reconnect', () => {
  const f = appFixture(); f.ready(); f.emit({ type: 'error', code: 'PROVIDER_PERMISSION', httpStatus: 403, message: '请检查权限或额度。' }); f.emit({ type: 'connection_state', state: 'disconnected' });
  assert.match(f.get('detail').textContent, /PROVIDER_PERMISSION.*403/); assert.equal(f.app.state.state, 'disconnected');
  f.ready(); assert.doesNotMatch(f.get('detail').textContent, /PROVIDER_PERMISSION/); f.app.dispose();
});
test('pagehide marks the app stopped and cannot leave a microphone action enabled', async () => {
  const f = appFixture(); f.ready(); f.pageEvents.pagehide();
  assert.equal(f.app.state.state, 'disconnected'); assert.equal(f.get('record').disabled, true); f.get('record').click(); await f.tick(); assert.equal(f.counts().captures, 0);
});
test('parallel feedback failures cannot unlock manual voice before response.created', async () => {
  const f = appFixture(); f.ready(); f.get('record').click(); await f.tick(); f.pcm(); f.get('stop').click(); await f.tick(); f.get('send').click(); await f.tick();
  assert.equal(f.app.state.awaitingResponse, true);
  for (const code of ['FEEDBACK_INVALID', 'FEEDBACK_TIMEOUT', 'PROVIDER_PERMISSION']) {
    f.emit({ type: 'feedback.pending' }); f.emit({ type: 'error', request: 'feedback', code, httpStatus: 403, message: '文字分析未完成。' });
    assert.equal(f.app.state.feedbackPending, false); assert.equal(f.app.state.awaitingResponse, true); assert.equal(f.get('record').disabled, true); assert.equal(f.get('send').disabled, true);
  }
  f.app.dispose();
});
test('parallel feedback failure cannot unlock manual recording during an active response', () => {
  const f = appFixture(); f.ready(); f.emit({ type: 'response.created', responseId: 'r1' }); f.emit({ type: 'feedback.pending' });
  f.emit({ type: 'error', request: 'feedback', code: 'PROVIDER_PERMISSION', httpStatus: 403, message: '文字分析未完成。' });
  assert.equal(f.app.state.responseActive, true); assert.equal(f.app.state.awaitingResponse, true); assert.equal(f.get('record').disabled, true); assert.equal(f.get('send').disabled, true);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'manual', responseActive: true, draftState: 'stopped', draftLength: 1600 }).send, false); f.app.dispose();
});
test('parallel feedback failure cannot restart realtime capture while a voice response is active', async () => {
  const f = appFixture({ mode: 'realtime' }); f.ready(); f.emit({ type: 'response.created', responseId: 'r1' }); f.emit({ type: 'feedback.pending' });
  f.emit({ type: 'error', request: 'feedback', code: 'FEEDBACK_TIMEOUT', message: '文字分析未完成。' });
  assert.equal(f.app.state.feedbackPending, false); assert.equal(f.app.state.awaitingResponse, true); assert.equal(f.get('start-call').disabled, true);
  assert.equal(api.deriveControls({ state: 'ready', mode: 'realtime', responseActive: true }).startCall, false);
  f.get('start-call').click(); await f.tick(); assert.equal(f.counts().captures, 0); f.app.dispose();
});
