import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('coach page exposes one continuous-call path, explicit microphone controls and retained evidence',async()=>{
  let html='',app='';
  try{html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');app=await readFile(new URL('../public/coach-app.mjs',import.meta.url),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const id of ['start','pause','review','resume-chat','end','transcripts','report'])assert.match(html,new RegExp(`id="${id}"`));
  assert.doesNotMatch(html,/发送这段录音|手动录音|onclick=|<script(?![^>]*src=)/);
  assert.match(html,/本次记录仅在当前页面/);
  assert.doesNotMatch(app,/localStorage|sessionStorage|document\.cookie|console\.|getUserMedia/);
  assert.match(app,/createCapture/);assert.match(app,/createTurnDetector/);assert.match(app,/capture\.stop/);assert.match(app,/playback\.stop/);
});

test('authentication form defaults to API Key with labelled, separate legacy fields',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  assert.match(html,/<label\b[^>]*for="auth-type"[^>]*>语音鉴权方式<\/label>/);
  const select=html.match(/<select\b[^>]*id="auth-type"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);assert.match(select,/<option\b[^>]*value="api-key"[^>]*selected[^>]*>/);assert.match(select,/<option\b[^>]*value="legacy"[^>]*>/);
  assert.match(html,/<div\b[^>]*id="api-key-fields"[^>]*aria-label="[^"]+"[^>]*>/);
  assert.match(html,/<input\b[^>]*id="voice-key"[^>]*type="password"[^>]*autocomplete="off"[^>]*maxlength="2048"/);
  assert.match(html,/<label\b[^>]*for="voice-key"[^>]*>豆包语音 API Key<\/label>/);
  assert.match(html,/<div\b[^>]*id="legacy-fields"[^>]*aria-label="[^"]+"[^>]*hidden[^>]*>[\s\S]*?id="app-id"[\s\S]*?id="access-token"[\s\S]*?<\/div>/);
  assert.match(html,/<label\b[^>]*for="text-key"[^>]*>百炼文字 API Key<\/label>/);
  assert.match(html,/调用由你的账户承担/);assert.doesNotMatch(html,/value="(?:FAKE|NOT_A_KEY|sk-)/);
});
test('authentication select keeps the existing form styling and keyboard focus treatment',async()=>{
  const css=await readFile(new URL('../public/coach.css',import.meta.url),'utf8');
  assert.match(css,/select:focus-visible/);assert.match(css,/input,select\{/);
  assert.match(css,/--sage:#8B9D83/);assert.match(css,/--sand:#E8DCC7/);
});

test('connection feedback describes its button while the persistent top status owns the only live announcement',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  assert.match(html,/<div\b[^>]*class="connection-feedback">\s*<button\b[^>]*id="start"[^>]*aria-describedby="connection-status"[^>]*>[\s\S]*?<\/button>\s*<p\b[^>]*id="connection-status"[^>]*>/);
  assert.equal([...html.matchAll(/aria-live="polite"/g)].length,1);
  assert.equal([...html.matchAll(/role="status"/g)].length,1);
  const topStatus=html.match(/<div\b[^>]*id="status"[^>]*>/)?.[0];assert.ok(topStatus);
  assert.match(topStatus,/role="status"/);assert.match(topStatus,/aria-live="polite"/);assert.match(topStatus,/aria-atomic="true"/);
  const connectionStatus=html.match(/<p\b[^>]*id="connection-status"[^>]*>/)?.[0];assert.ok(connectionStatus);assert.doesNotMatch(connectionStatus,/role="status"|aria-live=|aria-atomic=/);
});

test('credential handling copy explains retry retention and success or page exit cleanup',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  assert.match(html,/连接失败.*保留.*本页/);assert.match(html,/连接成功或离开页面.*清空.*密钥/);
  assert.match(html,/凭据不持久保存/);assert.match(html,/不自动重连/);assert.doesNotMatch(html,/点击连接后清空密钥输入框/);
});

test('reply wait offers a natural default and longer thinking pauses without promising response latency',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  assert.match(html,/<label\b[^>]*for="reply-wait"[^>]*>接话等待<\/label>/);
  const select=html.match(/<select\b[^>]*id="reply-wait"[^>]*>([\s\S]*?)<\/select>/)?.[1];assert.ok(select);
  assert.match(select,/<option\b[^>]*value="1500"[^>]*selected[^>]*>自然接话.*1\.5 秒/);
  assert.match(select,/<option\b[^>]*value="3000"[^>]*>留出思考.*3 秒/);assert.match(select,/<option\b[^>]*value="5000"[^>]*>更久.*5 秒/);
  assert.match(html,/停顿等待/);assert.match(html,/服务处理和网络/);assert.doesNotMatch(html,/停顿约 5 秒后 AI 接话/);
});

