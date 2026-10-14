import {isDeepStrictEqual} from 'node:util';
import {validateFeedback} from './feedback.mjs';

function validateCases(cases){
  const ids=new Set();
  if(!Array.isArray(cases)||cases.length>200)throw new TypeError('INVALID_EVALUATION_CASE');
  for(const item of cases){
    if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>30000
      ||!Array.isArray(item.relevant_card_ids)||item.relevant_card_ids.some(id=>typeof id!=='string'||!id)
      ||new Set(item.relevant_card_ids).size!==item.relevant_card_ids.length||typeof item.should_abstain!=='boolean'
      ||item.should_abstain===Boolean(item.relevant_card_ids.length))throw new TypeError('INVALID_EVALUATION_CASE');
    ids.add(item.id);
  }
}
function optionsValid(retrieve,topK){if(typeof retrieve!=='function'||!Number.isInteger(topK)||topK<1||topK>6)throw new TypeError('INVALID_EVALUATION_OPTIONS');}
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const percentile=(values,q)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)]:null;
function validateArms(arms,text){
  if(!Array.isArray(arms)||arms.length!==2||arms[0]?.arm!=='baseline'||arms[1]?.arm!=='rag')throw new TypeError('INVALID_COMPARISON_REQUESTS');
  const left=arms[0].payload,right=arms[1].payload;
  if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)||Array.isArray(right))throw new TypeError('COMPARISON_ARMS_DIFFER');
  const {messages:a,...parametersA}=left,{messages:b,...parametersB}=right;
  if(parametersA.model!=='qwen-plus'||!isDeepStrictEqual(parametersA,parametersB)||!Array.isArray(a)||a.length!==2||!Array.isArray(b)||b.length<2||b.length>3
    ||a[0]?.role!=='system'||typeof a[0].content!=='string'||!a[0].content.trim()||a[0].content.length>30000
    ||a[1]?.role!=='user'||typeof a[1].content!=='string'||!a[1].content.trim()||a[1].content.length>30000
    ||!isDeepStrictEqual(a,b.slice(0,2))||b.slice(2).some(message=>message?.role!=='user')
    ||(text!==undefined&&a[1].content!==text))throw new TypeError('COMPARISON_ARMS_DIFFER');
  try{knowledgeForArm(arms[1]);}catch{throw new TypeError('COMPARISON_ARMS_DIFFER');}
}
function knowledgeForArm({arm,payload}){
  if(arm==='baseline'||payload.messages.length===2)return undefined;
  const content=payload.messages[2].content;
  if(typeof content!=='string'||content.length>12000)throw new TypeError('INVALID_COMPARISON_REFERENCE');
  const reference=JSON.parse(content);
  if(reference?.type!=='expression_knowledge_reference'||reference.status!=='matched'||!Array.isArray(reference.cards)||!reference.cards.length)throw new TypeError('INVALID_COMPARISON_REFERENCE');
  // Reuse the runtime's reference-card limits before a request reaches a transport.
  validateFeedback({assessment:'no_clear_issue',summary:'Reference validation.',suggestions:[]},payload.messages[1].content,{coach:true,knowledge:reference});
  return reference;
}
export function validateComparisonRequests(prepared){
  if(!prepared||prepared.status!=='not_run'||prepared.model!=='qwen-plus'
    ||typeof prepared.corpusVersion!=='string'||!prepared.corpusVersion.trim()||prepared.corpusVersion.length>256||/[\u0000-\u001f]/u.test(prepared.corpusVersion)
    ||!Array.isArray(prepared.requests)||prepared.requests.length>200||prepared.caseCount!==prepared.requests.length)throw new TypeError('INVALID_COMPARISON_REQUESTS');
  const ids=new Set();
  for(const pair of prepared.requests){
    if(!pair||typeof pair.caseId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(pair.caseId)||ids.has(pair.caseId))throw new TypeError('INVALID_COMPARISON_REQUESTS');
    ids.add(pair.caseId);validateArms(pair.arms);
  }
  return prepared;
}
function safeUsage(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const entries=['prompt_tokens','completion_tokens','total_tokens'].filter(key=>Object.hasOwn(value,key)&&Number.isSafeInteger(value[key])&&value[key]>=0).map(key=>[key,value[key]]);
  return entries.length?Object.fromEntries(entries):null;
}

