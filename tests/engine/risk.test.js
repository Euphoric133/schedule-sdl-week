/**
 * 风险评估测试（验收场景相关的"30 天截止风险评估"）。
 *
 * 风险结论会直接影响用户决策（"这个任务来得及吗？"），因此断言都落在
 * **可复算的事实**上：最早完成时刻、富余分钟数、风险等级。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RISK_LEVEL, buildPolicy } from '../../src/engine/policy.js';
import { assessAllRisks, assessDeadlineRisk, simulateEarliestCompletion } from '../../src/engine/risk.js';

const NOW = { date: '2025-10-16', minutes: 12 * 60 };

function windowsEveryDay(startMinutes = 16 * 60, endMinutes = 18 * 60) {
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes, endMinutes }];
  return map;
}

const policy = buildPolicy({ riskWindowDays: 30 });

function task(overrides = {}) {
  return {
    id: 'tsk_1',
    title: '线性代数作业',
    subject: '数学',
    plannedMinutes: 120,
    deadlineDate: '2025-10-25',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    dependsOn: [],
    status: 'not_started',
    ...overrides,
  };
}

test('simulateEarliestCompletion：按每日容量顺序填满，得到最早完成时刻', () => {
  const result = simulateEarliestCompletion({
    remainingMinutes: 180,
    startDate: '2025-10-16',
    horizonDays: 7,
    studyWindows: windowsEveryDay(), // 每天 120 分钟，扣 10% 缓冲后 108 分钟
    bufferRatio: 0.1,
  });

  assert.ok(result, '容量足够时应给出完成时刻');
  // 每天 16:00–18:00 = 120 分钟，扣除 10% 缓冲后 108 分钟可用于安排
  assert.equal(result.date, '2025-10-17', '108 + 72 = 180，第二天即可完成');
  assert.equal(result.minutes, 16 * 60 + 72);
});

test('simulateEarliestCompletion：窗口内放不下时返回 null（不猜测）', () => {
  const result = simulateEarliestCompletion({
    remainingMinutes: 10 * 60,
    startDate: '2025-10-16',
    horizonDays: 3,
    studyWindows: windowsEveryDay(),
    bufferRatio: 0.1,
  });
  assert.equal(result, null);
});

test('simulateEarliestCompletion：剩余工作量为 0 时返回 null（无需安排）', () => {
  assert.equal(
    simulateEarliestCompletion({ remainingMinutes: 0, startDate: '2025-10-16', horizonDays: 7, studyWindows: windowsEveryDay() }),
    null,
  );
});

test('assessDeadlineRisk：富余充足 → on_time，并给出富余时间', () => {
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-10-25' }),
    remainingMinutes: 120,
    taskBlocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
  });

  assert.equal(risk.level, RISK_LEVEL.ON_TIME);
  assert.ok(risk.slackMinutes > 0);
  assert.match(risk.message, /可以在截止前完成/);
});

test('assessDeadlineRisk：能完成但富余不足 → tight', () => {
  // 每天 120 分钟窗口（扣缓冲后 108 分钟），剩 100 分钟 ⇒ 最早 10-16 17:40 完成；
  // 截止 10-16 18:00 ⇒ 富余只有 20 分钟，远低于剩余总时长的 20%
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-10-16', deadlineTime: '18:00' }),
    remainingMinutes: 100,
    taskBlocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
  });

  assert.equal(risk.level, RISK_LEVEL.TIGHT);
  assert.ok(risk.slackMinutes >= 0);
  assert.match(risk.message, /富余时间/);
});

test('assessDeadlineRisk：按容量最早完成也晚于截止 → at_risk，并说明晚多久', () => {
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-10-16', deadlineTime: '18:00' }),
    remainingMinutes: 600,
    taskBlocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
  });

  assert.equal(risk.level, RISK_LEVEL.AT_RISK);
  assert.ok(risk.slackMinutes < 0);
  assert.match(risk.message, /比截止时间晚/);
});

test('assessDeadlineRisk：截止时间已过 → impossible', () => {
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-10-15', deadlineTime: '23:00' }),
    remainingMinutes: 60,
    taskBlocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
  });

  assert.equal(risk.level, RISK_LEVEL.IMPOSSIBLE);
  assert.match(risk.message, /已经过去/);
});

test('assessDeadlineRisk：30 天内都放不下 → impossible，并说明原因', () => {
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-12-31' }),
    remainingMinutes: 10 * 60,
    taskBlocks: [],
    now: NOW,
    policy: { ...policy, riskWindowDays: 5, studyWindows: windowsEveryDay(16 * 60, 16 * 60 + 30) },
  });

  assert.equal(risk.level, RISK_LEVEL.IMPOSSIBLE);
  assert.match(risk.message, /找不到足够的可用时间/);
});

test('assessDeadlineRisk：剩余工作量为 0 → on_time（无需安排）', () => {
  const risk = assessDeadlineRisk({ task: task(), remainingMinutes: 0, taskBlocks: [], now: NOW, policy });
  assert.equal(risk.level, RISK_LEVEL.ON_TIME);
  assert.match(risk.message, /剩余工作量为 0/);
});

test('assessDeadlineRisk：计划里的实际完成时刻优先于模拟结果', () => {
  const risk = assessDeadlineRisk({
    task: task({ deadlineDate: '2025-10-25' }),
    remainingMinutes: 60,
    taskBlocks: [{ date: '2025-10-24', startMinutes: 16 * 60, endMinutes: 17 * 60 }],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
  });

  assert.equal(risk.plannedFinish.date, '2025-10-24');
  assert.equal(risk.level, RISK_LEVEL.TIGHT, '10-24 完成、10-25 截止，富余不足总时长的 20%');
});

test('assessAllRisks：跳过已完成/已取消任务，按严重程度排序，并解释依赖阻塞', () => {
  const tasks = [
    task({ id: 'tsk_done', title: '已完成', status: 'completed' }),
    task({ id: 'tsk_cancelled', title: '已取消', status: 'cancelled' }),
    task({ id: 'tsk_late', title: '已经逾期', deadlineDate: '2025-10-10' }),
    task({ id: 'tsk_ok', title: '充裕', deadlineDate: '2025-11-30' }),
    task({ id: 'tsk_dep', title: '依赖任务', deadlineDate: '2025-11-30', dependsOn: ['tsk_late'] }),
  ];

  const remaining = new Map([
    ['tsk_done', 0],
    ['tsk_cancelled', 0],
    ['tsk_late', 60],
    ['tsk_ok', 60],
    ['tsk_dep', 60],
  ]);

  const risks = assessAllRisks({
    tasks,
    remainingByTask: remaining,
    blocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
    capacityDays: [],
  });

  assert.equal(risks.length, 3, '已完成与已取消的任务不参与风险评估');
  assert.equal(risks[0].taskId, 'tsk_late', '最严重的风险排在最前');
  assert.equal(risks[0].level, RISK_LEVEL.IMPOSSIBLE);
  const dependent = risks.find((risk) => risk.taskId === 'tsk_dep');
  assert.ok(dependent, '依赖任务也应被评估');
  assert.ok(dependent.dependencyRisk, '依赖任务必须带上"前置任务有风险"的信息，便于界面解释');
  assert.equal(dependent.dependencyRisk.taskTitle, '已经逾期');
});

test('风险评估结果稳定：同一输入两次评估完全一致', () => {
  const args = {
    tasks: [task({ id: 'tsk_x' }), task({ id: 'tsk_y', deadlineDate: '2025-10-18' })],
    remainingByTask: new Map([
      ['tsk_x', 120],
      ['tsk_y', 60],
    ]),
    blocks: [],
    now: NOW,
    policy: { ...policy, studyWindows: windowsEveryDay() },
    capacityDays: [],
  };
  assert.deepEqual(assessAllRisks(args), assessAllRisks(args));
});
