/**
 * 容量计算与输入指纹测试。
 *
 * 容量是排程的地基（算错就会排进上课时间或凭空多出时间），
 * 指纹是"预览过期检测"的依据（算漏字段就会出现用旧数据覆盖新数据）。
 * 两者都属于"错了很难发现"的类型，因此测试要具体到分钟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clipSpan,
  computeDayCapacity,
  computeWindowCapacity,
  isWithinWindows,
  longestFreeSlot,
  mergeDaySpans,
  normalizeStudyWindows,
  preferredOverlapMinutes,
  slotsFitting,
  subtractSpans,
  sumLength,
} from '../../src/engine/capacity.js';
import { computeInputHash, computePolicyHash, deriveBlockId, deriveSessionId, hash32, hashParts, stableStringify } from '../../src/engine/versionHash.js';
import { mergeSpans } from '../../src/domain/fixedActivity.js';

function windowsEveryDay(startMinutes = 16 * 60, endMinutes = 23 * 60) {
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes, endMinutes }];
  return map;
}

/* ------------------------------------------------------------------ *
 * 区间运算
 * ------------------------------------------------------------------ */

test('clipSpan：把区间裁到一天之内，空区间返回 null', () => {
  assert.deepEqual(clipSpan({ date: '2025-10-16', startMinutes: -10, endMinutes: 30 }, '2025-10-16'), {
    date: '2025-10-16',
    startMinutes: 0,
    endMinutes: 30,
  });
  assert.equal(clipSpan({ date: '2025-10-16', startMinutes: 2000, endMinutes: 2100 }), null);
});

test('subtractSpans：从窗口中挖掉占用，返回剩余区间', () => {
  const free = subtractSpans(
    [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }],
    [
      { startMinutes: 17 * 60, endMinutes: 18 * 60 },
      { startMinutes: 20 * 60, endMinutes: 21 * 60 },
    ],
  );
  assert.deepEqual(free, [
    { startMinutes: 16 * 60, endMinutes: 17 * 60 },
    { startMinutes: 18 * 60, endMinutes: 20 * 60 },
    { startMinutes: 21 * 60, endMinutes: 23 * 60 },
  ]);
  assert.equal(sumLength(free), 5 * 60);
});

test('subtractSpans：占用完全覆盖窗口时返回空数组', () => {
  assert.deepEqual(subtractSpans([{ startMinutes: 16 * 60, endMinutes: 17 * 60 }], [{ startMinutes: 15 * 60, endMinutes: 18 * 60 }]), []);
});

test('mergeDaySpans：只处理指定日期，并合并重叠与相邻区间', () => {
  const merged = mergeDaySpans(
    [
      { date: '2025-10-16', startMinutes: 480, endMinutes: 600 },
      { date: '2025-10-16', startMinutes: 540, endMinutes: 660 },
      { date: '2025-10-17', startMinutes: 0, endMinutes: 60 },
    ],
    '2025-10-16',
  );
  assert.deepEqual(merged, [{ date: '2025-10-16', startMinutes: 480, endMinutes: 660 }]);
});

test('slotsFitting / longestFreeSlot：只返回装得下的槽位', () => {
  const windows = [
    { startMinutes: 960, endMinutes: 990 },
    { startMinutes: 1020, endMinutes: 1110 },
  ];
  assert.equal(longestFreeSlot(windows), 90);
  assert.deepEqual(slotsFitting(windows, 60), [{ startMinutes: 1020, endMinutes: 1110, length: 90 }]);
  assert.deepEqual(slotsFitting(windows, 120), []);
});

test('preferredOverlapMinutes：计算与偏好专注时段的重叠分钟数', () => {
  const preferred = [{ startMinutes: 19 * 60, endMinutes: 22 * 60 }];
  assert.equal(preferredOverlapMinutes(18 * 60, 20 * 60, preferred), 60);
  assert.equal(preferredOverlapMinutes(16 * 60, 17 * 60, preferred), 0);
  assert.equal(preferredOverlapMinutes(21 * 60, 23 * 60, preferred), 60);
});

test('isWithinWindows：片段必须完整落在某个允许窗口内', () => {
  const windows = windowsEveryDay(16 * 60, 23 * 60);
  assert.equal(isWithinWindows('2025-10-16', 16 * 60, 17 * 60, windows), true);
  assert.equal(isWithinWindows('2025-10-16', 15 * 60, 17 * 60, windows), false);
  assert.equal(isWithinWindows('2025-10-16', 22 * 60, 23 * 60 + 1, windows), false);
});

/* ------------------------------------------------------------------ *
 * 跨午夜窗口
 * ------------------------------------------------------------------ */

