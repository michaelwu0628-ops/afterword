// Local lexical retrieval: standard BM25 (k1=1.2, b=0.75), phrase/intent
// bonuses, and explicit one-hop card relations. This is not embedding search.
const METHOD = 'bm25-intent-graph-v1';
const MAX_CARDS = 6;
const MAX_RETURNED_CARDS = 4;
const MAX_CONTEXT_CHARS = 6000;
const MAX_EXPANDED = 24;
const INTENTS = new Set(['opinion', 'reasons', 'experience', 'comparison']);
const RELATIONS = new Set(['contrasts_with', 'related_to']);
const STATE = new WeakMap();
const STOPWORDS = new Set(('a an the i me my we our you your he she it they their am is are was were be been being and or of to in on at for from with this that these those as by do does did have has had can could will would shall should may might must so very d m s t ll re ve').split(' '));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const invalid = message => { throw new TypeError(`Invalid knowledge corpus: ${message}`); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyJson(value) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 4_000_000) invalid('data exceeds local size limit');
    return JSON.parse(serialized);
  } catch { invalid('data must be bounded JSON'); }
}

function stringArray(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some(item => !nonempty(item))) invalid(field);
}

function validateCorpus({ version, sources, cards } = {}) {
  if (!nonempty(version) || version.length > 128) invalid('version');
  if (!Array.isArray(sources) || !sources.length || sources.length > 5000) invalid('sources');
  if (!Array.isArray(cards) || !cards.length || cards.length > 10000) invalid('cards');
  const data = copyJson({ version, sources, cards });
  const sourceIds = new Map();
  for (const source of data.sources) {
    if (!isRecord(source) || !idValid(source.id) || sourceIds.has(source.id)) invalid('source id');
    for (const field of ['title', 'url', 'publisher', 'tier', 'read_status', 'rights']) {
      if (!nonempty(source[field])) invalid(`source ${field}`);
    }
    if (typeof source.approved_for_runtime !== 'boolean') invalid('source approval');
    let url;
    try { url = new URL(source.url); } catch { invalid('source URL'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) invalid('source must have a public HTTPS reference');
    sourceIds.set(source.id, source);
  }
  const cardIds = new Map();
  for (const card of data.cards) {
    if (!isRecord(card) || !idValid(card.id) || cardIds.has(card.id)) invalid('card id');
    if (!INTENTS.has(card.intent)) invalid('card intent');
    for (const field of ['expression', 'meaning', 'register', 'usage']) {
      if (!nonempty(card[field])) invalid(`card ${field}`);
    }
    if (typeof card.pitfalls === 'string') {
      if (!nonempty(card.pitfalls)) invalid('card pitfalls');
    } else stringArray(card.pitfalls, 'card pitfalls');
    for (const field of ['collocations', 'aliases', 'examples']) stringArray(card[field], `card ${field}`);
    stringArray(card.source_refs, 'card source_refs', { nonEmpty: true });
    if (new Set(card.source_refs).size !== card.source_refs.length) invalid('duplicate source reference');
    for (const sourceId of card.source_refs) {
      const source = sourceIds.get(sourceId);
      if (!source || source.approved_for_runtime !== true || /(?:fail|blocked|unavailable|unread|not[_ -]read|not[_ -]opened)/i.test(source.read_status)) invalid('unapproved or unread card source');
    }
    if (!Array.isArray(card.relations)) invalid('card relations');
    cardIds.set(card.id, card);
  }
  for (const card of data.cards) {
    const relations = new Set();
    for (const relation of card.relations) {
      if (!isRecord(relation) || !RELATIONS.has(relation.type) || !cardIds.has(relation.target) || relation.target === card.id) invalid('unknown card relation');
      const key = `${relation.type}:${relation.target}`;
      if (relations.has(key)) invalid('duplicate card relation');
      relations.add(key);
    }
  }
  data.sources.sort((a, b) => compare(a.id, b.id));
  data.cards.sort((a, b) => compare(a.id, b.id));
  return data;
}

const edgeKey = edge => `${edge.source}\u0000${edge.type}\u0000${edge.target}`;
function deriveGraph({ version, sources, cards }) {
  const nodes = new Map(), edges = new Map();
  const addNode = (id, type) => nodes.set(id, { id, type });
  const addEdge = (source, target, type) => {
    const edge = { source, target, type }; edges.set(edgeKey(edge), edge);
  };
  for (const source of sources) addNode(`source:${source.id}`, 'source');
  for (const card of cards) {
    const id = `card:${card.id}`;
    addNode(id, 'card');
    addNode(`intent:${card.intent}`, 'intent');
    addNode(`register:${card.register}`, 'register');
    addEdge(id, `intent:${card.intent}`, 'expresses_intent');
    addEdge(id, `register:${card.register}`, 'has_register');
    for (const sourceId of card.source_refs) addEdge(id, `source:${sourceId}`, 'supported_by');
    for (const relation of card.relations) addEdge(id, `card:${relation.target}`, relation.type);
  }
  return {
    version,
    nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => compare(edgeKey(a), edgeKey(b))),
  };
}

