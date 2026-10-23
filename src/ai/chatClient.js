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
import { collectSamples, calibrateStats } from './calibration.js';
import { formatMinutes } from '../domain/time.js';

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
 * 历史用时聚合：**只发统计结果，不发原始记录**。
 *
 * 为什么这样做：
 * - 原始记录体积大，免费额度下 token 是硬约束；
 * - 聚合数字（"数学最近 5 次平均多用 25 分钟"）已经足够让 AI 解释规律，
 *   而"逐条记录"反而容易让模型挑几条随意发挥。
 *
 * 复用 calibration.js 的统计函数：那里已经定义了"实际用时"的口径
 * （完成任务时段 + 用户手工声明的已完成），不另立一套算法。
 *
 * @param {object} state
 * @returns {Array<{subject, sampleCount, meanPlannedMinutes, meanActualMinutes, meanDiffMinutes, tendency}>}
 */
export function buildHistorySummary(state) {
  try {
    const samples = collectSamples(state);
    if (samples.length === 0) return [];
    const { subjects } = calibrateStats(samples);
    // 只取前 5 个科目：再多对回答没有帮助，只会烧 token
    return subjects.slice(0, 5).map((item) => ({
      subject: item.subject,
      sampleCount: item.sampleCount,
      meanPlannedMinutes: item.meanPlannedMinutes,
      meanActualMinutes: item.meanActualMinutes,
      meanDiffMinutes: item.meanDiffMinutes,
      tendency: item.tendency,
      reliable: item.reliable,
    }));
  } catch {
    // 统计失败不能连累对话：宁可少一段信息，也不要让整个请求挂掉
    return [];
  }
}

/**
 * 今日进度：让 AI 知道"今天已经学了多少、还剩多少"。
 *
 * 只统计当天已完成的时段，不推断任何未记录的内容。
 */
/**
 * 「此刻在做什么、这个时段还剩多久」——**由程序算好，不让模型自己减**。
 *
 * 为什么必须有它：用户把任务排在 09:42、时长 60 分钟，到 10:00 问"还剩多久"，
 * 正确答案是 42 分钟（10:42 结束）。但只把"剩余工作量 60 分钟"发给模型时，
 * 它只能回答 60——因为它根本不知道现在几点、这一段从什么时候开始。
 *
 * 这里做两件事：
 * 1. 找出**当前正在进行**的时段，算出这一段还剩多少分钟；
 * 2. 找出**下一段**，算出还有多久开始。
 *
 * 注意：剩余工作量（还要学多少）与当前时段剩余（这一段还有多久结束）
 * 是两个不同的概念，都提供给模型，让它在回答时分清语境。
 *
 * @returns {{nowTime: string|null, current: object|null, next: object|null, todayTotal: number}}
 */
export function buildNowFocus(state, now) {
  const date = now?.date ?? null;
  const nowMinutes = Number.isInteger(now?.minutes) ? now.minutes : null;
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const todays = sessions
    .filter((session) => session.date === date && session.state !== 'cancelled')
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const result = { nowTime: nowMinutes === null ? null : formatMinutes(nowMinutes), current: null, next: null, todayTotal: todays.length };
  if (nowMinutes === null) return result;

  const current = todays.find(
    (session) => session.startMinutes <= nowMinutes && nowMinutes < session.endMinutes,
  );
  if (current) {
    result.current = {
      start: formatMinutes(current.startMinutes),
      end: formatMinutes(current.endMinutes),
      remainingMinutes: Math.max(0, current.endMinutes - nowMinutes),
      elapsedMinutes: Math.max(0, nowMinutes - current.startMinutes),
      totalMinutes: current.endMinutes - current.startMinutes,
      state: current.state,
      taskId: current.taskId,
    };
  }

  const next = todays.find((session) => session.startMinutes > nowMinutes);
  if (next) {
    result.next = {
      start: formatMinutes(next.startMinutes),
      end: formatMinutes(next.endMinutes),
      minutesUntil: next.startMinutes - nowMinutes,
      taskId: next.taskId,
    };
  }

  return result;
}

