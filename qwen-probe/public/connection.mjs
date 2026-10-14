const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 3200;
const MAX_SAMPLES = SAMPLE_RATE * 30;
const OUTGOING_TYPES = new Set(['start_turn', 'audio', 'submit', 'cancel_response', 'feedback', 'disconnect']);
const TRANSPORT_ERROR = '本地连接已断开，请检查服务后重新连接。';
const QUEUE_ERROR = '连接发送队列已满，已断开连接，请重新连接后重试。';
const validItemId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

function encodePcm(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Holds a recording locally. No connection or remote operations are involved. */
export function createDraft({ maxSamples = MAX_SAMPLES } = {}) {
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > MAX_SAMPLES) {
    throw new RangeError('Draft maximum must be between 1 and 480000 samples.');
  }
  let state = 'recording';
  let length = 0;
  let chunks = [];
  return {
    push(samples) {
      if (state !== 'recording') throw new Error('Draft is not recording; it has stopped.');
      if (!(samples instanceof Int16Array)) throw new TypeError('Draft requires Int16Array samples.');
      if (length + samples.length > maxSamples) throw new RangeError('Draft maximum duration limit reached.');
      if (samples.length) {
        chunks.push(samples.slice());
        length += samples.length;
      }
    },
    stop() { if (state === 'recording') state = 'stopped'; },
    discard() {
      state = 'discarded';
      chunks = [];
      length = 0;
    },
    get samples() {
      const result = new Int16Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    },
    get state() { return state; },
    get length() { return length; },
  };
}

