import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createProviderSession } from './provider.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app.mjs', 'connection.mjs', 'audio.mjs', 'capture-worklet.mjs'].map(name => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
]);
export function isAllowedRequest(host, origin, port, requireOrigin = true) {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  return !requireOrigin || origin === `http://${host}`;
}
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)' };
export function createLocalServer({ port = 53217, upstreamFactory = (url, options) => new WebSocket(url, options), fetchImpl = fetch, connectTimeoutMs = 10000 } = {}) {
  let active = null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port;
    res.writeHead = new Proxy(res.writeHead, { apply(target, receiver, args) { args[1] = { ...headers, ...(args[1] || {}) }; return Reflect.apply(target, receiver, args); } });
    if (!isAllowedRequest(req.headers.host, null, actualPort, false)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const entry = files.get(req.url);
    if (!entry) { res.writeHead(404); res.end('Not found'); return; }
    try { const data = await readFile(new URL(`./public/${entry[0]}`, import.meta.url)); res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(404); res.end('Not found'); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/connect' || !isAllowedRequest(req.headers.host, req.headers.origin, server.address()?.port)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (active) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => { active = ws; wss.emit('connection', ws); });
  });
  wss.on('connection', client => {
    let session = null, first = true;
    function error(code, message) { if (client.readyState === 1) client.send(JSON.stringify({ type: 'error', code, message })); }
    const timer = setTimeout(() => { error('CONNECT_TIMEOUT', '未收到连接配置，请重新连接。'); client.close(1008, 'Connect timeout'); }, connectTimeoutMs);
    client.on('error', () => {});
    client.on('close', () => { clearTimeout(timer); session?.close(); session = null; if (active === client) active = null; });
    client.on('message', (raw, isBinary) => {
      if (isBinary) { error('INVALID_MESSAGE', '仅接受本页规定的请求。'); client.close(1008, 'Invalid message'); return; }
      let value; try { value = JSON.parse(raw.toString()); } catch { error('INVALID_MESSAGE', '请求格式错误。'); client.close(1008, 'Invalid message'); return; }
      if (first) {
        first = false; clearTimeout(timer);
        if (value?.type !== 'connect') { error('INVALID_CONNECT', '请通过连接按钮开始。'); client.close(1008, 'Invalid connect'); return; }
        try { session = createProviderSession(client, value, { upstreamFactory, fetchImpl }); }
        catch { error('INVALID_CONNECT', '请检查 Key、北京工作空间或 Base URL，然后手动重连。'); client.close(1008, 'Invalid connect'); }
        return;
      }
      session?.handle(value);
    });
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); }); }), close: () => new Promise(resolve => { active?.close(); for (const client of wss.clients) client.terminate(); wss.close(); server.close(resolve); server.closeAllConnections?.(); }) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const local = createLocalServer();
  local.listen().then(address => console.log(`Qwen 本地连接测试：http://127.0.0.1:${address.port}`)).catch(() => { console.error('本地服务启动失败：端口可能已被占用。'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => local.close().then(() => process.exit(0)));
}
