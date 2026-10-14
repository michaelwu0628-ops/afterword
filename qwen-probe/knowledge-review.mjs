import {createHash,randomInt} from 'node:crypto';
import {validateComparisonRequests} from './knowledge-evaluation.mjs';
import {validateFeedback} from './feedback.mjs';

const invalid=code=>{throw new TypeError(code);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=value=>{let json;try{json=JSON.stringify(value);}catch{invalid('INVALID_REVIEW_INPUT');}if(!json||json.length>4_000_000)invalid('INVALID_REVIEW_INPUT');return JSON.parse(json);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const score=value=>Number.isInteger(value)&&value>=0&&value<=2;
const finiteMs=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const rowKey=(caseId,sample)=>JSON.stringify([caseId,sample]);

/** File correspondence only: a digest is not proof that a model was called. */
export function comparisonDigest(prepared){validateComparisonRequests(prepared);return hash(prepared);}
function knowledgeFor(arm){return arm.payload.messages.length===3?JSON.parse(arm.payload.messages[2].content):undefined;}
function cleanUsage(value){
  if(!record(value))return null;
  const entries=['prompt_tokens','completion_tokens','total_tokens'].filter(key=>Number.isSafeInteger(value[key])&&value[key]>=0).map(key=>[key,value[key]]);
  return entries.length?Object.fromEntries(entries):null;
}
function referenceData(result,knowledge){
  const cards=new Map((knowledge?.cards||[]).map(card=>[card.id,card]));
  return [...new Set(result.suggestions.flatMap(item=>item.knowledge_ids))].map(id=>{
    const card=cards.get(id);
    return {expression:card.expression||id,usage:card.usage||'',pitfalls:card.pitfalls||[],examples:card.examples||[],groundingScope:card.grounding_scope||'editorial_principle',sourceRefs:card.source_refs||[]};
  });
}
function identity(review){return hash({requestDigest:review.requestDigest,model:review.model,corpusVersion:review.corpusVersion,status:review.status,instructions:review.packet.instructions,samples:review.packet.samples,assignments:review.key.assignments});}

/** Import local results, preserve missing/failed, and keep arm labels in a separate key. */
export function prepareHumanReview(prepared,cases,bundle,{randomBit=()=>randomInt(2)}={}){
  prepared=bounded(prepared);validateComparisonRequests(prepared);
  if(!Array.isArray(cases)||cases.length>200||typeof randomBit!=='function')invalid('CASES_DO_NOT_MATCH_REQUESTS');
  const dataset=new Map();
  for(const item of cases){
    if(!record(item)||typeof item.id!=='string'||dataset.has(item.id)||typeof item.text!=='string'||item.text.length>30000)invalid('CASES_DO_NOT_MATCH_REQUESTS');
    dataset.set(item.id,item);
  }
  for(const pair of prepared.requests)if(dataset.get(pair.caseId)?.text!==pair.arms[0].payload.messages[1].content)invalid('CASES_DO_NOT_MATCH_REQUESTS');
  const requestDigest=comparisonDigest(prepared),provided=new Map();
  if(bundle!==null&&bundle!==undefined){
    bundle=bounded(bundle);
    if(bundle.schemaVersion!==1||bundle.model!==prepared.model||bundle.corpusVersion!==prepared.corpusVersion||bundle.requestDigest!==requestDigest)invalid('RESULTS_DO_NOT_MATCH_REQUESTS');
    if(!Array.isArray(bundle.results)||bundle.results.length>prepared.requests.length*2)invalid('INVALID_COMPARISON_RESULTS');
    const expected=new Map(prepared.requests.flatMap(pair=>pair.arms.map(arm=>[rowKey(pair.caseId,arm.arm),arm])));
    for(const entry of bundle.results){
      if(!record(entry)||!['completed','failed'].includes(entry.status))invalid('INVALID_COMPARISON_RESULTS');
      const key=rowKey(entry.caseId,entry.arm),arm=expected.get(key);
      if(!arm||provided.has(key))invalid('INVALID_COMPARISON_RESULTS');
      if(entry.status==='failed'){provided.set(key,{status:'failed',error:'MODEL_EXECUTION_FAILED',elapsedMs:finiteMs(entry.elapsedMs)});continue;}
      let result;
      try{if(JSON.stringify(entry.result).length>24000)throw new Error();result=validateFeedback(entry.result,arm.payload.messages[1].content,{coach:true,knowledge:knowledgeFor(arm)});}catch{invalid('INVALID_COMPARISON_RESULTS');}
      provided.set(key,{status:'completed',result,usage:cleanUsage(entry.usage),elapsedMs:finiteMs(entry.elapsedMs)});
    }
  }
  const samples=[],assignments=[],template=[];
  for(const pair of prepared.requests){
    const bit=randomBit();if(bit!==0&&bit!==1)invalid('INVALID_REVIEW_INPUT');
    const order=bit?[pair.arms[1],pair.arms[0]]:pair.arms,item=dataset.get(pair.caseId);
    for(const [position,arm] of order.entries()){
      const label=position?'B':'A',outcome=provided.get(rowKey(pair.caseId,arm.arm))||{status:'missing'};
      const sample={caseId:pair.caseId,sample:label,learnerText:item.text,status:outcome.status,
        rubric:{allowedJudgment:typeof item.allowed_judgment==='string'?item.allowed_judgment.slice(0,3000):'',forbiddenJudgments:Array.isArray(item.forbidden_judgments)?item.forbidden_judgments.filter(value=>typeof value==='string').slice(0,20).map(value=>value.slice(0,3000)):[]},references:[]};
      if(outcome.status==='completed'){
        sample.result={...outcome.result,suggestions:outcome.result.suggestions.map(({knowledge_ids,...suggestion})=>suggestion)};
        sample.references=referenceData(outcome.result,knowledgeFor(arm));
        template.push({caseId:pair.caseId,sample:label,reviewer:'',correctness:null,meaningPreserved:null,contextFit:null,falseCorrection:null,sourceSupport:null,comments:''});
      }
      samples.push(sample);assignments.push({caseId:pair.caseId,sample:label,arm:arm.arm,status:outcome.status,usage:outcome.usage??null,elapsedMs:outcome.elapsedMs??null});
    }
  }
  const status=samples.some(item=>item.status==='completed')?'awaiting_human_review':provided.size?'no_completed_results':'not_run';
  const review={schemaVersion:1,requestDigest,status,model:prepared.model,corpusVersion:prepared.corpusVersion,
    packet:{schemaVersion:1,instructions:{
      scale:'correctness、meaningPreserved、contextFit：0 有明显问题，1 部分满足，2 满足；判断依据是本例原话和允许／禁止改动。',
      falseCorrection:'可接受的原话被当作错误时记 true；不要把有用的 optional 选择自动计为误纠。',
      sourceSupport:'仅评所给编辑知识卡的用法／例句是否支持这条建议：0 不支持，1 部分支持，2 支持；无引用必须 null。来源原文与卡片是否一致另行核验，不当作官方认证。',
      blinding:'隐藏组名评阅；参考内容本身可能提示策略，因此不是严格双盲。',
      unfinished:'不确定或未评时保留全空行；部分填写不能计入。不要评分 failed 或 missing。',
    },samples},key:{schemaVersion:1,requestDigest,status,model:prepared.model,corpusVersion:prepared.corpusVersion,assignments}};
  review.reviewId=identity(review);review.packet.reviewId=review.reviewId;review.key.reviewId=review.reviewId;
  review.ratingsTemplate={schemaVersion:1,reviewId:review.reviewId,ratings:template};
  return review;
}

function validateReview(review){
  if(!record(review)||review.schemaVersion!==1||!record(review.packet)||!record(review.key)||review.packet.schemaVersion!==1||review.key.schemaVersion!==1
    ||!Array.isArray(review.packet.samples)||review.packet.samples.length>400||!Array.isArray(review.key.assignments)||review.key.assignments.length!==review.packet.samples.length
    ||review.reviewId!==review.packet.reviewId||review.reviewId!==review.key.reviewId||review.requestDigest!==review.key.requestDigest||review.model!==review.key.model
    ||review.corpusVersion!==review.key.corpusVersion||review.status!==review.key.status||identity(review)!==review.reviewId)invalid('INVALID_REVIEW_PACKET');
  const entries=new Map(),pairs=new Map();
  for(const item of review.packet.samples){
    const key=rowKey(item.caseId,item.sample);
    if(entries.has(key)||!['A','B'].includes(item.sample)||!['completed','failed','missing'].includes(item.status)||!Array.isArray(item.references))invalid('INVALID_REVIEW_PACKET');
    entries.set(key,{sample:item,ratings:[]});
  }
  for(const mapping of review.key.assignments){
    const entry=entries.get(rowKey(mapping.caseId,mapping.sample));
    if(!entry||entry.arm||!['baseline','rag'].includes(mapping.arm)||entry.sample.status!==mapping.status)invalid('INVALID_REVIEW_PACKET');
    entry.arm=mapping.arm;
    const pair=pairs.get(mapping.caseId)||new Map();if(pair.has(mapping.arm))invalid('INVALID_REVIEW_PACKET');pair.set(mapping.arm,entry);pairs.set(mapping.caseId,pair);
  }
  if([...pairs.values()].some(pair=>pair.size!==2))invalid('INVALID_REVIEW_PACKET');
  return {entries,pairs};
}

/** Human marks remain human judgments; structural validity never becomes teaching success. */
export function summarizeHumanReview(review,ratings){
  bounded(review);const {entries,pairs}=validateReview(review);
  if(!record(ratings)||ratings.schemaVersion!==1||ratings.reviewId!==review.reviewId||!Array.isArray(ratings.ratings)||ratings.ratings.length>4000)invalid('INVALID_HUMAN_RATINGS');
  bounded(ratings);const identities=new Set();
  const numeric=['correctness','meaningPreserved','contextFit'];
  for(const row of ratings.ratings){
    if(!record(row))invalid('INVALID_HUMAN_RATINGS');
    const entry=entries.get(rowKey(row.caseId,row.sample));
    if(!entry||entry.sample.status!=='completed')invalid('INVALID_HUMAN_RATINGS');
    const empty=[...numeric,'falseCorrection','sourceSupport'].every(key=>row[key]===null)&&row.reviewer===''&&row.comments==='';
    if(empty)continue;
    if(typeof row.reviewer!=='string'||!row.reviewer.trim()||row.reviewer.length>128||numeric.some(key=>!score(row[key]))||typeof row.falseCorrection!=='boolean'
      ||typeof row.comments!=='string'||row.comments.length>3000||!((entry.sample.references.length?score(row.sourceSupport):row.sourceSupport===null)))invalid('INVALID_HUMAN_RATINGS');
    const key=JSON.stringify([row.caseId,row.sample,row.reviewer.trim()]);if(identities.has(key))invalid('INVALID_HUMAN_RATINGS');identities.add(key);
    entry.ratings.push({...row,reviewer:row.reviewer.trim()});
  }
  const perAnswer=entry=>entry.ratings.length?{...Object.fromEntries(numeric.map(key=>[key,mean(entry.ratings.map(row=>row[key]))])),falseCorrectionRate:mean(entry.ratings.map(row=>Number(row.falseCorrection))),sourceSupport:entry.sample.references.length?mean(entry.ratings.map(row=>row.sourceSupport)):null}:null;
  const arms={};
  for(const arm of ['baseline','rag']){
    const group=[...entries.values()].filter(entry=>entry.arm===arm),completed=group.filter(entry=>entry.sample.status==='completed');
    const reviewed=completed.filter(entry=>entry.ratings.length),scores=reviewed.map(perAnswer),cited=reviewed.filter(entry=>entry.sample.references.length);
    arms[arm]={requested:group.length,completed:completed.length,failed:group.filter(entry=>entry.sample.status==='failed').length,missing:group.filter(entry=>entry.sample.status==='missing').length,
      reviewed:reviewed.length,unreviewed:completed.length-reviewed.length,ratingCount:reviewed.reduce((sum,entry)=>sum+entry.ratings.length,0),
      ...Object.fromEntries([...numeric,'falseCorrectionRate'].map(key=>[key,mean(scores.map(row=>row[key]))])),sourceSupport:mean(cited.map(entry=>perAnswer(entry).sourceSupport)),
      citationCoverage:completed.length?completed.filter(entry=>entry.sample.references.length).length/completed.length:null};
  }
  const paired=[...pairs.values()].filter(pair=>[...pair.values()].every(entry=>entry.sample.status==='completed'&&entry.ratings.length));
  const delta=field=>mean(paired.map(pair=>perAnswer(pair.get('rag'))[field]-perAnswer(pair.get('baseline'))[field]));
  const completed=arms.baseline.completed+arms.rag.completed,reviewed=arms.baseline.reviewed+arms.rag.reviewed;
  const semanticQuality=!reviewed?'not_reviewed':reviewed===completed?'reviewed':'partially_reviewed';
  const failed=arms.baseline.failed+arms.rag.failed,missing=arms.baseline.missing+arms.rag.missing;
  return {schemaVersion:1,reviewId:review.reviewId,requestDigest:review.requestDigest,model:review.model,corpusVersion:review.corpusVersion,
    status:review.status==='not_run'?'not_run':semanticQuality,generationStatus:completed?(failed||missing?'partial_failure':'completed_unreviewed'):failed?'failed':'not_run',
    semanticQuality,learningOutcome:'not_tested',provenance:'user_supplied_results_not_independently_verified',blinding:'arm_labels_hidden_not_double_blind',sourceSupportScope:'cited_editorial_card_support_not_primary_source_certification',arms,
    paired:{caseCount:paired.length,correctnessDelta:delta('correctness'),meaningPreservedDelta:delta('meaningPreserved'),contextFitDelta:delta('contextFit'),falseCorrectionDelta:delta('falseCorrectionRate')}};
}
