/**
 * SchedulePlan 与容量计算测试。
 *
 * 这是"可用时间"这一最基础计算的回归测试。需求中的关键定义必须在这里被钉死：
 *   netCapacity(d)  = 允许窗口 − 固定活动 − 已锁定/进行中/已完成时段（重叠合并，只扣一次）
 *   bufferMinutes(d)= floor(netCapacity × bufferRatio)      ← 逐日 10%
 *   schedulable(d)  = netCapacity − buffer
 * 如果这些数字错了，后面的排程再"看起来合理"也是错的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGINE_VERSION,
  PLAN_STATUS,
  PLAN_WINDOW_DAYS,
  blocksOverlap,
  computeDayCapacity,
  computeFreeWindows,
  computePlanMetrics,
  createEmptyPlan,
  createPlanSnapshot,
  emptyDayMetrics,
  isFeasible,
  normalizeDayWindows,
  planWindow,
  validatePlan,
} from '../../src/domain/plan.js';
import { blockBuffer, createBlock } from '../../src/domain/calendarBlock.js';
import { WEEKDAY_NAMES_ZH, weekday } from '../../src/domain/time.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { FIXED_NOW_ISO, testIdFactory } from '../helpers/clock.js';

/** 生成"每天 16:00–23:00"的学习窗口配置 */
function windowsEveryDay(startMinutes = 16 * 60, endMinutes = 23 * 60) {
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes, endMinutes }];
  return map;
}

test('planWindow 默认生成今天起共七天（含当天）', () => {
  assert.equal(PLAN_WINDOW_DAYS, 7);
  const window = planWindow('2025-10-16');
  assert.equal(window.startDate, '2025-10-16');
  assert.equal(window.endDate, '2025-10-22');
  assert.equal(window.days, 7);
});

test('createEmptyPlan：七天全部为零，且不包含任何虚构数据', () => {
  const plan = createEmptyPlan({ planId: 'pln_1', version: 0, windowStart: '2025-10-16', nowIso: FIXED_NOW_ISO });

  assert.equal(plan.version, 0);
  assert.equal(plan.status, PLAN_STATUS.FEASIBLE);
  assert.equal(plan.engineVersion, ENGINE_VERSION);
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.days.length, 7);
  assert.deepEqual(plan.days.map((d) => d.date), [
    '2025-10-16',
    '2025-10-17',
    '2025-10-18',
    '2025-10-19',
    '2025-10-20',
    '2025-10-21',
    '2025-10-22',
  ]);
  for (const day of plan.days) {
    assert.equal(day.studyMinutes, 0);
    assert.equal(day.restMinutes, 0);
    assert.equal(day.bufferMinutes, 0);
    assert.equal(day.netCapacityMinutes, 0);
    assert.equal(day.overloadMinutes, 0);
  }
  assert.equal(plan.metrics.totalStudyMinutes, 0);
});

test('emptyDayMetrics 的 weekday 与日期一致（界面按星期显示窗口依赖它）', () => {
  assert.equal(emptyDayMetrics('2025-10-16').weekday, 4);
  assert.equal(WEEKDAY_NAMES_ZH[emptyDayMetrics('2025-10-16').weekday - 1], '周四');
});

test('normalizeDayWindows：把按星期配置的窗口换算成某一天内的窗口', () => {
  const windows = windowsEveryDay();
  assert.deepEqual(normalizeDayWindows('2025-10-16', windows), [{ startMinutes: 960, endMinutes: 1380 }]);

  const onlyThursday = { 4: [{ startMinutes: 960, endMinutes: 1380 }] };
  assert.deepEqual(normalizeDayWindows('2025-10-16', onlyThursday), [{ startMinutes: 960, endMinutes: 1380 }]);
  assert.deepEqual(normalizeDayWindows('2025-10-17', onlyThursday), [], '周五没有配置窗口');
  assert.deepEqual(normalizeDayWindows('2025-10-17', {}), []);
});

