/**
 * 计时盘几何、双模式与恢复（纯函数，固定时间，不真实等待）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_PROGRESS,
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  TIMER_MODE,
  TIMER_STATUS,
  advanceTimer,
  computeDisplaySeconds,
  computeElapsedSeconds,
  computeProgress,
  drawableProgress,
  formatStudyClock,
  overrunSeconds,
  pauseTimer,
  restoreStudyTimer,
  resumeTimer,
  ringDashOffset,
  startTimer,
  switchMode,
} from '../../src/services/studyTimer.js';

const T0 = 1_700_000_000_000;
const SEC = 1000;

/** 2 小时任务 */
const makeTimer = (mode = TIMER_MODE.COUNTDOWN) =>
  startTimer({ plannerId: 't1', title: '两小时项目', minutes: 120, mode }, T0);

/* ---------------- 圆环几何 ---------------- */

test('圆环几何：半径 144、周长 2πr，偏移量随进度递减', () => {
  assert.equal(RING_RADIUS, 144);
  assert.ok(Math.abs(RING_CIRCUMFERENCE - 2 * Math.PI * 144) < 1e-9);
  assert.ok(Math.abs(ringDashOffset(0.25) - RING_CIRCUMFERENCE * 0.75) < 0.01);
  assert.ok(Math.abs(ringDashOffset(1) - 0) < 0.01);
  assert.ok(Math.abs(ringDashOffset(MIN_PROGRESS) - RING_CIRCUMFERENCE * (1 - MIN_PROGRESS)) < 0.01);
});

test('T-01 空闲时使用最小圆弧（3.5%），不会看起来像没渲染', () => {
  assert.equal(drawableProgress(0), MIN_PROGRESS);
  assert.ok(Math.abs(ringDashOffset(drawableProgress(0)) - RING_CIRCUMFERENCE * 0.965) < 0.01);
  assert.equal(formatStudyClock(7200), '2:00:00');
});

/* ---------------- 倒计时 ---------------- */

test('T-02 倒计时 30 分钟后：显示 1:30:00，进度 25%', () => {
  const timer = makeTimer();
  const now = T0 + 1800 * SEC;
  assert.equal(computeElapsedSeconds(timer, now), 1800);
  assert.equal(computeDisplaySeconds(timer, now), 5400);
  assert.equal(formatStudyClock(computeDisplaySeconds(timer, now)), '1:30:00');
  assert.equal(computeProgress(1800, 7200), 0.25);
});

test('T-03/T-04 倒计时到点与超时：显示 0:00，进度 1，不出现负数', () => {
  const timer = makeTimer();
  assert.equal(computeDisplaySeconds(timer, T0 + 7200 * SEC), 0);
  assert.equal(computeDisplaySeconds(timer, T0 + 9000 * SEC), 0);
  assert.equal(computeProgress(9000, 7200), 1);
  assert.equal(advanceTimer(timer, T0 + 7200 * SEC).status, TIMER_STATUS.EXPIRED);
});

/* ---------------- 正计时 ---------------- */

test('T-05/T-06 正计时：数字持续增长，超过计划仍是 running', () => {
  const timer = makeTimer(TIMER_MODE.COUNTUP);
  const half = T0 + 1800 * SEC;
  assert.equal(computeDisplaySeconds(timer, half), 1800);
  assert.equal(formatStudyClock(computeDisplaySeconds(timer, half), { withHours: true }), '0:30:00');
  assert.equal(computeProgress(1800, 7200), 0.25);

  const over = T0 + 9000 * SEC;
  assert.equal(computeDisplaySeconds(timer, over), 9000);
  assert.equal(formatStudyClock(computeDisplaySeconds(timer, over), { withHours: true }), '2:30:00');
  assert.equal(computeProgress(9000, 7200), 1);
  assert.equal(advanceTimer(timer, over).status, TIMER_STATUS.RUNNING, '正计时不得自动完成');
  assert.equal(overrunSeconds(timer, over), 1800);
});

/* ---------------- 暂停 / 继续 ---------------- */

