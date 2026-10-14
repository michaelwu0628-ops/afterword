// Local energy detection, not semantic VAD. Model compatibility and echo require real tests.
export function createTurnDetector({onStart=()=>{},onAudio=()=>{},onEnd=()=>{},threshold=0.015,startMs=100,silenceMs=5000,maxTurnMs=60000}={}) {
  if(!Number.isFinite(threshold)||threshold<=0||threshold>=1
    ||!Number.isInteger(startMs)||startMs<20||startMs>500
    ||!Number.isInteger(silenceMs)||silenceMs<500||silenceMs>50000
    ||!Number.isInteger(maxTurnMs)||maxTurnMs<1000||maxTurnMs>60000) throw new RangeError('Invalid turn detector options.');
  const startFrames=Math.ceil(startMs/20),silenceFrames=Math.ceil(silenceMs/20),maxFrames=Math.floor(maxTurnMs/20);
  let partial=new Int16Array(320),count=0,roll=[],voiced=0,silent=0,sent=0,speaking=false,epoch=0;
  function reset(){epoch++;partial=new Int16Array(320);count=0;roll=[];voiced=0;silent=0;sent=0;speaking=false;}
  function frame(pcm){
    const token=epoch;
    let energy=0;
    for(const sample of pcm) energy+=(sample/32768)**2;
    const loud=Math.sqrt(energy/320)>=threshold;
    if(!speaking){
      roll.push(pcm); if(roll.length>15)roll.shift();
      voiced=loud?voiced+1:0;
      if(voiced<startFrames)return;
      speaking=true;sent=roll.length;silent=0;
      const held=roll;roll=[];
      onStart();for(const item of held){if(token!==epoch)return;onAudio(item);}
    }else{
      onAudio(pcm);if(token!==epoch)return;sent++;silent=loud?0:silent+1;
    }
    if(sent>=maxFrames||silent>=silenceFrames){
      const reason=sent>=maxFrames?'limit':'silence';
      partial=new Int16Array(320);count=0;roll=[];voiced=0;silent=0;sent=0;speaking=false;onEnd(reason);
    }
  }
  return {reset,get speaking(){return speaking;},push(pcm){
    if(!(pcm instanceof Int16Array))throw new TypeError('Expected Int16Array PCM.');
    let offset=0;const token=epoch;
    while(offset<pcm.length&&token===epoch){
      const length=Math.min(320-count,pcm.length-offset);
      partial.set(pcm.subarray(offset,offset+length),count);count+=length;offset+=length;
      if(count===320){const ready=partial;partial=new Int16Array(320);count=0;frame(ready);}
    }
  }};
}
