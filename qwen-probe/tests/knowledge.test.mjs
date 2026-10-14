import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createKnowledgeIndex, retrieveKnowledge, buildKnowledgeGraph } from '../knowledge.mjs';
import * as store from '../knowledge-store.mjs';
const source = (id = 'dictionary-1', extra = {}) => ({ id, title: 'Reviewed speaking reference', url: `https://example.org/${id}`, publisher: 'Example education', tier: 'education', read_status: 'body_read', approved_for_runtime: true, rights: 'paraphrase_only', ...extra });
const card = (id, expression, extra = {}) => ({ id, intent: 'opinion', expression, meaning: `Meaning of ${expression}`, register: 'neutral', usage: 'An original teaching note.', pitfalls: ['Keep the intended meaning.'], collocations: [expression], aliases: [], examples: [`${expression} can introduce a statement.`], source_refs: ['dictionary-1'], relations: [], grounding_scope: 'function_principle_only', ...extra });
const fixture = () => ({ version: 'fixture.v1', sources: [source()], cards: [
  card('op-think', 'I think', { aliases: ['I am think'], relations: [{ type: 'contrasts_with', target: 'op-believe' }] }),
  card('op-believe', 'I believe', { relations: [{ type: 'related_to', target: 'op-view' }] }),
  card('op-view', 'In my view'),
  card('reason-because', 'because', { intent: 'reasons' }),
  card('exp-used', 'used to', { intent: 'experience', aliases: ['use to'] }),
  card('comparison-than', 'more convenient than', { intent: 'comparison', aliases: ['more better than'] }),
] });

test('the local knowledge module exposes the agreed pure functions', () => {
  assert.equal(typeof createKnowledgeIndex, 'function');
  assert.equal(typeof retrieveKnowledge, 'function');
  assert.equal(typeof buildKnowledgeGraph, 'function');
  assert.equal(typeof store.loadDefaultKnowledgeIndex, 'function');
});

test('empty, punctuation-only and stopword-only queries return no_match', () => {
  const index = createKnowledgeIndex(fixture());
  for (const text of ['', '  ', '!!! 🎤', 'I am the and to']) {
    const result = retrieveKnowledge(index, { text });
    assert.equal(result.status, 'no_match');
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.trace.selectedIds, []);
  }
});

test('BM25 and learner aliases rank the directly matching expression first', () => {
  const result = retrieveKnowledge(createKnowledgeIndex(fixture()), { text: 'I am think this is useful.', graph: false });
  assert.equal(result.status, 'matched');
  assert.equal(result.method, 'bm25-intent-graph-v1');
  assert.equal(result.corpusVersion, 'fixture.v1');
  assert.equal(result.cards[0].id, 'op-think');
  assert.equal(result.trace.scores[0].id, 'op-think');
  assert.ok(result.trace.scores[0].bm25 > 0);
});

test('BM25 numeric scores use standard k1=1.2, b=0.75 and logarithmic IDF', () => {
  const simple = (id, expression) => card(id, expression, { meaning: expression, usage: expression, pitfalls: [], collocations: [], aliases: [], examples: [] });
  const index = createKnowledgeIndex({ version: 'bm25', sources: [source()], cards: [simple('a-zebra', 'zebra'), simple('b-quartz', 'quartz')] });
  const result = retrieveKnowledge(index, { text: 'zebra', graph: false });
  // Each document has 5 tokens; zebra occurs 3 times in one of 2 documents.
  const expected = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5)) * (3 * 2.2) / (3 + 1.2 * (0.25 + 0.75));
  assert.ok(Math.abs(result.trace.scores[0].bm25 - expected) < 0.000001);
});

test('Unicode normalization and Chinese bigrams support lexical matching', () => {
  const data = fixture(); data.cards[0].meaning = '表达个人观点';
  const index = createKnowledgeIndex(data);
  assert.equal(retrieveKnowledge(index, { text: 'Ｉ　ｔｈｉｎｋ', graph: false }).cards[0].id, 'op-think');
  assert.equal(retrieveKnowledge(index, { text: '个人观点', graph: false }).cards[0].id, 'op-think');
});

test('unknown content returns no_match instead of arbitrary teaching material', () => {
  const result = retrieveKnowledge(createKnowledgeIndex(fixture()), { text: 'quasar zirconium telescope', graph: true });
  assert.equal(result.status, 'no_match');
  assert.equal(result.cards.length, 0);
});

