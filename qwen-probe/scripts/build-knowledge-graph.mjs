import {readFileSync,writeFileSync} from 'node:fs';
import {buildKnowledgeGraph} from '../knowledge.mjs';
const base=new URL('../../docs/knowledge/',import.meta.url);
const register=JSON.parse(readFileSync(new URL('source-register.json',base),'utf8'));
const cards=readFileSync(new URL('expression-cards.jsonl',base),'utf8').trim().split('\n').map(JSON.parse);
const graph=buildKnowledgeGraph({version:register.version,sources:register.sources,cards});
writeFileSync(new URL('knowledge-graph.json',base),JSON.stringify(graph,null,2)+'\n');
console.log(JSON.stringify({version:graph.version,cards:cards.length,nodes:graph.nodes.length,edges:graph.edges.length}));
