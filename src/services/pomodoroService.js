/**
 * 番茄钟服务：阶段状态机 + 真实时间戳计时 + 可信记录。
 *
 * 三条硬性要求，任何实现都不能违反：
 *
 * 1. **必须用真实时间戳算剩余时间**，不能用"每秒减一"的计数器。
 *    计数器在标签页被节流、电脑休眠或页面刷新后必然漂移；
 *    而"结束时刻的绝对时间戳"无论中间发生什么都是对的。
 *
 * 2. **只有真实完成的专注才计入统计**。中途结束记为"提前结束"（`endedEarly`），
 *    不会被计入完成的番茄轮数。绝不虚报。
 *
 * 3. **一轮番茄钟完成 ≠ 任务完成**。计时结束只更新"已投入时长"，
 *    不会自动把任务标记为已完成——那是用户的决定。
 *
 * 状态放在偏好存储里（设备级、体积小、需要同步读取），
 * 而每一条完成的专注记录会**同时**写入业务数据（appState.sessions），
 * 因为它是"学习事实"，必须参与剩余工作量与统计的推导。
 */

import { FOCUS_PHASE, createTimerState, normalizeTimerState, remainingSecondsOf, phaseDurationSeconds } from './pomodoroTimer.js';

export { FOCUS_PHASE };

export const PHASE_LABELS_ZH = Object.freeze({
  [FOCUS_PHASE.FOCUS]: '专注',
  [FOCUS_PHASE.SHORT_BREAK]: '短休息',
  [FOCUS_PHASE.LONG_BREAK]: '长休息',
});

export const END_REASON = Object.freeze({
  COMPLETED: 'completed', // 自然走完整个阶段
  SKIPPED: 'skipped', // 用户手动跳过
  STOPPED: 'stopped', // 用户中途停止
});

/**
 * @param {object} options
 * @param {object} options.appearanceService 读写偏好（计时状态存这里）
 * @param {object} options.app 业务状态容器
 * @param {Function} options.now 返回 { date, minutes }（注入固定时钟便于测试）
 * @param {Function} options.nowMs 返回真实毫秒时间戳（计时精度的唯一来源）
 */
