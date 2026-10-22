/**
 * AI 功能的核心逻辑测试：提议校验、提议→ops 转换、时间校准统计。
 *
 * 重点覆盖"AI 出错时程序必须拦住"的路径——
 * 因为这些路径一旦漏了，用户会看到一个 AI 编造出来的方案被当成合法建议。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateProposals, proposalsToOps, MAX_PROPOSALS, MAX_DEFER_MINUTES } from '../../src/ai/proposals.js';
import { collectSamples, calibrateStats, suggestEstimate, MIN_SAMPLES } from '../../src/ai/calibration.js';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function makeCtx({ tasks = null, remaining = null } = {}) {
  const taskList = tasks ?? [
    { id: 'task_1', title: '数学作业', subject: '数学', plannedMinutes: 90 },
    { id: 'task_2', title: '英语作文', subject: '英语', plannedMinutes: 60 },
  ];
  return {
    today: '2026-10-22',
    latestAllowedDate: '2026-10-28',
    taskById: new Map(taskList.map((task) => [task.id, task])),
    remainingByTask: remaining ?? { task_1: 90, task_2: 60 },
  };
}

function makeState({ tasks, sessions = [] }) {
  return { tasks, sessions, settings: {} };
}

/* ------------------------------------------------------------------ *
 * validateProposals：正常路径
 * ------------------------------------------------------------------ */

test('合法提议：defer_task 与 lock_date 都通过', () => {
  const result = validateProposals(
    {
      proposals: [
        { kind: 'defer_task', taskId: 'task_1', minutes: 40, reason: '今天做不完' },
        { kind: 'lock_date', date: '2026-10-23', reason: '明天考试' },
      ],
    },
    makeCtx(),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0].taskTitle, '数学作业');
  assert.equal(result.proposals[1].date, '2026-10-23');
});

/* ------------------------------------------------------------------ *
 * validateProposals：拒绝路径（每一条都是一个真实风险）
 * ------------------------------------------------------------------ */

test('拒绝：引用不存在的任务（防止预览里凭空多出改动）', () => {
  const result = validateProposals({ proposals: [{ kind: 'defer_task', taskId: 'task_999', minutes: 30 }] }, makeCtx());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('不存在的任务')));
});

test('拒绝：不允许的调整类型（例如尝试改截止时间）', () => {
  const result = validateProposals(
    { proposals: [{ kind: 'change_deadline', taskId: 'task_1', date: '2026-10-30' }] },
    makeCtx(),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('不被允许')));
});

test('拒绝：推迟分钟数超过任务剩余工作量', () => {
  const result = validateProposals({ proposals: [{ kind: 'defer_task', taskId: 'task_1', minutes: 200 }] }, makeCtx());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('只剩下')));
});

test('拒绝：推迟分钟数为 0 / 负数 / 小数', () => {
  for (const minutes of [0, -10, 12.5]) {
    const result = validateProposals({ proposals: [{ kind: 'defer_task', taskId: 'task_1', minutes }] }, makeCtx());
    assert.equal(result.ok, false, `minutes=${minutes} 应被拒绝`);
  }
});

test('拒绝：推迟分钟数超过上限（防止一次改掉一整天）', () => {
  const ctx = makeCtx({ remaining: { task_1: MAX_DEFER_MINUTES + 60 } });
  const result = validateProposals({ proposals: [{ kind: 'defer_task', taskId: 'task_1', minutes: MAX_DEFER_MINUTES + 1 }] }, ctx);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('幅度过大')));
});

test('拒绝：锁定过去的日期', () => {
  const result = validateProposals({ proposals: [{ kind: 'lock_date', date: '2026-10-20' }] }, makeCtx());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('已经过去')));
});

test('拒绝：锁定超出规划窗口的日期', () => {
  const result = validateProposals({ proposals: [{ kind: 'lock_date', date: '2026-12-01' }] }, makeCtx());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('超出规划窗口')));
});

test('拒绝：日期格式非法', () => {
  const result = validateProposals({ proposals: [{ kind: 'lock_date', date: '2026/10/23' }] }, makeCtx());
  assert.equal(result.ok, false);
});

test('拒绝：重复调整同一个任务', () => {
  const result = validateProposals(
    {
      proposals: [
        { kind: 'defer_task', taskId: 'task_1', minutes: 20 },
        { kind: 'defer_task', taskId: 'task_1', minutes: 30 },
      ],
    },
    makeCtx(),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('重复调整')));
});

test('拒绝：提议条数超上限', () => {
  const proposals = Array.from({ length: MAX_PROPOSALS + 1 }, (_, index) => ({
    kind: 'lock_date',
    date: `2026-10-${String(23 + index).padStart(2, '0')}`,
  }));
  const result = validateProposals({ proposals }, makeCtx());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('最多接受')));
});

