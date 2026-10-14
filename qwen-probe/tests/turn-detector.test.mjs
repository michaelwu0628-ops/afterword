import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../public/turn-detector.mjs').catch(() => ({}));
const quiet = () => new Int16Array(320);
const voice = () => new Int16Array(320).fill(2000);
function fixture(options={}) {
  assert.equal(typeof api.createTurnDetector,'function');
  const events=[];
  const detector=api.createTurnDetector({onStart:()=>events.push(['start']),onAudio:pcm=>events.push(['audio',pcm]),onEnd:reason=>events.push(['end',reason]),...options});
  return {detector,events};
}
test('automatic detection retains pre-roll, streams 20ms PCM and ends after a thinking pause',()=>{
  const {detector,events}=fixture();
  for(let i=0;i<20;i++) detector.push(quiet());
  for(let i=0;i<4;i++) detector.push(voice());
  assert.equal(events.length,0);
  detector.push(voice());
  assert.equal(events[0][0],'start');
  assert.equal(events.filter(x=>x[0]==='audio').length,15);
  assert.ok(events.filter(x=>x[0]==='audio').every(x=>x[1].length===320));
  for(let i=0;i<249;i++) detector.push(quiet());
  assert.equal(events.some(x=>x[0]==='end'),false);
  detector.push(quiet());
  assert.deepEqual(events.at(-1),['end','silence']);
  assert.equal(detector.speaking,false);
});
test('short noises do not start a turn and re-chunking does not change detection',()=>{
  const first=fixture(), second=fixture();
  const pcm=new Int16Array(320*270);
  pcm.fill(2000,320*15,320*19); // 80ms noise
  pcm.fill(2000,320*20,320*26); // sustained voice
  for(let i=0;i<pcm.length;i+=320) first.detector.push(pcm.subarray(i,i+320));
  for(let i=0;i<pcm.length;i+=127) second.detector.push(pcm.subarray(i,i+127));
  const summary=events=>events.map(x=>x[0]==='audio'?['audio',...x[1]]:x);
  assert.deepEqual(summary(first.events),summary(second.events));
  assert.equal(first.events.filter(x=>x[0]==='start').length,1);
  assert.equal(first.events.some(x=>x[0]==='end'),false);
});
test('turn limit is bounded and reset never submits a partial turn',()=>{
  const {detector,events}=fixture({maxTurnMs:1000});
  for(let i=0;i<50;i++) detector.push(voice());
  assert.deepEqual(events.at(-1),['end','limit']);
  assert.equal(events.filter(x=>x[0]==='audio').length,50);
  for(let i=0;i<5;i++) detector.push(voice());
  const before=events.length;
  detector.reset();
  detector.push(new Int16Array(127));
  assert.equal(events.length,before);
  assert.equal(detector.speaking,false);
});
test('retained PCM is isolated from the capture buffer and detector options are bounded',()=>{
  const {detector,events}=fixture();
  const pcm=voice(); detector.push(pcm); pcm.fill(0);
  for(let i=0;i<4;i++) detector.push(voice());
  assert.equal(events.find(x=>x[0]==='audio')[1][0],2000);
  assert.throws(()=>detector.push([1,2]),TypeError);
  for(const options of [{threshold:0},{threshold:1},{silenceMs:10},{silenceMs:50001},{startMs:0},{maxTurnMs:999999}]) assert.throws(()=>api.createTurnDetector(options),RangeError);
});
test('reset inside callbacks stops cached release and the remainder of the same push',()=>{
  let detector;const events=[];
  detector=api.createTurnDetector({onStart(){events.push('start');detector.reset();},onAudio(){events.push('audio');}});
  detector.push(new Int16Array(320*50).fill(2000));
  assert.deepEqual(events,['start']);
  let audioCount=0;
  detector=api.createTurnDetector({onAudio(){audioCount++;detector.reset();}});
  detector.push(new Int16Array(320*50).fill(2000));
  assert.equal(audioCount,1);assert.equal(detector.speaking,false);
});
