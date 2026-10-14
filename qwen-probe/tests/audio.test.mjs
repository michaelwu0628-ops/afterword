import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let audio = {};
try { audio = await import('../public/audio.mjs'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('streaming resampling keeps sample positions across irregular chunk boundaries', () => {
  assert.equal(typeof audio.createResampler, 'function');
  const samples = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 20) * 0.7);
  const whole = audio.createResampler(44100).push(samples);
  const streaming = audio.createResampler(44100);
  const chunks = [];
  let i = 0;
  for (const size of [1, 127, 255, 5, 1000, 7777, 31, 25000, 99999]) {
    chunks.push(...streaming.push(samples.subarray(i, Math.min(i + size, samples.length))));
    i = Math.min(i + size, samples.length);
  }
  assert.equal(whole.length, 16000);
  assert.deepEqual(Int16Array.from(chunks), whole);
  streaming.reset();
  assert.deepEqual(streaming.push(samples), whole);
});

test('PCM conversion clamps float samples and preserves signed little endian values', () => {
  assert.equal(typeof audio.pcmToBase64, 'function');
  const pcm = audio.createResampler(16000).push(Float32Array.of(-2, -1, 0, 0.5, 1, 2));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 16384, 32767, 32767]);
  assert.deepEqual(audio.base64ToPcm(audio.pcmToBase64(pcm)), pcm);
  assert.throws(() => audio.base64ToPcm('AQ=='), /16|even|PCM/i);
});

test('WAV header and data lengths describe the exact mono PCM sample count', () => {
  assert.equal(typeof audio.encodeWav, 'function');
  const pcm = Int16Array.of(-32768, 42, 32767);
  const wav = audio.encodeWav(pcm, 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.byteLength, 50);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeAudio(sampleRate = 48000) {
  const contexts = [];
  const worklets = [];
  class Node {
    constructor() { this.connected = []; this.disconnected = false; }
    connect(node) { this.connected.push(node); }
    disconnect() { this.disconnected = true; }
  }
  class Context {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = new Node();
      this.audioWorklet = { addModule: async (url) => { this.moduleURL = url; } };
      this.buffers = [];
      this.sources = [];
      contexts.push(this);
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource(stream) { this.mediaSource = new Node(); this.stream = stream; return this.mediaSource; }
    createGain() { this.gainNode = new Node(); this.gainNode.gain = { value: 1 }; return this.gainNode; }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = { duration: length / rate, length, sampleRate: rate,
        copyToChannel(values) { data.set(values); }, getChannelData() { return data; } };
      this.buffers.push(buffer);
      return buffer;
    }
    createBufferSource() {
      const source = new Node();
      source.start = (time) => { source.started = time; };
      source.stop = () => { source.stopped = true; };
      this.sources.push(source);
      return source;
    }
  }
  class Worklet extends Node {
    constructor(context, name) { super(); this.context = context; this.name = name; this.port = { onmessage: null, close() { this.closed = true; } }; worklets.push(this); }
    emit(samples) { this.port.onmessage?.({ data: samples }); }
  }
  return { Context, Worklet, contexts, worklets };
}

function fakeStream() {
  const track = { stopCount: 0, stop() { this.stopCount++; } };
  return { track, getTracks: () => [track] };
}

test('stopping while microphone permission is pending releases the late stream', async () => {
  assert.equal(typeof audio.createCapture, 'function');
  const permission = deferred();
  const fake = fakeAudio();
  const stops = [];
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: () => permission.promise },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet, workletURL: '/capture-worklet.mjs', onStop: (result) => stops.push(result) });
  const starting = capture.start();
  await Promise.resolve();
  await capture.stop();
  const stream = fakeStream();
  permission.resolve(stream);
  assert.equal(await starting, null);
  assert.equal(stream.track.stopCount, 1);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].pcm.length, 0);
  assert.ok(fake.contexts.every((context) => context.state === 'closed'));
  await capture.dispose();
});

test('capture uses the actual input rate and closes all resources on the 30 second limit', async () => {
  assert.equal(typeof audio.createCapture, 'function');
  const fake = fakeAudio(44100);
  const stream = fakeStream();
  let constraints;
  let timer;
  let delay;
  let cleared;
  const chunks = [];
  const stopped = [];
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async (value) => { constraints = value; return stream; } },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet, workletURL: '/capture-worklet.mjs',
    onPcm: (chunk) => chunks.push(chunk), onStop: (result) => stopped.push(result),
    setTimeout: (callback, ms) => { timer = callback; delay = ms; return 7; }, clearTimeout: (id) => { cleared = id; } });
  assert.deepEqual(await capture.start(), { sampleRate: 44100 });
  assert.equal(constraints.audio.echoCancellation, true);
  assert.equal(constraints.audio.noiseSuppression, true);
  assert.equal(delay, 30000);
  fake.worklets[0].emit(new Float32Array(44100));
  assert.equal(chunks[0].length, 16000);
  timer();
  await Promise.resolve();
  assert.equal(stopped[0].reason, 'limit');
  assert.equal(stopped[0].pcm.length, 16000);
  assert.equal(stopped[0].wav.length, 32044);
  assert.equal(stopped[0].sampleRate, 16000);
  assert.equal(stream.track.stopCount, 1);
  assert.equal(cleared, 7);
  assert.equal(fake.contexts[0].state, 'closed');
  assert.equal(fake.worklets[0].disconnected, true);
  assert.equal(fake.worklets[0].port.closed, true);
  await capture.stop();
  assert.equal(stopped.length, 1);
});

