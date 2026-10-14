import test from 'node:test';
import assert from 'node:assert/strict';
let api = {};
try { api = await import('../public/mvp-backup.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const data = () => ({ practices: [{ id: 'p1', title: 'Tea', mode: 'material', turns: [{ id: 't1', role: 'user', text: 'I enjoy tea.', audio: new Blob([new Uint8Array([0, 1, 254, 255])], { type: 'audio/wav' }) }], material: { title: 'A source', mediaBlob: new Blob(['video bytes'], { type: 'video/mp4' }) }, independentAudio: new Blob(['answer'], { type: 'audio/webm;codecs=opus' }), review: { suggestions: [{ original: 'very like', suggestion: 'really enjoy', reason: 'Natural usage.' }] } }], reviewPolicy: [{ expression: 'really enjoy', status: 'stopped' }] });
const topic = () => ({ id: 'custom-1', category: '自添', title: 'A drink', prompt: 'Describe a drink.', bullets: ['What it is'], custom: true });
const encode = async value => { assert.equal(typeof api.encodeBackup, 'function'); return api.encodeBackup(value); };
const decode = async file => { assert.equal(typeof api.decodeBackup, 'function'); return api.decodeBackup(file); };
const file = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const envelope = () => ({ format: 'afterword-backup', version: 1, createdAt: '2026-10-14T00:00:00.000Z', data: { practices: [], reviewPolicy: [] }, topics: [] });

test('backup roundtrips audio, source media, policies and topics in versioned JSON', async () => {
  const original = data(), result = await encode({ data: original, topics: [topic()] });
  assert.equal(result.blob.type, 'application/json');
  assert.match(result.filename, /^afterword-backup-.*\.json$/);
  assert.deepEqual(result.counts, { practices: 1, topics: 1 });
  const json = JSON.parse(await result.blob.text());
  assert.equal(json.format, 'afterword-backup'); assert.equal(json.version, 1); assert.ok(Number.isFinite(Date.parse(json.createdAt)));
  const decoded = await decode(result.blob), practice = decoded.data.practices[0];
  assert.deepEqual(new Uint8Array(await practice.turns[0].audio.arrayBuffer()), new Uint8Array([0, 1, 254, 255]));
  assert.equal(practice.turns[0].audio.type, 'audio/wav');
  assert.equal(await practice.material.mediaBlob.text(), 'video bytes');
  assert.equal(await practice.independentAudio.text(), 'answer');
  assert.equal(practice.independentAudio.type, 'audio/webm;codecs=opus');
  assert.deepEqual(decoded.data.reviewPolicy, original.reviewPolicy);
  assert.deepEqual(decoded.topics, [topic()]);
});

test('encoding and decoding whitelist confidential and unknown fields at every level', async () => {
  const source = data(); source.apiKey = 'ROOT_PRIVATE'; source.practices[0].token = 'PRACTICE_PRIVATE';
  source.practices[0].turns[0].apiKey = 'TURN_PRIVATE'; source.practices[0].material.authorization = 'SOURCE_PRIVATE';
  const inputTopic = { ...topic(), apiKey: 'TOPIC_PRIVATE' };
  const result = await encode({ data: source, topics: [inputTopic] });
  assert.ok(!/PRIVATE|apiKey|authorization|token/.test(await result.blob.text()));
  const raw = JSON.parse(await result.blob.text()); raw.data.practices[0].apiKey = 'RESTORE_PRIVATE'; raw.topics[0].token = 'RESTORE_PRIVATE'; raw.apiKey = 'RESTORE_PRIVATE';
  assert.ok(!JSON.stringify(await decode(file(raw))).includes('PRIVATE'));
});

test('decoder rejects malformed JSON, versions, format and data types before a caller can import', async () => {
  for (const value of [
    { ...envelope(), format: 'other' }, { ...envelope(), version: 2 }, { ...envelope(), version: '1' },
    { ...envelope(), createdAt: 'broken date' }, { ...envelope(), topics: {} },
    { ...envelope(), data: { practices: [{ id: 'p', turns: ['not a turn'] }], reviewPolicy: [] } },
    { ...envelope(), topics: [{ ...topic(), bullets: [7] }] },
  ]) await assert.rejects(() => decode(file(value)), /invalid|unsupported|version|format|date|topic|turn|type/i);
  await assert.rejects(() => decode(new Blob(['{"format":'])), /JSON|invalid|corrupt/i);
  await assert.rejects(() => decode('not a Blob'), /Blob|file|invalid/i);
});

test('blob tags reject corrupt base64, noncanonical padding and forbidden MIME types', async () => {
  const encoded = JSON.parse(await (await encode({ data: data() })).blob.text());
  const tag = encoded.data.practices[0].turns[0].audio;
  assert.equal(tag.type, 'audio/wav'); assert.equal(typeof tag.base64, 'string');
  for (const replacement of [{ ...tag, base64: '@@@@' }, { ...tag, size: 1, base64: 'AB==' }, { ...tag, size: 2, base64: 'AAB=' }, { ...tag, base64: 'AAAA=' }, { ...tag, type: 'text/html' }, { ...tag, base64: 7 }, { ...tag, size: -1 }, { $type: 'not-a-blob', type: 'audio/wav', base64: 'AA==' }]) {
    const raw = structuredClone(encoded); raw.data.practices[0].turns[0].audio = replacement;
    await assert.rejects(() => decode(file(raw)), /blob|base64|media|MIME|size|invalid/i);
  }
  const source = data(); source.practices[0].turns[0].audio = new Blob(['html'], { type: 'text/html' });
  await assert.rejects(() => encode({ data: source }), /media|MIME|blob|invalid/i);
});

test('backups reject prototype keys without ever installing arbitrary prototypes', async () => {
  const raw = '{"format":"afterword-backup","version":1,"createdAt":"2026-10-14T00:00:00.000Z","data":{"practices":[{"id":"p","__proto__":{"polluted":true}}],"reviewPolicy":[]},"topics":[]}';
  await assert.rejects(() => decode(new Blob([raw])), /prototype|unsafe|invalid/i);
  assert.equal({}.polluted, undefined);
});

test('backup count limits reject excessive practices and topics', async () => {
  await assert.rejects(() => encode({ data: { practices: Array.from({ length: 1001 }, (_, i) => ({ id: String(i) })), reviewPolicy: [] } }), /limit|maximum|exceeds|1000/i);
  await assert.rejects(() => encode({ data: { practices: [], reviewPolicy: [] }, topics: Array.from({ length: 101 }, topic) }), /limit|maximum|exceeds|100/i);
  await assert.rejects(() => decode(file({ ...envelope(), topics: Array.from({ length: 101 }, topic) })), /limit|maximum|exceeds|100/i);
});

test('JSON input and decoded media budgets are enforced before reading huge data', async () => {
  class LargeFile extends Blob { get size() { return 100 * 1024 * 1024 + 1; } async text() { throw new Error('must not read oversized file'); } }
  await assert.rejects(() => decode(new LargeFile()), /100|limit|maximum|exceeds/i);
  const source = data(); source.practices[0].independentAudio = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: 'audio/wav' });
  source.practices[0].turns[0].audio = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: 'audio/wav' });
  await assert.rejects(() => encode({ data: source }), /64|limit|maximum|exceeds/i);
});

