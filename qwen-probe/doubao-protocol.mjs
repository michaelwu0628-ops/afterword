import { gunzipSync } from 'node:zlib';
import { types } from 'node:util';

export const DOUBAO_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 256;
const MAX_AUDIO_BYTES = 64000;
const MAX_JSON_DEPTH = 64;
// Header, code, sequence, event, ID length, ID bytes, payload length.
const MAX_FRAME_BYTES = MAX_PAYLOAD_BYTES + 4 + 4 + 4 + 4 + 4 + MAX_ID_BYTES + 4;
const CLIENT_EVENTS = new Set([1, 2, 100, 102, 201, 300, 400, 500, 501, 502, 510, 511, 512, 513, 514, 515]);
const CONNECTION_EVENTS = new Set([50, 51, 52]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const ID_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function binaryBytes(value, limit, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Buffer or Uint8Array`);
  if (value.byteLength > limit) throw new RangeError(`${label} is too large`);
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function sessionBytes(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId must be a nonempty string');
  const byteLength = Buffer.byteLength(sessionId, 'utf8');
  if (byteLength > MAX_ID_BYTES) throw new RangeError('sessionId exceeds 256 UTF-8 bytes');
  return Buffer.from(sessionId, 'utf8');
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Serialize directly into a bounded buffer; never expand a shared object graph
// into a cloned tree. The root counts as container depth 1 (maximum 64).
// Only enumerable own data properties and dense array indices are accepted;
// accessors, proxies, toJSON hooks and silently omitted properties are rejected.
function jsonBytes(root) {
  let output = Buffer.allocUnsafe(1024);
  let offset = 0;
  const ancestors = new Set();
  function checkBudget(length) {
    if (length > MAX_PAYLOAD_BYTES - offset) throw new RangeError('payload exceeds one MiB');
  }
  function append(text, length = Buffer.byteLength(text, 'utf8')) {
    checkBudget(length);
    if (offset + length > output.length) {
      const larger = Buffer.allocUnsafe(Math.min(MAX_PAYLOAD_BYTES, Math.max(offset + length, output.length * 2)));
      output.copy(larger, 0, 0, offset);
      output = larger;
    }
    offset += output.write(text, offset, length, 'utf8');
  }
  function appendString(value) {
    let length = 2; // JSON string quotes.
    checkBudget(length);
    for (let index = 0; index < value.length; index++) {
      const character = value.charCodeAt(index);
      if (character === 0x22 || character === 0x5c || character === 8 || character === 9 ||
          character === 10 || character === 12 || character === 13) length += 2;
      else if (character < 0x20) length += 6;
      else if (character < 0x80) length++;
      else if (character < 0x800) length += 2;
      else if (character >= 0xd800 && character <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          length += 4;
          index++;
        } else length += 6; // JSON escapes an unpaired surrogate.
      } else if (character >= 0xdc00 && character <= 0xdfff) length += 6;
      else length += 3;
      checkBudget(length);
    }
    // This stringify handles only a primitive string, after its escaped UTF-8
    // size is bounded. It cannot invoke an object's toJSON or a getter.
    append(JSON.stringify(value), length);
  }
  function dataProperty(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('payload must contain enumerable data properties');
    }
    return descriptor.value;
  }
  function writeValue(value, depth) {
    if (value === null) return append('null');
    if (typeof value === 'string') return appendString(value);
    if (typeof value === 'boolean') return append(value ? 'true' : 'false');
    if (typeof value === 'number' && Number.isFinite(value)) return append(String(Object.is(value, -0) ? 0 : value));
    if (typeof value !== 'object' || types.isProxy(value) || (!Array.isArray(value) && !plainObject(value))) {
      throw new TypeError('payload contains a non-JSON value');
    }
    if (depth > MAX_JSON_DEPTH) throw new RangeError('payload exceeds maximum JSON depth of 64');
    if (ancestors.has(value)) throw new TypeError('payload contains a cycle');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('payload contains symbol keys');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        // Even the shortest dense array needs one byte per item and separators.
        checkBudget(value.length === 0 ? 2 : value.length * 2 + 1);
        const keys = Object.getOwnPropertyNames(value);
        if (keys.length !== value.length + 1) throw new TypeError('payload contains sparse or extra array properties');
        append('[');
        for (let index = 0; index < value.length; index++) {
          if (index) append(',');
          writeValue(dataProperty(value, String(index)), depth + 1);
        }
        append(']');
        return;
      }
      append('{');
      let first = true;
      for (const key of Object.getOwnPropertyNames(value)) {
        const item = dataProperty(value, key);
        if (!first) append(',');
        first = false;
        appendString(key);
        append(':');
        writeValue(item, depth + 1);
      }
      append('}');
    } finally {
      ancestors.delete(value);
    }
  }
  writeValue(root, 1);
  return output.subarray(0, offset);
}

function encodeClientFrame(event, payload, sessionId, serialization) {
  const id = event === 1 || event === 2 ? null : sessionBytes(sessionId);
  const frame = Buffer.alloc(4 + 4 + (id ? 4 + id.length : 0) + 4 + payload.length);
  frame.set([0x11, serialization === 1 ? 0x14 : 0x24, serialization << 4, 0]);
  frame.writeInt32BE(event, 4);
  let offset = 8;
  if (id) {
    frame.writeUInt32BE(id.length, offset);
    offset += 4;
    id.copy(frame, offset);
    offset += id.length;
  }
  frame.writeUInt32BE(payload.length, offset);
  payload.copy(frame, offset + 4);
  return frame;
}

export function encodeDoubaoEvent(event, payload = {}, sessionId = '') {
  if (!CLIENT_EVENTS.has(event)) throw new TypeError('unsupported client event');
  if ((event === 1 || event === 2) && sessionId !== '') throw new TypeError('connection events must not include sessionId');
  if (!plainObject(payload)) throw new TypeError('payload must be a plain JSON object');
  return encodeClientFrame(event, jsonBytes(payload), sessionId, 1);
}

export function encodeDoubaoAudio(pcmBytes, sessionId) {
  const pcm = binaryBytes(pcmBytes, MAX_AUDIO_BYTES, 'PCM');
  if (pcm.length === 0 || pcm.length % 2 !== 0) throw new RangeError('PCM must contain complete 16-bit samples');
  return encodeClientFrame(200, pcm, sessionId, 0);
}

export function decodeDoubaoFrame(frame) {
  const bytes = binaryBytes(frame, MAX_FRAME_BYTES, 'frame');
  let offset = 0;
  function requireBytes(length) {
    if (length > bytes.length - offset) throw new RangeError('truncated Doubao frame');
  }
  function readInt(signed = false) {
    requireBytes(4);
    const value = signed ? bytes.readInt32BE(offset) : bytes.readUInt32BE(offset);
    offset += 4;
    return value;
  }
  function readBytes(length) {
    requireBytes(length);
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }

  requireBytes(4);
  if (bytes[0] !== 0x11 || bytes[3] !== 0) throw new TypeError('unsupported Doubao header');
  const type = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;
  if (![9, 11, 15].includes(type) || flags > 7 || serialization > 1 || compression > 1) {
    throw new TypeError('unsupported Doubao frame format');
  }
  offset = 4;
  const code = type === 15 ? readInt() : null;
  const sequence = flags & 1 ? readInt(true) : null;
  const event = flags & 4 ? readInt(true) : null;
  let sessionId = '';
  let connectId = '';
  if (event !== null && event !== 1 && event !== 2) {
    const idLength = readInt();
    if (idLength > MAX_ID_BYTES) throw new RangeError('ID exceeds 256 UTF-8 bytes');
    const id = ID_UTF8.decode(readBytes(idLength));
    if (CONNECTION_EVENTS.has(event)) connectId = id;
    else sessionId = id;
  }
  const payloadLength = readInt();
  if (payloadLength > MAX_PAYLOAD_BYTES) throw new RangeError('payload exceeds one MiB');
  let payloadBytes = readBytes(payloadLength);
  if (offset !== bytes.length) throw new TypeError('trailing bytes in Doubao frame');
  if (compression === 1) payloadBytes = gunzipSync(payloadBytes, { maxOutputLength: MAX_PAYLOAD_BYTES });
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new RangeError('decompressed payload exceeds one MiB');
  const payload = serialization === 1 ? JSON.parse(UTF8.decode(payloadBytes)) : Buffer.from(payloadBytes);
  return { type, flags, serialization, compression, event, sequence, code, sessionId, connectId, payload };
}