test('a reviewed multiword expression remains searchable when every word is a stopword', () => {
  const data = fixture(); data.cards.push(card('op-for-me', 'For me, ...'));
  const result = retrieveKnowledge(createKnowledgeIndex(data), { text: 'For me', graph: false });
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.cards.map(item => item.id), ['op-for-me']);
  assert.equal(result.trace.scores[0].phraseBonus, 2);
});

test('one-hop graph expansion follows only declared card relations', () => {
  const index = createKnowledgeIndex(fixture());
  const direct = retrieveKnowledge(index, { text: 'I think', graph: false });
  const graph = retrieveKnowledge(index, { text: 'I think', graph: true });
  assert.deepEqual(direct.cards.map(item => item.id), ['op-think']);
  assert.deepEqual(graph.trace.seedIds, ['op-think']);
  assert.deepEqual(graph.trace.expandedIds, ['op-believe']);
  assert.deepEqual(graph.cards.map(item => item.id), ['op-think', 'op-believe']);
  assert.equal(graph.cards.some(item => item.id === 'op-view'), false);
});

test('common source, intent and register nodes never expand to the whole corpus', () => {
  const result = retrieveKnowledge(createKnowledgeIndex(fixture()), { text: 'use to', graph: true });
  assert.deepEqual(result.cards.map(item => item.id), ['exp-used']);
  assert.deepEqual(result.trace.expandedIds, []);
});

test('a shared graph neighbor keeps the strongest one-hop seed evidence', () => {
  const data = { version: 'shared-neighbor', sources: [source()], cards: [
    card('a-strong', 'alpha', { aliases: ['beta'], relations: [{ type: 'related_to', target: 'c-neighbor' }] }),
    card('b-weak', 'beta', { relations: [{ type: 'related_to', target: 'c-neighbor' }] }),
    card('c-neighbor', 'gamma'),
  ] };
  const result = retrieveKnowledge(createKnowledgeIndex(data), { text: 'alpha beta' });
  assert.equal(result.trace.seedIds[0], 'a-strong');
  assert.equal(result.trace.scores.find(row => row.id === 'c-neighbor').via, 'a-strong');
});

test('ranking is deterministic even when card input order changes', () => {
  const data = { version: 'ties', sources: [source()], cards: [card('b-card', 'precisely'), card('a-card', 'precisely')] };
  const first = retrieveKnowledge(createKnowledgeIndex(data), { text: 'precisely', graph: false });
  const second = retrieveKnowledge(createKnowledgeIndex({ ...data, cards: [...data.cards].reverse() }), { text: 'precisely', graph: false });
  assert.deepEqual(first, second);
  assert.deepEqual(first.cards.map(item => item.id), ['a-card', 'b-card']);
});

test('topK is capped at four and context serialization is capped at 6000 characters', () => {
  const data = { version: 'limits', sources: [source()], cards: Array.from({ length: 15 }, (_, i) => card(`card-${i}`, 'precisely', { usage: 'u'.repeat(850) })) };
  const index = createKnowledgeIndex(data);
  const capped = retrieveKnowledge(index, { text: 'precisely', topK: 100, maxChars: 100000, graph: false });
  assert.ok(capped.cards.length <= 4);
  assert.ok(JSON.stringify(capped.cards).length <= 6000);
  const small = retrieveKnowledge(index, { text: 'precisely', maxChars: 1000, graph: false });
  assert.ok(JSON.stringify(small.cards).length <= 1000);
  assert.equal(retrieveKnowledge(index, { text: 'precisely', maxChars: 10 }).status, 'no_match');
});
test('the public retrieval interface never returns more than four short cards',()=>{
  const index=createKnowledgeIndex({version:'four-card-limit',sources:[source()],cards:Array.from({length:10},(_,i)=>card(`short-${i}`,'precisely'))});
  assert.equal(retrieveKnowledge(index,{text:'precisely',topK:100}).cards.length,4);
});

test('selected data and source metadata are deeply frozen independent copies', () => {
  const data = fixture();
  const index = createKnowledgeIndex(data);
  data.cards[0].expression = 'MUTATED';
  data.cards[0].aliases.push('poison');
  data.sources[0].title = 'MUTATED';
  const result = retrieveKnowledge(index, { text: 'I think' });
  assert.equal(result.cards[0].expression, 'I think');
  assert.equal(result.cards[0].grounding_scope, 'function_principle_only');
  assert.equal(index.sources[0].title, 'Reviewed speaking reference');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.cards));
  assert.ok(Object.isFrozen(result.cards[0].aliases));
  assert.throws(() => { result.cards[0].aliases.push('poison'); }, TypeError);
  assert.throws(() => { index.sources[0].title = 'poison'; }, TypeError);
});