test('拒绝：空提议 / 非对象输入', () => {
  assert.equal(validateProposals({ proposals: [] }, makeCtx()).ok, false);
  assert.equal(validateProposals(null, makeCtx()).ok, false);
  assert.equal(validateProposals({}, makeCtx()).ok, false);
});

test('部分不合法时整体不通过（不做"部分采纳"）', () => {
  const result = validateProposals(
    {
      proposals: [
        { kind: 'defer_task', taskId: 'task_1', minutes: 20 },
        { kind: 'defer_task', taskId: 'task_404', minutes: 20 },
      ],
    },
    makeCtx(),
  );
  assert.equal(result.ok, false, '有一条不合法就必须整体拒绝，避免用户看到半懂的方案');
});

/* ------------------------------------------------------------------ *
 * proposalsToOps
 * ------------------------------------------------------------------ */

test('defer_task → task.update，且不会把预计用时减到已完成以下', () => {
  const ctx = makeCtx({
    tasks: [{ id: 'task_1', title: '数学', subject: '数学', plannedMinutes: 60, priorCompletedMinutes: 50 }],
    remaining: { task_1: 10 },
  });
  const ops = proposalsToOps([{ kind: 'defer_task', taskId: 'task_1', minutes: 10, taskTitle: '数学' }], {
    taskById: ctx.taskById,
    today: ctx.today,
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'task.update');
  assert.equal(ops[0].patch.plannedMinutes, 50, '60 − 10 = 50，且不低于已完成的 50');
  assert.ok(ops[0].patch.plannedMinutes >= 1, '绝不产生 0 或负数的预计用时');
});

test('lock_date → fixedActivity.add，且标记为不可移动', () => {
  const ctx = makeCtx();
  const ops = proposalsToOps([{ kind: 'lock_date', date: '2026-10-23', reason: '明天考试' }], {
    taskById: ctx.taskById,
    today: ctx.today,
    lockDateTitlePrefix: 'TEST:',
  });
  assert.equal(ops[0].kind, 'fixedActivity.add');
  assert.equal(ops[0].input.movable, false, '锁定的日期不能被引擎移动');
  assert.deepEqual(ops[0].input.recurrence, { kind: 'once', date: '2026-10-23' });
});

/* ------------------------------------------------------------------ *
 * 时间校准：统计必须由程序算，且口径正确
 * ------------------------------------------------------------------ */

test('collectSamples：只统计已完成任务，实际用时 = 完成任务时段 + 手工填的已完成', () => {
  const state = makeState({
    tasks: [
      { id: 't1', title: '数学练习', subject: '数学', plannedMinutes: 60, status: 'completed', priorCompletedMinutes: 10 },
      { id: 't2', title: '英语阅读', subject: '英语', plannedMinutes: 30, status: 'completed' },
      { id: 't3', title: '还没做', subject: '数学', plannedMinutes: 60, status: 'not_started' },
    ],
    sessions: [
      { taskId: 't1', state: 'completed', actualMinutes: 80 },
      { taskId: 't2', state: 'completed', plannedMinutes: 25 },
      { taskId: 't3', state: 'completed', actualMinutes: 999 }, // 任务未完成，不应计入
    ],
  });
  const samples = collectSamples(state);
  assert.equal(samples.length, 2, '只有已完成任务参与统计');
  const math = samples.find((item) => item.subject === '数学');
  assert.equal(math.actualMinutes, 90, '80（时段）+ 10（手工声明）');
  assert.equal(math.plannedMinutes, 60);
  assert.equal(math.ratio, 1.5);
});

test('calibrateStats：均值按"实际总和 ÷ 计划总和"计算，而不是比例的平均值', () => {
  const samples = [
    { subject: '数学', title: 'a', plannedMinutes: 60, actualMinutes: 120, ratio: 2 },
    { subject: '数学', title: 'b', plannedMinutes: 120, actualMinutes: 120, ratio: 1 },
  ];
  const { subjects } = calibrateStats(samples);
  const math = subjects.find((item) => item.subject === '数学');
  // 总和口径：(120+120)/(60+120)=1.333；比例平均会是 1.5 —— 两者不同，必须选前者
  assert.equal(math.meanRatio, 1.333);
  assert.equal(math.meanDiffMinutes, 30, '平均实际 120 vs 平均计划 90');
});

test('calibrateStats：样本不足时标记 unreliable，且不会给出"低估"结论', () => {
  const samples = [
    { subject: '物理', title: 'a', plannedMinutes: 60, actualMinutes: 120, ratio: 2 },
    { subject: '物理', title: 'b', plannedMinutes: 60, actualMinutes: 120, ratio: 2 },
  ];
  const { subjects } = calibrateStats(samples);
  const physics = subjects.find((item) => item.subject === '物理');
  assert.equal(physics.reliable, false);
  assert.equal(physics.sampleCount, 2);
  assert.ok(physics.sampleCount < MIN_SAMPLES);
});

test('calibrateStats：偏差在噪声阈值内视为基本准确', () => {
  const samples = Array.from({ length: 4 }, (_, index) => ({
    subject: '语文',
    title: `t${index}`,
    plannedMinutes: 60,
    actualMinutes: 63, // +5%
    ratio: 1.05,
  }));
  const { subjects } = calibrateStats(samples);
  assert.equal(subjects.find((item) => item.subject === '语文').tendency, 'stable');
});

test('suggestEstimate：样本不足或波动正常时不调整', () => {
  assert.equal(suggestEstimate('数学', 60, []), null);
  const insufficient = [{ subject: '数学', reliable: false, tendency: 'underestimated', meanRatio: 1.5, sampleCount: 1 }];
  assert.equal(suggestEstimate('数学', 60, insufficient), null);
  const stable = [{ subject: '数学', reliable: true, tendency: 'stable', meanRatio: 1.0, sampleCount: 5 }];
  assert.equal(suggestEstimate('数学', 60, stable), null);
});

test('suggestEstimate：低估时给出更长的建议值，且取整到 5 分钟', () => {
  const stats = [{ subject: '数学', reliable: true, tendency: 'underestimated', meanRatio: 1.4, sampleCount: 5, meanDiffMinutes: 24 }];
  const result = suggestEstimate('数学', 60, stats);
  assert.ok(result);
  assert.equal(result.adjusted, 85, '60 × 1.4 = 84 → 取整到 85');
  assert.match(result.reason, /多 24 分钟/);
});

/* ------------------------------------------------------------------ *
 * 服务层端到端：提议 → 程序校验 → 生成候选预览（不写入正式计划）
 * ------------------------------------------------------------------ */

import { createTestApp, taskInput } from '../helpers/app.js';
import { createAiFeatureService } from '../../src/services/aiFeatureService.js';
import { FIXED_NOW } from '../helpers/clock.js';

function setupFeatureApp() {
  const { app, services, idFactory } = createTestApp();
  const feature = createAiFeatureService({
    app,
    planService: services.planService,
    now: () => ({ date: FIXED_NOW.date, minutes: FIXED_NOW.minutes }),
  });
  return { app, services, feature, idFactory };
}

test('prepareRescuePreview：校验通过时生成候选预览，但正式计划零改动', () => {
  const { app, services, feature } = setupFeatureApp();
  const task = services.taskService.addTask(
    taskInput({ title: '数学作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }),
  );
  assert.equal(task.ok, true);
  const taskId = app.getState().tasks[0].id;

  // 先有一份正式计划，才能验证"预览不覆盖它"
  services.planService.requestPreview({ changeSummary: '初始计划' });
  services.planService.applyPreview();
  const officialBefore = JSON.stringify(services.planService.getOfficialPlan());

  const input = feature.buildRescueInput();
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '数学已经超时，建议今天少做一部分。',
    proposals: [{ kind: 'defer_task', taskId, minutes: 30, reason: '今天时间不够' }],
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.stage, 'preview_ready');
  assert.ok(result.preview, '应生成候选预览');
  // 铁律：确认之前正式计划不能变
  assert.equal(JSON.stringify(services.planService.getOfficialPlan()), officialBefore, '正式计划必须零改动');
});

test('prepareRescuePreview：提议不合法时不生成任何预览', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学作业', deadlineDate: '2025-10-20' }));

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '编一个不存在的任务。',
    proposals: [{ kind: 'defer_task', taskId: 'task_not_exist', minutes: 30 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'proposal_rejected');
  assert.equal(services.planService.getPendingPreview(), null, '被拒绝时不应留下草稿预览');
});

test('prepareRescuePreview：AI 失败时如实返回，不生成预览', () => {
  const { feature } = setupFeatureApp();
  const result = feature.prepareRescuePreview({ ok: false, message: '额度用完了' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'ai_failed');
  assert.ok(result.issues[0].includes('额度'));
});

test('buildRescueInput：上下文里的任务 id 与校验用的任务表完全一致', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '任务A', subject: '数学', plannedMinutes: 60 }));
  services.taskService.addTask(taskInput({ title: '任务B', subject: '英语', plannedMinutes: 30 }));

  const input = feature.buildRescueInput();
  const contextIds = input.context.tasks.map((task) => task.id).sort();
  const mapIds = [...input.taskById.keys()].sort();
  assert.deepEqual(contextIds, mapIds, '送给 AI 的 id 必须与校验用的一致，否则合法建议会被误拒');
  assert.equal(input.today, FIXED_NOW.date);
});

test('getCalibration：没有 AI 也能用（纯程序统计）', () => {
  const { services, feature } = setupFeatureApp();
  const calibration = feature.getCalibration();
  assert.ok(Array.isArray(calibration.subjects));
  assert.equal(calibration.samples.length, 0, '没有已完成任务时应为空，而不是编造数据');
});

test('estimateForNewTask：数据不足时返回 null（不硬给建议）', () => {
  const { feature } = setupFeatureApp();
  assert.equal(feature.estimateForNewTask('数学', 60), null);
});
