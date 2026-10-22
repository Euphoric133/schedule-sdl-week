/**
 * Netlify Function：把浏览器请求转发给 Google Gemini API（计划助手）。
 *
 * 为什么必须有这一层（而不是让浏览器直接调 Google）：
 * 1. **密钥不能出现在前端**。站点是公开的，任何人按 F12 或直接 curl 都能拿到
 *    写死在 HTML 里的 key。浏览器直连 = 把 key 交给每一个访客。
 * 2. **用户零操作的前提是没有身份**：没有登录、没有账号，那么唯一能阻止"别人
 *    拿你的站点当免费 ChatGPT 刷额度"的防线，只能是服务端的限流与范围限制。
 * 3. 可以在这里统一收口：只允许"日程助手"范围内的对话、限制长度、限制输出 token。
 *
 * 本函数是**纯转发 + 守卫**：不读业务数据、不写任何存储、不记日志到磁盘。
 * 学生的日程内容只经内存转发，不会被本函数保存。
 *
 * 环境变量（在 Netlify 后台 Site configuration → Environment variables 配置）：
 *   GEMINI_API_KEY  必填。Google AI Studio 生成的 key。
 *   GEMINI_MODEL    可选。默认见 DEFAULT_MODEL；换模型不用改代码。
 *   ALLOWED_ORIGINS 可选。逗号分隔的允许来源；留空则自动允许本站域名与 localhost。
 *
 * 安全约束（任何一条被改动都要重新评估）：
 * - 只接受 POST，且必须是同源（或 ALLOWED_ORIGINS 白名单内）的请求；
 * - 同一 IP 在时间窗口内的请求数受限（进程内计数，见 rateLimit）；
 * - 入参上限：最多 12 条消息、每条 2000 字符；
 * - 输出上限：maxOutputTokens 固定；
 * - 永远不把 Google 的原始错误（可能包含 key 片段或内部细节）回传给浏览器。
 */

/** 默认模型。Google 的模型迭代很快，用环境变量 GEMINI_MODEL 覆盖，不要写死在这里。 */
const DEFAULT_MODEL = 'gemini-3.8-flash';

/** 当前推荐的接口。旧接口（generateContent）作为回退，见 callGemini。 */
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const LIMITS = Object.freeze({
  maxMessages: 12,
  maxCharsPerMessage: 2000,
  maxOutputTokens: 800,
  /** 每个 IP 在一个窗口内允许的请求数 */
  rateLimitMax: 8,
  rateLimitWindowMs: 60_000,
  upstreamTimeoutMs: 20_000,
});

/**
 * 助手的行为边界。写在这里而不是让前端传，是为了让前端无法通过改参数绕过。
 * 关键一句：它只做**日程助手**，不编造数据、不假装修改成功。
 */
const SYSTEM_INSTRUCTION = [
  '你是「七天学习规划器」里的日程助手，服务对象是学生。',
  '',
  '你的职责范围（超出范围要礼貌拒绝并说明你能做什么）：',
  '1. 帮学生理解自己的学习计划、任务优先级与时间冲突；',
  '2. 针对"今天没做完""某任务超时"这类情况，给出**不机械压缩所有任务**的处理建议，说明取舍；',
  '3. 提醒学生注意睡觉时间、截止日期与考试等硬性约束。',
  '',
  '必须遵守：',
  '- 使用简体中文，语气平实、具体，不说空话。',
  '- 只依据上下文里给出的数据回答。数据里没有的信息就说"我这里看不到"，不要编造任务、时长或日期。',
  '- 你只能**建议**，不能声称自己已经改了日程。任何调整都需要学生在预览页手动确认后才能生效。',
  '- 不要把学生的数据原文整段复述出来，除非学生明确要求。',
].join('\n');

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    // 兜底：任何未预料到的异常都变成稳定的 500，绝不把堆栈回传给浏览器
    console.error('[ai-chat] unhandled', err?.name, err?.message);
    return json(500, { ok: false, code: 'internal_error', message: '助手服务出了点问题，请稍后再试。' });
  }
};

