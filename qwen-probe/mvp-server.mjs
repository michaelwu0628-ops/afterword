import { fileURLToPath } from 'node:url';
import { createCoachServer } from './coach-server.mjs';
import { isAllowedRequest } from './server.mjs';
import { parseWorkspace } from './provider.mjs';
import { resolveMaterial, translateCues } from './material.mjs';

const BODY_LIMIT = 65536, RESPONSE_LIMIT = 131072;
const browserFiles = [
  ['/mvp.html', ['mvp.html', 'text/html; charset=utf-8']],
  ['/mvp.css', ['mvp.css', 'text/css; charset=utf-8']],
  ...['mvp-app.mjs', 'mvp-session.mjs', 'mvp-store.mjs', 'mvp-part2.mjs', 'mvp-backup.mjs'].map(name => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
];
const messages = {
  INVALID_REQUEST: '请求格式无效，请检查输入。', FORBIDDEN: '请求来源不符合本地服务规则。',
  METHOD_NOT_ALLOWED: '此接口仅接受 POST 请求。', UNSUPPORTED_MEDIA_TYPE: '请使用 JSON 请求。',
  BODY_TOO_LARGE: '请求内容过长，请缩短字幕选段。', BODY_TIMEOUT: '请求读取超时，请重试。',
  MATERIAL_FAILED: '素材解析暂时失败，请检查链接或补充字幕。',
  TRANSLATION_FAILED: '字幕翻译暂时失败，请检查文字服务设置后重试。',
  API_TIMEOUT: '服务请求超时，请稍后重试。',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function validTranslation(input) {
  if (!exactKeys(input, ['workspace', 'apiKey', 'cues']) || !text(input.apiKey, 2048)) return false;
  try { parseWorkspace(input.workspace); } catch { return false; }
  if (!Array.isArray(input.cues) || input.cues.length === 0 || input.cues.length > 300) return false;
  let chars = 0;
  return input.cues.every(cue => object(cue) && Object.keys(cue).every(key => ['start', 'end', 'text', 'zh'].includes(key))
    && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.end <= 86400
    && typeof cue.text === 'string' && cue.text.trim() && cue.text.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cue.text)
    && (cue.zh === undefined || typeof cue.zh === 'string' && cue.zh.length <= 12000)
    && (chars += cue.text.length) <= 12000);
}
function readJson(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const parts = [];
    const cleanup = () => { clearTimeout(deadline); req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onError); };
    const finish = (error, value) => { if (done) return; done = true; cleanup(); if (error) { parts.length = 0; req.resume(); reject(new Error(error)); } else resolve(value); };
    const onData = part => { size += part.length; if (size > BODY_LIMIT) finish('BODY_TOO_LARGE'); else parts.push(part); };
    const onEnd = () => { try { finish(null, JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { finish('INVALID_REQUEST'); } };
    const onError = () => finish('INVALID_REQUEST');
    const deadline = setTimeout(() => finish('BODY_TIMEOUT'), timeoutMs);
    if (Number(req.headers['content-length']) > BODY_LIMIT) { finish('BODY_TOO_LARGE'); return; }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onError);
  });
}

export function createMvpServer({ port = 53219, fetchImpl = globalThis.fetch, resolveMaterialImpl = resolveMaterial,
  translateCuesImpl = translateCues, apiTimeoutMs = 20000, bodyTimeoutMs = 5000, ...coachOptions } = {}) {
  const activeRequests = new Set();
  const local = createCoachServer({ ...coachOptions, port, fetchImpl, rootFile: coachOptions.rootFile || 'mvp.html', extraFiles: browserFiles,
    extraHeaders: { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob: https:; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    async handleRequest(req, res, { port: actualPort, respond }) {
      if (!['/api/material', '/api/translate'].includes(req.url)) return false;
      const json = (status, value) => {
        if (res.destroyed || res.writableEnded) return;
        const body = JSON.stringify(value);
        respond(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...(status >= 400 ? { Connection: 'close' } : {}) }); res.end(body);
      };
      const fail = (status, code) => json(status, { code, message: messages[code] });
      if (req.method !== 'POST') { fail(405, 'METHOD_NOT_ALLOWED'); return true; }
      if (!isAllowedRequest(req.headers.host, req.headers.origin, actualPort)) { fail(403, 'FORBIDDEN'); return true; }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) { fail(415, 'UNSUPPORTED_MEDIA_TYPE'); return true; }
      let input;
      try { input = await readJson(req, bodyTimeoutMs); }
      catch (error) { const code = ['BODY_TOO_LARGE', 'BODY_TIMEOUT'].includes(error.message) ? error.message : 'INVALID_REQUEST'; fail(code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400, code); return true; }
      const material = req.url === '/api/material';
      if (material ? !exactKeys(input, ['url']) || !text(input.url, 3000) : !validTranslation(input)) { fail(400, 'INVALID_REQUEST'); return true; }
      const controller = new AbortController(); activeRequests.add(controller);
      let timer, timedOut = false;
      const abort = () => controller.abort();
      res.once('close', abort);
      const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('API_TIMEOUT')); }, apiTimeoutMs); });
      try {
        const operation = material ? resolveMaterialImpl(input.url, { fetchImpl, signal: controller.signal })
          : translateCuesImpl({ workspace: input.workspace, apiKey: input.apiKey, cues: input.cues, fetchImpl, signal: controller.signal });
        const value = await Promise.race([operation, timeout]);
        const result = material ? value : { cues: value };
        const serialized = JSON.stringify(result);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > RESPONSE_LIMIT || !material && serialized.includes(input.apiKey)) throw new Error('INVALID_RESULT');
        json(200, result);
      } catch { fail(timedOut ? 504 : 502, timedOut ? 'API_TIMEOUT' : material ? 'MATERIAL_FAILED' : 'TRANSLATION_FAILED'); }
      finally { clearTimeout(timer); res.removeListener('close', abort); controller.abort(); activeRequests.delete(controller); input = null; }
      return true;
    },
  });
  return { ...local, close() { for (const controller of activeRequests) controller.abort(); return local.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const local = createMvpServer();
  local.listen().then(address => console.log(`本地口语练习：http://127.0.0.1:${address.port}`)).catch(() => { console.error('无法启动本地练习服务，端口可能已被占用。'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => local.close().then(() => process.exit(0)));
}
