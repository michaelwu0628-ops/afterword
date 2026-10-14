import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../public/coach-connection.mjs').catch(()=>({}));
function fixture({timerLag=0,sendCost=0}={}){
  assert.equal(typeof api.createCoachConnection,'function');
  const sockets=[],timers=new Map(),events=[];let next=1,clock=0;
  class Socket{constructor(){this.readyState=0;this.bufferedAmount=0;this.sent=[];this.audioTimes=[];sockets.push(this);}send(raw){const value=JSON.parse(raw);this.sent.push(value);if(value.type==='input.audio'){this.audioTimes.push(clock);clock+=sendCost;}}close(){this.readyState=3;this.onclose?.();}open(){this.readyState=1;this.onopen?.();}event(value){this.onmessage?.({data:JSON.stringify(value)});}}
  const connection=api.createCoachConnection({WebSocketImpl:Socket,url:'ws://127.0.0.1:1/connect',now:()=>clock,setTimer:(fn,ms)=>{const id=next++;timers.set(id,{fn,at:clock+ms+timerLag});return id;},clearTimer:id=>timers.delete(id),onEvent:e=>events.push(e)});
  const firstTimer=()=>[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
  const tick=()=>{const first=firstTimer();if(first){timers.delete(first[0]);clock=Math.max(clock,first[1].at);first[1].fn();}};
  const advance=ms=>{const target=clock+ms;while(firstTimer()?.[1].at<=target)tick();clock=Math.max(clock,target);};
  return {connection,sockets,timers,events,tick,advance,elapse:ms=>{clock+=ms;},now:()=>clock};
}
test('explicit connect does not start audio; gated PCM waits for input.ready and is paced before EndASR',()=>{
  const f=fixture();assert.equal(f.sockets.length,0);
  f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();
  assert.equal(socket.sent[0].type,'connect');assert.equal(f.connection.canStartTurn,false);
  socket.event({type:'ready'});assert.equal(f.connection.canStartTurn,true);
  assert.equal(f.connection.startTurn('t1',{responseId:null,audioEndMs:0}),true);
  f.connection.push(new Int16Array(320));f.connection.push(new Int16Array(320));f.connection.finishTurn();
  f.tick();assert.equal(socket.sent.some(x=>x.type==='input.audio'),false);
  socket.event({type:'input.ready',turnId:'t1'});
  assert.equal(socket.sent.filter(x=>x.type==='input.audio').length,1);
  f.tick();assert.equal(socket.sent.filter(x=>x.type==='input.audio').length,2);
  f.tick();assert.equal(socket.sent.at(-1).type,'input.end');
  assert.equal(f.connection.canStartTurn,false);
  socket.event({type:'user.transcript',turnId:'t1',text:'Hello.'});assert.equal(f.connection.canStartTurn,false);
  socket.event({type:'reply.start',replyId:'r1'});assert.equal(f.connection.canStartTurn,true);
  f.connection.disconnect();assert.equal(f.timers.size,0);
});
test('disconnect discards unsent PCM and old socket events cannot revive a new call',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const old=f.sockets[0];old.open();old.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});f.connection.push(new Int16Array(320));
  const late=old.onmessage;f.connection.disconnect();
  f.connection.connect({appId:'offline',accessToken:'ANOTHER_FAKE'});const current=f.sockets[1];current.open();
  late({data:JSON.stringify({type:'ready'})});late({data:JSON.stringify({type:'input.ready',turnId:'t1'})});
  assert.equal(f.connection.ready,false);assert.equal(current.sent.length,1);
  f.connection.disconnect();assert.equal(f.timers.size,0);
});
test('waiting audio and websocket backpressure are bounded; ending drops unsent audio',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});
  for(let i=0;i<500;i++)assert.equal(f.connection.push(new Int16Array(320)),true);
  assert.equal(f.connection.push(new Int16Array(320)),false);assert.equal(f.connection.ready,false);
  assert.ok(f.events.some(x=>x.type==='error'&&x.code==='AUDIO_QUEUE_LIMIT'));
  const g=fixture();g.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});g.sockets[0].open();g.sockets[0].event({type:'ready'});
  g.connection.startTurn('t2',{responseId:null,audioEndMs:0});g.connection.push(new Int16Array(320));g.connection.end();
  assert.equal(g.sockets[0].sent.at(-1).type,'session.end');assert.equal(g.connection.canStartTurn,false);
  g.sockets[0].event({type:'input.ready',turnId:'t2'});g.tick();assert.equal(g.sockets[0].sent.some(x=>x.type==='input.audio'),false);
  g.connection.disconnect();
  const h=fixture();h.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});h.sockets[0].open();h.sockets[0].event({type:'ready'});h.sockets[0].bufferedAmount=262145;
  assert.equal(h.connection.startTurn('t3',{responseId:null,audioEndMs:0}),false);assert.equal(h.connection.ready,false);
});
test('review requires generation to finish while barge-in remains available; recoverable errors keep the call',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});f.connection.push(new Int16Array(320));socket.event({type:'input.ready',turnId:'t1'});f.connection.finishTurn();f.tick();
  socket.event({type:'user.transcript',turnId:'t1',text:'Hello.'});socket.event({type:'reply.start',replyId:'r1'});
  assert.equal(f.connection.canStartTurn,true);assert.equal(f.connection.canReview,false);
  assert.equal(f.connection.requestReview(),false);assert.equal(f.connection.resumeChat(),false);
  socket.event({type:'reply.done',replyId:'r1'});assert.equal(f.connection.canReview,true);
  socket.event({type:'error',code:'BUSY',fatal:false,message:'请稍等。'});assert.equal(f.connection.ready,true);
  f.connection.disconnect();
});
test('hangup while the local socket is opening cancels credentials and ignores late open or ready',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0],lateOpen=socket.onopen,lateMessage=socket.onmessage;
  f.connection.end();lateOpen();lateMessage({data:JSON.stringify({type:'ready'})});
  assert.equal(socket.readyState,3);assert.equal(socket.sent.length,0);assert.equal(f.connection.ready,false);assert.equal(f.events.some(event=>event.type==='ready'),false);
});

