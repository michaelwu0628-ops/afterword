import test from 'node:test';
import assert from 'node:assert/strict';
let api = {};
try { api = await import('../public/mvp-store.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const memory = () => { assert.equal(typeof api.createMemoryPracticeStore, 'function'); return api.createMemoryPracticeStore(); };
const suggestion = (expression = 'really enjoy') => ({ original: 'very like', suggestion: expression, reason: '用动词和副词自然表达喜好。' });
const practice = (id = 'p1', suggestions = [suggestion()]) => ({ id, mode: 'material', title: 'A real conversation', createdAt: 1, updatedAt: 2, status: 'complete', turns: [{ id: 't1', role: 'user', text: 'I very like tea.', phase: 'chat' }], review: { assessment: 'suggestions', summary: '可以调整这一处搭配。', suggestions } });

test('memory store saves only practice, nested source, feedback and audio whitelists', async () => {
  const store = memory(), audio = new Blob(['actual audio'], { type: 'audio/wav' });
  const input = { ...practice(), apiKey: 'TOP_SECRET', config: { key: 'TOP_SECRET' }, material: { title: 'Tea', url: 'https://example.com/tea', mediaBlob: audio, blobURL: 'blob:ephemeral', transcriptKind: 'manual_selected_segment', apiKey: 'NESTED_SECRET', cues: [{ start: 0, end: 2, text: 'Tea is interesting.', token: 'CUE_SECRET' }] }, topic: { title: 'Tea', prompt: 'Describe a drink.', bullets: ['What it is'], auth: 'TOPIC_SECRET' }, turns: [{ id: 't1', role: 'user', text: 'Tea.', phase: 'chat', audio, duration: 2, incomplete: true, apiKey: 'TURN_SECRET' }], independentAudio: audio, independentDuration: 2 };
  input.review.suggestions[0].apiKey = 'REVIEW_SECRET';
  const saved = await store.putPractice(input);
  assert.equal(saved.id, 'p1'); assert.equal(saved.turns[0].audio.size, audio.size); assert.equal(saved.independentAudio.type, 'audio/wav');
  assert.ok(!JSON.stringify(saved).includes('SECRET'));
  assert.deepEqual(saved.topic.bullets, ['What it is']);
  assert.equal(saved.material.mediaBlob.size, audio.size); assert.equal(saved.material.transcriptKind, 'manual_selected_segment'); assert.ok(!Object.hasOwn(saved.material, 'blobURL'));
  saved.turns[0].text = 'mutated'; input.material.title = 'mutated';
  assert.equal((await store.getPractice('p1')).turns[0].text, 'Tea.');
  assert.equal((await store.getPractice('p1')).material.title, 'Tea');
});

test('practices are ordered by last update and missing records are null', async () => {
  const store = memory();
  await store.putPractice({ ...practice('old'), updatedAt: 10 });
  await store.putPractice({ ...practice('new'), updatedAt: 20 });
  assert.deepEqual((await store.listPractices()).map(p => p.id), ['new', 'old']);
  assert.equal(await store.getPractice('absent'), null);
  await assert.rejects(() => store.putPractice({ mode: 'material' }), /id/i);
});

test('only actual valid suggestions generate at most three idempotent review items', async () => {
  const store = memory();
  await store.putPractice(practice('p1', [suggestion('really enjoy'), suggestion('I tend to'), suggestion('in my experience'), suggestion('one more')]));
  await store.putPractice(practice('p1', [suggestion('really enjoy'), suggestion('I tend to'), suggestion('in my experience'), suggestion('one more')]));
  const items = await store.listReviewItems();
  assert.equal(items.length, 3);
  assert.deepEqual(Object.keys(items[0]).sort(), ['id', 'practiceId', 'original', 'suggestion', 'reason', 'status'].sort());
  await store.putPractice({ ...practice('p2', []), review: { assessment: 'no_clear_issue', summary: '无需修改。', suggestions: [] } });
  await store.putPractice(practice('p3', [{ original: '', suggestion: 'invented', reason: '' }]));
  assert.equal((await store.listReviewItems()).length, 3);
});

test('stopped expression remains stopped after practice updates and equivalent expressions elsewhere', async () => {
  const store = memory(); await store.putPractice(practice());
  const item = (await store.listReviewItems())[0];
  await store.setReviewStatus(item.id, 'stopped');
  await store.putPractice(practice()); await store.putPractice(practice('p2', [suggestion('  REALLY   ENJOY! ')]));
  assert.deepEqual((await store.listReviewItems()).map(i => i.status), ['stopped', 'stopped']);
  assert.deepEqual(await store.getReviewContext(), []);
  await store.setReviewStatus(item.id, 'active');
  assert.deepEqual((await store.listReviewItems()).map(i => i.status), ['active', 'active']);
  assert.equal((await store.getReviewContext()).length, 1);
  await assert.rejects(() => store.setReviewStatus(item.id, 'mastered'), /status/i);
});

test('deleting an expression suppresses equivalent items globally, including future reviews', async () => {
  const store = memory(); await store.putPractice(practice()); await store.putPractice(practice('p2'));
  const item = (await store.listReviewItems())[0]; await store.deleteReviewItem(item.id);
  assert.equal((await store.listReviewItems()).length, 0);
  await store.putPractice(practice()); await store.putPractice(practice('p3', [suggestion('REALLY ENJOY.')]));
  assert.deepEqual(await store.listReviewItems(), []); assert.deepEqual(await store.getReviewContext(), []);
});

test('context uses at most three active distinct expressions and contains only expression and usage', async () => {
  const store = memory(); await store.putPractice(practice('p1', [suggestion('one'), suggestion('two'), suggestion('three')]));
  await store.putPractice({ ...practice('p2', [suggestion('four'), suggestion('five'), suggestion('one')]), updatedAt: 3 });
  const context = await store.getReviewContext(); assert.equal(context.length, 3);
  assert.equal(new Set(context.map(i => i.expression.toLowerCase())).size, 3);
  assert.ok(context.every(i => Object.keys(i).sort().join() === 'expression,usage' && i.usage));
});

test('deleting a practice cascades its derived items and clear resets user expression policies', async () => {
  const store = memory(); await store.putPractice(practice());
  await store.setReviewStatus((await store.listReviewItems())[0].id, 'stopped');
  assert.equal(await store.deletePractice('p1'), true); assert.equal(await store.getPractice('p1'), null); assert.deepEqual(await store.listReviewItems(), []);
  await store.putPractice(practice('p2')); assert.equal((await store.listReviewItems())[0].status, 'stopped');
  await store.clear(); assert.deepEqual(await store.listPractices(), []); assert.deepEqual(await store.listReviewItems(), []);
  await store.putPractice(practice('p3')); assert.equal((await store.listReviewItems())[0].status, 'active');
});

// A small injected IndexedDB surface exercises reopen/transaction behavior without
// installing dependencies or accessing any real browser or user data.
function fakeIndexedDB({ failPut = () => false, transactions = [] } = {}) {
  const databases = new Map();
  return { open(name) {
    const request = {};
    setImmediate(() => {
      const isNew = !databases.has(name); if (isNew) databases.set(name, new Map());
      const stores = databases.get(name);
      const db = { objectStoreNames: { contains: key => stores.has(key) }, createObjectStore(key) { stores.set(key, new Map()); }, close() {}, transaction(names, mode) {
        transactions.push({ names, mode });
        const copies = new Map(names.map(key => [key, structuredClone(stores.get(key))]));
        let pending = 0, aborted = false, queued = false;
        const tx = { error: null, abort() { aborted = true; setImmediate(() => tx.onabort?.()); }, objectStore(name) {
          const values = copies.get(name);
          const enqueue = fn => { const request = {}; pending++; setImmediate(() => { if (aborted) return; try { request.result = structuredClone(fn()); request.onsuccess?.(); } catch (error) { request.error = error; request.onerror?.(); tx.error = error; tx.abort(); } pending--; check(); }); return request; };
          return { get: key => enqueue(() => values.get(key)), getAll: () => enqueue(() => [...values.values()]), put: value => enqueue(() => { if (failPut(name, value)) throw new Error('Injected storage failure'); values.set(value.id ?? value.expression, structuredClone(value)); return value.id ?? value.expression; }), delete: key => enqueue(() => values.delete(key)), clear: () => enqueue(() => values.clear()) };
        }};
        const check = () => { if (pending || queued || aborted) return; queued = true; setImmediate(() => { queued = false; if (pending || aborted) return; if (mode === 'readwrite') for (const [key, value] of copies) stores.set(key, value); tx.oncomplete?.(); }); };
        check(); return tx;
      }};
      request.result = db; if (isNew) request.onupgradeneeded?.(); request.onsuccess?.();
    }); return request;
  }};
}

test('IndexedDB store persists practice audio and expression policies when reopened', async () => {
  assert.equal(typeof api.createPracticeStore, 'function');
  const indexedDB = fakeIndexedDB(), first = api.createPracticeStore({ indexedDB });
  await first.putPractice({ ...practice(), independentAudio: new Blob(['persisted'], { type: 'audio/wav' }) });
  await first.setReviewStatus((await first.listReviewItems())[0].id, 'stopped');
  const reopened = api.createPracticeStore({ indexedDB });
  assert.equal(await (await reopened.getPractice('p1')).independentAudio.text(), 'persisted');
  assert.deepEqual(await reopened.getReviewContext(), []);
  await reopened.putPractice(practice('p2')); assert.ok((await reopened.listReviewItems()).every(i => i.status === 'stopped'));
  await reopened.deletePractice('p1'); assert.equal((await reopened.listPractices()).length, 1);
  await reopened.clear(); assert.deepEqual(await reopened.listPractices(), []);
});

test('IndexedDB failures are surfaced instead of silently saving in temporary memory', async () => {
  assert.equal(typeof api.createPracticeStore, 'function');
  const store = api.createPracticeStore({ indexedDB: null });
  await assert.rejects(() => store.putPractice(practice()), /IndexedDB/i);
});

test('real capitalization corrections are retained while unknown metadata is removed', async () => {
  const store = memory();
  const saved = await store.putPractice(practice('capital', [{ original: 'i', suggestion: 'I', reason: '英语第一人称代词大写。', knowledgeSources: [{ knowledgeId: 'capital-i', expression: 'I', sources: [{ id: 's1', title: 'Reference', url: 'https://example.org/rule', publisher: 'Example', apiKey: 'SECRET' }], apiKey: 'SECRET' }], evidence: { turnId: 't1', text: 'i like tea', apiKey: 'SECRET' } }]));
  assert.equal(saved.review.suggestions.length, 1);
  assert.equal((await store.listReviewItems()).length, 1);
  assert.equal(saved.review.suggestions[0].knowledgeSources[0].sources[0].title, 'Reference');
  assert.ok(!JSON.stringify(saved).includes('SECRET'));
});


test('Part 2 dimensional feedback and evidence survive IndexedDB reopen without nested credentials', async () => {
  assert.equal(typeof api.createPracticeStore, 'function');
  const indexedDB = fakeIndexedDB(), store = api.createPracticeStore({ indexedDB });
  const assessed = { status: 'assessed', basis: 'transcript', feedback: '词语能准确表达习惯。', evidence: { turnId: 'part2-answer', text: 'I walk there every Sunday.', quote: 'every Sunday', apiKey: 'EVIDENCE_SECRET' }, apiKey: 'AXIS_SECRET' };
  const unavailable = { status: 'unavailable', reason: '当前证据不足。', token: 'AXIS_SECRET' };
  const input = { ...practice('part2'), mode: 'part2', review: { ...practice().review, part2Assessment: { lexical: assessed, grammar: assessed, organisation: unavailable, pronunciation: unavailable, score: unavailable, apiKey: 'ASSESSMENT_SECRET' } } };
  await store.putPractice(input);
  const reopened = api.createPracticeStore({ indexedDB });
  const actual = (await reopened.getPractice('part2')).review.part2Assessment;
  assert.ok(actual, 'saved Part 2 dimensional assessment must survive reopen');
  assert.deepEqual(Object.keys(actual).sort(), ['lexical', 'grammar', 'organisation', 'pronunciation', 'score'].sort());
  assert.deepEqual(actual.lexical, { status: 'assessed', basis: 'transcript', feedback: assessed.feedback, evidence: { turnId: 'part2-answer', text: 'I walk there every Sunday.', quote: 'every Sunday' } });
  assert.deepEqual(actual.organisation, { status: 'unavailable', reason: '当前证据不足。' });
  assert.ok(!JSON.stringify(actual).includes('SECRET'));
});

test('exportData snapshots practices and review policies in one read transaction', async () => {
  const transactions = [], store = api.createPracticeStore({ indexedDB: fakeIndexedDB({ transactions }) });
  await store.putPractice({ ...practice(), apiKey: 'PRIVATE', material: { title: 'Source', mediaBlob: new Blob(['source'], { type: 'video/mp4' }) } });
  await store.setReviewStatus((await store.listReviewItems())[0].id, 'stopped');
  transactions.length = 0;
  assert.equal(typeof store.exportData, 'function');
  const result = await store.exportData();
  assert.deepEqual(transactions.map(t => t.mode), ['readonly']);
  assert.deepEqual(Object.keys(result).sort(), ['practices', 'reviewPolicy']);
  assert.deepEqual(result.reviewPolicy, [{ expression: 'really enjoy', status: 'stopped' }]);
  assert.equal(await result.practices[0].material.mediaBlob.text(), 'source');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  result.practices[0].title = 'Changed';
  assert.equal((await store.getPractice('p1')).title, 'A real conversation');
});

test('importData appends missing ids without overwriting existing practices and is idempotent', async () => {
  const store = memory();
  await store.putPractice(practice());
  assert.equal(typeof store.importData, 'function');
  const data = { practices: [{ ...practice(), title: 'Overwrite attempt' }, { ...practice('p2'), token: 'PRIVATE' }], reviewPolicy: [] };
  assert.deepEqual(await store.importData(data), { imported: 1, skipped: 1 });
  assert.equal((await store.getPractice('p1')).title, 'A real conversation');
  assert.ok(!JSON.stringify(await store.getPractice('p2')).includes('PRIVATE'));
  assert.deepEqual(await store.importData(data), { imported: 0, skipped: 2 });
  assert.equal((await store.listReviewItems()).length, 2);
});

test('policy import uses deleted then stopped then active across normalized expressions', async () => {
  const store = memory();
  await store.putPractice(practice('old', [suggestion('really enjoy'), suggestion('I tend to')]));
  await store.setReviewStatus((await store.listReviewItems()).find(i => i.suggestion === 'really enjoy').id, 'stopped');
  assert.equal(typeof store.importData, 'function');
  const data = { practices: [practice('new', [suggestion('REALLY ENJOY!'), suggestion('I tend to')])], reviewPolicy: [{ expression: '  REALLY ENJOY! ', status: 'active' }, { expression: 'I tend to', status: 'deleted' }] };
  await store.importData(data);
  assert.deepEqual((await store.listReviewItems()).map(i => i.status), ['stopped', 'stopped']);
  assert.deepEqual(await store.getReviewContext(), []);
  await store.importData({ practices: [practice('third')], reviewPolicy: [{ expression: 'really enjoy', status: 'deleted' }, { expression: 'I tend to', status: 'active' }] });
  assert.deepEqual(await store.listReviewItems(), []);
  assert.deepEqual((await store.exportData()).reviewPolicy, [{ expression: 'i tend to', status: 'deleted' }, { expression: 'really enjoy', status: 'deleted' }]);
});

test('import rejects invalid known fields and limits before mutating memory', async () => {
  const store = memory(); await store.putPractice(practice());
  assert.equal(typeof store.importData, 'function');
  for (const invalid of [
    { practices: [practice('ok'), { ...practice('bad'), turns: 'not turns' }], reviewPolicy: [] },
    { practices: [], reviewPolicy: [{ expression: 'enjoy', status: 'mastered' }] },
    { practices: Array.from({ length: 1001 }, (_, i) => practice(String(i))), reviewPolicy: [] },
    { practices: [], reviewPolicy: Array.from({ length: 10001 }, () => ({ expression: 'enjoy', status: 'active' })) },
    { practices: [Object.assign(Object.create({ id: 'inherited' }), { title: 'invalid prototype' })], reviewPolicy: [] },
  ]) await assert.rejects(() => store.importData(invalid), /invalid|limit|maximum|exceeds|plain|1000|10000/i);
  assert.deepEqual((await store.listPractices()).map(p => p.id), ['p1']);
});

test('IndexedDB import rolls back practices, policies and derived items on storage failure', async () => {
  let fail = false;
  const transactions = [], indexedDB = fakeIndexedDB({ transactions, failPut: (name, value) => fail && name === 'reviewItems' && value.practiceId === 'p2' });
  const store = api.createPracticeStore({ indexedDB }); await store.putPractice(practice());
  assert.equal(typeof store.importData, 'function');
  const before = await store.exportData(), beforeItems = await store.listReviewItems();
  transactions.length = 0; fail = true;
  await assert.rejects(() => store.importData({ practices: [practice('p2')], reviewPolicy: [{ expression: 'really enjoy', status: 'stopped' }] }), /Injected storage failure/);
  assert.deepEqual(transactions.map(t => t.mode), ['readwrite']);
  const reopened = api.createPracticeStore({ indexedDB });
  assert.deepEqual(await reopened.exportData(), before);
  assert.deepEqual(await reopened.listReviewItems(), beforeItems);
});

test('import snapshots caller input and skips duplicate ids within the same file', async () => {
  const store = memory(), input = { practices: [practice('first'), { ...practice('first'), title: 'must be skipped' }], reviewPolicy: [] };
  assert.equal(typeof store.importData, 'function');
  const pending = store.importData(input);
  input.practices[0].title = 'changed while pending'; input.practices[0].turns[0].text = 'changed';
  assert.deepEqual(await pending, { imported: 1, skipped: 1 });
  const saved = await store.getPractice('first');
  assert.equal(saved.title, 'A real conversation'); assert.equal(saved.turns[0].text, 'I very like tea.');
});

test('combined import limits reject before altering an already full store', async () => {
  const store = memory(); assert.equal(typeof store.importData, 'function');
  await store.importData({ practices: Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}` })), reviewPolicy: [] });
  await assert.rejects(() => store.importData({ practices: [{ id: 'extra' }], reviewPolicy: [{ expression: 'new policy', status: 'deleted' }] }), /1000|maximum|exceeds/i);
  assert.equal(await store.getPractice('extra'), null);
  const snapshot = await store.exportData(); assert.equal(snapshot.practices.length, 1000); assert.deepEqual(snapshot.reviewPolicy, []);
});

test('practice saves require an own id', async () => {
  const store = memory();
  await assert.rejects(() => store.putPractice(Object.create({ id: 'inherited' })), /id|invalid/i);
  assert.deepEqual(await store.listPractices(), []);
});

test('import axes never invoke accessors', async () => {
  const store = memory();
  let reads = 0;
  const axis = {}; Object.defineProperty(axis, 'status', { get() { reads++; return 'unavailable'; }, enumerable: true });
  await assert.rejects(() => store.importData({ practices: [{ id: 'p', review: { part2Assessment: { lexical: axis } } }], reviewPolicy: [] }), /invalid/i);
  assert.equal(reads, 0); assert.deepEqual(await store.listPractices(), []);
});
