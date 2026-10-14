import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {createCoachConnection} from '../public/coach-connection.mjs';
const api=await import('../coach-server.mjs').catch(()=>({}));
test('coach server exports a separate loopback entry without listening on import',()=>{assert.equal(typeof api.createCoachServer,'function');});
async function fixture(t){
  let calls=0;
  const server=api.createCoachServer({port:0,upstreamFactory(){calls++;const socket=new EventEmitter();socket.readyState=1;socket.bufferedAmount=0;socket.send=()=>{};socket.close=()=>{};return socket;},fetchImpl(){throw new Error('OFFLINE_ONLY');},connectTimeoutMs:100});
  const address=await server.listen();t.after(()=>server.close());const origin=`http://127.0.0.1:${address.port}`;
  return {server,origin,url:origin.replace('http:','ws:')+'/connect',calls:()=>calls};
}
function open(url,origin){return new Promise((resolve,reject)=>{const ws=new WebSocket(url,{origin});ws.once('open',()=>resolve(ws));ws.once('error',reject);});}
test('new static routes and socket enforce origin and never create a model from browsing',async t=>{
  assert.equal(typeof api.createCoachServer,'function');const f=await fixture(t);
  const response=await fetch(f.origin+'/');assert.equal(response.status,200);assert.match(await response.text(),/一起语音复盘/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  for(const path of ['/doubao-coach.mjs','/../provider.mjs','/index.html?secret=1'])assert.equal((await fetch(f.origin+path)).status,404);
  assert.equal((await fetch(f.origin+'/',{method:'POST'})).status,405);
  await assert.rejects(open(f.url,'https://example.invalid'));
  const ws=await open(f.url,f.origin),closed=new Promise(resolve=>ws.once('close',resolve));ws.send(JSON.stringify({type:'connect'}));await closed;
  assert.equal(f.calls(),0);
});
test('connect rejects mixed modes and unknown fields without opening upstream',async t=>{
  const f=await fixture(t);
  for(const config of [
    {authType:'api-key',apiKey:'OFFLINE_API_KEY',appId:'offline',accessToken:'OFFLINE_TOKEN'},
    {authType:'legacy',appId:'offline',accessToken:'OFFLINE_TOKEN',apiKey:'OFFLINE_API_KEY'},
    {appId:'offline',accessToken:'OFFLINE_TOKEN',apiKey:'OFFLINE_API_KEY'},
    {authType:'other',appId:'offline',accessToken:'OFFLINE_TOKEN'},
    {authType:'api-key',apiKey:'OFFLINE_API_KEY',endpoint:'wss://example.invalid'},
    {authType:'api-key',apiKey:'x\n'},
  ]){
    const ws=await open(f.url,f.origin),messages=[];
    ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
    const closed=new Promise(resolve=>ws.once('close',resolve));ws.send(JSON.stringify({type:'connect',...config}));await closed;
    assert.equal(messages[0]?.code,'INVALID_CONNECT');
    assert.equal(JSON.stringify(messages).includes('OFFLINE_'),false);
  }
  assert.equal(f.calls(),0);
});
for(const [authName,credentials] of [
  ['API Key',{authType:'api-key',apiKey:'OFFLINE_API_KEY'}],
  ['explicit legacy',{authType:'legacy',appId:'offline',accessToken:'OFFLINE_TOKEN'}],
  ['implicit legacy',{appId:'offline',accessToken:'OFFLINE_TOKEN'}],
])test(`${authName}: automatic PCM, transcript and shared review cross the real local socket offline`,async t=>{
  const sent=[],events=[],requests=[];let sessionId,upstream,deadline,audioTurns=0;
  const upstreamCalls=[];
  const serverFrame=(event,payload)=>{
    const binary=Buffer.isBuffer(payload),body=binary?payload:Buffer.from(JSON.stringify(payload)),identifier=Buffer.from(event===50?'offline-connect':sessionId);
    const numbers=Buffer.alloc(12);numbers.writeInt32BE(event);numbers.writeUInt32BE(identifier.length,4);numbers.writeUInt32BE(body.length,8);
    return Buffer.concat([Buffer.from([0x11,binary?0xb4:0x94,binary?0:0x10,0]),numbers.subarray(0,8),identifier,numbers.subarray(8),body]);
  };
  const local=api.createCoachServer({port:0,upstreamFactory:(url,options)=>{
    upstreamCalls.push({url,options});
    upstream=new EventEmitter();upstream.readyState=1;upstream.bufferedAmount=0;upstream.close=()=>{};
    const event=(id,payload)=>queueMicrotask(()=>upstream.emit('message',serverFrame(id,payload),true));
    upstream.send=raw=>{
      const id=raw.readInt32BE(4);sent.push(id);
      if(id===1){event(50,{});return;}
      const length=raw.readUInt32BE(8);sessionId=raw.subarray(12,12+length).toString();
      if(id===100)event(150,{dialog_id:'offline-dialog'});
      if(id===400){const n=++audioTurns,question_id=`q${n}`,reply_id=`r${n}`;event(450,{question_id});event(451,{results:[{text:n===1?'I very like podcasts.':`It is answer ${n}.`,is_interim:false}]});event(459,{});event(550,{question_id,reply_id,content:'What do you enjoy?'});event(350,{question_id,reply_id,text:'What do you enjoy?'});event(352,Buffer.alloc(4800));event(359,{question_id,reply_id});}
      if(id===501){event(553,{question_id:'review-q'});event(550,{question_id:'review-q',reply_id:'review-r',content:'Try really like.'});event(350,{question_id:'review-q',reply_id:'review-r',text:'Try really like.'});event(352,Buffer.alloc(4800));event(359,{question_id:'review-q',reply_id:'review-r'});}
    };
    queueMicrotask(()=>upstream.emit('open'));return upstream;
  },fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({assessment:'suggestions',summary:'修饰 like 可用 really。',suggestions:[{original:'very like',suggestion:'really like',reason:'really 可修饰动词 like。',kind:'correction'}]})}}]})};}});
  const address=await local.listen();t.after(()=>local.close());const origin=`http://127.0.0.1:${address.port}`;
  class Socket extends WebSocket{constructor(url){super(url,{origin});}}
  const waiting=[];
  function waitFor(predicate){const existing=events.find(predicate);if(existing)return Promise.resolve(existing);return new Promise(resolve=>waiting.push({predicate,resolve}));}
  const connection=createCoachConnection({WebSocketImpl:Socket,url:origin.replace('http:','ws:')+'/connect',onEvent:event=>{events.push(event);for(const item of [...waiting])if(item.predicate(event)){waiting.splice(waiting.indexOf(item),1);item.resolve(event);}}});
  t.after(()=>{clearTimeout(deadline);connection.disconnect();});
  const timeout=new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('offline local flow timed out')),3000);});
  connection.connect({...credentials,text:{workspace:'ws-offline',apiKey:'OFFLINE_TEXT'}});
  const first=await Promise.race([waitFor(event=>event.type==='ready'||event.type==='error'),timeout]);
  assert.equal(first.type,'ready');assert.equal(upstreamCalls.length,1);
  const selectedHeaders=upstreamCalls[0].options.headers;
  if(credentials.authType==='api-key'){
    assert.equal(selectedHeaders['x-api-key'],'OFFLINE_API_KEY');
    assert.equal(Object.hasOwn(selectedHeaders,'X-Api-App-ID'),false);assert.equal(Object.hasOwn(selectedHeaders,'X-Api-Access-Key'),false);
  }else{
    assert.equal(selectedHeaders['X-Api-App-ID'],'offline');assert.equal(selectedHeaders['X-Api-Access-Key'],'OFFLINE_TOKEN');
    assert.equal(Object.hasOwn(selectedHeaders,'x-api-key'),false);
  }
  assert.equal(connection.startTurn('turn-1',{responseId:null,sampleRate:24000,receivedSamples:0,playedSamples:0,audioEndMs:0}),true);
  connection.push(new Int16Array(320));connection.finishTurn();
  await Promise.race([waitFor(event=>event.type==='reply.done'&&event.replyId==='r1'),timeout]);
  assert.equal(events.find(event=>event.type==='user.transcript').text,'I very like podcasts.');
  // The local playback snapshot confirms each 100ms reply was fully heard.
  // Following ordinary turns must cross the actual local socket without 513/515.
  for(let n=2;n<=6;n++){
    assert.equal(connection.startTurn(`turn-${n}`,{responseId:`r${n-1}`,audioEndMs:100}),true);
    connection.push(new Int16Array(320));connection.finishTurn();
    await Promise.race([waitFor(event=>event.type==='reply.done'&&event.replyId===`r${n}`),timeout]);
  }
  assert.equal(events.filter(event=>event.type==='user.transcript').length,6);
  assert.equal(sent.filter(id=>id===400).length,6);assert.equal(sent.some(id=>[513,515].includes(id)),false);
  assert.equal(connection.requestReview(),true);
  await Promise.race([waitFor(event=>event.type==='reply.done'&&event.replyId==='review-r'),timeout]);
  const review=events.find(event=>event.type==='review.result');assert.equal(review.result.suggestions[0].evidence.turnId,'turn-1');assert.equal(requests.length,1);
  assert.equal(sent.filter(id=>id===501).length,1);assert.equal(sent.includes(201),false);
  connection.end();await Promise.race([waitFor(event=>event.type==='ended'),timeout]);
  assert.equal(requests.length,1);assert.deepEqual(events.filter(event=>event.type==='review.result').at(-1).result,review.result);
  for(const secret of ['OFFLINE_API_KEY','OFFLINE_TOKEN','OFFLINE_TEXT'])assert.equal(JSON.stringify(events).includes(secret),false);
});