async function handle(req) {
  if (req.method !== 'POST') {
    return json(405, { ok: false, code: 'method_not_allowed', message: '只接受 POST 请求。' });
  }

  const originCheck = checkOrigin(req);
  if (!originCheck.ok) {
    return json(403, { ok: false, code: 'origin_rejected', message: '请求来源不被允许。' });
  }

  const apiKey = readEnv('GEMINI_API_KEY');
  if (!apiKey) {
    // 这是部署配置问题，不是用户操作问题：提示要指向"去配置环境变量"，而不是"重试"
    return json(503, {
      ok: false,
      code: 'missing_api_key',
      message: '服务端还没有配置 GEMINI_API_KEY。请在 Netlify 的环境变量里添加后重新部署。',
    });
  }

  const clientIp = clientIpOf(req);
  const gate = rateLimit(clientIp);
  if (!gate.ok) {
    return json(429, {
      ok: false,
      code: 'rate_limited',
      message: `请求有点频繁，请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试。`,
      retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000),
    });
  }

  const body = await readJson(req);
  if (!body.ok) return json(400, { ok: false, code: 'bad_request', message: body.message });

  const parsed = parseMessages(body.value);
  if (!parsed.ok) return json(400, { ok: false, code: 'bad_request', message: parsed.message });

  const model = readEnv('GEMINI_MODEL') || DEFAULT_MODEL;
  const upstream = await callGemini({ apiKey, model, messages: parsed.messages });

  if (!upstream.ok) {
    console.error('[ai-chat] upstream', upstream.status, upstream.code);
    return json(upstream.status, { ok: false, code: upstream.code, message: upstream.message, model });
  }

  return json(200, { ok: true, model, reply: upstream.reply, usage: upstream.usage ?? null });
}

/* ------------------------------------------------------------------ *
 * 守卫
 * ------------------------------------------------------------------ */

/**
 * 同源校验。
 *
 * 为什么要做：函数是公开地址，任何人都能直接 POST。检查 Origin/Referer 不能阻止
 * 用脚本伪造请求头的人（所以还需要限流），但能阻止绝大多数"其它网页盗用你的额度"
 * 的情况，成本几乎为零。
 *
 * 判定规则：
 * - 请求里没有 Origin 也没有 Referer → 拒绝（浏览器发起的 fetch 一定会带 Origin；
 *   服务器到服务器反而无所谓，所以不存在"误伤正常用户"的问题）；
 * - Origin 与请求自身的域名一致 → 通过；
 * - Origin 在 ALLOWED_ORIGINS 白名单里 → 通过（用于自定义域名、本地预览）。
 */
function checkOrigin(req) {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const candidate = origin || (referer ? safeOrigin(referer) : null);
  if (!candidate) return { ok: false };

  const allowed = readEnv('ALLOWED_ORIGINS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.includes(candidate)) return { ok: true };

  // 本站域名：比较 host（不看协议），因为 Netlify 既可能是 http 也可能是 https 的预览域名
  const selfHost = req.headers.get('host');
  if (selfHost && sameHost(candidate, selfHost)) return { ok: true };

  // 本地开发：http://localhost:4173 与 http://127.0.0.1:4173
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(candidate)) return { ok: true };

  return { ok: false };
}

function sameHost(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * 简易限流（进程内）。
 *
 * 局限（必须写清楚，避免误以为它是万能的）：
 * - Netlify Functions 会横向扩展到多个实例，每个实例各自计数，
 *   因此**真实上限会高于这里的数字**。它挡的是"单个实例被短时间内打爆"，
 *   不是精确的全局配额。
 * - 进程重启后计数清零。
 *
 * 如果需要严格配额，正确做法是使用 Netlify Blobs / 外部 KV 做分布式计数，
 * 但那会增加依赖与延迟；对"学生自用的学习工具"这个场景，当前强度足够。
 */
const buckets = new Map();

/**
 * 清空限流计数。
 *
 * 存在的理由：这是**进程内**状态，测试之间会互相污染（一个用例把某个 IP 的
 * 配额用完后，后面的用例全被误判成 429）。导出它让测试可以在合适的边界隔离。
 * 生产环境不应调用它。
 */
export function __resetRateLimit() {
  buckets.clear();
}

function rateLimit(key) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= LIMITS.rateLimitWindowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  // 顺手清理过期桶，避免长期运行后 Map 无限增长
  if (buckets.size > 500) {
    for (const [k, v] of buckets) {
      if (now - v.start >= LIMITS.rateLimitWindowMs) buckets.delete(k);
    }
  }

  if (bucket.count > LIMITS.rateLimitMax) {
    return { ok: false, retryAfterMs: LIMITS.rateLimitWindowMs - (now - bucket.start) };
  }
  return { ok: true };
}

