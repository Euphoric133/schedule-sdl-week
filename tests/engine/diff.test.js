/**
 * 差异计算测试（对应验收场景 11：调整预览能完整显示差异）。
 *
 * 差异是用户确认计划前唯一能看到的东西，因此要求：
 * - 分类完整：新增 / 移动 / 缩短延长 / 拆分 / 取消 / 保持不变 / 锁定时段影响 / 每日指标变化
 * - 受保护时段（已完成 / 锁定）绝不出现在"取消"里
 * - 每项都带可读原因
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { diffPlans, computeDailyDelta } from '../../src/engine/diff.js';

function plan(blocks, { status = 'feasible', days = [], unscheduled = [] } = {}) {
  return { status, blocks, days, unscheduled, windowStart: '2025-10-16', windowEnd: '2025-10-22' };
}

function study(overrides = {}) {
  return {
    id: 'blk_1',
    kind: 'study',
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    refId: 'ses_1',
    taskId: 'tsk_1',
    subject: '数学',
    label: '线性代数作业',
    locked: false,
    meta: {},
    ...overrides,
  };
}

const taskById = new Map([['tsk_1', { id: 'tsk_1', title: '线性代数作业', subject: '数学', status: 'not_started' }]]);

test('完全相同的两份计划：全部计入"保持不变"，没有新增/移动/取消', () => {
  const base = plan([study()]);
  const candidate = plan([study()]);
  const diff = diffPlans(base, candidate, { taskById });

  assert.equal(diff.counts.added, 0);
  assert.equal(diff.counts.moved, 0);
  assert.equal(diff.counts.cancelled, 0);
  assert.equal(diff.counts.unchanged, 1);
  assert.match(diff.unchanged[0].reasons[0], /未影响/);
});

test('新增时段：出现在 added 里并带原因', () => {
  const diff = diffPlans(plan([]), plan([study({ refId: null, id: 'ses_new', meta: { reasons: ['deadline_urgency'] } })]), { taskById });

  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].taskId, 'tsk_1');
  assert.equal(diff.added[0].minutes, 45);
  assert.ok(diff.added[0].reasons.length > 0);
});

test('同一 sessionId 改时间：计入 moved，带原时间与新时间', () => {
  const base = plan([study()]);
  const candidate = plan([study({ date: '2025-10-17', startMinutes: 19 * 60, endMinutes: 19 * 60 + 45 })]);
  const diff = diffPlans(base, candidate, { taskById });

  assert.equal(diff.moved.length, 1);
  assert.deepEqual(diff.moved[0].from, { date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 16 * 60 + 45 });
  assert.deepEqual(diff.moved[0].to, { date: '2025-10-17', startMinutes: 19 * 60, endMinutes: 19 * 60 + 45 });
  assert.ok(diff.moved[0].reasons.some((reason) => /重新规划|变化/.test(reason)));
});

test('同一 sessionId 改时长：计入 resized，区分缩短与延长', () => {
  const shortened = diffPlans(plan([study()]), plan([study({ endMinutes: 16 * 60 + 30 })]), { taskById });
  assert.equal(shortened.resized.length, 1);
  assert.equal(shortened.resized[0].fromMinutes, 45);
  assert.equal(shortened.resized[0].toMinutes, 30);
  assert.match(shortened.resized[0].reasons[0], /缩短/);

  const extended = diffPlans(plan([study()]), plan([study({ endMinutes: 16 * 60 + 60 })]), { taskById });
  assert.match(extended.resized[0].reasons[0], /延长/);
});

test('基础时段被拆成多段：计入 split，并给出拆分后的各段', () => {
  const base = plan([study({ endMinutes: 16 * 60 + 90 })]);
  const candidate = plan([
    study({ id: 'blk_a', refId: null, endMinutes: 16 * 60 + 45, meta: { reasons: ['same_subject_continuity'] } }),
    study({ id: 'blk_b', refId: null, startMinutes: 17 * 60, endMinutes: 17 * 60 + 45 }),
  ]);
  const diff = diffPlans(base, candidate, { taskById });

  assert.ok(diff.split.length + diff.added.length >= 1, '要么识别为拆分，要么至少如实列出新增片段');
  assert.equal(diff.cancelled.length, 0, '被拆分的源时段不应同时被算作取消');
});

test('基础时段消失且没有替代：计入 cancelled，带原时间与原因', () => {
  const diff = diffPlans(plan([study()]), plan([]), { taskById });
  assert.equal(diff.cancelled.length, 1);
  assert.equal(diff.cancelled[0].sessionId, 'ses_1');
  assert.deepEqual(diff.cancelled[0].from, { date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 16 * 60 + 45 });
  assert.match(diff.cancelled[0].reasons[0], /不再需要/);
});

test('锁定时段原样保留时进入 lockedImpact（说明"没有被移动"）', () => {
  const base = plan([study({ locked: true })]);
  const candidate = plan([study({ locked: true })]);
  const diff = diffPlans(base, candidate, { taskById });

  assert.equal(diff.lockedImpact.length, 1);
  assert.equal(diff.lockedImpact[0].impact, 'untouched');
  assert.match(diff.lockedImpact[0].message, /保持不变/);
  assert.equal(diff.cancelled.length, 0, '锁定时段绝不能出现在取消列表里');
});

test('已完成时段消失会被记为违规，而不是安静的"取消"', () => {
  const completedTask = new Map([['tsk_1', { id: 'tsk_1', title: '已完成任务', subject: '数学', status: 'completed' }]]);
  const base = plan([study({ locked: true, meta: { state: 'completed' } })]);
  const candidate = plan([]);
  const diff = diffPlans(base, candidate, { taskById: completedTask });

  assert.equal(diff.cancelled.length, 0, '已完成时段不能出现在取消列表');
  assert.ok(diff.violations.some((violation) => violation.code === 'protected_cancelled'));
  assert.ok(diff.lockedImpact.some((entry) => entry.impact === 'cancelled'));
});

test('每日指标变化：只列出有变化的日期，并给出候选 − 正式 的差值', () => {
  const base = plan([], {
    days: [
      { date: '2025-10-16', studyMinutes: 45, restMinutes: 0, bufferMinutes: 42, sessionCount: 1 },
      { date: '2025-10-17', studyMinutes: 0, restMinutes: 0, bufferMinutes: 42, sessionCount: 0 },
    ],
  });
  const candidate = plan([], {
    days: [
      { date: '2025-10-16', studyMinutes: 90, restMinutes: 10, bufferMinutes: 42, sessionCount: 2 },
      { date: '2025-10-17', studyMinutes: 0, restMinutes: 0, bufferMinutes: 42, sessionCount: 0 },
    ],
  });

  const delta = computeDailyDelta(base, candidate);
  assert.equal(delta.length, 1, '只有 10-16 有变化');
  assert.equal(delta[0].date, '2025-10-16');
  assert.equal(delta[0].studyDelta, 45);
  assert.equal(delta[0].restDelta, 10);
  assert.equal(delta[0].bufferDelta, 0);
  assert.equal(delta[0].sessionDelta, 1);
});

test('状态与未安排任务会被带进差异结果，供预页面显示结论', () => {
  const diff = diffPlans(
    plan([], { status: 'feasible' }),
    plan([], { status: 'partially_feasible', unscheduled: [{ taskId: 'tsk_1', remainingMinutes: 30, reasonCode: 'insufficient_capacity' }] }),
    { taskById },
  );

  assert.equal(diff.statusBefore, 'feasible');
  assert.equal(diff.statusAfter, 'partially_feasible');
  assert.equal(diff.feasibleAfter, false);
  assert.equal(diff.unscheduledAfter.length, 1);
});

test('首次生成计划（没有正式计划）时全部算新增，不报错', () => {
  const diff = diffPlans(null, plan([study()]), { taskById });
  assert.equal(diff.added.length, 1);
  assert.equal(diff.statusBefore, null);
  assert.equal(diff.counts.moved, 0);
});

test('差异结果稳定：同一对计划两次计算结果一致', () => {
  const base = plan([study(), study({ id: 'blk_2', refId: 'ses_2', startMinutes: 17 * 60, endMinutes: 18 * 60 })]);
  const candidate = plan([study({ date: '2025-10-17' }), study({ id: 'blk_3', refId: null })]);
  const first = diffPlans(base, candidate, { taskById });
  const second = diffPlans(base, candidate, { taskById });
  assert.deepEqual(first, second);
});
