import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const api = await import('../doubao-protocol.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const LIMIT = 1024 * 1024;
const CLIENT_EVENTS = [1, 2, 100, 102, 201, 300, 400, 500, 501, 502, 510, 511, 512, 513, 514, 515];

function exported(name) {
  assert.equal(typeof api[name], 'function', `${name} must be exported`);
  return api[name];
}

function i32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function serverFrame({ type = 9, flags = 4, serialization = 1, compression = 0,
  code = 0, sequence = 0, event = 150, id = 'session', payload = Buffer.from('{}') } = {}) {
  const fields = [Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | compression, 0])];
  if (type === 15) fields.push(u32(code));
  if (flags & 1) fields.push(i32(sequence));
  if (flags & 4) {
    fields.push(i32(event));
    if (event !== 1 && event !== 2) {
      const idBytes = Buffer.from(id);
      fields.push(u32(idBytes.length), idBytes);
    }
  }
  fields.push(u32(payload.length), payload);
  return Buffer.concat(fields);
}

function expected(overrides = {}) {
  return { type: 9, flags: 4, serialization: 1, compression: 0,
    event: 150, sequence: null, code: null, sessionId: 'session', connectId: '', payload: {}, ...overrides };
}

test('exports the pinned endpoint and codec functions', () => {
  assert.equal(api.DOUBAO_ENDPOINT, 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue');
  for (const name of ['encodeDoubaoEvent', 'encodeDoubaoAudio', 'decodeDoubaoFrame']) exported(name);
});

test('StartConnection matches the official golden bytes', () => {
  assert.equal(exported('encodeDoubaoEvent')(1).toString('hex'), '1114100000000001000000027b7d');
});

test('all allowed client events use JSON and the correct connection/session envelope', () => {
  const encode = exported('encodeDoubaoEvent');
  for (const event of CLIENT_EVENTS) {
    const frame = encode(event, { text: '你好' }, event <= 2 ? '' : '会话-一');
    assert.ok(Buffer.isBuffer(frame));
    assert.deepEqual(frame.subarray(0, 4), Buffer.from([0x11, 0x14, 0x10, 0]));
    assert.equal(frame.readInt32BE(4), event);
    const idLength = Buffer.byteLength('会话-一');
    const offset = event <= 2 ? 8 : 12 + idLength;
    if (event > 2) {
      assert.equal(frame.readUInt32BE(8), idLength);
      assert.equal(frame.subarray(12, offset).toString('utf8'), '会话-一');
    }
    assert.equal(frame.readUInt32BE(offset), frame.length - offset - 4);
    assert.deepEqual(JSON.parse(frame.subarray(offset + 4)), { text: '你好' });
  }
});

test('client IDs are bounded by UTF-8 byte length and connection IDs are forbidden', () => {
  const encode = exported('encodeDoubaoEvent');
  for (const event of [1, 2]) for (const id of ['session', null, 0, {}]) assert.throws(() => encode(event, {}, id));
  for (const id of ['', null, 0, undefined, {}, '中'.repeat(86), 'a'.repeat(257)]) {
    assert.throws(() => encode(100, {}, id));
  }
  assert.doesNotThrow(() => encode(100, {}, '中'.repeat(85)));
  assert.doesNotThrow(() => encode(100, {}, 'a'.repeat(256)));
});

test('client event encoder rejects unknown, audio, fractional and nonnumeric events', () => {
  const encode = exported('encodeDoubaoEvent');
  for (const event of [0, 3, 99, 101, 200, 570, -1, 1.5, '1', NaN, Infinity, null, undefined]) {
    assert.throws(() => encode(event, {}, 'session'));
  }
});

test('client payload accepts ordinary nested JSON without changing input', () => {
  const encode = exported('encodeDoubaoEvent');
  const payload = { text: '中文', values: [null, true, false, 1.5, { value: 'ok' }] };
  const snapshot = structuredClone(payload);
  encode(100, payload, 's');
  assert.deepEqual(payload, snapshot);
  assert.doesNotThrow(() => encode(100, Object.assign(Object.create(null), { a: 1 }), 's'));
});

test('client payload rejects lossy values, cycles and non-JSON objects', () => {
  const encode = exported('encodeDoubaoEvent');
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 1;
  const invalid = [null, [], 'text', 1, true, new Date(), new Map(), Buffer.from('x'),
    { x: NaN }, { x: Infinity }, { x: -Infinity }, { x: undefined }, { x: { y: undefined } },
    { x: [undefined] }, { x: sparse }, { x: 1n }, { x: Symbol('x') }, { x() {} },
    { x: new Date() }, { x: new Set() }, { toJSON() { return {}; } }, cycle];
  for (const payload of invalid) assert.throws(() => encode(100, payload, 's'));
});

test('client payload does not hide undefined in nonenumerable or extra array properties', () => {
  const encode = exported('encodeDoubaoEvent');
  const hidden = Object.defineProperty({}, 'value', { value: undefined });
  const array = [1];
  array.note = undefined;
  assert.throws(() => encode(100, { nested: hidden }, 's'));
  assert.throws(() => encode(100, { nested: array }, 's'));
});

test('client JSON payload size is limited to one MiB after UTF-8 encoding', () => {
  const encode = exported('encodeDoubaoEvent');
  assert.doesNotThrow(() => encode(100, { x: 'a'.repeat(LIMIT - 8) }, 's'));
  assert.throws(() => encode(100, { x: 'a'.repeat(LIMIT - 7) }, 's'));
  assert.throws(() => encode(100, { x: '中'.repeat(Math.ceil(LIMIT / 3)) }, 's'));
});

test('bounded JSON serialization rejects excessive depth before expanding shared DAGs', () => {
  const encode = exported('encodeDoubaoEvent');
  let deepestAllowed = {};
  for (let depth = 1; depth < 64; depth++) deepestAllowed = { next: deepestAllowed };
  assert.doesNotThrow(() => encode(100, deepestAllowed, 's'));
  // Verify the depth guard first: pre-fix RED exits here without expanding a DAG.
  assert.throws(() => encode(100, { next: deepestAllowed }, 's'), { name: 'RangeError', message: /depth/i });
  let deepChain = {};
  for (let depth = 1; depth < 3000; depth++) deepChain = { next: deepChain };
  assert.throws(() => encode(100, deepChain, 's'), { name: 'RangeError', message: /maximum JSON depth/i });
  let shared = { value: 0 };
  for (let depth = 0; depth < 30; depth++) shared = { left: shared, right: shared };
  assert.throws(() => encode(100, shared, 's'), { name: 'RangeError', message: /one MiB/i });
});

test('bounded JSON serialization preserves small shared references and exact escaped UTF-8 sizes', () => {
  const encode = exported('encodeDoubaoEvent');
  const shared = { value: '共享' };
  const payload = { left: shared, right: shared, '\"\\\n中': '\ud800😀\b\f\r\t' };
  assert.deepEqual(encode(100, payload, 's').subarray(17), Buffer.from(JSON.stringify(payload)));
  const key = '\u0000';
  const overhead = Buffer.byteLength(JSON.stringify({ [key]: '' }));
  const remaining = LIMIT - overhead;
  const exact = '\u0000'.repeat(Math.floor(remaining / 6)) + 'a'.repeat(remaining % 6);
  assert.equal(encode(100, { [key]: exact }, 's').readUInt32BE(13), LIMIT);
  assert.throws(() => encode(100, { [key]: exact + 'a' }, 's'), RangeError);
});

test('bounded JSON serialization rejects accessors and toJSON without executing user code', () => {
  const encode = exported('encodeDoubaoEvent');
  let calls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
  const array = Object.defineProperty([], '0', { enumerable: true, get() { calls++; return 1; } });
  const toJSON = { toJSON() { calls++; return {}; } };
  for (const payload of [getter, { nested: getter }, { array }, toJSON]) assert.throws(() => encode(100, payload, 's'), TypeError);
  assert.equal(calls, 0);
});

test('audio event 200 preserves little-endian PCM bytes and uses a raw payload', () => {
  const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f]);
  const original = Buffer.from(pcm);
  const frame = exported('encodeDoubaoAudio')(pcm, '音频');
  assert.deepEqual(frame.subarray(0, 4), Buffer.from([0x11, 0x24, 0, 0]));
  assert.equal(frame.readInt32BE(4), 200);
  assert.equal(frame.readUInt32BE(8), 6);
  assert.equal(frame.subarray(12, 18).toString(), '音频');
  assert.equal(frame.readUInt32BE(18), 4);
  assert.deepEqual(frame.subarray(22), pcm);
  frame[22] ^= 0xff;
  assert.deepEqual(pcm, original);
});

