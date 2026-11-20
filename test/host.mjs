// 宿主半侧单元测试：mock connection/webServer，验证 RPC 信封与持久化。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'dsh-session-color-test-'));
process.env.DSH_HOME = tmp;

const { apply } = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href);

let route = null;
const effects = [];
const fakeCtx = {
  connection: { requestRejection: () => undefined },
  webServer: { register: (r) => { route = r; return () => { route = null; }; } },
  effect: (fn, label) => {
    const cleanup = fn();
    effects.push({ label, cleanup });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  },
};

apply(fakeCtx);
if (!route || route.path !== '/dsh-session-color') throw new Error('route not registered');

async function rpc(endpoint, payload, methodOverride) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: 'test-1', method: methodOverride ?? endpoint, payload,
  });
  const req = {
    method: 'POST', url: `/dsh-session-color/${endpoint}`,
    headers: { host: '127.0.0.1:57008', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }, destroy() {},
  };
  let status = 0; let responseBody = '';
  const res = {
    writableEnded: false, on() {}, off() {}, once() {},
    writeHead(s) { status = s; },
    write(chunk) { responseBody += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; },
    end(chunk) { if (chunk) responseBody += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); this.writableEnded = true; },
  };
  await route.handler(req, res);
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { /* 非 JSON 错误响应 */ }
  return { status, parsed, text: responseBody };
}

// 官方信封断言：parseConnectionResponse 强制 result = { ok:true, value }。
const valueOf = (r) => {
  if (r.status !== 200) throw new Error('status ' + r.status + ': ' + r.text);
  const env = r.parsed;
  if (!env || env.type !== 'server-response' || typeof env.rpcId !== 'string') throw new Error('invalid envelope: ' + r.text);
  if (env.result.ok === true) return env.result.value;
  if (env.result.ok === false) return { __error: env.result.error };
  throw new Error('invalid result: ' + r.text);
};

let r = await rpc('colors.list', {});
let v = valueOf(r);
if (!v.colors || Object.keys(v.colors).length !== 0) throw new Error('expected empty');

r = await rpc('colors.set', { sessionId: 'session-abc', key: 'green' });
if (valueOf(r).colors?.['session-abc'] !== 'green') throw new Error('set failed');
r = await rpc('colors.list', {});
if (valueOf(r).colors['session-abc'] !== 'green') throw new Error('persistence failed');

const file = join(tmp, 'dsh-session-color', 'colors.json');
if (JSON.parse(readFileSync(file, 'utf8'))['session-abc'] !== 'green') throw new Error('file wrong');

r = await rpc('colors.set', { sessionId: '../evil', key: 'red' });
if (!valueOf(r).__error) throw new Error('invalid sessionId not rejected');
r = await rpc('colors.set', { sessionId: 'session-abc', key: 'not-a-color' });
if (!valueOf(r).__error) throw new Error('invalid key not rejected');
r = await rpc('colors.set', { sessionId: 'session-abc', key: null });
if (valueOf(r).colors['session-abc'] !== undefined) throw new Error('clear failed');

r = await rpc('colors.list', {}, 'colors.set');
if (!valueOf(r).__error) throw new Error('method mismatch should be failure envelope');

const bad = await (async () => {
  const req = { method: 'GET', url: '/dsh-session-color/colors.list', headers: { host: 'x' }, async *[Symbol.asyncIterator]() {}, destroy() {} };
  const res = { writableEnded: false, on() {}, off() {}, once() {}, writeHead(s) { this.status = s; }, write() { return true; }, end() { this.writableEnded = true; } };
  await route.handler(req, res);
  return res.status;
})();
if (bad !== 404) throw new Error('GET should be 404, got ' + bad);

console.log('HOST OK');
console.log('  effects:', effects.map((e) => e.label).join(', '));
rmSync(tmp, { recursive: true, force: true });
