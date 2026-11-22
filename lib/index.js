// dsh-session-color 宿主半侧
//
// 职责：
//   1. 注册一个 Connection RPC channel，让浏览器端读写「会话 → 颜色」映射；
//   2. 把映射持久化到 $DSH_HOME/dsh-session-color/colors.json。
//
// 颜色本身不参与任何模型上下文，纯展示状态。
//
// 路由挂载（DSH 0.2.2-rc.1 源码查证）：
//   ctx.connection.rpc.handle 内部执行 owner.effect(() => owner.webServer.register(route))
//   [dsh-client-connection/lib/index.js:871]，而 connection 插件自身 inject = ["credentials"]
//   [同文件 :1013]，在受限 Context 上访问 owner.webServer 会抛 "cannot get property without inject"。
//   因此这里自己 inject webServer 注册路由，并用 connection.requestRejection(req) 做认证栅栏
//   （与官方 /api 路由一致，同文件 :1049）。
//
// 信封契约（关键）：
//   浏览器端 parseConnectionResponse [dsh-client-connection/lib/client.browser.js:1288-1298]
//   强制 result 必须是 { ok:true, value } 或 { ok:false, error:{code,message,details} }。
//   返回裸业务对象会让前端解析抛错 → 乐观更新回滚 → 用户看到「闪一下就消失」。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { RPC_CHANNEL, ENDPOINTS, PALETTE, isValidColorKey } from '../shared/contract.mjs';

const name = 'dsh-session-color';
const inject = ['connection', 'webServer'];

const STORAGE_REL = join('dsh-session-color', 'colors.json');
const VALID_KEYS = new Set(PALETTE.map((item) => item.key));
const SESSION_ID_RE = /^[A-Za-z0-9._~:-]{1,200}$/;
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;
const RPC_BODY_MAX = 64 * 1024;

function storagePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), STORAGE_REL);
}

/** 容错读取：文件缺失 / 损坏一律当空表，绝不因为展示状态拖垮 Host。 */
function readColors() {
  try {
    const raw = JSON.parse(readFileSync(storagePath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const clean = {};
    for (const [id, key] of Object.entries(raw)) {
      if (SESSION_ID_RE.test(id) && (key === null || isValidColorKey(key, VALID_KEYS))) clean[id] = key;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeColors(colors) {
  const path = storagePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(colors, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** RPC handler：返回业务值；信封包装在 makeFetchHandler 里完成。 */
function handleRpc(endpoint, payload) {
  switch (endpoint) {
    case ENDPOINTS.list:
      return { colors: readColors() };

    case ENDPOINTS.set: {
      const sessionId = payload?.sessionId;
      const key = payload?.key;
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        throw new Error('invalid sessionId');
      }
      if (key !== null && !isValidColorKey(key, VALID_KEYS)) {
        throw new Error('invalid color key');
      }
      const colors = readColors();
      if (key === null) delete colors[sessionId];
      else colors[sessionId] = key;
      if (!writeColors(colors)) throw new Error('failed to persist colors');
      return { colors };
    }

    default:
      throw new Error(`unknown endpoint: ${endpoint}`);
  }
}

function endpointFromPath(pathname) {
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_RE.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** server-response 信封：parseConnectionResponse 强制 result = { ok:true, value }。 */
function serverResponse(rpcId, value) {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  });
}

/** 失败信封：rpcErrorSchema 要求 code / message / details。 */
function serverError(rpcId, message) {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error: { code: 'bad-request', message, details: { issues: [{ message }] } },
    },
  });
}

/** fetch-shaped handler，逐分支复刻官方 rpcFetchHandler 的 4xx / 200。 */
function makeFetchHandler() {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      const endpoint = endpointFromPath(new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request';
      const method = body && typeof body.method === 'string' ? body.method : null;
      if (rpcId === 'invalid-request' || method === null) {
        return new Response(serverError('invalid-request', 'invalid client-request message'), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (method !== endpoint) {
        return new Response(serverError(rpcId, `method ${String(method)} does not match endpoint ${String(endpoint)}`), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      try {
        const value = await handleRpc(endpoint, body.payload, request.signal);
        return new Response(serverResponse(rpcId, value), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        return new Response(serverError(rpcId, String(error)), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
    },
  };
}

/** node:http 请求 → fetch-shaped handler → node:http 响应（含 body 上限与断连 abort）。 */
async function bridge(req, res, fetchHandler) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > RPC_BODY_MAX) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > RPC_BODY_MAX) { tooLarge = true; break; }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }

  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const init = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    signal: abort.signal,
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const response = await fetchHandler.fetch(new Request(url, init));

  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (response.body === null) { res.end(); return; }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}

function apply(ctx) {
  const connection = ctx.connection;
  const fetchHandler = makeFetchHandler();
  const route = {
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (req, res) => {
      // 与官方 /api 路由一致的认证栅栏；必须以方法形式调用（内部读 this）。
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      await bridge(req, res, fetchHandler);
    },
  };

  ctx.effect(() => {
    const registered = ctx.webServer.register(route);
    if (typeof registered === 'function') return registered;
    if (registered && typeof registered.then === 'function') {
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        try {
          const d = await registered;
          if (typeof d === 'function') d();
        } catch { /* 已清理 */ }
      };
    }
    return () => {};
  }, 'dsh-session-color: rpc channel');
}

export { name, inject, apply };
