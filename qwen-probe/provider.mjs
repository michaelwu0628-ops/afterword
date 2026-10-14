export const VOICE_MODEL = 'qwen3.8-omni-flash-realtime';
export const ASR_MODEL = 'qwen3-asr-flash-realtime';
import { TEXT_MODEL, validateFeedback, requestFeedback } from './feedback.mjs';
export { TEXT_MODEL, validateFeedback };
const instructions = 'You are a friendly English conversation partner. Respond briefly in natural English, usually with one relevant question. Allow the learner to think. Give a keyword or sentence beginning only when asked. Do not give pronunciation scores or claim an IELTS band.';
const ID = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const rawId = new RegExp(`^${ID}$`);
const baseURL = new RegExp(`^https://(${ID})\\.cn-beijing\\.maas\\.aliyuncs\\.com(?:/(?:compatible-mode/v1/?)?)?$`);
export function parseWorkspace(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('INVALID_WORKSPACE');
  const input = value.trim();
  if (rawId.test(input)) return input;
  const match = baseURL.exec(input);
  if (!match) throw new Error('INVALID_WORKSPACE');
  return match[1];
}
export function buildSessionUpdate(mode) {
  return { type: 'session.update', session: { modalities: ['text', 'audio'], audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { voice: 'Tina', format: { type: 'pcm', sample_rate: 24000 } } }, input_audio_transcription: { model: ASR_MODEL }, turn_detection: mode === 'manual' ? null : { type: 'server_vad', threshold: 0.5, silence_duration_ms: 5000 }, max_tokens: 1024, instructions } };
}
const usageFields = new Set(['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'text_tokens', 'audio_tokens', 'cached_tokens', 'input_token_details', 'output_token_details', 'prompt_tokens_details', 'completion_tokens_details', 'cached_tokens_details']);
export function safeUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) if (usageFields.has(key)) {
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item;
    else if (item && typeof item === 'object') result[key] = safeUsage(item, depth + 1);
  }
  return result;
}
const messages = {
  NOT_READY: '等待模型配置确认后再操作。', INVALID_MESSAGE: '请求格式不符合本页规则。', AUDIO_LIMIT: '音频超过本页限制，请重新录制。', BUSY: '上一项请求尚未结束。', EMPTY_AUDIO: '请先录制至少 0.1 秒音频。',
  PROVIDER_AUTH: '身份验证失败，请检查 Key 后手动重连。', PROVIDER_PERMISSION: '权限、额度或模型访问失败，请检查工作空间与控制台设置。', PROVIDER_RATE_LIMIT: '服务额度或频率限制，请检查控制台后手动重连。', PROVIDER_ERROR: '模型请求失败，请检查控制台后手动重连。', PROVIDER_NETWORK: '模型连接中断，请手动重连。', PROVIDER_TIMEOUT: '模型配置确认超时，请手动重连。', SESSION_LIMIT: '本次连接已达 5 分钟，请手动重连。',
  FEEDBACK_QUEUE_FULL: '点评等待队列已满，可稍后通过更正入口重新分析。', FEEDBACK_TIMEOUT: '文字分析超时，请手动重试。', FEEDBACK_INVALID: '文字结果为空或结构、原文引用不合格。', FEEDBACK_FAILED: '文字分析失败，请检查权限或手动重试。', BACKPRESSURE: '网络发送队列已满，本次连接停止。',
};
function statusCode(status) { return status === 401 ? 'PROVIDER_AUTH' : status === 403 ? 'PROVIDER_PERMISSION' : status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ERROR'; }
function eventId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null; }
function decodePCM(value) {
  if (typeof value !== 'string' || value.length > 44000 || value.length < 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length && bytes.length % 2 === 0 && bytes.length <= 32768 && bytes.toString('base64') === value ? bytes : null;
}

// Dependencies are explicit so offline tests cannot accidentally reach a model.
export function createProviderSession(client, config, { upstreamFactory, fetchImpl = fetch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let apiKey = config?.apiKey;
  const workspace = parseWorkspace(config?.workspace);
  const mode = config?.mode;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2048 || /[\r\n\x00-\x1f]/.test(apiKey) || !['manual', 'realtime'].includes(mode) || typeof upstreamFactory !== 'function') throw new Error('INVALID_CREDENTIALS');
  const host = `${workspace}.cn-beijing.maas.aliyuncs.com`;
  let upstream, closed = false, ready = false, configured = false, turnOpen = false, responsePending = false, turnBytes = 0, activeId = null, feedbackController = null, feedbackTimer = null;
  let unassignedAudioBytes = 0, pendingAudioCommits = 0;
  const inputItems = new Map(), feedbackQueue = [];
  let responseBytes = 0, responseTextLength = 0;
  const canceled = new Set();
  function emit(value) {
    if (closed || client.readyState !== 1) return;
    let leaked = false;
    const serialized = JSON.stringify(value, (key, item) => { if (apiKey && typeof item === 'string' && item.includes(apiKey)) leaked = true; return item; });
    if (leaked) { close(); return; }
    if (client.bufferedAmount + Buffer.byteLength(serialized) > 262144) { close(1013, 'BACKPRESSURE'); return; }
    try { client.send(serialized); } catch { close(); }
  }
  function fail(code, httpStatus, request, correlation = {}) { emit({ type: 'error', ...correlation, code, message: messages[code] || messages.PROVIDER_ERROR, ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}), ...(request === 'feedback' ? { request } : {}) }); }
  let handshakeTimer, lifetimeTimer;
  function close(code = 1000, reason = 'Session ended') {
    if (closed) return; closed = true; ready = false; apiKey = '';
    if (handshakeTimer) clearTimer(handshakeTimer); if (lifetimeTimer) clearTimer(lifetimeTimer); if (feedbackTimer) clearTimer(feedbackTimer);
    feedbackController?.abort(); feedbackController = null;
    for (const job of feedbackQueue.splice(0)) job.resolve();
    inputItems.clear(); unassignedAudioBytes = 0; pendingAudioCommits = 0;
    const old = upstream; upstream = null;
    if (old) { old.removeAllListeners?.(); old.on?.('error', () => {}); try { old.close(); } catch {} }
    if (client.readyState === 1 || client.readyState === 0) { try { client.close(typeof code === 'number' ? code : 1000, reason); } catch {} }
    canceled.clear(); activeId = null;
  }
  function upstreamSend(value) {
    if (closed || upstream?.readyState !== 1) return false;
    if (upstream.bufferedAmount > 262144 || client.bufferedAmount > 262144) { fail('BACKPRESSURE'); close(); return false; }
    try { upstream.send(JSON.stringify(value)); return true; } catch { fail('PROVIDER_NETWORK'); close(); return false; }
  }
  function cancelActive() {
    if (!activeId) return;
    const responseId = activeId; canceled.add(responseId);
    if (canceled.size > 64) canceled.delete(canceled.values().next().value);
    activeId = null; upstreamSend({ type: 'response.cancel' }); emit({ type: 'response.canceled', responseId });
  }
  function feedback(text, itemId) {
    const correlation = itemId ? { itemId, source: 'correction' } : { source: 'typed' };
    if (!itemId && feedbackController) { fail('BUSY', undefined, 'feedback', correlation); return Promise.resolve(); }
    return enqueueFeedback(text, correlation);
  }
  function enqueueFeedback(text, correlation) {
    const feedbackFail = code => fail(code, undefined, 'feedback', correlation);
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) { feedbackFail('INVALID_MESSAGE'); return Promise.resolve(); }
    if (correlation.source === 'correction' && !inputItems.get(correlation.itemId)?.text) { feedbackFail('INVALID_MESSAGE'); return Promise.resolve(); }
    if (feedbackController && feedbackQueue.length >= 8) { feedbackFail('FEEDBACK_QUEUE_FULL'); return Promise.resolve(); }
    return new Promise(resolve => {
      const job = { text: text.trim(), ...correlation, resolve };
      const queued = !!feedbackController;
      emit({ type: 'feedback.pending', ...correlation, queued });
      if (closed) { resolve(); return; }
      if (queued) feedbackQueue.push(job); else void runFeedback(job);
    });
  }
  async function runFeedback(job, wasQueued = false) {
    if (closed) { job.resolve(); return; }
    const correlation = { source: job.source, ...(job.itemId ? { itemId: job.itemId } : {}) };
    const controller = new AbortController(); feedbackController = controller; let timedOut = false;
    const timer = setTimer(() => { timedOut = true; controller.abort(); }, 30000); feedbackTimer = timer;
    if (wasQueued) emit({ type: 'feedback.pending', ...correlation, queued: false });
    try {
      const { result, usage } = await requestFeedback({ host, apiKey, text: job.text, fetchImpl, signal: controller.signal });
      if (!closed && !controller.signal.aborted) emit({ type: 'feedback.result', ...correlation, result, usage: safeUsage(usage) });
    } catch (error) {
      if (!closed) fail(timedOut ? 'FEEDBACK_TIMEOUT' : error?.message === 'FEEDBACK_INVALID' ? 'FEEDBACK_INVALID' : error?.message === 'FEEDBACK_HTTP' ? statusCode(error.httpStatus) : 'FEEDBACK_FAILED', error?.httpStatus, 'feedback', correlation);
    } finally {
      clearTimer(timer); if (feedbackTimer === timer) feedbackTimer = null;
      if (feedbackController === controller) feedbackController = null;
      job.resolve();
      if (!closed && feedbackQueue.length) void runFeedback(feedbackQueue.shift(), true);
    }
  }
  function associateInput(itemId) {
    if (!itemId || inputItems.has(itemId)) return;
    if (mode === 'manual' ? !pendingAudioCommits : !unassignedAudioBytes) return;
    if (inputItems.size >= 256) { fail('AUDIO_LIMIT'); close(); return; }
    if (mode === 'manual') pendingAudioCommits--; else unassignedAudioBytes = 0;
    inputItems.set(itemId, { finalized: false, text: null });
    emit({ type: 'user.transcription_pending', itemId });
  }
  function finishTranscription(event) {
    const itemId = eventId(event.item_id), item = inputItems.get(itemId);
    if (!item || item.finalized || (event.content_index !== undefined && event.content_index !== 0)) return;
    item.finalized = true;
    const text = event.transcript;
    const code = event.type.endsWith('.failed') ? 'TRANSCRIPTION_FAILED' : typeof text !== 'string' || text.length > 6000 ? 'TRANSCRIPTION_INVALID' : !text.trim() ? 'TRANSCRIPTION_EMPTY' : null;
    if (code) { emit({ type: 'user.transcription_failed', itemId, code }); return; }
    item.text = text.trim();
    emit({ type: 'user.transcript', itemId, text: item.text });
    if (!closed) void enqueueFeedback(item.text, { itemId, source: 'transcript' });
  }
  function handle(message) {
    if (closed) return;
    function invalid() { fail('INVALID_MESSAGE'); close(); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') return invalid();
    if (message.type === 'disconnect') return close();
    if (!['start_turn', 'audio', 'submit', 'cancel_response', 'feedback'].includes(message.type)) return invalid();
    if (!ready) return fail('NOT_READY', undefined, message.type === 'feedback' ? 'feedback' : undefined);
    if (message.type === 'feedback') {
      if (message.itemId !== undefined && !eventId(message.itemId)) return fail('INVALID_MESSAGE', undefined, 'feedback');
      return feedback(message.text, message.itemId);
    }
    if (message.type === 'cancel_response') return cancelActive();
    if (message.type === 'start_turn') {
      if ((mode === 'manual' && turnOpen) || activeId || responsePending) return fail('BUSY');
      turnOpen = true; turnBytes = 0; unassignedAudioBytes = 0; upstreamSend({ type: 'input_audio_buffer.clear' }); return;
    }
    if (message.type === 'audio') {
      const pcm = decodePCM(message.audio);
      if (!turnOpen || !pcm) return invalid();
      turnBytes += pcm.length;
      if (turnBytes > (mode === 'manual' ? 960000 : 9600000)) { fail('AUDIO_LIMIT'); close(); return; }
      if (upstreamSend({ type: 'input_audio_buffer.append', audio: message.audio })) unassignedAudioBytes += pcm.length; return;
    }
    if (mode !== 'manual' || !turnOpen) return invalid();
    if (turnBytes < 3200) return fail('EMPTY_AUDIO');
    turnOpen = false; responsePending = true; pendingAudioCommits++; upstreamSend({ type: 'input_audio_buffer.commit' }); upstreamSend({ type: 'response.create' });
  }
  function onMessage(raw) {
    if (closed || raw.length > 524288) return;
    let event; try { event = JSON.parse(raw.toString()); } catch { fail('PROVIDER_ERROR'); close(); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { fail('PROVIDER_ERROR'); close(); return; }
    if (event.type === 'session.created') { if (!configured) { configured = true; upstreamSend(buildSessionUpdate(mode)); } return; }
    if (event.type === 'session.updated') { if (configured && !ready) { ready = true; clearTimer(handshakeTimer); emit({ type: 'ready', mode, voiceModel: VOICE_MODEL, textModel: TEXT_MODEL, asrModel: ASR_MODEL }); } return; }
    if (event.type === 'error') { fail('PROVIDER_ERROR'); close(); return; }
    if (!ready) return;
    if (event.type === 'input_audio_buffer.committed') { associateInput(eventId(event.item_id)); return; }
    if (event.type === 'conversation.item.created') {
      if (event.item?.role === 'user' && Array.isArray(event.item.content) && event.item.content.some(part => part?.type === 'input_audio')) associateInput(eventId(event.item.id));
      return;
    }
    if (['conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed'].includes(event.type)) { finishTranscription(event); return; }
    if (event.type === 'response.created') {
      const id = eventId(event.response?.id); if (!id || canceled.has(id)) return;
      responsePending = false; activeId = id; responseBytes = 0; responseTextLength = 0; emit({ type: event.type, responseId: id }); return;
    }
    if (event.type === 'input_audio_buffer.speech_started') { const responseId = activeId; cancelActive(); emit({ type: event.type, ...(responseId ? { responseId } : {}) }); return; }
    if (event.type === 'input_audio_buffer.speech_stopped') { emit({ type: event.type }); return; }
    const id = eventId(event.response_id || event.response?.id);
    if (id && canceled.has(id) && event.type === 'response.done') { emit({ type: 'response.usage', responseId: id, status: 'cancelled', usage: safeUsage(event.response?.usage) }); return; }
    if (!id || canceled.has(id) || id !== activeId) return;
    if (event.type === 'response.done') {
      const statuses = ['completed', 'cancelled', 'failed', 'incomplete'];
      emit({ type: event.type, responseId: id, status: statuses.includes(event.response?.status) ? event.response.status : 'unknown', usage: safeUsage(event.response?.usage) }); activeId = null; return;
    }
    if (event.type === 'response.audio.delta') {
      if (typeof event.delta !== 'string' || event.delta.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)) { fail('PROVIDER_ERROR'); close(); return; }
      responseBytes += event.delta.length;
      if (responseBytes > 8000000) { fail('AUDIO_LIMIT'); close(); return; }
      emit({ type: event.type, responseId: id, delta: event.delta }); return;
    }
    if (event.type === 'response.audio.done') { emit({ type: event.type, responseId: id }); return; }
    const textKeys = { 'response.audio_transcript.delta': 'delta', 'response.audio_transcript.done': 'transcript', 'response.text.delta': 'delta', 'response.text.done': 'text' };
    const field = textKeys[event.type];
    if (field && typeof event[field] === 'string') {
      responseTextLength += event[field].length;
      if (event[field].length <= 16000 && responseTextLength <= 48000) emit({ type: event.type, responseId: id, [field]: event[field] });
    }
  }
  try {
    upstream = upstreamFactory(`wss://${host}/api-ws/v1/realtime?model=${VOICE_MODEL}`, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 15000, maxPayload: 524288, perMessageDeflate: false });
    upstream.on('message', onMessage);
    upstream.on('error', () => { fail('PROVIDER_NETWORK'); close(); });
    upstream.on('unexpected-response', (request, response) => { response.resume?.(); fail(statusCode(response.statusCode), response.statusCode); close(); });
    upstream.on('close', () => { if (!closed) { fail('PROVIDER_NETWORK'); close(); } });
  } catch { apiKey = ''; throw new Error('PROVIDER_NETWORK'); }
  handshakeTimer = setTimer(() => { fail('PROVIDER_TIMEOUT'); close(); }, 15000);
  lifetimeTimer = setTimer(() => { fail('SESSION_LIMIT'); close(); }, 300000);
  client.on('close', close);
  return { handle, close, get ready() { return ready; } };
}