test('T-07/T-08 暂停期间时间冻结，继续后剩余时间不跳变', () => {
  const timer = makeTimer();
  const pausedAt = T0 + 1800 * SEC;
  const paused = pauseTimer(timer, pausedAt);

  // 暂停 600 秒后：已专注仍是 1800
  assert.equal(computeElapsedSeconds(paused, pausedAt + 600 * SEC), 1800);
  assert.equal(computeDisplaySeconds(paused, pausedAt + 600 * SEC), 5400);

  const resumed = resumeTimer(paused, pausedAt + 600 * SEC);
  // 再走 600 秒 → 已专注 2400，剩余 4800
  assert.equal(computeElapsedSeconds(resumed, pausedAt + 1200 * SEC), 2400);
  assert.equal(computeDisplaySeconds(resumed, pausedAt + 1200 * SEC), 4800);
});

test('T-09 倒计时暂停 600 秒后继续：targetAt 后移 600000ms', () => {
  const timer = makeTimer();
  const paused = pauseTimer(timer, T0 + 1800 * SEC);
  const resumed = resumeTimer(paused, T0 + 2400 * SEC);
  assert.equal(resumed.targetAt, timer.targetAt + 600 * SEC);
});

/* ---------------- 模式切换 ---------------- */

test('T-10 正计时 → 倒计时：targetAt = now + 剩余×1000', () => {
  const timer = makeTimer(TIMER_MODE.COUNTUP);
  const now = T0 + 1800 * SEC;
  const switched = switchMode(timer, TIMER_MODE.COUNTDOWN, now);
  assert.equal(switched.mode, TIMER_MODE.COUNTDOWN);
  assert.equal(switched.targetAt, now + 5400 * SEC);
  assert.equal(computeDisplaySeconds(switched, now), 5400);
  assert.equal(formatStudyClock(5400), '1:30:00');
});

test('T-11 正计时已超过计划，切回倒计时立即进入待确认', () => {
  const timer = makeTimer(TIMER_MODE.COUNTUP);
  const over = T0 + 9000 * SEC;
  // 先推进（正计时不会自动结束），再切换
  const switched = switchMode(advanceTimer(timer, over), TIMER_MODE.COUNTDOWN, over);
  assert.equal(switched.status, TIMER_STATUS.EXPIRED);
  assert.equal(computeDisplaySeconds(switched, over), 0, '不得显示负数');
});

test('T-12 倒计时 → 正计时：保留已过时间，targetAt 清空', () => {
  const timer = makeTimer();
  const now = T0 + 1800 * SEC;
  const switched = switchMode(timer, TIMER_MODE.COUNTUP, now);
  assert.equal(switched.mode, TIMER_MODE.COUNTUP);
  assert.equal(switched.targetAt, null);
  assert.equal(computeDisplaySeconds(switched, now), 1800);
  assert.equal(computeDisplaySeconds(switched, now + 600 * SEC), 2400);
});

/* ---------------- 恢复 ---------------- */

test('T-13 恢复：2 小时倒计时过了 1 小时，剩余 3600 秒且仍在运行', () => {
  const raw = JSON.parse(JSON.stringify(makeTimer()));
  const restored = restoreStudyTimer(raw, T0 + 3600 * SEC);
  assert.equal(restored.status, TIMER_STATUS.RUNNING);
  assert.equal(computeDisplaySeconds(restored, T0 + 3600 * SEC), 3600);
  assert.equal(restored.restored, true);
});

test('T-14 恢复：过了 3 小时，进入 expired 但不写数据', () => {
  const raw = JSON.parse(JSON.stringify(makeTimer()));
  const restored = restoreStudyTimer(raw, T0 + 3 * 3600 * SEC);
  assert.equal(restored.status, TIMER_STATUS.EXPIRED);
  assert.equal(computeDisplaySeconds(restored, T0 + 3 * 3600 * SEC), 0);
});

test('T-15 恢复：暂停状态不计入暂停时长', () => {
  const paused = pauseTimer(makeTimer(), T0 + 1800 * SEC);
  const raw = JSON.parse(JSON.stringify(paused));
  const restored = restoreStudyTimer(raw, T0 + 2400 * SEC);
  assert.equal(restored.status, TIMER_STATUS.PAUSED);
  assert.equal(computeElapsedSeconds(restored, T0 + 2400 * SEC), 1800, '暂停的 10 分钟不算专注');
});
