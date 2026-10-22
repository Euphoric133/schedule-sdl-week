/**
 * 计时器状态：持久化恢复、暂停/继续、到点待确认（B-11 / B-12 / B-13）。
 *
 * 全部注入固定时间，不真实等待。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIMER_STATUS,
  TIMER_STORAGE_KEY,
  advanceTimer,
  clearTimer,
  elapsedSeconds,
  isExpired,
  loadTimer,
  pauseTimer,
  remainingSeconds,
  resumeTimer,
  saveTimer,
  startTimer,
} from '../../src/services/studyTimer.js';

function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

test('B-11 运行 1 小时后恢复：剩余 3600 秒，状态仍是 running', () => {
  const timer = startTimer({ plannerId: 't1', title: '两小时项目', minutes: 120 }, T0);
  const restored = advanceTimer(timer, T0 + 60 * MINUTE);

  assert.equal(restored.status, TIMER_STATUS.RUNNING);
  assert.equal(remainingSeconds(restored, T0 + 60 * MINUTE), 3600);
});

test('B-12 超过结束时刻后恢复：剩余 0，状态为 expired，且不会自动标记完成', () => {
  const timer = startTimer({ plannerId: 't1', title: '两小时项目', minutes: 120 }, T0);
  const now = T0 + 121 * MINUTE;
  const restored = advanceTimer(timer, now);

  assert.equal(restored.status, TIMER_STATUS.EXPIRED);
  assert.equal(remainingSeconds(timer, now), 0);
  assert.equal(isExpired(timer, now), true);
  // 纯状态推进：没有任何"完成"副作用
  assert.equal(restored.status, TIMER_STATUS.EXPIRED);
  assert.equal(restored.plannerId, 't1');
});

test('B-13 结束/放弃后持久化的键被清理，不会下次复活', () => {
  const store = installStorage();
  try {
    const timer = startTimer({ plannerId: 't1', minutes: 30 }, T0);
    assert.equal(saveTimer(timer), true);
    assert.ok(store.get(TIMER_STORAGE_KEY), '应当写入存储');

    assert.equal(saveTimer(clearTimer()), true);
    assert.equal(store.get(TIMER_STORAGE_KEY), undefined, '键必须被删除');
    assert.equal(loadTimer(), null);
  } finally {
    delete globalThis.localStorage;
  }
});

test('持久化：损坏的数据被安全忽略', () => {
  const store = installStorage();
  try {
    store.set(TIMER_STORAGE_KEY, '{ 坏掉的 json');
    assert.equal(loadTimer(), null);

    store.set(TIMER_STORAGE_KEY, JSON.stringify({ plannerId: '', startedAt: 1, targetAt: 2 }));
    assert.equal(loadTimer(), null, '没有任务 id 的状态无效');

    store.set(TIMER_STORAGE_KEY, JSON.stringify({ plannerId: 't1', startedAt: 1, targetAt: 2, status: 'weird' }));
    const loaded = loadTimer();
    assert.equal(loaded.status, TIMER_STATUS.RUNNING, '未知状态回退为 running');
  } finally {
    delete globalThis.localStorage;
  }
});

test('暂停与继续：暂停期间不消耗时间，恢复后剩余时间不变', () => {
  const timer = startTimer({ plannerId: 't1', minutes: 30 }, T0);
  const pausedAt = T0 + 5 * MINUTE;
  const paused = pauseTimer(timer, pausedAt);

  assert.equal(paused.status, TIMER_STATUS.PAUSED);
  // 暂停 10 分钟后看剩余：仍是 25 分钟
  assert.equal(remainingSeconds(paused, pausedAt + 10 * MINUTE), 25 * 60);

  const resumed = resumeTimer(paused, pausedAt + 10 * MINUTE);
  assert.equal(resumed.status, TIMER_STATUS.RUNNING);
  // 恢复后过 1 分钟，剩余 24 分钟（暂停的 10 分钟被补回）
  assert.equal(remainingSeconds(resumed, pausedAt + 11 * MINUTE), 24 * 60);
});

test('已用时间：暂停时段不计入专注时长', () => {
  const timer = startTimer({ plannerId: 't1', minutes: 30 }, T0);
  const paused = pauseTimer(timer, T0 + 5 * MINUTE);
  const resumed = resumeTimer(paused, T0 + 15 * MINUTE);

  // 实际专注 5 + 10 = 15 分钟（中间暂停的 10 分钟不算）
  assert.equal(elapsedSeconds(resumed, T0 + 25 * MINUTE), 15 * 60);
});
