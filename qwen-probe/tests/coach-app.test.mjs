import test from 'node:test';
import assert from 'node:assert/strict';
import {initCoachApp} from '../public/coach-app.mjs';
import {createCapture} from '../public/audio.mjs';
import {createCoachConnection} from '../public/coach-connection.mjs';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/coach.html',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({connect=false,realConnection=false,socketThrows=false,unlockDeferred=false,playbackFails=false}={}){
  const elements=new Map();
  let document;
  class Element{
    constructor(tag='div'){
      this.tagName=tag.toUpperCase();this.value='';this._text='';this.disabled=false;this.hidden=false;this.open=false;this.handlers={};this.children=[];this.parentElement=null;this.attributes=new Map();this.scrollTop=0;this.scrollHeight=1200;this.clientHeight=300;this.tabIndex=0;this.scrollCalls=[];
      const classes=new Set();
      this.classList={toggle(name,force){const active=force===undefined?!classes.has(name):force;if(active)classes.add(name);else classes.delete(name);return active;},contains:name=>classes.has(name)};
    }
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this._text=String(value);this.replaceChildren();}
    setAttribute(name,value){this.attributes.set(name,String(value));if(name==='id'){this.id=String(value);elements.set(this.id,this);}if(name==='class')this.className=value;if(name==='tabindex')this.tabIndex=Number(value);}
    getAttribute(name){return this.attributes.get(name)??null;}
    addEventListener(name,handler){this.handlers[name]=handler;}
    append(...children){for(const child of children){if(child.parentElement)child.parentElement.children.splice(child.parentElement.children.indexOf(child),1);child.parentElement=this;this.children.push(child);}}
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children);}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    focus(){document.activeElement=this;}
    click(){if(this.disabled)return;this.focus();return this.handlers.click?.({currentTarget:this});}
    change(){return this.handlers.change?.({currentTarget:this});}
    fire(name,event={}){return this.handlers[name]?.({currentTarget:this,preventDefault(){this.defaultPrevented=true;},...event});}
    scrollTo({top}){this.scrollTop=top;this.scrollCalls.push(top);}
    getBoundingClientRect(){return {top:this.rectTop??0,bottom:(this.rectTop??0)+100};}
    pause(){this.paused=true;}
  }
  document={getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),activeElement:null};
  const root=new Element(),stack=[root],voidTags=new Set(['meta','link','input','br']);
  for(const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)/g)){
    if(match[3]){stack.at(-1)._text+=match[3];continue;}
    const tag=match[1];if(match[0].startsWith('</')){stack.pop();continue;}
    const element=new Element(tag);
    for(const attribute of match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)){
      const [,name,value='']=attribute;element.setAttribute(name,value);
      if(['hidden','disabled','open'].includes(name))element[name]=true;
      if(name==='value')element.value=value;
    }
    stack.at(-1).append(element);if(!voidTags.has(tag))stack.push(element);
  }
  for(const element of elements.values())if(element.tagName==='SELECT'){
    const options=element.children.filter(child=>child.tagName==='OPTION');
    element.value=(options.find(option=>option.attributes.has('selected'))||options[0])?.value||'';
  }
  const field=id=>{const element=elements.get(id);assert.ok(element,`Missing page field: ${id}`);return element;};
  const permissionRejects=[],unlocks=[],requests=[],tracks=[],contexts=[],connects=[],secretsAtConnect=[],sockets=[],turnStarts=[],audioFrames=[];
  const node=()=>({connect(){},disconnect(){}});
  class Context{
    constructor(){this.state='running';this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};this.destination={};contexts.push(this);}
    async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return node();}createGain(){return {...node(),gain:{value:1}};}
  }
  class Worklet{constructor(){this.port={onmessage:null,close(){}};}connect(){}disconnect(){}}
  let options,captureInput,playbackInput,playbackPlaying=false,stopPlayback=0,turnFinishes=0;
  const calls=[];
  const connection={ready:false,canStartTurn:false,canReview:false,connect(config){calls.push('connect');connects.push(config);secretsAtConnect.push(['voice-key','access-token','text-key'].map(id=>elements.get(id)?.value));this.ready=true;this.canStartTurn=true;this.canReview=true;options.onEvent({type:'ready'});},disconnect(){calls.push('disconnect');this.ready=false;},end(){calls.push('end');this.ready=false;},finishTurn(){calls.push('finishTurn');turnFinishes++;},startTurn(id){calls.push('startTurn');turnStarts.push(id);return true;},push(pcm){calls.push('push');audioFrames.push(pcm);return true;},requestReview(){calls.push('requestReview');return true;},resumeChat(){calls.push('resumeChat');return true;}};
  class Socket{
    constructor(){if(socketThrows)throw new Error('OFFLINE_ONLY');this.readyState=0;this.bufferedAmount=0;this.sent=[];sockets.push(this);}
    open(){this.readyState=1;this.onopen?.();}send(raw){this.sent.push(JSON.parse(raw));}event(value){this.onmessage?.({data:JSON.stringify(value)});}close(){this.readyState=3;this.onclose?.();}
  }
  let activeConnection=connection;
  const windowHandlers=new Map(),window={addEventListener:(name,handler)=>windowHandlers.set(name,handler)};
  const app=initCoachApp({document,window,connectionFactory(input){options=input;if(realConnection)activeConnection=createCoachConnection({...input,WebSocketImpl:Socket,url:'ws://127.0.0.1:1/offline',setTimer:()=>1,clearTimer(){}});return activeConnection;},
    playbackFactory:input=>{playbackInput=input;return {get playing(){return playbackPlaying;},unlock:()=>{let resolve;const promise=new Promise(done=>resolve=done);unlocks.push(resolve);if(!unlockDeferred)resolve(true);return promise;},stop(){stopPlayback++;playbackPlaying=false;playbackInput.onStateChange(false);return {responseId:null,audioEndMs:0};},activate(){},enqueue(){if(playbackFails)return false;playbackPlaying=true;playbackInput.onStateChange(true);return true;},dispose:async()=>{}};},
    captureFactory:input=>{captureInput=input;return createCapture({...input,mediaDevices:{getUserMedia:()=>new Promise((resolve,reject)=>{requests.push(resolve);permissionRejects.push(reject);})},AudioContext:Context,AudioWorkletNode:Worklet,setTimeout:()=>1,clearTimeout(){}});},
  });
  const resolve=index=>{const track={stopped:false,stop(){this.stopped=true;}};tracks[index]=track;requests[index]({getTracks:()=>[track]});};
  if(connect){
    if(elements.has('auth-type')){field('auth-type').value='legacy';field('auth-type').change();}
    field('app-id').value='offline';field('access-token').value='NOT_A_KEY';field('workspace').value='offline-workspace';field('text-key').value='FAKE_TEXT_KEY';field('start').click();field('pause').click();
  }
  return {app,elements,field,document,calls,connects,secretsAtConnect,requests,tracks,contexts,resolve,permissionRejects,unlocks,drain:()=>{playbackPlaying=false;playbackInput.onStateChange(false);},sockets,turnStarts,audioFrames,turnFinishes:()=>turnFinishes,pcm:pcm=>captureInput.onPcm(pcm),connection:activeConnection,hide:()=>windowHandlers.get('pagehide')?.(),event:event=>options.onEvent(event),stopPlayback:()=>stopPlayback};
}
test('a cancelled permission attempt cannot stop a newer microphone attempt',async()=>{
  const f=fixture({connect:true});assert.equal(f.requests.length,0);
  const first=f.elements.get('start').click();await flush();f.elements.get('pause').click();
  const second=f.elements.get('start').click();await flush();assert.equal(f.requests.length,2);
  f.resolve(0);await first;f.resolve(1);await second;
  assert.equal(f.tracks[0].stopped,true);assert.equal(f.tracks[1].stopped,false);
  assert.equal(f.contexts[1].state,'running');assert.match(f.elements.get('status').textContent,/正在收音/);
  f.app.end();await flush();assert.equal(f.tracks[1].stopped,true);
});
test('hangup cancels a pending permission and retains late text without restarting capture',async()=>{
  const f=fixture({connect:true});const starting=f.elements.get('start').click();await flush();f.app.end();
  assert.ok(f.stopPlayback()>0);f.resolve(0);await starting;
  assert.equal(f.tracks[0].stopped,true);assert.equal(f.elements.get('start').disabled,true);
  const requests=f.requests.length;
  f.event({type:'review.result',result:{assessment:'no_clear_issue',summary:'已有原话无需明显修改。',suggestions:[]}});
  assert.equal(f.requests.length,requests);assert.match(f.elements.get('report-status').textContent,/无需明显修改/);
});

