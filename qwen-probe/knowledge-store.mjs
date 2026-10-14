import { readFileSync, statSync } from 'node:fs';
import { createKnowledgeIndex } from './knowledge.mjs';

const paths = Object.freeze({
  sources: new URL('../docs/knowledge/source-register.json', import.meta.url),
  cards: new URL('../docs/knowledge/expression-cards.jsonl', import.meta.url),
  graph: new URL('../docs/knowledge/knowledge-graph.json', import.meta.url),
});
let cached;

function readLocal(path) {
  if (statSync(path).size > 4_000_000) throw new TypeError('Knowledge artifact exceeds size limit');
  return readFileSync(path, 'utf8');
}

/** Fixed local files only. Restart the process to load a reviewed corpus update. */
export function loadDefaultKnowledgeIndex() {
  if (cached) return cached;
  try {
    const register = JSON.parse(readLocal(paths.sources));
    const cards = readLocal(paths.cards).split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    const graph = JSON.parse(readLocal(paths.graph));
    cached = createKnowledgeIndex({ version: register.version, sources: register.sources, cards, edges: graph });
  } catch {
    // Never leak filesystem paths, failed content, or error text to the client.
    cached = Object.freeze({ status: 'unavailable', corpusVersion: null, reason: 'missing_or_invalid_corpus' });
  }
  return cached;
}