test('trace is bounded and never records personal query text or tokens', () => {
  const text = 'I think PRIVATE_USER_NAME_917 lives at PRIVATE_ADDRESS_434.';
  const result = retrieveKnowledge(createKnowledgeIndex(fixture()), { text });
  assert.equal(JSON.stringify(result.trace).includes('PRIVATE_'), false);
  assert.ok(result.trace.seedIds.length <= 6);
  assert.ok(result.trace.expandedIds.length <= 24);
  assert.ok(result.trace.scores.length <= 30);
  assert.deepEqual(result.trace.selectedIds, result.cards.map(item => item.id));
});

test('approved runtime references require known sources and HTTPS URLs', () => {
  assert.equal(typeof createKnowledgeIndex, 'function');
  for (const mutate of [
    data => { data.cards[0].source_refs = ['missing-source']; },
    data => { data.sources[0].approved_for_runtime = false; },
    data => { data.sources[0].url = 'http://example.org/unsafe'; },
    data => { data.sources[0].url = 'https://user:secret@example.org/private'; },
    data => { data.sources[0].read_status = 'access_failed'; },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => createKnowledgeIndex(data), TypeError);
  }
});

test('unapproved discovery records can remain in the source register when unreferenced', () => {
  const data = fixture(); data.sources.push(source('discovery', { approved_for_runtime: false, read_status: 'not_read' }));
  const index = createKnowledgeIndex(data);
  assert.equal(index.cards.length, 6);
  assert.equal(index.sources.find(item => item.id === 'discovery').approved_for_runtime, false);
});

test('duplicate IDs, unknown intents, missing required fields and unknown card relations are rejected', () => {
  assert.equal(typeof createKnowledgeIndex, 'function');
  for (const mutate of [
    data => { data.cards[1].id = data.cards[0].id; },
    data => { data.sources.push({ ...data.sources[0] }); },
    data => { data.cards[0].intent = 'pronunciation'; },
    data => { delete data.cards[0].usage; },
    data => { data.cards[0].relations = [{ type: 'related_to', target: 'missing-card' }]; },
    data => { data.cards[0].relations = [{ type: 'supported_by', target: 'dictionary-1' }]; },
    data => { data.cards[0].source_refs = []; },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => createKnowledgeIndex(data), TypeError);
  }
});

test('graph generation includes provenance nodes and validates graph version, nodes and edges', () => {
  const data = fixture();
  const graph = buildKnowledgeGraph(data);
  assert.equal(graph.version, 'fixture.v1');
  assert.ok(graph.nodes.some(node => node.id === 'card:op-think' && node.type === 'card'));
  assert.ok(graph.nodes.some(node => node.id === 'source:dictionary-1' && node.type === 'source'));
  assert.ok(graph.nodes.some(node => node.id === 'intent:opinion' && node.type === 'intent'));
  assert.ok(graph.edges.some(edge => edge.source === 'card:op-think' && edge.target === 'card:op-believe' && edge.type === 'contrasts_with'));
  assert.equal(createKnowledgeIndex({ ...data, edges: graph }).cards.length, 6);
  for (const mutate of [
    value => { value.version = 'wrong'; },
    value => { value.nodes.pop(); },
    value => { value.nodes[0].type = 'arbitrary'; },
    value => { value.edges.push({ source: 'card:op-think', target: 'card:unknown', type: 'related_to' }); },
    value => { value.edges.push({ source: 'source:dictionary-1', target: 'card:op-think', type: 'related_to' }); },
    value => { value.edges = value.edges.filter(edge => edge.type !== 'contrasts_with'); },
  ]) {
    const changed = structuredClone(graph); mutate(changed);
    assert.throws(() => createKnowledgeIndex({ ...data, edges: changed }), TypeError);
  }
});

test('arbitrary edge references and undeclared card relationships are rejected', () => {
  assert.equal(typeof createKnowledgeIndex, 'function');
  const data = fixture();
  assert.throws(() => createKnowledgeIndex({ ...data, edges: [{ source: 'card:op-think', target: 'card:missing', type: 'related_to' }] }), TypeError);
  assert.throws(() => createKnowledgeIndex({ ...data, edges: [{ source: 'card:op-think', target: 'card:reason-because', type: 'related_to' }] }), TypeError);
});

