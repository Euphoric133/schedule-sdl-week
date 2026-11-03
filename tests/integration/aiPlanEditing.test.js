/**
 * 「让 AI 会改计划」的核心测试。
 *
 * 覆盖三件必须成立的事：
 * 1. 每种新提议类型的**校验边界**（该拒的拒、该放行的放行并打风险标记）；
 * 2. 提议 → ops 的转换正确（包括软删除 / 彻底删除 / 完成链路）；
 * 3. 端到端：提议只能经预览确认后才写入，确认前数据零改动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CREATE_TASKS,
  MAX_DELETE_TASKS,
  PROPOSAL_KINDS,
  proposalsToOps,
  validateProposals,
} from '../../src/ai/proposals.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { createAiFeatureService } from '../../src/services/aiFeatureService.js';
import { FIXED_NOW } from '../helpers/clock.js';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const TODAY = '2026-11-03';

function makeCtx({ tasks, sessions = [], subjects = ['数学', '英语', '生物', '化学'] } = {}) {
  const taskList = tasks ?? [
    { id: 'task_1', title: '数学作业', subject: '数学', plannedMinutes: 90, status: 'not_started' },
    { id: 'task_2', title: '英语作文', subject: '英语', plannedMinutes: 60, status: 'not_started' },
  ];
  return {
    today: TODAY,
    latestAllowedDate: '2026-11-09',
    taskById: new Map(taskList.map((task) => [task.id, task])),
    remainingByTask: Object.fromEntries(taskList.map((task) => [task.id, task.plannedMinutes])),
    subjects,
    state: { tasks: taskList, sessions },
    contextTasks: taskList.map((task, index) => ({ ref: index + 1, id: task.id })),
  };
}

function createProposal(overrides = {}) {
  return {
    kind: 'create_task',
    title: '生物实验报告',
    subject: '生物',
    plannedMinutes: 90,
    deadlineDate: '2026-11-07',
    deadlineTime: '23:00',
    importance: 4,
    reason: '新增作业',
    ...overrides,
  };
}

function run(proposals, ctx = makeCtx()) {
  return validateProposals({ proposals }, ctx);
}

function setup() {
  const { app, services } = createTestApp();
  const feature = createAiFeatureService({
    app,
    planService: services.planService,
    now: () => ({ date: FIXED_NOW.date, minutes: FIXED_NOW.minutes }),
  });
  return { app, services, feature };
}

/* ------------------------------------------------------------------ *
 * 1. 提议类型与 create_task 校验
 * ------------------------------------------------------------------ */

test('PROPOSAL_KINDS：新增五类操作，且保留原有两类', () => {
  for (const kind of ['defer_task', 'lock_date', 'create_task', 'update_task', 'complete_task', 'cancel_task', 'delete_task']) {
    assert.ok(PROPOSAL_KINDS.includes(kind), `缺少 ${kind}`);
  }
});

test('create_task：合法输入通过，字段被规范化', () => {
  const result = run([createProposal()]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const proposal = result.proposals[0];
  assert.equal(proposal.kind, 'create_task');
  assert.equal(proposal.title, '生物实验报告');
  assert.equal(proposal.plannedMinutes, 90);
  assert.equal(proposal.splittable, true, '未指定时默认允许拆分');
  assert.equal(proposal.deadlineTime, '23:00');
  assert.deepEqual(result.flags, [], '未来日期不应带风险标记');
});

test('create_task：缺标题 / 标题超长 → 拒绝', () => {
  assert.equal(run([createProposal({ title: '' })]).ok, false);
  assert.equal(run([createProposal({ title: '   ' })]).ok, false);
  assert.equal(run([createProposal({ title: 'x'.repeat(200) })]).ok, false);
});

test('create_task：科目必须已存在 → 否则拒绝', () => {
  const result = run([createProposal({ subject: '物理' })]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('物理') && issue.includes('不存在')));
});

test('create_task：非法日期格式与不存在的日期 → 拒绝', () => {
  assert.equal(run([createProposal({ deadlineDate: '2026/11/07' })]).ok, false);
  assert.equal(run([createProposal({ deadlineDate: '2020-02-30' })]).ok, false, '2 月 30 日并不存在');
});

