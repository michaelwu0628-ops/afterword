import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const material = await import('../material.mjs').catch(() => ({}));
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body, headers = {}, status = 200) => new Response(body, { status, headers });
const tedURL = 'https://www.ted.com/talks/example_talk';
const mediaURL = 'https://download.ted.com/talks/example.mp4';
function tedPage(data) { return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{videoData:data}}})}</script></html>`; }

test('exports material and translation APIs', () => {
  for (const name of ['resolveMaterial', 'translateCues', 'normalizeCues', 'parseSubtitleText']) assert.equal(typeof material[name], 'function');
});
test('rejects unsupported URL credentials, protocols, ports and host suffix tricks without fetching', async () => {
  let calls = 0;
  for (const url of ['http://www.ted.com/talks/a','https://www.ted.com:8443/talks/a','https://user:pass@www.ted.com/talks/a','https://www.ted.com.evil.test/talks/a','https://127.0.0.1/a.mp3','https://example.com/a.mp3']) {
    await assert.rejects(material.resolveMaterial(url,{lookup:publicLookup,fetchImpl:async()=>{calls++;}}), /MATERIAL_UNSUPPORTED/);
  }
  assert.equal(calls, 0);
});
test('rejects DNS answers containing private, mapped, link local or reserved addresses before fetch', async () => {
  let calls = 0;
  for (const address of ['127.0.0.1','10.2.3.4','172.20.1.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','192.0.2.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) {
    await assert.rejects(material.resolveMaterial(mediaURL,{lookup:async()=>[{address,family:address.includes(':')?6:4}],fetchImpl:async()=>{calls++;}}), /MATERIAL_ADDRESS/);
  }
  assert.equal(calls, 0);
});
test('direct media returns needs_transcript after bounded HEAD check without downloading audio', async () => {
  const methods=[];
  const result=await material.resolveMaterial('https://ondemand.npr.org/anon.npr-mp3/npr/test.mp3',{lookup:publicLookup,fetchImpl:async(url,options)=>{methods.push(options.method);return response(null,{'content-type':'audio/mpeg'});}});
  assert.deepEqual(methods,['HEAD']); assert.equal(result.kind,'audio'); assert.equal(result.status,'needs_transcript'); assert.deepEqual(result.cues,[]); assert.match(result.message,/字幕|transcript/i);
});
test('redirect target is validated before another request and rejects unsupported redirect', async () => {
  let calls=0;
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async()=>{calls++;return response(null,{location:'https://127.0.0.1/private'},302);}}), /MATERIAL_UNSUPPORTED/);
  assert.equal(calls,1);
});
test('redirect loop is bounded', async () => {
  let calls=0;
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async()=>{calls++;return response(null,{location:tedURL},302);}}), /MATERIAL_REDIRECT/);
  assert.equal(calls,4);
});
test('metadata content length and streaming bytes are bounded', async () => {
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async()=>response('x',{'content-length':'99999999'})}), /MATERIAL_SIZE/);
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async()=>response('x'.repeat(2097153))}), /MATERIAL_SIZE/);
});
test('fetch and DNS have a total deadline even when injected operations ignore abort', async () => {
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,timeoutMs:20,fetchImpl:async()=>new Promise(()=>{})}), /MATERIAL_TIMEOUT/);
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:async()=>new Promise(()=>{}),timeoutMs:20,fetchImpl:async()=>{throw Error('unexpected');}}), /MATERIAL_TIMEOUT/);
});
test('TED embedded player data yields actual media and English subtitle cues', async () => {
  const subtitleURL='https://www.ted.com/talks/subtitles/id/123/lang/en';
  const page=tedPage({title:'A public talk',duration:20,playerData:JSON.stringify({resources:{h264:[{file:mediaURL}]},subtitles:[{languageCode:'en',url:subtitleURL}]})});
  const result=await material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async(url,options)=>url===tedURL?response(page):url===subtitleURL?response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there.\n\n00:00:03.000 --> 00:00:05.000\nListen carefully.\n'):response(null,{'content-type':'video/mp4'})});
  assert.equal(result.title,'A public talk');assert.equal(result.mediaUrl,mediaURL);assert.equal(result.duration,20);assert.equal(result.status,'ready');assert.deepEqual(result.cues,[{start:1,end:3,text:'Hello there.'},{start:3,end:5,text:'Listen carefully.'}]);
});
test('TED subtitle failure keeps playable material visibly awaiting transcript', async () => {
  const page=tedPage({title:'No transcript',playerData:{resources:{h264:[{file:mediaURL}]}}});
  const result=await material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async(url)=>url===tedURL?response(page):response(null,{'content-type':'video/mp4'})});
  assert.equal(result.status,'needs_transcript'); assert.equal(result.mediaUrl,mediaURL); assert.deepEqual(result.cues,[]);
});
test('untrusted embedded media cannot bypass public host validation', async () => {
  await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async()=>response(tedPage({title:'Bad',playerData:{resources:{h264:[{file:'https://127.0.0.1/private.mp4'}]}}}))}), /MATERIAL_MEDIA|MATERIAL_UNSUPPORTED/);
});
test('NPR RSS maps a requested episode to its enclosure and duration without fabricated transcript', async () => {
  const episode='https://www.npr.org/2026/10/09/nx-s1-123/example';
  const enclosure='https://ondemand.npr.org/anon.npr-mp3/npr/example.mp3';
  const rss=`<rss><channel><item><title>Public &amp; science</title><link>${episode}</link><enclosure url="${enclosure}" type="audio/mpeg"/><itunes:duration>12:09</itunes:duration></item></channel></rss>`;
  const urls=[];
  const result=await material.resolveMaterial(episode,{lookup:publicLookup,fetchImpl:async(url,options)=>{urls.push(url);return options.method==='HEAD'?response(null,{'content-type':'audio/mpeg'}):response(rss);}});
  assert.equal(urls[0],'https://feeds.npr.org/510351/podcast.xml'); assert.equal(result.url,episode); assert.equal(result.mediaUrl,enclosure); assert.equal(result.title,'Public & science'); assert.equal(result.duration,729);assert.equal(result.status,'needs_transcript');
});
test('RSS may expose a public timed English transcript, never downloads full enclosure', async () => {
  const rss='<rss><channel><item><title>Science</title><link>https://www.npr.org/2026/10/09/example</link><enclosure url="https://ondemand.npr.org/anon.npr-mp3/npr/example.mp3" type="audio/mpeg"/><podcast:transcript url="https://www.npr.org/transcripts/example.vtt" type="text/vtt" language="en"/></item></channel></rss>';
  const result=await material.resolveMaterial('https://feeds.npr.org/510351/podcast.xml',{lookup:publicLookup,fetchImpl:async(url,options)=>options.method==='HEAD'?response(null,{'content-type':'audio/mpeg'}):response(url.includes('.vtt')?'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nReal transcript.':rss)});
  assert.equal(result.status,'ready'); assert.equal(result.cues[0].text,'Real transcript.');
});
test('subtitle parser accepts VTT/SRT, strips markup and rejects unbounded or invalid time data', () => {
  assert.deepEqual(material.parseSubtitleText('1\n00:00:01,200 --> 00:00:02,500\n<b>Hello</b> &amp; goodbye.'),[{start:1.2,end:2.5,text:'Hello & goodbye.'}]);
  assert.throws(()=>material.normalizeCues([{start:2,end:1,text:'bad'}]),/MATERIAL_CUES/);
  assert.throws(()=>material.normalizeCues([{start:0,end:2,text:'x'.repeat(12001)}]),/MATERIAL_CUES/);
});
test('translation uses fixed workspace endpoint and keeps trusted time and English indices', async () => {
  const cues=[{start:1,end:2,text:'Hello'},{start:2,end:4,text:'Thank you'}]; let captured;
  const result=await material.translateCues({workspace:'demo-workspace',apiKey:'mock-key',cues,fetchImpl:async(url,options)=>{captured={url,options};return response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:[{index:1,zh:'谢谢'},{index:0,zh:'你好'}]})}}]}));}});
  assert.equal(captured.url,'https://demo-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  const body=JSON.parse(captured.options.body);assert.equal(body.model,'qwen-plus');assert.equal(body.response_format.type,'json_object');assert.equal(captured.options.redirect,'error');
  assert.deepEqual(result,[{...cues[0],zh:'你好'},{...cues[1],zh:'谢谢'}]);
});
test('translation rejects invalid credentials and bounds before vendor request', async () => {
  let calls=0;const fetchImpl=async()=>{calls++;};
  await assert.rejects(material.translateCues({workspace:'https://evil.test',apiKey:'mock',cues:[{start:0,end:1,text:'Hi'}],fetchImpl}),/INVALID_WORKSPACE/);
  for(const cues of [[],Array.from({length:201},(_,i)=>({start:i,end:i+1,text:'a'})),[{start:0,end:1,text:'a'.repeat(12001)}]]) await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl}),/TRANSLATION_INPUT/);
  await assert.rejects(material.translateCues({workspace:'demo',apiKey:'key\nsecret',cues:[{start:0,end:1,text:'Hi'}],fetchImpl}),/TRANSLATION_CREDENTIALS/); assert.equal(calls,0);
});
test('translation refuses missing, duplicate, forged or empty indexed output', async () => {
  const cues=[{start:0,end:1,text:'Hello'},{start:1,end:2,text:'Bye'}];
  for(const translations of [[{index:0,zh:'你好'}],[{index:0,zh:'你好'},{index:0,zh:'再见'}],[{index:0,zh:'你好'},{index:9,zh:'再见'}],[{index:0,zh:'你好'},{index:1,zh:''}]]) await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl:async()=>response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations})}}]}))}),/TRANSLATION_INVALID/);
});
test('translation bounds response body and aborts ignored injected fetch', async () => {
  const cues=[{start:0,end:1,text:'Hello'}];
  await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl:async()=>response('x'.repeat(131073))}),/TRANSLATION_INVALID/);
  const controller=new AbortController(); const pending=material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl:async()=>new Promise(()=>{}),signal:controller.signal});controller.abort();await assert.rejects(pending,/TRANSLATION_ABORTED/);
});

test('NPR episode falls back from an unmatched feed to official HTML audio metadata', async () => {
  const episode='https://www.npr.org/2026/10/09/example-story';
  const audio='https://ondemand.npr.org/anon.npr-mp3/npr/story.mp3';
  const requests=[];
  const result=await material.resolveMaterial(episode,{lookup:publicLookup,fetchImpl:async(url,options)=>{
    requests.push([url,options.method]);
    if(url.includes('feeds.npr.org')) return response('<rss><channel></channel></rss>');
    if(options.method==='HEAD') return response(null,{'content-type':'audio/mpeg'});
    return response(`<meta content="A real story" property="og:title"><meta property="og:audio" content="${audio}">`);
  }});
  assert.equal(result.title,'A real story'); assert.equal(result.mediaUrl,audio); assert.equal(result.status,'needs_transcript');
  assert.deepEqual(requests.map(item=>item[1]),['GET','GET','HEAD']);
});
test('official BBC direct audio works but nonmedia pages without an enclosure stay unavailable', async () => {
  const result=await material.resolveMaterial('https://podcastdownload.files.bbci.co.uk/p02pc9tn.mp3',{lookup:publicLookup,fetchImpl:async()=>response(null,{'content-type':'audio/mpeg'})});
  assert.equal(result.kind,'audio'); assert.equal(result.status,'needs_transcript');
  await assert.rejects(material.resolveMaterial('https://www.bbc.co.uk/programmes/example',{lookup:publicLookup,fetchImpl:async()=>response('<title>Programme</title>')}),/MATERIAL_MEDIA/);
});
test('mixed DNS answers and illegal media responses cannot bypass validation', async () => {
  let calls=0;
  await assert.rejects(material.resolveMaterial(mediaURL,{lookup:async()=>[{address:'93.184.216.34',family:4},{address:'::ffff:c0a8:101',family:6}],fetchImpl:async()=>{calls++;}}),/MATERIAL_ADDRESS/);
  assert.equal(calls,0);
  await assert.rejects(material.resolveMaterial(mediaURL,{lookup:publicLookup,fetchImpl:async()=>response(null,{'content-type':'text/html'})}),/MATERIAL_MEDIA/);
});
test('manual cues retain English times, strip markup and reject nonfinite, unsorted or excessive values', () => {
  assert.deepEqual(material.normalizeCues([{start:0,end:1,text:' <i>Hello</i>  there ',zh:' 你好 '}]),[{start:0,end:1,text:'Hello there',zh:'你好'}]);
  for(const cues of [[{start:NaN,end:1,text:'Hello'}],[{start:0,end:Infinity,text:'Hello'}],[{start:4,end:5,text:'b'},{start:0,end:1,text:'a'}],[{start:0,end:86401,text:'Hello'}]]) assert.throws(()=>material.normalizeCues(cues),/MATERIAL_CUES/);
  assert.deepEqual(material.parseSubtitleText('WEBVTT\n\nNOTE comment\nignore\n\ncue\n00:01.000 --> 00:02.000 align:start\nHi.'),[{start:1,end:2,text:'Hi.'}]);
});
test('caller cancellation interrupts unresolved DNS and body reads', async () => {
  for(const options of [
    {lookup:async()=>new Promise(()=>{}),fetchImpl:async()=>{throw Error('unexpected');}},
    {lookup:publicLookup,fetchImpl:async()=>response(new ReadableStream({start(){}}))},
  ]) {
    const controller=new AbortController();
    const pending=material.resolveMaterial(tedURL,{...options,signal:controller.signal});
    controller.abort();
    await assert.rejects(pending,/MATERIAL_ABORTED/);
  }
});
test('translation rejects provider errors, malformed JSON and forged English or timestamps', async () => {
  const cues=[{start:0,end:1,text:'Hello'}];
  for(const body of ['not JSON',JSON.stringify({choices:[{message:{content:'```json\n{}\n```'}}]}),JSON.stringify({choices:[{message:{content:JSON.stringify({translations:[{index:0,zh:'你好',text:'forged',start:900}]})}}]})]) {
    await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl:async()=>response(body)}),/TRANSLATION_INVALID/);
  }
  await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues,fetchImpl:async()=>response('{"message":"mock-key"}',{},401)}),/TRANSLATION_HTTP/);
});
test('TED player page metadata cannot override the actual downloadable resource', async () => {
  const page=`<meta property="og:video" content="https://embed.ted.com/talks/example_talk">${tedPage({title:'Actual resource',playerData:{resources:{h264:[{file:mediaURL}]}},duration:10})}`;
  const result=await material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async(url,options)=>options.method==='HEAD'?response(null,{'content-type':'video/mp4'}):response(page)});
  assert.equal(result.mediaUrl,mediaURL);
});
test('TED JSON captions use numeric milliseconds and malformed captions remain visibly unavailable', async () => {
  for(const [captions,expected] of [[[{startTime:1000,duration:2000,content:'Hello.'}], [{start:1,end:3,text:'Hello.'}]],[[{startTime:'1000',duration:'2000',content:'Hello.'}],[]]]) {
    const page=tedPage({title:'Captions',playerData:{resources:{h264:[{file:mediaURL}]}},captions});
    const result=await material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async(url,options)=>options.method==='HEAD'?response(null,{'content-type':'video/mp4'}):response(page)});
    assert.deepEqual(result.cues,expected);
  }
});
test('caller abort cancels a body read that has already started', async () => {
  let readStarted;
  const started=new Promise(resolve=>{readStarted=resolve;});
  const controller=new AbortController();
  const pending=material.resolveMaterial(tedURL,{lookup:publicLookup,signal:controller.signal,fetchImpl:async()=>response(new ReadableStream({pull(){readStarted();return new Promise(()=>{});}}))});
  await started; controller.abort();
  await assert.rejects(pending,/MATERIAL_ABORTED/);
});
test('translation deadline bounds an injected fetch even if it ignores abort', async () => {
  await assert.rejects(material.translateCues({workspace:'demo',apiKey:'mock',cues:[{start:0,end:1,text:'Hello'}],timeoutMs:20,fetchImpl:async()=>new Promise(()=>{})}),/TRANSLATION_TIMEOUT/);
});
test('default native HTTPS pins the validated DNS answer without another resolution', async () => {
  const original=https.request; let captured, resolutions=0;
  https.request=(url,options,onResponse)=>{
    captured=options;
    const request=new EventEmitter();
    request.end=()=>{const incoming=Readable.from([]); incoming.statusCode=200; incoming.headers={'content-type':'video/mp4'};onResponse(incoming);};
    return request;
  };
  syncBuiltinESMExports();
  try {
    const result=await material.resolveMaterial(mediaURL,{lookup:async()=>{resolutions++;return [{address:'93.184.216.34',family:4}];}});
    assert.equal(result.status,'needs_transcript');assert.equal(resolutions,1);
    await new Promise((resolve,reject)=>captured.lookup('download.ted.com',{},(error,address,family)=>{if(error)reject(error);else {assert.equal(address,'93.184.216.34');assert.equal(family,4);resolve();}}));
  } finally {https.request=original;syncBuiltinESMExports();}
});
test('native HTTPS handles an empty successful metadata response without an uncaught callback error', async () => {
  const original=https.request;
  https.request=(url,options,onResponse)=>{
    const request=new EventEmitter();
    request.end=()=>setImmediate(()=>{const incoming=Readable.from([]);incoming.statusCode=204;incoming.headers={};onResponse(incoming);});
    return request;
  };
  syncBuiltinESMExports();
  try {await assert.rejects(material.resolveMaterial(tedURL,{lookup:publicLookup,timeoutMs:30}),/MATERIAL_MEDIA/);}
  finally {https.request=original;syncBuiltinESMExports();}
});
test('invalid DNS records and the deprecated IPv4 relay range are rejected uniformly', async () => {
  for(const records of [[],[{}],[{address:null}],[{address:'192.88.99.1',family:4}]]) {
    await assert.rejects(material.resolveMaterial(mediaURL,{lookup:async()=>records,fetchImpl:async()=>{throw Error('unexpected fetch');}}),/MATERIAL_ADDRESS/);
  }
});
test('real TED player shape prefers its official H264 CDN over JSON-LD HLS and discovers English subtitles', async () => {
  const download='https://py.tedcdn.com/consus/talk.mp4';
  const subtitle='https://www.ted.com/talks/subtitles/id/123/lang/en';
  const html=`<script type="application/ld+json">{"contentUrl":"https://hls.ted.com/talks/playlist.m3u8"}</script>${tedPage({title:'Official player shape',duration:680,videoPlayerData:{id:123,resources:{h264:[{file:download}],hls:{stream:'https://hls.ted.com/talks/playlist.m3u8'}},languages:[{languageCode:'en'}]}})}`;
  const calls=[];
  const result=await material.resolveMaterial(tedURL,{lookup:publicLookup,fetchImpl:async(url,options)=>{
    calls.push(url);
    if(options.method==='HEAD') return response(null,{'content-type':'video/mp4'});
    if(url===subtitle) return response(JSON.stringify({captions:[{startTime:0,duration:1500,content:'Hello there.'}]}));
    return response(html);
  }});
  assert.equal(result.mediaUrl,download); assert.equal(result.status,'ready'); assert.equal(result.duration,680);
  assert.deepEqual(result.cues,[{start:0,end:1.5,text:'Hello there.'}]); assert.ok(calls.includes(subtitle));
});
test('NPR feed stops after its first complete item and returns its exact public tracking enclosure without fetching media', async () => {
  const tracking='https://prfx.byspotify.com/e/npr/example.mp3';
  const item=`<rss><channel><item><title>Real feed episode</title><link>https://www.npr.org/2026/10/09/example</link><enclosure url="${tracking}" type="audio/mpeg"/><itunes:duration>10:20</itunes:duration></item>`;
  const requests=[],lookups=[];let cancelled=false;
  const result=await material.resolveMaterial('https://feeds.npr.org/510351/podcast.xml',{
    lookup:async host=>{lookups.push(host);return publicLookup();},
    fetchImpl:async(url,options)=>{requests.push([url,options.method]);let sent=false;return response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(item));}else controller.enqueue(new Uint8Array(2097153));},cancel(){cancelled=true;}}),{'content-length':'9999999'});},
  });
  assert.equal(result.mediaUrl,tracking);assert.equal(result.kind,'audio');assert.equal(result.duration,620);assert.equal(result.status,'needs_transcript');
  assert.deepEqual(requests,[['https://feeds.npr.org/510351/podcast.xml','GET']]);assert.deepEqual(lookups,['feeds.npr.org','prfx.byspotify.com']);assert.equal(cancelled,true);
});
test('NPR tracking enclosure remains limited to official feed context and public DNS', async () => {
  const tracking='https://prfx.byspotify.com/e/npr/example.mp3';
  await assert.rejects(material.resolveMaterial(tracking,{lookup:publicLookup,fetchImpl:async()=>{throw Error('unexpected');}}),/MATERIAL_UNSUPPORTED/);
  const rss=`<rss><channel><item><title>Example</title><enclosure url="${tracking}" type="audio/mpeg"/></item></channel></rss>`;
  await assert.rejects(material.resolveMaterial('https://feeds.npr.org/510351/podcast.xml',{lookup:async host=>host==='prfx.byspotify.com'?[{address:'127.0.0.1',family:4}]:publicLookup(),fetchImpl:async()=>response(rss)}),/MATERIAL_ADDRESS/);
  await assert.rejects(material.resolveMaterial('https://podcasts.files.bbci.co.uk/example.rss',{lookup:publicLookup,fetchImpl:async()=>response(rss)}),/MATERIAL_UNSUPPORTED/);
});
test('an RSS item that itself exceeds the metadata cap is still rejected', async () => {
  await assert.rejects(material.resolveMaterial('https://feeds.npr.org/510351/podcast.xml',{lookup:publicLookup,fetchImpl:async()=>response('<rss><channel><item><description>'+'x'.repeat(2097153)+'</description></item></channel></rss>',{'content-length':'9999999'})}),/MATERIAL_SIZE/);
});