test('audio accepts Uint8Array views and the 64000-byte boundary', () => {
  const encode = exported('encodeDoubaoAudio');
  const source = Uint8Array.from([9, 1, 2, 8]);
  assert.deepEqual(encode(source.subarray(1, 3), 's').subarray(-2), Buffer.from([1, 2]));
  assert.equal(encode(Buffer.alloc(64000), 's').readUInt32BE(13), 64000);
});

test('audio rejects empty, odd, oversized, nonbinary data and invalid session IDs', () => {
  const encode = exported('encodeDoubaoAudio');
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(64002), [], 'ab', new ArrayBuffer(2), new DataView(new ArrayBuffer(2))]) {
    assert.throws(() => encode(pcm, 's'));
  }
  for (const id of ['', undefined, null, 1, '中'.repeat(86)]) assert.throws(() => encode(Buffer.alloc(2), id));
});

test('server connection events 50, 51 and 52 populate only connectId', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const event of [50, 51, 52]) {
    assert.deepEqual(decode(serverFrame({ event, id: '连接-一' })),
      expected({ event, sessionId: '', connectId: '连接-一' }));
  }
});

test('decoder preserves a leading UTF-8 BOM in session and connection IDs', () => {
  const decode = exported('decodeDoubaoFrame');
  assert.deepEqual(decode(serverFrame({ id: '\uFEFFs' })), expected({ sessionId: '\uFEFFs' }));
  assert.deepEqual(decode(serverFrame({ event: 50, id: '\uFEFFc' })),
    expected({ event: 50, sessionId: '', connectId: '\uFEFFc' }));
});

