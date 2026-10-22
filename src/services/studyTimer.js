/**
 * 学习任务计时器的状态机（纯函数 + 一层本地持久化）。
 *
 * 两种模式共用一套"已专注秒数"的算法：
 *   elapsed = (now - startedAt - pausedAccumMs - 本次暂停时长) / 1000
 *
 * - 倒计时：`targetAt` 记录绝对结束时刻，显示 `plannedSeconds - elapsed`；
 * - 正计时：`targetAt = null`，显示 `elapsed`，超过计划也不自动结束；
 * - 圆环表示**已完成进度**（elapsed / plannedSeconds），倒计时模式下数字减少但圆环在填充。
 *
 * 所有函数都可注入 `now`，测试不需要真实等待；模块顶层不访问 window/AudioContext。
 */

export const TIMER_STORAGE_KEY = 'studyPlanner:v1:studyTimer';
export const PREFS_STORAGE_KEY = 'studyPlanner:v1:studyTimerPrefs';

export const TIMER_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  EXPIRED: 'expired',
});

export const TIMER_MODE = Object.freeze({
  COUNTDOWN: 'countdown',
  COUNTUP: 'countup',
});

/** 计时盘几何：与花园番茄钟一致（viewBox 300×300、半径 144） */
export const RING_RADIUS = 144;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** 空闲时至少画出这么多弧度，避免看起来像没渲染 */
export const MIN_PROGRESS = 0.035;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* ================================================================== *
 * 创建与状态推进
 * ================================================================== */

/**
 * 开始一次计时。
 *
 * @param {{plannerId: string, gardenId?: string|null, title?: string, minutes?: number, mode?: string}} task
 * @param {number} nowMs
 */
export function startTimer(task, nowMs) {
  const minutes = Math.max(1, Math.round(task.minutes ?? 25));
  const plannedSeconds = minutes * 60;
  const mode = task.mode === TIMER_MODE.COUNTUP ? TIMER_MODE.COUNTUP : TIMER_MODE.COUNTDOWN;
  return {
    plannerId: String(task.plannerId ?? ''),
    gardenId: task.gardenId ?? null,
    title: String(task.title ?? '学习任务'),
    plannedSeconds,
    mode,
    status: TIMER_STATUS.RUNNING,
    startedAt: nowMs,
    pausedAccumMs: 0,
    pauseStartedAt: null,
    // 只有倒计时需要绝对结束时刻
    targetAt: mode === TIMER_MODE.COUNTDOWN ? nowMs + plannedSeconds * 1000 : null,
    restored: false,
  };
}

/** 暂停：记录本次暂停起点 */
export function pauseTimer(timer, nowMs) {
  if (!timer || timer.status !== TIMER_STATUS.RUNNING) return timer;
  return { ...timer, status: TIMER_STATUS.PAUSED, pauseStartedAt: nowMs };
}

/** 继续：把暂停时长补进累加值；倒计时同时把 targetAt 后移，保证剩余时间不跳变 */
export function resumeTimer(timer, nowMs) {
  if (!timer || timer.status !== TIMER_STATUS.PAUSED) return timer;
  const pausedMs = timer.pauseStartedAt === null ? 0 : Math.max(0, nowMs - timer.pauseStartedAt);
  return {
    ...timer,
    status: TIMER_STATUS.RUNNING,
    pauseStartedAt: null,
    pausedAccumMs: (timer.pausedAccumMs ?? 0) + pausedMs,
    targetAt: timer.targetAt === null ? null : timer.targetAt + pausedMs,
  };
}

/**
 * 按当前时间推进状态。
 *
 * 只对**倒计时**生效：到点后进入 `expired`（待用户确认），**不会**自动写完成数据。
 * 正计时永远停在 `running`，直到用户点「完成专注」。
 */
export function advanceTimer(timer, nowMs) {
  if (!timer) return timer;
  if (timer.status !== TIMER_STATUS.RUNNING) return timer;
  if (timer.mode === TIMER_MODE.COUNTUP) return timer;
  if (timer.targetAt === null) return timer;
  if (nowMs < timer.targetAt) return timer;
  return { ...timer, status: TIMER_STATUS.EXPIRED };
}

/* ================================================================== *
 * 计算
 * ================================================================== */