export function buildTodayProgress(state, now) {
  const date = now?.date ?? null;
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const todays = sessions.filter((session) => session.date === date && session.state !== 'cancelled');
  const completed = todays.filter((session) => session.state === 'completed');
  return {
    date,
    completedCount: completed.length,
    completedMinutes: completed.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0),
    plannedMinutes: todays.reduce((sum, session) => sum + (session.plannedMinutes ?? 0), 0),
    remainingCount: todays.filter((session) => session.state === 'flexible' || session.state === 'in_progress').length,
  };
}

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
  const history = buildHistorySummary(state);
  const progress = buildTodayProgress(state, now);
  const focus = buildNowFocus(state, now);

  /**
   * 不再"没有待办就返回 null"。
   *
   * 旧逻辑只看待办任务，于是"任务都做完了"时上下文为空，
   * AI 对"我最近效率怎么样"这类问题只能回答"看不到"——
   * 而它本可以依据历史统计分析。现在只要有**任何**可用信息就发。
   */
  const hasAnything =
    active.length > 0 ||
    history.length > 0 ||
    progress.completedCount > 0 ||
    focus.current !== null ||
    focus.next !== null ||
    sessions.some((session) => session.date === progress.date);
  if (!hasAnything) return null;

  const entry = {
    date: now?.date ?? null,
    nowTime: focus.nowTime,
    latestSleepMinutes: Number.isInteger(state?.settings?.latestSleepMinutes) ? state.settings.latestSleepMinutes : null,
    todayProgress: progress,
    /**
     * 「此刻在做什么、这一段还剩多久」。
     * 与 todayProgress 的区别：progress 是"今天整体进度"，
     * focus 是"眼下这一段还剩多少时间"，用来回答"还剩多久"。
     */
    currentFocus: focus.current,
    nextSession: focus.next,
    history,
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

  const active = tasks.filter((task) => task.status === 'not_started' || task.status === 'in_progress');
  const history = buildHistorySummary(state);
  const progress = buildTodayProgress(state, now);
  const focus = buildNowFocus(state, now);

  /**
   * 旧逻辑在"没有待办任务"时直接返回空串，导致 AI 对任何问题都答"看不到"。
   * 但"任务都做完了"恰恰是最需要看历史的时候（"我最近效率怎么样"）。
   * 现在只要有任何一项信息就构造上下文。
   */
  const hasAnything = active.length > 0 || history.length > 0 || progress.completedCount > 0;
  if (!hasAnything) return '';

  const today = now?.date ?? '';
  const lines = [];
  lines.push(`今天：${today}`);
  if (focus.nowTime) lines.push(`现在：${focus.nowTime}`);

  /**
   * 「此刻进度」单独成段，并直接给出算好的分钟数。
   *
   * 这段是为了回答"还剩多久"这类问题：模型如果只拿到"剩余工作量 60 分钟"，
   * 就会忽略已经开始的时间。这里把"这一段的剩余分钟"算好写清楚，
   * 并在同一行提示优先使用该数字，避免模型自己推算。
   */
  if (focus.current) {
    const c = focus.current;
    const taskTitle = tasks.find((task) => task.id === c.taskId)?.title;
    lines.push(
      `正在进行的时段：${taskTitle ? `${taskTitle}　` : ''}${c.start}–${c.end}，共 ${c.totalMinutes} 分钟，已过去 ${c.elapsedMinutes} 分钟，**还剩 ${c.remainingMinutes} 分钟**。`,
    );
    lines.push('（若被问到"还剩多久"，请使用上面这个"还剩 N 分钟"，不要用任务的总时长或剩余工作量回答。）');
  } else if (focus.next) {
    const n = focus.next;
    const taskTitle = tasks.find((task) => task.id === n.taskId)?.title;
    lines.push(`下一段：${taskTitle ? `${taskTitle}　` : ''}${n.start} 开始（还有 ${n.minutesUntil} 分钟）。`);
  } else if (now?.minutes != null) {
    lines.push('当前没有正在进行或今天稍后的学习时段。');
  }

  // —— 今日进度 ——
  if (progress.completedCount > 0 || progress.plannedMinutes > 0) {
    const parts = [];
    if (progress.completedCount > 0) parts.push(`已完成 ${progress.completedCount} 段，共 ${progress.completedMinutes} 分钟`);
    if (progress.plannedMinutes > 0) parts.push(`今日计划 ${progress.plannedMinutes} 分钟`);
    if (progress.remainingCount > 0) parts.push(`还有 ${progress.remainingCount} 段待完成`);
    lines.push(`今日进度：${parts.join('，') || '暂无记录'}`);
  } else {
    lines.push('今日进度：今天还没有学习记录');
  }

  // —— 待办任务（最多 8 个）——
  if (active.length > 0) {
    lines.push('待办任务：');
    const sorted = [...active].sort((a, b) =>
      `${a.deadlineDate}${a.deadlineTime}`.localeCompare(`${b.deadlineDate}${b.deadlineTime}`),
    );
    for (const task of sorted.slice(0, 8)) {
      const done = sessions
        .filter((session) => session.taskId === task.id && session.state === 'completed')
        .reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
      const remaining = Math.max(0, (task.plannedMinutes ?? 0) - done);
      lines.push(
        `- ${task.title}（${task.subject}）：剩余约 ${remaining} 分钟，截止 ${task.deadlineDate} ${task.deadlineTime}，重要度 ${task.importance}/5`,
      );
    }
    if (active.length > 8) lines.push(`（另有 ${active.length - 8} 个任务未列出）`);
  } else {
    lines.push('待办任务：当前没有未完成的任务（都已完成或已删除）。');
  }

  // —— 历史用时（按科目聚合，不发原始记录）——
  if (history.length > 0) {
    lines.push('历史用时（按科目聚合）：');
    for (const item of history) {
      const label =
        item.tendency === 'underestimated' ? '常被低估' : item.tendency === 'overestimated' ? '常被高估' : '基本准确';
      const reliability = item.reliable ? '' : '（样本较少，仅供参考）';
      lines.push(
        `- ${item.subject}：${item.sampleCount} 次，平均预计 ${item.meanPlannedMinutes} 分钟 / 实际 ${item.meanActualMinutes} 分钟，${label}${reliability}`,
      );
    }
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
