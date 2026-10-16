/**
 * 番茄钟计时精度测试。
 *
 * 这是全项目对时间正确性要求最高的部分，因此直接针对纯函数层测试，
 * 用**构造的时间戳**模拟各种真实场景：正常流逝、标签页被节流、电脑休眠、
 * 暂停与恢复、以及从存储恢复（刷新页面）。
 *
 * 判定标准只有一条：剩余时间必须由"结束时刻的绝对时间戳"算出，
 * 而不是靠累计"每秒减一"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUS_PHASE,
  createTimerState,
  elapsedSecondsOf,
  formatSeconds,
  hasPhaseElapsed,
  normalizeTimerState,
  phaseDurationSeconds,
  progressOf,
  remainingSecondsOf,
} from '../../src/services/pomodoroTimer.js';

const T0 = 1_700_000_000_000; // 固定起点，避免依赖真实时间
const MINUTE = 60_000;

/* ------------------------------------------------------------------ *
 * 基本计时
 * ------------------------------------------------------------------ */

test('计时：剩余时间由结束时间戳算出，随时间线性减少', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });

  assert.equal(remainingSecondsOf(state, T0), 1500);
  assert.equal(remainingSecondsOf(state, T0 + 60_000), 1440);
  assert.equal(remainingSecondsOf(state, T0 + 5 * MINUTE), 1200);
  assert.equal(remainingSecondsOf(state, T0 + 24 * MINUTE), 60);
  assert.equal(remainingSecondsOf(state, T0 + 25 * MINUTE), 0);
  assert.equal(remainingSecondsOf(state, T0 + 60 * MINUTE), 0, '超时后不会变成负数');
});

test('计时：页面被节流 10 分钟（每秒回调没跑）后剩余时间依然正确', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  // 假设浏览器完全冻结了 10 分钟，期间没有任何 tick
  const afterThrottle = T0 + 10 * MINUTE;
  assert.equal(remainingSecondsOf(state, afterThrottle), 900, '不依赖 tick 次数，因此不会漂移');
  assert.equal(elapsedSecondsOf(state, afterThrottle), 600);
});

test('计时：电脑休眠 40 分钟后阶段已经到时间', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  const afterSleep = T0 + 40 * MINUTE;
  assert.equal(hasPhaseElapsed(state, afterSleep), true);
  assert.equal(remainingSecondsOf(state, afterSleep), 0);
});

test('计时：进度从 0 走到 1 并且不会越界', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 100, startedAtMs: T0 });
  assert.equal(progressOf(state, T0), 0);
  assert.equal(progressOf(state, T0 + 50_000), 0.5);
  assert.equal(progressOf(state, T0 + 100_000), 1);
  assert.equal(progressOf(state, T0 + 500_000), 1, '超时后进度不会超过 1');
});

/* ------------------------------------------------------------------ *
 * 暂停与恢复
 * ------------------------------------------------------------------ */

test('暂停：剩余时间被冻结，暂停期间不流逝', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  // 5 分钟时暂停，剩余 20 分钟
  const paused = { ...state, paused: true, pausedRemainingSeconds: 1200, pausedAtMs: T0 + 5 * MINUTE };

  assert.equal(remainingSecondsOf(paused, T0 + 5 * MINUTE), 1200);
  assert.equal(remainingSecondsOf(paused, T0 + 30 * MINUTE), 1200, '暂停 25 分钟后剩余时间不变');
  assert.equal(remainingSecondsOf(paused, T0 + 3 * 60 * MINUTE), 1200, '暂停 3 小时后依然不变');
  assert.equal(hasPhaseElapsed(paused, T0 + 60 * MINUTE), false, '暂停中不会被判定为已到时间');
});

test('恢复：重新锚定结束时间戳，暂停的那段时间不计入专注', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  const pausedAt = T0 + 5 * MINUTE;
  const paused = { ...state, paused: true, pausedRemainingSeconds: 1200, pausedAtMs: pausedAt };

  // 20 分钟后恢复
  const resumedAt = pausedAt + 20 * MINUTE;
  const resumed = {
    ...paused,
    paused: false,
    endsAtMs: resumedAt + 1200 * 1000,
    pausedRemainingSeconds: null,
    accumulatedPausedMs: (paused.accumulatedPausedMs ?? 0) + (resumedAt - pausedAt),
  };

  assert.equal(remainingSecondsOf(resumed, resumedAt), 1200, '恢复时剩余时间与暂停时一致');
  assert.equal(remainingSecondsOf(resumed, resumedAt + 10 * MINUTE), 600);
  assert.equal(hasPhaseElapsed(resumed, resumedAt + 19 * MINUTE), false);
  assert.equal(hasPhaseElapsed(resumed, resumedAt + 20 * MINUTE), true);
  assert.equal(resumed.accumulatedPausedMs, 20 * MINUTE, '累计暂停时长被正确记录');
});