test('a failed microphone acquisition closes the context and remains restartable', async () => {
  assert.equal(typeof audio.createCapture, 'function');
  const fake = fakeAudio();
  const stream = fakeStream();
  let attempt = 0;
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => {
    if (++attempt === 1) throw new Error('denied');
    return stream;
  } }, AudioContext: fake.Context, AudioWorkletNode: fake.Worklet });
  await assert.rejects(capture.start(), /denied/);
  assert.equal(fake.contexts[0].state, 'closed');
  await capture.start();
  await capture.dispose();
  assert.equal(stream.track.stopCount, 1);
  await assert.rejects(capture.start(), /disposed/i);
});

test('a late limit callback from a stopped capture cannot stop the next capture', async () => {
  const fake = fakeAudio();
  const streams = [fakeStream(), fakeStream()];
  const timers = [];
  const stops = [];
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => streams.shift() },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet,
    setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout() {},
    onStop: (result) => stops.push(result) });
  await capture.start();
  await capture.stop();
  await capture.start();
  timers[0]();
  await Promise.resolve();
  assert.equal(stops.length, 1);
  assert.equal(fake.contexts[1].state, 'running');
  await capture.dispose();
});

test('cancelling during worklet loading cannot attach nodes or retain microphone tracks', async () => {
  const moduleLoad = deferred();
  const moduleStarted = deferred();
  const fake = fakeAudio();
  class Context extends fake.Context {
    constructor() {
      super();
      this.audioWorklet.addModule = () => { moduleStarted.resolve(); return moduleLoad.promise; };
    }
  }
  const stream = fakeStream();
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => stream },
    AudioContext: Context, AudioWorkletNode: fake.Worklet });
  const starting = capture.start();
  await moduleStarted.promise;
  await capture.dispose();
  moduleLoad.resolve();
  assert.equal(await starting, null);
  assert.equal(fake.worklets.length, 0);
  assert.equal(stream.track.stopCount, 1);
  assert.equal(fake.contexts[0].state, 'closed');
});

test('capture sample limit bounds a draft even when a timer has not fired', async () => {
  const fake = fakeAudio(16000);
  const stream = fakeStream();
  const stopped = [];
  const chunks = [];
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => stream },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet, maxMs: 100,
    setTimeout: () => 1, clearTimeout() {}, onPcm: (chunk) => chunks.push(chunk), onStop: (result) => stopped.push(result) });
  await capture.start();
  const lateMessage = fake.worklets[0].port.onmessage;
  fake.worklets[0].emit(new Float32Array(8000));
  lateMessage({ data: new Float32Array(8000) });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 1600);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].pcm.length, 1600);
  assert.equal(stopped[0].reason, 'limit');
  await capture.dispose();
});

test('explicit long capture retains audio beyond 30 seconds until a manual stop', async () => {
  const fake = fakeAudio(16000);
  const stream = fakeStream();
  let delay;
  const stopped = [];
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => stream },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet, maxMs: 120000,
    setTimeout: (callback, ms) => { delay = ms; return 1; }, clearTimeout() {}, onStop: (result) => stopped.push(result) });
  await capture.start();
  assert.equal(delay, 120000);
  fake.worklets[0].emit(new Float32Array(31 * 16000));
  assert.equal(stopped.length, 0);
  assert.equal(stream.track.stopCount, 0);
  const result = await capture.stop();
  assert.equal(result.reason, 'manual');
  assert.equal(result.sampleRate, 16000);
  assert.equal(result.pcm.length, 31 * 16000);
  assert.equal(new DataView(result.wav.buffer).getUint32(40, true), 31 * 16000 * 2);
  assert.equal(stream.track.stopCount, 1);
  assert.equal(stopped.length, 1);
  await capture.stop();
  await capture.dispose();
  assert.equal(stream.track.stopCount, 1);
});

