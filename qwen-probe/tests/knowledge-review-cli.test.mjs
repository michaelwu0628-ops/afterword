import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareModelComparison} from '../knowledge-evaluation.mjs';
import {buildFeedbackRequest} from '../feedback.mjs';
import {comparisonDigest} from '../knowledge-review.mjs';

let api={};try{api=await import('../scripts/review-knowledge.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const script=fileURLToPath(new URL('../scripts/review-knowledge.mjs',import.meta.url));
const cases=[{id:'case-1',split:'development',category:'correct',text:'I like tea.',relevant_card_ids:[],should_abstain:true,generation_evaluable:true,allowed_judgment:'这句可以保留。',forbidden_judgments:['不要改变偏好。']}];
const prepared=prepareModelComparison({version:'test.v1'},cases,{retrieve:()=>({status:'no_match',cards:[]}),buildRequest:buildFeedbackRequest});
const read=(directory,name)=>JSON.parse(readFileSync(join(directory,name),'utf8'));
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'knowledge-review-cli-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const casesFile=join(directory,'cases.jsonl');
  writeFileSync(casesFile,cases.map(item=>JSON.stringify(item)).join('\n')+'\n');
  writeFileSync(join(directory,'model-comparison-requests.json'),JSON.stringify(prepared));
  return {directory,casesFile};
}
function importResults(options,results){
  const bundle={schemaVersion:1,requestDigest:comparisonDigest(prepared),model:prepared.model,corpusVersion:prepared.corpusVersion,
    results:results??['baseline','rag'].map(arm=>({caseId:'case-1',arm,status:'completed',result:{assessment:'no_clear_issue',summary:'可保留。',suggestions:[],raw:'FAKE_SECRET'},
      usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,raw_header:'FAKE_SECRET'},elapsedMs:25}))};
  writeFileSync(join(options.directory,'model-comparison-results.json'),JSON.stringify(bundle));
}

