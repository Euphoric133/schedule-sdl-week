/**
 * 优先级评分测试。
 *
 * 需求明确要求"各评分采用明确、可测试的 0–100 分标准"，因此这里的每一个分值
 * 都被精确断言。引擎内部不读系统时钟，`now` 全部显式传入，测试完全可重复。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPolicy, continuousLimitFor, isFragmentLengthAllowed, normalizeWeights } from '../../src/engine/policy.js';
import { deadlineUrgencyScore, ratingToScore, scoreTask, sortBySchedulePriority } from '../../src/engine/priority.js';

const NOW = { date: '2025-10-16', minutes: 12 * 60 }; // 2025-10-16 12:00

test('ratingToScore：1–5 级线性映射到 0 / 25 / 50 / 75 / 100', () => {
  assert.equal(ratingToScore(1), 0);
  assert.equal(ratingToScore(2), 25);
  assert.equal(ratingToScore(3), 50);
  assert.equal(ratingToScore(4), 75);
  assert.equal(ratingToScore(5), 100);
  assert.equal(ratingToScore(0), 0, '越界值被夹到合法范围');
  assert.equal(ratingToScore(9), 100);
  assert.equal(ratingToScore(undefined), 0);
});

test('deadlineUrgencyScore：越接近截止越高，超期固定为 100', () => {
  const policy = buildPolicy({});

  // 截止还有 168 小时（7 天）→ 0
  assert.equal(deadlineUrgencyScore({ deadlineDate: '2025-10-23', deadlineTime: '12:00' }, NOW, policy.deadlineHorizonHours), 0);
  // 截止还有 84 小时（3.5 天）→ 50
  assert.equal(deadlineUrgencyScore({ deadlineDate: '2025-10-20', deadlineTime: '00:00' }, NOW, policy.deadlineHorizonHours), 50);
  // 截止还有 1 小时 → 约 99
  assert.equal(deadlineUrgencyScore({ deadlineDate: '2025-10-16', deadlineTime: '13:00' }, NOW, policy.deadlineHorizonHours), 99);
  // 已超期 → 100
  assert.equal(deadlineUrgencyScore({ deadlineDate: '2025-10-15', deadlineTime: '23:00' }, NOW, policy.deadlineHorizonHours), 100);
  // 恰好卡在评分窗口上
  assert.equal(deadlineUrgencyScore({ deadlineDate: '2025-10-16', deadlineTime: '12:00' }, NOW, policy.deadlineHorizonHours), 100);
});

test('scoreTask：按权重加权求和，分项可解释', () => {
  const policy = buildPolicy({});
  const task = {
    id: 'tsk_1',
    deadlineDate: '2025-10-20',
    deadlineTime: '00:00', // 距 12:00 还有 84 小时 → 紧迫度 50
    difficulty: 4, // 75
    importance: 5, // 100
    procrastination: 2, // 25
  };

  const score = scoreTask(task, { now: NOW, policy });
  const expected = 0.35 * 50 + 0.3 * 75 + 0.2 * 100 + 0.15 * 25;
  assert.equal(score.parts.deadlineUrgency, 50);
  assert.equal(score.parts.difficulty, 75);
  assert.equal(score.parts.importance, 100);
  assert.equal(score.parts.procrastination, 25);
  assert.equal(score.priority, Math.round(expected * 10000) / 10000);
  assert.ok(score.formula.includes('紧迫(50)'), '公式说明应包含分项数值，便于向用户解释');
});

test('normalizeWeights：和不为 1 时自动归一化，全为 0 时退回默认权重', () => {
  const normalized = normalizeWeights({ deadlineUrgency: 1, difficulty: 1, importance: 1, procrastination: 1 });
  assert.equal(Object.values(normalized).reduce((a, b) => a + b, 0), 1);
  assert.equal(normalized.deadlineUrgency, 0.25);

  const fallback = normalizeWeights({ deadlineUrgency: 0, difficulty: 0, importance: 0, procrastination: 0 });
  assert.equal(fallback.deadlineUrgency, 0.35, '权重全为 0 时必须退回默认值，否则评分会全是 NaN');

  const negative = normalizeWeights({ deadlineUrgency: -5, difficulty: 1, importance: 0, procrastination: 0 });
  assert.equal(negative.deadlineUrgency, 0, '负权重按 0 处理');
  assert.equal(negative.difficulty, 1, '只剩一个有效权重时归一化为 1');
});

test('buildPolicy：非法设置被夹到安全范围，缺字段用默认值', () => {
  const policy = buildPolicy({ bufferRatio: 5, baseContinuousMinutes: -3, defaultMinChunkMinutes: 0 });
  assert.equal(policy.bufferRatio, 0.5, '缓冲比例上限 0.5');
  assert.equal(policy.baseContinuousMinutes, 90, '非法值退回默认');
  assert.equal(policy.defaultMinChunkMinutes, 30);
  assert.equal(policy.restAfterContinuousMinutes, 50);
  assert.equal(policy.restMinutes, 10);
});

test('continuousLimitFor：按难度自适应，且有 25–180 分钟的边界', () => {
  const policy = buildPolicy({});
  assert.equal(continuousLimitFor(3, policy), 90);
  assert.equal(continuousLimitFor(1, policy), 54);
  assert.equal(continuousLimitFor(5, policy), 126);

  const flat = buildPolicy({ adaptiveContinuousLimit: false });
  assert.equal(continuousLimitFor(5, flat), 90, '关闭自适应后所有难度都使用基础上限');
});

test('isFragmentLengthAllowed：可拆分用任务区间，不可拆分必须等于总时长', () => {
  const policy = buildPolicy({});
  const splittable = { splittable: true, minChunkMinutes: 30, maxChunkMinutes: 60, plannedMinutes: 180 };
  assert.equal(isFragmentLengthAllowed(splittable, 30, policy), true);
  assert.equal(isFragmentLengthAllowed(splittable, 60, policy), true);
  assert.equal(isFragmentLengthAllowed(splittable, 29, policy), false);
  assert.equal(isFragmentLengthAllowed(splittable, 61, policy), false);

  const atomic = { splittable: false, minChunkMinutes: 120, maxChunkMinutes: 120, plannedMinutes: 120 };
  assert.equal(isFragmentLengthAllowed(atomic, 120, policy), true);
  assert.equal(isFragmentLengthAllowed(atomic, 60, policy), false);
});

test('sortBySchedulePriority：截止时间优先，其次评分，最后任务 ID（全序，结果稳定）', () => {
  const entries = [
    { task: { id: 'tsk_c', deadlineDate: '2025-10-20', deadlineTime: '23:00' }, score: { priority: 80 } },
    { task: { id: 'tsk_a', deadlineDate: '2025-10-18', deadlineTime: '23:00' }, score: { priority: 10 } },
    { task: { id: 'tsk_b', deadlineDate: '2025-10-20', deadlineTime: '23:00' }, score: { priority: 90 } },
  ];

  const sorted = sortBySchedulePriority(entries);
  assert.deepEqual(sorted.map((entry) => entry.task.id), ['tsk_a', 'tsk_b', 'tsk_c'], '最紧急的任务排最前，其次按评分');

  // 相同截止与相同评分时按 ID 兜底，保证全序
  const ties = [
    { task: { id: 'tsk_y', deadlineDate: '2025-10-20', deadlineTime: '23:00' }, score: { priority: 50 } },
    { task: { id: 'tsk_x', deadlineDate: '2025-10-20', deadlineTime: '23:00' }, score: { priority: 50 } },
  ];
  assert.deepEqual(sortBySchedulePriority(ties).map((entry) => entry.task.id), ['tsk_x', 'tsk_y']);
  assert.deepEqual(sortBySchedulePriority([...ties].reverse()).map((entry) => entry.task.id), ['tsk_x', 'tsk_y'], '输入顺序不影响结果');
});
