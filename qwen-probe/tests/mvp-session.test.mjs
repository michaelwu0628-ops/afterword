import test from 'node:test';
import assert from 'node:assert/strict';
let api={};try{api=await import('../public/mvp-session.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(mode='material',{captureStart=async()=>true}={}){
  let event,pcm,stopped,detector;const calls=[],snapshots=[];
  const connection={ready:false,canStartTurn:true,canReview:true,connect(c){calls.push(['connect',c]);},startTurn(id){calls.push(['turn',id]);return true;},push(frame){calls.push(['push',frame.length]);event({type:'input.sent',turnId:calls.find(x=>x[0]==='turn').at(-1),pcm:frame});return true;},finishTurn(){calls.push(['finish']);},requestReview(){calls.push(['review']);return true;},resumeChat(){return true;},end(){calls.push(['end']);},disconnect(){calls.push(['disconnect']);}};
  const session=api.createPracticeCall({config:{authType:'api-key',apiKey:'FAKE_VOICE_SECRET'},practice:{id:'p1',mode,title:'Practice',topic:{id:'topic-id',category:'place',custom:true,title:'A place',prompt:'Describe a place.',bullets:[]}},onSnapshot:s=>snapshots.push(s),
    connectionFactory:options=>{event=options.onEvent;return connection;},captureFactory:options=>{pcm=options.onPcm;stopped=options.onStop;return {start:async()=>{calls.push(['mic.start']);return captureStart();},stop:async reason=>{calls.push(['mic.stop',reason]);},dispose:async()=>{calls.push(['mic.dispose']);}};},
    playbackFactory:()=>({playing:false,unlock:async()=>true,stop:()=>({responseId:null,audioEndMs:0}),activate(){},enqueue:()=>true,dispose:async()=>{}}),detectorFactory:options=>{detector={push(frame){calls.push(['detector',frame.length]);},reset(){},options};return detector;}});
  return {session,calls,snapshots,event:e=>event(e),pcm:p=>pcm(p),stop:r=>stopped(r),connection,get detector(){return detector;}};
}
test('call requires explicit start and upstream readiness before opening a microphone',async()=>{
  assert.equal(typeof api.createPracticeCall,'function');const f=fixture();assert.equal(f.calls.length,0);await f.session.start();assert.equal(f.calls.filter(x=>x[0]==='mic.start').length,0);
  f.event({type:'ready'});await flush();assert.equal(f.calls.filter(x=>x[0]==='mic.start').length,1);
});
test('Part 2 sends only permitted teaching fields rather than storage topic metadata',async()=>{
  const f=fixture('part2');await f.session.start();const context=f.calls.find(item=>item[0]==='connect')[1].practice;
  assert.deepEqual(context.topic,{title:'A place',prompt:'Describe a place.',bullets:[]});
});
test('ending while connection is pending prevents late readiness from restarting capture',async()=>{
  const f=fixture();await f.session.start();f.session.end();f.event({type:'ready'});await flush();assert.equal(f.calls.filter(x=>x[0]==='mic.start').length,0);
});
test('Part 2 independent audio bypasses silence detection until the learner finishes',async()=>{
  const f=fixture('part2');await f.session.start();f.event({type:'ready'});await flush();f.pcm(new Int16Array(640));
  assert.equal(f.calls.filter(x=>x[0]==='push').length,2);assert.equal(f.calls.filter(x=>x[0]==='detector').length,0);assert.equal(f.calls.filter(x=>x[0]==='finish').length,0);
  await f.session.finishAnswer();assert.equal(f.calls.filter(x=>x[0]==='finish').length,1);
});
test('normal conversation retains the existing detector and only saves actually sent PCM',async()=>{
  const f=fixture();await f.session.start();f.event({type:'ready'});await flush();f.pcm(new Int16Array(640));assert.equal(f.calls.filter(x=>x[0]==='detector').length,1);
  f.detector.options.onStart();f.detector.options.onAudio(new Int16Array(320));f.detector.options.onEnd();f.event({type:'user.transcript',turnId:'turn-1',text:'I enjoy tea.',phase:'chat'});
  const last=f.snapshots.at(-1);assert.equal(last.turns[0].text,'I enjoy tea.');assert.equal(last.turns[0].audio.size,684);assert.ok(!JSON.stringify(last).includes('FAKE_VOICE_SECRET'));
});
test('end stops devices immediately while a late legitimate review can still be saved',async()=>{
  const f=fixture();await f.session.start();f.event({type:'ready'});await flush();f.session.end();assert.ok(f.calls.some(x=>x[0]==='mic.stop'));
  f.event({type:'review.result',result:{assessment:'no_clear_issue',summary:'可以保留。',suggestions:[]}});assert.equal(f.snapshots.at(-1).review.assessment,'no_clear_issue');assert.equal(f.snapshots.at(-1).status,'complete');
});
test('dispose releases connection and devices and ignores stale review callbacks',async()=>{
  const f=fixture();await f.session.start();await f.session.dispose();const count=f.snapshots.length;f.event({type:'review.result',result:{suggestions:[]}});assert.equal(f.snapshots.length,count);assert.ok(f.calls.some(x=>x[0]==='disconnect'));
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('local capture failure closes the upstream connection and keeps an interrupted snapshot',async()=>{
  const f=fixture('material',{captureStart:async()=>false});await f.session.start();f.event({type:'ready'});await flush();
  assert.equal(f.session.state.ended,true);assert.equal(f.snapshots.at(-1).status,'interrupted');
  assert.ok(f.calls.some(x=>x[0]==='disconnect'),'local failure must close the upstream connection');
});
test('repeated resume while capture is opening starts only one device attempt',async()=>{
  const pending=deferred();let starts=0;
  const f=fixture('material',{captureStart:async()=>++starts===1?true:starts===2?pending.promise:Promise.reject(new Error('already starting'))});
  await f.session.start();f.event({type:'ready'});await flush();f.session.pause();
  const first=f.session.resume();await flush();const second=f.session.resume();await second;
  assert.equal(starts,2);assert.equal(f.session.state.starting,true);assert.equal(f.session.state.ended,false);
  pending.resolve(true);await first;assert.equal(f.session.state.mic,true);assert.equal(f.session.state.starting,false);
});
test('pause invalidates a pending capture start and its late success stays paused',async()=>{
  const pending=deferred();let starts=0;
  const f=fixture('material',{captureStart:async()=>++starts===1?true:pending.promise});
  await f.session.start();f.event({type:'ready'});await flush();f.session.pause();
  const resumed=f.session.resume();await flush();f.session.pause();pending.resolve(true);await resumed;
  assert.equal(f.session.state.mic,false);assert.equal(f.session.state.starting,false);assert.equal(f.session.state.ended,false);assert.equal(f.session.state.stage,'paused');
  assert.ok(f.calls.some(x=>x[0]==='mic.stop'&&x[1]==='cancel'));
});
test('pause invalidates a pending capture failure without converting it to a call failure',async()=>{
  const pending=deferred();let starts=0;
  const f=fixture('material',{captureStart:async()=>++starts===1?true:pending.promise});
  await f.session.start();f.event({type:'ready'});await flush();f.session.pause();
  const resumed=f.session.resume();await flush();f.session.pause();pending.reject(new Error('cancelled'));await resumed;
  assert.equal(f.session.state.mic,false);assert.equal(f.session.state.ended,false);assert.equal(f.session.state.stage,'paused');assert.equal(f.session.state.starting,false);
});
test('end while capture is opening stops a late device result and keeps the call ended',async()=>{
  const pending=deferred();const f=fixture('material',{captureStart:()=>pending.promise});
  await f.session.start();f.event({type:'ready'});await flush();f.session.end();pending.resolve(true);await flush();
  assert.equal(f.session.state.mic,false);assert.equal(f.session.state.ended,true);assert.equal(f.session.state.stage,'ended');assert.equal(f.session.state.starting,false);
  assert.ok(f.calls.some(x=>x[0]==='mic.stop'&&x[1]==='cancel'));
});
test('sent PCM is checkpointed about once a second before a transcript exists',async()=>{
  const f=fixture();await f.session.start();f.event({type:'ready'});await flush();f.detector.options.onStart();
  for(let i=0;i<49;i++)f.detector.options.onAudio(new Int16Array(320));
  assert.equal(f.snapshots.length,0,'sub-second input does not cause a save for every frame');
  f.detector.options.onAudio(new Int16Array(320));
  assert.equal(f.snapshots.length,1);const turn=f.snapshots.at(-1).turns[0];
  assert.equal(turn.audio.size,32044);assert.equal(turn.duration,1);assert.equal(turn.incomplete,true);
  assert.ok(!Object.hasOwn(turn,'audioSamples'));assert.ok(!Object.hasOwn(turn,'chunks'));
  for(let i=0;i<50;i++)f.detector.options.onAudio(new Int16Array(320));
  assert.equal(f.snapshots.length,2);assert.equal(f.snapshots.at(-1).turns[0].duration,2);
});
test('ending and disposing checkpoint sub-second sent audio without claiming a finished transcript',async()=>{
  for(const action of ['end','dispose']){
    const f=fixture();await f.session.start();f.event({type:'ready'});await flush();f.detector.options.onStart();f.detector.options.onAudio(new Int16Array(320));
    await f.session[action]();const saved=f.snapshots.at(-1).turns[0];
    assert.equal(saved.audio.size,684);assert.equal(saved.text,'');assert.equal(saved.incomplete,true);
  }
});
test('a final transcript clears checkpoint incompleteness but never clears a real upload drop',async()=>{
  const f=fixture();await f.session.start();f.event({type:'ready'});await flush();f.detector.options.onStart();
  for(let i=0;i<50;i++)f.detector.options.onAudio(new Int16Array(320));
  assert.equal(f.snapshots.at(-1)?.turns[0].incomplete,true);
  f.event({type:'user.transcript',turnId:'turn-1',text:'I enjoy tea.',phase:'chat'});assert.equal(f.snapshots.at(-1).turns[0].incomplete,false);
  f.event({type:'input.dropped',turnId:'turn-1'});f.event({type:'user.transcript',turnId:'turn-1',text:'I enjoy tea.',phase:'chat'});
  assert.equal(f.snapshots.at(-1).turns[0].incomplete,true);
});