// This measures retrieval on explicitly labelled synthetic cases, not teaching quality.
export function evaluateRetrieval(index,cases,{retrieve,topK=4,graph=true,now=()=>performance.now()}={}){
  validateCases(cases);optionsValid(retrieve,topK);
  const details=cases.map(item=>{
    const start=now(),result=retrieve(index,{text:item.text,topK,graph}),elapsedMs=Math.max(0,now()-start);
    const selectedIds=result.status==='matched'?[...new Set(result.trace?.selectedIds||result.cards?.map(card=>card.id)||[])].slice(0,topK):[];
    const relevant=new Set(item.relevant_card_ids),hits=selectedIds.filter(id=>relevant.has(id)).length,rank=selectedIds.findIndex(id=>relevant.has(id));
    return {caseId:item.id,split:item.split,category:item.category,relevantIds:[...relevant],selectedIds,status:result.status,hit:hits>0,
      recall:relevant.size?hits/relevant.size:null,reciprocalRank:relevant.size?(rank<0?0:1/(rank+1)):null,
      expectedAbstain:item.should_abstain,abstained:result.status==='no_match',elapsedMs};
  });
  const answerable=details.filter(item=>!item.expectedAbstain),negatives=details.filter(item=>item.expectedAbstain);
  return {datasetType:'synthetic_development_and_diagnostic',corpusVersion:index?.corpusVersion||index?.version||null,topK,graph,
    caseCount:details.length,answerableCount:answerable.length,negativeCount:negatives.length,generationStatus:'not_run',
    metrics:{recallAtK:mean(answerable.map(item=>item.recall)),mrr:mean(answerable.map(item=>item.reciprocalRank)),hitAtK:mean(answerable.map(item=>Number(item.hit))),
      abstentionAccuracy:mean(negatives.map(item=>Number(item.abstained))),falseAbstentionRate:mean(answerable.map(item=>Number(item.abstained))),
      unavailableCount:details.filter(item=>item.status==='unavailable').length,p50Ms:percentile(details.map(item=>item.elapsedMs),.5),p95Ms:percentile(details.map(item=>item.elapsedMs),.95)},cases:details};
}

// Only learner text enters the model input. Labels, forbidden changes and rubric stay out.
export function prepareModelComparison(index,cases,{retrieve,buildRequest,topK=4}={}){
  validateCases(cases);optionsValid(retrieve,topK);if(typeof buildRequest!=='function')throw new TypeError('REQUEST_BUILDER_REQUIRED');
  return {status:'not_run',model:'qwen-plus',corpusVersion:index?.corpusVersion||index?.version||null,caseCount:cases.length,
    requests:cases.map(item=>{
      const knowledge=retrieve(index,{text:item.text,topK,graph:true});
      const arms=[{arm:'baseline',payload:buildRequest({text:item.text,coach:true})},{arm:'rag',payload:buildRequest({text:item.text,coach:true,knowledge})}];
      validateArms(arms,item.text);return {caseId:item.id,arms};
    })};
}

// There is intentionally no default network transport or environment/credential lookup.
export async function runModelComparison(prepared,{execute,now=()=>performance.now()}={}){
  if(typeof execute!=='function')throw new TypeError('EXPLICIT_EXECUTOR_REQUIRED');
  // Validate every pair before any call, including imported or modified requests.
  validateComparisonRequests(prepared);
  if(!prepared.requests.length)return {status:'not_run',semanticQuality:'not_reviewed',learningOutcome:'not_tested',results:[]};
  const results=[];
  for(const pair of prepared.requests){
    for(const {arm,payload} of pair.arms){
      const start=now();
      try{
        const value=await execute({caseId:pair.caseId,arm,payload});
        if(!value?.result||JSON.stringify(value.result).length>24000)throw new Error();
        const result=validateFeedback(value.result,payload.messages[1].content,{coach:true,knowledge:knowledgeForArm({arm,payload})});
        results.push({caseId:pair.caseId,arm,status:'completed',result,usage:safeUsage(value.usage),elapsedMs:Math.max(0,now()-start)});
      }catch{results.push({caseId:pair.caseId,arm,status:'failed',error:'MODEL_EXECUTION_FAILED',elapsedMs:Math.max(0,now()-start)});}
    }
  }
  return {status:results.every(item=>item.status==='completed')?'completed_unreviewed':results.some(item=>item.status==='completed')?'partial_failure':'failed',
    model:prepared.model,corpusVersion:prepared.corpusVersion,semanticQuality:'not_reviewed',learningOutcome:'not_tested',results};
}
