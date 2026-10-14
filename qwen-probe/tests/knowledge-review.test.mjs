import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareModelComparison} from '../knowledge-evaluation.mjs';
import {buildFeedbackRequest} from '../feedback.mjs';
let api={};try{api=await import('../knowledge-review.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const cases=[
  {id:'case-1',text:'I stayed home because of I felt tired.',relevant_card_ids:['card-1'],should_abstain:false,allowed_judgment:'Preserve the cause and time.',forbidden_judgments:['Do not change the meaning.']},
  {id:'case-2',text:'I enjoy tea.',relevant_card_ids:[],should_abstain:true,allowed_judgment:'Simple English is acceptable.',forbidden_judgments:['Do not invent an error.']},
];
const card={id:'card-1',expression:'because + clause',meaning:'原因',usage:'because 后接分句。',pitfalls:['不要机械改动原意。'],examples:['I stayed home because I felt tired.'],source_refs:['source-1'],grounding_scope:'editorial_principle'};
const retrieve=(index,{text})=>({status:text===cases[0].text?'matched':'no_match',corpusVersion:'v1',cards:text===cases[0].text?[card]:[]});
const prepared=()=>prepareModelComparison({version:'v1'},cases,{retrieve,buildRequest:buildFeedbackRequest});
const correct=(arm)=>({assessment:'suggestions',summary:'原因连接词可调整。',suggestions:[{original:'because of I felt tired',suggestion:'because I felt tired',reason:'because 后接完整分句。',kind:'correction',knowledge_ids:arm==='rag'?['card-1']:[]}]});
const acceptable={assessment:'no_clear_issue',summary:'原句可以保留。',suggestions:[]};
function bundle(p=prepared()){
  return {schemaVersion:1,model:p.model,corpusVersion:p.corpusVersion,requestDigest:api.comparisonDigest(p),results:p.requests.flatMap(pair=>pair.arms.map(({arm})=>({caseId:pair.caseId,arm,status:'completed',result:pair.caseId==='case-1'?correct(arm):acceptable,usage:{prompt_tokens:40,total_tokens:70,apiKey:'DO_NOT_COPY'},elapsedMs:12})))};
}
function review(b){const p=prepared();return api.prepareHumanReview(p,cases,b===undefined?bundle(p):b,{randomBit:()=>0});}
function rating(r,caseId,sample,overrides={}){
  const row=r.ratingsTemplate.ratings.find(x=>x.caseId===caseId&&x.sample===sample);
  return {...row,reviewer:'editor-1',correctness:2,meaningPreserved:2,contextFit:2,falseCorrection:false,sourceSupport:caseId==='case-1'&&sample==='B'?2:null,...overrides};
}
const ratings=(r,rows)=>({schemaVersion:1,reviewId:r.reviewId,ratings:rows});

test('request digest binds the exact prompt, parameters and corpus, not just sample IDs',()=>{
  assert.equal(typeof api.comparisonDigest,'function');const a=prepared(),b=structuredClone(a);b.requests[0].arms[1].payload.messages[2].content+=' ';
  assert.equal(api.comparisonDigest(a).length,64);assert.notEqual(api.comparisonDigest(a),api.comparisonDigest(b));
});
test('import prepares answer content and rubric while separating arm mapping and unvalidated metadata',()=>{
  const r=review();assert.equal(r.status,'awaiting_human_review');assert.equal(r.packet.samples.length,4);assert.equal(r.ratingsTemplate.ratings.length,4);
  assert.equal(r.packet.samples[0].learnerText,cases[0].text);assert.equal(r.packet.samples[0].rubric.allowedJudgment,cases[0].allowed_judgment);
  assert.equal(r.key.assignments[0].arm,'baseline');assert.equal(r.packet.samples[1].references[0].usage,card.usage);
  const publicText=JSON.stringify(r.packet);assert.ok(!publicText.includes('"arm"'));assert.ok(!publicText.includes('knowledge_ids'));assert.ok(!JSON.stringify(r).includes('DO_NOT_COPY'));
});
test('missing result bundle stays not run with no fabricated responses or scores',()=>{
  const r=api.prepareHumanReview(prepared(),cases,null,{randomBit:()=>0});assert.equal(r.status,'not_run');assert.equal(r.ratingsTemplate.ratings.length,0);
  const report=api.summarizeHumanReview(r,ratings(r,[]));assert.equal(report.semanticQuality,'not_reviewed');assert.equal(report.arms.baseline.missing,2);assert.equal(report.arms.baseline.correctness,null);assert.equal(report.learningOutcome,'not_tested');
});
for(const field of ['model','corpusVersion','requestDigest'])test(`import rejects mismatched ${field}`,()=>{
  const p=prepared(),b=bundle(p);b[field]='wrong';assert.throws(()=>api.prepareHumanReview(p,cases,b),/RESULTS_DO_NOT_MATCH_REQUESTS/);
});
test('import rejects unknown cases, duplicate arms and invalid completion structures',()=>{
  const p=prepared(),b=bundle(p);b.results[0].caseId='forged';assert.throws(()=>api.prepareHumanReview(p,cases,b),/INVALID_COMPARISON_RESULTS/);
  const duplicate=bundle(p);duplicate.results.push(duplicate.results[0]);assert.throws(()=>api.prepareHumanReview(p,cases,duplicate),/INVALID_COMPARISON_RESULTS/);
  const garbage=bundle(p);garbage.results[0].result={garbage:true};assert.throws(()=>api.prepareHumanReview(p,cases,garbage),/INVALID_COMPARISON_RESULTS/);
});
test('baseline cannot cite a RAG card and RAG cannot cite an unknown card',()=>{
  for(const [position,id] of [[0,'card-1'],[1,'invented']]){const p=prepared(),b=bundle(p);b.results[position].result.suggestions[0].knowledge_ids=[id];assert.throws(()=>api.prepareHumanReview(p,cases,b),/INVALID_COMPARISON_RESULTS/);}
});
test('unknown dataset membership or a changed original is rejected even when a request digest matches',()=>{
  const p=prepared();const altered=structuredClone(cases);altered[0].text='different';assert.throws(()=>api.prepareHumanReview(p,altered,bundle(p)),/CASES_DO_NOT_MATCH_REQUESTS/);
  assert.throws(()=>api.prepareHumanReview(p,cases.slice(1),bundle(p)),/CASES_DO_NOT_MATCH_REQUESTS/);
});
test('assignment can reverse labels and old ratings cannot be applied to the new assignment',()=>{
  const p=prepared(),b=bundle(p),left=api.prepareHumanReview(p,cases,b,{randomBit:()=>0}),right=api.prepareHumanReview(p,cases,b,{randomBit:()=>1});
  assert.equal(right.key.assignments[0].arm,'rag');assert.notEqual(left.reviewId,right.reviewId);
  assert.throws(()=>api.summarizeHumanReview(right,ratings(left,[])),/INVALID_HUMAN_RATINGS/);
});
test('blank score template remains unreviewed rather than becoming zero or passing',()=>{
  const r=review(),report=api.summarizeHumanReview(r,r.ratingsTemplate);
  assert.equal(report.semanticQuality,'not_reviewed');assert.equal(report.arms.baseline.reviewed,0);assert.equal(report.arms.baseline.unreviewed,2);assert.equal(report.paired.caseCount,0);assert.equal(report.paired.correctnessDelta,null);
});
test('failure and missing denominators remain separate and never become bad language scores',()=>{
  const p=prepared(),b=bundle(p);b.results[1]={caseId:'case-1',arm:'rag',status:'failed',error:'FAKE_SECRET'};b.results.pop();
  const r=api.prepareHumanReview(p,cases,b,{randomBit:()=>0}),report=api.summarizeHumanReview(r,ratings(r,[rating(r,'case-1','A')]));
  assert.deepEqual([report.arms.rag.requested,report.arms.rag.completed,report.arms.rag.failed,report.arms.rag.missing],[2,0,1,1]);assert.equal(report.arms.rag.correctness,null);assert.equal(report.paired.caseCount,0);assert.ok(!JSON.stringify(r).includes('FAKE_SECRET'));
  assert.throws(()=>api.summarizeHumanReview(r,ratings(r,[{...rating(r,'case-1','A'),sample:'B'}])),/INVALID_HUMAN_RATINGS/);
});
test('paired quality deltas require both scored completions, with citation support absent as null',()=>{
  const r=review();const report=api.summarizeHumanReview(r,ratings(r,[rating(r,'case-1','A',{correctness:1}),rating(r,'case-1','B'),rating(r,'case-2','A')]));
  assert.equal(report.paired.caseCount,1);assert.equal(report.paired.correctnessDelta,1);assert.equal(report.arms.baseline.sourceSupport,null);assert.equal(report.arms.rag.sourceSupport,2);assert.equal(report.arms.rag.citationCoverage,.5);assert.equal(report.semanticQuality,'partially_reviewed');assert.equal(report.learningOutcome,'not_tested');
});
test('multiple reviewers are averaged per answer rather than inflating the model sample count',()=>{
  const r=review();const report=api.summarizeHumanReview(r,ratings(r,[rating(r,'case-1','A',{correctness:0}),rating(r,'case-1','A',{reviewer:'editor-2'}),rating(r,'case-2','A')]));
  assert.equal(report.arms.baseline.reviewed,2);assert.equal(report.arms.baseline.ratingCount,3);assert.equal(report.arms.baseline.correctness,1.5);
});
test('ratings reject duplicate identities, partial, out-of-range, wrong citation scope and unknown samples',()=>{
  const r=review(),row=rating(r,'case-1','A');
  const bad=[[row,row],[{...row,correctness:3}],[{...row,meaningPreserved:null}],[{...row,falseCorrection:'false'}],[{...row,sourceSupport:0}],[{...row,sample:'Z'}],[{...row,caseId:'forged'}],[rating(r,'case-1','B',{sourceSupport:null})]];
  for(const items of bad)assert.throws(()=>api.summarizeHumanReview(r,ratings(r,items)),/INVALID_HUMAN_RATINGS/);
});
test('modified mapping or answer content is detected before scores can be attributed',()=>{
  const r=review();r.key.assignments[0].arm='rag';assert.throws(()=>api.summarizeHumanReview(r,ratings(r,[])),/INVALID_REVIEW_PACKET/);
});
test('changed grading instructions invalidate the saved review identity and old marks',()=>{
  for(const field of ['scale','sourceSupport']){
    const r=review(),marks=ratings(r,[rating(r,'case-1','A')]);r.packet.instructions[field]='Changed meaning of the grading scale.';
    assert.throws(()=>api.summarizeHumanReview(r,marks),/INVALID_REVIEW_PACKET/);
  }
});