test('two accessible view tabs share one evidence workspace and one retained record list',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length);
  for(const id of ['call-tab','review-tab'])assert.match(html,new RegExp(`<button\\b[^>]*id="${id}"[^>]*role="tab"[^>]*aria-controls="practice-workspace"`));
  assert.match(html,/<div\b[^>]*role="tablist"[^>]*aria-label="[^\"]+"/);
  assert.match(html,/<div\b[^>]*id="practice-workspace"[^>]*role="tabpanel"[^>]*aria-labelledby="call-tab"/);
  assert.equal(ids.filter(id=>id==='transcripts').length,1);assert.equal(ids.filter(id=>id==='report').length,1);
  assert.match(html,/<div\b[^>]*id="transcripts-scroll"[^>]*tabindex="0"[^>]*>/);
  assert.match(html,/<button\b[^>]*id="new-content"[^>]*hidden[^>]*>查看新内容<\/button>/);
});
test('shared call controls precede the view workspace so both presentations retain them',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8'),workspace=html.indexOf('id="practice-workspace"');assert.ok(workspace>0);
  for(const id of ['call-state','call-detail','mic-status','start','pause','end','review','resume-chat'])assert.ok(html.indexOf(`id="${id}"`)<workspace,`${id} stays shared`);
  assert.match(html,/<details\b[^>]*id="connection-settings"[^>]*open[^>]*>/);
});

test('ordinary 720px desktop height keeps a bounded two-column workspace and stacking depends on width',async()=>{
  const css=await readFile(new URL('../public/coach.css',import.meta.url),'utf8');
  assert.match(css,/@media\(min-width:981px\) and \(min-height:660px\)\{main\{height:100dvh\}/);
  assert.match(css,/\.workspace\{flex:1;min-height:200px\}/);
  assert.doesNotMatch(css,/@media\(max-width:980px\),\(max-height:/);
  assert.match(css,/@media\(max-width:980px\)\{[\s\S]*?\.workspace,\.workspace\[data-view=review\]\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css,/@media\(min-width:981px\) and \(max-height:659px\)\{\.workspace\{height:\d+px\}/);
});


test('setup runs top to bottom with one primary Begin after optional review and reply wait',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8');
  const position=id=>html.indexOf(`id="${id}"`);
  assert.ok(position('voice-key')<position('workspace'));assert.ok(position('workspace')<position('reply-wait'));assert.ok(position('reply-wait')<position('start'));
  assert.equal([...html.matchAll(/id="start"/g)].length,1);assert.doesNotMatch(html,/id="connect"/);
  assert.match(html,/语音服务（必需）/);assert.match(html,/文字复盘设置（可选/);assert.match(html,/本次仅聊天/);
  for(const id of ['voice-capability','text-capability','voice-error','text-error','startup-actions','session-actions'])assert.ok(position(id)>=0,id);
  assert.match(html,/<button\b[^>]*id="start"[^>]*>开始练习<\/button>/);
});


test('preparation uses one page scroll and keeps cancellation after the setup footer',async()=>{
  const html=await readFile(new URL('../public/coach.html',import.meta.url),'utf8'),css=await readFile(new URL('../public/coach.css',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="start"')<html.indexOf('id="end"'));assert.doesNotMatch(css,/\.settings\[open\]\{[^}]*overflow-y:auto/);
});