test('the page default connects only the voice API Key and clears secrets on readiness',()=>{
  const f=fixture();assert.equal(f.field('auth-type').value,'api-key');
  f.field('voice-key').value='  FAKE_VOICE_KEY  ';f.field('app-id').value='hidden-app';f.field('access-token').value='HIDDEN_FAKE_TOKEN';
  f.field('start').click();
  assert.deepEqual(f.connects,[{authType:'api-key',apiKey:'FAKE_VOICE_KEY'}]);
  assert.deepEqual(f.secretsAtConnect,[['  FAKE_VOICE_KEY  ','HIDDEN_FAKE_TOKEN','']]);assert.equal(f.requests.length,0);
  assert.deepEqual(['voice-key','access-token','text-key'].map(id=>f.field(id).value),['','','']);
  assert.equal(f.field('start').disabled,true);
});
test('switching authentication clears both voice secrets and keeps the independent text key',()=>{
  const f=fixture();
  assert.equal(f.field('api-key-fields').hidden,false);assert.equal(f.field('legacy-fields').hidden,true);
  for(const mode of ['legacy','api-key']){
    f.field('voice-key').value='FAKE_VOICE_KEY';f.field('access-token').value='FAKE_LEGACY_TOKEN';f.field('text-key').value='FAKE_TEXT_KEY';f.field('app-id').value='offline-app';
    f.field('auth-type').value=mode;f.field('auth-type').change();
    assert.equal(f.field('voice-key').value,'');assert.equal(f.field('access-token').value,'');
    assert.equal(f.field('text-key').value,'FAKE_TEXT_KEY');assert.equal(f.field('app-id').value,'offline-app');
    assert.equal(f.field('api-key-fields').hidden,mode!=='api-key');assert.equal(f.field('legacy-fields').hidden,mode!=='legacy');
  }
  assert.equal(f.connects.length,0);assert.equal(f.requests.length,0);
});
test('explicit legacy authentication sends only its selected credentials and a separate text config',()=>{
  const f=fixture();f.field('auth-type').value='legacy';f.field('auth-type').change();
  f.field('app-id').value=' offline-app ';f.field('access-token').value=' FAKE_LEGACY_TOKEN ';f.field('voice-key').value='HIDDEN_FAKE_VOICE_KEY';
  f.field('workspace').value=' offline-workspace ';f.field('text-key').value=' FAKE_TEXT_KEY ';f.field('start').click();
  assert.deepEqual(f.connects,[{authType:'legacy',appId:'offline-app',accessToken:'FAKE_LEGACY_TOKEN',text:{workspace:'offline-workspace',apiKey:'FAKE_TEXT_KEY'}}]);
  assert.deepEqual(f.secretsAtConnect,[['HIDDEN_FAKE_VOICE_KEY',' FAKE_LEGACY_TOKEN ',' FAKE_TEXT_KEY ']]);assert.equal(f.requests.length,0);
  assert.deepEqual(['voice-key','access-token','text-key'].map(id=>f.field(id).value),['','','']);
});
test('API Key mode keeps its voice and text keys in separate config fields',()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';
  f.field('start').click();
  assert.deepEqual(f.connects,[{authType:'api-key',apiKey:'FAKE_VOICE_KEY',text:{workspace:'offline-workspace',apiKey:'FAKE_TEXT_KEY'}}]);
  assert.deepEqual(f.secretsAtConnect,[['FAKE_VOICE_KEY','','FAKE_TEXT_KEY']]);assert.equal(f.requests.length,0);
  assert.deepEqual(['voice-key','access-token','text-key'].map(id=>f.field(id).value),['','','']);
});
for(const scenario of [
  {name:'unknown mode',mode:'unknown',voice:'FAKE_VOICE_KEY',app:'offline-app',token:'FAKE_LEGACY_TOKEN',workspace:'offline-workspace',text:'FAKE_TEXT_KEY'},
  {name:'missing voice API Key does not fall back to legacy',mode:'api-key',voice:'  ',app:'offline-app',token:'FAKE_LEGACY_TOKEN',workspace:'offline-workspace',text:'FAKE_TEXT_KEY'},
  {name:'missing legacy App ID does not fall back to API Key',mode:'legacy',voice:'FAKE_VOICE_KEY',app:'  ',token:'FAKE_LEGACY_TOKEN',workspace:'offline-workspace',text:'FAKE_TEXT_KEY'},
  {name:'missing legacy Access Token',mode:'legacy',voice:'FAKE_VOICE_KEY',app:'offline-app',token:'  ',workspace:'offline-workspace',text:'FAKE_TEXT_KEY'},
  {name:'text workspace without text key',mode:'api-key',voice:'FAKE_VOICE_KEY',app:'offline-app',token:'HIDDEN_FAKE_TOKEN',workspace:'offline-workspace',text:''},
  {name:'text key without text workspace',mode:'api-key',voice:'FAKE_VOICE_KEY',app:'offline-app',token:'HIDDEN_FAKE_TOKEN',workspace:'',text:'FAKE_TEXT_KEY'},
])test(`invalid form: ${scenario.name} neither connects nor clears filled credentials`,()=>{
  const f=fixture();f.field('auth-type').value=scenario.mode;
  for(const [id,value] of [['voice-key',scenario.voice],['app-id',scenario.app],['access-token',scenario.token],['workspace',scenario.workspace],['text-key',scenario.text]])f.field(id).value=value;
  const before=['voice-key','access-token','text-key'].map(id=>f.field(id).value);
  f.field('start').click();
  assert.equal(f.connects.length,0);assert.equal(f.requests.length,0);assert.equal(f.field('start').disabled,false);
  assert.deepEqual(['voice-key','access-token','text-key'].map(id=>f.field(id).value),before);
  assert.match(f.field('status').textContent,/请|不支持/);
  assert.equal(f.field('connection-status').textContent,f.field('status').textContent);
});

