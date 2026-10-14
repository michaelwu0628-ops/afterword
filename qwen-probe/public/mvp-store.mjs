const DATABASE = 'speaking-practice-local-v1';
const STORES = ['practices', 'reviewItems', 'reviewPolicy'];
const MAX_LOCAL_MEDIA_BYTES = 50 * 1024 * 1024;
const clone = value => value === undefined ? undefined : structuredClone(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlob = value => typeof Blob !== 'undefined' && value instanceof Blob;
const text = (value, limit = 12000) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const number = value => Number.isFinite(value) ? value : undefined;
const strings = (value, count = 20, limit = 3000) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, count).map(item => item.slice(0, limit)) : undefined;
function fields(source, schema) {
  if (!isObject(source)) return undefined;
  const result = {};
  for (const [key, clean] of Object.entries(schema)) {
    if (!Object.hasOwn(source, key)) continue;
    const value = clean(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
const shortText = value => text(value, 3000);
const cue = value => fields(value, { start: number, end: number, text: value => text(value, 12000), zh: value => text(value, 12000) });
const topic = value => fields(value, { id: shortText, category: shortText, title: shortText, prompt: shortText, bullets: value => strings(value, 8) });
function material(value) {
  const result = fields(value, {
    title: shortText, url: shortText, mediaUrl: shortText, kind: shortText, duration: number,
    status: shortText, message: shortText, transcriptKind: value => ['source', 'manual_timed', 'manual_selected_segment'].includes(value) ? value : undefined,
    start: number, end: number, selectedStart: number, selectedEnd: number, selectedText: value => text(value, 12000),
    cues: value => Array.isArray(value) ? value.slice(0, 10000).map(cue).filter(Boolean) : undefined,
    mediaBlob: value => isBlob(value) ? value : undefined,
  });
  if (result?.mediaBlob?.size > MAX_LOCAL_MEDIA_BYTES) throw new RangeError('Local media exceeds 50 MB');
  return result;
}
const sourceReference = value => fields(value, { id: shortText, title: shortText, url: shortText, publisher: shortText, tier: shortText });
const knowledgeReference = value => fields(value, {
  knowledgeId: shortText, expression: shortText, groundingScope: shortText,
  sources: value => Array.isArray(value) ? value.slice(0, 4).map(sourceReference).filter(Boolean) : undefined,
});
function cleanSuggestion(value) {
  const result = fields(value, {
    original: shortText, suggestion: shortText, reason: shortText,
    kind: value => ['correction', 'optional'].includes(value) ? value : undefined,
    knowledge_ids: value => strings(value, 2, 256),
    evidence: value => fields(value, { turnId: shortText, text: value => text(value, 12000) }),
    knowledgeSources: value => Array.isArray(value) ? value.slice(0, 2).map(knowledgeReference).filter(Boolean) : undefined,
  });
  return result && ['original', 'suggestion', 'reason'].every(key => result[key]?.trim()) && result.original.trim() !== result.suggestion.trim() ? result : undefined;
}
const knowledge = value => fields(value, {
  status: shortText, method: shortText, corpusVersion: shortText, retrievedIds: value => strings(value, 24, 256),
});
function assessmentAxis(value, textAssessment = true) {
  if (!isObject(value)) return undefined;
  if (value.status === 'unavailable') return fields(value, { status: shortText, reason: shortText });
  if (textAssessment && value.status === 'assessed' && value.basis === 'transcript') return fields(value, {
    status: shortText, basis: shortText, feedback: shortText,
    evidence: value => fields(value, { turnId: shortText, text: value => text(value, 24000), quote: shortText }),
  });
  return undefined;
}
const part2Assessment = value => fields(value, {
  lexical: assessmentAxis, grammar: assessmentAxis, organisation: assessmentAxis,
  pronunciation: value => assessmentAxis(value, false), score: value => assessmentAxis(value, false),
});
const review = value => fields(value, {
  assessment: shortText, summary: shortText, knowledge, part2Assessment,
  suggestions: value => Array.isArray(value) ? value.map(cleanSuggestion).filter(Boolean).slice(0, 3) : undefined,
});
const turn = value => fields(value, {
  id: shortText, role: shortText, text: value => text(value, 24000), phase: shortText,
  audio: value => isBlob(value) ? value : undefined, duration: number,
  incomplete: value => typeof value === 'boolean' ? value : undefined,
});
const timestamp = value => typeof value === 'string' ? value.slice(0, 100) : number(value);
function cleanPractice(value) {
  if (!isObject(value) || !Object.hasOwn(value, 'id') || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) throw new TypeError('A practice id is required');
  return fields(value, {
    id: value => text(value, 256), mode: shortText, title: shortText,
    createdAt: timestamp, updatedAt: timestamp, status: shortText, material, topic,
    notes: value => text(value, 12000), turns: value => Array.isArray(value) ? value.slice(0, 1000).map(turn).filter(Boolean) : undefined,
    review, independentAudio: value => isBlob(value) ? value : undefined,
    independentDuration: number, relatedPracticeId: value => text(value, 256),
  });
}
function normalize(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Import uses the same allowlist as ordinary saves, but rejects corrupt known
// fields instead of silently truncating or dropping them. Unknown fields never
// cross this boundary (in particular service credentials and derived items).
const invalid = path => { throw new TypeError(`Invalid backup data at ${path}`); };
const boundedText = (limit, nonempty = false) => (value, path) => {
  if (typeof value !== 'string' || value.length > limit || (nonempty && !value.trim())) invalid(path);
  return value;
};
const finiteNumber = (value, path) => { if (!Number.isFinite(value)) invalid(path); return value; };
const nonnegativeNumber = (value, path) => { finiteNumber(value, path); if (value < 0) invalid(path); return value; };
const booleanValue = (value, path) => { if (typeof value !== 'boolean') invalid(path); return value; };
const choice = values => (value, path) => { if (!values.includes(value)) invalid(path); return value; };
const arrayOf = (validate, maximum) => (value, path) => {
  if (!Array.isArray(value)) invalid(path);
  if (value.length > maximum) throw new RangeError(`Backup ${path} exceeds maximum ${maximum}`);
  return Array.from(value, (item, index) => validate(item, `${path}[${index}]`));
};
function recordOf(schema, required = []) {
  return (value, path) => {
    if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${path} (plain object required)`);
    for (const key of ['__proto__', 'prototype', 'constructor']) if (Object.hasOwn(value, key)) invalid(`${path} (unsafe prototype key)`);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
    const result = {};
    for (const [key, validate] of Object.entries(schema)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) invalid(`${path}.${key}`);
      result[key] = validate(descriptor.value, `${path}.${key}`);
    }
    return result;
  };
}
const importedText = boundedText(3000), longText = boundedText(12000), idText = boundedText(256, true);
const mediaType = /^(?:audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[ -~]*)?$/;
const mediaValue = (value, path) => { if (!isBlob(value) || !mediaType.test(value.type)) invalid(`${path} (audio/video MIME blob required)`); return value; };
const importCue = recordOf({ start: nonnegativeNumber, end: nonnegativeNumber, text: longText, zh: longText });
const importTopic = recordOf({ id: importedText, category: importedText, title: importedText, prompt: importedText, bullets: arrayOf(importedText, 8) });
const importMaterial = recordOf({
  title: importedText, url: importedText, mediaUrl: importedText, kind: importedText, duration: nonnegativeNumber,
  status: importedText, message: importedText, transcriptKind: choice(['source', 'manual_timed', 'manual_selected_segment']),
  start: nonnegativeNumber, end: nonnegativeNumber, selectedStart: nonnegativeNumber, selectedEnd: nonnegativeNumber, selectedText: longText,
  cues: arrayOf(importCue, 10000), mediaBlob: (value, path) => { mediaValue(value, path); if (value.size > MAX_LOCAL_MEDIA_BYTES) throw new RangeError('Local media exceeds 50 MB'); return value; },
});
const importSource = recordOf({ id: importedText, title: importedText, url: importedText, publisher: importedText, tier: importedText });
const importKnowledgeReference = recordOf({ knowledgeId: importedText, expression: importedText, groundingScope: importedText, sources: arrayOf(importSource, 4) });
const importSuggestionRecord = recordOf({
  original: boundedText(3000, true), suggestion: boundedText(3000, true), reason: boundedText(3000, true), kind: choice(['correction', 'optional']),
  knowledge_ids: arrayOf(boundedText(256), 2), evidence: recordOf({ turnId: importedText, text: longText }),
  knowledgeSources: arrayOf(importKnowledgeReference, 2),
}, ['original', 'suggestion', 'reason']);
const importSuggestion = (value, path) => {
  const result = importSuggestionRecord(value, path);
  if (result.original.trim() === result.suggestion.trim()) invalid(path);
  return result;
};
const importKnowledge = recordOf({ status: importedText, method: importedText, corpusVersion: importedText, retrievedIds: arrayOf(boundedText(256), 24) });
const importUnavailableAxis = recordOf({ status: choice(['unavailable']), reason: importedText }, ['status']);
const importAssessedAxis = recordOf({ status: choice(['assessed']), basis: choice(['transcript']), feedback: importedText, evidence: recordOf({ turnId: importedText, text: boundedText(24000), quote: importedText }) }, ['status', 'basis']);
const importAxis = (value, path) => {
  if (!isObject(value)) invalid(path);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'status');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`${path}.status`);
  return descriptor.value === 'unavailable' ? importUnavailableAxis(value, path) : importAssessedAxis(value, path);
};
const importAssessment = recordOf({ lexical: importAxis, grammar: importAxis, organisation: importAxis, pronunciation: importUnavailableAxis, score: importUnavailableAxis });
const importReview = recordOf({ assessment: importedText, summary: importedText, knowledge: importKnowledge, part2Assessment: importAssessment, suggestions: arrayOf(importSuggestion, 3) });
const importTurn = recordOf({ id: importedText, role: importedText, text: boundedText(24000), phase: importedText, audio: mediaValue, duration: nonnegativeNumber, incomplete: booleanValue });
const importTimestamp = (value, path) => {
  if (typeof value === 'number') return nonnegativeNumber(value, path);
  boundedText(100, true)(value, path); if (!Number.isFinite(Date.parse(value))) invalid(path); return value;
};
const importPractice = recordOf({
  id: idText, mode: choice(['material', 'part2']), title: importedText, createdAt: importTimestamp, updatedAt: importTimestamp,
  status: importedText, material: importMaterial, topic: importTopic, notes: longText, turns: arrayOf(importTurn, 1000), review: importReview,
  independentAudio: mediaValue, independentDuration: nonnegativeNumber, relatedPracticeId: boundedText(256),
}, ['id']);
const importPolicyRecord = recordOf({ expression: boundedText(3000, true), status: choice(['active', 'stopped', 'deleted']) }, ['expression', 'status']);
const importPolicy = (value, path) => {
  const result = importPolicyRecord(value, path); result.expression = normalize(result.expression);
  if (!result.expression || result.expression.length > 3000) invalid(`${path}.expression`);
  return result;
};

export function sanitizePracticeData(value) {
  return recordOf({ practices: arrayOf(importPractice, 1000), reviewPolicy: arrayOf(importPolicy, 10000) }, ['practices', 'reviewPolicy'])(value, 'data');
}

const policyPriority = { active: 0, stopped: 1, deleted: 2 };
function mergePolicies(values) {
  const result = new Map();
  for (const value of values) {
    const previous = result.get(value.expression);
    if (!previous || policyPriority[value.status] > policyPriority[previous.status]) result.set(value.expression, value);
  }
  return result;
}
function derivedItems(practice, policies) {
  const items = [], used = new Set();
  for (const suggestion of practice.review?.suggestions || []) {
    const expression = normalize(suggestion.suggestion), status = policies.get(expression)?.status;
    if (!expression || used.has(expression) || status === 'deleted') continue;
    used.add(expression);
    items.push({ id: JSON.stringify([practice.id, expression]), practiceId: practice.id, original: suggestion.original, suggestion: suggestion.suggestion, reason: suggestion.reason, status: status === 'stopped' ? 'stopped' : 'active' });
  }
  return items;
}
const timeValue = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const recentFirst = (a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt) || a.id.localeCompare(b.id);
function createStore(transact) {
  const read = fn => transact('readonly', fn), write = fn => transact('readwrite', fn);
  return {
    exportData: () => read(async db => {
      const [practices, reviewPolicy] = await Promise.all([db.all('practices'), db.all('reviewPolicy')]);
      return sanitizePracticeData({ practices: practices.sort(recentFirst), reviewPolicy: reviewPolicy.sort((a, b) => a.expression.localeCompare(b.expression)) });
    }),
    importData(value) {
      let incoming;
      try { incoming = sanitizePracticeData(value); } catch (error) { return Promise.reject(error); }
      return write(async db => {
        const [existing, previousPolicies] = await Promise.all([db.all('practices'), db.all('reviewPolicy')]);
        const practices = new Map(existing.map(item => [item.id, item]));
        const policies = mergePolicies([...previousPolicies.map((item, index) => importPolicy(item, `reviewPolicy[${index}]`)), ...incoming.reviewPolicy]);
        let imported = 0, skipped = 0;
        const additions = [];
        for (const practice of incoming.practices) {
          if (practices.has(practice.id)) { skipped++; continue; }
          practice.createdAt ??= Date.now(); practice.updatedAt ??= practice.createdAt;
          practices.set(practice.id, practice); additions.push(practice); imported++;
        }
        if (practices.size > 1000 || policies.size > 10000) throw new RangeError('Import exceeds maximum 1000 practices or 10000 review policies');
        for (const practice of additions) await db.put('practices', practice);
        await db.clear('reviewPolicy');
        for (const policy of policies.values()) await db.put('reviewPolicy', policy);
        await db.clear('reviewItems');
        for (const practice of practices.values()) for (const item of derivedItems(practice, policies)) await db.put('reviewItems', item);
        return { imported, skipped };
      });
    },
    listPractices: () => read(async db => (await db.all('practices')).sort(recentFirst)),
    getPractice: id => read(async db => (await db.get('practices', id)) ?? null),
    putPractice(value) {
      // Snapshot before opening the asynchronous transaction: callers may continue
      // editing their current practice while a save is in progress.
      let practice;
      try { practice = clone(cleanPractice(value)); } catch (error) { return Promise.reject(error); }
      return write(async db => {
        const previous = await db.get('practices', practice.id);
        practice.createdAt ??= previous?.createdAt ?? Date.now();
        practice.updatedAt ??= Date.now();
        await db.put('practices', practice);
        for (const item of await db.all('reviewItems')) if (item.practiceId === practice.id) await db.delete('reviewItems', item.id);
        const used = new Set();
        for (const suggestion of practice.review?.suggestions || []) {
          const expression = normalize(suggestion.suggestion);
          if (!expression || used.has(expression)) continue;
          used.add(expression);
          const policy = await db.get('reviewPolicy', expression);
          if (policy?.status === 'deleted') continue;
          await db.put('reviewItems', {
            id: JSON.stringify([practice.id, expression]), practiceId: practice.id,
            original: suggestion.original, suggestion: suggestion.suggestion, reason: suggestion.reason,
            status: policy?.status === 'stopped' ? 'stopped' : 'active',
          });
        }
        return practice;
      });
    },
    deletePractice: id => write(async db => {
      const present = await db.get('practices', id);
      await db.delete('practices', id);
      for (const item of await db.all('reviewItems')) if (item.practiceId === id) await db.delete('reviewItems', item.id);
      return Boolean(present);
    }),
    clear: () => write(async db => { for (const name of STORES) await db.clear(name); }),
    listReviewItems: () => read(async db => (await db.all('reviewItems')).sort((a, b) => a.id.localeCompare(b.id))),
    setReviewStatus(id, status) {
      if (!['active', 'stopped'].includes(status)) return Promise.reject(new TypeError('Invalid review status'));
      return write(async db => {
        const item = await db.get('reviewItems', id);
        if (!item) return null;
        const expression = normalize(item.suggestion);
        await db.put('reviewPolicy', { expression, status });
        for (const candidate of await db.all('reviewItems')) {
          if (normalize(candidate.suggestion) === expression) await db.put('reviewItems', { ...candidate, status });
        }
        return { ...item, status };
      });
    },
    deleteReviewItem: id => write(async db => {
      const item = await db.get('reviewItems', id);
      if (!item) return false;
      const expression = normalize(item.suggestion);
      // An expression policy survives a practice update or a different session.
      await db.put('reviewPolicy', { expression, status: 'deleted' });
      for (const candidate of await db.all('reviewItems')) if (normalize(candidate.suggestion) === expression) await db.delete('reviewItems', candidate.id);
      return true;
    }),
    getReviewContext: () => read(async db => {
      const practices = new Map((await db.all('practices')).map(item => [item.id, item]));
      const items = (await db.all('reviewItems')).filter(item => item.status === 'active')
        .sort((a, b) => recentFirst(practices.get(a.practiceId) || { id: a.id }, practices.get(b.practiceId) || { id: b.id }));
      const context = [], used = new Set();
      for (const item of items) {
        const expression = normalize(item.suggestion);
        if (used.has(expression)) continue;
        used.add(expression); context.push({ expression: item.suggestion, usage: item.reason });
        if (context.length === 3) break;
      }
      return context;
    }),
  };
}

export function createMemoryPracticeStore() {
  let stores = new Map(STORES.map(name => [name, new Map()])), queue = Promise.resolve();
  return createStore((mode, callback) => {
    const work = queue.then(async () => {
      const working = mode === 'readwrite' ? clone(stores) : stores;
      const db = {
        get: async (name, id) => clone(working.get(name).get(id)),
        all: async name => clone([...working.get(name).values()]),
        put: async (name, value) => { working.get(name).set(value.id ?? value.expression, clone(value)); },
        delete: async (name, id) => { working.get(name).delete(id); },
        clear: async name => { working.get(name).clear(); },
      };
      const result = await callback(db);
      if (mode === 'readwrite') stores = working;
      return clone(result);
    });
    queue = work.catch(() => {});
    return work;
  });
}

export function createPracticeStore({ indexedDB = globalThis.indexedDB } = {}) {
  let opening;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!indexedDB?.open) { reject(new Error('IndexedDB is unavailable; practice was not saved')); return; }
      const request = indexedDB.open(DATABASE, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'reviewPolicy' ? 'expression' : 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => { blocked = true; reject(new Error('IndexedDB upgrade is blocked; close other practice tabs')); };
    }).catch(error => { opening = undefined; throw error; });
    return opening;
  }
  return createStore(async (mode, callback) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORES, mode);
      let result, failure;
      transaction.oncomplete = () => resolve(clone(result));
      transaction.onabort = () => reject(failure || transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => { /* onabort carries the original failure. */ };
      const request = work => new Promise((yes, no) => {
        let pending;
        try { pending = work(); } catch (error) { no(error); return; }
        pending.onsuccess = () => yes(pending.result);
        pending.onerror = () => no(pending.error || new Error('IndexedDB request failed'));
      });
      const db = {
        get: (name, id) => request(() => transaction.objectStore(name).get(id)),
        all: name => request(() => transaction.objectStore(name).getAll()),
        put: (name, value) => request(() => transaction.objectStore(name).put(value)),
        delete: (name, id) => request(() => transaction.objectStore(name).delete(id)),
        clear: name => request(() => transaction.objectStore(name).clear()),
      };
      Promise.resolve().then(() => callback(db)).then(value => { result = value; }, error => {
        failure = error;
        try { transaction.abort(); } catch { reject(error); }
      });
    });
  });
}