test('normalizeDayWindows：跨午夜窗口把凌晨部分归到次日，不丢也不多算', () => {
  // 周四 22:00–02:00 → 周四 22:00–24:00 + 周五 00:00–02:00
  const windows = { 4: [{ startMinutes: 22 * 60, endMinutes: 2 * 60 }] };
  assert.deepEqual(normalizeDayWindows('2025-10-16', windows), [{ startMinutes: 1320, endMinutes: 1440 }]);
  assert.deepEqual(normalizeDayWindows('2025-10-17', windows), [{ startMinutes: 0, endMinutes: 120 }]);
  assert.deepEqual(normalizeDayWindows('2025-10-18', windows), []);
});

test('computeFreeWindows：从允许窗口里挖掉固定活动，保留前后两段', () => {
  const free = computeFreeWindows(
    '2025-10-16',
    [{ startMinutes: 960, endMinutes: 1380 }],
    [{ date: '2025-10-16', startMinutes: 1080, endMinutes: 1140 }],
  );
  assert.deepEqual(free, [
    { startMinutes: 960, endMinutes: 1080 },
    { startMinutes: 1140, endMinutes: 1380 },
  ]);
});

test('computeFreeWindows：窗口之外的活动不影响结果，完全占满时返回空数组', () => {
  const outside = computeFreeWindows(
    '2025-10-16',
    [{ startMinutes: 960, endMinutes: 1380 }],
    [{ date: '2025-10-16', startMinutes: 480, endMinutes: 580 }],
  );
  assert.deepEqual(outside, [{ startMinutes: 960, endMinutes: 1380 }]);

  const fullyBooked = computeFreeWindows(
    '2025-10-16',
    [{ startMinutes: 960, endMinutes: 1020 }],
    [{ date: '2025-10-16', startMinutes: 900, endMinutes: 1100 }],
  );
  assert.deepEqual(fullyBooked, []);
});

test('computeDayCapacity：净容量与 10% 缓冲的计算口径', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [{ date: '2025-10-16', startMinutes: 1020, endMinutes: 1080 }], // 17:00–18:00 上课
    bufferRatio: 0.1,
  });

  assert.equal(capacity.windowMinutes, 420, '16:00–23:00 共 420 分钟');
  assert.equal(capacity.fixedMinutes, 60);
  assert.equal(capacity.netCapacityMinutes, 360, '扣除固定活动后剩 360 分钟');
  assert.equal(capacity.bufferMinutes, 36, '10% 缓冲向下取整');
  assert.equal(capacity.schedulableMinutes, 324);
  assert.deepEqual(capacity.freeWindows, [
    { startMinutes: 960, endMinutes: 1020 },
    { startMinutes: 1080, endMinutes: 1380 },
  ]);
});

test('computeDayCapacity：重叠的固定活动只扣一次（避免容量被重复估计）', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [
      { date: '2025-10-16', startMinutes: 960, endMinutes: 1080 },
      { date: '2025-10-16', startMinutes: 1020, endMinutes: 1140 },
    ],
  });
  assert.equal(capacity.fixedMinutes, 180, '16:00–19:00 合并为 180 分钟，而不是 120 + 120');
  assert.equal(capacity.netCapacityMinutes, 420 - 180);
});

test('computeDayCapacity：锁定/进行中/已完成时段按保留处理，与固定活动分开记账（H10）', () => {
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: windowsEveryDay(),
    fixedSpans: [{ date: '2025-10-16', startMinutes: 1020, endMinutes: 1080 }],
    occupiedSpans: [{ date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }],
  });

  assert.equal(capacity.fixedMinutes, 60);
  assert.equal(capacity.reservedMinutes, 45, '锁定/完成时段单独统计，便于向用户解释容量去向');
  assert.equal(capacity.netCapacityMinutes, 420 - 60 - 45);
});

test('computeDayCapacity：没有任何可学习窗口时容量为 0（不是错误，但要如实报告）', () => {
  const capacity = computeDayCapacity({ date: '2025-10-16', studyWindows: {}, fixedSpans: [] });
  assert.equal(capacity.windowMinutes, 0);
  assert.equal(capacity.netCapacityMinutes, 0);
  assert.equal(capacity.bufferMinutes, 0);
  assert.deepEqual(capacity.freeWindows, []);
});