test('暂停恢复多次：总专注时长如实等于真实投入，不多不少', () => {
  let state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 600, startedAtMs: T0 });
  let clock = T0;

  // 专注 2 分钟 → 暂停 10 分钟 → 专注 3 分钟 → 暂停 5 分钟 → 专注完剩余 5 分钟
  clock += 2 * MINUTE;
  state = { ...state, paused: true, pausedRemainingSeconds: remainingSecondsOf(state, clock) };
  clock += 10 * MINUTE;
  state = { ...state, paused: false, endsAtMs: clock + state.pausedRemainingSeconds * 1000, pausedRemainingSeconds: null };
  clock += 3 * MINUTE;
  state = { ...state, paused: true, pausedRemainingSeconds: remainingSecondsOf(state, clock) };
  clock += 5 * MINUTE;
  state = { ...state, paused: false, endsAtMs: clock + state.pausedRemainingSeconds * 1000, pausedRemainingSeconds: null };

  // 真实投入 = 2 + 3 + 5 = 10 分钟（正好走完）
  clock += 5 * MINUTE;
  assert.equal(remainingSecondsOf(state, clock), 0);
  assert.equal(elapsedSecondsOf(state, clock), 600, '已投入时间精确等于阶段总时长');
  assert.equal(hasPhaseElapsed(state, clock), true);
});

/* ------------------------------------------------------------------ *
 * 从存储恢复（刷新页面）
 * ------------------------------------------------------------------ */

test('刷新恢复：进行中的阶段被归一化后继续正确倒计时', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  // 模拟"存进 localStorage → 刷新页面 → 6 分钟后再读出来"
  const serialized = JSON.parse(JSON.stringify(state));
  const reloadedAt = T0 + 6 * MINUTE;
  const normalized = normalizeTimerState(serialized, reloadedAt);

  assert.equal(normalized.paused, false, '进行中的状态不应被改成暂停');
  assert.equal(remainingSecondsOf(normalized, reloadedAt), 1140, '25 分钟的阶段过了 6 分钟，应剩余 19 分钟');
});

test('刷新恢复：暂停中的阶段在刷新后仍然冻结，不会继续走', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  const paused = { ...state, paused: true, pausedRemainingSeconds: 900, pausedAtMs: T0 + 10 * MINUTE };
  const serialized = JSON.parse(JSON.stringify(paused));

  const reloadedAt = T0 + 3 * 60 * MINUTE; // 3 小时后才重新打开
  const normalized = normalizeTimerState(serialized, reloadedAt);
  assert.equal(normalized.paused, true);
  assert.equal(remainingSecondsOf(normalized, reloadedAt), 900, '暂停期间的时间不会被消耗');
});

test('刷新恢复：缺少剩余秒数的暂停状态也能推出合理值，而不是崩溃', () => {
  const state = createTimerState({ phase: FOCUS_PHASE.FOCUS, durationSeconds: 1500, startedAtMs: T0 });
  const broken = { ...state, paused: true, pausedRemainingSeconds: null };
  const normalized = normalizeTimerState(broken, T0 + 5 * MINUTE);
  assert.equal(normalized.pausedRemainingSeconds, 1200, '按结束时间推算剩余');
  assert.equal(remainingSecondsOf(normalized, T0 + 5 * MINUTE), 1200);
});

test('刷新恢复：空数据或损坏数据回退为未开始状态', () => {
  for (const bad of [null, undefined, {}, { phase: null }, 'nonsense', 42]) {
    const normalized = normalizeTimerState(bad, T0);
    assert.equal(normalized.phase, FOCUS_PHASE.IDLE);
    assert.equal(remainingSecondsOf(normalized, T0), 0);
    assert.equal(hasPhaseElapsed(normalized, T0 + 10 * MINUTE), false);
  }
});

test('刷新恢复：未开始状态不会因为时间流逝而自己开始计时', () => {
  const idle = createTimerState({ phase: FOCUS_PHASE.IDLE, startedAtMs: T0 });
  const normalized = normalizeTimerState(idle, T0 + 60 * MINUTE);
  assert.equal(normalized.phase, FOCUS_PHASE.IDLE);
  assert.equal(normalized.endsAtMs, null);
  assert.equal(remainingSecondsOf(normalized, T0 + 60 * MINUTE), 0);
});

/* ------------------------------------------------------------------ *
 * 阶段配置与格式化
 * ------------------------------------------------------------------ */

test('阶段时长：按设置计算，并有下限保护（不允许 0 或负数）', () => {
  const config = { focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 25 };
  assert.equal(phaseDurationSeconds(FOCUS_PHASE.FOCUS, config), 3000);
  assert.equal(phaseDurationSeconds(FOCUS_PHASE.SHORT_BREAK, config), 600);
  assert.equal(phaseDurationSeconds(FOCUS_PHASE.LONG_BREAK, config), 1500);
  assert.equal(phaseDurationSeconds(FOCUS_PHASE.FOCUS, { focusMinutes: 0 }), 60, '最小 1 分钟');
  assert.equal(phaseDurationSeconds(FOCUS_PHASE.FOCUS, {}), 1500, '缺省时使用默认值');
});

test('格式化：秒数显示为 mm:ss，超过一小时显示 h:mm:ss', () => {
  assert.equal(formatSeconds(0), '00:00');
  assert.equal(formatSeconds(59), '00:59');
  assert.equal(formatSeconds(60), '01:00');
  assert.equal(formatSeconds(1500), '25:00');
  assert.equal(formatSeconds(3599), '59:59');
  assert.equal(formatSeconds(3600), '1:00:00');
  assert.equal(formatSeconds(3661), '1:01:01');
  assert.equal(formatSeconds(-5), '00:00', '负数按 0 处理');
  assert.equal(formatSeconds(59.6), '01:00', '四舍五入到秒');
});