test('JSON output budget counts escaped UTF-8 practice text', async () => {
  const text = '茶'.repeat(24000);
  const practices = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, turns: [{ text }, { text }] }));
  await assert.rejects(() => encode({ data: { practices, reviewPolicy: [] } }), /100|limit|maximum|exceeds/i);
});

test('decoder enforces the aggregate decoded media budget in a valid sized JSON file', async () => {
  const base64 = 'AAAA'.repeat(33 * 1024 * 1024 / 3);
  // A shared base64 value keeps fixture allocation bounded; JSON itself is 88 MiB.
  const header = '{"format":"afterword-backup","version":1,"createdAt":"2026-10-14T00:00:00.000Z","data":{"practices":[{"id":"p","turns":[{"audio":{"$type":"blob","type":"audio/wav","size":34603008,"base64":"';
  const middle = '"}}],"independentAudio":{"$type":"blob","type":"audio/wav","size":34603008,"base64":"';
  const large = new Blob([header, base64, middle, base64, '"}}],"reviewPolicy":[]},"topics":[]}']);
  assert.ok(large.size < 100 * 1024 * 1024);
  await assert.rejects(() => decode(large), /64|limit|maximum|exceeds/i);
});

test('topic validation requires own data fields without invoking accessors', async () => {
  let reads = 0;
  const card = topic(); Object.defineProperty(card, 'title', { get() { reads++; return 'Accessed'; }, enumerable: true });
  await assert.rejects(() => encode({ data: { practices: [], reviewPolicy: [] }, topics: [card] }), /invalid|accessor|topic/i);
  assert.equal(reads, 0);
});

test('decoder rejects invalid UTF-8 rather than importing replacement characters', async () => {
  const corrupted = new Blob(['{"format":"afterword-backup","version":1,"createdAt":"2026-10-14T00:00:00.000Z","data":{"practices":[{"id":"p","title":"', new Uint8Array([255]), '"}],"reviewPolicy":[]},"topics":[]}']);
  await assert.rejects(() => decode(corrupted), /UTF-8|encoding|invalid|corrupt/i);
});
