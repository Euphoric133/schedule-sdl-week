/**
 * 时间模块测试（对应验收场景 18：时区与跨午夜）。
 *
 * 重点验证三件事：
 * 1. 日期字符串解析不会被 Date 的 UTC 隐式解析带偏一天（东八区经典 bug）。
 * 2. 跨午夜时段（如睡眠 23:30–07:00）会被正确切成两段，并归属于各自的日期。
 * 3. 业务日边界（默认 04:00）的归属规则稳定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  absoluteMinutes,
  addDays,
  businessDateFor,
  compareWallTime,
  dateRange,
  dateToOrdinal,
  diffDays,
  daysInMonth,
  formatDateWithWeekday,
  formatDuration,
  formatMinutes,
  formatMinutesWithDayMark,
  isOverlapping,
  isValidDateString,
  isValidTimeString,
  minutesBetweenWallTimes,
  ordinalToDate,
  overlapLength,
  parseDateString,
  parseTimeString,
  spanToMinutes,
  splitOvernightSpan,
  toWallTimeFromUtcOffsetMs,
  wallTimeToUtcOffsetMs,
  weekday,
} from '../../src/domain/time.js';

test('日期字符串校验：接受合法日期，拒绝不存在的日期与错误格式', () => {
  assert.equal(isValidDateString('2025-10-16'), true);
  assert.equal(isValidDateString('2024-02-29'), true, '闰年 2 月 29 日应当合法');
  assert.equal(isValidDateString('2025-02-29'), false, '平年 2 月 29 日不合法');
  assert.equal(isValidDateString('2025-13-01'), false);
  assert.equal(isValidDateString('2025-00-10'), false);
  assert.equal(isValidDateString('2025-10-32'), false);
  assert.equal(isValidDateString('2025-1-6'), false, '必须补零');
  assert.equal(isValidDateString('2025/10/16'), false);
  assert.equal(isValidDateString(''), false);
  assert.equal(isValidDateString(null), false);
  assert.equal(isValidDateString(20251016), false);
});

test('时刻字符串校验与解析', () => {
  assert.equal(isValidTimeString('00:00'), true);
  assert.equal(isValidTimeString('23:59'), true);
  assert.equal(isValidTimeString('24:00'), false, '24:00 不是合法墙钟时刻，跨夜请用分钟数表示');
  assert.equal(isValidTimeString('9:00'), false);
  assert.equal(isValidTimeString('09:60'), false);
  assert.equal(parseTimeString('16:30'), 990);
  assert.throws(() => parseTimeString('16:60'), TypeError);
});

test('日期与天序号互转保持稳定，且不发生时区偏移', () => {
  assert.equal(ordinalToDate(dateToOrdinal('2025-10-16')), '2025-10-16');
  assert.equal(ordinalToDate(dateToOrdinal('1970-01-01')), '1970-01-01');
  assert.equal(dateToOrdinal('1970-01-02') - dateToOrdinal('1970-01-01'), 1);
  // 这是最容易出错的地方：跨月、跨年、跨闰日
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2025-01-01', -1), '2024-12-31');
  assert.equal(diffDays('2025-10-16', '2025-10-23'), 7);
  assert.equal(diffDays('2025-10-23', '2025-10-16'), -7);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2025, 2), 28);
});

test('星期计算符合 ISO 约定（1=周一 … 7=周日）', () => {
  // 2025-10-16 是星期四
  assert.equal(weekday('2025-10-16'), 4);
  assert.equal(weekday('2025-10-19'), 7, '星期日为 7');
  assert.equal(weekday('2025-10-20'), 1, '星期一为 1');
  assert.equal(weekday('1970-01-01'), 4, '1970-01-01 是星期四');
  assert.equal(formatDateWithWeekday('2025-10-16'), '2025-10-16 周四');
});

test('dateRange 覆盖闭区间，且 start > end 时返回空数组', () => {
  assert.deepEqual(dateRange('2025-10-16', '2025-10-18'), ['2025-10-16', '2025-10-17', '2025-10-18']);
  assert.deepEqual(dateRange('2025-10-16', '2025-10-16'), ['2025-10-16']);
  assert.deepEqual(dateRange('2025-10-18', '2025-10-16'), []);
  // 七天窗口的边界：今天 + 6 天
  assert.equal(dateRange('2025-10-16', addDays('2025-10-16', 6)).length, 7);
});

test('分钟格式化：环绕到 24 小时内，跨夜用 +1 标记', () => {
  assert.equal(formatMinutes(0), '00:00');
  assert.equal(formatMinutes(990), '16:30');
  assert.equal(formatMinutes(1439), '23:59');
  assert.equal(formatMinutes(1440), '00:00', '整点跨夜环绕');
  assert.equal(formatMinutesWithDayMark(1440), '00:00+1');
  assert.equal(formatMinutesWithDayMark(1530), '01:30+1');
  assert.equal(formatMinutesWithDayMark(990), '16:30');
});

test('区间重叠判定使用半开区间：首尾相接不算重叠', () => {
  assert.equal(isOverlapping(960, 1020, 1020, 1080), false, '16:00-17:00 与 17:00-18:00 相邻合法');
  assert.equal(isOverlapping(960, 1021, 1020, 1080), true);
  assert.equal(isOverlapping(1020, 1080, 960, 1020), false);
  assert.equal(overlapLength(960, 1020, 1000, 1100), 20);
  assert.equal(overlapLength(960, 1020, 1020, 1100), 0);
  assert.equal(overlapLength(960, 1020, 600, 700), 0);
});

test('业务日边界：04:00 之前的时段归属于前一天', () => {
  assert.equal(DEFAULT_DAY_BOUNDARY_HOUR, 4);
  assert.equal(businessDateFor('2025-10-17', 1 * 60 + 30), '2025-10-16', '凌晨 01:30 属于前一天');
  assert.equal(businessDateFor('2025-10-17', 3 * 60 + 59), '2025-10-16');
  assert.equal(businessDateFor('2025-10-17', 4 * 60), '2025-10-17', '04:00 起属于当天');
  assert.equal(businessDateFor('2025-10-17', 20 * 60), '2025-10-17');
  assert.equal(businessDateFor('2025-10-17', 1 * 60 + 30, 6), '2025-10-16', '边界设为 06:00 时，01:30 仍属于前一天');
  assert.equal(businessDateFor('2025-10-17', 7 * 60, 6), '2025-10-17', '边界设为 06:00 时，07:00 属于当天');
});

test('跨午夜时段切分：睡眠 23:30–07:00 切成两段并归属各自日期', () => {
  const parts = splitOvernightSpan({ date: '2025-10-16', startMinutes: 23 * 60 + 30, endMinutes: 31 * 60 });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { date: '2025-10-16', startMinutes: 1410, endMinutes: 1440 });
  assert.deepEqual(parts[1], { date: '2025-10-17', startMinutes: 0, endMinutes: 420 });
  assert.equal(parts.reduce((sum, p) => sum + (p.endMinutes - p.startMinutes), 0), 450, '切分不改变总时长');
});

test('跨午夜时段切分：不跨夜时原样返回一段', () => {
  const parts = splitOvernightSpan({ date: '2025-10-16', startMinutes: 960, endMinutes: 1020 });
  assert.deepEqual(parts, [{ date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }]);
});

test('跨午夜时段切分：超过 24 小时或空区间会抛错，避免静默产生错误数据', () => {
  assert.throws(() => splitOvernightSpan({ date: '2025-10-16', startMinutes: 600, endMinutes: 600 }), RangeError);
  assert.throws(() => splitOvernightSpan({ date: '2025-10-16', startMinutes: 600, endMinutes: 300 }), RangeError);
  assert.throws(() => splitOvernightSpan({ date: 'bad-date', startMinutes: 600, endMinutes: 700 }), TypeError);
});

test('spanToMinutes 支持字符串形式并自动识别跨夜', () => {
  assert.deepEqual(spanToMinutes({ start: '16:00', end: '17:00' }), { startMinutes: 960, endMinutes: 1020, lengthMinutes: 60 });
  const overnight = spanToMinutes({ start: '22:00', end: '02:00' });
  assert.equal(overnight.lengthMinutes, 240, '22:00–02:00 应为 240 分钟');
  assert.deepEqual(spanToMinutes({ startMinutes: 1410, endMinutes: 1470 }), { startMinutes: 1410, endMinutes: 1470, lengthMinutes: 60 });
});

test('墙钟时间比较与差值基于绝对分钟数（跨日正确）', () => {
  const a = { date: '2025-10-16', minutes: 1380 };
  const b = { date: '2025-10-17', minutes: 60 };
  assert.equal(compareWallTime(a, b), -1);
  assert.equal(minutesBetweenWallTimes(a, b), 120, '23:00 到次日 01:00 相差 120 分钟');
  assert.equal(absoluteMinutes({ date: '2025-10-16', minutes: 0 }) + 1440, absoluteMinutes({ date: '2025-10-17', minutes: 0 }));
});

test('与时间戳的换算在固定偏移下可逆（不依赖宿主机时区）', () => {
  const offset = 8 * 60; // 东八区
  const wall = { date: '2025-10-16', minutes: 990 };
  const ms = wallTimeToUtcOffsetMs(wall, offset);
  assert.deepEqual(toWallTimeFromUtcOffsetMs(ms, offset), wall);
  // 2025-10-16 16:30 (+08:00) == 2025-10-16T08:30:00Z
  assert.equal(new Date(ms).toISOString(), '2025-10-16T08:30:00.000Z');
});

test('时长格式化', () => {
  assert.equal(formatDuration(45), '45 分钟');
  assert.equal(formatDuration(60), '1 小时');
  assert.equal(formatDuration(95), '1 小时 35 分钟');
  assert.equal(formatDuration(0), '0 分钟');
  assert.equal(formatDuration(-30), '-30 分钟');
  assert.equal(formatDuration(Number.NaN), '—');
});

test('parseDateString 对非法输入抛错（避免调用方拿到 undefined 继续计算）', () => {
  assert.deepEqual(parseDateString('2025-03-01'), { year: 2025, month: 3, day: 1 });
  assert.throws(() => parseDateString('2025-02-30'), TypeError);
});