function clientIpOf(req) {
  const forwarded = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

async function readJson(req) {
  let text;
  try {
    text = await req.text();
  } catch {
    return { ok: false, message: '无法读取请求内容。' };
  }
  // 上限 64KB：一条正常的日程问答远小于这个数，超出说明不是正常使用
  if (text.length > 64 * 1024) return { ok: false, message: '请求内容过大。' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: '请求不是合法的 JSON。' };
  }
}

/**
 * 校验并裁剪消息列表。
 *
 * 只接受 role 为 user / assistant 的纯文本消息：前端传来任何多余字段都会被丢弃，
 * 因此不存在"前端塞一个伪造的 system 提示"绕过系统指令的路径。
 */
function parseMessages(value) {
  if (!value || typeof value !== 'object') return { ok: false, message: '请求体必须是对象。' };
  const raw = value.messages;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: 'messages 必须是非空数组。' };
  if (raw.length > LIMITS.maxMessages) {
    return { ok: false, message: `对话太长了（最多 ${LIMITS.maxMessages} 条），请刷新页面重新开始。` };
  }

  const messages = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, message: 'messages 里存在非法项。' };
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) return { ok: false, message: '消息 role 只能是 user 或 assistant。' };
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) return { ok: false, message: '消息内容不能为空。' };
    if (content.length > LIMITS.maxCharsPerMessage) {
      return { ok: false, message: `单条消息不能超过 ${LIMITS.maxCharsPerMessage} 字，请精简后再发。` };
    }
    messages.push({ role, content });
  }
  if (messages.at(-1).role !== 'user') return { ok: false, message: '最后一条消息必须来自用户。' };

  return { ok: true, messages };
}

/**
 * 可选的学生日程摘要（前端已裁剪成短文本）。
 * 它被拼进系统指令，而不是当成用户消息——这样学生无法伪装成"系统"来改写它。
 */
function withContext(systemInstruction, contextText) {
  if (!contextText) return systemInstruction;
  return `${systemInstruction}\n\n下面是该学生当前的日程摘要（只读，来自应用数据）：\n${contextText}`;
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */

/**
 * 调用 Gemini。
 *
 * 优先用当前推荐的 **Interactions API**；如果它返回 404/400（说明该账号或该模型
 * 在这个接口上不可用），自动回退到旧版 **generateContent**。
 * 这样做是为了在 Google 迁移接口期间，功能不会因为一次接口变更就整体不可用。
 *
 * @param {{apiKey: string, model: string, messages: Array<{role: string, content: string}>, contextText?: string}} input
 * @returns {Promise<{ok: true, reply: string, usage: object|null} | {ok: false, status: number, code: string, message: string}>}
 */
export async function callGemini({ apiKey, model, messages, contextText = '' }) {
  const system = withContext(SYSTEM_INSTRUCTION, contextText);

  const primary = await postJson(INTERACTIONS_URL, apiKey, buildInteractionsBody(model, system, messages));
  if (primary.ok) {
    const reply = extractInteractionsText(primary.data);
    if (reply) return { ok: true, reply, usage: primary.data?.usage ?? null };
    return mapUpstreamError(primary.status, primary.data, 'interactions_empty');
  }
  // 404/400 才回退；401/403（key 问题）与 429（限流）回退没有意义，直接如实返回
  if (primary.status !== 404 && primary.status !== 400) {
    return mapUpstreamError(primary.status, primary.data, 'interactions_failed');
  }

  const legacy = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    apiKey,
    buildGenerateContentBody(system, messages),
  );
  if (!legacy.ok) return mapUpstreamError(legacy.status, legacy.data, 'generate_content_failed');

  const reply = extractGenerateContentText(legacy.data);
  if (!reply) return mapUpstreamError(200, legacy.data, 'generate_content_empty');
  return { ok: true, reply, usage: legacy.data?.usageMetadata ?? null };
}

