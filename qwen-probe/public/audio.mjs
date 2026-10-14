const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

function validRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('Audio sample rate must be positive.');
  return rate;
}

function floatToPcm(sample) {
  const clipped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return Math.round(clipped * (clipped < 0 ? 32768 : 32767));
}

// Keep the source position across worklet messages; restarting per block loses samples.
export function createResampler(inputRate, outputRate = INPUT_RATE) {
  validRate(inputRate);
  validRate(outputRate);
  let inputCount = 0;
  let outputCount = 0;
  let previous = 0;
  return {
    push(samples) {
      if (!(samples instanceof Float32Array)) throw new TypeError('Expected Float32Array audio.');
      if (!samples.length) return new Int16Array();
      const firstIndex = inputCount;
      const lastIndex = firstIndex + samples.length - 1;
      const output = [];
      while (true) {
        const position = outputCount * inputRate / outputRate;
        const left = Math.floor(position);
        const fraction = position - left;
        if (left > lastIndex || (fraction > 0 && left + 1 > lastIndex)) break;
        const a = left < firstIndex ? previous : samples[left - firstIndex];
        const b = fraction ? samples[left + 1 - firstIndex] : a;
        output.push(floatToPcm(a + (b - a) * fraction));
        outputCount++;
      }
      inputCount += samples.length;
      previous = samples[samples.length - 1];
      return Int16Array.from(output);
    },
    reset() { inputCount = 0; outputCount = 0; previous = 0; },
  };
}

function pcmBytes(pcm) {
  if (!(pcm instanceof Int16Array)) throw new TypeError('Expected Int16Array PCM.');
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  return bytes;
}

