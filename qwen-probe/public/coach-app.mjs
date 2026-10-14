import {createCapture,createPlayback,encodeWav} from './audio.mjs';
import {createTurnDetector} from './turn-detector.mjs';
import {createCoachConnection} from './coach-connection.mjs';

export function initCoachApp({document=globalThis.document,window=globalThis.window,captureFactory=createCapture,playbackFactory=createPlayback,connectionFactory=createCoachConnection,detectorFactory=createTurnDetector}={}){
  const el=id=>document.getElementById(id);
  let connection,ended=false,connecting=false,mic=false,starting=false,phase='chat',reviewPending=false,reviewDone=false,liveTurn=null,turnSequence=0,captureMs=0,captureStarted=0,generation=0,fatalMessage='';
  let voiceReady=false,textConfigured=false,textVerified=false,beginRequested=false,pageGone=false,canRetry=false,unlockPromise=null,startPromise=null;
  let reviewState='idle',reviewError='',permissionError='',notice='',stopReason='',replyGenerating=false,awaitingReply=false;
  const rows=new Map(),urls=new Set();
  let followTail=true,highlightedRow=null;
  function showView(view,focus=false){
    const reviewing=view==='review';
    el('practice-workspace').setAttribute('data-view',view);
    el('practice-workspace').setAttribute('aria-labelledby',reviewing?'review-tab':'call-tab');
    el('call-overview').hidden=reviewing;el('report').hidden=!reviewing;
    for(const id of ['call-tab','review-tab']){
      const selected=id===(reviewing?'review-tab':'call-tab');
      el(id).setAttribute('aria-selected',String(selected));el(id).tabIndex=selected?0:-1;
    }
    if(focus)el(reviewing?'review-tab':'call-tab').focus();
  }
  function updateRecords(update){
    update();
    if(followTail){el('transcripts-scroll').scrollTop=el('transcripts-scroll').scrollHeight;el('new-content').hidden=true;}
    else el('new-content').hidden=false;
  }
  function locateEvidence(id){
    const row=rows.get(id);if(!row)return;
    followTail=false;
    if(highlightedRow)highlightedRow.node.classList.toggle('source-highlight',false);
    row.content.open=true;updateTranscriptSummary(row);row.node.classList.toggle('source-highlight',true);highlightedRow=row;
    const scroll=el('transcripts-scroll');
    scroll.scrollTo({top:Math.max(0,scroll.scrollTop+row.node.getBoundingClientRect().top-scroll.getBoundingClientRect().top-8),behavior:'auto'});
  }
  function message(text){notice=text;renderState();}
  function clearSecrets(){for(const id of ['voice-key','access-token','text-key'])el(id).value='';}
  function renderState(){
    let title,detail,status;
    if(fatalMessage){title='连接已中断';detail='收音和播放已停止，已有记录保留在当前页面。';status=fatalMessage;}
    else if(ended){
      title='通话已结束';
      if(reviewState==='pending'){detail='麦克风和播放已停止，正在整理已有聊天原话。';status='正在整理复盘，请稍等。';}
      else if(reviewState==='complete'){detail='文字复盘已完成，已有记录保留在当前页面。';status='复盘已完成。可以查看建议与原音。';}
      else if(reviewState==='error'){detail=reviewError;status=`复盘失败。${reviewError}`;}
      else if(!textConfigured){detail='本次仅聊天，未配置表达复盘服务。原音与原话保留在当前页面。';status='通话已结束。本次仅聊天，已有记录保留。';}
      else {detail='麦克风和播放已停止。已有记录保留在当前页面。';status='通话已结束，等待已有记录的复盘状态。';}
    }else if(connecting){title='正在连接语音服务';detail='语音服务就绪后会申请麦克风权限；可取消连接。';status='正在连接，尚未打开麦克风。';}
    else if(starting){title='正在等待麦克风权限';detail='请在浏览器中允许麦克风；取消后不会继续开麦。';status='语音服务已就绪，正在开启麦克风。';}
    else if(reviewPending){title='正在整理复盘';detail='正在根据已有聊天原话整理一组表达建议。';status='正在整理复盘，请稍等。';}
    else if(replyGenerating||playback.playing){title=phase==='review'?'一起回顾':'AI 正在回应';detail='可以开口打断；也可以听完后继续。';status=phase==='review'?'正在播放语音复盘。':'AI 正在回应。';}
    else if(permissionError){title='无法开始收音';detail=permissionError;status=permissionError;}
    else if(mic){title=liveTurn?(phase==='review'?'练一练刚才的表达':'我在听'):awaitingReply?'等 AI 接话':'开口就可以聊';detail='允许思考停顿。求助时可以问：How can I say…?';status=awaitingReply?'等 AI 接话。麦克风仍在收音，可继续开口。':'正在收音。开口后会自动上传给你配置的语音服务。';}
    else if(voiceReady){title=captureStarted?'收音已暂停':'准备好再开始';detail='麦克风已停止，仍可听 AI 的回复；点击继续收音再聊。';status='麦克风已停止。点击继续收音再聊。';}
    else {title='准备好再开始';detail='设置完成后点击开始练习；语音服务就绪后申请麦克风权限。';status='先配置语音服务，再选择接话等待，点击开始练习。';}
    if(!fatalMessage&&!ended&&!reviewPending){
      if(reviewState==='complete')status=`复盘已完成。${status}`;
      if(reviewState==='error'){status=`复盘失败。${reviewError} ${status}`;detail=`${reviewError} ${detail}`;}
    }
    if(ended&&stopReason&&!fatalMessage){detail=`${stopReason} ${detail}`;status=`${stopReason} ${status}`;}
    el('call-state').textContent=title;el('call-detail').textContent=detail;
    el('status').textContent=fatalMessage||notice||status;el('connection-status').textContent=el('status').textContent;
  }
  function capabilities(){
    el('voice-capability').textContent=ended&&!fatalMessage&&!canRetry?'语音服务：本次通话已结束。':voiceReady?'语音服务：已就绪，实时聊天可用。':connecting?'语音服务：正在连接验证。':fatalMessage?'语音服务：连接失败。':'语音服务：等待连接验证。';
    const configured=voiceReady||connecting||ended&&!canRetry?textConfigured:Boolean(el('workspace').value.trim()&&el('text-key').value.trim());
    el('text-capability').textContent=textVerified?'表达复盘：已验证，可查看本次结果。':configured?'表达复盘：已配置，尚未验证；以实际复盘结果为准。':'表达复盘：未配置，本次仅聊天；语音复盘与文字复盘均不可用。';
    if(!textConfigured&&reviewState==='idle')el('report-status').textContent='未配置表达复盘服务，本次仅聊天；语音复盘与文字复盘均不可用。原音与原话仍保留。';
  }
  function controls(){
    const retrySetup=!voiceReady&&!pageGone&&(!ended||canRetry);
    const canResume=voiceReady&&!ended&&!mic&&!starting&&!reviewPending;
    const destination=el(retrySetup?'startup-actions':'session-actions');
    if(el('start').parentElement!==destination)destination.append(el('start'));
    el('start').hidden=!retrySetup&&!canResume;
    el('start').disabled=pageGone||connecting||starting||mic||reviewPending||ended&&!canRetry;
    el('start').textContent=connecting?'正在连接…':starting?'正在开启麦克风…':voiceReady?'继续收音':'开始练习';
    for(const id of ['auth-type','voice-key','app-id','access-token','workspace','text-key'])el(id).disabled=connecting||voiceReady||ended&&!canRetry;
    el('reply-wait').disabled=connecting||starting||mic||ended&&!canRetry;
    el('pause').hidden=!mic&&!starting;el('pause').disabled=!mic&&!starting;
    el('end').hidden=ended||!connecting&&!voiceReady&&!starting;el('end').disabled=el('end').hidden;
    el('end').textContent=connecting?'取消连接':'结束通话';
    el('review').hidden=!textConfigured||!voiceReady||ended||phase==='review'||starting||reviewPending||reviewDone;
    el('review').disabled=el('review').hidden||!connection?.canReview||Boolean(liveTurn)||playback.playing||reviewPending||reviewDone||!rows.size;
    el('resume-chat').hidden=!textConfigured||!voiceReady||phase!=='review'||ended||starting;
    el('resume-chat').disabled=el('resume-chat').hidden||!connection?.canReview||playback.playing||Boolean(liveTurn)||reviewPending;
    el('orb').classList.toggle('active',mic||playback.playing);
    el('mic-status').textContent=mic?'正在收音':starting?'正在等待麦克风权限':ended?'收音已结束':captureStarted?'收音已暂停':'麦克风未开启';
    el('settings-summary').textContent=voiceReady?`本次设置 · 语音已就绪 · ${textVerified?'表达复盘已验证':textConfigured?'表达复盘已配置，尚未验证':'本次仅聊天'}`:ended&&!canRetry?'本次设置 · 通话已结束':'准备练习';
    const workspaceVisible=voiceReady||Boolean(rows.size)||ended&&!canRetry;
    el('view-tabs').hidden=!workspaceVisible;el('practice-workspace').hidden=!workspaceVisible;
    el('call-controls-region').hidden=!connecting&&!voiceReady&&!starting&&(!ended||canRetry)&&!fatalMessage;
    capabilities();renderState();
  }
  const playback=playbackFactory({sampleRate:24000,maxQueuedSeconds:30,onStateChange:()=>controls()});
  function rowFor(id){
    if(rows.has(id))return rows.get(id);
    if(rows.size>=40)throw new Error('TURN_LIMIT');
    const node=document.createElement('li'),label=document.createElement('span'),content=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');
    node.setAttribute('id',`record-${id}`);
    label.className='turn-label';label.textContent=phase==='review'?'复盘短练 · 有提示':'聊天原话';text.textContent='正在识别…';
    content.className='turn-content';content.open=true;summary.hidden=true;content.append(summary,text);node.append(label,content);
    updateRecords(()=>{if(!rows.size)el('transcripts').replaceChildren();el('transcripts').append(node);});
    const row={id,node,label,content,summary,text,phase,chunks:[],samples:0,audio:null,complete:false,dropped:0};
    content.addEventListener('toggle',()=>updateTranscriptSummary(row));rows.set(id,row);return row;
  }
  function updateTranscriptSummary(row){
    if(!row.summary.hidden)row.summary.textContent=row.content.open?'收起原话':`${row.text.textContent.slice(0,140)}… 展开原话`;
  }
  function renderTranscript(row,event){
    updateRecords(()=>{
      const long=event.text.length>320;
      row.content.open=!long||row.complete&&row.content.open;row.summary.hidden=!long;
      row.text.textContent=event.text;updateTranscriptSummary(row);row.complete=true;row.phase=event.phase;
      row.label.textContent=`${event.turnId} · ${event.phase==='review'?'复盘短练（有提示）':'聊天原话'}${row.dropped?' · 尾段未上传':''}`;
    });
  }

  function retainAudio(row){
    if(row.audio||!row.samples)return;
    const pcm=new Int16Array(row.samples);let offset=0;
    for(const chunk of row.chunks){pcm.set(chunk,offset);offset+=chunk.length;}row.chunks=[];
    const url=URL.createObjectURL(new Blob([encodeWav(pcm)],{type:'audio/wav'}));urls.add(url);
    const audio=document.createElement('audio');audio.className='turn-audio';audio.controls=true;audio.preload='none';audio.src=url;
    audio.addEventListener('play',()=>{if(!ended)audio.pause();});
    updateRecords(()=>row.node.append(audio));row.audio=audio;
  }
  function renderReview(event){
    reviewPending=false;reviewDone=true;notice='';
    const result=event.result;
    if(!result||!Array.isArray(result.suggestions)){reviewState='error';reviewError='复盘结果不完整，未展示建议。';el('report-status').textContent=reviewError;controls();return;}
    reviewState='complete';textConfigured=true;textVerified=true;
    let knowledgeStatus='';
    if(result.knowledge?.status==='matched')knowledgeStatus=`表达参考：本次检索到 ${result.knowledge.retrievedIds?.length||0} 张知识卡${result.knowledge.corpusVersion?`（${result.knowledge.corpusVersion}）`:''}。`;
    if(result.knowledge?.status==='no_match')knowledgeStatus='本库暂无相关卡；本次按模型判断复盘。';
    if(result.knowledge?.status==='unavailable')knowledgeStatus='知识库不可用；本次按模型判断复盘。';
    el('report-status').textContent=[result.summary,knowledgeStatus].filter(Boolean).join(' ');
    el('suggestions').replaceChildren();
    for(const item of result.suggestions){
      const card=document.createElement('article');card.className='suggestion';
      const original=document.createElement('blockquote'),suggestion=document.createElement('p'),reason=document.createElement('details'),reasonTitle=document.createElement('summary'),reasonText=document.createElement('p'),source=document.createElement('p');
      const kind=document.createElement('p');kind.className='note';kind.textContent=item.kind==='optional'?'可选说法 · 原表达也可以使用':'明确问题';
      original.textContent=item.original;suggestion.textContent=item.suggestion;suggestion.className='suggestion-text';
      reasonTitle.textContent='为什么这样说';reasonText.textContent=item.reason;reason.append(reasonTitle,reasonText);
      const turnId=item.evidence?.turnId;
      source.className='note';source.textContent=turnId?`原话依据：${turnId} 的聊天原话；短练不代表掌握。`:'原句来自本次聊天；未评估发音。';
      card.append(kind,original,suggestion,reason,source);
      const references=Array.isArray(item.knowledgeSources)?item.knowledgeSources.slice(0,2):[];
      if(!references.length){const note=document.createElement('p');note.className='note';note.textContent='模型判断，未引用知识卡。';card.append(note);}
      for(const reference of references){
        const section=document.createElement('details'),label=document.createElement('summary'),scope=document.createElement('p');
        label.className='note';label.textContent=`表达参考：${reference.expression||reference.knowledgeId||'知识卡'}`;
        scope.className='note';scope.textContent='资料支持教学原则，不构成官方对该表达或本次纠错的逐字认证。';section.append(label,scope);
        for(const entry of (Array.isArray(reference.sources)?reference.sources:[]).slice(0,4)){
          let url;try{url=new URL(entry.url);}catch{continue;}
          if(url.protocol!=='https:'||!url.hostname||url.username||url.password)continue;
          const link=document.createElement('a'),line=document.createElement('p');link.textContent=entry.title||'参考来源';link.setAttribute('href',url.href);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');line.className='note';line.append(link);section.append(line);
        }
        card.append(section);
      }
      if(turnId){
        const button=document.createElement('button');button.textContent='查看原句';button.disabled=!rows.has(turnId);
        if(rows.has(turnId))button.setAttribute('aria-controls',rows.get(turnId).node.id);
        button.addEventListener('click',()=>locateEvidence(turnId));card.append(button);
      }
      el('suggestions').append(card);
    }
    if(event.unreviewedTurnIds?.length){const note=document.createElement('p');note.textContent=`另有 ${event.unreviewedTurnIds.length} 段新回答尚未纳入这组复盘。`;el('suggestions').append(note);}
    controls();
  }
  function stopMic(){
    generation++;beginRequested=false;starting=false;
    if(mic){captureMs+=Date.now()-captureStarted;mic=false;}
    detector.reset();if(liveTurn){connection.finishTurn();liveTurn=null;}
    void capture.stop('pause').catch(()=>message('收音已停止，设备释放过程有异常。'));controls();
  }
  function end(){
    if(ended)return;
    const cancelled=connecting;
    ended=true;connecting=false;canRetry=cancelled&&!rows.size;voiceReady=false;notice='';replyGenerating=false;awaitingReply=false;
    stopMic();playback.stop();
    if(cancelled){connection.disconnect();el('connection-settings').open=true;notice='已取消连接。可以检查设置后再次开始练习。';}
    else connection.end();
    for(const row of rows.values())retainAudio(row);
    if(!cancelled)showView('review');controls();
  }
  const detectorHandlers={
    onStart(){
      if(!mic||!connection.canStartTurn){liveTurn=null;return;}
      replyGenerating=false;awaitingReply=false;notice='';const progress=playback.stop(),id=`turn-${++turnSequence}`;
      if(connection.startTurn(id,progress)){liveTurn=id;rowFor(id);}
      else liveTurn=null;
      controls();
    },
    onAudio(pcm){if(liveTurn&&mic)connection.push(pcm);},
    onEnd(){if(liveTurn){connection.finishTurn();liveTurn=null;awaitingReply=true;}controls();},
  };
  function createDetector(){return detectorFactory({...detectorHandlers,silenceMs:Number(el('reply-wait').value)});}
  let detector=createDetector();
  const capture=captureFactory({maxMs:300000,onPcm(pcm){if(mic)detector.push(pcm);},onStop(result){
    if(mic){captureMs+=Date.now()-captureStarted;mic=false;starting=false;detector.reset();if(liveTurn){connection.finishTurn();liveTurn=null;}}
    if(result.reason==='limit')end();controls();
  }});
  function interruptReview(){
    if(!textConfigured||reviewState==='complete'||reviewState==='error')return;
    reviewPending=false;reviewState='error';notice='';reviewError='连接已中断，文字复盘未完成。已有原话与原音保留。';
    el('report-status').textContent=reviewError;
  }
  connection=connectionFactory({onEvent(event){
    if(pageGone)return;
    if(event.type==='connection.closed'&&ended){interruptReview();controls();return;}
    if(event.type==='ready'){
      // A late upstream event cannot resurrect a cancelled or failed startup.
      if(!connecting||!beginRequested||ended)return;
      const focusStart=document.activeElement===el('start');
      clearSecrets();el('connection-settings').open=false;voiceReady=true;connecting=false;notice='';
      startPromise=startCapture(generation,unlockPromise);
      if(focusStart)el('end').focus();
    }
    if(event.type==='input.sent'){const row=rowFor(event.turnId);row.chunks.push(event.pcm);row.samples+=event.pcm.length;}
    if(event.type==='input.dropped'){const row=rows.get(event.turnId);if(row){row.dropped+=event.samples;updateRecords(()=>row.label.textContent+=' · 尾段未上传');}}
    if(event.type==='user.transcript'){const row=rowFor(event.turnId);renderTranscript(row,event);if(ended)retainAudio(row);}
    if(event.type==='user.incomplete'){const row=rows.get(event.turnId);if(row){updateRecords(()=>{row.content.open=true;row.summary.hidden=true;row.text.textContent='这段识别未完成。可回听本页已发送的原音。';});if(ended)retainAudio(row);}}
    if(event.type==='reply.start'&&!ended){replyGenerating=true;awaitingReply=false;notice='';playback.activate(event.replyId);}
    if(event.type==='reply.audio'&&!ended){if(!playback.enqueue(event.audio,event.replyId)){stopReason='播放未能跟上回复，本次通话停止。';end();}}
    if(event.type==='reply.done'&&!ended)replyGenerating=false;
    if(event.type==='phase'&&!ended){phase=event.phase;notice='';}
    if(event.type==='review.pending'&&textConfigured&&(reviewState==='idle'||reviewState==='pending')){reviewPending=true;reviewState='pending';notice='';el('report-status').textContent='正在根据聊天原话整理一组表达建议…';}
    if(event.type==='review.result')renderReview(event);
    if(event.type==='review.error'){
      reviewPending=false;notice='';
      if(textConfigured){reviewState='error';reviewError=event.message||'文字复盘不可用；已有原音与原话保留。';el('report-status').textContent=reviewError;}
      else reviewState='idle';
    }
    if(event.type==='ended'){
      if(!ended){ended=true;connecting=false;voiceReady=false;canRetry=false;notice='';replyGenerating=false;awaitingReply=false;stopMic();playback.stop();for(const row of rows.values())retainAudio(row);}
      showView('review');
    }
    if(event.type==='error'&&event.fatal===false)message(event.message||'请等当前回复结束后再操作。');
    if(event.type==='error'&&event.fatal!==false||event.type==='connection.closed'){
      if(event.type==='error'){
        const detail=typeof event.message==='string'&&event.message?event.message:'连接失败，请检查配置后手动重连。';
        const code=typeof event.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(event.code)?`（${event.code}）`:'';
        fatalMessage||=detail+code;
      }else fatalMessage||='连接已关闭。已有记录保留。';
      canRetry=!rows.size;ended=true;connecting=false;voiceReady=false;notice='';replyGenerating=false;awaitingReply=false;stopMic();playback.stop();
      interruptReview();
      if(canRetry)el('connection-settings').open=true;
      for(const row of rows.values())retainAudio(row);
    }
    controls();
  }});
  function showAuthFields(){
    const mode=el('auth-type').value;
    el('api-key-fields').hidden=mode!=='api-key';el('legacy-fields').hidden=mode!=='legacy';
  }
  const tabs=['call-tab','review-tab'];
  for(const [index,id] of tabs.entries()){
    el(id).addEventListener('click',()=>showView(index?'review':'call'));
    el(id).addEventListener('keydown',event=>{
      let next;
      if(event.key==='ArrowRight'||event.key==='ArrowLeft')next=1-index;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=1;
      else return;
      event.preventDefault();showView(next?'review':'call',true);
    });
  }
  el('transcripts-scroll').addEventListener('scroll',()=>{
    const scroll=el('transcripts-scroll');followTail=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<=64;
    if(followTail)el('new-content').hidden=true;
  });
  el('new-content').addEventListener('click',()=>{
    followTail=true;el('transcripts-scroll').scrollTop=el('transcripts-scroll').scrollHeight;el('new-content').hidden=true;
  });
  showView('call');
  el('auth-type').addEventListener('change',()=>{
    el('voice-key').value='';el('access-token').value='';showAuthFields();
  });
  showAuthFields();
  function clearFormErrors(){
    for(const group of ['voice','text']){el(`${group}-error`).hidden=true;el(`${group}-error`).textContent='';}
    for(const id of ['auth-type','voice-key','app-id','access-token','workspace','text-key'])el(id).setAttribute('aria-invalid','false');
  }
  function formError(group,id,text){
    el(`${group}-error`).hidden=false;el(`${group}-error`).textContent=text;el(id).setAttribute('aria-invalid','true');
    el('connection-settings').open=true;if(group==='text')el('text-settings').open=true;
    message(text);el(id).focus();return null;
  }
  function configuration(){
    clearFormErrors();
    const mode=el('auth-type').value;
    if(mode!=='api-key'&&mode!=='legacy')return formError('voice','auth-type','不支持此语音鉴权方式，请重新选择。');
    const config=mode==='api-key'
      ? {authType:'api-key',apiKey:el('voice-key').value.trim()}
      : {authType:'legacy',appId:el('app-id').value.trim(),accessToken:el('access-token').value.trim()};
    if(mode==='api-key'&&!config.apiKey)return formError('voice','voice-key','请填写豆包语音 API Key。');
    if(mode==='legacy'&&(!config.appId||!config.accessToken))return formError('voice',!config.appId?'app-id':'access-token','请填写豆包 App ID 和 Access Token。');
    const workspace=el('workspace').value.trim(),apiKey=el('text-key').value.trim();
    if((workspace&&!apiKey)||(!workspace&&apiKey))return formError('text',workspace?'text-key':'workspace','请同时填写文字配置的 Workspace ID 或 Base URL 与百炼文字 API Key。');
    if(apiKey)config.text={workspace,apiKey};
    return config;
  }
  function unlockPlayback(){
    // Resume must begin inside the explicit click, before waiting for upstream ready.
    try{return Promise.resolve(playback.unlock()).then(Boolean,()=>false);}catch{return Promise.resolve(false);}
  }
  async function startCapture(token,unlocked){
    if(token!==generation||ended||pageGone||!beginRequested||!voiceReady)return;
    const focusStart=document.activeElement===el('start');
    starting=true;permissionError='';notice='';controls();
    if(focusStart)el('pause').focus();
    try{
      detector.reset();detector=createDetector();
      if(!await unlocked)throw new Error('Playback unavailable.');
      if(token!==generation||ended||pageGone||!beginRequested)return;
      const result=await capture.start();
      if(token!==generation||ended||pageGone||!beginRequested)return;
      if(!result)throw new Error('Capture cancelled.');
      starting=false;beginRequested=false;mic=true;captureStarted=Date.now();controls();
    }catch{
      if(token===generation&&!ended&&!pageGone){starting=false;beginRequested=false;permissionError='无法开始收音，请检查浏览器麦克风权限与音频播放支持，然后点击继续收音。';controls();}
    }
  }
  el('start').addEventListener('click',()=>{
    if(pageGone||connecting||mic||starting||reviewPending||ended&&!canRetry)return;
    if(captureMs>=300000){message('本次练习已达 5 分钟。');end();return;}
    if(voiceReady){
      const token=++generation;beginRequested=true;unlockPromise=unlockPlayback();startPromise=startCapture(token,unlockPromise);return startPromise;
    }
    if(rows.size){message('本页已有记录。请先保存需要的原音，再刷新开启新练习。');return;}
    const config=configuration();if(!config)return;
    const focusStart=document.activeElement===el('start');
    fatalMessage='';notice='';permissionError='';stopReason='';ended=false;canRetry=false;connecting=true;beginRequested=true;generation++;
    textConfigured=Boolean(config.text);textVerified=false;reviewState='idle';reviewError='';reviewPending=false;reviewDone=false;
    unlockPromise=unlockPlayback();controls();if(focusStart)el('end').focus();connection.connect(config);return startPromise;
  });
  el('pause').addEventListener('click',()=>{if(ended||!mic&&!starting)return;notice='';permissionError='';stopMic();controls();if(!el('start').hidden)el('start').focus();});
  el('end').addEventListener('click',end);
  el('review').addEventListener('click',()=>{if(!textConfigured||ended||el('review').disabled)return;if(connection.requestReview()){reviewPending=true;reviewState='pending';notice='';el('report-status').textContent='正在根据聊天原话整理一组表达建议…';showView('review');controls();}});
  el('resume-chat').addEventListener('click',()=>{if(!textConfigured||ended||el('resume-chat').disabled)return;if(connection.resumeChat()){phase='chat';notice='';showView('call');controls();}});
  window.addEventListener('pagehide',()=>{clearSecrets();pageGone=true;ended=true;connecting=false;voiceReady=false;canRetry=false;stopMic();playback.stop();connection.disconnect();void capture.dispose();void playback.dispose();for(const url of urls)URL.revokeObjectURL(url);urls.clear();});
  for(const id of ['workspace','text-key'])el(id).addEventListener('input',()=>capabilities());
  controls();return {end};
}
if(globalThis.document)initCoachApp();
