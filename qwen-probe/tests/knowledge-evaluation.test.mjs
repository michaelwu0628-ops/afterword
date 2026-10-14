import test from 'node:test';
import assert from 'node:assert/strict';
let api={};try{api=await import('../knowledge-evaluation.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const cases=[
  {id:'c1',split:'development',category:'correction',text:'Learner original one.',relevant_card_ids:['a','b'],should_abstain:false,expected_assessment:'suggestions',forbidden:['GOLD_SECRET_ONE']},
  {id:'c2',split:'diagnostic',category:'correct',text:'Learner original two.',relevant_card_ids:['a'],should_abstain:false,expected_assessment:'no_clear_issue',forbidden:['GOLD_SECRET_TWO']},
  {id:'c3',split:'diagnostic',category:'out_of_scope',text:'Unrelated query.',relevant_card_ids:[],should_abstain:true},
];
const retrieve=(index,{text})=>({status:text===cases[2].text?'no_match':'matched',method:'test',corpusVersion:index.version,cards:[],trace:{selectedIds:text===cases[0].text?['b','c']:text===cases[1].text?['x','a']:[]}});
const buildRequest=({text,knowledge})=>({model:'qwen-plus',max_tokens:1200,messages:[{role:'system',content:'Same strong prompt'},{role:'user',content:text},...(knowledge?.trace.selectedIds.length?[{role:'user',content:JSON.stringify({type:'expression_knowledge_reference',status:'matched',cards:knowledge.trace.selectedIds.map(id=>({id}))})}]:[])]});
test('retrieval metrics distinguish recall, reciprocal rank and correct abstention without saving raw text',()=>{
  assert.equal(typeof api.evaluateRetrieval,'function');let time=0;
  const report=api.evaluateRetrieval({version:'v1'},cases,{retrieve,now:()=>time++});
  assert.equal(report.answerableCount,2);assert.equal(report.metrics.recallAtK,.75);assert.equal(report.metrics.mrr,.75);assert.equal(report.metrics.hitAtK,1);assert.equal(report.metrics.abstentionAccuracy,1);
  assert.equal(report.generationStatus,'not_run');assert.equal(report.cases.length,3);assert.ok(!JSON.stringify(report).includes('Learner original'));
});
test('retrieval evaluation rejects duplicate case IDs and missing gold instead of inventing a score',()=>{
  assert.throws(()=>api.evaluateRetrieval({},[cases[0],cases[0]],{retrieve}),/INVALID_EVALUATION_CASE/);
  assert.throws(()=>api.evaluateRetrieval({},[{id:'missing',text:'x'}],{retrieve}),/INVALID_EVALUATION_CASE/);
});
test('comparison preparation uses identical strong prompts and never leaks labels or rubric to either arm',()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases,{retrieve,buildRequest});
  assert.equal(prepared.status,'not_run');assert.equal(prepared.requests.length,3);
  for(const pair of prepared.requests){
    const [base,rag]=pair.arms;assert.equal(base.payload.model,rag.payload.model);assert.equal(base.payload.max_tokens,rag.payload.max_tokens);assert.equal(base.payload.messages[0].content,rag.payload.messages[0].content);assert.equal(base.payload.messages[1].content,rag.payload.messages[1].content);
  }
  assert.ok(!JSON.stringify(prepared).includes('GOLD_SECRET'));assert.ok(!JSON.stringify(prepared).includes('expected_assessment'));
});
test('graph ablation is explicit and sends no more than the declared retrieval budget',()=>{
  const calls=[];api.evaluateRetrieval({},cases,{retrieve:(index,options)=>{calls.push(options);return retrieve(index,options);},graph:false,topK:3});
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.graph===false&&c.topK===3));
});
test('model comparisons cannot run without an explicitly supplied executor',async()=>{
  await assert.rejects(()=>api.runModelComparison({requests:[]}),/EXPLICIT_EXECUTOR_REQUIRED/);
});
test('an explicit executor runs pairs sequentially and leaves semantic quality unreviewed',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,2),{retrieve,buildRequest});let active=0,maxActive=0;const order=[];
  const result=await api.runModelComparison(prepared,{execute:async({caseId,arm})=>{active++;maxActive=Math.max(active,maxActive);order.push(`${caseId}:${arm}`);await Promise.resolve();active--;return {result:{assessment:'no_clear_issue',summary:'可保留。',suggestions:[]}};}});
  assert.equal(result.status,'completed_unreviewed');assert.equal(result.results.length,4);assert.equal(maxActive,1);assert.deepEqual(order,['c1:baseline','c1:rag','c2:baseline','c2:rag']);assert.equal(result.semanticQuality,'not_reviewed');
});
test('execution failures keep fixed diagnostics without copying transport errors or credentials',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});
  const result=await api.runModelComparison(prepared,{execute:async()=>{throw new Error('FAKE_SECRET_IN_TRANSPORT');}});
  assert.equal(result.status,'failed');assert.ok(result.results.every(item=>item.error==='MODEL_EXECUTION_FAILED'));assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
});
for(const mismatch of ['parameters','prompt'])test(`comparison preparation rejects different ${mismatch} between paired arms`,()=>{
  assert.throws(()=>api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest:options=>{
    const body=buildRequest(options);if(options.knowledge){if(mismatch==='parameters')body.model='other-model';else body.messages[0].content='Different strong prompt';}return body;
  }}),/COMPARISON_ARMS_DIFFER/);
});
test('an empty comparison remains not run and never calls the executor',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},[],{retrieve,buildRequest});
  let calls=0;const result=await api.runModelComparison(prepared,{execute:async()=>{calls++;}});
  assert.equal(result.status,'not_run');assert.equal(calls,0);
});
test('execution rechecks paired requests before a modified request can reach a transport',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});prepared.requests[0].arms[1].payload.model='other-model';let calls=0;
  await assert.rejects(()=>api.runModelComparison(prepared,{execute:async()=>{calls++;}}),/COMPARISON_ARMS_DIFFER/);assert.equal(calls,0);
});
test('comparison request validation returns the validated preparation without claiming dataset membership',()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});
  assert.equal(typeof api.validateComparisonRequests,'function');
  assert.equal(api.validateComparisonRequests(prepared),prepared);
});
const invalidPreparations={
  duplicate_id:prepared=>{prepared.requests[1].caseId=prepared.requests[0].caseId;},
  missing_id:prepared=>{delete prepared.requests[1].caseId;},
  malformed_id:prepared=>{prepared.requests[1].caseId='forged id\n';},
  oversized_id:prepared=>{prepared.requests[1].caseId='x'.repeat(257);},
  null_pair:prepared=>{prepared.requests[1]=null;},
  null_arm:prepared=>{prepared.requests[1].arms[1]=null;},
  unknown_arm:prepared=>{prepared.requests[1].arms[1].arm='candidate';},
  incorrect_count:prepared=>{prepared.caseCount++;},
  incorrect_model:prepared=>{prepared.model='unknown-model';},
  missing_corpus:prepared=>{delete prepared.corpusVersion;},
  already_completed:prepared=>{prepared.status='completed_unreviewed';},
  invalid_reference:prepared=>{prepared.requests[1].arms[1].payload.messages[2].content='{"type":"instructions","cards":[{"id":"a"}]}';},
};
for(const [name,mutate] of Object.entries(invalidPreparations))test(`all requests are prevalidated before any executor call: ${name}`,async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,2),{retrieve,buildRequest});mutate(prepared);let calls=0;
  await assert.rejects(()=>api.runModelComparison(prepared,{execute:async()=>{calls++;return {result:{assessment:'no_clear_issue',summary:'可保留。',suggestions:[]}};}}),/INVALID_COMPARISON_REQUESTS|COMPARISON_ARMS_DIFFER/);
  assert.equal(calls,0);
});
test('unavailable and no-match retrievals cannot earn hits from a forged selected-ID trace',()=>{
  for(const status of ['unavailable','no_match']){
    const report=api.evaluateRetrieval({},cases.slice(0,1),{retrieve:()=>({status,trace:{selectedIds:['a','b']},cards:[{id:'a'}]})});
    assert.deepEqual(report.cases[0].selectedIds,[]);assert.equal(report.metrics.recallAtK,0);assert.equal(report.metrics.hitAtK,0);assert.equal(report.metrics.mrr,0);
  }
});
test('malformed completed outputs fail with fixed diagnostics and never retain usage metadata',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});
  const report=await api.runModelComparison(prepared,{execute:async()=>({result:{garbage:true},usage:{prompt_tokens:1,raw_header:'FAKE_SECRET'}})});
  assert.equal(report.status,'failed');assert.ok(report.results.every(item=>item.status==='failed'&&item.error==='MODEL_EXECUTION_FAILED'));
  assert.ok(!JSON.stringify(report).includes('FAKE_SECRET'));assert.ok(report.results.every(item=>!Object.hasOwn(item,'usage')));
});
test('completed outputs are normalized and can cite only cards supplied in their own arm',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});
  const report=await api.runModelComparison(prepared,{execute:async()=>({result:{assessment:'suggestions',summary:'可优化。',suggestions:[{original:'Learner',suggestion:'A learner',reason:'可选说法。',kind:'optional',knowledge_ids:['b']}]}})});
  assert.equal(report.status,'partial_failure');assert.equal(report.results[0].status,'failed');assert.equal(report.results[1].status,'completed');
  const forged=await api.runModelComparison(prepared,{execute:async()=>({result:{assessment:'suggestions',summary:'可优化。',suggestions:[{original:'Learner',suggestion:'A learner',reason:'可选说法。',kind:'optional',knowledge_ids:['not-sent']}]}})});
  assert.equal(forged.status,'failed');
});
test('usage stores only known nonnegative safe integer token counts',async()=>{
  const prepared=api.prepareModelComparison({version:'v1'},cases.slice(0,1),{retrieve,buildRequest});
  const report=await api.runModelComparison(prepared,{execute:async()=>({result:{assessment:'no_clear_issue',summary:'可保留。',suggestions:[],raw:'discard'},usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,raw_header:'FAKE_SECRET',prompt_tokens_details:{raw:'FAKE_SECRET'}}})});
  assert.deepEqual(report.results[0].usage,{prompt_tokens:10,completion_tokens:2,total_tokens:12});assert.ok(!JSON.stringify(report).includes('FAKE_SECRET'));assert.ok(!Object.hasOwn(report.results[0].result,'raw'));
  const invalid=await api.runModelComparison(prepared,{execute:async()=>({result:{assessment:'no_clear_issue',summary:'可保留。',suggestions:[]},usage:{prompt_tokens:-1,completion_tokens:NaN,total_tokens:Number.MAX_SAFE_INTEGER+1}})});
  assert.equal(invalid.results[0].usage,null);
});