test('connection status beside Begin follows asynchronous readiness and starts the microphone only after ready',async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();
  assert.match(f.field('status').textContent,/正在连接/);assert.equal(f.field('connection-status').textContent,f.field('status').textContent);
  assert.equal(f.field('start').textContent,'正在连接…');assert.equal(f.field('start').disabled,true);
  f.sockets[0].open();assert.equal(f.field('start').disabled,true);
  queueMicrotask(()=>f.sockets[0].event({type:'ready'}));await flush();
  assert.match(f.field('status').textContent,/麦克风/);assert.equal(f.field('connection-status').textContent,f.field('status').textContent);
  assert.equal(f.field('start').textContent,'正在开启麦克风…');assert.equal(f.field('start').disabled,true);assert.equal(f.requests.length,1);f.app.end();
});
test('fatal connection diagnostics survive ended and close until an explicit retry',async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();f.sockets[0].open();
  f.sockets[0].event({type:'error',fatal:true,code:'UPSTREAM_TIMEOUT',message:'语音服务响应超时，请手动重连。'});
  const diagnostic=f.field('status').textContent;
  assert.match(diagnostic,/语音服务响应超时/);assert.match(diagnostic,/UPSTREAM_TIMEOUT/);
  f.sockets[0].event({type:'ended'});f.sockets[0].close();
  assert.equal(f.field('status').textContent,diagnostic);assert.equal(f.field('connection-status').textContent,diagnostic);
  assert.equal(f.field('start').textContent,'开始练习');assert.equal(f.field('start').disabled,false);
  assert.equal(f.sockets.length,1);
  f.field('voice-key').value='FAKE_RETRY_KEY';f.field('start').click();
  assert.match(f.field('status').textContent,/正在连接/);assert.doesNotMatch(f.field('status').textContent,/UPSTREAM_TIMEOUT/);assert.equal(f.sockets.length,2);
  f.sockets[1].open();queueMicrotask(()=>f.sockets[1].event({type:'ready'}));await flush();
  assert.equal(f.field('start').textContent,'正在开启麦克风…');assert.equal(f.requests.length,1);f.app.end();
});
test('synchronous WebSocket construction failure is not replaced by a connecting status',()=>{
  const f=fixture({realConnection:true,socketThrows:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();
  assert.match(f.field('status').textContent,/无法打开本地连接/);assert.match(f.field('status').textContent,/CONNECTION_LOST/);
  assert.equal(f.field('connection-status').textContent,f.field('status').textContent);
  assert.equal(f.field('start').textContent,'开始练习');assert.equal(f.field('start').disabled,false);assert.equal(f.requests.length,0);
});
test('only bounded diagnostic codes are appended to the fixed failure message',()=>{
  for(const code of ['bad-code','UPSTREAM_ERROR\n','UPSTREAM_ERROR\nUNTRUSTED','A'.repeat(65),{unexpected:'value'}]){
    const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();f.sockets[0].open();
    f.sockets[0].event({type:'error',fatal:true,code,message:'语音服务连接失败（HTTP 401），请检查配置。'});f.sockets[0].close();
    assert.equal(f.field('status').textContent,'语音服务连接失败（HTTP 401），请检查配置。');
    assert.equal(f.field('connection-status').textContent,f.field('status').textContent);
  }
});

test('pending and failed connections retain password fields for manual retry, then readiness clears them',async()=>{
  const f=fixture({realConnection:true}),secretIds=['voice-key','access-token','text-key'],fieldIds=['auth-type','voice-key','app-id','access-token','workspace','text-key'];
  f.field('voice-key').value='FAKE_VOICE_KEY';f.field('access-token').value='HIDDEN_FAKE_TOKEN';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';
  const entered=secretIds.map(id=>f.field(id).value);
  f.field('start').click();
  assert.deepEqual(secretIds.map(id=>f.field(id).value),entered);
  assert.ok(fieldIds.every(id=>f.field(id).disabled));assert.equal(f.field('start').disabled,true);
  f.sockets[0].open();f.sockets[0].event({type:'error',fatal:true,code:'UPSTREAM_ERROR',message:'语音服务连接失败，请检查配置。'});f.sockets[0].close();
  assert.deepEqual(secretIds.map(id=>f.field(id).value),entered);
  assert.ok(fieldIds.every(id=>!f.field(id).disabled));assert.equal(f.sockets.length,1);
  f.field('start').click();f.sockets[1].open();
  assert.deepEqual(f.sockets[1].sent[0],f.sockets[0].sent[0]);
  assert.deepEqual(secretIds.map(id=>f.field(id).value),entered);
  queueMicrotask(()=>f.sockets[1].event({type:'ready'}));await flush();
  assert.deepEqual(secretIds.map(id=>f.field(id).value),['','','']);
  assert.ok(fieldIds.every(id=>f.field(id).disabled));assert.equal(f.field('start').disabled,true);assert.equal(f.requests.length,1);f.app.end();
});
test('leaving the page clears all password fields including failed connection inputs',async()=>{
  const f=fixture({realConnection:true}),secretIds=['voice-key','access-token','text-key'];
  f.field('voice-key').value='FAKE_VOICE_KEY';f.field('access-token').value='HIDDEN_FAKE_TOKEN';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';
  f.field('start').click();f.sockets[0].open();f.sockets[0].event({type:'error',fatal:true,code:'UPSTREAM_ERROR',message:'语音服务连接失败，请检查配置。'});
  for(const id of secretIds)f.field(id).value='FAKE_PAGEHIDE_SECRET';
  f.hide();await flush();
  assert.deepEqual(secretIds.map(id=>f.field(id).value),['','','']);assert.equal(f.sockets[0].readyState,3);assert.equal(f.requests.length,0);
});

for(const silenceMs of [1500,3000,5000])test(`actual detector ends a voiced turn after the selected ${silenceMs} ms of quiet`,async()=>{
  const f=fixture({connect:true});
  if(silenceMs===1500)assert.equal(f.field('reply-wait').value,'1500');else f.field('reply-wait').value=String(silenceMs);
  assert.equal(f.field('reply-wait').disabled,false);
  const starting=f.field('start').click();await flush();f.resolve(0);await starting;
  f.pcm(new Int16Array(320*300));assert.equal(f.turnStarts.length,0);assert.equal(f.audioFrames.length,0);
  f.pcm(new Int16Array(320*5).fill(2000));assert.equal(f.turnStarts.length,1);
  f.pcm(new Int16Array(320*(silenceMs/20-1)));assert.equal(f.turnFinishes(),0);
  f.pcm(new Int16Array(320));assert.equal(f.turnFinishes(),1);assert.match(f.field('call-state').textContent,/等 AI 接话/);
  const sent=f.audioFrames.length;f.pcm(new Int16Array(320*300));assert.equal(f.turnStarts.length,1);assert.equal(f.audioFrames.length,sent);
  f.app.end();await flush();assert.equal(f.tracks[0].stopped,true);
});
test('pausing allows a new wait selection and restarting resets the previous detector turn',async()=>{
  const f=fixture({connect:true});const first=f.field('start').click();await flush();f.resolve(0);await first;
  f.pcm(new Int16Array(320*5).fill(2000));f.pcm(new Int16Array(320*74));assert.equal(f.turnFinishes(),0);
  f.field('pause').click();await flush();assert.equal(f.turnFinishes(),1);assert.equal(f.field('reply-wait').disabled,false);
  f.field('reply-wait').value='3000';const second=f.field('start').click();await flush();f.resolve(1);await second;
  f.pcm(new Int16Array(320*100));assert.equal(f.turnStarts.length,1);assert.equal(f.turnFinishes(),1);
  f.pcm(new Int16Array(320*5).fill(2000));f.pcm(new Int16Array(320*149));assert.equal(f.turnStarts.length,2);assert.equal(f.turnFinishes(),1);
  f.pcm(new Int16Array(320));assert.equal(f.turnFinishes(),2);f.app.end();await flush();
});
for(const eventType of ['error','connection.closed'])test(`${eventType} updates the listening display and stops capture`,async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();f.sockets[0].open();f.sockets[0].event({type:'ready'});
  await flush();f.resolve(0);await flush();f.pcm(new Int16Array(320*5).fill(2000));
  assert.equal(f.field('call-state').textContent,'我在听');
  if(eventType==='error')f.sockets[0].event({type:'error',fatal:true,code:'AUDIO_QUEUE_LIMIT',message:'等待音频已达上限，通话已停止。'});else f.sockets[0].close();
  await flush();
  assert.equal(f.field('call-state').textContent,'连接已中断');assert.match(f.field('call-detail').textContent,/收音和播放已停止/);assert.equal(f.tracks[0].stopped,true);
  assert.equal(f.field('start').disabled,true);assert.equal(f.requests.length,1);
  if(eventType==='error'){const diagnostic=f.field('status').textContent;assert.match(diagnostic,/AUDIO_QUEUE_LIMIT/);f.sockets[0].event({type:'ended'});f.sockets[0].close();assert.equal(f.field('status').textContent,diagnostic);assert.equal(f.field('call-state').textContent,'连接已中断');}
});

test('reply wait is locked during microphone startup and capture but editable while connected and paused',async()=>{
  const f=fixture({connect:true});assert.equal(f.field('reply-wait').disabled,false);
  const starting=f.field('start').click();await flush();assert.equal(f.field('reply-wait').disabled,true);f.resolve(0);await starting;
  assert.equal(f.field('reply-wait').disabled,true);f.field('pause').click();await flush();
  assert.equal(f.connection.ready,true);assert.equal(f.field('reply-wait').disabled,false);f.app.end();await flush();
});

const descendants=node=>[node,...node.children.flatMap(descendants)];
const transcript=(f,id,text='I enjoyed the conversation.')=>f.event({type:'user.transcript',turnId:id,phase:'chat',text});
const reviewResult=(turnId='turn-1')=>({type:'review.result',result:{summary:'试着用更自然的表达。',suggestions:[{original:'I very like it.',suggestion:'I really like it.',reason:'really 修饰 like 更自然。',evidence:{turnId}}]}});

test('view tabs change presentation while retaining transcript and audio nodes without service or device calls',async()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');f.event({type:'input.sent',turnId:'turn-1',pcm:new Int16Array(320)});f.app.end();await flush();
  const list=f.field('transcripts'),row=list.children[0],audio=descendants(row).find(node=>node.tagName==='AUDIO');assert.ok(audio);
  const before={calls:[...f.calls],requests:f.requests.length,stops:f.stopPlayback()};
  for(const id of ['call-tab','review-tab','call-tab','review-tab'])f.field(id).click();
  assert.equal(list.children[0],row);assert.equal(descendants(row).find(node=>node.tagName==='AUDIO'),audio);
  assert.deepEqual({calls:f.calls,requests:f.requests.length,stops:f.stopPlayback()},before);
  assert.equal(f.field('report').hidden,false);assert.equal(f.field('call-overview').hidden,true);
  assert.equal(f.field('practice-workspace').getAttribute('aria-labelledby'),'review-tab');
  assert.equal(f.field('review-tab').getAttribute('aria-selected'),'true');assert.equal(f.field('call-tab').getAttribute('aria-selected'),'false');
});
test('tab keyboard navigation maintains a single keyboard stop and moves focus to the selected tab',()=>{
  const f=fixture();f.field('call-tab').focus();
  for(const [from,key,to] of [['call-tab','ArrowRight','review-tab'],['review-tab','ArrowLeft','call-tab'],['call-tab','End','review-tab'],['review-tab','Home','call-tab']]){
    f.field(from).fire('keydown',{key});assert.equal(f.document.activeElement,f.field(to));assert.equal(f.field(to).tabIndex,0);
    assert.equal(f.field(to==='call-tab'?'review-tab':'call-tab').tabIndex,-1);assert.equal(f.field(to).getAttribute('aria-selected'),'true');
  }
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
});
test('review presentation preserves live microphone state and shared pause and hangup controls',async()=>{
  const f=fixture({connect:true});const starting=f.field('start').click();await flush();f.resolve(0);await starting;
  const before={calls:[...f.calls],requests:f.requests.length,stops:f.stopPlayback()};f.field('review-tab').click();
  assert.deepEqual({calls:f.calls,requests:f.requests.length,stops:f.stopPlayback()},before);
  assert.match(f.field('mic-status').textContent,/正在收音/);assert.equal(f.field('pause').disabled,false);assert.equal(f.field('end').disabled,false);
  assert.equal(f.field('practice-workspace').contains(f.field('pause')),false);assert.equal(f.field('practice-workspace').contains(f.field('end')),false);
  f.field('pause').click();await flush();assert.match(f.field('mic-status').textContent,/已暂停/);assert.equal(f.tracks[0].stopped,true);f.app.end();await flush();
});
test('background review results do not change the call view but ending opens retained review',async()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');f.event({type:'review.pending'});assert.equal(f.field('report').hidden,true);
  f.event(reviewResult());assert.equal(f.field('call-tab').getAttribute('aria-selected'),'true');
  f.app.end();await flush();assert.equal(f.field('report').hidden,false);assert.equal(f.field('review-tab').getAttribute('aria-selected'),'true');
  assert.match(f.field('report-status').textContent,/自然的表达/);
});
test('ending while review is pending opens the review status without duplicating the recording list',async()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');assert.equal(f.field('report').hidden,true);f.app.end();f.event({type:'review.pending'});await flush();
  assert.equal(f.field('report').hidden,false);assert.match(f.field('report-status').textContent,/正在/);assert.equal(f.field('transcripts').children.length,1);
});
test('new transcript text follows the bottom while leaving keyboard focus alone',()=>{
  const f=fixture(),scroll=f.field('transcripts-scroll');scroll.scrollTop=900;scroll.fire('scroll');f.field('call-tab').focus();
  transcript(f,'turn-1');assert.equal(scroll.scrollTop,scroll.scrollHeight);assert.equal(f.document.activeElement,f.field('call-tab'));assert.equal(f.field('new-content').hidden,true);
});
test('new records and late transcription do not interrupt reading and the new-content button returns to the bottom',()=>{
  const f=fixture(),scroll=f.field('transcripts-scroll');transcript(f,'turn-1');scroll.scrollTop=120;scroll.fire('scroll');f.field('call-tab').focus();
  transcript(f,'turn-2');transcript(f,'turn-1','A longer, late final transcript.');
  assert.equal(scroll.scrollTop,120);assert.equal(f.document.activeElement,f.field('call-tab'));assert.equal(f.field('new-content').hidden,false);
  f.field('new-content').click();assert.equal(scroll.scrollTop,scroll.scrollHeight);assert.equal(f.field('new-content').hidden,true);
  scroll.scrollTop=900;scroll.fire('scroll');transcript(f,'turn-3');assert.equal(scroll.scrollTop,scroll.scrollHeight);
});
test('long original text remains complete in a collapsed disclosure',()=>{
  const f=fixture(),text='I would like to explain the whole story in my own words. '.repeat(20);transcript(f,'turn-1',text);
  const row=f.field('transcripts').children[0],content=descendants(row).find(node=>node.tagName==='DETAILS');
  assert.ok(content);assert.equal(content.open,false);assert.ok(descendants(content).some(node=>node.tagName==='P'&&node.textContent===text));
  content.open=true;assert.ok(content.textContent.includes(text));
});
test('view-original expands and highlights the actual evidence row and scrolls only the record container',()=>{
  const f=fixture(),text='A complete long original sentence. '.repeat(30);transcript(f,'turn-1',text);transcript(f,'turn-2','A different sentence.');f.event(reviewResult('turn-1'));f.field('review-tab').click();
  const row=f.field('transcripts').children[0],scroll=f.field('transcripts-scroll'),content=descendants(row).find(node=>node.tagName==='DETAILS');
  row.rectTop=240;scroll.rectTop=100;scroll.scrollTop=80;scroll.fire('scroll');
  const source=descendants(f.field('suggestions')).find(node=>node.tagName==='BUTTON'&&node.textContent==='查看原句');assert.ok(source);source.click();
  assert.equal(content.open,true);assert.equal(row.classList.contains('source-highlight'),true);assert.ok(scroll.scrollTop>80);assert.equal(f.document.activeElement,source);
  assert.equal(f.field('practice-workspace').scrollCalls.length,0);assert.equal(f.field('report').scrollCalls.length,0);
  assert.equal(source.getAttribute('aria-controls'),row.id);assert.ok(row.textContent.includes(text));
  const top=scroll.scrollTop;transcript(f,'turn-3');assert.equal(scroll.scrollTop,top);
});
test('Chinese review reasons start collapsed and original plus English suggestion remain immediately available',()=>{
  const f=fixture();transcript(f,'turn-1');f.event(reviewResult());
  const card=f.field('suggestions').children[0],reason=descendants(card).find(node=>node.tagName==='DETAILS');assert.ok(reason);assert.equal(reason.open,false);
  assert.ok(descendants(card).some(node=>node.tagName==='BLOCKQUOTE'&&node.textContent==='I very like it.'));
  assert.ok(card.children.some(node=>node.tagName==='P'&&node.textContent==='I really like it.'));assert.match(reason.textContent,/really 修饰/);
});
test('successful readiness collapses connection settings while a failed attempt leaves them available',()=>{
  const f=fixture({realConnection:true});assert.equal(f.field('connection-settings').open,true);f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();
  f.sockets[0].open();f.sockets[0].event({type:'error',fatal:true,code:'UPSTREAM_ERROR',message:'连接失败。'});assert.equal(f.field('connection-settings').open,true);
  f.sockets[0].close();f.field('start').click();f.sockets[1].open();f.sockets[1].event({type:'ready'});assert.equal(f.field('connection-settings').open,false);
  f.field('connection-settings').open=true;assert.equal(f.field('connection-settings').open,true);assert.equal(f.requests.length,0);f.app.end();
});