test('computeDayCapacity：窗口为动态的星期配置（周四与周五可不同）', () => {
  const windows = {
    4: [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }],
    5: [{ startMinutes: 9 * 60, endMinutes: 12 * 60 }],
  };
  assert.equal(computeDayCapacity({ date: '2025-10-16', studyWindows: windows, fixedSpans: [] }).netCapacityMinutes, 420);
  assert.equal(computeDayCapacity({ date: '2025-10-17', studyWindows: windows, fixedSpans: [] }).netCapacityMinutes, 180);
  assert.equal(computeDayCapacity({ date: '2025-10-18', studyWindows: windows, fixedSpans: [] }).netCapacityMinutes, 0);
});

test('computePlanMetrics：学习/休息/缓冲分别累加，科目切换次数按同日相邻段统计', () => {
  const blocks = [
    createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020, subject: '数学' }),
    createBlock({ id: 'b2', kind: 'study', date: '2025-10-16', startMinutes: 1020, endMinutes: 1080, subject: '数学' }),
    createBlock({ id: 'b3', kind: 'study', date: '2025-10-16', startMinutes: 1080, endMinutes: 1140, subject: '英语' }),
    blockBuffer({ id: 'b4', date: '2025-10-16', startMinutes: 1140, endMinutes: 1176 }),
    createBlock({ id: 'b5', kind: 'rest', date: '2025-10-16', startMinutes: 1176, endMinutes: 1186, derived: true }),
  ];
  const metrics = computePlanMetrics(blocks);
  assert.equal(metrics.totalStudyMinutes, 180);
  assert.equal(metrics.bufferReservedMinutes, 36);
  assert.equal(metrics.restMinutes, 10);
  assert.equal(metrics.subjectSwitches, 1, '数学→数学不算切换，数学→英语算一次');
});

test('validatePlan：结构与窗口天数会被校验', () => {
  const plan = createEmptyPlan({ planId: 'pln_1', windowStart: '2025-10-16', nowIso: FIXED_NOW_ISO });
  assert.equal(validatePlan(plan).ok, true);

  const badVersion = validatePlan({ ...plan, version: -1 });
  assert.equal(badVersion.ok, false);
  assert.ok(badVersion.errors.some((i) => i.path.endsWith('.version')));

  const badStatus = validatePlan({ ...plan, status: 'maybe' });
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.errors.some((i) => i.code === VALIDATION_CODES.ENUM));

  const wrongDays = validatePlan({ ...plan, days: plan.days.slice(0, 3) });
  assert.equal(wrongDays.ok, false);
  assert.ok(wrongDays.errors.some((i) => i.path.endsWith('.days')));

  assert.equal(validatePlan(null).ok, false);
});

test('isFeasible 只在完整可行时为真', () => {
  assert.equal(isFeasible({ status: PLAN_STATUS.FEASIBLE }), true);
  assert.equal(isFeasible({ status: PLAN_STATUS.PARTIALLY_FEASIBLE }), false);
  assert.equal(isFeasible(null), false);
});

test('createPlanSnapshot 保留完整计划快照，供撤销使用', () => {
  const plan = createEmptyPlan({ planId: 'pln_1', version: 7, windowStart: '2025-10-16', nowIso: FIXED_NOW_ISO });
  const snapshot = createPlanSnapshot({ plan, nowIso: FIXED_NOW_ISO, changeSummary: '新增任务：线代作业', trigger: 'manual' });
  assert.equal(snapshot.version, 7);
  assert.equal(snapshot.changeSummary, '新增任务：线代作业');
  assert.equal(snapshot.plan, plan, '快照直接引用该版本计划对象（计划对象本身不可变）');
});

test('blocksOverlap 只比较同一天的块', () => {
  const a = createBlock({ id: 'a', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 });
  const b = createBlock({ id: 'b', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 });
  assert.equal(blocksOverlap(a, b), false);
  assert.equal(blocksOverlap(a, { ...a, id: 'c' }), true);
});

test('weekday 与窗口配置的键一致（星期键 1–7 不会错位）', () => {
  assert.equal(weekday('2025-10-16'), 4);
  const capacity = computeDayCapacity({
    date: '2025-10-16',
    studyWindows: { 4: [{ startMinutes: 600, endMinutes: 660 }] },
    fixedSpans: [],
  });
  assert.equal(capacity.netCapacityMinutes, 60);
});

test('测试用 ID 工厂在容量测试中可用（保证 planId 形态一致）', () => {
  const factory = testIdFactory();
  assert.match(factory.next('plan'), /^pln_/);
});
