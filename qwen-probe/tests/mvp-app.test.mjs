import test from 'node:test';import assert from 'node:assert/strict';
import {initProductApp} from '../public/mvp-app.mjs';
import {createMemoryPracticeStore} from '../public/mvp-store.mjs';
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
// Minimal event/DOM adapter: exercise application lifecycle without browser,
// microphone, provider credentials, or an implementation-derived fake store.
class Element{
  constructor(){this.listeners={};this.dataset={};this.value='';this.children=[];this.hidden=false;this.classList={add(){},remove(){},toggle(){}};this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;}
  addEventListener(name,fn){this.listeners[name]=fn;}click(){return this.listeners.click?.({preventDefault(){}});}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(){}removeAttribute(){}querySelector(){return null;}querySelectorAll(){return [];}getBoundingClientRect(){return {top:0};}
}
function fixture({beforePut,savedTopics=[]}={}){
  const ids=new Map(),views=['home','listen','part2','practice','history','review-items','settings'].map(name=>{const e=new Element();e.dataset.view=name;return e;}),wordmark=new Element();
  const document={getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},createElement(){return new Element();},querySelector(selector){if(selector==='.wordmark')return wordmark;const name=selector.match(/data-view="([^"]+)"/)?.[1];return views.find(e=>e.dataset.view===name)||null;},querySelectorAll(selector){return selector==='[data-view]'?views:[];}};
  const topicWrites=[];const window={localStorage:{getItem:()=>JSON.stringify(savedTopics),setItem(key,value){topicWrites.push(JSON.parse(value));}},setInterval:()=>1,clearInterval(){},addEventListener(){},scrollTo(){},confirm:()=>true};
  const store=createMemoryPracticeStore(),realPut=store.putPractice.bind(store);let puts=0;
  store.putPractice=async value=>{puts++;await beforePut?.(puts);return realPut(value);};
  const calls=[];
  const app=initProductApp({document,window,store,callFactory:options=>{const call={options,state:{ended:false,ready:false},starts:0,async start(){this.starts++;this.state.ready=true;},end(){this.state.ended=true;this.state.ready=false;},async dispose(){this.end();options.onSnapshot({turns:[{id:'last',role:'user',text:'Final words.',phase:'chat'}],status:'complete'});}};calls.push(call);return call;}});
  const get=id=>document.getElementById(id);get('voice-auth').value='api-key';get('mvp-voice-key').value='FAKE_ONLY';get('enable-feedback').checked=false;get('mvp-reply-wait').value='1500';get('service-form').listeners.submit({preventDefault(){}});
  return {app,store,calls,get,topicWrites,get puts(){return puts;}};
}
test('leaving during initial save never starts a late call',async()=>{
  const gate=deferred(),f=fixture({beforePut:n=>n===1?gate.promise:undefined});f.get('begin-part2-answer').click();await flush();f.app.dispose();gate.resolve();await flush();assert.equal(f.calls.length,0);
});
test('double start while initial save is pending creates exactly one call',async()=>{
  const gate=deferred(),f=fixture({beforePut:n=>n===1?gate.promise:undefined});f.get('begin-part2-answer').click();f.get('begin-part2-answer').click();await flush();assert.equal(f.puts,1);gate.resolve();await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].starts,1);f.app.dispose();
});
test('a previous call cannot overwrite a new practice with a late snapshot',async()=>{
  const f=fixture();f.get('begin-part2-answer').click();await flush();const previous=f.calls[0];previous.end();f.get('begin-part2-answer').click();await flush();const id=f.app.currentPractice.id;previous.options.onSnapshot({turns:[{id:'stale',role:'user',text:'STALE'}],status:'complete'});await flush();assert.equal(f.app.currentPractice.id,id);assert.ok(!(await f.store.getPractice(id)).turns.some(t=>t.text==='STALE'));f.app.dispose();
});
test('dispose accepts the final synchronous snapshot before disabling updates',async()=>{
  const f=fixture();f.get('begin-part2-answer').click();await flush();const id=f.app.currentPractice.id;f.app.dispose();await flush();assert.equal((await f.store.getPractice(id)).turns[0].text,'Final words.');
});
test('deletion flushes saves and rejects a late callback for the deleted practice',async()=>{
  const f=fixture();f.get('begin-part2-answer').click();await flush();const old=f.calls[0],id=f.app.currentPractice.id;old.end();f.app.navigate('history');await flush();const card=f.get('history-list').children[0];await card.children[1].children[1].click();old.options.onSnapshot({turns:[{id:'late',role:'user',text:'Late reply'}],status:'complete'});await flush();assert.equal(await f.store.getPractice(id),null);f.app.dispose();
});
test('clear flushes the current call and prevents late saved records',async()=>{
  const f=fixture();f.get('begin-part2-answer').click();await flush();const old=f.calls[0];old.end();await f.get('clear-history').click();old.options.onSnapshot({turns:[{id:'late',role:'user',text:'Late reply'}],status:'complete'});await flush();assert.deepEqual(await f.store.listPractices(),[]);f.app.dispose();
});
test('initial storage failure prevents any call from starting',async()=>{
  const f=fixture({beforePut:()=>Promise.reject(new Error('storage unavailable'))});f.get('begin-part2-answer').click();await flush();assert.equal(f.calls.length,0);assert.equal(f.get('notice').textContent,'storage unavailable');f.app.dispose();
});
test('a delayed history read cannot cancel a new practice started while waiting',async()=>{
  const f=fixture(),gate=deferred(),old={id:'old',mode:'part2',title:'Old record',turns:[],status:'complete'};f.store.getPractice=async()=>gate.promise;const reading=f.app.openPractice('old');await flush();f.get('begin-part2-answer').click();await flush();const id=f.app.currentPractice.id;gate.resolve(old);await reading;assert.equal(f.app.currentPractice.id,id);f.app.dispose();
});