export function createPomodoroService({ appearanceService, app, now, nowMs }) {
  const listeners = new Set();
  let recordSink = null; // 完成记录的写入回调（由入口注入，避免循环依赖）

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(getTimer());
      } catch {
        /* 忽略单个订阅者错误 */
      }
    }
  };

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 读取计时状态（每次读取都对状态做一次归一化，保证显示与真实时间一致） */
  function getTimer() {
    const prefs = appearanceService.getPreferences();
    return normalizeTimerState(prefs.focus?.timer ?? null, nowMs());
  }

  function writeTimer(timer) {
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      focus: { ...prefs.focus, timer },
    }));
    notify();
  }

  function readConfig() {
    const focus = appearanceService.getPreferences().focus;
    return {
      focusMinutes: focus.focusMinutes,
      shortBreakMinutes: focus.shortBreakMinutes,
      longBreakMinutes: focus.longBreakMinutes,
      roundsBeforeLongBreak: focus.roundsBeforeLongBreak,
      autoStartNext: focus.autoStartNext,
    };
  }

  function setConfig(patch = {}) {
    const clamp = (value, min, max, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    };
    const current = readConfig();
    const next = {
      focusMinutes: clamp(patch.focusMinutes, 1, 180, current.focusMinutes),
      shortBreakMinutes: clamp(patch.shortBreakMinutes, 1, 60, current.shortBreakMinutes),
      longBreakMinutes: clamp(patch.longBreakMinutes, 1, 120, current.longBreakMinutes),
      roundsBeforeLongBreak: clamp(patch.roundsBeforeLongBreak, 1, 12, current.roundsBeforeLongBreak),
      autoStartNext: patch.autoStartNext === undefined ? current.autoStartNext : Boolean(patch.autoStartNext),
    };
    appearanceService.updatePreferences((prefs) => ({ ...prefs, focus: { ...prefs.focus, ...next } }));
    return { ok: true, config: next };
  }

  /**
   * 开始一个新的专注阶段。
   * @param {object} options
   * @param {string|null} options.sessionId 关联的学习时段（可选）
   * @param {string|null} options.taskId
   */
  function startFocus({ sessionId = null, taskId = null, taskTitle = null } = {}) {
    const config = readConfig();
    const timestamp = nowMs();
    const timer = createTimerState({
      phase: FOCUS_PHASE.FOCUS,
      durationSeconds: config.focusMinutes * 60,
      startedAtMs: timestamp,
      sessionId,
      taskId,
      taskTitle,
      round: (getTimer().round ?? 0) + 0,
      config,
    });
    writeTimer(timer);
    return { ok: true, timer };
  }

  /** 开始休息阶段（短或长） */
  function startBreak({ long = false } = {}) {
    const config = readConfig();
    const timestamp = nowMs();
    const previous = getTimer();
    const timer = createTimerState({
      phase: long ? FOCUS_PHASE.LONG_BREAK : FOCUS_PHASE.SHORT_BREAK,
      durationSeconds: (long ? config.longBreakMinutes : config.shortBreakMinutes) * 60,
      startedAtMs: timestamp,
      sessionId: previous.sessionId ?? null,
      taskId: previous.taskId ?? null,
      taskTitle: previous.taskTitle ?? null,
      round: previous.round ?? 0,
      config,
    });
    writeTimer(timer);
    return { ok: true, timer };
  }

  function pause() {
    const timer = getTimer();
    if (timer.phase === FOCUS_PHASE.IDLE) return { ok: false, message: '当前没有正在进行的计时。' };
    if (timer.paused) return { ok: true, timer, alreadyPaused: true };
    const timestamp = nowMs();
    const pausedTimer = {
      ...timer,
      paused: true,
      // 记录暂停时刻的剩余秒数：恢复时以此为准，暂停期间的时间不计入
      pausedRemainingSeconds: remainingSecondsOf(timer, timestamp),
      updatedAtMs: timestamp,
    };
    writeTimer(pausedTimer);
    return { ok: true, timer: pausedTimer };
  }

  function resume() {
    const timer = getTimer();
    if (timer.phase === FOCUS_PHASE.IDLE) return { ok: false, message: '当前没有正在进行的计时。' };
    if (!timer.paused) return { ok: true, timer, alreadyRunning: true };

    const timestamp = nowMs();
    const remaining = Math.max(0, Math.round(timer.pausedRemainingSeconds ?? timer.durationSeconds));
    const resumed = {
      ...timer,
      paused: false,
      // 关键：把"结束时刻"重新锚定到真实时间戳上，暂停的那段时间不会被算进去
      endsAtMs: timestamp + remaining * 1000,
      pausedRemainingSeconds: null,
      accumulatedPausedMs: (timer.accumulatedPausedMs ?? 0) + Math.max(0, timestamp - (timer.pausedAtMs ?? timestamp)),
      pausedAtMs: null,
      updatedAtMs: timestamp,
    };
    writeTimer(resumed);
    return { ok: true, timer: resumed };
  }

  /** 暂停时记录暂停发生的时刻（供累计暂停时长使用） */
  function markPausedAt() {
    const timer = getTimer();
    if (timer.paused && !timer.pausedAtMs) {
      const updated = { ...timer, pausedAtMs: nowMs() };
      writeTimer(updated);
      return updated;
    }
    return timer;
  }

  /**
   * 结束当前阶段。
   * @param {object} options
   * @param {string} options.reason END_REASON 之一
   * @returns {{ok: boolean, phase: string, focusedSeconds: number, completed: boolean, record?: object, message?: string}}
   */
  function endPhase({ reason = END_REASON.STOPPED } = {}) {
    const timestamp = nowMs();
    const timer = getTimer();
    if (timer.phase === FOCUS_PHASE.IDLE) return { ok: false, message: '当前没有正在进行的计时。' };

    const remaining = remainingSecondsOf(timer, timestamp);
    const elapsedSeconds = Math.max(0, timer.durationSeconds - remaining);
    const isFocus = timer.phase === FOCUS_PHASE.FOCUS;
    // 只有"专注阶段自然走完"才算一个完整番茄；中途停止一律记为提前结束
    const completed = reason === END_REASON.COMPLETED && isFocus && remaining <= 0;

    const config = readConfig();
    const nextRound = isFocus && completed ? (timer.round ?? 0) + 1 : timer.round ?? 0;
    const shouldLongBreak = isFocus && completed && nextRound > 0 && nextRound % config.roundsBeforeLongBreak === 0;

    // 下一个阶段由用户控制；只有开启"自动进入下一阶段"时才自动启动
    let nextPhase = null;
    if (reason === END_REASON.COMPLETED) {
      nextPhase = isFocus ? (shouldLongBreak ? FOCUS_PHASE.LONG_BREAK : FOCUS_PHASE.SHORT_BREAK) : FOCUS_PHASE.FOCUS;
    }

    const idle = createTimerState({
      phase: config.autoStartNext && nextPhase ? nextPhase : FOCUS_PHASE.IDLE,
      durationSeconds: config.autoStartNext && nextPhase
        ? phaseDurationSeconds(nextPhase, config)
        : config.focusMinutes * 60,
      startedAtMs: timestamp,
      sessionId: timer.sessionId,
      taskId: timer.taskId,
      taskTitle: timer.taskTitle,
      round: nextRound,
      config,
    });

    writeTimer(idle);

    const result = {
      ok: true,
      phase: timer.phase,
      focusedSeconds: isFocus ? elapsedSeconds : 0,
      elapsedSeconds,
      completed,
      round: nextRound,
      nextPhase,
      autoStarted: Boolean(config.autoStartNext && nextPhase),
      reason,
      sessionId: timer.sessionId,
      taskId: timer.taskId,
      taskTitle: timer.taskTitle,
    };

    // 只把**专注阶段的真实投入**写成学习记录（休息阶段不记录）
    if (isFocus && elapsedSeconds >= 60) {
      recordSink?.({ ...result, date: now().date });
    }

    return result;
  }

  /** 放弃当前阶段（不写入任何记录） */
  function discard() {
    const config = readConfig();
    const timer = getTimer();
    writeTimer(
      createTimerState({
        phase: FOCUS_PHASE.IDLE,
        durationSeconds: config.focusMinutes * 60,
        startedAtMs: nowMs(),
        sessionId: timer.sessionId,
        taskId: timer.taskId,
        taskTitle: timer.taskTitle,
        round: timer.round,
        config,
      }),
    );
    return { ok: true };
  }

  /** 更换当前关联的任务（不打断计时） */
  function attachTask({ sessionId = null, taskId = null, taskTitle = null } = {}) {
    const timer = getTimer();
    const updated = { ...timer, sessionId, taskId, taskTitle, updatedAtMs: nowMs() };
    writeTimer(updated);
    return { ok: true, timer: updated };
  }

  /** 由入口注入"写入学习记录"的回调（避免服务之间直接依赖） */
  function setRecordSink(sink) {
    recordSink = sink;
  }

  /** 今天的番茄统计：全部来自真实记录，没有记录时如实为 0 */
  function todayStats() {
    const state = app.getState();
    const today = now().date;
    const records = (state.focusRecords ?? []).filter((record) => record.date === today);
    const completed = records.filter((record) => record.completed);
    const early = records.filter((record) => !record.completed);
    return {
      completedRounds: completed.length,
      earlyEndedRounds: early.length,
      focusedMinutes: Math.round(records.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
      completedMinutes: Math.round(completed.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
      earlyMinutes: Math.round(early.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
      records,
    };
  }

  /** 当前阶段进度（0–1），界面进度条使用 */
  function progress() {
    const timer = getTimer();
    if (timer.phase === FOCUS_PHASE.IDLE || timer.durationSeconds <= 0) return 0;
    const remaining = remainingSecondsOf(timer, nowMs());
    return Math.min(1, Math.max(0, 1 - remaining / timer.durationSeconds));
  }

  return {
    subscribe,
    getTimer,
    readConfig,
    setConfig,
    startFocus,
    startBreak,
    pause,
    resume,
    resumeMarkPause: markPausedAt,
    endPhase,
    discard,
    attachTask,
    setRecordSink,
    todayStats,
    progress,
    PHASE_LABELS_ZH,
  };
}

export { END_REASON as POMODORO_END_REASON };