test('create_task：用时与评分越界 → 拒绝', () => {
  assert.equal(run([createProposal({ plannedMinutes: 0 })]).ok, false);
  assert.equal(run([createProposal({ plannedMinutes: 4 })]).ok, false, '低于最小粒度');
  assert.equal(run([createProposal({ plannedMinutes: 999999 })]).ok, false);
  assert.equal(run([createProposal({ importance: 6 })]).ok, false);
  assert.equal(run([createProposal({ difficulty: 0 })]).ok, false);
});

test('create_task：超过上限数量 → 拒绝', () => {
  const many = Array.from({ length: MAX_CREATE_TASKS + 1 }, (_, index) => createProposal({ title: `任务${index}` }));
  const result = run(many);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('最多新建')));
});

/* ------------------------------------------------------------------ *
 * 2. 截止日期越界：放行 + 风险标记（核心行为变更）
 * ------------------------------------------------------------------ */

test('create_task：截止日期早于今天 → 通过，并带 deadline_in_past 标记', () => {
  const result = run([createProposal({ deadlineDate: '2026-10-20' })]);
  assert.equal(result.ok, true, '过去日期不再直接拒绝');
  assert.ok(result.flags.includes('deadline_in_past'));
  assert.ok(result.proposals[0].flags.includes('deadline_in_past'));
});

test('create_task：当年更早的日期（2026-01-01）同样标记为过去', () => {
  const result = run([createProposal({ deadlineDate: '2026-01-01' })]);
  assert.equal(result.ok, true);
  assert.ok(result.flags.includes('deadline_in_past'));
});