/** Deterministic, reproducible graph artifact; no IO and no model calls. */
export function buildKnowledgeGraph(input) {
  return freeze(deriveGraph(validateCorpus(input)));
}

function validateGraph(input, expected) {
  if (input === undefined) return expected;
  const graph = Array.isArray(input) ? { version: expected.version, nodes: expected.nodes, edges: input } : input;
  if (!isRecord(graph) || graph.version !== expected.version || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) invalid('graph structure or version');
  const expectedNodes = new Map(expected.nodes.map(node => [node.id, node.type]));
  const seenNodes = new Set();
  for (const node of graph.nodes) {
    if (!isRecord(node) || expectedNodes.get(node.id) !== node.type || seenNodes.has(node.id)) invalid('graph node');
    seenNodes.add(node.id);
  }
  if (seenNodes.size !== expectedNodes.size) invalid('missing graph node');
  const expectedKeys = new Set(expected.edges.map(edgeKey)), seenEdges = new Set();
  for (const edge of graph.edges) {
    if (!isRecord(edge) || !expectedNodes.has(edge.source) || !expectedNodes.has(edge.target) || !expectedKeys.has(edgeKey(edge)) || seenEdges.has(edgeKey(edge))) invalid('graph edge');
    seenEdges.add(edgeKey(edge));
  }
  // Arrays can contain the explicit card relations alone; graph files must also
  // preserve all provenance edges. Neither form may invent new relationships.
  const required = Array.isArray(input) && input.every(edge => RELATIONS.has(edge.type))
    ? expected.edges.filter(edge => RELATIONS.has(edge.type)) : expected.edges;
  if (required.some(edge => !seenEdges.has(edgeKey(edge)))) invalid('graph inconsistent with cards');
  return expected;
}

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[’']/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tokenize(text) {
  const result = [];
  for (const term of normalize(text).match(/[\p{L}\p{N}]+/gu) || []) {
    if (/^\p{Script=Han}+$/u.test(term)) {
      if (term.length <= 4) result.push(term);
      for (let i = 0; i < term.length - 1; i++) result.push(term.slice(i, i + 2));
    } else if (!STOPWORDS.has(term)) result.push(term);
  }
  return result;
}

function documentText(card) {
  return [card.expression, ...card.aliases, card.meaning, card.register, card.usage, ...(Array.isArray(card.pitfalls) ? card.pitfalls : [card.pitfalls]), ...card.collocations, ...card.examples, card.intent].join(' ');
}