test('capture caps an explicit duration at five minutes', async () => {
  const fake = fakeAudio(16000);
  const stream = fakeStream();
  let delay;
  const capture = audio.createCapture({ mediaDevices: { getUserMedia: async () => stream },
    AudioContext: fake.Context, AudioWorkletNode: fake.Worklet, maxMs: 600000,
    setTimeout: (callback, ms) => { delay = ms; return 1; }, clearTimeout() {} });
  await capture.start();
  assert.equal(delay, 300000);
  await capture.dispose();
  assert.equal(stream.track.stopCount, 1);
});

test('playback schedules 24 kHz PCM and rejects late response IDs or excess queued audio', async () => {
  assert.equal(typeof audio.createPlayback, 'function');
  const fake = fakeAudio();
  const playback = audio.createPlayback({ AudioContext: fake.Context, maxQueuedSeconds: 2 });
  await playback.unlock();
  playback.activate('one');
  const encoded = audio.pcmToBase64(new Int16Array(24000).fill(16384));
  assert.equal(playback.enqueue(encoded, 'one'), true);
  assert.equal(playback.enqueue(encoded, 'one'), true);
  assert.equal(playback.enqueue(encoded, 'one'), false);
  const context = fake.contexts[0];
  assert.equal(context.buffers[0].sampleRate, 24000);
  assert.equal(context.buffers[0].getChannelData(0)[0], 0.5);
  assert.deepEqual(context.sources.map((source) => source.started), [0, 1]);
  playback.activate('two');
  assert.ok(context.sources.every((source) => source.stopped));
  assert.equal(playback.enqueue(encoded, 'one'), false);
  assert.equal(playback.enqueue(encoded, 'two'), true);
  playback.stop();
  assert.equal(playback.enqueue(encoded, 'two'), false);
  await playback.dispose();
  assert.equal(context.state, 'closed');
  assert.equal(await playback.unlock(), false);
});

test('playback reports scheduled audio until the final source ends or is stopped', async () => {
  const fake = fakeAudio();
  const changes = [];
  const playback = audio.createPlayback({ AudioContext: fake.Context, onStateChange: (playing) => changes.push(playing) });
  assert.equal(playback.playing, false);
  await playback.unlock();
  playback.activate('one');
  assert.equal(playback.enqueue(audio.pcmToBase64(new Int16Array(120000)), 'one'), true);
  assert.equal(playback.playing, true);
  assert.equal(changes.at(-1), true);
  const context = fake.contexts[0];
  context.sources[0].onended();
  assert.equal(playback.playing, false);
  assert.equal(changes.at(-1), false);
  assert.equal(playback.enqueue(audio.pcmToBase64(new Int16Array(24000)), 'one'), true);
  assert.equal(playback.playing, true);
  playback.stop();
  assert.equal(playback.playing, false);
  assert.equal(changes.at(-1), false);
  assert.equal(playback.enqueue('', 'one'), false);
  await playback.dispose();
  assert.equal(changes.at(-1), false);
});

test('playback progress follows the configured sample rate across queued sources and returns isolated snapshots', async () => {
  const fake = fakeAudio();
  const playback = audio.createPlayback({ AudioContext: fake.Context, sampleRate: 16000, maxQueuedSeconds: 2 });
  await playback.unlock();
  playback.activate('reply');
  const encoded = audio.pcmToBase64(new Int16Array(16000));
  assert.equal(playback.enqueue(encoded, 'reply'), true);
  assert.equal(playback.enqueue(encoded, 'reply'), true);
  assert.equal(playback.enqueue(encoded, 'reply'), false);
  const context = fake.contexts[0];
  assert.deepEqual(context.buffers.map((buffer) => buffer.sampleRate), [16000, 16000]);
  assert.deepEqual(context.sources.map((source) => source.started), [0, 1]);
  context.currentTime = 0.25;
  const snapshot = playback.progress();
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.deepEqual(snapshot, { responseId: 'reply', sampleRate: 16000, receivedSamples: 32000, playedSamples: 4000, audioEndMs: 250 });
  snapshot.responseId = 'changed';
  snapshot.sampleRate = 1;
  snapshot.receivedSamples = -1;
  snapshot.playedSamples = -1;
  snapshot.audioEndMs = -1;
  assert.deepEqual(playback.progress(), { responseId: 'reply', sampleRate: 16000, receivedSamples: 32000, playedSamples: 4000, audioEndMs: 250 });
  context.currentTime = 1.25;
  assert.deepEqual(playback.progress(), { responseId: 'reply', sampleRate: 16000, receivedSamples: 32000, playedSamples: 20000, audioEndMs: 1250 });
  await playback.dispose();
});

