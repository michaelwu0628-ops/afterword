import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProviderSession, validateFeedback, buildSessionUpdate } from '../provider.mjs';
import * as feedbackApi from '../feedback.mjs';

const secret = 'OFFLINE_SECRET_NEVER_FORWARDED';
const text = 'I very like podcasts.';
const result = { assessment: 'suggestions', summary: '这里有一处搭配可以调整。', suggestions: [{ original: 'very like', suggestion: 'really like', reason: '用 really 修饰动词 like 更自然。' }] };
const response = (value = result) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 7, total_tokens: 19, secret } }) });
const settle = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; closed = false;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  event(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function setup(options = {}) {
  const client = new Socket(), upstream = new Socket(), calls = [];
  const session = createProviderSession(client, { apiKey: secret, workspace: 'ws-offline', mode: options.mode || 'manual' }, {
    upstreamFactory: () => upstream,
    fetchImpl: async (url, request) => { calls.push({ url, request }); return options.fetchImpl ? options.fetchImpl(url, request) : response(); },
    ...options.deps,
  });
  upstream.event({ type: 'session.created' }); upstream.event({ type: 'session.updated' });
  return { client, upstream, calls, session };
}
function sendAudio(f, itemId, { userItem = false, noStart = false } = {}) {
  if (!noStart) f.session.handle({ type: 'start_turn' });
  f.session.handle({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') });
  if (f.upstream.sent[0].session.turn_detection === null) f.session.handle({ type: 'submit' });
  f.upstream.event(userItem ? { type: 'conversation.item.created', item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_audio' }] } } : { type: 'input_audio_buffer.committed', item_id: itemId });
}
function transcribe(f, itemId, transcript = text, extra = {}) {
  f.upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript, ...extra });
}

test('both recording modes enable only the fixed input ASR model', () => {
  for (const mode of ['manual', 'realtime']) assert.deepEqual(buildSessionUpdate(mode).session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime' });
});

test('a committed recording transcribes and requests feedback once independently of the assistant response ID', async () => {
  const f = setup();
  try {
    sendAudio(f, 'opaque/User item:1');
    f.upstream.event({ type: 'response.created', response: { id: 'assistant-1' } });
    f.upstream.event({ type: 'response.audio_transcript.done', response_id: 'assistant-1', transcript: 'An assistant sentence.' });
    transcribe(f, 'opaque/User item:1', text, { usage: { total_tokens: 999 }, secret });
    transcribe(f, 'opaque/User item:1');
    await settle();
    assert.deepEqual(f.client.sent.find(event => event.type === 'user.transcript'), { type: 'user.transcript', itemId: 'opaque/User item:1', text });
    assert.equal(f.calls.length, 1);
    const body = JSON.parse(f.calls[0].request.body);
    assert.equal(body.model, 'qwen-plus'); assert.equal(body.messages[1].content, text);
    assert.match(body.messages[0].content, /do not translate/i);
    assert.match(body.messages[0].content, /summary.*evaluat/i);
    assert.equal(f.calls[0].request.redirect, 'error');
    const events = f.client.sent.filter(event => event.type.startsWith('feedback.'));
    assert.deepEqual(events.map(event => [event.type, event.itemId, event.source]), [['feedback.pending', 'opaque/User item:1', 'transcript'], ['feedback.result', 'opaque/User item:1', 'transcript']]);
    assert.deepEqual(events[1].usage, { prompt_tokens: 7, total_tokens: 19 });
    assert.equal(JSON.stringify(f.client.sent).includes(secret), false);
    assert.equal(f.client.sent.some(event => event.usage?.total_tokens === 999), false);
  } finally { f.session.close(); }
});

test('realtime user input_audio items are associated only after audio was actually sent', async () => {
  const f = setup({ mode: 'realtime' });
  try {
    sendAudio(f, 'realtime-1', { userItem: true }); transcribe(f, 'realtime-1'); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.client.sent.find(event => event.type === 'user.transcript').itemId, 'realtime-1');
  } finally { f.session.close(); }
});

test('clearing a realtime buffer cannot authorize a transcription for discarded audio', async () => {
  const f = setup({ mode: 'realtime' });
  try {
    f.session.handle({ type: 'start_turn' });
    f.session.handle({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') });
    f.session.handle({ type: 'start_turn' });
    f.upstream.event({ type: 'input_audio_buffer.committed', item_id: 'discarded' });
    transcribe(f, 'discarded'); await settle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.client.sent.some(event => event.type === 'user.transcript'), false);
  } finally { f.session.close(); }
});

test('unassociated, intermediate, assistant and malformed transcription events cannot launch feedback', async () => {
  const f = setup();
  try {
    f.upstream.event({ type: 'input_audio_buffer.committed', item_id: 'fake-commit' });
    f.upstream.event({ type: 'conversation.item.created', item: { id: 'fake-item', type: 'message', role: 'user', content: [{ type: 'input_audio' }] } });
    for (const item of ['unknown', 'fake-commit', 'fake-item', '', 'x'.repeat(257)]) transcribe(f, item);
    sendAudio(f, 'user-1');
    f.upstream.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user-1', delta: text });
    f.upstream.event({ type: 'response.created', response: { id: 'assistant-1' } });
    f.upstream.event({ type: 'response.audio_transcript.done', response_id: 'assistant-1', transcript: text });
    f.upstream.event({ type: 'conversation.item.created', item: { id: 'assistant-item', type: 'message', role: 'assistant', content: [{ type: 'input_audio' }] } });
    transcribe(f, 'assistant-item'); await settle();
    assert.equal(f.calls.length, 0); assert.equal(f.client.sent.some(event => event.type === 'user.transcript'), false);
  } finally { f.session.close(); }
});

test('empty, excessive and failed ASR results emit safe failures once without making up text', async () => {
  for (const [kind, transcript, expected] of [['empty', '  ', 'TRANSCRIPTION_EMPTY'], ['long', 'a'.repeat(6001), 'TRANSCRIPTION_INVALID'], ['failed', null, 'TRANSCRIPTION_FAILED']]) {
    const f = setup();
    try {
      sendAudio(f, 'user-1');
      const event = kind === 'failed' ? { type: 'conversation.item.input_audio_transcription.failed', item_id: 'user-1', error: { code: secret, message: secret } } : { type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript };
      f.upstream.event(event); f.upstream.event(event); transcribe(f, 'user-1'); await settle();
      assert.deepEqual(f.client.sent.filter(event => event.type === 'user.transcription_failed'), [{ type: 'user.transcription_failed', itemId: 'user-1', code: expected }]);
      assert.equal(f.calls.length, 0); assert.equal(f.client.sent.some(event => event.type === 'user.transcript'), false);
      assert.equal(f.upstream.closed, false); assert.equal(JSON.stringify(f.client.sent).includes(secret), false);
    } finally { f.session.close(); }
  }
});

test('valid corrections retain their input item and source while unknown items cannot trigger requests', async () => {
  const f = setup();
  try {
    await f.session.handle({ type: 'feedback', itemId: 'unknown', text });
    assert.equal(f.calls.length, 0); assert.equal(f.client.sent.at(-1).request, 'feedback');
    sendAudio(f, 'user-1'); transcribe(f, 'user-1'); await settle();
    await f.session.handle({ type: 'feedback', itemId: 'user-1', text: 'Actually, I very like podcasts.' });
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.parse(f.calls[1].request.body).messages[1].content, 'Actually, I very like podcasts.');
    assert.equal(f.client.sent.at(-1).itemId, 'user-1'); assert.equal(f.client.sent.at(-1).source, 'correction');
  } finally { f.session.close(); }
});

test('automatic feedback has one active request and eight waiting slots with explicit overflow', async () => {
  const resolvers = [];
  const f = setup({ mode: 'realtime', fetchImpl: () => new Promise(resolve => resolvers.push(resolve)) });
  try {
    for (let n = 1; n <= 10; n++) { sendAudio(f, `user-${n}`, { noStart: n > 1 }); transcribe(f, `user-${n}`); }
    assert.equal(f.calls.length, 1);
    const pending = f.client.sent.filter(event => event.type === 'feedback.pending');
    assert.equal(pending.length, 9); assert.equal(pending[0].queued, false); assert.equal(pending[1].queued, true);
    assert.deepEqual(f.client.sent.filter(event => event.code === 'FEEDBACK_QUEUE_FULL').map(event => [event.request, event.itemId, event.source]), [['feedback', 'user-10', 'transcript']]);
    for (let n = 1; n <= 9; n++) { resolvers[n - 1](response()); await settle(); assert.equal(f.calls.length, Math.min(n + 1, 9)); }
    assert.deepEqual(f.client.sent.filter(event => event.type === 'feedback.result').map(event => event.itemId), Array.from({ length: 9 }, (_, n) => `user-${n + 1}`));
  } finally { f.session.close(); }
});

test('closing aborts the active analysis and discards queued analyses even if a fake fetch ignores abort', async () => {
  const f = setup({ mode: 'realtime', fetchImpl: () => new Promise(() => {}) });
  sendAudio(f, 'user-1'); transcribe(f, 'user-1');
  sendAudio(f, 'user-2', { noStart: true }); transcribe(f, 'user-2');
  const signal = f.calls[0]?.request.signal;
  f.session.close(); await settle();
  assert.ok(signal, 'the recorded utterance must have launched an analysis');
  assert.equal(signal.aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.upstream.closed, true);
  assert.equal(f.client.sent.some(event => event.type === 'feedback.result'), false);
});

test('feedback timeouts keep their item/source and leave an active voice response intact', async () => {
  const timers = [];
  const f = setup({ fetchImpl: () => new Promise(() => {}), deps: { setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer: timer => { timer.cleared = true; } } });
  try {
    sendAudio(f, 'user-1'); transcribe(f, 'user-1');
    f.upstream.event({ type: 'response.created', response: { id: 'voice-1' } });
    const timer = timers.find(timer => timer.ms === 30000); assert.ok(timer, 'automatic feedback must have a deadline');
    timer.fn(); await settle();
    const error = f.client.sent.find(event => event.code === 'FEEDBACK_TIMEOUT');
    assert.deepEqual([error.request, error.itemId, error.source], ['feedback', 'user-1', 'transcript']);
    f.upstream.event({ type: 'response.audio.delta', response_id: 'voice-1', delta: 'AAA=' });
    assert.equal(f.client.sent.at(-1).type, 'response.audio.delta'); assert.equal(f.upstream.closed, false);
  } finally { f.session.close(); }
});

test('feedback schema accepts real rewrites or an explicit no-clear-issue assessment', () => {
  assert.deepEqual(validateFeedback(result, text), result);
  const valid = { assessment: 'no_clear_issue', summary: '未发现明显语法或搭配问题，无需修改。', suggestions: [] };
  assert.deepEqual(validateFeedback(valid, 'I enjoy listening to podcasts.'), valid);
});

test('translation-shaped, fabricated, unchanged and inconsistent feedback is rejected', () => {
  const bad = [
    { summary: '我非常喜欢播客。', suggestions: [] },
    { ...result, assessment: 'no_clear_issue' },
    { ...result, assessment: 'suggestions', suggestions: [] },
    { ...result, suggestions: [{ ...result.suggestions[0], suggestion: '很喜欢' }] },
    { ...result, suggestions: [{ ...result.suggestions[0], suggestion: 'really like（很喜欢）' }] },
    { ...result, suggestions: [{ ...result.suggestions[0], suggestion: 'very like' }] },
    { ...result, suggestions: [{ ...result.suggestions[0], suggestion: '123' }] },
    { ...result, suggestions: [{ ...result.suggestions[0], original: 'I dislike podcasts' }] },
    { ...result, suggestions: Array(4).fill(result.suggestions[0]) },
  ];
  for (const value of bad) assert.throws(() => validateFeedback(value, text), /FEEDBACK_INVALID/);
});

const knowledge = { status: 'matched', method: 'bm25+graph', corpusVersion: 'test-v1', cards: [
  { id: 'card-like', intent: 'opinion', expression: 'really like', meaning: '喜欢', register: 'neutral', usage: 'Use really before like.', pitfalls: [], collocations: [], aliases: [], examples: ['I really like music.'], source_refs: ['source-1'], relations: [], grounding_scope: 'editorial_principles_not_official_exact_certification' },
] };

test('coach baseline and RAG share one prompt and parameters while learner text stays message 1', () => {
  assert.equal(typeof feedbackApi.buildFeedbackRequest, 'function');
  const baseline = feedbackApi.buildFeedbackRequest({ text, coach: true });
  const rag = feedbackApi.buildFeedbackRequest({ text, coach: true, knowledge });
  assert.deepEqual({ ...rag, messages: baseline.messages }, baseline);
  assert.deepEqual(baseline.messages, rag.messages.slice(0, 2));
  assert.equal(baseline.messages[1].content, text);
  assert.equal(rag.messages[2].role, 'user');
  const reference = JSON.parse(rag.messages[2].content);
  assert.equal(reference.type, 'expression_knowledge_reference');
  assert.deepEqual(reference.cards.map(card => card.id), ['card-like']);
  assert.match(baseline.messages[0].content, /untrusted|not instructions/i);
  assert.match(baseline.messages[0].content, /optional/);
  assert.match(baseline.messages[0].content, /no_clear_issue/);
  assert.match(baseline.messages[0].content, /pronunciation/i);
  assert.equal(baseline.max_tokens, 700);
  const legacy = feedbackApi.buildFeedbackRequest({ text, knowledge });
  assert.equal(legacy.messages.length, 2);
  assert.equal(legacy.messages[0].content, feedbackApi.FEEDBACK_PROMPT);
});

test('coach suggestions retain selected knowledge ids and mark optional alternatives explicitly', () => {
  const value = { ...result, suggestions: [{ ...result.suggestions[0], kind: 'optional', knowledge_ids: ['card-like'], url: 'https://forged.example' }] };
  const validated = feedbackApi.validateFeedback(value, text, { coach: true, knowledge });
  assert.deepEqual(validated.suggestions[0], { ...result.suggestions[0], kind: 'optional', knowledge_ids: ['card-like'] });
  const correction = { ...result, suggestions: [{ ...result.suggestions[0], kind: 'correction' }] };
  assert.deepEqual(feedbackApi.validateFeedback(correction, text, { coach: true }).suggestions[0], { ...result.suggestions[0], kind: 'correction', knowledge_ids: [] });
  assert.deepEqual(feedbackApi.validateFeedback(result, text), result);
});

test('coach rejects an omitted kind instead of labelling an optional alternative as a correction', () => {
  const original = 'I think this is useful.';
  const value = { assessment: 'suggestions', summary: '原句自然。', suggestions: [{
    original: 'I think', suggestion: 'In my view', reason: '原句自然，这是可选说法。', knowledge_ids: [],
  }] };
  assert.throws(() => feedbackApi.validateFeedback(value, original, { coach: true }), /FEEDBACK_INVALID/);
  assert.deepEqual(feedbackApi.validateFeedback(value, original).suggestions[0], {
    original: 'I think', suggestion: 'In my view', reason: '原句自然，这是可选说法。',
  });
});

test('coach rejects unknown, duplicate, excessive or malformed citations and invalid suggestion kinds', () => {
  for (const ids of [['missing'], ['card-like', 'card-like'], ['card-like', 'b', 'c'], 'card-like', [1]]) {
    const value = { ...result, suggestions: [{ ...result.suggestions[0], kind: 'correction', knowledge_ids: ids }] };
    assert.throws(() => feedbackApi.validateFeedback(value, text, { coach: true, knowledge }), /FEEDBACK_INVALID/);
  }
  assert.throws(() => feedbackApi.validateFeedback({ ...result, suggestions: [{ ...result.suggestions[0], kind: 'error' }] }, text, { coach: true, knowledge }), /FEEDBACK_INVALID/);
  assert.throws(() => feedbackApi.validateFeedback({ ...result, suggestions: [{ ...result.suggestions[0], knowledge_ids: ['card-like'] }] }, text, { coach: true }), /FEEDBACK_INVALID/);
  assert.deepEqual(feedbackApi.validateFeedback({ assessment: 'no_clear_issue', summary: '无需修改。', suggestions: [] }, text, { coach: true, knowledge }).suggestions, []);
});

test('coach request uses the shared builder and validates citation ids before returning a result', async () => {
  let payload;
  const selected = { ...result, suggestions: [{ ...result.suggestions[0], kind: 'correction', knowledge_ids: ['card-like'] }] };
  const output = await feedbackApi.requestFeedback({ host: 'offline.example', apiKey: secret, text, coach: true, knowledge, signal: new AbortController().signal,
    fetchImpl: async (url, request) => { payload = JSON.parse(request.body); return response(selected); } });
  assert.equal(payload.messages.length, 3);
  assert.deepEqual(output.result.suggestions[0].knowledge_ids, ['card-like']);
});

const part2Axes = { lexical: { status: 'assessed', feedback: 'like 的程度修饰可用 really。', original: 'very like' },
  grammar: { status: 'assessed', feedback: '主句完整，时态为一般现在时。', original: 'I very like podcasts.' },
  organisation: { status: 'unavailable', reason: '当前原话较短，无法判断展开结构。' },
  pronunciation: { status: 'assessed', band: 9 }, score: 9 };
test('Part 2 request asks for transcript-grounded dimensions and validation never forwards audio claims or a band', () => {
  const request = feedbackApi.buildFeedbackRequest({ text, coach: true, part2: true });
  assert.equal(request.messages[1].content, text); assert.match(request.messages[0].content, /organisation/); assert.match(request.messages[0].content, /exact.*substring/i);
  const input = { ...result, suggestions: [{ ...result.suggestions[0], kind: 'correction' }], part2Assessment: part2Axes };
  const validated = feedbackApi.validateFeedback(input, text, { coach: true, part2: true });
  assert.equal(validated.part2Assessment.lexical.original, 'very like');
  assert.equal(validated.part2Assessment.pronunciation.status, 'unavailable'); assert.equal(validated.part2Assessment.score.status, 'unavailable');
  assert.equal(JSON.stringify(validated.part2Assessment).includes('band'), false);
  assert.throws(() => feedbackApi.validateFeedback({ ...input, part2Assessment: { ...part2Axes, lexical: { ...part2Axes.lexical, original: 'fabricated original' } } }, text, { coach: true, part2: true }), /FEEDBACK_INVALID/);
  assert.throws(() => feedbackApi.validateFeedback({ ...input, part2Assessment: undefined }, text, { coach: true, part2: true }), /FEEDBACK_INVALID/);
});