test('server session events include 570 with an extensible JSON payload', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const event of [150, 350, 451, 570]) {
    assert.deepEqual(decode(serverFrame({ event })), expected({ event }));
  }
  const payload = { future_field: { accepted: true } };
  assert.deepEqual(decode(serverFrame({ event: 570, payload: Buffer.from(JSON.stringify(payload)) })),
    expected({ event: 570, payload }));
});

test('server connection control events 1 and 2 carry no ID field', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const event of [1, 2]) assert.deepEqual(decode(serverFrame({ event })), expected({ event, sessionId: '' }));
});

test('raw type B audio returns an independent Buffer and leaves frame unchanged', () => {
  const pcm = Buffer.from([0, 128, 255, 127]);
  const frame = serverFrame({ type: 11, serialization: 0, event: 352, payload: pcm });
  const snapshot = Buffer.from(frame);
  const decoded = exported('decodeDoubaoFrame')(frame);
  assert.deepEqual(decoded, expected({ type: 11, serialization: 0, event: 352, payload: pcm }));
  assert.ok(Buffer.isBuffer(decoded.payload));
  assert.deepEqual(frame, snapshot);
  decoded.payload[0] = 9;
  assert.deepEqual(frame, snapshot);
  frame[frame.length - 1] = 1;
  assert.equal(decoded.payload[3], 127);
});

test('flags 5 and 7 read signed sequences before events; flag 6 has no sequence', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const [flags, sequence] of [[5, 123], [7, -123], [6, 0]]) {
    assert.deepEqual(decode(serverFrame({ flags, sequence })), expected({ flags, sequence: flags === 6 ? null : sequence }));
  }
});

test('flags 0, 1, 2 and 3 accept no-event frames without IDs', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const flags of [0, 1, 2, 3]) {
    assert.deepEqual(decode(serverFrame({ type: 11, flags, sequence: -2147483648, serialization: 0, payload: Buffer.from([1, 2]) })),
      expected({ type: 11, flags, serialization: 0, event: null, sequence: flags & 1 ? -2147483648 : null,
        sessionId: '', payload: Buffer.from([1, 2]) }));
  }
});

test('native type F error reads unsigned code without inventing event or session fields', () => {
  const frame = Buffer.from('11f01000ffffffff000000107b226572726f72223a226661696c227d', 'hex');
  assert.deepEqual(exported('decodeDoubaoFrame')(frame), expected({ type: 15, flags: 0,
    event: null, sessionId: '', code: 4294967295, payload: { error: 'fail' } }));
});

test('type F compatibility envelopes read code before sequence, event and ID', () => {
  const decode = exported('decodeDoubaoFrame');
  assert.deepEqual(decode(serverFrame({ type: 15, code: 500, event: 153 })),
    expected({ type: 15, code: 500, event: 153 }));
  assert.deepEqual(decode(serverFrame({ type: 15, flags: 5, sequence: -10, code: 500, event: 51, id: 'connection' })),
    expected({ type: 15, flags: 5, sequence: -10, code: 500, event: 51, sessionId: '', connectId: 'connection' }));
});

test('type F golden bytes pin code, signed sequence, event and session ID order', () => {
  const frame = Buffer.from('11f5100001020304fffffffe0000009900000003732d310000000b7b226f6b223a747275657d', 'hex');
  assert.deepEqual(exported('decodeDoubaoFrame')(frame), expected({ type: 15, flags: 5,
    code: 16909060, sequence: -2, event: 153, sessionId: 's-1', payload: { ok: true } }));
});