test('long-original summary follows native disclosure toggles and programmatic evidence expansion without repeating the preview',()=>{
  const f=fixture(),text='I want to tell the complete story in my own words. '.repeat(20);transcript(f,'turn-1',text);
  const row=f.field('transcripts').children[0],content=descendants(row).find(node=>node.tagName==='DETAILS'),summary=content.children.find(node=>node.tagName==='SUMMARY');
  assert.ok(summary.textContent.includes(text.slice(0,140)));assert.match(summary.textContent,/展开原话/);
  content.open=true;content.fire('toggle');assert.equal(summary.textContent,'收起原话');
  content.open=false;content.fire('toggle');assert.ok(summary.textContent.includes(text.slice(0,140)));assert.match(summary.textContent,/展开原话/);
  f.event(reviewResult());f.field('review-tab').click();descendants(f.field('suggestions')).find(node=>node.tagName==='BUTTON'&&node.textContent==='查看原句').click();
  assert.equal(content.open,true);assert.equal(summary.textContent,'收起原话');assert.ok(content.children.some(node=>node.tagName==='P'&&node.textContent===text));
});

test('filling credentials and changing views never connects or unlocks audio',()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';
  for(const id of ['voice-key','workspace','text-key'])f.field(id).fire('input');f.field('review-tab').click();f.field('call-tab').click();
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);assert.equal(f.unlocks.length,0);assert.equal(f.field('start').disabled,false);
});
test('one Begin unlocks playback immediately but waits for upstream ready before permission',async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();f.field('start').click();
  assert.equal(f.unlocks.length,1);assert.equal(f.sockets.length,1);assert.equal(f.requests.length,0);assert.equal(f.field('end').hidden,false);
  f.sockets[0].open();await flush();assert.equal(f.requests.length,0);f.sockets[0].event({type:'ready'});await flush();assert.equal(f.requests.length,1);
  assert.match(f.field('voice-capability').textContent,/已就绪/);assert.equal(f.field('start').hidden,true);assert.equal(f.field('pause').hidden,false);
  f.resolve(0);await flush();assert.equal(f.field('pause').hidden,false);assert.equal(f.field('end').hidden,false);assert.equal(f.field('start').hidden,true);f.app.end();
});
for(const cancel of ['end','pagehide'])test(`${cancel} cancels connection intent and ignores late ready`,async()=>{
  const f=fixture({realConnection:true,unlockDeferred:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();
  if(cancel==='end')f.field('end').click();else f.hide();
  const before=f.field('status').textContent;f.event({type:'ready'});f.unlocks[0](true);await flush();
  assert.equal(f.requests.length,0);assert.equal(f.field('status').textContent,before);assert.equal(f.field('connection-settings').open,true);
  assert.equal(f.field('voice-key').value,cancel==='pagehide'?'':'FAKE_VOICE_KEY');
});
test('permission rejection leaves a clear explicit retry on the accepted connection',async()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();await flush();f.permissionRejects[0](new Error('NotAllowedError'));await flush();
  assert.match(f.field('call-state').textContent,/无法开始收音/);assert.match(f.field('call-detail').textContent,/权限/);assert.equal(f.field('start').hidden,false);assert.equal(f.field('start').disabled,false);
  f.field('start').click();f.field('start').click();await flush();assert.equal(f.connects.length,1);assert.equal(f.requests.length,2);f.resolve(1);await flush();assert.match(f.field('mic-status').textContent,/正在收音/);f.app.end();
});
test('partial optional text configuration reports locally and focuses its missing field without calling services',()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('workspace').value='offline-workspace';f.field('start').click();
  assert.equal(f.connects.length,0);assert.equal(f.unlocks.length,0);assert.equal(f.field('text-error').hidden,false);assert.match(f.field('text-error').textContent,/同时填写/);assert.equal(f.document.activeElement,f.field('text-key'));
  assert.equal(f.field('text-key').getAttribute('aria-invalid'),'true');assert.equal(f.field('voice-key').value,'FAKE_VOICE_KEY');
});
test('voice-only practice explains both unavailable reviews even when connection busy capability allows review',async()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();await flush();f.resolve(0);await flush();transcript(f,'turn-1');
  assert.match(f.field('text-capability').textContent,/本次仅聊天/);assert.match(f.field('report-status').textContent,/未配置.*语音复盘.*文字复盘/);
  assert.equal(f.field('review').hidden,true);assert.equal(f.field('review').disabled,true);f.field('review').fire('click');assert.ok(!f.calls.includes('requestReview'));
  f.app.end();assert.match(f.field('status').textContent,/仅聊天/);assert.doesNotMatch(f.field('call-detail').textContent,/正在整理/);
});
test('configured review remains unverified until a valid result and pending feedback closes everywhere',async()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');assert.match(f.field('text-capability').textContent,/已配置.*尚未验证/);
  f.event({type:'review.pending'});assert.match(f.field('status').textContent,/正在整理/);f.event(reviewResult());
  assert.match(f.field('text-capability').textContent,/已验证/);assert.match(f.field('status').textContent,/复盘已完成/);assert.doesNotMatch(f.field('call-detail').textContent,/正在整理/);
  f.app.end();f.event({type:'ended'});assert.match(f.field('status').textContent,/复盘已完成/);assert.match(f.field('call-detail').textContent,/完成/);
});
test('review failure clears every wait state and preserves a useful error after ended',()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');f.app.end();f.event({type:'review.pending'});f.event({type:'review.error',message:'文字服务不可用，原音保留。'});f.event({type:'ended'});
  assert.match(f.field('report-status').textContent,/文字服务不可用/);assert.match(f.field('status').textContent,/复盘失败/);assert.match(f.field('call-detail').textContent,/文字服务不可用/);assert.doesNotMatch(f.field('status').textContent,/正在整理/);
});
test('reply done keeps responding until scheduled audio actually drains then restores current mic stage',async()=>{
  const f=fixture({connect:true});const starting=f.field('start').click();await flush();f.resolve(0);await starting;
  f.event({type:'reply.start',replyId:'reply-1'});f.event({type:'reply.audio',replyId:'reply-1',audio:'fake'});f.event({type:'reply.done'});
  assert.equal(f.field('call-state').textContent,'AI 正在回应');assert.match(f.field('status').textContent,/AI 正在回应/);
  f.drain();assert.equal(f.field('call-state').textContent,'开口就可以聊');assert.match(f.field('status').textContent,/正在收音/);
  f.event({type:'reply.start',replyId:'reply-2'});f.event({type:'reply.audio',replyId:'reply-2',audio:'fake'});f.field('pause').click();f.event({type:'reply.done'});assert.equal(f.field('call-state').textContent,'AI 正在回应');
  f.drain();assert.equal(f.field('call-state').textContent,'收音已暂停');assert.equal(f.field('start').hidden,false);f.app.end();
});
test('phase controls expose only current actions and explicit voice review or resume changes view',async()=>{
  const f=fixture();assert.equal(f.field('start').hidden,false);for(const id of ['pause','end','review','resume-chat'])assert.equal(f.field(id).hidden,true,id);
  f.field('voice-key').value='FAKE_VOICE_KEY';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';f.field('start').click();await flush();f.resolve(0);await flush();transcript(f,'turn-1');
  f.field('review').click();assert.equal(f.field('report').hidden,false);f.event({type:'phase',phase:'review'});f.event(reviewResult());
  assert.equal(f.field('review').hidden,true);assert.equal(f.field('resume-chat').hidden,false);f.field('resume-chat').click();assert.equal(f.field('call-overview').hidden,false);assert.equal(f.field('resume-chat').hidden,true);
  f.field('pause').click();assert.equal(f.field('pause').hidden,true);assert.equal(f.field('start').hidden,false);f.app.end();for(const id of ['start','pause','end','review','resume-chat'])assert.equal(f.field(id).hidden,true,id);
});
test('the first fatal diagnostic locks global and call states against late review, phase, and ready events',()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');f.event({type:'error',fatal:true,code:'UPSTREAM_ERROR',message:'语音连接失败。'});const diagnostic=f.field('status').textContent;
  for(const event of [{type:'review.pending'},reviewResult(),{type:'review.error',message:'later error'},{type:'phase',phase:'chat'},{type:'ended'},{type:'ready'}])f.event(event);
  assert.equal(f.field('status').textContent,diagnostic);assert.equal(f.field('call-state').textContent,'连接已中断');assert.match(f.field('call-detail').textContent,/收音和播放已停止/);assert.equal(f.requests.length,0);
});


