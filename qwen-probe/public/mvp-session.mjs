import {createCapture,createPlayback,encodeWav} from './audio.mjs';
import {createTurnDetector} from './turn-detector.mjs';
import {createCoachConnection} from './coach-connection.mjs';

export function createPracticeCall({config,practice,onEvent=()=>{},onSnapshot=()=>{},captureFactory=createCapture,playbackFactory=createPlayback,connectionFactory=createCoachConnection,detectorFactory=createTurnDetector}={}){
  if(!config||!practice||!['material','part2'].includes(practice.mode))throw new TypeError('INVALID_PRACTICE');
  let connecting=false,ready=false,starting=false,mic=false,ended=false,gone=false,epoch=0,phase='chat',liveTurn=null,sequence=0,review=null,reviewPending=false,stage='idle',message='准备好后开始练习。',unlock;
  let independent=practice.mode==='part2',answerSubmitted=false,followups=0,partial=new Int16Array(320),partialCount=0,independentAudio=null,independentDuration=0,failed=false;
  const rows=new Map();
  const state=()=>({connecting,ready,starting,mic,ended,phase,stage,message,reviewPending,answerSubmitted,followups,playing:playback.playing,canReview:ready&&!ended&&!starting&&!independent&&connection.canReview&&!playback.playing&&rows.size>0,review});
  function publish(){if(!gone)onEvent({type:'state',...state()});}
  function row(id,role='user'){
    if(!rows.has(id)){if(rows.size>=80)throw new Error('RECORD_LIMIT');rows.set(id,{id,role,text:'',phase:role==='user'&&id==='part2-answer'?'independent':phase,chunks:[],samples:0,audioSamples:0,audio:null,duration:0,incomplete:false});}
    return rows.get(id);
  }
  function keepAudio(item){
    if(!item.samples||item.audio&&item.audioSamples===item.samples)return;
    const pcm=new Int16Array(item.samples);let offset=0;for(const chunk of item.chunks){pcm.set(chunk,offset);offset+=chunk.length;}
    item.audio=new Blob([encodeWav(pcm)],{type:'audio/wav'});item.duration=item.samples/16000;item.audioSamples=item.samples;
  }
  function snapshot(){
    if(gone)return;
    for(const item of rows.values())if(item.role==='user')keepAudio(item);
    onSnapshot({turns:[...rows.values()].map(({chunks,samples,audioSamples,...item})=>({...item,incomplete:item.incomplete||item.role==='user'&&!item.text})),review,independentAudio,independentDuration,status:ended?(failed?'interrupted':'complete'):'active'});
  }
  function stopMic(){epoch++;mic=false;detector.reset();if(liveTurn){connection.finishTurn();liveTurn=null;}void capture.stop('pause').catch(()=>{});}
  function fail(text){failed=true;message=text||'连接中断，已有记录保留。';ended=true;ready=false;connecting=false;stage='error';stopMic();playback.stop();connection.end();connection.disconnect();snapshot();publish();}
  const playback=playbackFactory({sampleRate:24000,maxQueuedSeconds:30,onStateChange:()=>publish()});
  const detector=detectorFactory({silenceMs:[1500,3000,5000].includes(config.replyWait)?config.replyWait:1500,
    onStart(){if(!mic||!connection.canStartTurn)return;const progress=playback.stop(),id=`turn-${++sequence}`;if(connection.startTurn(id,progress)){liveTurn=id;row(id);stage='listening';publish();}},
    onAudio(pcm){if(mic&&liveTurn)connection.push(pcm);},
    onEnd(){if(liveTurn){connection.finishTurn();liveTurn=null;stage='waiting';message='等 AI 接话。';publish();}},
  });
  function sendIndependent(pcm){
    let offset=0;
    while(offset<pcm.length&&independent&&mic){const size=Math.min(320-partialCount,pcm.length-offset);partial.set(pcm.subarray(offset,offset+size),partialCount);offset+=size;partialCount+=size;if(partialCount===320){connection.push(partial);partial=new Int16Array(320);partialCount=0;}}
  }
  const capture=captureFactory({maxMs:practice.mode==='part2'?120000:300000,onPcm(pcm){if(mic){if(independent)sendIndependent(pcm);else detector.push(pcm);}},onStop(result){
    if(gone)return;
    if(practice.mode==='part2'&&!answerSubmitted&&result?.pcm){independentAudio=new Blob([result.wav||encodeWav(result.pcm)],{type:'audio/wav'});independentDuration=result.pcm.length/16000;}
    if(result?.reason==='limit'){if(independent)void finishAnswer(true);else end();}
    snapshot();
  }});
  async function beginCapture(token){
    if(starting||mic||token!==epoch||ended||gone||!ready)return;
    // Keep this guard until the outstanding device promise settles, even after
    // pause/end. A stale completion must never stop a newer capture attempt.
    starting=true;publish();
    const cancelled=()=>token!==epoch||ended||gone||!ready;
    try{
      const unlocked=await unlock;
      if(cancelled())return;if(!unlocked)throw new Error();
      detector.reset();
      if(independent){if(!connection.startTurn('part2-answer',playback.stop()))throw new Error();liveTurn='part2-answer';row(liveTurn);}
      const opened=await capture.start();
      if(cancelled()){void capture.stop('cancel').catch(()=>{});return;}
      if(!opened)throw new Error();
      mic=true;stage=independent?'answering':'listening';message=independent?'独立作答中。思考停顿不会结束录音。':'开口就可以聊。想停一会儿可以暂停。';publish();
    }catch{
      if(cancelled())void capture.stop('cancel').catch(()=>{});
      else fail('无法开启麦克风，请检查浏览器权限后重新开始。');
    }finally{starting=false;publish();}
  }
  const connection=connectionFactory({onEvent(event){
    if(gone)return;
    if(event.type==='ready'){if(!connecting||ended)return;ready=true;connecting=false;void beginCapture(epoch);}
    if(event.type==='input.sent'){const item=row(event.turnId);item.chunks.push(event.pcm.slice());item.samples+=event.pcm.length;if(item.samples-item.audioSamples>=16000)snapshot();}
    if(event.type==='input.dropped'){const item=rows.get(event.turnId);if(item)item.incomplete=true;snapshot();}
    if(event.type==='user.transcript'){
      const item=row(event.turnId);item.text=event.text;item.phase=event.turnId==='part2-answer'?'independent':event.phase||phase;keepAudio(item);
      if(practice.mode==='part2'&&answerSubmitted&&event.turnId!=='part2-answer'&&item.phase==='chat')followups++;snapshot();
    }
    if(event.type==='user.incomplete'){const item=row(event.turnId);item.incomplete=true;snapshot();}
    if(event.type==='reply.start'&&!ended){playback.activate(event.replyId);row(`ai-${event.replyId}`,'assistant');stage='responding';message=phase==='review'?'一起回顾刚才的表达。':'AI 正在回应，可以开口打断。';}
    if(event.type==='reply.audio'&&!ended&&!playback.enqueue(event.audio,event.replyId)){fail('音频播放未能跟上，通话已停止。');return;}
    if(event.type==='reply.text'){const item=row(`ai-${event.replyId}`,'assistant');item.text=event.text;snapshot();}
    if(event.type==='reply.done'&&!ended){stage=mic?'listening':'paused';if(practice.mode==='part2'&&answerSubmitted&&phase==='chat'){if(followups>=2){stopMic();stage='followups_done';message='追问已完成，可以一起复盘或结束。';}else if(!mic)void resume();}}
    if(event.type==='phase')phase=event.phase;
    if(event.type==='review.pending'){reviewPending=true;stage='reviewing';message='正在整理真实原话与表达建议。';}
    if(event.type==='review.result'){review=event.result;reviewPending=false;message='复盘已准备好。';snapshot();}
    if(event.type==='review.error'){reviewPending=false;message=event.message||'复盘暂未完成，原音和记录已保留。';snapshot();}
    if(event.type==='ended'){ended=true;ready=false;connecting=false;stage='ended';stopMic();playback.stop();snapshot();}
    if(event.type==='error'){if(event.fatal===false)message=event.message||'请等当前回应结束。';else{fail(event.message);return;}}
    if(event.type==='connection.closed'&&!ended){fail('连接已关闭，已有记录保留。');return;}
    onEvent(event);publish();
  }});
  async function start(){
    if(connecting||ready||ended||gone)return;
    connecting=true;stage='connecting';message='正在连接语音服务，尚未开启麦克风。';epoch++;
    // Unlock starts synchronously within the caller's explicit click.
    unlock=Promise.resolve(playback.unlock()).catch(()=>false);publish();
    const topic=practice.topic&&{title:practice.topic.title,prompt:practice.topic.prompt,bullets:practice.topic.bullets};
    const reviewItems=(practice.reviewItems||[]).filter(item=>typeof item.expression==='string'&&item.expression.length<=240&&typeof item.usage==='string'&&item.usage.length<=600).slice(0,3).map(({expression,usage})=>({expression,usage}));
    const context={mode:practice.mode,title:(practice.title||'').slice(0,240),...(practice.mode==='material'?{sourceText:practice.sourceText||''}:{topic,notes:practice.notes||''}),reviewItems};
    const {replyWait,...credentials}=config;connection.connect({...credentials,practice:context});
  }
  async function finishAnswer(fromCapture=false){
    if(!independent||answerSubmitted||ended)return;
    mic=false;
    if(!fromCapture)await capture.stop('answer-finished');
    if(partialCount){connection.push(partial);partial=new Int16Array(320);partialCount=0;}
    independent=false;answerSubmitted=true;connection.finishTurn();liveTurn=null;stage='waiting';message='作答已结束，接下来是短追问。';snapshot();publish();
  }
  function pause(){if(!ready||ended||independent)return;stopMic();stage='paused';message='麦克风已暂停，仍可听 AI 的回复。';publish();}
  async function resume(){if(!ready||ended||gone||starting||mic||independent||reviewPending)return;unlock=Promise.resolve(playback.unlock()).catch(()=>false);await beginCapture(epoch);}
  function requestReview(){if(!state().canReview)return false;if(connection.requestReview()){reviewPending=true;stage='reviewing';publish();return true;}return false;}
  function resumeChat(){if(!ended&&connection.resumeChat()){phase='chat';message='继续聊聊。';publish();return true;}return false;}
  function end(){if(ended||gone)return;ended=true;connecting=false;ready=false;stopMic();playback.stop();connection.end();stage='ended';message='通话已结束，正在保存已有内容。';snapshot();publish();}
  async function dispose(){if(gone)return;end();gone=true;epoch++;connection.disconnect();await Promise.allSettled([capture.dispose(),playback.dispose()]);config=null;}
  return {start,pause,resume,requestReview,resumeChat,finishAnswer,end,dispose,get state(){return state();}};
}
