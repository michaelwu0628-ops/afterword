import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {WebSocket,WebSocketServer} from 'ws';
import {isAllowedRequest} from './server.mjs';
import {createDoubaoCoach} from './doubao-coach.mjs';

const files=new Map([
  ['/', ['coach.html','text/html; charset=utf-8']],['/coach.html',['coach.html','text/html; charset=utf-8']],['/coach.css',['coach.css','text/css; charset=utf-8']],
  ...['coach-app.mjs','coach-connection.mjs','turn-detector.mjs','audio.mjs','capture-worklet.mjs'].map(name=>[`/${name}`,[name,'text/javascript; charset=utf-8']]),
]);
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'Permissions-Policy':'camera=(), geolocation=(), microphone=(self)'};
export function createCoachServer({port=53218,upstreamFactory=(url,options)=>new WebSocket(url,options),fetchImpl=fetch,connectTimeoutMs=10000,
  rootFile='coach.html',extraFiles=[],handleRequest,extraHeaders={}}={}){
  let active=null;
  const staticFiles=new Map(files);
  staticFiles.set('/',[rootFile,'text/html; charset=utf-8']);
  for(const [route,entry] of extraFiles)staticFiles.set(route,entry);
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  const server=http.createServer(async(req,res)=>{
    const actualPort=server.address()?.port;
    const respond=(status,extra={})=>res.writeHead(status,{...headers,...extraHeaders,...extra});
    if(!isAllowedRequest(req.headers.host,null,actualPort,false)){respond(403);res.end('Forbidden');return;}
    if(handleRequest&&await handleRequest(req,res,{port:actualPort,respond}))return;
    if(!['GET','HEAD'].includes(req.method)){respond(405,{Allow:'GET, HEAD'});res.end();return;}
    const entry=staticFiles.get(req.url);
    if(!entry){respond(404);res.end('Not found');return;}
    try{const bytes=await readFile(new URL(`./public/${entry[0]}`,import.meta.url));respond(200,{'Content-Type':entry[1],'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
    catch{respond(404);res.end('Not found');}
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/connect'||!isAllowedRequest(req.headers.host,req.headers.origin,server.address()?.port)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    if(active){socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>{active=ws;wss.emit('connection',ws);});
  });
  wss.on('connection',client=>{
    let session=null,first=true;
    function reject(){if(client.readyState===1)client.send(JSON.stringify({type:'error',code:'INVALID_CONNECT',message:'连接配置无效，请检查语音鉴权方式、对应凭据及可选文字服务设置。'}));client.close(1008,'Invalid request');}
    const deadline=setTimeout(reject,connectTimeoutMs);
    client.on('error',()=>{});
    client.on('close',()=>{clearTimeout(deadline);session?.close();session=null;if(active===client)active=null;});
    client.on('message',(raw,isBinary)=>{
      if(isBinary){reject();return;}
      let value;try{value=JSON.parse(raw.toString());}catch{reject();return;}
      if(first){
        first=false;clearTimeout(deadline);
        if(value?.type!=='connect'||Object.keys(value).some(key=>!['type','authType','apiKey','appId','accessToken','text','practice'].includes(key))){reject();return;}
        try{session=createDoubaoCoach(client,value,{upstreamFactory,fetchImpl});}catch{reject();}
      }else session?.handle(value);
    });
  });
  return {server,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address());});}),close:()=>new Promise(resolve=>{active?.close();for(const client of wss.clients)client.terminate();wss.close();server.close(resolve);server.closeAllConnections?.();})};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const local=createCoachServer();
  local.listen().then(address=>console.log(`实时教练局部验证：http://127.0.0.1:${address.port}`)).catch(()=>{console.error('无法启动本地验证服务，端口可能已被占用。');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>local.close().then(()=>process.exit(0)));
}