test('normalizeStudyWindows：跨午夜窗口被拆到两天，容量不丢也不多', () => {
  const map = { 4: [{ startMinutes: 22 * 60, endMinutes: 2 * 60 }] }; // 周四 22:00–02:00
  assert.deepEqual(normalizeStudyWindows('2025-10-16', map), [{ date: '2025-10-16', startMinutes: 1320, endMinutes: 1440 }]);
  assert.deepEqual(normalizeStudyWindows('2025-10-17', map), [{ date: '2025-10-17', startMinutes: 0, endMinutes: 120 }]);
  assert.deepEqual(normalizeStudyWindows('2025-10-18', map), []);
});

test('computeDayCapacity：跨午夜窗口的净容量是两段之和', () => {
  const map = windowsEveryDay(22 * 60, 2 * 60);
  const capacity = computeDayCapacity({ date: '2025-10-17', studyWindows: map, bufferRatio: 0.1 });
  assert.equal(capacity.windowMinutes, 240, '22:00–24:00 + 00:00–02:00 = 240 分钟');
  assert.equal(capacity.netCapacityMinutes, 240);
  assert.equal(capacity.bufferMinutes, 24);
  assert.equal(capacity.schedulableMinutes, 216);
});

/* ------------------------------------------------------------------ *
 * 每日容量
 * ------------------------------------------------------------------ */

test('computeDayCapacity：净容量、10% 缓冲与空闲区间', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [{ date: '2025-10-16', startMinutes: 17 * 60, endMinutes: 18 * 60 }],
    bufferRatio: 0.1,
  });

  assert.equal(capacity.windowMinutes, 420);
  assert.equal(capacity.fixedMinutes, 60);
  assert.equal(capacity.netCapacityMinutes, 360);
  assert.equal(capacity.bufferMinutes, 36);
  assert.equal(capacity.schedulableMinutes, 324);
  assert.deepEqual(capacity.freeWindows, [
    { startMinutes: 16 * 60, endMinutes: 17 * 60 },
    { startMinutes: 18 * 60, endMinutes: 23 * 60 },
  ]);
});

test('computeDayCapacity：重叠的固定活动只扣一次', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [
      { date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 18 * 60 },
      { date: '2025-10-16', startMinutes: 17 * 60, endMinutes: 19 * 60 },
    ],
  });
  assert.equal(capacity.fixedMinutes, 180, '16:00–19:00 合并后为 180 分钟');
  assert.equal(capacity.netCapacityMinutes, 420 - 180);
});

test('computeDayCapacity：锁定/进行中/已完成时段单独统计（与固定活动分开记账）', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [{ date: '2025-10-16', startMinutes: 17 * 60, endMinutes: 18 * 60 }],
    reservedSpans: [{ date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 16 * 60 + 45 }],
  });
  assert.equal(capacity.fixedMinutes, 60);
  assert.equal(capacity.reservedMinutes, 45);
  assert.equal(capacity.netCapacityMinutes, 420 - 60 - 45);
});

test('computeWindowCapacity：逐日给出容量，且每天独立计算缓冲（不跨日挪用）', () => {
  const days = computeWindowCapacity({
    windowStart: '2025-10-16',
    windowEnd: '2025-10-22',
    studyWindows: { 4: [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }], 5: [{ startMinutes: 9 * 60, endMinutes: 12 * 60 }] },
    bufferRatio: 0.1,
  });

  assert.equal(days.length, 7);
  assert.equal(days[0].netCapacityMinutes, 420, '周四 16:00–23:00');
  assert.equal(days[0].bufferMinutes, 42);
  assert.equal(days[1].netCapacityMinutes, 180, '周五 09:00–12:00');
  assert.equal(days[1].bufferMinutes, 18);
  assert.equal(days[2].netCapacityMinutes, 0, '周六没有配置窗口');
  assert.equal(days[2].bufferMinutes, 0);
});

test('computeDayCapacity：没有窗口或窗口被占满时容量为 0', () => {
  assert.equal(computeDayCapacity({ date: '2025-10-16', studyWindows: {}, fixedSpans: [] }).netCapacityMinutes, 0);

  const fullyBooked = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [{ date: '2025-10-16', startMinutes: 0, endMinutes: 1440 }],
  });
  assert.equal(fullyBooked.netCapacityMinutes, 0);
  assert.deepEqual(fullyBooked.freeWindows, []);
});

/* ------------------------------------------------------------------ *
 * 输入指纹
 * ------------------------------------------------------------------ */

test('hash32 / stableStringify：稳定且与键顺序无关', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(hashParts('a', { x: 1 }), hashParts('a', { x: 1 }));
});

