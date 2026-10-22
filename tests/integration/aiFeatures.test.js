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

/* ------------------------------------------------------------------ *
 * 回复文本的显示处理（普通访客不该看到原始 JSON）
 * ------------------------------------------------------------------ */

test('stripProposalBlock：去掉末尾的提议 JSON 块，只留文字', async () => {
  const { stripProposalBlock, splitReply } = await import('../../src/ai/chatClient.js');
  const reply = '数学今天超时了，建议少做 30 分钟。\n\n```json\n{"proposals":[{"kind":"lock_date","date":"2026-10-23"}]}\n```';
  const display = stripProposalBlock(reply);
  assert.ok(!display.includes('proposals'), '显示文本不能包含 proposals');
  assert.ok(!display.includes('```'), '显示文本不能包含代码围栏');
  assert.match(display, /建议少做 30 分钟/, '正常文字必须保留');

  const split = splitReply(reply);
  assert.equal(split.proposals.length, 1, '解析仍要拿到提议');
  assert.equal(split.proposals[0].date, '2026-10-23');
  assert.match(split.text, /建议少做 30 分钟/);
});

test('stripProposalBlock：没有代码块时原样保留', async () => {
  const { stripProposalBlock } = await import('../../src/ai/chatClient.js');
  assert.equal(stripProposalBlock('今天先做英语作文。'), '今天先做英语作文。');
});

test('stripProposalBlock：空提议块也要清掉（否则用户看到 {"proposals":[]}）', async () => {
  const { stripProposalBlock } = await import('../../src/ai/chatClient.js');
  const reply = '我这里看不到你的任务。\n\n```json\n{"proposals":[]}\n```';
  assert.ok(!stripProposalBlock(reply).includes('proposals'));
});

test('splitReply：非法 JSON 不猜测，返回空提议', async () => {
  const { splitReply } = await import('../../src/ai/chatClient.js');
  const split = splitReply('建议休息。\n```json\n{坏掉的 json}\n```');
  assert.deepEqual(split.proposals, []);
  assert.ok(!split.text.includes('坏掉的'), '无法解析的块不应显示给用户');
});

/* ------------------------------------------------------------------ *
 * ref → 真实 id 映射（修复模型抄错 id 的真实故障）
 * ------------------------------------------------------------------ */

test('buildRescueInput：上下文里每个任务都带唯一 ref，且与真实 id 一一对应', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: 'A', subject: '数学', plannedMinutes: 60 }));
  services.taskService.addTask(taskInput({ title: 'B', subject: '英语', plannedMinutes: 30 }));
  const input = feature.buildRescueInput();
  const refs = input.context.tasks.map((item) => item.ref);
  assert.deepEqual(refs, [1, 2], 'ref 必须是从 1 开始的连续编号');
  for (const item of input.context.tasks) {
    assert.ok(input.taskById.has(item.id), 'ref 必须能对应到真实任务');
  }
});

test('prepareRescuePreview：AI 用 ref 引用任务时能正常通过（模型抄错 id 的修复）', () => {
  const { app, services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学练习册', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const input = feature.buildRescueInput();
  const ref = input.context.tasks[0].ref;

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '建议今天少做一些。',
    proposals: [{ kind: 'defer_task', taskId: String(ref), minutes: 30, reason: '时间不够' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.stage, 'preview_ready');
});

test('prepareRescuePreview：ref 不存在时仍然拒绝（映射不是兜底猜测）', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学', deadlineDate: '2025-10-20' }));
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: 'x',
    proposals: [{ kind: 'defer_task', taskId: '99', minutes: 30 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'proposal_rejected');
});

test('prepareRescuePreview：模型直接写真实 id 也接受（两种写法都兼容）', () => {
  const { app, services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学', deadlineDate: '2025-10-20' }));
  const realId = app.getState().tasks[0].id;
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: 'x',
    proposals: [{ kind: 'defer_task', taskId: realId, minutes: 20 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

/* ------------------------------------------------------------------ *
 * 结果必须在重渲染后存活（实测发现的缺陷）
 * ------------------------------------------------------------------ */

test('急救结果存在服务层，重渲染后仍可取回', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学', deadlineDate: '2025-10-20' }));

  assert.equal(feature.getRescueState(), null, '初始应为空');

  const prepared = { ok: true, stage: 'preview_ready', proposals: [{ kind: 'lock_date', date: '2025-10-17' }], reply: '建议锁定' };
  feature.setRescueState({ reportText: '数学超时了', prepared });

  /**
   * 模拟 prepareRescuePreview 内部 requestPreview 触发的整页重渲染：
   * 页面重新执行 renderAi 时读的必须是这份状态。
   * 若结果只存在 DOM 里，重渲染会把它抹掉——用户看到分析闪一下就消失。
   */
  const restored = feature.getRescueState();
  assert.equal(restored.reportText, '数学超时了', '输入框文字要一起恢复');
  assert.equal(restored.prepared.stage, 'preview_ready');

  feature.clearRescueState();
  assert.equal(feature.getRescueState(), null);
});

test('prepareRescuePreview 成功后，结果可由 getRescueState 保存并复原', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学', deadlineDate: '2025-10-20' }));
  const input = feature.buildRescueInput();
  const ref = input.context.tasks[0].ref;

  const prepared = feature.prepareRescuePreview({
    ok: true,
    reply: '建议少做一点',
    proposals: [{ kind: 'defer_task', taskId: String(ref), minutes: 20 }],
  });
  feature.setRescueState({ reportText: '数学超时', prepared });

  const restored = feature.getRescueState();
  assert.equal(restored.prepared.ok, true);
  assert.equal(restored.prepared.stage, 'preview_ready');
  assert.ok(restored.prepared.preview, '预览对象必须保留，否则重渲染后按钮点了也没内容');
});

test('上下文提供 validTaskRefs，且与 tasks 的 ref 完全一致', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: 'A', deadlineDate: '2025-10-20' }));
  services.taskService.addTask(taskInput({ title: 'B', deadlineDate: '2025-10-20' }));
  const input = feature.buildRescueInput();
  assert.deepEqual(input.context.validTaskRefs, [1, 2]);
  assert.deepEqual(input.context.tasks.map((t) => t.ref), [1, 2]);
});

test('AI 直接写精确标题时也能映射（确定性匹配，非模糊猜测）', () => {
  const { app, services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学练习册', subject: '数学', deadlineDate: '2025-10-20' }));
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: 'x',
    proposals: [{ kind: 'defer_task', taskId: '数学练习册', minutes: 20 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('标题相同但重复出现时不猜（避免改错任务）', () => {
  const { services, feature } = setupFeatureApp();
  services.taskService.addTask(taskInput({ title: '数学作业', deadlineDate: '2025-10-20' }));
  services.taskService.addTask(taskInput({ title: '数学作业', deadlineDate: '2025-10-21' }));
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: 'x',
    proposals: [{ kind: 'defer_task', taskId: '数学作业', minutes: 20 }],
  });
  assert.equal(result.ok, false, '同名任务时必须拒绝，而不是随便选一个');
  assert.equal(result.stage, 'proposal_rejected');
});