for(const timerLag of [2,20])test(`absolute pacing tolerates ${timerLag}ms timer lateness for sixty seconds`,()=>{
  const f=fixture({timerLag});f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});socket.event({type:'input.ready',turnId:'t1'});
  for(let frame=0;frame<3000;frame++){f.advance(20);assert.equal(f.connection.push(new Int16Array(320)),true);}
  f.connection.finishTurn();const captureEnded=f.now();while(f.timers.size&&f.now()-captureEnded<100)f.tick();
  assert.equal(socket.sent.filter(event=>event.type==='input.audio').length,3000);
  assert.ok(socket.sent.filter(event=>event.type==='input.audio').every(event=>Buffer.from(event.audio,'base64').length===640));
  assert.ok(socket.audioTimes.at(-1)-socket.audioTimes[0]<=60000);
  assert.equal(socket.sent.at(-1).type,'input.end');assert.ok(f.now()-captureEnded<=40,'upload tail must remain within two PCM frames');
  assert.equal(f.events.some(event=>event.type==='error'),false);assert.equal(f.timers.size,0);f.connection.disconnect();
});
test('PCM send processing time is deducted from the next twenty-millisecond deadline',()=>{
  const f=fixture({sendCost:2});f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});for(let frame=0;frame<100;frame++)f.connection.push(new Int16Array(320));f.connection.finishTurn();
  socket.event({type:'input.ready',turnId:'t1'});while(f.timers.size)f.tick();
  assert.equal(socket.audioTimes.at(-1)-socket.audioTimes[0],99*20);assert.equal(socket.sent.at(-1).type,'input.end');f.connection.disconnect();
});
test('a severe timer suspension reanchors pacing after one frame instead of flushing a burst',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});for(let frame=0;frame<20;frame++)f.connection.push(new Int16Array(320));socket.event({type:'input.ready',turnId:'t1'});
  f.elapse(500);f.tick();
  assert.equal(socket.audioTimes.length,2);assert.equal(socket.audioTimes[1],500);assert.equal([...f.timers.values()][0].at,520);
  f.tick();assert.equal(socket.audioTimes[2],520);f.connection.disconnect();
});
test('the final queued PCM frame sends input.end immediately without a trailing timer',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});f.connection.push(new Int16Array(320));f.connection.push(new Int16Array(320));f.connection.finishTurn();
  socket.event({type:'input.ready',turnId:'t1'});f.tick();
  assert.equal(socket.sent.at(-1).type,'input.end');assert.equal(f.timers.size,0);f.connection.disconnect();
});
test('a completed live queue sends input.end without waiting for its pacing timer',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});socket.event({type:'input.ready',turnId:'t1'});f.connection.push(new Int16Array(320));f.connection.finishTurn();
  assert.equal(socket.sent.at(-1).type,'input.end');assert.equal(f.timers.size,0);f.connection.disconnect();
});
test('a cancelled old pump callback cannot send PCM or replace a new session timer',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const old=f.sockets[0];old.open();old.event({type:'ready'});
  f.connection.startTurn('old',{responseId:null,audioEndMs:0});f.connection.push(new Int16Array(320));old.event({type:'input.ready',turnId:'old'});
  const late=[...f.timers.values()][0].fn;f.connection.disconnect();
  f.connection.connect({appId:'offline',accessToken:'ANOTHER_FAKE'});const current=f.sockets[1];current.open();current.event({type:'ready'});
  f.connection.startTurn('new',{responseId:null,audioEndMs:0});f.connection.push(new Int16Array(320));f.connection.push(new Int16Array(320));current.event({type:'input.ready',turnId:'new'});
  const timer=[...f.timers.keys()][0];late();
  assert.equal(current.sent.filter(event=>event.type==='input.audio').length,1);assert.deepEqual([...f.timers.keys()],[timer]);f.connection.disconnect();
});
for(const waitingFor of ['input_ready','truncate_ack','reply_end','truncate_ack_and_reply_end'])test(`gate queue overflow safely identifies ${waitingFor}`,()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});
  if(waitingFor!=='input_ready')socket.event({type:'input.waiting',turnId:'t1',waitFor:waitingFor});
  for(let i=0;i<500;i++)assert.equal(f.connection.push(new Int16Array(320)),true);
  assert.equal(socket.sent.some(event=>event.type==='input.audio'),false);assert.equal(f.connection.push(new Int16Array(320)),false);
  const error=f.events.find(event=>event.type==='error');
  assert.equal(error.code,'AUDIO_QUEUE_LIMIT');assert.equal(error.queueStage,'gate');assert.equal(error.waitingFor,waitingFor);
  assert.equal(error.queuedMs,10000);assert.equal(error.maxQueuedMs,10000);assert.equal(f.timers.size,0);
  assert.deepEqual(Object.keys(error).sort(),['type','code','message','queueStage','waitingFor','queuedMs','maxQueuedMs'].sort());
});
test('input.waiting only records matched fixed progress and never opens the upload gate',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});
  socket.event({type:'input.waiting',turnId:'t1',waitFor:'truncate_ack_and_reply_end'});
  socket.event({type:'input.waiting',turnId:'other',waitFor:'truncate_ack'});socket.event({type:'input.waiting',turnId:'t1',waitFor:'UNTRUSTED'});
  socket.event({type:'input.waiting',turnId:'t1',waitFor:'reply_end'});
  for(let i=0;i<501;i++)f.connection.push(new Int16Array(320));
  assert.equal(socket.sent.some(event=>event.type==='input.audio'),false);
  assert.equal(f.events.find(event=>event.type==='error').waitingFor,'reply_end');
  assert.equal(f.events.some(event=>event.waitFor==='UNTRUSTED'||event.turnId==='other'),false);
});
test('an open upload gate reports scheduling backlog without relaxing its queue bound',()=>{
  const f=fixture();f.connection.connect({appId:'offline',accessToken:'NOT_A_KEY'});const socket=f.sockets[0];socket.open();socket.event({type:'ready'});
  f.connection.startTurn('t1',{responseId:null,audioEndMs:0});socket.event({type:'input.ready',turnId:'t1'});
  for(let i=0;i<502;i++)f.connection.push(new Int16Array(320));
  const error=f.events.find(event=>event.type==='error');assert.equal(error.code,'AUDIO_QUEUE_LIMIT');assert.equal(error.queueStage,'upload');
  assert.equal(Object.hasOwn(error,'waitingFor'),false);assert.equal(error.queuedMs,10000);assert.equal(error.maxQueuedMs,10000);
  assert.equal(socket.sent.filter(event=>event.type==='input.audio').length,1);assert.equal(f.timers.size,0);
});