test('deriveSessionId / deriveBlockId：同一输入得到同一 ID，不同输入得到不同 ID', () => {
  assert.equal(deriveSessionId('H1', 'tsk_a', 0), deriveSessionId('H1', 'tsk_a', 0));
  assert.notEqual(deriveSessionId('H1', 'tsk_a', 0), deriveSessionId('H1', 'tsk_a', 1));
  assert.notEqual(deriveSessionId('H1', 'tsk_a', 0), deriveSessionId('H2', 'tsk_a', 0));
  assert.match(deriveSessionId('H1', 'tsk_a', 0), /^ses_[0-9a-f]{8}$/);
  assert.match(deriveBlockId('rest', 'H1', '2025-10-16', 960, 1), /^rst_[0-9a-f]{8}$/);
  assert.match(deriveBlockId('buffer', 'H1', '2025-10-16', 960, 1), /^buf_[0-9a-f]{8}$/);
});

test('computeInputHash：任何影响排程的字段变化都会改变指纹', () => {
  const base = {
    engineVersion: 'engine@test',
    policyHash: 'policy-a',
    nowDate: '2025-10-16',
    windowStart: '2025-10-16',
    windowEnd: '2025-10-22',
    settings: {
      studyWindows: windowsEveryDay(),
      preferredFocusWindows: [],
      adaptiveContinuousLimit: true,
      baseContinuousMinutes: 90,
      subjectSwitchPenaltyMinutes: 30,
      defaultMinChunkMinutes: 30,
      defaultMaxChunkMinutes: 60,
      restRule: { afterContinuousMinutes: 50, restMinutes: 10, extraOnSubjectSwitch: 0 },
      bufferRatio: 0.1,
      dayBoundaryHour: 4,
      weights: { deadlineUrgency: 0.35, difficulty: 0.3, importance: 0.2, procrastination: 0.15 },
      maxSessionsPerDay: 24,
      dailyStudyCapMinutes: null,
    },
    tasks: [
      {
        id: 'tsk_a',
        status: 'not_started',
        plannedMinutes: 90,
        deadlineDate: '2025-10-20',
        deadlineTime: '23:00',
        importance: 3,
        difficulty: 3,
        procrastination: 3,
        splittable: true,
        minChunkMinutes: 30,
        maxChunkMinutes: 60,
        dependsOn: [],
      },
    ],
    sessions: [],
    fixedActivities: [],
    completedMinutesByTask: { tsk_a: 0 },
  };

  const baseHash = computeInputHash(base);
  assert.equal(baseHash, computeInputHash(base), '同一输入必须得到同一指纹');

  const mutations = {
    '任务剩余量变化': { completedMinutesByTask: { tsk_a: 30 } },
    '任务截止时间变化': { tasks: [{ ...base.tasks[0], deadlineDate: '2025-10-19' }] },
    '任务难度变化': { tasks: [{ ...base.tasks[0], difficulty: 5 }] },
    '拆分设置变化': { tasks: [{ ...base.tasks[0], maxChunkMinutes: 45 }] },
    '依赖变化': { tasks: [{ ...base.tasks[0], dependsOn: ['tsk_b'] }] },
    '窗口变化': { windowEnd: '2025-10-23' },
    '今天日期变化': { nowDate: '2025-10-17' },
    '允许学习时间变化': { settings: { ...base.settings, studyWindows: windowsEveryDay(15 * 60, 23 * 60) } },
    '缓冲比例变化': { settings: { ...base.settings, bufferRatio: 0.2 } },
    '权重变化': { settings: { ...base.settings, weights: { deadlineUrgency: 0.5, difficulty: 0.2, importance: 0.2, procrastination: 0.1 } } },
    '引擎版本变化': { engineVersion: 'engine@next' },
  };

  for (const [label, patch] of Object.entries(mutations)) {
    const mutated = computeInputHash({ ...base, ...patch });
    assert.notEqual(mutated, baseHash, `${label} 应当改变输入指纹`);
  }
});

test('computeInputHash：与数组顺序无关（同一份数据的排序不影响指纹）', () => {
  const settings = {
    studyWindows: windowsEveryDay(),
    preferredFocusWindows: [],
    adaptiveContinuousLimit: true,
    baseContinuousMinutes: 90,
    subjectSwitchPenaltyMinutes: 30,
    defaultMinChunkMinutes: 30,
    defaultMaxChunkMinutes: 60,
    restRule: { afterContinuousMinutes: 50, restMinutes: 10, extraOnSubjectSwitch: 0 },
    bufferRatio: 0.1,
    dayBoundaryHour: 4,
    weights: { deadlineUrgency: 0.35, difficulty: 0.3, importance: 0.2, procrastination: 0.15 },
    maxSessionsPerDay: 24,
    dailyStudyCapMinutes: null,
  };
  const task = (id) => ({
    id,
    status: 'not_started',
    plannedMinutes: 90,
    deadlineDate: '2025-10-20',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
  });

  const common = { engineVersion: 'e', policyHash: 'p', nowDate: '2025-10-16', windowStart: '2025-10-16', windowEnd: '2025-10-22', settings, sessions: [], fixedActivities: [], completedMinutesByTask: {} };
  const ordered = computeInputHash({ ...common, tasks: [task('tsk_a'), task('tsk_b')] });
  const reversed = computeInputHash({ ...common, tasks: [task('tsk_b'), task('tsk_a')] });
  assert.equal(ordered, reversed);
});

