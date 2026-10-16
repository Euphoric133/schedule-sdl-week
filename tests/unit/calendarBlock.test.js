/**
 * CalendarBlock 测试。
 *
 * 这是"时间轴只有一种数据源"的结构性保证：
 * 学习、固定活动、计划休息、机动缓冲四类块都由这里统一产出与统计，
 * 每日视图与七天视图消费的是同一份块集合，因此不可能互相冲突。
 *
 * 重点验证硬约束 H8：休息与缓冲的门类不同、区间不重叠、统计不重复计算。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_KIND,
  blockBuffer,
  blockFromFixedActivity,
  blockFromSession,
  blockRest,
  computeDailyStats,
  computeWindowStats,
  createBlock,
  describeBlock,
  detectBlockOverlaps,
  groupBlocksByDate,
  isWeekend,
  validateBlocks,
} from '../../src/domain/calendarBlock.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { makeSession, testContext } from '../helpers/fixtures.js';

test('createBlock 校验时间区间，非法区间直接抛错（不产生负长度块）', () => {
  const block = createBlock({ id: 'blk_1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 });
  assert.equal(block.endMinutes - block.startMinutes, 60);
  assert.equal(block.derived, false);
  assert.throws(() => createBlock({ id: 'blk_2', kind: 'study', date: '2025-10-16', startMinutes: 1020, endMinutes: 1020 }), RangeError);
  assert.throws(() => createBlock({ id: 'blk_3', kind: 'study', date: '2025-10-16', startMinutes: 1020, endMinutes: 960 }), RangeError);
});

test('blockFromSession 带上任务信息与锁定状态', () => {
  const ctx = testContext();
  const session = makeSession({ taskId: 'tsk_1', startMinutes: 960, endMinutes: 1005, locked: true }, ctx);
  const block = blockFromSession(session, { task: { title: '线代作业', subject: '数学' } });

  assert.equal(block.kind, BLOCK_KIND.STUDY);
  assert.equal(block.refId, session.id);
  assert.equal(block.taskId, 'tsk_1');
  assert.equal(block.label, '线代作业');
  assert.equal(block.subject, '数学');
  assert.equal(block.locked, true);
  assert.equal(block.meta.state, 'flexible');
});

test('blockFromFixedActivity / blockRest / blockBuffer 分别标记为派生或固定', () => {
  const fixed = blockFromFixedActivity({ id: 'fix_1', title: '高等数学课', type: 'class' }, '2025-10-16', {
    startMinutes: 480,
    endMinutes: 580,
  });
  assert.equal(fixed.kind, BLOCK_KIND.FIXED);
  assert.equal(fixed.derived, false);
  assert.equal(fixed.meta.type, 'class');

  const rest = blockRest({ id: 'blk_rest_1', date: '2025-10-16', startMinutes: 1005, endMinutes: 1015 });
  assert.equal(rest.kind, BLOCK_KIND.REST);
  assert.equal(rest.derived, true);

  const buffer = blockBuffer({ id: 'blk_buf_1', date: '2025-10-16', startMinutes: 1015, endMinutes: 1033 });
  assert.equal(buffer.kind, BLOCK_KIND.BUFFER);
  assert.equal(buffer.derived, true);
});

test('groupBlocksByDate 按日期分组并按开始时间稳定排序', () => {
  const blocks = [
    createBlock({ id: 'blk_c', kind: 'study', date: '2025-10-17', startMinutes: 600, endMinutes: 660 }),
    createBlock({ id: 'blk_a', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }),
    createBlock({ id: 'blk_b', kind: 'fixed', date: '2025-10-16', startMinutes: 480, endMinutes: 580 }),
  ];
  const grouped = groupBlocksByDate(blocks);
  assert.deepEqual([...grouped.keys()], ['2025-10-17', '2025-10-16']);
  assert.deepEqual(grouped.get('2025-10-16').map((b) => b.id), ['blk_b', 'blk_a']);
});

test('computeDailyStats：四类时长分开统计，缓冲与休息不重复计算（H8）', () => {
  const blocks = [
    createBlock({ id: 'blk_s1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }),
    createBlock({ id: 'blk_s2', kind: 'study', date: '2025-10-16', startMinutes: 1080, endMinutes: 1140 }),
    blockRest({ id: 'blk_r', date: '2025-10-16', startMinutes: 1005, endMinutes: 1015 }),
    blockBuffer({ id: 'blk_b', date: '2025-10-16', startMinutes: 1140, endMinutes: 1158 }),
    createBlock({ id: 'blk_f', kind: 'fixed', date: '2025-10-16', startMinutes: 480, endMinutes: 580 }),
  ];

  const stats = computeDailyStats(blocks, '2025-10-16');
  assert.equal(stats.studyMinutes, 45 + 60);
  assert.equal(stats.restMinutes, 10);
  assert.equal(stats.bufferMinutes, 18);
  assert.equal(stats.fixedMinutes, 100);
  assert.equal(stats.sessionCount, 2);
  assert.equal(stats.firstStudyStart, 960);
  assert.equal(stats.lastStudyEnd, 1140);
});

test('computeWindowStats 返回窗口内每一天（含没有任何安排的日期）', () => {
  const blocks = [createBlock({ id: 'blk_1', kind: 'study', date: '2025-10-17', startMinutes: 600, endMinutes: 660 })];
  const stats = computeWindowStats(blocks, '2025-10-16', '2025-10-18');
  assert.deepEqual(stats.map((s) => s.date), ['2025-10-16', '2025-10-17', '2025-10-18']);
  assert.deepEqual(stats.map((s) => s.studyMinutes), [0, 60, 0]);
});

test('detectBlockOverlaps：学习/休息/缓冲互相重叠会被检测出来，固定活动之间允许重叠', () => {
  const overlapping = [
    createBlock({ id: 'blk_s', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 }),
    blockRest({ id: 'blk_r', date: '2025-10-16', startMinutes: 1000, endMinutes: 1010 }),
  ];
  const issues = detectBlockOverlaps(overlapping, '2025-10-16');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, VALIDATION_CODES.ENTITY_OVERLAP);
  assert.equal(issues[0].details.overlap, 10);

  const fixedOverlap = [
    createBlock({ id: 'blk_f1', kind: 'fixed', date: '2025-10-16', startMinutes: 480, endMinutes: 600 }),
    createBlock({ id: 'blk_f2', kind: 'fixed', date: '2025-10-16', startMinutes: 540, endMinutes: 660 }),
  ];
  assert.deepEqual(detectBlockOverlaps(fixedOverlap, '2025-10-16'), [], '固定活动重叠不构成数据错误（容量合并时只扣一次）');
});

test('validateBlocks：整体结构校验（类型、区间、重叠）', () => {
  const good = [createBlock({ id: 'blk_1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1020 })];
  assert.equal(validateBlocks(good).ok, true);

  const badKind = validateBlocks([{ ...good[0], kind: 'lecture' }]);
  assert.equal(badKind.ok, false);
  assert.ok(badKind.errors.some((i) => i.code === VALIDATION_CODES.ENUM));

  const badSpan = validateBlocks([{ ...good[0], endMinutes: 900 }]);
  assert.equal(badSpan.ok, false);
  assert.ok(badSpan.errors.some((i) => i.code === VALIDATION_CODES.SESSION_EMPTY_SPAN));

  const outOfRange = validateBlocks([{ ...good[0], startMinutes: -10 }]);
  assert.equal(outOfRange.ok, false);
  assert.ok(outOfRange.errors.some((i) => i.code === VALIDATION_CODES.RANGE));

  assert.equal(validateBlocks('not-an-array').ok, false);
});

test('describeBlock 生成可读文案（含时间与时长），供详情提示使用', () => {
  const block = createBlock({ id: 'blk_1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005, label: '线代作业' });
  assert.equal(describeBlock(block), '学习 16:00–16:45 · 线代作业（45 分钟）');
});

test('isWeekend 仅用于展示，不参与硬约束', () => {
  assert.equal(isWeekend('2025-10-18'), true, '周六');
  assert.equal(isWeekend('2025-10-19'), true, '周日');
  assert.equal(isWeekend('2025-10-16'), false, '周四');
});
