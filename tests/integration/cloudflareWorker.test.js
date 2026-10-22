/**
 * Cloudflare Worker 版本的中继测试。
 *
 * 重点验证与 Netlify 版**不同的那三处**，而不是重复测业务逻辑
 * （业务逻辑由 aiChat.test.js 覆盖，两边是同一份代码）：
 *
 * 1. CORS 预检与响应头：跨域场景下缺了它，浏览器里的所有请求都会失败；
 * 2. 环境变量来自 env 参数而不是 process.env；
 * 3. 跨域下的 origin 白名单。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const WORKER_PATH = join(projectRoot, 'cloudflare', 'ai-chat-worker.js');

/** Worker 用的是 export default { fetch }，动态 import 拿不到 env，因此用源码 + 注入的方式跑 */
async function loadWorker(env) {
  const source = await readFile(WORKER_PATH, 'utf8');
  /**
   * 只把**行首**的 `export default {` 换成具名常量。
   * 必须锚定行首：注释里也出现了同样的字样（入口说明），
   * 不加锚会把注释改坏，导致 "Identifier '.default' has already been declared"。
   */
  const patched = source.replace(/^export default \{$/m, 'const __worker = {') + '\nexport default __worker;\n';
  const dataUrl = `data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`;
  const mod = await import(dataUrl);
  const call = (request) => mod.default.fetch(request, env);
  return { mod, call };
}

const ORIGIN = 'https://powerschedule.netlify.app';

function makeRequest({ method = 'POST', origin = ORIGIN, body } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) headers.set('origin', origin);
  return new Request('https://schedule-ai-chat.example.workers.dev/', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body ?? { messages: [{ role: 'user', content: '你好' }] }) : undefined,
  });
}

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

const OK = { outputs: [{ content: [{ text: '好的' }] }] };

test('CORS 预检：OPTIONS 返回 204 并带 allow-origin', async () => {
  const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
  const response = await call(makeRequest({ method: 'OPTIONS' }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.ok(response.headers.get('access-control-allow-methods').includes('POST'));
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('正常请求：响应带 CORS 头（否则浏览器丢弃响应）', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
  try {
    const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
    const response = await call(makeRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    const payload = await response.json();
    assert.equal(payload.ok, true);
  } finally {
    restore();
  }
});

test('错误响应也带 CORS 头（否则前端只能看到"网络错误"）', async () => {
  const { call } = await loadWorker({ ALLOWED_ORIGINS: ORIGIN }); // 故意不给 key
  const response = await call(makeRequest());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await response.json()).code, 'missing_api_key');
});

test('环境变量来自 env 参数：没有 process.env 也能读到 key', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const restore = stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
  try {
    const { call } = await loadWorker({ GEMINI_API_KEY: 'from-worker-env', ALLOWED_ORIGINS: ORIGIN });
    const response = await call(makeRequest());
    assert.equal(response.status, 200, 'Worker 必须从 env 读取 key，而不是 process.env');
  } finally {
    restore();
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
});

test('跨域 origin 不在白名单时被拒绝', async () => {
  const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
  const response = await call(makeRequest({ origin: 'https://evil.example' }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'origin_rejected');
  // 被拒绝时也必须带 CORS 头，否则前端拿不到具体的错误原因
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://evil.example');
});

test('没有 Origin 头的请求放行（curl / 服务端调用），由限流兜底', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
  try {
    const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
    const response = await call(makeRequest({ origin: null }));
    assert.equal(response.status, 200);
  } finally {
    restore();
  }
});

test('本地开发地址始终放行', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
  try {
    const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
    const response = await call(makeRequest({ origin: 'http://localhost:4173' }));
    assert.equal(response.status, 200);
  } finally {
    restore();
  }
});

test('结构化模式在 Worker 上同样可用（responseSchema 照常下发）', async () => {
  let sent = null;
  const restore = stubFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: '建议少做', proposals: [{ kind: 'defer_task', taskId: '1', minutes: 20, reason: 'x' }] }) }] } }] }),
      { status: 200 },
    );
  });
  try {
    const { call } = await loadWorker({ GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN });
    const response = await call(makeRequest({ body: { structured: true, message: '数学超时', context: {}, taskRefs: [1] } }));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.structured.proposals[0].taskId, '1');
    assert.deepEqual(sent.generationConfig.responseSchema.properties.proposals.items.properties.taskId.enum, ['1']);
  } finally {
    restore();
  }
});

test('Worker 源码不含 Netlify 专属头（平台差异确实被替换）', async () => {
  const source = await readFile(WORKER_PATH, 'utf8');
  assert.ok(!source.includes('x-nf-client-connection-ip'), 'Worker 应使用 cf-connecting-ip');
  assert.ok(source.includes('cf-connecting-ip'));
  assert.ok(source.includes('access-control-allow-origin'), '必须处理 CORS');
});