test('gzip JSON and raw payloads decode with their declared serialization', () => {
  const decode = exported('decodeDoubaoFrame');
  const object = { message: '你好' };
  assert.deepEqual(decode(serverFrame({ compression: 1, payload: gzipSync(Buffer.from(JSON.stringify(object))) })),
    expected({ compression: 1, payload: object }));
  const raw = Buffer.from([0, 255, 1, 2]);
  assert.deepEqual(decode(serverFrame({ type: 11, serialization: 0, compression: 1, payload: gzipSync(raw) })).payload, raw);
});

test('gzip bombs and corrupt gzip are rejected', () => {
  const decode = exported('decodeDoubaoFrame');
  assert.throws(() => decode(serverFrame({ serialization: 0, compression: 1, payload: gzipSync(Buffer.alloc(LIMIT + 1)) })));
  assert.throws(() => decode(serverFrame({ compression: 1, payload: Buffer.from('not gzip') })));
});

test('a raw payload of exactly one MiB is accepted', () => {
  const payload = Buffer.alloc(LIMIT, 7);
  const frame = serverFrame({ type: 11, serialization: 0, payload, id: 'a'.repeat(256) });
  assert.deepEqual(exported('decodeDoubaoFrame')(frame).payload, payload);
});

test('decoder accepts a Uint8Array view without modifying its backing bytes', () => {
  const original = serverFrame();
  const array = Uint8Array.from(Buffer.concat([Buffer.from([99]), original, Buffer.from([88])]));
  const snapshot = Uint8Array.from(array);
  assert.deepEqual(exported('decodeDoubaoFrame')(array.subarray(1, -1)), expected());
  assert.deepEqual(array, snapshot);
});

test('decoder rejects every truncation of connection, sequence and native-error frames', () => {
  const decode = exported('decodeDoubaoFrame');
  const frames = [serverFrame({ event: 50 }), serverFrame({ flags: 7, sequence: -1 }),
    serverFrame({ type: 15, flags: 0, code: 500 }), serverFrame({ type: 15, flags: 5, code: 500 })];
  for (const frame of frames) for (let length = 0; length < frame.length; length++) {
    assert.throws(() => decode(frame.subarray(0, length)), `truncation at ${length} of ${frame.length}`);
  }
});

test('decoder rejects invalid header version, size, type, flags, serializer, compression and reserved byte', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const [index, value] of [[0, 0x21], [0, 0x10], [0, 0x12], [1, 0x14], [1, 0xa4],
    [1, 0x98], [1, 0x9f], [2, 0x20], [2, 0x02], [2, 0x12], [3, 1]]) {
    const frame = serverFrame();
    frame[index] = value;
    assert.throws(() => decode(frame));
  }
});

test('decoder rejects nonbinary input and frames above the maximum bounded envelope', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const frame of [null, undefined, [], 'bytes', new ArrayBuffer(8), new DataView(new ArrayBuffer(8)), Buffer.alloc(LIMIT + 281)]) {
    assert.throws(() => decode(frame));
  }
});

test('decoder rejects oversized declared IDs and payloads before reading their bytes', () => {
  const decode = exported('decodeDoubaoFrame');
  for (const length of [257, 4294967295]) {
    assert.throws(() => decode(Buffer.concat([Buffer.from([0x11, 0x94, 0x10, 0]), i32(150), u32(length)])));
  }
  for (const length of [LIMIT + 1, 4294967295]) {
    assert.throws(() => decode(Buffer.concat([Buffer.from([0x11, 0x90, 0x00, 0]), u32(length)])));
  }
  assert.throws(() => decode(serverFrame({ id: '中'.repeat(86) })));
  assert.throws(() => decode(serverFrame({ serialization: 0, payload: Buffer.alloc(LIMIT + 1) })));
  assert.throws(() => decode(serverFrame({ compression: 1, serialization: 0, payload: Buffer.alloc(LIMIT + 1) })));
});

test('decoder rejects invalid UTF-8 IDs, invalid UTF-8 JSON and malformed JSON', () => {
  const decode = exported('decodeDoubaoFrame');
  const invalidId = serverFrame({ id: 'a' });
  invalidId[12] = 0xff;
  assert.throws(() => decode(invalidId));
  for (const payload of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('undefined'), Buffer.from('')]) {
    assert.throws(() => decode(serverFrame({ payload })));
  }
  assert.throws(() => decode(serverFrame({ compression: 1, payload: gzipSync(Buffer.from([0xff])) })));
});

test('decoder rejects trailing bytes and a payload length that exceeds the remaining frame', () => {
  const decode = exported('decodeDoubaoFrame');
  assert.throws(() => decode(Buffer.concat([serverFrame(), Buffer.from([0])])));
  const wrongLength = serverFrame({ flags: 0 });
  wrongLength.writeUInt32BE(3, 4);
  assert.throws(() => decode(wrongLength));
});