test('a normal socket close after ended preserves completed review instead of inventing a fatal interruption',()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');f.app.end();f.event(reviewResult());f.event({type:'connection.closed'});
  assert.equal(f.field('call-state').textContent,'通话已结束');assert.match(f.field('status').textContent,/复盘已完成/);f.event({type:'review.pending'});assert.match(f.field('status').textContent,/复盘已完成/);
});
test('idle setup hides the empty call workspace and its capabilities remain visible after ready collapses setup',()=>{
  const f=fixture();assert.equal(f.field('view-tabs').hidden,true);assert.equal(f.field('practice-workspace').hidden,true);assert.equal(f.field('call-controls-region').hidden,true);
  f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();assert.equal(f.field('connection-settings').open,false);assert.equal(f.field('view-tabs').hidden,false);assert.equal(f.field('practice-workspace').hidden,false);assert.match(f.field('settings-summary').textContent,/语音已就绪.*本次仅聊天/);assert.equal(f.document.activeElement,f.field('end'));f.app.end();
});

test('voice-only backend review unavailability after ending remains an explained chat-only outcome',async()=>{
  const f=fixture();f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();await flush();f.resolve(0);await flush();transcript(f,'turn-1');f.app.end();
  f.event({type:'ended'});f.event({type:'review.error',message:'未配置文字服务，无法生成表达复盘。'});
  assert.match(f.field('voice-capability').textContent,/本次通话已结束/);assert.doesNotMatch(f.field('voice-capability').textContent,/等待.*验证/);
  assert.match(f.field('status').textContent,/本次仅聊天/);assert.doesNotMatch(f.field('status').textContent,/复盘失败|正在整理/);assert.match(f.field('report-status').textContent,/语音复盘与文字复盘均不可用/);
});
test('secondary review is hidden while pending and after its one retained result is complete',()=>{
  const f=fixture({connect:true});transcript(f,'turn-1');assert.equal(f.field('review').hidden,false);f.field('review').click();assert.equal(f.field('review').hidden,true);
  f.event(reviewResult());assert.equal(f.field('review').hidden,true);
});

