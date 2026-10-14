import { sanitizePracticeData } from './mvp-store.mjs';

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MEDIA_TYPE = /^(?:audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[ -~]*)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();
const isBlob = value => typeof Blob !== 'undefined' && value instanceof Blob;
const invalid = detail => { throw new TypeError(`Invalid backup: ${detail}`); };
const jsonLimit = () => { throw new RangeError('Backup JSON exceeds maximum 100 MiB'); };
const mediaLimit = () => { throw new RangeError('Backup media exceeds maximum 64 MiB'); };

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  for (const key of ['__proto__', 'prototype', 'constructor']) if (Object.hasOwn(value, key)) invalid('unsafe prototype key');
  return value;
}
function string(value, maximum, label, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) invalid(`${label} must be valid text`);
  return value;
}
function sanitizeTopics(value) {
  if (!Array.isArray(value)) invalid('topics must be an array');
  if (value.length > 100) throw new RangeError('Backup topics exceeds maximum 100');
  return Array.from(value, source => {
    plain(source, 'topic');
    const field = key => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`topic ${key} must be an own data field`);
      return descriptor.value;
    };
    const result = {
      id: string(field('id'), 256, 'topic id'), title: string(field('title'), 120, 'topic title'),
      prompt: string(field('prompt'), 1500, 'topic prompt'),
    };
    if (Object.hasOwn(source, 'category')) result.category = string(field('category'), 100, 'topic category');
    const bullets = field('bullets');
    if (!Array.isArray(bullets) || bullets.length < 1 || bullets.length > 6) invalid('topic bullets must contain 1 to 6 entries');
    result.bullets = Array.from(bullets, value => string(value, 500, 'topic bullet'));
    if (Object.hasOwn(source, 'custom')) { const custom = field('custom'); if (typeof custom !== 'boolean') invalid('topic custom must be boolean'); result.custom = custom; }
    return result;
  });
}

function countMedia(value) {
  if (isBlob(value)) return value.size;
  if (!value || typeof value !== 'object') return 0;
  let size = 0;
  for (const child of Object.values(value)) { size += countMedia(child); if (size > MAX_MEDIA_BYTES) mediaLimit(); }
  return size;
}

function toBase64(bytes) {
  // Chunk boundaries are divisible by three so independently encoded chunks
  // concatenate without introducing padding in the middle of the payload.
  const chunks = [], chunkSize = 0x6000;
  for (let start = 0; start < bytes.length; start += chunkSize) chunks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + chunkSize))));
  return chunks.join('');
}
async function encodeMedia(value) {
  if (isBlob(value)) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (bytes.byteLength !== value.size) invalid('blob size changed');
    return { $type: 'blob', type: value.type, size: value.size, base64: toBase64(bytes) };
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const child of value) result.push(await encodeMedia(child));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = await encodeMedia(child);
    return result;
  }
  return value;
}

// Count UTF-8 bytes while emitting JSON. This stops at the limit instead of
// constructing an unbounded JSON string from otherwise valid practice text.
function jsonBlob(value) {
  const chunks = []; let size = 0;
  function append(chunk) { size += encoder.encode(chunk).byteLength; if (size > MAX_JSON_BYTES) jsonLimit(); chunks.push(chunk); }
  function visit(value) {
    if (Array.isArray(value)) {
      append('['); value.forEach((item, index) => { if (index) append(','); visit(item); }); append(']');
    } else if (value && typeof value === 'object') {
      append('{'); Object.entries(value).forEach(([key, item], index) => { if (index) append(','); append(JSON.stringify(key)); append(':'); visit(item); }); append('}');
    } else append(JSON.stringify(value));
  }
  visit(value);
  return new Blob(chunks, { type: 'application/json' });
}

export async function encodeBackup({ data, topics = [] } = {}) {
  const safeData = sanitizePracticeData(data), safeTopics = sanitizeTopics(topics);
  if (countMedia(safeData) > MAX_MEDIA_BYTES) mediaLimit();
  const createdAt = new Date().toISOString();
  const blob = jsonBlob({ format: 'afterword-backup', version: 1, createdAt, data: await encodeMedia(safeData), topics: safeTopics });
  return { blob, filename: `afterword-backup-${createdAt.replace(/[:.]/g, '-')}.json`, counts: { practices: safeData.practices.length, topics: safeTopics.length } };
}

function decodeBlob(value, budget) {
  if (value.$type !== 'blob' || typeof value.type !== 'string' || !MEDIA_TYPE.test(value.type)) invalid('unsupported media MIME blob');
  if (!Number.isSafeInteger(value.size) || value.size < 0) invalid('blob size');
  const encoded = value.base64;
  if (typeof encoded !== 'string' || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('blob base64');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedSize = encoded.length / 4 * 3 - padding;
  if (decodedSize !== value.size) invalid('blob size does not match base64');
  // Reject alternate encodings with non-zero unused bits, which permissive
  // atob implementations otherwise silently accept (for example AB==).
  if ((padding === 2 && (BASE64_ALPHABET.indexOf(encoded.at(-3)) & 15)) || (padding === 1 && (BASE64_ALPHABET.indexOf(encoded.at(-2)) & 3))) invalid('noncanonical blob base64');
  budget.bytes += decodedSize; if (budget.bytes > MAX_MEDIA_BYTES) mediaLimit();
  const chunks = [], chunkSize = 0x8000;
  // Decode bounded chunks to keep a second full-size binary string out of memory.
  for (let start = 0; start < encoded.length; start += chunkSize) {
    let binary;
    try { binary = atob(encoded.slice(start, start + chunkSize)); } catch { invalid('corrupt blob base64'); }
    chunks.push(Uint8Array.from(binary, character => character.charCodeAt(0)));
  }
  return new Blob(chunks, { type: value.type });
}

export async function decodeBackup(file) {
  if (!isBlob(file)) invalid('file must be a Blob');
  if (file.size > MAX_JSON_BYTES) jsonLimit();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BYTES) jsonLimit();
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid('corrupt UTF-8 encoding'); }
  const budget = { bytes: 0 }; let envelope;
  try {
    envelope = JSON.parse(source, (key, value) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('unsafe prototype key');
      if (value && typeof value === 'object' && Object.hasOwn(value, '$type')) return decodeBlob(value, budget);
      return value;
    });
  } catch (error) {
    if (error instanceof SyntaxError) invalid('corrupt JSON');
    throw error;
  }
  plain(envelope, 'envelope');
  if (envelope.format !== 'afterword-backup') invalid('unsupported format');
  if (envelope.version !== 1) invalid('unsupported version');
  if (typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt))) invalid('createdAt date');
  return { data: sanitizePracticeData(envelope.data), topics: sanitizeTopics(envelope.topics) };
}