/** Validates and snapshots all input. Scoring maps are private and immutable to callers. */
export function createKnowledgeIndex(input = {}) {
  const data = validateCorpus(input);
  const graph = validateGraph(input.edges, deriveGraph(data));
  const documents = new Map(), frequencies = new Map(), neighbors = new Map();
  let totalLength = 0;
  for (const card of data.cards) {
    const tokens = tokenize(documentText(card)), counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const token of counts.keys()) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    totalLength += tokens.length;
    documents.set(card.id, { card, counts, length: tokens.length });
    neighbors.set(card.id, new Set());
  }
  for (const edge of graph.edges) {
    if (!RELATIONS.has(edge.type)) continue;
    const source = edge.source.slice(5), target = edge.target.slice(5);
    // Both relation types describe a pair; no traversal of provenance nodes.
    neighbors.get(source).add(target); neighbors.get(target).add(source);
  }
  const index = freeze({ status: 'ready', version: data.version, corpusVersion: data.version, cards: data.cards, sources: data.sources, graph });
  STATE.set(index, { documents, frequencies, neighbors, averageLength: totalLength / data.cards.length });
  return index;
}

function queryIntent(text) {
  const intents = new Set();
  if (/\b(think|believe|opinion|view|agree|disagree|feel)\b|观点|看法|认为/u.test(text)) intents.add('opinion');
  if (/\b(because|reason|reasons|why|therefore)\b|\bdue to\b|原因|理由|因为/u.test(text)) intents.add('reasons');
  if (/\b(remember|ago|yesterday|experience)\b|\b(used to|last time|have ever)\b|经历|过去|以前/u.test(text)) intents.add('experience');
  if (/\b(than|compare|comparison|whereas|unlike|prefer|rather|different|similar)\b|比较|相比|区别/u.test(text)) intents.add('comparison');
  return intents;
}

function queryRegister(text) {
  if (/\b(informal|casual|conversational)\b|口语|非正式/u.test(text)) return 'conversational';
  if (/\b(formal|academic)\b|正式|学术/u.test(text)) return 'formal';
  return null;
}

const boundedInt = (value, fallback, maximum) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
const round = value => Number(value.toFixed(6));
function outcome(status, version, cards = [], trace = {}) {
  return freeze({ status, method: METHOD, corpusVersion: version, cards, trace: { seedIds: [], expandedIds: [], selectedIds: [], scores: [], contextChars: JSON.stringify(cards).length, ...trace } });
}

