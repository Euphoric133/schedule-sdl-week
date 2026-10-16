/**
 * 番茄钟计时状态的纯函数层。
 *
 * 单独抽出来的原因：这是全项目**唯一**对时间精度有硬要求的地方，
 * 必须能被单元测试直接覆盖（给定时间戳 → 给定的剩余秒数），
 * 而不需要启动整个应用或等待真实时间流逝。
 *
 * 核心不变量：
 * - `endsAtMs` 是阶段结束的**绝对时间戳**，唯一的时间真相；
 * - 暂停时把剩余秒数冻结在 `pausedRemainingSeconds`，恢复时重新锚定 `endsAtMs`；
 * - 任何派生值（剩余秒数、进度）都由"当前时间戳 + 状态"算出，从不累加计数器。
 */

export const FOCUS_PHASE = Object.freeze({
  IDLE: 'idle',
  FOCUS: 'focus',
  SHORT_BREAK: 'short_break',
  LONG_BREAK: 'long_break',
});

/** 一个阶段的默认时长（秒），用于自动进入下一阶段 */
export function phaseDurationSeconds(phase, config) {
  switch (phase) {
    case FOCUS_PHASE.SHORT_BREAK:
      return Math.max(60, (config.shortBreakMinutes ?? 5) * 60);
    case FOCUS_PHASE.LONG_BREAK:
      return Math.max(60, (config.longBreakMinutes ?? 15) * 60);
    case FOCUS_PHASE.FOCUS:
    default:
      return Math.max(60, (config.focusMinutes ?? 25) * 60);
  }
}

/**
 * 创建一个新的计时状态。
 * @param {object} input
 * @param {string} input.phase
 * @param {number} input.durationSeconds
 * @param {number} input.startedAtMs 真实毫秒时间戳
 */
export function createTimerState({
  phase = FOCUS_PHASE.IDLE,
  durationSeconds = 25 * 60,
  startedAtMs = 0,
  sessionId = null,
  taskId = null,
  taskTitle = null,
  round = 0,
  config = {},
} = {}) {
  return {
    phase,
    durationSeconds,
    startedAtMs,
    endsAtMs: phase === FOCUS_PHASE.IDLE ? null : startedAtMs + durationSeconds * 1000,
    paused: false,
    pausedRemainingSeconds: null,
    pausedAtMs: null,
    accumulatedPausedMs: 0,
    sessionId,
    taskId,
    taskTitle,
    round,
    updatedAtMs: startedAtMs,
    config: {
      focusMinutes: config.focusMinutes ?? 25,
      shortBreakMinutes: config.shortBreakMinutes ?? 5,
      longBreakMinutes: config.longBreakMinutes ?? 15,
      roundsBeforeLongBreak: config.roundsBeforeLongBreak ?? 4,
      autoStartNext: Boolean(config.autoStartNext),
    },
    /** 已经自动推进过的阶段结束时间戳，避免同一次结束被处理两遍 */
    lastAutoAdvanceFromMs: null,
  };
}

/**
 * 归一化：把存储里读出的状态修正成"与真实时间一致"的状态。
 *
 * 这个函数是"刷新后计时不漂移"的关键：它不依赖任何事件，
 * 只根据当前时间戳判断"这个阶段是不是早就该结束了"。
 *
 * @param {object|null} stored
 * @param {number} nowMs
 */
export function normalizeTimerState(stored, nowMs) {
  if (!stored || typeof stored !== 'object' || !stored.phase) {
    return createTimerState({ startedAtMs: nowMs });
  }
  const state = { ...stored };

  if (state.phase === FOCUS_PHASE.IDLE) {
    return { ...state, endsAtMs: null, paused: false, pausedRemainingSeconds: null };
  }

  // 正在进行且没有暂停：结束时间戳保持不变即可，剩余时间是"算"出来的
  if (!state.paused && Number.isFinite(state.endsAtMs)) {
    return state;
  }

  // 暂停状态：剩余时间冻结在暂停时刻，不随时间流逝
  if (state.paused) {
    const frozen = Number.isFinite(state.pausedRemainingSeconds)
      ? state.pausedRemainingSeconds
      : Math.max(0, Math.round(((state.endsAtMs ?? nowMs) - nowMs) / 1000));
    return { ...state, pausedRemainingSeconds: frozen };
  }

  // 数据不完整（例如被外部改坏）：按剩余 0 处理，让用户重新开始，而不是给出错误的倒计时
  return { ...state, endsAtMs: nowMs, paused: false, pausedRemainingSeconds: null };
}

/**
 * 剩余秒数（唯一计算入口）。
 * - 暂停中：返回冻结值；
 * - 进行中：`(endsAtMs - nowMs) / 1000`，下限 0。
 */
export function remainingSecondsOf(state, nowMs) {
  if (!state || state.phase === FOCUS_PHASE.IDLE) return 0;
  if (state.paused) {
    return Math.max(0, Math.round(state.pausedRemainingSeconds ?? state.durationSeconds ?? 0));
  }
  if (!Number.isFinite(state.endsAtMs)) return 0;
  return Math.max(0, Math.round((state.endsAtMs - nowMs) / 1000));
}

/** 阶段是否已经在真实时间上走完（页面被节流或休眠后仍然正确） */
export function hasPhaseElapsed(state, nowMs) {
  if (!state || state.phase === FOCUS_PHASE.IDLE || state.paused) return false;
  return Number.isFinite(state.endsAtMs) && nowMs >= state.endsAtMs;
}

/** 已过去的秒数 */
export function elapsedSecondsOf(state, nowMs) {
  if (!state || state.phase === FOCUS_PHASE.IDLE) return 0;
  const duration = state.durationSeconds ?? 0;
  return Math.max(0, Math.min(duration, duration - remainingSecondsOf(state, nowMs)));
}

/** 进度 0–1 */
export function progressOf(state, nowMs) {
  const duration = state?.durationSeconds ?? 0;
  if (!state || duration <= 0) return 0;
  return Math.min(1, Math.max(0, elapsedSecondsOf(state, nowMs) / duration));
}

/** 秒数 → mm:ss（超过一小时显示 h:mm:ss） */
export function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
