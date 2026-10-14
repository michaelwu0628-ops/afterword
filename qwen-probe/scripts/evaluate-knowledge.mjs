import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {loadDefaultKnowledgeIndex} from '../knowledge-store.mjs';
import {retrieveKnowledge} from '../knowledge.mjs';
import {buildFeedbackRequest} from '../feedback.mjs';
import {evaluateRetrieval,prepareModelComparison} from '../knowledge-evaluation.mjs';

// Offline only: no transport, credential reader, model SDK, or live mode.
if(process.argv.length>2)throw new Error('OFFLINE_EVALUATION_TAKES_NO_CREDENTIALS_OR_LIVE_FLAGS');
const directory=new URL('../../docs/validation/knowledge-rag/',import.meta.url);
const cases=readFileSync(new URL('../../docs/validation/coach-quality-cases.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const index=loadDefaultKnowledgeIndex();if(index.status!=='ready')throw new Error('REVIEWED_KNOWLEDGE_UNAVAILABLE');
const groups=[['all',cases],['development',cases.filter(item=>item.split==='development')],['diagnostic',cases.filter(item=>item.split==='diagnostic')]];
const comparisons=groups.map(([group,items])=>({group,lexical:evaluateRetrieval(index,items,{retrieve:retrieveKnowledge,graph:false}),graph:evaluateRetrieval(index,items,{retrieve:retrieveKnowledge,graph:true})}));
const generationCases=cases.filter(item=>item.generation_evaluable!==false);
const prepared=prepareModelComparison(index,generationCases,{retrieve:retrieveKnowledge,buildRequest:buildFeedbackRequest});
const report={createdAt:new Date().toISOString(),corpusVersion:index.version,cards:index.cards.length,sources:index.sources.length,
  approvedSources:index.sources.filter(source=>source.approved_for_runtime).length,graphNodes:index.graph.nodes.length,graphEdges:index.graph.edges.length,
  datasetType:'original_synthetic_development_and_diagnostic_not_student_sample',generationStatus:'not_run',actualModelCalls:0,
  preparedCases:prepared.caseCount,preparedCalls:prepared.caseCount*2,semanticQuality:'not_reviewed',learningOutcome:'not_tested',comparisons};
mkdirSync(directory,{recursive:true});
const save=(name,value)=>writeFileSync(new URL(name,directory),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
save('retrieval-report.json',report);save('model-comparison-requests.json',prepared);
const percentage=value=>value===null?'不适用':`${(value*100).toFixed(1)}%`;
const lines=['# 知识检索对照与模型评测准备','',`语料版本：${index.version}；${index.cards.length} 张卡；${index.sources.length} 条去重来源（${report.approvedSources} 条可用于运行参考）。`,`图：${report.graphNodes} 个节点，${report.graphEdges} 条边。`,
  '',`原创合成案例 ${cases.length} 个：开发 ${groups[1][1].length}、诊断 ${groups[2][1].length}。不是学生实测、官方题库或独立人评 gold；诊断组也没有被宣称为严格盲测集。`,
  '','| 组别 | 方法 | Recall@4 | MRR | Hit@4 | 空回退准确率 | 检索 P95 ms |','| --- | --- | --- | --- | --- | --- | --- |'];
for(const comparison of comparisons)for(const method of ['lexical','graph']){
  const metrics=comparison[method].metrics;
  lines.push(`| ${comparison.group} | ${method==='lexical'?'BM25＋表达/意图规则':'同前＋一跳图扩展'} | ${percentage(metrics.recallAtK)} | ${percentage(metrics.mrr)} | ${percentage(metrics.hitAtK)} | ${percentage(metrics.abstentionAccuracy)} | ${metrics.p95Ms?.toFixed(3)??'不适用'} |`);
}
lines.push('','这些数字只描述本地检索。相关卡片命中不证明建议正确、来源支持充分或学习效果提升；微小耗时来自本机计时，不是网络／模型延迟。图扩展没有改进的指标同样保留。',
  '',`同模型请求已准备 ${prepared.caseCount} 组、${prepared.caseCount*2} 个请求，实际模型调用 0。两组均为 qwen-plus、相同强提示和 700 输出 token 上限，RAG 仅额外收到检索参考。预期答案、禁止修改及评分 rubric 没有进入请求。`,
  '', '模型回答质量、误纠率、原意保持、引用支持、真实时延、用量与费用：**未运行／未知**。准备文件不含 Key、请求头或用户真实材料；当前脚本没有 live 模式，也不读取环境变量或配置凭据。',
  '', '后续真实执行须由本人主动提供凭据并调用显式 executor；失败内容采用固定诊断。输出先记为 completed_unreviewed，再以对应案例的 allowed_judgment/forbidden_judgments 做人工评阅；不能用 JSON 合格率冒充语义质量。',
  '', '## 检索未命中或空回退失败','');
for(const method of ['lexical','graph']){
  const failed=comparisons[0][method].cases.filter(item=>item.expectedAbstain?!item.abstained:!item.hit);
  lines.push(`### ${method}：${failed.length} 例`,'');
  for(const item of failed)lines.push(`- ${item.caseId}：期望 ${item.expectedAbstain?'空回退':item.relevantIds.join(', ')}；实际 ${item.selectedIds.join(', ')||item.status}。`);
  if(!failed.length)lines.push('本次样例无该类失败，不能外推至真实用户。');
  lines.push('');
}
save('retrieval-report.md',lines.join('\n')+'\n');
const key={status:'not_run',assignments:prepared.requests.map((pair,position)=>({caseId:pair.caseId,A:position%2?'rag':'baseline',B:position%2?'baseline':'rag'}))};
save('review-assignment-key.json',key);
save('human-review-template.csv','case_id,sample,correctness_0_2,meaning_preserved_0_2,context_fit_0_2,false_correction,source_support_0_2,comments,reviewer\n'+prepared.requests.flatMap(pair=>['A','B'].map(sample=>`${pair.caseId},${sample},,,,,,,`)).join('\n')+'\n');
console.log(JSON.stringify({corpus:report.corpusVersion,cards:report.cards,sources:report.sources,approvedSources:report.approvedSources,cases:cases.length,preparedModelCalls:report.preparedCalls,actualModelCalls:0,lexical:comparisons[0].lexical.metrics,graph:comparisons[0].graph.metrics}));