test('review distinguishes optional wording and displays approved sources as safe text links',()=>{
  const f=fixture();transcript(f,'turn-1');const event=reviewResult();
  event.result.knowledge={status:'matched',method:'bm25+graph',corpusVersion:'test-v1',retrievedIds:['card-like']};
  Object.assign(event.result.suggestions[0],{kind:'optional',knowledge_ids:['card-like'],knowledgeSources:[{knowledgeId:'card-like',expression:'really like',groundingScope:'editorial_principles_not_official_exact_certification',sources:[{id:'src',title:'<img src=x onerror=bad()>',url:'https://example.org/grammar',publisher:'Teacher',tier:'education'}]}]});
  f.event(event);const nodes=descendants(f.field('suggestions')),link=nodes.find(node=>node.tagName==='A');
  assert.match(f.field('suggestions').textContent,/可选说法/);assert.match(f.field('suggestions').textContent,/表达参考/);assert.match(f.field('suggestions').textContent,/原则.*不.*逐字|不.*逐字.*认证/);
  assert.equal(link.textContent,'<img src=x onerror=bad()>');assert.equal(link.getAttribute('href'),'https://example.org/grammar');assert.equal(link.getAttribute('rel'),'noopener noreferrer');
  assert.equal(nodes.some(node=>node.tagName==='IMG'),false);assert.match(f.field('report-status').textContent,/知识卡/);
});
for(const status of ['no_match','unavailable'])test(`review honestly displays ${status} knowledge fallback and unreferenced model judgement`,()=>{
  const f=fixture();transcript(f,'turn-1');const event=reviewResult();event.result.knowledge={status,retrievedIds:[]};f.event(event);
  assert.match(f.field('report-status').textContent,status==='no_match'?/本库暂无相关卡/:/知识库不可用/);
  assert.match(f.field('suggestions').textContent,/模型判断.*未引用知识卡/);
});
test('reference UI refuses unsafe source URLs and renders source text without HTML',()=>{
  const f=fixture();transcript(f,'turn-1');const event=reviewResult();event.result.suggestions[0].knowledgeSources=[{knowledgeId:'card-like',expression:'really like',groundingScope:'editorial_principles_not_official_exact_certification',sources:[{title:'Unsafe',url:'javascript:alert(1)'},{title:'Local',url:'file:///tmp/secret'},{title:'HTTP',url:'http://example.org'}]}];f.event(event);
  assert.equal(descendants(f.field('suggestions')).some(node=>node.tagName==='A'),false);
});
test('reference details start collapsed and keep source links separate from the visible original and replacement',()=>{
  const f=fixture();transcript(f,'turn-1');const event=reviewResult();event.result.suggestions[0].knowledgeSources=[{knowledgeId:'card',expression:'really like',sources:[{title:'Reference',url:'https://example.org/grammar'}]}];f.event(event);
  const card=f.field('suggestions').children[0],reference=descendants(card).find(node=>node.tagName==='DETAILS'&&node.textContent.includes('表达参考'));
  assert.ok(reference);assert.equal(reference.open,false);assert.ok(descendants(reference).some(node=>node.tagName==='A'));assert.ok(card.children.some(node=>node.tagName==='BLOCKQUOTE'));
});