/** Trace contains only bounded IDs and numeric scores, never query text/tokens. */
export function retrieveKnowledge(index, { text = '', topK = 4, maxChars = MAX_CONTEXT_CHARS, graph = true } = {}) {
  const state = index && STATE.get(index);
  if (!state) return outcome('unavailable', null, [], { reason: 'missing_or_invalid_corpus' });
  const limit = boundedInt(topK, 4, MAX_RETURNED_CARDS), budget = boundedInt(maxChars, MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS);
  const query = typeof text === 'string' ? text.slice(0, 20000) : '';
  const tokens = [...new Set(tokenize(query))].slice(0, 256);
  const normalized = normalize(query);
  // "For me" is an informative reviewed expression despite containing only
  // stopwords. This exception requires an exact known multiword phrase.
  const exactPhraseIds = new Set(normalized.includes(' ') ? index.cards.filter(card => [card.expression, ...card.aliases].some(phrase => normalize(phrase) === normalized)).map(card => card.id) : []);
  if ((!tokens.length && !exactPhraseIds.size) || !limit) return outcome('no_match', index.version, [], { reason: 'uninformative_query' });
  const intents = queryIntent(normalized), register = queryRegister(normalized);
  const count = state.documents.size, ranked = [];
  for (const { card, counts, length } of state.documents.values()) {
    let bm25 = 0;
    for (const token of tokens) {
      const tf = counts.get(token) || 0;
      if (!tf) continue;
      const df = state.frequencies.get(token), idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      bm25 += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / (state.averageLength || 1)));
    }
    if (!bm25 && !exactPhraseIds.has(card.id)) continue;
    const phraseBonus = [card.expression, ...card.aliases].some(phrase => {
      const normalizedPhrase = normalize(phrase);
      return (tokenize(phrase).length > 0 || exactPhraseIds.has(card.id)) && normalizedPhrase.length > 1 && ` ${normalized} `.includes(` ${normalizedPhrase} `);
    }) ? 2 : 0;
    const intentBoost = intents.has(card.intent) ? 0.35 : 0;
    const registerBoost = register && (card.register.includes(register) || (register === 'formal' && card.register.includes('academic'))) ? 0.2 : 0;
    ranked.push({ id: card.id, score: bm25 + phraseBonus + intentBoost + registerBoost, bm25, phraseBonus, intentBoost, registerBoost, graphBoost: 0, via: null });
  }
  const byRank = (a, b) => b.score - a.score || compare(a.id, b.id);
  ranked.sort(byRank);
  if (!ranked.length) return outcome('no_match', index.version, [], { reason: 'no_lexical_match' });
  const seeds = ranked.slice(0, MAX_CARDS), candidates = new Map(ranked.map(item => [item.id, item])), expanded = new Map();
  if (graph === true) {
    for (const seed of seeds) {
      for (const id of [...state.neighbors.get(seed.id)].sort(compare)) {
        const graphBoost = seed.score * 0.45;
        const existing = expanded.get(id) || candidates.get(id);
        if (!existing || existing.graphBoost < graphBoost) {
          const candidate = existing ? { ...existing, score: existing.score - existing.graphBoost + graphBoost, graphBoost, via: seed.id }
            : { id, score: graphBoost, bm25: 0, phraseBonus: 0, intentBoost: 0, registerBoost: 0, graphBoost, via: seed.id };
          expanded.set(id, candidate);
        }
      }
    }
    // Bound expansion before merging. Seeds never include expanded neighbors,
    // which prevents two-hop traversal and shared-source expansion.
    for (const candidate of [...expanded.values()].sort(byRank).slice(0, MAX_EXPANDED)) candidates.set(candidate.id, candidate);
  }
  const allRanked = [...candidates.values()].sort(byRank), selected = [], usedIntents = new Map(), usedSources = new Map();
  let contextChars = 2;
  const remaining = [...allRanked];
  while (remaining.length && selected.length < limit) {
    // Mild tie-level diversification; substantial lexical/phrase evidence wins.
    remaining.sort((a, b) => {
      const adjust = item => {
        const card = state.documents.get(item.id).card;
        const repeatIntent = usedIntents.get(card.intent) || 0;
        const repeatSource = Math.max(0, ...card.source_refs.map(id => usedSources.get(id) || 0));
        return item.score / (1 + 0.03 * repeatIntent + 0.02 * repeatSource);
      };
      return adjust(b) - adjust(a) || byRank(a, b);
    });
    const candidate = remaining.shift(), card = state.documents.get(candidate.id).card;
    const chars = JSON.stringify(card).length + (selected.length ? 1 : 0);
    if (contextChars + chars > budget) continue;
    selected.push(card); contextChars += chars;
    usedIntents.set(card.intent, (usedIntents.get(card.intent) || 0) + 1);
    for (const id of card.source_refs) usedSources.set(id, (usedSources.get(id) || 0) + 1);
  }
  const scoreRows = allRanked.slice(0, MAX_CARDS + MAX_EXPANDED).map(item => ({ ...item, score: round(item.score), bm25: round(item.bm25), graphBoost: round(item.graphBoost) }));
  return outcome(selected.length ? 'matched' : 'no_match', index.version, selected, {
    reason: selected.length ? 'ranked_match' : 'context_limit',
    seedIds: seeds.map(item => item.id), expandedIds: graph === true ? [...expanded.values()].sort(byRank).slice(0, MAX_EXPANDED).map(item => item.id) : [],
    selectedIds: selected.map(card => card.id), scores: scoreRows, contextChars,
  });
}
