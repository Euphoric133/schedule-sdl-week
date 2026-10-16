/**
 * FixedActivity（固定活动）测试。
 *
 * 重点：
 * - 每周重复与一次性两种规则都正确展开到具体日期
 * - 跨午夜活动（睡眠 23:30–07:00）在两天各产生一段，且总时长不变
 * - 多个活动重叠时，合并算法保证时间只被扣减一次（否则容量会被重复估计）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_ACTIVITY_MAX_MINUTES,
  FIXED_ACTIVITY_TYPE,
  RECURRENCE_KIND,
  createFixedActivity,
  expandFixedActivities,
  fixedActivitiesOverlap,
  mergeSpans,
  occursOn,
  removeFixedActivity,
  totalMergedMinutes,
  validateFixedActivity,
} from '../../src/domain/fixedActivity.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { makeFixedActivity, testContext } from '../helpers/fixtures.js';

test('createFixedActivity：字符串时刻、跨夜归一化与默认值', () => {
  const ctx = testContext();
  const activity = createFixedActivity(
    { title: '  高等数学课  ', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4, 2, 4] }, start: '08:00', end: '09:40' },
    ctx,
  );
  assert.match(activity.id, /^fix_/);
  assert.equal(activity.title, '高等数学课');
  assert.deepEqual(activity.recurrence.daysOfWeek, [2, 4], '星期去重并排序，保证结果稳定');
  assert.equal(activity.startMinutes, 480);
  assert.equal(activity.endMinutes, 580);
  assert.equal(activity.movable, false, '固定活动默认不可移动');

  const sleep = createFixedActivity({ title: '睡眠', type: 'sleep', recurrence: { kind: 'weekly', daysOfWeek: [1] }, start: '23:30', end: '07:00' }, ctx);
  assert.equal(sleep.endMinutes, 31 * 60, '23:30 → 07:00 应表达为次日 07:00');
});

test('validateFixedActivity：类型、重复规则与生效区间都会被校验', () => {
  const ctx = testContext();
  const base = makeFixedActivity({}, ctx);
  assert.equal(validateFixedActivity(base).ok, true);

  const badType = validateFixedActivity({ ...base, type: 'lecture' });
  assert.equal(badType.ok, false);
  assert.ok(badType.errors.some((i) => i.code === VALIDATION_CODES.ENUM));

  const badWeekly = validateFixedActivity({ ...base, recurrence: { kind: 'weekly', daysOfWeek: [] } });
  assert.equal(badWeekly.ok, false);
  assert.ok(badWeekly.errors.some((i) => i.code === VALIDATION_CODES.FIXED_ACTIVITY_RECURRENCE));

  const badDay = validateFixedActivity({ ...base, recurrence: { kind: 'weekly', daysOfWeek: [0] } });
  assert.equal(badDay.ok, false);

  const badOnce = validateFixedActivity({ ...base, recurrence: { kind: RECURRENCE_KIND.ONCE, date: '2025-13-01' } });
  assert.equal(badOnce.ok, false);

  const badRange = validateFixedActivity({ ...base, activeFrom: '2025-11-01', activeTo: '2025-10-01' });
  assert.equal(badRange.ok, false);

  const tooLong = validateFixedActivity({ ...base, startMinutes: 0, endMinutes: FIXED_ACTIVITY_MAX_MINUTES + 60 });
  assert.equal(tooLong.ok, false);
});

test('occursOn：每周重复按星期生效，一次性按日期生效，且受生效区间约束', () => {
  const ctx = testContext();
  const weekly = makeFixedActivity({ recurrence: { kind: 'weekly', daysOfWeek: [4] } }, ctx);
  assert.equal(occursOn(weekly, '2025-10-16'), true, '2025-10-16 是周四');
  assert.equal(occursOn(weekly, '2025-10-17'), false);

  const once = makeFixedActivity({ recurrence: { kind: 'once', date: '2025-10-18' } }, ctx);
  assert.equal(occursOn(once, '2025-10-18'), true);
  assert.equal(occursOn(once, '2025-10-19'), false);

  const bounded = makeFixedActivity({ recurrence: { kind: 'weekly', daysOfWeek: [4] }, activeFrom: '2025-10-01', activeTo: '2025-10-10' }, ctx);
  assert.equal(occursOn(bounded, '2025-10-16'), false, '超出生效区间');
  assert.equal(occursOn(bounded, '2025-10-02'), true);
});

test('expandFixedActivities：白天活动展开到对应日期，窗口外不出现', () => {
  const ctx = testContext();
  const activity = makeFixedActivity({ recurrence: { kind: 'weekly', daysOfWeek: [4] } }, ctx);
  const spans = expandFixedActivities([activity], '2025-10-13', '2025-10-19');

  assert.equal(spans.length, 1);
  assert.equal(spans[0].date, '2025-10-16');
  assert.equal(spans[0].startMinutes, 480);
  assert.equal(spans[0].endMinutes, 580);
  assert.equal(spans[0].type, FIXED_ACTIVITY_TYPE.CLASS);
});

test('expandFixedActivities：跨午夜活动在两天各产生一段，总时长不变', () => {
  const ctx = testContext();
  const sleep = createFixedActivity(
    { title: '睡眠', type: 'sleep', recurrence: { kind: 'weekly', daysOfWeek: [4, 5] }, start: '23:30', end: '07:00' },
    ctx,
  );
  const spans = expandFixedActivities([sleep], '2025-10-16', '2025-10-17');
  const on16 = spans.filter((s) => s.date === '2025-10-16');
  const on17 = spans.filter((s) => s.date === '2025-10-17');

  // 周四(4)与周五(5)晚上生效：10-16 只有周四晚间的 23:30–24:00；
  // 10-17 既有周四晚延续来的 00:00–07:00，也有周五晚间的 23:30–24:00。
  assert.equal(spans.length, 3, '两个晚间段（周四、周五）+ 一个早晨段（周五凌晨）');
  assert.deepEqual(on16.map((s) => [s.startMinutes, s.endMinutes]), [[1410, 1440]]);
  assert.deepEqual(
    on17.map((s) => [s.startMinutes, s.endMinutes]),
    [
      [0, 420],
      [1410, 1440],
    ],
  );

  const oneNight = 420 + 30; // 00:00–07:00（420）与 23:30–24:00（30）合起来才是一整晚
  const totalAfter = spans.reduce((sum, s) => sum + (s.endMinutes - s.startMinutes), 0);
  assert.equal(totalAfter, oneNight + 30, '两个晚间段（30 + 30）+ 一个完整早晨段（420）= 480 分钟');
  assert.equal(totalAfter, oneNight * 2 - 420, '等价校验：两晚合计减去未落入窗口的那一段早晨');
});

test('expandFixedActivities：窗口首日能看到前一天跨夜活动留下的凌晨时段（不遗漏）', () => {
  const ctx = testContext();
  const sleep = createFixedActivity(
    { title: '睡眠', type: 'sleep', recurrence: { kind: 'weekly', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] }, start: '23:30', end: '07:00' },
    ctx,
  );
  // 窗口从周四开始：周四凌晨的一段来自周三晚上的睡眠
  const spans = expandFixedActivities([sleep], '2025-10-16', '2025-10-16');
  assert.equal(spans.length, 2, '同一天既有当日 23:30–24:00，也有前一日延续来的 00:00–07:00');
  assert.ok(spans.some((s) => s.startMinutes === 0 && s.endMinutes === 420));
  assert.ok(spans.some((s) => s.startMinutes === 1410 && s.endMinutes === 1440));
});

test('mergeSpans：重叠区间只保留一次，相邻区间合并', () => {
  const merged = mergeSpans([
    { date: '2025-10-16', startMinutes: 480, endMinutes: 600 },
    { date: '2025-10-16', startMinutes: 540, endMinutes: 660 },
    { date: '2025-10-16', startMinutes: 660, endMinutes: 700 },
    { date: '2025-10-17', startMinutes: 0, endMinutes: 60 },
  ]);
  assert.deepEqual(merged, [
    { date: '2025-10-16', startMinutes: 480, endMinutes: 700 },
    { date: '2025-10-17', startMinutes: 0, endMinutes: 60 },
  ]);
});

test('totalMergedMinutes：当天重叠的固定活动只扣减一次', () => {
  const spans = [
    { date: '2025-10-16', startMinutes: 480, endMinutes: 600 },
    { date: '2025-10-16', startMinutes: 540, endMinutes: 660 },
    { date: '2025-10-17', startMinutes: 0, endMinutes: 60 },
  ];
  assert.equal(totalMergedMinutes(spans, '2025-10-16'), 180, '480–660 合并后为 180 分钟，而不是 240');
  assert.equal(totalMergedMinutes(spans, '2025-10-17'), 60);
  assert.equal(totalMergedMinutes(spans, '2025-10-18'), 0);
});

test('fixedActivitiesOverlap：计算两个活动在指定日期的重叠分钟数（仅用于提示，不算数据错误）', () => {
  const ctx = testContext();
  const a = makeFixedActivity({ title: '课程', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '08:00', end: '10:00' }, ctx);
  const b = makeFixedActivity({ title: '通勤', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '09:30', end: '10:30' }, ctx);
  assert.equal(fixedActivitiesOverlap(a, b, '2025-10-16'), 30);
  assert.equal(fixedActivitiesOverlap(a, b, '2025-10-17'), 0, '当天不生效则为 0');
});

test('removeFixedActivity 返回新数组，不修改原数组', () => {
  const ctx = testContext();
  const a = makeFixedActivity({ title: 'A' }, ctx);
  const b = makeFixedActivity({ title: 'B' }, ctx);
  const list = [a, b];
  const result = removeFixedActivity(list, a.id);
  assert.deepEqual(result.map((x) => x.title), ['B']);
  assert.equal(list.length, 2);
});