test('unavailable or forged indexes surface unavailable without fabricated knowledge', () => {
  for (const index of [null, {}, { status: 'unavailable', reason: 'missing_or_invalid_corpus' }, { status: 'ready', cards: fixture().cards }]) {
    const result = retrieveKnowledge(index, { text: 'I think' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.corpusVersion, null);
    assert.deepEqual(result.cards, []);
  }
});

test('default loader reads only fixed corpus paths and does not accept arbitrary caller paths', () => {
  const loaderSource = readFileSync(fileURLToPath(new URL('../knowledge-store.mjs', import.meta.url)), 'utf8');
  assert.match(loaderSource, /source-register\.json/);
  assert.match(loaderSource, /expression-cards\.jsonl/);
  assert.match(loaderSource, /knowledge-graph\.json/);
  assert.doesNotMatch(loaderSource, /\.env|process\.env|fetch\(|https?:/);
  assert.equal(store.loadDefaultKnowledgeIndex.length, 0);
  const index = store.loadDefaultKnowledgeIndex();
  assert.ok(['ready', 'unavailable'].includes(index.status));
  assert.equal(store.loadDefaultKnowledgeIndex(), index);
});

function withIsolatedStore(run) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-store-test-'));
  const modules = join(root, 'qwen-probe'), artifacts = join(root, 'docs', 'knowledge');
  mkdirSync(modules); mkdirSync(artifacts, { recursive: true });
  for (const name of ['knowledge.mjs', 'knowledge-store.mjs']) copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(modules, name));
  const data = fixture();
  const paths = { sources: join(artifacts, 'source-register.json'), cards: join(artifacts, 'expression-cards.jsonl'), graph: join(artifacts, 'knowledge-graph.json') };
  writeFileSync(paths.sources, JSON.stringify({ version: data.version, sources: data.sources }));
  writeFileSync(paths.cards, data.cards.map(value => JSON.stringify(value)).join('\n'));
  writeFileSync(paths.graph, JSON.stringify(buildKnowledgeGraph(data)));
  const load = () => {
    const script = `import { loadDefaultKnowledgeIndex } from ${JSON.stringify(pathToFileURL(join(modules, 'knowledge-store.mjs')).href)}; import { retrieveKnowledge } from ${JSON.stringify(pathToFileURL(join(modules, 'knowledge.mjs')).href)}; const index=loadDefaultKnowledgeIndex(); const result=retrieveKnowledge(index,{text:'I think'}); process.stdout.write(JSON.stringify({status:index.status,result,cacheSame:index===loadDefaultKnowledgeIndex()}));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  try { run({ load, paths, data }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('the fixed loader loads a complete validated local corpus without network access', () => {
  withIsolatedStore(({ load }) => {
    const result = load();
    assert.equal(result.status, 'ready');
    assert.equal(result.result.status, 'matched');
    assert.equal(result.result.corpusVersion, 'fixture.v1');
    assert.equal(result.cacheSame, true);
  });
});

test('a missing local artifact produces unavailable rather than fallback material', () => {
  for (const field of ['sources', 'cards', 'graph']) withIsolatedStore(({ load, paths }) => {
    unlinkSync(paths[field]);
    const result = load();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.result.status, 'unavailable');
    assert.deepEqual(result.result.cards, []);
    assert.equal(result.cacheSame, true);
  });
});

test('corrupt JSON, invalid references and stale graph versions produce unavailable', () => {
  for (const mode of ['source-json', 'card-json', 'card-source', 'graph-version']) withIsolatedStore(({ load, paths, data }) => {
    if (mode === 'source-json') writeFileSync(paths.sources, '{broken');
    if (mode === 'card-json') writeFileSync(paths.cards, '{broken');
    if (mode === 'card-source') {
      data.cards[0].source_refs = ['unknown-source'];
      writeFileSync(paths.cards, data.cards.map(value => JSON.stringify(value)).join('\n'));
    }
    if (mode === 'graph-version') writeFileSync(paths.graph, JSON.stringify({ ...buildKnowledgeGraph(data), version: 'stale' }));
    const result = load();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.result.status, 'unavailable');
    assert.deepEqual(result.result.cards, []);
  });
});