test('playback progress excludes silent gaps and counts natural completion only once', async () => {
  const fake = fakeAudio();
  const playback = audio.createPlayback({ AudioContext: fake.Context });
  await playback.unlock();
  playback.activate('reply');
  assert.equal(playback.enqueue(audio.pcmToBase64(new Int16Array(24000)), 'reply'), true);
  const context = fake.contexts[0];
  context.currentTime = 1.5;
  const ended = context.sources[0].onended;
  ended();
  ended();
  assert.deepEqual(playback.progress(), { responseId: 'reply', sampleRate: 24000, receivedSamples: 24000, playedSamples: 24000, audioEndMs: 1000 });
  assert.equal(playback.enqueue(audio.pcmToBase64(new Int16Array(12000)), 'reply'), true);
  assert.equal(context.sources[1].started, 1.5);
  context.currentTime = 1.75;
  assert.deepEqual(playback.progress(), { responseId: 'reply', sampleRate: 24000, receivedSamples: 36000, playedSamples: 30000, audioEndMs: 1250 });
  await playback.dispose();
});

test('stopping playback returns prior progress and stale source callbacks cannot change a new response', async () => {
  const fake = fakeAudio();
  const changes = [];
  const playback = audio.createPlayback({ AudioContext: fake.Context, onStateChange: (playing) => changes.push(playing) });
  await playback.unlock();
  playback.activate('old');
  const encoded = audio.pcmToBase64(new Int16Array(24000));
  assert.equal(playback.enqueue(encoded, 'old'), true);
  assert.equal(playback.enqueue(encoded, 'old'), true);
  const context = fake.contexts[0];
  const ended = context.sources.map((source) => source.onended);
  context.currentTime = 0.5;
  assert.deepEqual(playback.stop(), { responseId: 'old', sampleRate: 24000, receivedSamples: 48000, playedSamples: 12000, audioEndMs: 500 });
  assert.ok(context.sources.every((source) => source.stopped));
  assert.deepEqual(playback.progress(), { responseId: null, sampleRate: 24000, receivedSamples: 0, playedSamples: 0, audioEndMs: 0 });
  playback.activate('new');
  assert.equal(playback.enqueue(encoded, 'new'), true);
  const changesBeforeLateCallbacks = changes.length;
  ended.forEach((callback) => { callback(); callback(); });
  assert.deepEqual(playback.progress(), { responseId: 'new', sampleRate: 24000, receivedSamples: 24000, playedSamples: 0, audioEndMs: 0 });
  assert.equal(playback.playing, true);
  assert.equal(changes.length, changesBeforeLateCallbacks);
  await playback.dispose();
});

test('playback validates sample rates and preserves progress only for the same active response', async () => {
  const fake = fakeAudio();
  for (const sampleRate of [0, 7999, 48001, 16000.5, NaN]) {
    assert.throws(() => audio.createPlayback({ AudioContext: fake.Context, sampleRate }), RangeError);
  }
  const playback = audio.createPlayback({ AudioContext: fake.Context });
  const zero = { responseId: null, sampleRate: 24000, receivedSamples: 0, playedSamples: 0, audioEndMs: 0 };
  assert.deepEqual(playback.progress(), zero);
  playback.activate('reply');
  const encoded = audio.pcmToBase64(new Int16Array(24000));
  assert.equal(playback.enqueue(encoded, 'reply'), false);
  assert.deepEqual(playback.progress(), { ...zero, responseId: 'reply' });
  await playback.unlock();
  assert.equal(playback.enqueue(encoded, 'reply'), true);
  const context = fake.contexts[0];
  context.currentTime = 0.25;
  const beforeSameId = playback.progress();
  playback.activate('reply');
  assert.deepEqual(playback.progress(), beforeSameId);
  assert.equal(context.sources[0].stopped, undefined);
  const ended = context.sources[0].onended;
  playback.activate('other');
  assert.deepEqual(playback.progress(), { ...zero, responseId: 'other' });
  ended();
  assert.deepEqual(playback.progress(), { ...zero, responseId: 'other' });
  assert.equal(context.sources[0].stopped, true);
  await playback.dispose();
});

test('capture worklet averages channels into a transferable mono block and outputs silence', async () => {
  let source = '';
  try { source = await readFile(new URL('../public/capture-worklet.mjs', import.meta.url), 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let Processor;
  const messages = [];
  vm.runInNewContext(source, { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (...args) => messages.push(args) }; } },
    registerProcessor: (name, Type) => { assert.equal(name, 'pcm-capture'); Processor = Type; }, Float32Array });
  assert.equal(typeof Processor, 'function');
  const worklet = new Processor();
  const output = Float32Array.of(1, 1);
  assert.equal(worklet.process([[Float32Array.of(1, 0), Float32Array.of(-1, 1)]], [[output]]), true);
  assert.deepEqual([...messages[0][0]], [0, 0.5]);
  assert.equal(messages[0][1][0], messages[0][0].buffer);
  assert.deepEqual([...output], [0, 0]);
});
