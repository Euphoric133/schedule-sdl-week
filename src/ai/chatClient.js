/**
 * 浏览器侧：调用自己的 Netlify Function 中继（不直连 Google）。
 *
 * 为什么不直连：key 一旦出现在前端就等于公开。所有请求都发往
 * `/.netlify/functions/ai-chat`，由服务端注入密钥。
 *
 * 这个模块的职责只有三件：
 * 1. 组装对话消息（并裁剪成短上下文，控制 token 消耗）；
 * 2. 处理超时与取消；
 * 3. 把各种失败翻译成**用户能据此采取行动**的结果（重试 / 去配置 / 等一会）。
 *
 * 它不读全局状态、不依赖 DOM，便于在 Node 测试里直接调用。
 */

/**
 * 中继地址的解析顺序（从高到低）：
 *
 * 1. `window.__AI_ENDPOINT__` —— 部署时由 index.html 注入；
 * 2. 同源的 `/.netlify/functions/ai-chat`（Netlify 部署的默认值）。
 *
 * 为什么要做成可配置：中继可能运行在 Netlify（同源，无 CORS）
 * 或 Cloudflare Worker（跨域，需要 CORS）。写死其中一个，
 * 换平台就得改代码——而地址属于部署配置，不该混进业务代码。
 */
export const NETLIFY_ENDPOINT = '/.netlify/functions/ai-chat';

export function resolveEndpoint(explicit) {
  if (explicit) return explicit;
  const injected = globalThis.__AI_ENDPOINT__;
  if (typeof injected === 'string' && injected.trim()) return injected.trim();
  return NETLIFY_ENDPOINT;
}

/** 兼容旧名：默认中继地址（同源 Netlify 函数） */
export const DEFAULT_ENDPOINT = NETLIFY_ENDPOINT;

/** 与服务端 LIMITS 保持一致的对话上限，超出时由调用方裁剪最旧的消息 */
export const MAX_MESSAGES = 12;
export const MAX_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * 从应用状态里提炼一段**短**的日程摘要，作为助手的只读上下文。
 *
 * 为什么要裁剪而不是把整个 state 发过去：
 * - token 消耗（费用）与响应时间都随上下文线性增长；
 * - 学生数据里包含大量排程细节，机器人并不需要全部；
 * - 少发数据 = 出错时影响面更小。
 *
 * @param {object} state 应用状态
 * @param {{date: string}} now 当前墙上时间
 * @returns {string}
 */
/**
 * 结构化日程上下文：给 AI 一份**带 id 的**任务清单。
 *
 * 为什么必须带 id：功能一的提议要求写 taskId，程序据此校验"这个任务真的存在"。
 * 如果只给标题，AI 只能凭标题编一个 id，校验一定失败——那等于功能不可用。
 * 因此上下文里同时给 title（给人看/AI 理解）和 id（给程序用）。
 *
 * 返回的是**对象**而不是纯文本：服务端会把它序列化后拼进系统侧，
 * 前端只负责选出必要字段，不决定最终文本形态。
 *
 * @param {object} state
 * @param {{date: string}} now
 * @returns {object|null} null 表示没有可提供的上下文
 */
export function buildStructuredContext(state, now) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const active = tasks.filter((task) => task.status === 'not_started' || task.status === 'in_progress');
  if (active.length === 0) return null;

  const entry = {
    date: now?.date ?? null,
    latestSleepMinutes: Number.isInteger(state?.settings?.latestSleepMinutes) ? state.settings.latestSleepMinutes : null,
    tasks: [],
    todaySessions: [],
  };

  const sorted = [...active].sort((a, b) =>
    `${a.deadlineDate}${a.deadlineTime}`.localeCompare(`${b.deadlineDate}${b.deadlineTime}`),
  );
  for (const task of sorted.slice(0, 8)) {
    const done = sessions
      .filter((session) => session.taskId === task.id && session.state === 'completed')
      .reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
    entry.tasks.push({
      id: task.id,
      title: task.title,
      subject: task.subject,
      plannedMinutes: task.plannedMinutes,
      remainingMinutes: Math.max(0, (task.plannedMinutes ?? 0) - done),
      deadline: `${task.deadlineDate} ${task.deadlineTime}`,
      importance: task.importance,
    });
  }

  entry.todaySessions = sessions
    .filter((session) => session.date === entry.date)
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .slice(0, 12)
    .map((session) => ({ taskId: session.taskId, start: session.startMinutes, end: session.endMinutes, state: session.state }));

  return entry;
}