export function pcmToBase64(pcm) {
  const bytes = pcmBytes(pcm);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToPcm(encoded) {
  if (typeof encoded !== 'string') throw new TypeError('Expected base64 PCM text.');
  const binary = atob(encoded);
  if (binary.length % 2) throw new RangeError('16-bit PCM must have an even byte count.');
  const pcm = new Int16Array(binary.length / 2);
  for (let i = 0; i < pcm.length; i++) {
    const unsigned = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    pcm[i] = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  }
  return pcm;
}

export function encodeWav(pcm, sampleRate = INPUT_RATE) {
  validRate(sampleRate);
  const data = pcmBytes(pcm);
  const wav = new Uint8Array(44 + data.length);
  const view = new DataView(wav.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.length, true);
  wav.set(data, 44);
  return wav;
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function disconnect(node) {
  try { node?.disconnect(); } catch { /* A partially initialized node may already be disconnected. */ }
}

export function createCapture({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  AudioWorkletNode = globalThis.AudioWorkletNode,
  workletURL = new URL('./capture-worklet.mjs', import.meta.url).href,
  onPcm = () => {},
  onStop = () => {},
  maxMs = 30000,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancelTimer = globalThis.clearTimeout,
} = {}) {
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new RangeError('Capture duration must be positive.');
  const duration = Math.min(300000, maxMs);
  const maxSamples = Math.floor(duration * INPUT_RATE / 1000);
  let current = null;
  let disposed = false;
  let generation = 0;

  async function release(session) {
    if (session.released) return;
    session.released = true;
    if (session.timer !== null) cancelTimer(session.timer);
    if (session.node) {
      session.node.port.onmessage = null;
      session.node.port.close?.();
    }
    disconnect(session.source);
    disconnect(session.node);
    disconnect(session.gain);
    stopTracks(session.stream);
    if (session.context && session.context.state !== 'closed') {
      try { await session.context.close(); } catch { /* Tracks have already been released. */ }
    }
  }

  async function stop(reason = 'manual') {
    const session = current;
    if (!session) return null;
    current = null;
    generation++;
    const closing = release(session);
    const pcm = new Int16Array(session.count);
    let offset = 0;
    for (const chunk of session.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    session.chunks.length = 0;
    const result = { reason, pcm, sampleRate: INPUT_RATE, wav: encodeWav(pcm) };
    try { onStop(result); } finally { await closing; }
    return result;
  }

  async function start() {
    if (disposed) throw new Error('Audio capture has been disposed.');
    if (current) throw new Error('Audio capture is already starting or recording.');
    if (!mediaDevices?.getUserMedia || !AudioContext || !AudioWorkletNode) {
      throw new Error('This browser does not support microphone audio capture.');
    }
    const token = ++generation;
    const session = { chunks: [], count: 0, stream: null, context: null, node: null, source: null, gain: null, timer: null, released: false };
    current = session;
    const isCurrent = () => current === session && generation === token && !disposed;
    try {
      session.context = new AudioContext();
      // Resume during the initiating click, before waiting for microphone permission.
      const resumed = Promise.resolve(session.context.resume()).then(() => null, (error) => error);
      const stream = await mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true,
      }, video: false });
      if (!isCurrent()) { stopTracks(stream); return null; }
      session.stream = stream;
      const resumeError = await resumed;
      if (resumeError) throw resumeError;
      if (!isCurrent()) return null;
      await session.context.audioWorklet.addModule(workletURL);
      if (!isCurrent()) return null;
      const resampler = createResampler(session.context.sampleRate);
      session.source = session.context.createMediaStreamSource(stream);
      session.node = new AudioWorkletNode(session.context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      session.gain = session.context.createGain();
      session.gain.gain.value = 0;
      session.node.port.onmessage = ({ data }) => {
        if (!isCurrent()) return;
        const floats = data instanceof Float32Array ? data : new Float32Array(data);
        const converted = resampler.push(floats);
        const pcm = converted.subarray(0, Math.max(0, maxSamples - session.count));
        if (pcm.length) {
          session.chunks.push(pcm.slice());
          session.count += pcm.length;
          onPcm(pcm);
        }
        if (isCurrent() && session.count >= maxSamples) void stop('limit').catch(() => {});
      };
      session.source.connect(session.node);
      session.node.connect(session.gain);
      session.gain.connect(session.context.destination);
      session.timer = schedule(() => { if (isCurrent()) void stop('limit').catch(() => {}); }, duration);
      return { sampleRate: session.context.sampleRate };
    } catch (error) {
      if (!isCurrent()) return null;
      await stop('error');
      throw error;
    }
  }

  return {
    start, stop,
    async dispose() { disposed = true; return stop('dispose'); },
  };
}

export function createPlayback({
  AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  sampleRate = OUTPUT_RATE,
  maxQueuedSeconds = 10,
  onStateChange = () => {},
} = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new RangeError('Playback sample rate must be an integer from 8000 to 48000.');
  if (!Number.isFinite(maxQueuedSeconds) || maxQueuedSeconds <= 0) throw new RangeError('Playback queue duration must be positive.');
  let context = null;
  let disposed = false;
  let activeId = null;
  let nextTime = 0;
  let receivedSamples = 0;
  let completedSamples = 0;
  const sources = new Set();
  const segments = new Map();

  function progress() {
    let playedSamples = completedSamples;
    for (const { startTime, length } of segments.values()) {
      playedSamples += Math.max(0, Math.min(length, Math.floor((context.currentTime - startTime) * sampleRate)));
    }
    return { responseId: activeId, sampleRate, receivedSamples, playedSamples, audioEndMs: Math.floor(playedSamples * 1000 / sampleRate) };
  }

  function clearQueue() {
    segments.clear();
    receivedSamples = 0;
    completedSamples = 0;
    for (const source of sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A completed source may already be stopped. */ }
      disconnect(source);
    }
    sources.clear();
    nextTime = 0;
    onStateChange(false);
  }

  async function unlock() {
    if (disposed) return false;
    if (!AudioContext) throw new Error('This browser does not support audio playback.');
    context ??= new AudioContext();
    await context.resume();
    return !disposed && context.state === 'running';
  }

  function activate(responseId) {
    if (disposed) return;
    if (typeof responseId !== 'string' || !responseId) throw new TypeError('Playback needs a response ID.');
    if (activeId === responseId) return;
    clearQueue();
    activeId = responseId;
  }

  function enqueue(encoded, responseId) {
    if (disposed || !context || context.state !== 'running' || !activeId || responseId !== activeId) return false;
    // A single oversized message must not allocate an unbounded decoded buffer.
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxQueuedSeconds * sampleRate * 2 / 3) * 4 + 4) return false;
    const pcm = base64ToPcm(encoded);
    if (!pcm.length) return true;
    const startTime = Math.max(context.currentTime, nextTime);
    const duration = pcm.length / sampleRate;
    if (startTime - context.currentTime + duration > maxQueuedSeconds) return false;
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const floats = Float32Array.from(pcm, (sample) => sample / 32768);
    buffer.copyToChannel(floats, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      const segment = segments.get(source);
      if (!segment) return;
      segments.delete(source);
      completedSamples += segment.length;
      sources.delete(source);
      disconnect(source);
      onStateChange(sources.size > 0);
    };
    sources.add(source);
    segments.set(source, { startTime, length: pcm.length });
    receivedSamples += pcm.length;
    source.start(startTime);
    nextTime = startTime + duration;
    onStateChange(true);
    return true;
  }

  function stop() {
    const snapshot = progress();
    activeId = null;
    clearQueue();
    return snapshot;
  }

  return {
    unlock, activate, enqueue, progress, stop,
    get playing() { return sources.size > 0; },
    async dispose() {
      disposed = true;
      stop();
      if (context && context.state !== 'closed') await context.close();
    },
  };
}