test('update_task：把截止日期改到过去 → 通过并标记', () => {
  const result = run([
    { kind: 'update_task', taskId: '1', patch: { deadlineDate: '2026-10-01' }, reason: '改到上个月' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.flags.includes('deadline_in_past'));
});

/* ------------------------------------------------------------------ *
 * 3. update_task 白名单
 * ------------------------------------------------------------------ */

test('update_task：白名单字段可以通过', () => {
  const result = run([
    { kind: 'update_task', taskId: 'task_1', patch: { plannedMinutes: 60, importance: 5, splittable: false }, reason: '调整' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.proposals[0].patch, { plannedMinutes: 60, importance: 5, splittable: false });
});

test('update_task：禁止改 status / dependsOn / note', () => {
  for (const patch of [{ status: 'completed' }, { dependsOn: [] }, { note: 'x' }]) {
    const result = run([{ kind: 'update_task', taskId: 'task_1', patch, reason: '试一下' }]);
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 应被拒绝`);
    assert.ok(result.issues.some((issue) => issue.includes('不允许')));
  }
});

test('update_task：同一任务两条修改 → 拒绝', () => {
  const result = run([
    { kind: 'update_task', taskId: 'task_1', patch: { plannedMinutes: 60 }, reason: 'a' },
    { kind: 'update_task', taskId: 'task_1', patch: { importance: 2 }, reason: 'b' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('重复修改')));
});

/* ------------------------------------------------------------------ *
 * 4. 完成 / 取消
 * ------------------------------------------------------------------ */

test('complete_task：未开始的任务可以通过', () => {
  const result = run([{ kind: 'complete_task', taskId: '1', reason: '课上做完了' }]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.proposals[0].kind, 'complete_task');
});

test('complete_task：已完成的任务 → 拒绝', () => {
  const ctx = makeCtx({
    tasks: [{ id: 'task_1', title: '数学作业', subject: '数学', plannedMinutes: 90, status: 'completed' }],
  });
  const result = run([{ kind: 'complete_task', taskId: '1', reason: '重复完成' }], ctx);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('已经是完成状态')));
});

test('cancel_task：已完成任务 → 拒绝（状态不可退回取消）', () => {
  const ctx = makeCtx({
    tasks: [{ id: 'task_1', title: '数学作业', subject: '数学', plannedMinutes: 90, status: 'completed' }],
  });
  const result = run([{ kind: 'cancel_task', taskId: '1', reason: '取消' }], ctx);
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ *
 * 5. 删除（软删除 / 彻底删除）
 * ------------------------------------------------------------------ */

test('delete_task：默认是软删除，hard:true 也允许', () => {
  const soft = run([{ kind: 'delete_task', taskId: '1', reason: '删掉' }]);
  assert.equal(soft.ok, true, JSON.stringify(soft.issues));
  assert.equal(soft.proposals[0].hard, false);

  const hard = run([{ kind: 'delete_task', taskId: '1', hard: true, reason: '彻底删除' }]);
  assert.equal(hard.ok, true, JSON.stringify(hard.issues));
  assert.equal(hard.proposals[0].hard, true);
});

test('delete_task：已完成的任务允许删除，但会标记"将删除已完成记录"', () => {
  const ctx = makeCtx({
    tasks: [{ id: 'task_1', title: '数学作业', subject: '数学', plannedMinutes: 90, status: 'completed' }],
    sessions: [
      { id: 's1', taskId: 'task_1', state: 'completed', actualMinutes: 60 },
      { id: 's2', taskId: 'task_1', state: 'completed', actualMinutes: 30 },
    ],
  });
  const result = run([{ kind: 'delete_task', taskId: '1', hard: true, reason: '清掉' }], ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.flags.includes('deletes_completed_sessions'));
  assert.equal(result.proposals[0].completedSessionCount, 2);
});

test('delete_task：同一任务同时 update 和 delete → 拒绝', () => {
  const result = run([
    { kind: 'update_task', taskId: '1', patch: { plannedMinutes: 60 }, reason: 'a' },
    { kind: 'delete_task', taskId: '1', reason: 'b' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('同时修改并删除')));
});

test('delete_task：超过上限数量 → 拒绝', () => {
  const tasks = Array.from({ length: MAX_DELETE_TASKS + 1 }, (_, index) => ({
    id: `task_${index}`,
    title: `任务${index}`,
    subject: '数学',
    plannedMinutes: 60,
    status: 'not_started',
  }));
  const ctx = makeCtx({ tasks });
  const proposals = tasks.map((_, index) => ({ kind: 'delete_task', taskId: String(index + 1), reason: '删' }));
  const result = run(proposals, ctx);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('最多删除')));
});

/* ------------------------------------------------------------------ *
 * 6. 提议 → ops
 * ------------------------------------------------------------------ */

test('proposalsToOps：create / update / cancel / delete 各自映射到正确的 op', () => {
  const ctx = makeCtx();
  const ops = proposalsToOps(
    [
      { kind: 'create_task', title: '新任务', subject: '数学', plannedMinutes: 60, deadlineDate: '2026-11-07', deadlineTime: '23:00', importance: 3, difficulty: 3, procrastination: 3, splittable: true, plannedStartMinutes: null },
      { kind: 'update_task', taskId: 'task_1', patch: { plannedMinutes: 45 } },
      { kind: 'cancel_task', taskId: 'task_2' },
      { kind: 'delete_task', taskId: 'task_1', hard: false },
      { kind: 'delete_task', taskId: 'task_2', hard: true },
    ],
    { taskById: ctx.taskById, today: TODAY },
  );
  assert.equal(ops[0].kind, 'task.add');
  assert.equal(ops[0].input.title, '新任务');
  assert.equal(ops[1].kind, 'task.update');
  assert.deepEqual(ops[1].patch, { plannedMinutes: 45 });
  assert.equal(ops[2].kind, 'task.status');
  assert.equal(ops[2].to, 'cancelled');
  assert.equal(ops[3].kind, 'task.delete', '软删除');
  assert.equal(ops[4].kind, 'task.purge', '彻底删除');
});

test('proposalsToOps：complete_task 复用注入的完成链路，且不降级为只改状态', () => {
  const ctx = makeCtx();
  let called = 0;
  const ops = proposalsToOps([{ kind: 'complete_task', taskId: 'task_1' }], {
    taskById: ctx.taskById,
    today: TODAY,
    completionOpsFor: (taskId) => {
      called += 1;
      return [
        { kind: 'session.complete', sessionId: 's1', actualMinutes: 40 },
        { kind: 'task.status', taskId, to: 'completed' },
      ];
    },
  });
  assert.equal(called, 1);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, 'session.complete');

  // 没有注入函数时不能退化成"只改状态"（那会丢学习记录）
  const bare = proposalsToOps([{ kind: 'complete_task', taskId: 'task_1' }], { taskById: ctx.taskById, today: TODAY });
  assert.equal(bare.length, 0);
});

/* ------------------------------------------------------------------ *
 * 7. 端到端：提议 → 预览 → 确认
 * ------------------------------------------------------------------ */

test('端到端：新建任务经预览确认后才写入', () => {
  const { app, services, feature } = setup();
  const before = app.getState().tasks.length;

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '已为你添加这个任务。',
    proposals: [createProposal({ deadlineDate: '2025-10-22' })],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(app.getState().tasks.length, before, '确认前不得写入');

  services.planService.applyPreview();
  const titles = app.getState().tasks.map((task) => task.title);
  assert.ok(titles.includes('生物实验报告'), '确认后任务应存在');
});

test('端到端：把截止日期改到过去 → 预览通过且带风险标记', () => {
  const { app, services, feature } = setup();
  services.taskService.addTask(taskInput({ title: '化学实验', subject: '化学', plannedMinutes: 60, deadlineDate: '2025-10-25' }));
  const taskId = app.getState().tasks[0].id;

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '改到上个月了，注意这个日期已经过去。',
    // FIXED_NOW 是 2025-10-16，2025-09-01 才是"过去"
    proposals: [{ kind: 'update_task', taskId, patch: { deadlineDate: '2025-09-01' }, reason: '改到上个月' }],
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.flags.includes('deadline_in_past'));
  assert.ok(result.flagMessages.some((text) => text.includes('已逾期') || text.includes('过去')));

  services.planService.applyPreview();
  const task = app.getState().tasks.find((item) => item.id === taskId);
  assert.equal(task.deadlineDate, '2025-09-01');
});

test('端到端：完成任务会记录实际学习时段', () => {
  const { app, services, feature } = setup();
  services.taskService.addTask(taskInput({ title: '英语作文', subject: '英语', plannedMinutes: 60 }));
  const taskId = app.getState().tasks[0].id;

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '已标记完成。',
    proposals: [{ kind: 'complete_task', taskId, reason: '已经写完了' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));

  services.planService.applyPreview();
  const task = app.getState().tasks.find((item) => item.id === taskId);
  assert.equal(task.status, 'completed');
  const sessions = app.getState().sessions.filter((session) => session.taskId === taskId && session.state === 'completed');
  assert.ok(sessions.length >= 1, '完成必须留下学习记录，否则统计会少一段时长');
});

test('端到端：软删除 → 任务进入已删除状态（可恢复）', () => {
  const { app, services, feature } = setup();
  services.taskService.addTask(taskInput({ title: '数学作业', subject: '数学', plannedMinutes: 60 }));
  const taskId = app.getState().tasks[0].id;

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '已删除，可在已删除历史里恢复。',
    proposals: [{ kind: 'delete_task', taskId, hard: false, reason: '老师取消了' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  services.planService.applyPreview();

  const task = app.getState().tasks.find((item) => item.id === taskId);
  assert.ok(task, '软删除不物理移除任务');
  assert.equal(task.status, 'deleted');
});

test('端到端：彻底删除 → 任务及其学习记录一并消失', () => {
  const { app, services, feature } = setup();
  services.taskService.addTask(taskInput({ title: '数学作业', subject: '数学', plannedMinutes: 60 }));
  const taskId = app.getState().tasks[0].id;
  services.planService.completeTaskAtomic({ taskId });
  assert.ok(app.getState().sessions.some((session) => session.taskId === taskId), '先确保有记录');

  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '已彻底删除。',
    proposals: [{ kind: 'delete_task', taskId, hard: true, reason: '彻底删除' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.flags.includes('deletes_completed_sessions'), '应提示会删除已完成记录');

  services.planService.applyPreview();
  assert.ok(!app.getState().tasks.some((item) => item.id === taskId), '任务应被移除');
  assert.ok(!app.getState().sessions.some((session) => session.taskId === taskId), '学习记录也应被移除');
});

test('端到端：校验失败时不生成预览', () => {
  const { services, feature } = setup();
  // 先建立一个"数学"科目，让可用科目集合非空——否则任何科目都无从判断存在性
  services.taskService.addTask(taskInput({ title: '数学作业', subject: '数学', plannedMinutes: 60 }));
  const result = feature.prepareRescuePreview({
    ok: true,
    reply: '好的。',
    proposals: [createProposal({ subject: '物理' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'proposal_rejected');
  assert.equal(services.planService.getPendingPreview(), null);
});