export function buildScheduleContext(state, now) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  if (tasks.length === 0) return '';

  const active = tasks.filter((task) => task.status === 'not_started' || task.status === 'in_progress');
  if (active.length === 0) return '';

  const today = now?.date ?? '';
  const lines = [];
  lines.push(`今天：${today}`);

  // 只列最近的 8 个任务，按截止时间排序：更多信息对回答没有帮助，只会烧 token
  const sorted = [...active].sort((a, b) => `${a.deadlineDate}${a.deadlineTime}`.localeCompare(`${b.deadlineDate}${b.deadlineTime}`));
  for (const task of sorted.slice(0, 8)) {
    const done = sessions
      .filter((session) => session.taskId === task.id && session.state === 'completed')
      .reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
    const remaining = Math.max(0, (task.plannedMinutes ?? 0) - done);
    lines.push(
      `- ${task.title}（${task.subject}）：剩余约 ${remaining} 分钟，截止 ${task.deadlineDate} ${task.deadlineTime}，重要度 ${task.importance}/5`,
    );
  }
  return lines.join('\n');
}

/**
 * 调用中继获取一条回复。
 *
 * @param {object} input
 * @param {Array<{role: 'user'|'assistant', content: string}>} input.messages
 * @param {string} [input.context] 日程摘要（会拼进系统侧，不作为用户消息）
 * @param {string} [input.endpoint]
 * @param {number} [input.timeoutMs]
 * @param {(ms?: number) => Promise<void>} [input.sleep] 便于测试
 * @param {(ms: number) => Promise<never>} [input.withTimeout] 便于测试注入
 * @returns {Promise<{ok: true, reply: string, model: string} | {ok: false, code: string, message: string, retryable: boolean, retryAfterSeconds?: number}>}
 */
export async function sendMessage(input, options = {}) {
  const endpoint = resolveEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'no_fetch', message: '当前环境无法发起网络请求。', retryable: false };
  }

  const body = {
    messages: normalizeMessages(input.messages ?? []),
    // context 可以是纯文本，也可以是结构化对象（含任务 id）
    context: input.context ?? '',
  };
  if (body.messages.length === 0) {
    return { ok: false, code: 'empty', message: '请先输入你想问的问题。', retryable: false };
  }

  let response;
  try {
    response = await withTimeoutSignal(doFetch, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'timeout') {
      return { ok: false, code: 'timeout', message: '助手响应有点慢，已经超时。可以再试一次。', retryable: true };
    }
    // 最典型的一类：Netlify 站点还没部署 Functions（本地直接打开单文件、或尚未推送）
    return {
      ok: false,
      code: 'network',
      message: '连不上助手服务。如果你的站点还没部署 Functions，或是在本地直接打开了文件，这个功能暂时不可用。',
      retryable: true,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok && payload?.ok && typeof payload.reply === 'string') {
    return { ok: true, reply: payload.reply, model: payload.model ?? '' };
  }

  // 服务端返回的是**已经翻译好的中文提示**，直接展示；只有缺失时才用兜底文案
  const code = payload?.code ?? `http_${response.status}`;
  return {
    ok: false,
    code,
    message: payload?.message ?? '助手暂时不可用，请稍后再试。',
    retryable: response.status === 429 || response.status >= 500,
    retryAfterSeconds: payload?.retryAfterSeconds,
  };
}

