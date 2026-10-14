import {createPracticeStore} from './mvp-store.mjs';
import {TOPICS,createPart2Clock} from './mvp-part2.mjs';
import {createPracticeCall} from './mvp-session.mjs';
import {encodeBackup,decodeBackup} from './mvp-backup.mjs';

export function initProductApp({document=globalThis.document,window=globalThis.window,store=createPracticeStore(),callFactory=createPracticeCall,fetchImpl=globalThis.fetch}={}){
  const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  let page='home',material=null,selectedTopic=TOPICS[0],modelConfig=null,call=null,currentPractice=null,saveQueue=Promise.resolve(),returnPage='home',answerClockStarted=false,disposed=false;
  let media=null,launching=false,mutatingHistory=false,pendingRelatedId=null,historyRead=0;const deletedIds=new Set();const clock=createPart2Clock(),urls=new Set(),audioUrls=new WeakMap();let customTopics=[];
  try{customTopics=JSON.parse(window.localStorage.getItem('afterword-topics-v1')||'[]').filter(t=>t&&typeof t.prompt==='string'&&Array.isArray(t.bullets));}catch{}
  function tell(text){$('notice').textContent=text;$('notice').hidden=!text;}
  function audioURL(blob){if(!audioUrls.has(blob)){const url=URL.createObjectURL(blob);audioUrls.set(blob,url);urls.add(url);}return audioUrls.get(blob);}
  function busy(){return launching||mutatingHistory||Boolean(call&&!call.state.ended&&(call.state.connecting||call.state.ready||call.state.mic));}
  function navigate(next){
    if(busy()&&next!=='practice'){tell('先结束当前通话，再切换练习。已有内容会自动保留。');return;}
    if(!document.querySelector(`[data-view="${next}"]`))return;
    for(const player of document.querySelectorAll('audio,video'))player.pause();
    page=next;tell('');for(const view of document.querySelectorAll('[data-view]'))view.hidden=view.dataset.view!==next;
    const labels={home:'开始练习',listen:'听后聊',part2:'雅思 Part 2',practice:'本次练习',history:'练习记录','review-items':'表达复习',settings:'AI 服务设置'};$('page-label').textContent=labels[next];
    for(const button of document.querySelectorAll('nav [data-page]')){if(button.dataset.page===next)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
    if(['home','history','review-items'].includes(next))void refreshLists();
    if(next==='listen')renderMaterial();if(next==='part2')renderTopic();window.scrollTo({top:0,behavior:'auto'});
  }
  for(const button of document.querySelectorAll('[data-page]'))button.addEventListener('click',()=>navigate(button.dataset.page));
  document.querySelector('.wordmark').addEventListener('click',event=>{event.preventDefault();navigate('home');});
  async function api(path,body){
    const response=await fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    let value;try{value=await response.json();}catch{throw new Error('服务没有返回可读取的结果，请稍后重试。');}
    if(!response.ok)throw new Error(value.message||'请求未完成，请检查配置后重试。');return value;
  }
  function segment(){
    const start=Number($('segment-start').value),end=Number($('segment-end').value);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||material?.duration&&end>material.duration+1)throw new Error('请填写有效片段起止，结束须晚于开始且不超过素材时长。');
    const cues=(material?.cues||[]).filter(cue=>cue.end>start&&cue.start<end),text=cues.map(c=>c.text).join('\n');
    return {start,end,cues,text};
  }
  function renderCues(target,cues,field){target.replaceChildren();for(const cue of cues){const p=node('p',null,`${format(cue.start)}  ${cue[field]||''}`);target.append(p);}if(!cues.length)target.append(node('p','helper','还没有这部分字幕。'));}
  function renderMaterial(){
    $('material-ready').hidden=!material;if(!material)return;
    $('material-title').textContent=material.title;$('material-source').textContent=material.mediaBlob?'本地文件':'公开链接';$('media-host').replaceChildren();
    media=document.createElement(material.kind==='video'?'video':'audio');media.controls=true;media.preload='metadata';media.src=material.mediaBlob?audioURL(material.mediaBlob):material.mediaUrl;
    media.addEventListener('loadedmetadata',()=>{if(Number.isFinite(media.duration)&&media.duration>0){material.duration=media.duration;if(Number($('segment-end').value)>media.duration)$('segment-end').value=String(Math.round(media.duration));updateReadiness();}});
    media.addEventListener('timeupdate',()=>{const end=Number($('segment-end').value);if(media.currentTime>=end)media.pause();});media.addEventListener('error',()=>{$('material-status').textContent='音视频暂时无法播放。请检查源链接或使用本地音视频；文字内容不会丢失。';});
    $('media-host').append(media);$('segment-start').value=String(material.selectedStart??0);$('segment-end').value=String(material.selectedEnd??Math.min(material.duration||300,300));
    renderCues($('english-cues'),material.cues||[],'text');renderCues($('chinese-cues'),(material.cues||[]).filter(c=>c.zh),'zh');
    $('transcript-supplement').open=!(material.cues||[]).length;updateReadiness();
  }
  function updateReadiness(){
    try{const s=segment();$('segment-description').textContent=`本次 ${format(s.start)}–${format(s.end)}，约 ${Math.ceil((s.end-s.start)/60)} 分钟。`;$('listen-readiness').textContent=s.text?`已准备 ${s.cues.length} 段英文内容，AI 将依据这些文字聊天。`:'还缺英文内容。可以展开“补充或更正英文字幕”。';$('start-listening-call').disabled=!s.text||s.text.length>12000;if(s.text.length>12000)$('listen-readiness').textContent='这段英文超过首版上下文上限，请缩短片段或文本。';}catch(error){$('listen-readiness').textContent=error.message;$('start-listening-call').disabled=true;}
  }
  $('import-material').addEventListener('click',async()=>{
    const button=$('import-material');button.disabled=true;$('material-status').textContent='正在获取公开素材信息…';
    try{const value=await api('/api/material',{url:$('material-url').value.trim()});material=value;$('material-status').textContent=value.message||'素材信息已取得，请确认播放与英文内容。';renderMaterial();}catch(error){$('material-status').textContent=error.message;}finally{button.disabled=false;}
  });
  $('media-file').addEventListener('change',()=>{const file=$('media-file').files?.[0];if(!file)return;if(file.size>50*1024*1024){tell('本地文件请控制在 50 MB 内。');return;}material={title:file.name,url:'',mediaUrl:'',kind:file.type.startsWith('video/')?'video':'audio',duration:null,cues:[],status:'needs_transcript',mediaBlob:file};$('material-status').textContent='本地素材已选择。请补充你想讨论的片段英文内容。';renderMaterial();});
  for(const id of ['segment-start','segment-end'])$(id).addEventListener('input',()=>{if(material){material.selectedStart=Number($('segment-start').value);material.selectedEnd=Number($('segment-end').value);}updateReadiness();});
  $('play-segment').addEventListener('click',async()=>{try{const s=segment();media.currentTime=s.start;await media.play();}catch{tell('暂时无法播放所选片段，请确认音视频已加载。');}});
  function parseSubtitles(text){
    text=text.replace(/^\uFEFF/,'').trim();const cues=[];
    const seconds=s=>{const p=s.replace(',','.').split(':').map(Number);return p.reduce((total,v)=>total*60+v,0);};
    for(const block of text.split(/\r?\n\s*\r?\n/)){const lines=block.split(/\r?\n/),i=lines.findIndex(line=>line.includes('-->'));if(i<0)continue;const match=lines[i].match(/([\d:. ,]+)\s*-->\s*([\d:.,]+)/);if(!match)continue;const start=seconds(match[1].trim()),end=seconds(match[2].trim()),body=lines.slice(i+1).join(' ').replace(/<[^>]*>/g,'').trim();if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&body)cues.push({start,end,text:body});}
    if(cues.length)return {cues,kind:'manual_timed'};if(text.length>12000)throw new Error('无时间轴的片段文本请控制在 12000 字符内，内容尚未替换。');const s=segment();return {cues:[{start:s.start,end:s.end,text}],kind:'manual_selected_segment'};
  }
  function applyTranscript(){if(!material)return;const text=$('transcript-input').value.trim();if(!text){tell('请先填入英文内容。');return;}try{const parsed=parseSubtitles(text);material.cues=parsed.cues;material.transcriptKind=parsed.kind;material.status='ready';renderCues($('english-cues'),material.cues,'text');$('chinese-cues').replaceChildren();$('chinese-status').textContent='英文内容已更正，可重新生成中文字幕。';updateReadiness();tell(parsed.kind==='manual_selected_segment'?'已使用所选片段文本；这份文本没有逐句时间轴。':'带时间轴的英文字幕已载入。');}catch(error){tell(error.message);}}
  $('apply-transcript').addEventListener('click',applyTranscript);
  $('subtitle-file').addEventListener('change',async()=>{const file=$('subtitle-file').files?.[0];if(!file)return;if(file.size>1000000){tell('字幕文件过大，请使用所选片段的字幕。');return;}$('transcript-input').value=await file.text();applyTranscript();});
  $('translate-material').addEventListener('click',async()=>{
    if(!modelConfig?.text){returnPage='listen';navigate('settings');tell('先填写文字复盘服务，再按需生成中文字幕。');return;}
    const button=$('translate-material');button.disabled=true;
    try{const s=segment();if(!s.cues.length)throw new Error('请先准备英文字幕。');if(s.cues.length>200||s.text.length>12000)throw new Error('请缩短片段，单次翻译最多 200 条字幕、12000 个英文字符。');$('chinese-status').textContent='正在生成所选片段的中文字幕…';const result=await api('/api/translate',{...modelConfig.text,cues:s.cues});const translated=result.cues;for(const cue of material.cues){const match=translated.find(x=>x.start===cue.start&&x.end===cue.end&&x.text===cue.text);if(match)cue.zh=match.zh;}renderCues($('chinese-cues'),translated,'zh');$('chinese-status').textContent='中文由 AI 翻译，英文仍是理解依据。';}catch(error){$('chinese-status').textContent=error.message;}finally{button.disabled=false;}
  });
  function topics(){return [...TOPICS,...customTopics];}
  function renderTopic(){
    $('topic-title').textContent=selectedTopic.title;$('topic-prompt').textContent=selectedTopic.prompt;$('topic-bullets').replaceChildren(...selectedTopic.bullets.map(text=>node('li',null,text)));$('topic-origin').textContent=TOPICS.some(t=>t.id===selectedTopic.id)?'原创练习题卡 · 非当季真题':'自己的练习题卡';$('delete-custom-topic').hidden=!customTopics.some(t=>t.id===selectedTopic.id);
    const category=$('topic-category').value;const list=topics().filter(t=>category==='all'||t.category===category);$('topic-list').replaceChildren();for(const topic of list){const button=node('button','topic-choice',`${topic.category} / ${topic.title}`);button.setAttribute('aria-pressed',String(topic.id===selectedTopic.id));button.addEventListener('click',()=>{selectedTopic=topic;clock.finish();$('part2-stage').textContent='选择题卡，准备开始';$('part2-timer').textContent='01:00';$('prepare-part2').hidden=false;$('begin-part2-answer').hidden=true;renderTopic();});$('topic-list').append(button);}
  }
  function renderCategories(){const select=$('topic-category');select.replaceChildren();for(const category of ['all',...new Set(topics().map(t=>t.category))]){const option=node('option',null,category==='all'?'全部题材':category);option.value=category;select.append(option);}}
  $('topic-category').addEventListener('change',renderTopic);$('random-topic').addEventListener('click',()=>{const values=topics().filter(t=>$('topic-category').value==='all'||t.category===$('topic-category').value);selectedTopic=values[Math.floor(Math.random()*values.length)]||TOPICS[0];clock.finish();$('prepare-part2').hidden=false;$('begin-part2-answer').hidden=true;renderTopic();});
  $('show-custom-topic').addEventListener('click',()=>{$('custom-topic-form').hidden=!$('custom-topic-form').hidden;});
  $('save-custom-topic').addEventListener('click',()=>{if(customTopics.length>=100){tell('自添题卡最多 100 张，请先选择并删除不需要的自添题卡。');return;}const title=$('custom-title').value.trim(),prompt=$('custom-prompt').value.trim(),bullets=$('custom-bullets').value.split('\n').map(s=>s.trim()).filter(Boolean);if(bullets.length>6||bullets.some(text=>text.length>500)){tell('提示点最多 6 条，每条请控制在 500 字符以内。');return;}if(!title||!prompt||!bullets.length){tell('请填写题目名称、英文题干和至少一个提示点。');return;}const topic={id:crypto.randomUUID(),category:'自添',title,prompt,bullets,custom:true};try{const next=[...customTopics,topic];window.localStorage.setItem('afterword-topics-v1',JSON.stringify(next));customTopics=next;selectedTopic=topic;renderCategories();renderTopic();$('custom-topic-form').hidden=true;tell('题卡已保存在当前浏览器。');}catch{tell('题卡暂未保存，请检查浏览器存储空间。');}});
  $('delete-custom-topic').addEventListener('click',()=>{
    if(!customTopics.some(topic=>topic.id===selectedTopic.id)||!window.confirm('删除这张自添题卡？已保存练习中的题卡会保留。'))return;
    try{const next=customTopics.filter(topic=>topic.id!==selectedTopic.id);window.localStorage.setItem('afterword-topics-v1',JSON.stringify(next));customTopics=next;selectedTopic=TOPICS[0];clock.finish();$('prepare-part2').hidden=false;$('begin-part2-answer').hidden=true;$('part2-timer').textContent='01:00';$('part2-stage').textContent='选择题卡，准备开始';renderCategories();renderTopic();tell('题卡已删除，已保存练习不受影响。');}catch{tell('题卡删除失败，原有题卡保留。');}
  });
  $('prepare-part2').addEventListener('click',()=>{clock.prepare();$('part2-stage').textContent='准备中，写几个自己的提示词';$('prepare-part2').hidden=true;$('begin-part2-answer').hidden=false;$('begin-part2-answer').textContent='提前开始独立作答';});
  function format(seconds){seconds=Math.max(0,Math.ceil(seconds));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  const ticker=window.setInterval(()=>{if(disposed)return;const value=clock.tick();if(value.phase==='preparing'){$('part2-timer').textContent=format(value.remainingMs/1000);if(!value.remainingMs){$('part2-stage').textContent='准备时间结束，准备好就开始';$('begin-part2-answer').textContent='开始独立作答';}}if(value.phase==='answering'&&page==='practice')$('practice-stage').textContent=`独立作答 ${format(value.remainingMs/1000)}`;},250);
  function ensureService(mode){if(modelConfig)return true;returnPage=mode==='part2'?'part2':'listen';navigate('settings');tell('先保存自己的语音服务配置，再开始练习。');return false;}
  async function startPractice(mode,relatedPracticeId){
    if(disposed||!ensureService(mode))return;if(busy())return;launching=true;
    try{
      if(call){await call.dispose();call=null;}if(disposed)return;
      const timestamp=new Date().toISOString();let selected,sourceText='';if(mode==='material'){selected=segment();if(!selected.text||selected.text.length>12000)throw new Error('请准备 12000 字符以内的所选片段英文内容。');sourceText=selected.text;media?.pause();}
      currentPractice={id:crypto.randomUUID(),mode,title:mode==='material'?material.title:selectedTopic.title,createdAt:timestamp,updatedAt:timestamp,status:'active',turns:[],review:null,relatedPracticeId:relatedPracticeId||pendingRelatedId,
        ...(mode==='material'?{material:{...material,selectedStart:selected.start,selectedEnd:selected.end,selectedText:sourceText}}:{topic:{...selectedTopic},notes:$('part2-notes').value})};
      await store.putPractice(currentPractice);if(disposed)return;pendingRelatedId=null;$('save-status').textContent='已保存';
      const reviewItems=mode==='material'?await store.getReviewContext():[];if(disposed)return;
      const livePractice={...currentPractice,sourceText,reviewItems},practiceId=currentPractice.id;answerClockStarted=false;clock.finish();renderPractice(currentPractice,false);navigate('practice');
      call=callFactory({config:{...modelConfig},practice:livePractice,onSnapshot:value=>{if(currentPractice?.id===practiceId&&!deletedIds.has(practiceId))saveSnapshot(value);},onEvent:event=>{if(currentPractice?.id!==practiceId||deletedIds.has(practiceId)||disposed)return;
        if(event.type==='state')renderCallState(event);
        if(event.type==='review.error'){$('feedback-state').textContent='未完成';$('feedback-content').replaceChildren(node('p','feedback-note',event.message||'文字复盘未完成，原音和记录保留。'));}
      }});await call.start();
    }catch(error){tell(error.message||'练习暂未开始，请检查存储与服务配置。');}finally{launching=false;}
  }
  $('start-listening-call').addEventListener('click',()=>void startPractice('material'));$('begin-part2-answer').addEventListener('click',()=>void startPractice('part2'));
  function saveSnapshot(value){
    if(!currentPractice||disposed||deletedIds.has(currentPractice.id))return;currentPractice={...currentPractice,...value,updatedAt:new Date().toISOString()};const saved=currentPractice;
    renderConversation(value.turns);if(value.review)renderFeedback(value.review);$('save-status').textContent='保存中…';
    saveQueue=saveQueue.catch(()=>{}).then(()=>deletedIds.has(saved.id)?undefined:store.putPractice(saved)).then(()=>{if(!disposed)$('save-status').textContent='已保存';}).catch(()=>{if(!disposed){$('save-status').textContent='保存失败';tell('本机保存失败，当前页面内容仍保留。请先回听或下载原音，检查浏览器空间。');}});
  }
  function renderPractice(record,readonly){
    $('practice-title').textContent=record.title;$('practice-mode').textContent=record.mode==='part2'?'雅思 Part 2':'听后聊';$('part2-pinned').hidden=record.mode!=='part2';$('practice-material').hidden=record.mode!=='material';
    if(record.mode==='part2'){$('part2-pinned').replaceChildren(node('strong',null,record.topic?.prompt||record.title),node('p',null,(record.topic?.bullets||[]).join(' · ')),node('p','helper',`自己的笔记：${record.notes||'未填写'}`));}
    else{$('practice-material-copy').replaceChildren(node('p','helper',`${format(record.material?.selectedStart||0)}–${format(record.material?.selectedEnd||0)}`),node('p',null,record.material?.selectedText||''));$('practice-media').replaceChildren();if(record.material?.mediaBlob||record.material?.mediaUrl){const player=document.createElement(record.material.kind==='video'?'video':'audio');player.controls=true;player.preload='none';player.src=record.material.mediaBlob?audioURL(record.material.mediaBlob):record.material.mediaUrl;player.currentTime=record.material.selectedStart||0;player.addEventListener('play',()=>{if(!readonly&&call&&!call.state.ended){if(call.state.playing||['responding','waiting'].includes(call.state.stage)){player.pause();tell('等 AI 回应结束后再回听素材，避免声音重叠。');return;}call.pause();tell('已暂停收音，听完后点“继续收音”回到聊天。');}});player.addEventListener('timeupdate',()=>{if(player.currentTime>=(record.material.selectedEnd||Infinity))player.pause();});$('practice-media').append(player);}}
    renderConversation(record.turns||[],readonly);$('feedback-state').textContent=record.review?'已完成':'尚未开始';$('feedback-content').replaceChildren(node('p','empty',readonly?'这次没有生成可用的文字复盘，原音与文字仍可回看。':'可以主动语音复盘，或在结束后等待文字版。'));if(record.review)renderFeedback(record.review);
    $('practice-finished').hidden=!readonly;$('return-to-material').hidden=!readonly||record.mode!=='material';for(const id of ['finish-independent','pause-call','resume-call','voice-review','back-to-chat','end-call'])$(id).hidden=true;
    if(readonly){$('live-status').textContent='练习记录';$('live-detail').textContent='浏览记录不会调用模型。';$('practice-stage').textContent=record.status==='complete'?'已结束':'未完整结束';$('call-indicator').classList.remove('live');}
  }
  function renderConversation(turns,readonly=call?.state.ended!==false){
    const host=$('conversation'),nearBottom=host.scrollHeight-host.scrollTop-host.clientHeight<100,oldTop=host.scrollTop;host.replaceChildren();
    for(const turn of turns){
      const item=node('article',`message ${turn.role==='assistant'?'assistant':'user'}`);item.id=`saved-${turn.id}`;item.append(node('p','who',turn.role==='assistant'?'AI':turn.phase==='independent'?'独立作答':turn.phase==='review'?'复盘短练 · 有提示':'我的原话'));
      const text=turn.text||'识别尚未完成，已记录的原音仍可回听。';if(text.length>450){const details=document.createElement('details');details.append(node('summary',null,text.slice(0,130)+'… 展开全文'),node('p',null,text));item.append(details);}else item.append(node('p',null,text));
      if(turn.incomplete)item.append(node('p','helper','这段未完整提交或识别，不能当作完整表现。'));
      if(turn.audio?.size){if(readonly){const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=audioURL(turn.audio);item.append(audio);const a=node('a','helper','下载原音');a.href=audio.src;a.download=`practice-${turn.id}.wav`;item.append(a);}else item.append(node('p','helper','结束后可回听与下载原音。'));}
      host.append(item);
    }
    if(readonly&&currentPractice?.independentAudio?.size&&!turns.some(t=>t.phase==='independent'&&t.audio?.size)){const item=node('article','message user');item.append(node('p','who','独立作答原音 · 转写未完成'));const audio=document.createElement('audio');audio.controls=true;audio.src=audioURL(currentPractice.independentAudio);item.append(audio);const download=node('a','helper','下载独立作答原音');download.href=audio.src;download.download='part2-original.wav';item.append(download);host.append(item);}if(!turns.length&&!host.children.length)host.append(node('p','empty','开口后，这里会出现真实转写和原音。'));host.scrollTop=nearBottom?host.scrollHeight:oldTop;
  }
  function renderFeedback(review){
    $('feedback-state').textContent='已完成';const host=$('feedback-content');host.replaceChildren(node('p','feedback-summary',review.summary));
    const knowledge=review.knowledge;if(knowledge)host.append(node('p','feedback-note',knowledge.status==='matched'?`本次复盘参考了 ${knowledge.retrievedIds?.length||0} 张表达知识卡。`:knowledge.status==='no_match'?'没有匹配知识卡，本次按模型判断复盘。':'知识库暂不可用，本次按模型判断复盘。'));
    if(currentPractice?.mode==='part2'){
      const dimensions=node('div','dimension-list'),labels={lexical:'词汇与搭配',grammar:'语法',organisation:'组织与衔接',pronunciation:'发音',score:'本次参考分'};
      for(const [key,label] of Object.entries(labels)){const value=review.part2Assessment?.[key];const box=node('div');box.append(node('strong',null,label),node('p',null,value?.status==='assessed'?value.feedback:value?.reason||'未评估。文字转写不足以完成该项判断。'));dimensions.append(box);}host.append(dimensions,node('p','feedback-note','语言点评依据转写；原音发音和总参考分尚未评估，不代表正式雅思评价。'));
    }
    for(const item of review.suggestions||[]){
      const card=node('article','suggestion');card.append(node('p','type',item.kind==='optional'?'可选说法 · 原句也可以使用':'明确问题'),node('blockquote',null,item.original),node('p','replacement',item.suggestion));const reason=document.createElement('details');reason.append(node('summary',null,'为什么这样说'),node('p','reason',item.reason));card.append(reason);
      if(item.evidence?.turnId){const locate=node('button','text-button','查看原句');locate.addEventListener('click',()=>{const target=$(`saved-${item.evidence.turnId}`);if(target){for(const detail of target.querySelectorAll('details'))detail.open=true;const scroll=$('conversation');scroll.scrollTop+=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top-8;target.classList.add('highlighted');}});card.append(locate);}
      for(const ref of item.knowledgeSources||[]){const details=document.createElement('details');details.append(node('summary',null,`表达参考：${ref.expression}`),node('p','feedback-note','参考支持相关教学原则，不代表机构认证本次纠错。'));for(const source of ref.sources||[]){try{const u=new URL(source.url);if(u.protocol!=='https:'||u.username||u.password)continue;const p=node('p'),a=node('a',null,source.title);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';p.append(a);details.append(p);}catch{}}card.append(details);}
      host.append(card);
    }
    if(!review.suggestions?.length)host.append(node('p','feedback-note','这次没有明确需要修改的表达，不必为了复杂而重说。'));
  }
  function renderCallState(s){
    if((s.mic||s.ended)&&$('notice').textContent.startsWith('已暂停收音'))tell('');
    $('live-status').textContent=s.message;$('live-detail').textContent=s.mic?(s.stage==='answering'?'麦克风开启 · 独立作答':'麦克风开启 · 开口后自动上传'):'麦克风已停止或尚未开启';$('call-indicator').classList.toggle('live',s.mic||s.playing);
    if(s.stage==='answering'&&!answerClockStarted){clock.answer();answerClockStarted=true;}if(s.answerSubmitted)clock.finish();
    if(s.stage!=='answering')$('practice-stage').textContent=s.ended?'通话已结束':s.phase==='review'?'语音复盘':s.answerSubmitted?`短追问 ${Math.min(2,s.followups+1)} / 2`:s.connecting?'连接中':'实时聊天';
    $('finish-independent').hidden=s.stage!=='answering';$('pause-call').hidden=!s.mic||s.stage==='answering';$('resume-call').hidden=s.ended||!s.ready||s.mic||s.stage==='answering'||s.reviewPending;
    $('voice-review').hidden=s.ended||!modelConfig?.text||Boolean(s.review)||s.phase==='review';$('voice-review').disabled=!s.canReview;
    $('back-to-chat').hidden=s.ended||s.phase!=='review';$('back-to-chat').disabled=s.playing;$('end-call').hidden=s.ended||!s.connecting&&!s.ready;$('end-call').textContent=s.connecting?'取消连接':'结束并查看复盘';
    if(s.reviewPending)$('feedback-state').textContent='整理中';if(s.ended){$('practice-finished').hidden=false;if(!s.review&&!s.reviewPending){const host=$('feedback-content');if(!host.querySelector('[data-pending-note]')){const note=node('p','feedback-note',modelConfig?.text?'复盘尚未完成或不可用，已有记录保留。':'本次未配置文字复盘服务，原音和文字保留。');note.dataset.pendingNote='true';host.append(note);}}renderConversation(currentPractice?.turns||[],true);}
  }
  $('finish-independent').addEventListener('click',()=>void call?.finishAnswer());$('pause-call').addEventListener('click',()=>call?.pause());$('resume-call').addEventListener('click',()=>void call?.resume());$('voice-review').addEventListener('click',()=>call?.requestReview());$('back-to-chat').addEventListener('click',()=>call?.resumeChat());$('end-call').addEventListener('click',()=>call?.end());$('follow-new').addEventListener('click',()=>{$('conversation').scrollTop=$('conversation').scrollHeight;});
  $('return-to-material').addEventListener('click',()=>{if(currentPractice?.material){material=currentPractice.material;navigate('listen');}});
  $('practice-again').addEventListener('click',()=>{if(!currentPractice)return;const previous=currentPractice;pendingRelatedId=previous.id;if(previous.mode==='part2'){selectedTopic=previous.topic;$('part2-notes').value='';navigate('part2');tell('同题重练会建立新记录，不覆盖这次作答。');}else{material=previous.material;navigate('listen');}});
  async function openPractice(id){
    if(disposed||busy()){tell('先结束当前练习。');return;}
    const read=++historyRead;await saveQueue;if(disposed||busy()||read!==historyRead)return;
    let record;try{record=await store.getPractice(id);}catch{tell('暂时无法读取这次记录，请重试。');return;}
    if(!record||disposed||busy()||read!==historyRead||deletedIds.has(id))return;
    launching=true;try{if(call){await call.dispose();call=null;}if(disposed)return;currentPractice=record;renderPractice(record,true);navigate('practice');}finally{launching=false;}
  }
  function practiceCard(record,canDelete){const card=node('article','record-card'),info=node('div');info.append(node('p',null,`${record.mode==='part2'?'雅思 Part 2':'听后聊'} · ${new Date(record.createdAt).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`),node('h3',null,record.title),node('p',null,record.review?'已有复盘':record.status==='complete'?'已结束 · 无可用复盘':'尚未完整结束'));const actions=node('div','record-actions'),open=node('button','secondary','查看记录');open.addEventListener('click',()=>void openPractice(record.id));actions.append(open);if(canDelete){const del=node('button','text-button','删除');del.addEventListener('click',async()=>{if(busy()){tell('当前练习或备份操作尚未结束，请稍后删除。');return;}if(!window.confirm('删除这次练习、原音和相关复习项？'))return;try{mutatingHistory=true;deletedIds.add(record.id);if(currentPractice?.id===record.id&&call){await call.dispose();call=null;}await saveQueue;await store.deletePractice(record.id);await refreshLists();mutatingHistory=false;}catch{deletedIds.delete(record.id);mutatingHistory=false;tell('删除失败，请重试。');}});actions.append(del);}card.append(info,actions);return card;}
  async function refreshLists(){
    try{const records=await store.listPractices();$('recent-list').replaceChildren(...records.slice(0,3).map(r=>practiceCard(r,false)));$('history-list').replaceChildren(...records.map(r=>practiceCard(r,true)));if(!records.length){$('recent-list').append(node('p','empty','还没有练习记录。从上面的一个入口开始。'));$('history-list').append(node('p','empty','还没有练习记录。完成的话轮和原音会自动保存在这里。'));}
      const items=await store.listReviewItems();$('review-item-list').replaceChildren();for(const item of items){const box=node('article',`review-item ${item.status==='stopped'?'stopped':''}`);box.append(node('span','tag',item.status==='stopped'?'已停止安排':'可在合适话题中复习'),node('h2',null,item.suggestion),node('p',null,`原话：${item.original}`),node('p',null,item.reason));const toggle=node('button','secondary',item.status==='stopped'?'恢复安排':'不用再练'),del=node('button','text-button','删除');toggle.addEventListener('click',async()=>{try{await saveQueue;await store.setReviewStatus(item.id,item.status==='stopped'?'active':'stopped');await refreshLists();}catch{tell('复习安排暂未保存，请重试。');}});del.addEventListener('click',async()=>{try{await saveQueue;await store.deleteReviewItem(item.id);await refreshLists();}catch{tell('复习项删除失败，请重试。');}});box.append(toggle,del);$('review-item-list').append(box);}if(!items.length)$('review-item-list').append(node('p','empty','有了真实复盘建议后，值得再练的表达会自动出现在这里。'));
    }catch{$('save-status').textContent='本机存储不可用';tell('暂时无法读取本机记录。请允许当前站点使用浏览器存储。');}
  }
  $('clear-history').addEventListener('click',async()=>{if(busy()){tell('当前练习或备份操作尚未结束，请稍后清空。');return;}if(!window.confirm('清空本机全部练习、原音和复习项？此操作无法恢复。'))return;try{mutatingHistory=true;for(const record of await store.listPractices())deletedIds.add(record.id);if(currentPractice)deletedIds.add(currentPractice.id);if(call){await call.dispose();call=null;}await saveQueue;await store.clear();await refreshLists();}catch{tell('清空失败，请重试。');}finally{mutatingHistory=false;}});
  async function withBackup(action,kind='import'){
    if(disposed)return;
    if(busy()||call?.state.reviewPending){$('backup-status').textContent='请先结束通话，并等复盘整理完成后再备份或导入。';return;}
    mutatingHistory=true;$('export-backup').disabled=true;$('backup-file').disabled=true;
    try{await saveQueue;if(disposed)return;await action();}
    catch(error){if(!disposed)$('backup-status').textContent=error instanceof RangeError?(kind==='export'?'本机记录超过备份容量上限，未生成备份文件。':'备份超过容量或数量上限，未导入任何练习。'):error instanceof TypeError?(kind==='export'?'部分记录不符合备份格式，未生成备份文件。已有记录保留。':'备份文件格式不正确或内容已损坏，未导入任何练习。'):'操作未完成，请检查浏览器存储空间后重试。';}
    finally{mutatingHistory=false;if(!disposed){$('export-backup').disabled=false;$('backup-file').disabled=false;$('backup-file').value='';}}
  }
  $('export-backup').addEventListener('click',()=>withBackup(async()=>{
    $('backup-status').textContent='正在整理本机记录与原音…';
    const data=await store.exportData();if(disposed)return;
    const result=await encodeBackup({data,topics:customTopics});if(disposed)return;
    const anchor=$('backup-download');if(anchor.href&&urls.has(anchor.href)){URL.revokeObjectURL(anchor.href);urls.delete(anchor.href);}
    const url=URL.createObjectURL(result.blob);urls.add(url);anchor.href=url;anchor.download=result.filename;anchor.click();
    $('backup-status').textContent=`已导出 ${result.counts.practices} 次练习、${result.counts.topics} 张自添题卡。备份含原音与私人内容，请妥善保存。`;
  },'export'));
  $('backup-file').addEventListener('change',()=>{
    const file=$('backup-file').files?.[0];if(!file)return;
    return withBackup(async()=>{
      $('backup-status').textContent='正在校验备份，已有记录会保留…';
      const value=await decodeBackup(file);if(disposed)return;
      const byId=new Map(customTopics.map(topic=>[topic.id,topic]));let addedTopics=0,omittedTopics=0;
      for(const topic of value.topics){if(byId.has(topic.id))continue;if(byId.size>=100){omittedTopics++;continue;}byId.set(topic.id,{...topic,custom:true,category:topic.category||'自添'});addedTopics++;}
      const mergedTopics=[...byId.values()];
      const previous=call;call=null;currentPractice=null;historyRead++;if(previous)await previous.dispose();await saveQueue;if(disposed)return;
      const result=await store.importData(value.data);if(disposed)return;
      for(const record of value.data.practices)deletedIds.delete(record.id);
      let topicFailure=false;try{window.localStorage.setItem('afterword-topics-v1',JSON.stringify(mergedTopics));customTopics=mergedTopics;renderCategories();renderTopic();}catch{topicFailure=true;}
      await refreshLists();if(disposed)return;
      $('backup-status').textContent=`已导入 ${result.imported} 次练习，保留 ${result.skipped} 次同 ID 本机记录。`+(topicFailure?'练习已保存，但自添题卡保存失败，请检查存储空间后重新导入。':`新增 ${addedTopics} 张题卡。`)+(omittedTopics?`题卡已达 100 张，另有 ${omittedTopics} 张未添加。`:'');
    });
  });
  function authFields(){$('new-auth').hidden=$('voice-auth').value!=='api-key';$('old-auth').hidden=!$('new-auth').hidden;}
  $('voice-auth').addEventListener('change',()=>{$('mvp-voice-key').value='';$('mvp-access-token').value='';authFields();});$('enable-feedback').addEventListener('change',()=>{$('feedback-config').hidden=!$('enable-feedback').checked;});
  function clearSecretFields(){for(const id of ['mvp-voice-key','mvp-access-token','mvp-text-key'])$(id).value='';}
  $('service-form').addEventListener('submit',event=>{event.preventDefault();const authType=$('voice-auth').value,previous=modelConfig?.authType===authType?modelConfig:null;const config=authType==='api-key'?{authType,apiKey:$('mvp-voice-key').value.trim()||previous?.apiKey}:{authType,appId:$('mvp-app-id').value.trim(),accessToken:$('mvp-access-token').value.trim()||previous?.accessToken};if(authType==='api-key'?!config.apiKey:!config.appId||!config.accessToken){$('service-status').textContent='请填完整所选语音鉴权信息。';return;}if($('enable-feedback').checked){const workspace=$('mvp-workspace').value.trim(),apiKey=$('mvp-text-key').value.trim()||modelConfig?.text?.apiKey;if(!workspace||!apiKey){$('service-status').textContent='请填写文字服务的 Workspace／Base URL 和 Key，或关闭文字复盘。';return;}config.text={workspace,apiKey};}config.replyWait=Number($('mvp-reply-wait').value);modelConfig=config;clearSecretFields();$('service-short').textContent=config.text?'语音与复盘已填写':'仅语音已填写';$('service-status').textContent='已保留在当前页面内存，尚未发起模型调用。';navigate(returnPage);tell('配置已保存到当前页面，准备好后可以开始练习。');});
  $('forget-service').addEventListener('click',()=>{modelConfig=null;clearSecretFields();$('service-short').textContent='尚未配置';$('service-status').textContent='当前凭据已清除，练习历史保留。';});
  function dispose(){if(disposed)return;void call?.dispose();disposed=true;window.clearInterval(ticker);clearSecretFields();modelConfig=null;for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
  window.addEventListener('pagehide',dispose);authFields();renderCategories();renderTopic();void refreshLists();
  return {navigate,store,openPractice,get currentPractice(){return currentPractice;},dispose};
}
if(globalThis.document)initProductApp();
