import {pcmToBase64} from './audio.mjs';

export function createCoachConnection({WebSocketImpl=globalThis.WebSocket,url=`ws://${globalThis.location?.host}/connect`,onEvent=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,now=()=>globalThis.performance.now()}={}){
  let socket=null,generation=0,ready=false,ending=false,turn=null,timer=null,asrPending=false,awaitingReply=false,responseActive=false,clearPending=()=>{};
  const allowed=new Set(['ready','input.ready','input.waiting','user.transcript','user.incomplete','reply.start','reply.audio','reply.text','reply.done','truncate.confirmed','review.pending','review.result','review.error','phase','ended','usage','error']);
  const waitingMessages={input_ready:'等待上传许可的音频已达上限，通话已停止。',truncate_ack:'等待打断确认的音频已达上限，通话已停止。',reply_end:'等待上一段回复结束的音频已达上限，通话已停止。',truncate_ack_and_reply_end:'等待打断确认和上一段回复结束的音频已达上限，通话已停止。'};
  const waitingStages=new Set(['truncate_ack','reply_end','truncate_ack_and_reply_end']);
  function clearQueue(){
    if(timer!==null)clearTimer(timer);timer=null;
    if(turn?.queue.length)onEvent({type:'input.dropped',turnId:turn.id,samples:turn.queue.length*320});
    turn=null;
  }
  function disconnect(){const old=socket;socket=null;generation++;clearPending();clearPending=()=>{};ready=false;ending=false;asrPending=false;awaitingReply=false;responseActive=false;clearQueue();if(old){old.onopen=old.onmessage=old.onclose=null;old.onerror=()=>{};old.close();}}
  function fail(code,message,diagnostics={}){disconnect();onEvent({type:'error',code,message,...diagnostics});}
  function send(value){
    if(!socket||socket.readyState!==1)return false;
    if(socket.bufferedAmount>262144){fail('BACKPRESSURE','发送队列已满，通话已停止。');return false;}
    try{socket.send(JSON.stringify(value));return true;}catch{fail('CONNECTION_LOST','本地连接已中断。');return false;}
  }
  function finishInput(current){
    if(current!==turn||!current?.gate||!current.done||current.queue.length)return;
    if(timer!==null)clearTimer(timer);timer=null;
    turn=null;asrPending=true;awaitingReply=true;send({type:'input.end',turnId:current.id});
  }
  function pump(current=turn,token=generation){
    if(current!==turn||token!==generation)return;
    timer=null;
    if(!current?.gate||ending||!ready)return;
    if(current.queue.length){
      const sentAt=now(),deadline=current.nextSendAt??sentAt;
      const pcm=current.queue.shift(),id=current.id;
      if(!send({type:'input.audio',turnId:id,audio:pcmToBase64(pcm)}))return;
      onEvent({type:'input.sent',turnId:id,pcm:pcm.slice()});
      if(current!==turn||token!==generation)return;
      // Compensate ordinary callback/send delay without flushing a stalled queue.
      // More than one frame late starts a new cadence; each callback sends one frame.
      current.nextSendAt=sentAt-deadline>20?sentAt+20:deadline+20;
      if(current.done&&!current.queue.length)finishInput(current);
      else timer=setTimer(()=>pump(current,token),Math.max(0,current.nextSendAt-now()));
    }else if(current.done){
      finishInput(current);
    }
  }
  function connect(config){
    disconnect();const token=generation;let pending={type:'connect',...config};clearPending=()=>{pending=null;};
    try{socket=new WebSocketImpl(url);}catch{pending=null;fail('CONNECTION_LOST','无法打开本地连接。');return;}
    const current=socket,isCurrent=()=>socket===current&&generation===token;
    current.onopen=()=>{if(!isCurrent())return;send(pending);pending=null;};
    current.onerror=()=>{if(isCurrent()){pending=null;fail('CONNECTION_LOST','本地连接失败，请手动重连。');}};
    current.onclose=()=>{if(isCurrent()){pending=null;disconnect();onEvent({type:'connection.closed'});}};
    current.onmessage=({data})=>{
      if(!isCurrent())return;
      let event;try{if(typeof data!=='string'||data.length>262144)throw new Error();event=JSON.parse(data);}catch{fail('INVALID_EVENT','收到的本地消息无法解析。');return;}
      if(!allowed.has(event?.type))return;
      if(event.type==='ready'&&!ending)ready=true;
      if(event.type==='input.waiting'){
        if(!turn||turn.gate||turn.id!==event.turnId||ending||!waitingStages.has(event.waitFor))return;
        turn.waitFor=event.waitFor;event={type:'input.waiting',turnId:turn.id,waitFor:event.waitFor};
      }
      if(event.type==='input.ready'&&turn?.id===event.turnId&&!ending){turn.gate=true;if(timer===null)pump();}
      if(event.type==='user.transcript'||event.type==='user.incomplete')asrPending=false;
      if(event.type==='reply.start'){awaitingReply=false;responseActive=true;}
      if(event.type==='reply.done')responseActive=false;
      if(event.type==='review.error')awaitingReply=false;
      if(event.type==='ended'){ending=true;ready=false;clearQueue();}
      if(event.type==='error'&&event.fatal!==false){ready=false;clearQueue();}
      onEvent(event);
    };
  }
  return {connect,disconnect,get ready(){return ready&&!ending;},get canStartTurn(){return ready&&!ending&&!turn&&!asrPending&&!awaitingReply;},
    get canReview(){return this.canStartTurn&&!responseActive;},
    startTurn(id,playback){
      if(!this.canStartTurn||typeof id!=='string'||!id||id.length>256)return false;
      turn={id,queue:[],gate:false,done:false,nextSendAt:null,waitFor:null};
      const position={responseId:playback?.responseId??null,audioEndMs:playback?.audioEndMs??0};
      if(!send({type:'input.start',turnId:id,playback:position})){turn=null;return false;}return true;
    },
    push(pcm){
      if(!turn||turn.done||ending)return false;
      if(!(pcm instanceof Int16Array)||pcm.length!==320)throw new TypeError('Expected 20ms PCM.');
      if(turn.queue.length>=500){
        const queueStage=turn.gate?'upload':'gate',waitingFor=turn.waitFor||'input_ready';
        fail('AUDIO_QUEUE_LIMIT',queueStage==='gate'?waitingMessages[waitingFor]:'音频发送进度落后，等待音频已达上限，通话已停止。',
          {queueStage,...(queueStage==='gate'?{waitingFor}:{}),queuedMs:turn.queue.length*20,maxQueuedMs:10000});return false;
      }
      turn.queue.push(pcm.slice());if(turn.gate&&timer===null)pump();return true;
    },
    finishTurn(){if(!turn||ending)return;turn.done=true;if(turn.gate&&!turn.queue.length)finishInput(turn);else if(timer===null)pump();},
    requestReview(){if(!this.canReview)return false;awaitingReply=true;if(send({type:'review.start'}))return true;awaitingReply=false;return false;},
    resumeChat(){if(!this.canReview)return false;return send({type:'review.resume'});},
    end(){if(!socket||ending)return;if(socket.readyState!==1){disconnect();return;}ending=true;ready=false;clearQueue();send({type:'session.end'});},
  };
}