/** 已专注秒数（暂停期间不增长） */
export function computeElapsedSeconds(timer, nowMs) {
  if (!timer) return 0;
  const end = timer.status === TIMER_STATUS.PAUSED ? (timer.pauseStartedAt ?? nowMs) : nowMs;
  const usedMs = Math.max(0, end - timer.startedAt - (timer.pausedAccumMs ?? 0));
  return Math.floor(usedMs / 1000);
}

/** 圆环进度：elapsed / plannedSeconds，限制在 0–1 */
export function computeProgress(elapsedSeconds, plannedSeconds) {
  if (!Number.isFinite(plannedSeconds) || plannedSeconds <= 0) return 0;
  return clamp(elapsedSeconds / plannedSeconds, 0, 1);
}

/**
 * 时间数字显示用秒数。
 * - 倒计时：`plannedSeconds - elapsed`，不小于 0；
 * - 正计时：`elapsed`，一直增长。
 */
export function computeDisplaySeconds(timer, nowMs) {
  if (!timer) return 0;
  const elapsed = computeElapsedSeconds(timer, nowMs);
  if (timer.mode === TIMER_MODE.COUNTUP) return elapsed;
  return Math.max(0, timer.plannedSeconds - elapsed);
}

/** 圆环的 strokeDashoffset：进度越大，偏移越小（填得越满） */
export function ringDashOffset(progress) {
  return RING_CIRCUMFERENCE * (1 - clamp(progress, 0, 1));
}

/** 实际绘制用的进度（空闲时保底 3.5%） */
export function drawableProgress(progress) {
  return Math.max(clamp(progress, 0, 1), MIN_PROGRESS);
}

/**
 * 秒 → 时间文本。
 *
 * - 默认：满 1 小时才显示小时位（`25:00`、`1:30:00`）；
 * - `withHours: true`：强制显示小时位（`0:30:00`），用于"计划 ≥ 1 小时"的计时盘，
 *   避免数字宽度在同一场计时里跳来跳去。
 *
 * @param {number} totalSeconds
 * @param {{withHours?: boolean}} [options]
 */
export function formatStudyClock(totalSeconds, { withHours = false } = {}) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return withHours || hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 兼容旧调用：剩余秒数 */
export function remainingSeconds(timer, nowMs) {
  if (!timer) return 0;
  const advanced = advanceTimer(timer, nowMs);
  if (advanced.status === TIMER_STATUS.EXPIRED) return 0;
  return computeDisplaySeconds(advanced, nowMs);
}

/** 兼容旧调用：已用秒数 */
export function elapsedSeconds(timer, nowMs) {
  return computeElapsedSeconds(timer, nowMs);
}

/** 是否已到时间（仅倒计时） */
export function isExpired(timer, nowMs) {
  return advanceTimer(timer, nowMs)?.status === TIMER_STATUS.EXPIRED;
}

/** 是否超过计划（正计时用） */
export function overrunSeconds(timer, nowMs) {
  if (!timer || timer.mode !== TIMER_MODE.COUNTUP) return 0;
  return Math.max(0, computeElapsedSeconds(timer, nowMs) - timer.plannedSeconds);
}

/* ================================================================== *
 * 模式切换
 * ================================================================== */

/**
 * 切换计时模式，**保留已经专注的时间**。
 *
 * - 倒计时 → 正计时：清掉 targetAt，已过时间不变；
 * - 正计时 → 倒计时：`targetAt = now + max(0, 计划 - 已过) × 1000`；
 *   若已超过计划，剩余为 0 → 立即进入 `expired`（待确认），不会出现负数。
 */
export function switchMode(timer, mode, nowMs) {
  if (!timer) return timer;
  const nextMode = mode === TIMER_MODE.COUNTUP ? TIMER_MODE.COUNTUP : TIMER_MODE.COUNTDOWN;
  if (timer.mode === nextMode) return timer;

  const elapsed = computeElapsedSeconds(timer, nowMs);
  if (nextMode === TIMER_MODE.COUNTUP) {
    return { ...timer, mode: nextMode, targetAt: null, status: timer.status === TIMER_STATUS.EXPIRED ? TIMER_STATUS.RUNNING : timer.status };
  }

  const remaining = Math.max(0, timer.plannedSeconds - elapsed);
  const expired = remaining <= 0;
  return {
    ...timer,
    mode: nextMode,
    targetAt: nowMs + remaining * 1000,
    status: expired ? TIMER_STATUS.EXPIRED : timer.status === TIMER_STATUS.EXPIRED ? TIMER_STATUS.RUNNING : timer.status,
  };
}