/** Interactions API 的请求体：system 放在 system_instruction，历史消息放在 input。 */
export function buildInteractionsBody(model, system, messages) {
  return {
    model,
    system_instruction: system,
    // 注意：input 项**不能**带 type: 'message'——实测会被拒（404 列表里没有这个取值）。
    // 官方 curl 示例直接给字符串；多轮历史用 { role, content } 对象即可。
    input: messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      content: message.content,
    })),
    generation_config: {
      max_output_tokens: LIMITS.maxOutputTokens,
      temperature: 0.6,
    },
  };
}

/** 旧版 generateContent 的请求体（回退路径）。 */
export function buildGenerateContentBody(system, messages) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      maxOutputTokens: LIMITS.maxOutputTokens,
      temperature: 0.6,
    },
  };
}

/** 从 Interactions API 的返回里取文本。兼容 content 是字符串或 parts 数组两种形态。 */
export function extractInteractionsText(data) {
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const texts = [];
  for (const output of outputs) {
    if (typeof output?.content === 'string') texts.push(output.content);
    else if (Array.isArray(output?.content)) {
      for (const part of output.content) {
        if (typeof part?.text === 'string') texts.push(part.text);
      }
    }
  }
  if (texts.length === 0 && typeof data?.output_text === 'string') texts.push(data.output_text);
  return texts.join('').trim();
}

/** 从 generateContent 的返回里取文本（跳过 thought 段）。 */
export function extractGenerateContentText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const texts = parts.filter((part) => part && part.thought !== true && typeof part.text === 'string').map((part) => part.text);
  return texts.join('').trim();
}

async function postJson(url, apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.upstreamTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // key 走请求头而不是 URL，避免被写进任何访问日志
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, status: 504, data: { __timeout: true } };
    return { ok: false, status: 502, data: { __network: true } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把上游错误翻译成**给用户看的中文提示**。
 *
 * 关键决定：不转发 Google 原始 message。原因有两个：
 * - 原始错误里可能带出 key 前缀、项目编号等不应出现在浏览器里的信息；
 * - 原始错误对用户没有行动价值（"INVALID_ARGUMENT" 不如"模型名称不对"有用）。
 * 具体状态码会写进函数日志，便于排查。
 */
export function mapUpstreamError(status, data, code) {
  if (data?.__timeout) {
    return { ok: false, status: 504, code: 'timeout', message: '助手响应超时了，请稍后再试。' };
  }
  if (data?.__network) {
    return { ok: false, status: 502, code: 'network', message: '暂时连不上助手的后端服务。' };
  }
  // 地区限制：实测在中国大陆网络下，generateContent / interactions 都会返回
  // 400 FAILED_PRECONDITION "User location is not supported for the API use."
  // 这不是代码或模型名的问题，换什么模型都会失败，必须明确告诉部署者。
  const upstreamMessage = typeof data?.error?.message === 'string' ? data.error.message : '';
  if (/location is not supported/i.test(upstreamMessage)) {
    return {
      ok: false,
      status: 502,
      code: 'region_blocked',
      message: 'Google 拒绝对当前网络位置提供服务（User location is not supported）。这不是代码问题：请把站点的函数部署在 Google 支持的地区，或改用部署在支持地区的服务来转发。',
    };
  }
  if (status === 400 || status === 404) {
    return {
      ok: false,
      status: 502,
      code: 'model_unavailable',
      message: '模型名称可能已失效。请在 Netlify 环境变量里检查 GEMINI_MODEL。',
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: 502,
      code: 'auth_failed',
      message: 'Google API key 无效或被拒绝。请检查 GEMINI_API_KEY，以及这个 key 是否只允许 Gemini API。',
    };
  }
  if (status === 429) {
    return { ok: false, status: 429, code: 'quota_exceeded', message: '助手的调用额度暂时用完了，请几分钟后再试。' };
  }
  if (status >= 500) {
    return { ok: false, status: 502, code: 'upstream_down', message: 'Google 这边的服务暂时不可用，请稍后再试。' };
  }
  return { ok: false, status: 502, code, message: '助手返回了无法识别的内容，请再试一次。' };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function readEnv(name) {
  const env = globalThis.process?.env ?? {};
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