test('the offline review CLI exposes an injectable workflow without running on import',()=>{
  assert.equal(typeof api.runReviewWorkflow,'function');
});
test('prepare without imported results writes only an honest not-run report',t=>{
  const options=fixture(t);api.runReviewWorkflow({...options,mode:'prepare'});
  const report=read(options.directory,'generation-review-report.json');
  assert.equal(report.status,'not_run');assert.equal(report.semanticQuality,'not_reviewed');assert.equal(report.learningOutcome,'not_tested');
  assert.match(readFileSync(join(options.directory,'generation-review-report.md'),'utf8'),/未运行|not_run/u);
  for(const name of ['blind-review-packet.json','blind-review-key.json','human-review-ratings.json'])assert.equal(existsSync(join(options.directory,name)),false);
});
test('workflow mode accepts only prepare or score before reading or writing files',t=>{
  const options=fixture(t);
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'live'}),/INVALID_REVIEW_MODE/);
  assert.equal(existsSync(join(options.directory,'generation-review-report.json')),false);
});
for(const name of ['model-comparison-requests.json','cases.jsonl'])test(`input size is capped at four MiB: ${name}`,t=>{
  const options=fixture(t);writeFileSync(join(options.directory,name),'x'.repeat(4*1024*1024+1));
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'prepare'}),/REVIEW_FILE_TOO_LARGE/);
  assert.equal(existsSync(join(options.directory,'generation-review-report.json')),false);
});
test('malformed local files raise fixed diagnostics without including their content',t=>{
  const options=fixture(t);writeFileSync(join(options.directory,'model-comparison-requests.json'),'FAKE_SECRET_NOT_JSON');
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'prepare'}),error=>error.message==='REVIEW_FILE_INVALID'&&!String(error).includes('FAKE_SECRET'));
});
test('the executable rejects credential and file-path arguments with a fixed message and no stack',()=>{
  const result=spawnSync(process.execPath,[script,'prepare','--api-key','FAKE_SECRET'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'INVALID_REVIEW_MODE');
  assert.ok(!result.stderr.includes('FAKE_SECRET'));assert.ok(!result.stderr.includes(' at '));
});
test('prepare imports validated results into separate blind packet, key and empty ratings',t=>{
  const options=fixture(t);importResults(options);const report=api.runReviewWorkflow({...options,mode:'prepare'});
  const packet=read(options.directory,'blind-review-packet.json'),key=read(options.directory,'blind-review-key.json'),ratings=read(options.directory,'human-review-ratings.json');
  assert.equal(report.semanticQuality,'not_reviewed');assert.equal(report.paired.caseCount,0);assert.equal(packet.samples.length,2);assert.equal(ratings.ratings.length,2);
  assert.equal(packet.reviewId,key.reviewId);assert.equal(ratings.reviewId,key.reviewId);assert.equal(key.requestDigest,comparisonDigest(prepared));
  assert.ok(packet.samples.every(sample=>!Object.hasOwn(sample,'arm')&&!Object.hasOwn(sample,'usage')));
  assert.ok(ratings.ratings.every(row=>row.reviewer===''&&row.correctness===null&&row.falseCorrection===null&&row.sourceSupport===null));
  for(const value of [packet,key,ratings,report])assert.ok(!JSON.stringify(value).includes('FAKE_SECRET'));
});
test('score summarizes human marks using the saved assignment and reports paired deltas',t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});
  const key=read(options.directory,'blind-review-key.json'),ratings=read(options.directory,'human-review-ratings.json');
  for(const row of ratings.ratings){
    const arm=key.assignments.find(item=>item.caseId===row.caseId&&item.sample===row.sample).arm;
    Object.assign(row,{reviewer:'reviewer-private-name',correctness:arm==='baseline'?2:1,meaningPreserved:2,contextFit:2,falseCorrection:arm==='rag',sourceSupport:null,comments:'private-review-comment'});
  }
  const ratingsPath=join(options.directory,'human-review-ratings.json');writeFileSync(ratingsPath,JSON.stringify(ratings));const originalRatings=readFileSync(ratingsPath,'utf8');
  const report=api.runReviewWorkflow({...options,mode:'score'});
  assert.equal(report.semanticQuality,'reviewed');assert.equal(report.learningOutcome,'not_tested');assert.equal(report.paired.caseCount,1);assert.equal(report.paired.correctnessDelta,-1);assert.equal(report.paired.falseCorrectionDelta,1);
  assert.equal(report.arms.baseline.reviewed,1);assert.equal(report.arms.rag.reviewed,1);assert.equal(readFileSync(ratingsPath,'utf8'),originalRatings);
  for(const file of ['generation-review-report.json','generation-review-report.md']){
    const text=readFileSync(join(options.directory,file),'utf8');assert.ok(!text.includes('reviewer-private-name'));assert.ok(!text.includes('private-review-comment'));
  }
});
for(const change of [row=>{row.comments='unfinished review';},row=>{row.correctness=0;},row=>{row.reviewer='reviewer';}])test('prepare preserves any existing human marks or notes instead of overwriting review work',t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});
  const ratings=read(options.directory,'human-review-ratings.json');change(ratings.ratings[0]);writeFileSync(join(options.directory,'human-review-ratings.json'),JSON.stringify(ratings));
  const names=['blind-review-packet.json','blind-review-key.json','human-review-ratings.json','generation-review-report.json'];
  const before=names.map(name=>readFileSync(join(options.directory,name),'utf8'));
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'prepare'}),/REVIEW_RATINGS_EXIST/);
  assert.deepEqual(names.map(name=>readFileSync(join(options.directory,name),'utf8')),before);
});
test('prepare may regenerate an unscored template and keeps all artifacts corresponding',t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});api.runReviewWorkflow({...options,mode:'prepare'});
  const packet=read(options.directory,'blind-review-packet.json'),key=read(options.directory,'blind-review-key.json'),ratings=read(options.directory,'human-review-ratings.json');
  assert.equal(packet.reviewId,key.reviewId);assert.equal(ratings.reviewId,key.reviewId);assert.equal(api.runReviewWorkflow({...options,mode:'score'}).semanticQuality,'not_reviewed');
});
test('score rejects a changed preparation digest and preserves the earlier report',t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});
  const changed=structuredClone(prepared);for(const arm of changed.requests[0].arms)arm.payload.max_tokens=699;
  writeFileSync(join(options.directory,'model-comparison-requests.json'),JSON.stringify(changed));
  const before=readFileSync(join(options.directory,'generation-review-report.json'),'utf8');
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'score'}),/REVIEW_REQUEST_DIGEST_MISMATCH/);
  assert.equal(readFileSync(join(options.directory,'generation-review-report.json'),'utf8'),before);
});
test('score rejects a modified packet before replacing a report',t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});
  const packet=read(options.directory,'blind-review-packet.json');packet.samples[0].learnerText='changed';writeFileSync(join(options.directory,'blind-review-packet.json'),JSON.stringify(packet));
  const before=readFileSync(join(options.directory,'generation-review-report.json'),'utf8');
  assert.throws(()=>api.runReviewWorkflow({...options,mode:'score'}),/INVALID_REVIEW_PACKET/);
  assert.equal(readFileSync(join(options.directory,'generation-review-report.json'),'utf8'),before);
});
test('failed and missing imported samples remain distinct and receive no ratings rows',t=>{
  const options=fixture(t);importResults(options,[{caseId:'case-1',arm:'baseline',status:'failed',error:'FAKE_SECRET'}]);
  const report=api.runReviewWorkflow({...options,mode:'prepare'});
  assert.equal(report.arms.baseline.failed,1);assert.equal(report.arms.rag.missing,1);assert.equal(report.arms.baseline.reviewed,0);assert.equal(report.paired.caseCount,0);
  assert.deepEqual(read(options.directory,'human-review-ratings.json').ratings,[]);assert.ok(!JSON.stringify(read(options.directory,'blind-review-key.json')).includes('FAKE_SECRET'));
});
for(const [name,mode] of [['model-comparison-results.json','prepare'],['blind-review-packet.json','score'],['blind-review-key.json','score'],['human-review-ratings.json','score']])test(`every workflow file is bounded before parsing: ${name}`,t=>{
  const options=fixture(t);importResults(options);api.runReviewWorkflow({...options,mode:'prepare'});writeFileSync(join(options.directory,name),'x'.repeat(4*1024*1024+1));
  assert.throws(()=>api.runReviewWorkflow({...options,mode}),/REVIEW_FILE_TOO_LARGE/);
});