test('history export offers a local backup download without starting a model call',async()=>{
  const f=fixture();await f.get('export-backup').click();await flush();assert.match(f.get('backup-download').download,/afterword/);assert.match(f.get('backup-download').href,/^blob:/);assert.match(f.get('backup-status').textContent,/已导出/);assert.equal(f.calls.length,0);f.app.dispose();
});
test('backup controls cannot read records while a call is active',async()=>{
  const f=fixture();let exports=0;f.store.exportData=async()=>{exports++;return {practices:[],reviewPolicy:[]};};f.get('begin-part2-answer').click();await flush();await f.get('export-backup').click();assert.equal(exports,0);assert.match(f.get('backup-status').textContent,/结束/);f.app.dispose();
});
test('history import restores audio and a damaged second file leaves records unchanged',async()=>{
  const {encodeBackup}=await import('../public/mvp-backup.mjs');const f=fixture(),audio=new Blob([new Uint8Array([1,2,3,4])],{type:'audio/wav'});
  const encoded=await encodeBackup({data:{practices:[{id:'restored',mode:'material',title:'Restored fixture',turns:[{id:'t1',role:'user',text:'Tea.',phase:'chat',audio}],status:'complete'}],reviewPolicy:[]},topics:[]});
  f.get('backup-file').files=[encoded.blob];await f.get('backup-file').listeners.change?.();await flush();const restored=await f.store.getPractice('restored');assert.ok(restored);assert.equal(restored.turns[0].audio.size,4);assert.match(f.get('backup-status').textContent,/已导入/);assert.equal(f.calls.length,0);
  f.get('backup-file').files=[new Blob(['not JSON'],{type:'application/json'})];await f.get('backup-file').listeners.change?.();assert.match(f.get('backup-status').textContent,/格式|损坏/);assert.equal((await f.store.listPractices()).length,1);f.app.dispose();
});
test('clearing history cannot release an in-flight backup import lock',async()=>{
  const {encodeBackup}=await import('../public/mvp-backup.mjs'),f=fixture(),gate=deferred();const encoded=await encodeBackup({data:{practices:[],reviewPolicy:[]}}),bytes=await encoded.blob.arrayBuffer();
  class SlowBackup extends Blob{arrayBuffer(){return gate.promise;}}
  f.get('backup-file').files=[new SlowBackup([bytes],{type:'application/json'})];const importing=f.get('backup-file').listeners.change();await flush();await f.get('clear-history').click();f.get('begin-part2-answer').click();await flush();const starts=f.calls.length;gate.resolve(bytes);await importing;assert.equal(starts,0);assert.equal(f.calls.length,0);f.app.dispose();
});
const customFixtureTopics=count=>Array.from({length:count},(_,i)=>({id:`custom-${i}`,title:`Legacy ${i}`,prompt:'Describe a conversation.',bullets:['Who you spoke with'],category:'自添',custom:true}));
test('the 101st custom topic is refused before changing stored topics',()=>{
  const f=fixture({savedTopics:customFixtureTopics(100)});f.get('custom-title').value='One more';f.get('custom-prompt').value='Describe a new experience.';f.get('custom-bullets').value='What happened';f.get('save-custom-topic').click();assert.equal(f.topicWrites.length,0);assert.match(f.get('notice').textContent,/100/);f.app.dispose();
});
test('legacy topics above the backup limit remain visible and can be removed explicitly',()=>{
  const f=fixture({savedTopics:customFixtureTopics(101)});f.get('topic-category').value='all';f.get('topic-category').listeners.change();const last=f.get('topic-list').children.find(e=>e.textContent?.includes('Legacy 100'));assert.ok(last,'do not silently truncate legacy topics');last.click();f.get('delete-custom-topic').click();assert.equal(f.topicWrites.at(-1).length,100);assert.ok(!f.topicWrites.at(-1).some(t=>t.id==='custom-100'));f.app.dispose();
});