/**
 * 把对话裁剪到服务端能接受的范围：保留最近的消息，并截断过长的单条。
 * 裁剪放在前端而不是只靠服务端报错，是为了让"聊久了"仍然可用，而不是直接失败。
 */
export function normalizeMessages(messages) {
  const cleaned = [];
  for (const item of messages) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    cleaned.push({ role: item.role, content: content.slice(0, MAX_CHARS) });
  }
  // 必须从一条 user 消息开始，且以 user 结尾（服务端也要求）
  while (cleaned.length > 0 && cleaned[0].role !== 'user') cleaned.shift();
  return cleaned.slice(-MAX_MESSAGES);
}

/** 带超时的 fetch：超时后 abort，并把错误统一成 code=timeout */
async function withTimeoutSignal(doFetch, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('timeout');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


/**
 * 从 AI 回复里去掉末尾的提议 JSON 代码块，只留下给人看的文字。
 *
 * 为什么需要：系统提示要求模型在回复末尾附带
 * ```json {"proposals":[...]} ```
 * 供程序解析。但那段 JSON 是**给程序看的**，直接显示在聊天气泡里
 * 就是一堆 `{"proposals":[]}`，普通用户看到会以为界面坏了。
 *
 * 这里的剥离只影响**显示**：原文本仍会被页面拿去解析提议，两者不冲突。
 */
export function stripProposalBlock(reply) {
  if (typeof reply !== 'string') return '';
  return reply
    .replace(/```(?:json)?\s*\{[\s\S]*?"proposals"[\s\S]*?\}\s*```/g, '')
    .replace(/```(?:json)?\s*\[[\s\S]*?\]\s*```/g, '')
    .trim();
}

/**
 * 解析回复里的提议块。解析失败返回空数组——**绝不猜测意图**。
 * @returns {{text: string, proposals: object[]}}
 */
export function splitReply(reply) {
  if (typeof reply !== 'string') return { text: '', proposals: [] };
  const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!match) return { text: reply.trim(), proposals: [] };
  try {
    const parsed = JSON.parse(match[1]);
    return {
      text: reply.replace(match[0], '').trim(),
      proposals: Array.isArray(parsed?.proposals) ? parsed.proposals : [],
    };
  } catch {
    return { text: reply.replace(match[0], '').trim(), proposals: [] };
  }
}


/**
 * 结构化提议请求（计划急救专用）。
 *
 * 与 sendMessage 的区别：服务端用 responseSchema 约束输出，
 * taskId 只能取自 taskRefs，因此不会出现"引用了不存在的任务"。
 *
 * @param {{message: string, context: object, taskRefs: Array<number|string>}} input
 * @returns {Promise<{ok: true, reply: string, proposals: object[], model: string} | {ok: false, code: string, message: string}>}
 */
export async function sendStructuredRescue(input, options = {}) {
  const endpoint = resolveEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'no_fetch', message: '当前环境无法发起网络请求。' };
  }

  const body = {
    structured: true,
    message: String(input.message ?? '').slice(0, MAX_CHARS),
    context: input.context ?? null,
    taskRefs: Array.isArray(input.taskRefs) ? input.taskRefs : [],
  };

  let response;
  try {
    response = await withTimeoutSignal(doFetch, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'timeout') {
      return { ok: false, code: 'timeout', message: '助手响应有点慢，已经超时。可以再试一次。' };
    }
    return { ok: false, code: 'network', message: '连不上助手服务，请检查网络或稍后再试。' };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok && payload?.ok && payload.structured) {
    return {
      ok: true,
      reply: payload.structured.reply ?? '',
      proposals: Array.isArray(payload.structured.proposals) ? payload.structured.proposals : [],
      model: payload.model ?? '',
    };
  }
  return {
    ok: false,
    code: payload?.code ?? `http_${response.status}`,
    message: payload?.message ?? '助手暂时不可用，请稍后再试。',
  };
}