for(const pending of [false,true])test(`socket close after ended settles ${pending?'pending':'not-yet-announced'} written review`,async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';f.field('start').click();
  f.sockets[0].open();f.sockets[0].event({type:'ready'});await flush();f.resolve(0);await flush();transcript(f,'turn-1');f.app.end();f.sockets[0].event({type:'ended'});
  if(pending)f.sockets[0].event({type:'review.pending'});f.sockets[0].close();
  assert.match(f.field('status').textContent,/复盘失败/);assert.match(f.field('report-status').textContent,/连接.*中断/);assert.doesNotMatch(f.field('status').textContent,/正在整理|等待/);assert.equal(f.field('call-state').textContent,'通话已结束');
});
test('cancelled setup permits changing wait and reflects edited optional capabilities before retry',()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();f.field('end').click();
  assert.equal(f.field('reply-wait').disabled,false);f.field('reply-wait').value='5000';
  f.field('workspace').value='offline-workspace';f.field('text-key').value='FAKE_TEXT_KEY';f.field('text-key').fire('input');
  assert.match(f.field('text-capability').textContent,/已配置.*尚未验证/);assert.equal(f.requests.length,0);assert.equal(f.sockets.length,1);
});
test('explicit Begin and resume transfer focus before their initiating action is hidden',async()=>{
  const f=fixture({realConnection:true});f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();
  assert.equal(f.document.activeElement,f.field('end'));f.sockets[0].open();f.sockets[0].event({type:'ready'});await flush();f.resolve(0);await flush();
  f.field('pause').click();assert.equal(f.document.activeElement,f.field('start'));f.field('start').click();assert.equal(f.document.activeElement,f.field('pause'));
  await flush();f.app.end();f.resolve(1);await flush();
});
for(const configured of [false,true])test(`playback failure remains the stop reason through ${configured?'written review completion':'chat-only ending'}`,()=>{
  const f=fixture({connect:configured,playbackFails:true});
  if(!configured){f.field('voice-key').value='FAKE_VOICE_KEY';f.field('start').click();}
  transcript(f,'turn-1');f.event({type:'reply.start',replyId:'reply-1'});f.event({type:'reply.audio',replyId:'reply-1',audio:'fake'});
  assert.match(f.field('status').textContent,/播放未能跟上回复/);f.event({type:'ended'});
  if(configured){f.event({type:'review.pending'});assert.match(f.field('status').textContent,/播放未能跟上回复/);f.event(reviewResult());}
  else f.event({type:'review.error',message:'未配置文字服务。'});
  f.event({type:'ended'});assert.match(f.field('status').textContent,/播放未能跟上回复/);assert.match(f.field('call-detail').textContent,/播放未能跟上回复/);assert.match(f.field('status').textContent,configured?/复盘已完成/:/本次仅聊天/);
});