/** A user initiated local connection; credentials live only until its first frame. */
export function createConnection({
  WebSocketImpl = globalThis.WebSocket,
  url,
  onEvent = () => {},
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxBufferedAmount = 128 * 1024,
} = {}) {
  if (!Number.isFinite(maxBufferedAmount) || maxBufferedAmount < 1) throw new RangeError('Invalid queue limit.');
  let socket = null;
  let generation = 0;
  let state = 'disconnected';
  let mode = 'manual';
  let pendingCredentials = null;
  let pendingSubmission = null;
  let hasServerDiagnostic = false;
  let activeResponse = false;
  let activeResponseId = null;
  let retiredResponseIds = new Set();
  const recognizedItems = new Set();
  const submittedDrafts = new WeakSet();

  function setState(next) {
    if (state === next) return;
    state = next;
    onEvent({ type: 'connection_state', state });
  }

  function disconnect() {
    generation++;
    const previous = socket;
    socket = null;
    pendingCredentials = null;
    pendingSubmission = null;
    hasServerDiagnostic = false;
    activeResponse = false;
    activeResponseId = null;
    retiredResponseIds = new Set();
    recognizedItems.clear();
    setState('disconnected');
    if (previous && previous.readyState < 2) {
      try { previous.close(); } catch { /* The disconnected state is already applied. */ }
    }
  }

  function fail(code, message) {
    const preserveDiagnostic = hasServerDiagnostic && (code === 'connection_closed' || code === 'connection_error');
    disconnect();
    if (!preserveDiagnostic) onEvent({ type: 'error', code, message });
  }

  function write(frame) {
    if (!socket || socket.readyState !== 1) return false;
    let serialized;
    try { serialized = JSON.stringify(frame); } catch { return false; }
    const size = new TextEncoder().encode(serialized).byteLength;
    if (size + (socket.bufferedAmount || 0) > maxBufferedAmount) {
      fail('client_backpressure', QUEUE_ERROR);
      return false;
    }
    try { socket.send(serialized); return true; }
    catch { fail('connection_error', TRANSPORT_ERROR); return false; }
  }

  function retireActiveResponse() {
    if (activeResponseId) {
      retiredResponseIds.add(activeResponseId);
      if (retiredResponseIds.size > 256) retiredResponseIds.delete(retiredResponseIds.values().next().value);
    }
    activeResponse = false;
    activeResponseId = null;
  }

  function connect({ apiKey, workspace = '', mode: selectedMode = 'manual' } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2048) throw new Error('请输入有效的 API Key。');
    if (typeof workspace !== 'string' || workspace.length > 256) throw new Error('请输入有效的工作空间。');
    if (!['manual', 'realtime'].includes(selectedMode)) throw new Error('请选择有效的会话模式。');
    if (typeof WebSocketImpl !== 'function') throw new Error('当前环境不支持本地连接。');
    disconnect();
    mode = selectedMode;
    pendingCredentials = { type: 'connect', apiKey: apiKey.trim(), workspace: workspace.trim(), mode };
    const currentGeneration = generation;
    let current;
    try { current = new WebSocketImpl(url); }
    catch { fail('connection_error', TRANSPORT_ERROR); return; }
    socket = current;
    setState('connecting');
    const isCurrent = () => socket === current && generation === currentGeneration;
    current.addEventListener('open', () => {
      if (!isCurrent() || !pendingCredentials) return;
      const credentials = pendingCredentials;
      pendingCredentials = null;
      write(credentials);
    });
    current.addEventListener('message', event => {
      if (!isCurrent()) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (['user.transcript', 'user.transcription_pending', 'user.transcription_failed'].includes(message.type)) {
        if (!validItemId(message.itemId)) return;
        if (message.type === 'user.transcript') {
          if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 6000) return;
          if (recognizedItems.size >= 256) recognizedItems.delete(recognizedItems.values().next().value);
          recognizedItems.add(message.itemId);
          onEvent({ type: message.type, itemId: message.itemId, text: message.text });
        } else if (message.type === 'user.transcription_pending') onEvent({ type: message.type, itemId: message.itemId });
        else onEvent({ type: message.type, itemId: message.itemId, code: typeof message.code === 'string' && /^[A-Z_]{1,80}$/.test(message.code) ? message.code : 'TRANSCRIPTION_FAILED' });
        return;
      }
      const responseId = typeof message.responseId === 'string' ? message.responseId : null;
      if (message.type === 'ready') setState('ready');
      if (message.type === 'response.created') {
        if (responseId && retiredResponseIds.has(responseId)) return;
        if (activeResponse && responseId === activeResponseId) return;
        retireActiveResponse();
        activeResponse = true;
        activeResponseId = responseId;
      } else if (message.type !== 'response.usage' && message.type.startsWith('response.') && responseId) {
        if (retiredResponseIds.has(responseId) || (activeResponseId && responseId !== activeResponseId)) return;
      }
      if (message.type === 'response.done' || message.type === 'response.canceled' || message.type === 'input_audio_buffer.speech_started') {
        retireActiveResponse();
      }
      if (message.type === 'error' || message.type === 'feedback.error') {
        if (message.type === 'error') hasServerDiagnostic = true;
        message = {
          type: message.type,
          code: typeof message.code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(message.code) ? message.code : 'request_error',
          message: '请求未完成，请检查连接和配置后重试。',
          ...(Number.isInteger(message.httpStatus) ? { httpStatus: message.httpStatus } : {}),
          ...(message.request === 'feedback' ? { request: 'feedback' } : {}),
          ...(validItemId(message.itemId) ? { itemId: message.itemId } : {}),
          ...(['transcript', 'correction'].includes(message.source) ? { source: message.source } : {}),
        };
      }
      onEvent(message);
    });
    current.addEventListener('error', () => { if (isCurrent()) fail('connection_error', TRANSPORT_ERROR); });
    current.addEventListener('close', () => {
      if (!isCurrent()) return;
      fail('connection_closed', TRANSPORT_ERROR);
    });
  }

  function send(type, data = {}) {
    if (state !== 'ready' || !OUTGOING_TYPES.has(type)) return false;
    if (type === 'cancel_response' && !activeResponse) return false;
    if (type === 'feedback' && (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > 6000 || !recognizedItems.has(data.itemId))) return false;
    return write({ ...data, type });
  }

  async function submitDraft(samples) {
    if (state !== 'ready') throw new Error('Connection must be ready before submitting.');
    if (mode !== 'manual') throw new Error('Draft submission requires manual mode.');
    if (pendingSubmission) throw new Error('A draft submission is already in progress.');
    if (!(samples instanceof Int16Array)) throw new TypeError('Draft must be an Int16Array.');
    if (samples.length < 1600) throw new RangeError('Draft minimum is 100 ms.');
    if (samples.length > MAX_SAMPLES) throw new RangeError('Draft maximum is 30 seconds.');
    if (submittedDrafts.has(samples)) throw new Error('This draft has already been submitted.');
    const token = {};
    const submissionGeneration = generation;
    pendingSubmission = token;
    const ensureCurrent = () => {
      if (generation !== submissionGeneration || state !== 'ready') throw new Error('Connection disconnected during submission.');
    };
    try {
      if (!send('start_turn')) throw new Error('Connection queue could not start the turn.');
      submittedDrafts.add(samples);
      const snapshot = samples.slice();
      for (let offset = 0; offset < snapshot.length; offset += CHUNK_SAMPLES) {
        ensureCurrent();
        const chunk = snapshot.subarray(offset, offset + CHUNK_SAMPLES);
        if (!send('audio', { audio: encodePcm(chunk) })) throw new Error('Connection queue could not send the audio.');
        await sleep(chunk.length * 1000 / SAMPLE_RATE);
      }
      ensureCurrent();
      if (!send('submit')) throw new Error('Connection queue could not submit the turn.');
    } finally {
      if (pendingSubmission === token) pendingSubmission = null;
    }
  }

  return {
    connect,
    disconnect,
    send,
    submitDraft,
    feedback(text, itemId) {
      if (typeof text !== 'string' || !text.trim() || text.length > 6000 || !validItemId(itemId) || !recognizedItems.has(itemId)) return false;
      return send('feedback', { text: text.trim(), itemId });
    },
    get state() { return state; },
    get mode() { return mode; },
  };
}