/** 停止/放弃：返回 null（持久化层据此删除键） */
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

/**
 * 从持久化数据恢复计时状态。
 *
 * @param {unknown} raw 已解析的 JSON
 * @param {number} nowMs
 * @returns {object|null}
 */
export function restoreStudyTimer(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (typeof source.plannerId !== 'string' || !source.plannerId) return null;
  if (!Number.isFinite(source.startedAt)) return null;

  const mode = source.mode === TIMER_MODE.COUNTUP ? TIMER_MODE.COUNTUP : TIMER_MODE.COUNTDOWN;
  const plannedSeconds = Number.isFinite(source.plannedSeconds)
    ? Math.max(1, Math.round(source.plannedSeconds))
    : Number.isFinite(source.minutes)
      ? Math.max(1, Math.round(source.minutes)) * 60
      : 1500;

  const status = Object.values(TIMER_STATUS).includes(/** @type {string} */ (source.status))
    ? /** @type {string} */ (source.status)
    : TIMER_STATUS.RUNNING;

  const timer = {
    plannerId: source.plannerId,
    gardenId: typeof source.gardenId === 'string' ? source.gardenId : null,
    title: typeof source.title === 'string' ? source.title : '学习任务',
    plannedSeconds,
    mode,
    status,
    startedAt: /** @type {number} */ (source.startedAt),
    pausedAccumMs: Number.isFinite(source.pausedAccumMs) ? /** @type {number} */ (source.pausedAccumMs) : 0,
    pauseStartedAt: Number.isFinite(source.pauseStartedAt) ? /** @type {number} */ (source.pauseStartedAt) : null,
    targetAt: Number.isFinite(source.targetAt) ? /** @type {number} */ (source.targetAt) : null,
    restored: true,
  };

  // 倒计时缺 targetAt 时按"剩余 = 计划 - 已过"补出来
  if (timer.mode === TIMER_MODE.COUNTDOWN && timer.targetAt === null) {
    const elapsed = computeElapsedSeconds(timer, nowMs);
    timer.targetAt = nowMs + Math.max(0, plannedSeconds - elapsed) * 1000;
  }

  const advanced = advanceTimer(timer, nowMs);
  return advanced;
}

/** 读取持久化的计时状态 */
export function loadTimer(nowMs = Date.now()) {
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
  return restoreStudyTimer(parsed, nowMs);
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

/* ================================================================== *
 * 偏好（模式、背景音、提示音）—— 第一阶段只用 mode
 * ================================================================== */

export const DEFAULT_PREFS = Object.freeze({
  mode: TIMER_MODE.COUNTDOWN,
  ambient: 'off',
  ambientVolume: 0.35,
  chime: 'bell',
  chimeEnabled: true,
  chimeVolume: 0.5,
});

/** 读取偏好，损坏或缺失时回退默认值 */
export function loadPrefs() {
  const store = storage();
  if (!store) return { ...DEFAULT_PREFS };
  let raw = null;
  try {
    raw = store.getItem(PREFS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (!raw) return { ...DEFAULT_PREFS };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };

  return {
    mode: parsed.mode === TIMER_MODE.COUNTUP ? TIMER_MODE.COUNTUP : TIMER_MODE.COUNTDOWN,
    ambient: typeof parsed.ambient === 'string' ? parsed.ambient : DEFAULT_PREFS.ambient,
    ambientVolume: Number.isFinite(parsed.ambientVolume) ? clamp(parsed.ambientVolume, 0, 1) : DEFAULT_PREFS.ambientVolume,
    chime: typeof parsed.chime === 'string' ? parsed.chime : DEFAULT_PREFS.chime,
    chimeEnabled: parsed.chimeEnabled !== false,
    chimeVolume: Number.isFinite(parsed.chimeVolume) ? clamp(parsed.chimeVolume, 0, 1) : DEFAULT_PREFS.chimeVolume,
  };
}

/** 保存偏好 */
export function savePrefs(prefs) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(PREFS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_PREFS, ...prefs }));
    return true;
  } catch {
    return false;
  }
}
