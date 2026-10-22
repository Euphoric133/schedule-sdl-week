/**
 * 学习任务计时器的状态逻辑（纯函数 + 一层本地持久化）。
 *
 * 设计要点：
 * - 计时用**绝对结束时刻** `targetAt`，剩余时间 = targetAt − now，因此后台降频不会漂移；
 * - 刷新/关闭页面后从 localStorage 恢复；已超时则进入 `expired`，**不自动**改任何数据，
 *   必须等用户确认（避免"页面一刷新就把任务标完成"）；
 * - 所有函数都可注入 `now`，测试不需要真的等待。
 */

/** 计时状态存放的键（与规划器其它数据同一命名空间，但独立一个键） */
export const TIMER_STORAGE_KEY = 'studyPlanner:v1:studyTimer';

export const TIMER_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  EXPIRED: 'expired',
});

/**
 * 开始一次计时。
 *
 * @param {{plannerId: string, gardenId?: string|null, title?: string, minutes: number}} task
 * @param {number} nowMs
 */
export function startTimer(task, nowMs) {
  const minutes = Math.max(1, Math.round(task.minutes ?? 25));
  return {
    plannerId: String(task.plannerId ?? ''),
    gardenId: task.gardenId ?? null,
    title: String(task.title ?? '学习任务'),
    minutes,
    status: TIMER_STATUS.RUNNING,
    startedAt: nowMs,
    targetAt: nowMs + minutes * 60_000,
    pausedAt: null,
    pausedAccumMs: 0,
  };
}

/** 暂停：记录暂停时刻，之后恢复时把暂停时长补回 targetAt */
export function pauseTimer(timer, nowMs) {
  if (!timer || timer.status !== TIMER_STATUS.RUNNING) return timer;
  return { ...timer, status: TIMER_STATUS.PAUSED, pausedAt: nowMs };
}

/** 恢复：把暂停期间的时间补回 targetAt，保证剩余时间不因暂停而减少 */
export function resumeTimer(timer, nowMs) {
  if (!timer || timer.status !== TIMER_STATUS.PAUSED) return timer;
  const pausedMs = timer.pausedAt === null ? 0 : Math.max(0, nowMs - timer.pausedAt);
  return {
    ...timer,
    status: TIMER_STATUS.RUNNING,
    pausedAt: null,
    pausedAccumMs: (timer.pausedAccumMs ?? 0) + pausedMs,
    targetAt: timer.targetAt === null ? null : timer.targetAt + pausedMs,
  };
}

/**
 * 按当前时间推进状态：running 且已到点 → expired。
 * 注意：**不会**自动完成，只把状态推进到"待确认"。
 */
export function advanceTimer(timer, nowMs) {
  if (!timer) return timer;
  if (timer.status !== TIMER_STATUS.RUNNING) return timer;
  if (timer.targetAt === null || nowMs < timer.targetAt) return timer;
  return { ...timer, status: TIMER_STATUS.EXPIRED };
}

/** 剩余秒数（已超时为 0，不返回负数） */
export function remainingSeconds(timer, nowMs) {
  if (!timer || timer.targetAt === null) return 0;
  const projected = advanceTimer(timer, nowMs);
  if (projected.status === TIMER_STATUS.EXPIRED) return 0;
  if (projected.status === TIMER_STATUS.PAUSED) {
    return Math.max(0, Math.round((timer.targetAt - (timer.pausedAt ?? nowMs)) / 1000));
  }
  return Math.max(0, Math.round((timer.targetAt - nowMs) / 1000));
}

/** 已用秒数（用于提前结束时记录实际专注时长） */
export function elapsedSeconds(timer, nowMs) {
  if (!timer) return 0;
  const end = timer.status === TIMER_STATUS.PAUSED ? (timer.pausedAt ?? nowMs) : nowMs;
  const usedMs = Math.max(0, end - timer.startedAt - (timer.pausedAccumMs ?? 0));
  return Math.round(usedMs / 1000);
}

/** 是否"到点待确认" */
export function isExpired(timer, nowMs) {
  return advanceTimer(timer, nowMs)?.status === TIMER_STATUS.EXPIRED;
}

/** 停止/放弃：清空（持久化层据此删除键） */
export function clearTimer() {
  return null;
}

/* ================================================================== *
 * 持久化
 * ================================================================== */

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读取并规范化持久化的计时状态 */
export function loadTimer() {
  const store = storage();
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(TIMER_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.plannerId !== 'string' || !parsed.plannerId) return null;
  if (!Number.isFinite(parsed.targetAt) || !Number.isFinite(parsed.startedAt)) return null;

  const status = Object.values(TIMER_STATUS).includes(parsed.status) ? parsed.status : TIMER_STATUS.RUNNING;
  return {
    plannerId: parsed.plannerId,
    gardenId: typeof parsed.gardenId === 'string' ? parsed.gardenId : null,
    title: typeof parsed.title === 'string' ? parsed.title : '学习任务',
    minutes: Number.isFinite(parsed.minutes) ? parsed.minutes : 25,
    status,
    startedAt: parsed.startedAt,
    targetAt: parsed.targetAt,
    pausedAt: Number.isFinite(parsed.pausedAt) ? parsed.pausedAt : null,
    pausedAccumMs: Number.isFinite(parsed.pausedAccumMs) ? parsed.pausedAccumMs : 0,
  };
}

/** 写入（timer 为 null 时删除键） */
export function saveTimer(timer) {
  const store = storage();
  if (!store) return false;
  try {
    if (!timer) {
      store.removeItem(TIMER_STORAGE_KEY);
    } else {
      store.setItem(TIMER_STORAGE_KEY, JSON.stringify(timer));
    }
    return true;
  } catch {
    return false;
  }
}