test('computePolicyHash：设置变化会改变策略指纹', () => {
  const settings = {
    studyWindows: windowsEveryDay(),
    preferredFocusWindows: [],
    adaptiveContinuousLimit: true,
    baseContinuousMinutes: 90,
    subjectSwitchPenaltyMinutes: 30,
    defaultMinChunkMinutes: 30,
    defaultMaxChunkMinutes: 60,
    restRule: { afterContinuousMinutes: 50, restMinutes: 10, extraOnSubjectSwitch: 0 },
    bufferRatio: 0.1,
    weights: { deadlineUrgency: 0.35, difficulty: 0.3, importance: 0.2, procrastination: 0.15 },
    maxSessionsPerDay: 24,
    dailyStudyCapMinutes: null,
  };
  const a = computePolicyHash(settings, 'e');
  assert.equal(a, computePolicyHash(settings, 'e'));
  assert.notEqual(a, computePolicyHash({ ...settings, bufferRatio: 0.2 }, 'e'));
  assert.notEqual(a, computePolicyHash(settings, 'e2'));
});

test('mergeSpans（来自 domain）与 capacity 的口径一致', () => {
  const merged = mergeSpans([
    { date: '2025-10-16', startMinutes: 960, endMinutes: 1020 },
    { date: '2025-10-16', startMinutes: 1000, endMinutes: 1080 },
  ]);
  assert.deepEqual(merged, [{ date: '2025-10-16', startMinutes: 960, endMinutes: 1080 }]);
});

/* ------------------------------------------------------------------ *
 * 最晚睡觉时间：硬约束
 * ------------------------------------------------------------------ */

test('latestSleepMinutes：把当天窗口右端截断，容量随之减少', () => {
  const studyWindows = { 1: [{ startMinutes: 19 * 60, endMinutes: 23 * 60 }] };
  const baseline = computeDayCapacity({ date: '2025-10-27', studyWindows });
  const limited = computeDayCapacity({
    date: '2025-10-27',
    studyWindows,
    latestSleepMinutes: 22 * 60 + 30,
  });

  assert.equal(baseline.windowMinutes, 4 * 60);
  assert.equal(limited.windowMinutes, 3 * 60 + 30, '19:00–22:30 只剩 210 分钟');
  assert.ok(limited.schedulableMinutes < baseline.schedulableMinutes);
  assert.equal(limited.windows[0].endMinutes, 22 * 60 + 30);
});

test('latestSleepMinutes：晚于窗口结束时不产生影响', () => {
  const studyWindows = { 1: [{ startMinutes: 19 * 60, endMinutes: 22 * 60 }] };
  const limited = computeDayCapacity({ date: '2025-10-27', studyWindows, latestSleepMinutes: 23 * 60 });
  assert.equal(limited.windowMinutes, 3 * 60);
});

test('latestSleepMinutes：早于窗口开始 → 当天完全没有可用时间', () => {
  const studyWindows = { 1: [{ startMinutes: 19 * 60, endMinutes: 23 * 60 }] };
  const limited = computeDayCapacity({ date: '2025-10-27', studyWindows, latestSleepMinutes: 18 * 60 });
  assert.equal(limited.windowMinutes, 0);
  assert.equal(limited.schedulableMinutes, 0);
});

test('latestSleepMinutes：非法值（null / 0 / 超范围）等于不限制', () => {
  const studyWindows = { 1: [{ startMinutes: 19 * 60, endMinutes: 23 * 60 }] };
  for (const bad of [null, undefined, 0, -5, 2000, 1.5]) {
    const day = computeDayCapacity({ date: '2025-10-27', studyWindows, latestSleepMinutes: bad });
    assert.equal(day.windowMinutes, 4 * 60, `非法值 ${bad} 不应改变容量`);
  }
});

test('latestSleepMinutes：不把睡眠时间当成"占用块"插入（窗口右端截止，而非扣除一段）', () => {
  const studyWindows = { 1: [{ startMinutes: 19 * 60, endMinutes: 23 * 60 }] };
  const limited = computeDayCapacity({ date: '2025-10-27', studyWindows, latestSleepMinutes: 22 * 60 });
  // 关键：freeWindows 只有一段（19:00–22:00），不是"19:00–22:00 + 被扣掉的 22:00–23:00"
  assert.equal(limited.freeWindows.length, 1);
  assert.equal(limited.fixedSpans.length, 0, '睡眠时间是约束，不是固定活动');
});
