/**
 * 阶段 4 集成测试：学习执行、计时持久化、清理、导入预览与异常处理。
 *
 * 重点验证"记录事实"与"改动计划"之间的边界：
 * - 计时（开始/暂停/继续/结束）只记录实际投入，不自动改动未来安排；
 * - 结束时的每个分支选项都把后果说清楚，改变计划的选项一律先出预览；
 * - 清理是用户显式触发、有影响面确认的破坏性操作，且绝不碰已完成记录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_STATE } from '../../src/domain/session.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { PLAN_STATUS } from '../../src/domain/plan.js';
import { evaluateCleanupImpact } from '../../src/domain/mutations.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { buildBackup, serializeBackup } from '../../src/storage/backup.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/** 应用一份计划，返回第一个待进行的时段 */
function prepared(options = {}) {
  const env = createTestApp();
  const created = env.services.taskService.addTask(
    taskInput({ title: '线性代数作业', plannedMinutes: options.plannedMinutes ?? 90, deadlineDate: '2025-10-20' }),
  );
  assert.equal(created.ok, true);
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.ok(session, '应存在一个待进行的时段');
  return { ...env, task: created.task, session };
}

/* ------------------------------------------------------------------ *
 * 计时循环
 * ------------------------------------------------------------------ */

test('计时：开始会让时段进入进行中并自动锁定，且只记录事实', () => {
  const env = prepared();
  const planBefore = env.app.getState().officialPlan;

  const started = env.services.focusService.start(env.session.id);
  assert.equal(started.ok, true);
  assert.equal(started.session.state, SESSION_STATE.IN_PROGRESS);
  assert.equal(started.session.locked, true, '进行中的时段自动锁定，防止被重排移走');

  assert.equal(env.app.getState().officialPlan, planBefore, '开始计时不得改动正式计划');
  assert.equal(env.app.getState().officialPlan.version, 1);
});

test('计时：暂停与继续会持久化累计分钟数，刷新页面后仍然保留', () => {
  const adapter = createMemoryAdapter();
  const first = prepared();
  // 用同一份存储重新装配，模拟刷新
  const env = createTestApp({ adapter });
  env.services.taskService.addTask(taskInput({ plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  env.services.planService.requestPreview({ now: NOW });
  env.services.planService.applyPreview();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  void first;

  assert.equal(env.services.focusService.start(session.id).ok, true);
  const paused = env.services.focusService.pause(session.id, { elapsedMinutes: 25 });
  assert.equal(paused.ok, true);
  assert.equal(paused.session.paused, true);
  assert.equal(paused.session.elapsedMinutes, 25);

  // 刷新：重新装配同一个存储
  const reloaded = createTestApp({ adapter });
  const restored = reloaded.app.getState().sessions.find((item) => item.id === session.id);
  assert.ok(restored, '时段应被持久化');
  assert.equal(restored.state, SESSION_STATE.IN_PROGRESS);
  assert.equal(restored.paused, true, '暂停状态应被持久化');
  assert.equal(restored.elapsedMinutes, 25, '累计分钟数应被持久化（计时不会归零）');

  const resumed = reloaded.services.focusService.resume(session.id, { elapsedMinutes: 25 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.session.paused, false);
});

test('计时：暂停与继续只接受"进行中"的时段', () => {
  const env = prepared();
  const pausedTooEarly = env.services.focusService.pause(env.session.id, { elapsedMinutes: 5 });
  assert.equal(pausedTooEarly.ok, false);
  assert.match(pausedTooEarly.issues[0].message, /正在进行中/);

  assert.equal(env.services.focusService.start(env.session.id).ok, true);
  const resumedTooEarly = env.services.focusService.resume(env.session.id, { elapsedMinutes: 5 });
  assert.equal(resumedTooEarly.ok, true);
  assert.equal(resumedTooEarly.alreadyRunning, true, '未暂停时继续是幂等的');
});

test('计时：同一时间只允许一段进行中（防止实际时长统计串味）', () => {
  const env = prepared({ plannedMinutes: 180 });
  const sessions = env.app.getState().sessions.filter((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.ok(sessions.length >= 2, '180 分钟应拆成多段');
  assert.equal(env.services.focusService.start(sessions[0].id).ok, true);
  const second = env.services.focusService.start(sessions[1].id);
  assert.equal(second.ok, false);
  assert.match(second.issues[0].message, /已经有一段学习正在进行/);
});

/* ------------------------------------------------------------------ *
 * 结束时的分支
 * ------------------------------------------------------------------ */

test('结束分支：提前完成会给出"顺延剩余工作"与"重新规划"选项', () => {
  const env = prepared({ plannedMinutes: 180 });
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(env.services.focusService.start(session.id).ok, true);

  const evaluated = env.services.focusService.evaluateFinish(session.id, { actualMinutes: 20 });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.isEarly, true);
  assert.equal(evaluated.differenceMinutes, 20 - session.plannedMinutes);
  assert.ok(evaluated.remainingAfterThis > 0, '任务还有剩余工作量');
  const codes = evaluated.options.map((option) => option.code);
  assert.ok(codes.includes('complete'), '应始终提供"只记录实际时长"');
  assert.ok(codes.includes('replan'), '还有剩余工作量时应提供"重新规划"');
  assert.equal(codes.includes('complete_task'), false, '还有剩余工作量时不应提供"标记任务完成"');
});

test('结束分支：剩余工作量为 0 时提供"标记任务完成"而不是"重新规划"', () => {
  const env = prepared({ plannedMinutes: 45 });
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(env.services.focusService.start(session.id).ok, true);

  const evaluated = env.services.focusService.evaluateFinish(session.id, { actualMinutes: session.plannedMinutes });
  assert.equal(evaluated.taskWillBeComplete, true);
  const codes = evaluated.options.map((option) => option.code);
  assert.ok(codes.includes('complete_task'));
  assert.equal(codes.includes('replan'), false);
});

test('结束分支：超时会提供"延长本段"与"只记录实际时长"两个选项', () => {
  const env = prepared();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(env.services.focusService.start(session.id).ok, true);

  const evaluated = env.services.focusService.evaluateFinish(session.id, { actualMinutes: session.plannedMinutes + 15 });
  assert.equal(evaluated.isOverrun, true);
  const codes = evaluated.options.map((option) => option.code);
  assert.ok(codes.includes('extend'), '超时时应允许延长本段');
  assert.ok(codes.includes('keep_plan'), '超时时应允许只记录实际时长');
  assert.ok(codes.includes('complete'), '始终可以单纯结束');
});

test('结束记录：写入实际时长、完成任务判断与"不自动改动计划"', () => {
  const env = prepared({ plannedMinutes: 45 });
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  const planVersionBefore = env.app.getState().officialPlan.version;
  assert.equal(env.services.focusService.start(session.id).ok, true);

  const finished = env.services.focusService.finish(session.id, { actualMinutes: 45 });
  assert.equal(finished.ok, true);
  assert.equal(finished.session.state, SESSION_STATE.COMPLETED);
  assert.equal(finished.session.actualMinutes, 45);
  assert.equal(finished.needsReplan, true, '结束时提示"可能需要重新规划"，而不是自动重排');
  assert.equal(env.app.getState().officialPlan.version, planVersionBefore, '记录学习事实不得改动正式计划');

  const task = env.app.getState().tasks[0];
  assert.equal(task.status, TASK_STATUS.IN_PROGRESS, '首次学习会把任务置为进行中');
});

test('结束后的重新规划必须经过预览确认：放弃则计划与数据都不变', () => {
  const env = prepared({ plannedMinutes: 180 });
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(env.services.focusService.start(session.id).ok, true);
  assert.equal(env.services.focusService.finish(session.id, { actualMinutes: 20 }).ok, true);

  const before = JSON.stringify({ sessions: env.app.getState().sessions, plan: env.app.getState().officialPlan });
  const previewed = env.services.planService.requestPreview({ now: NOW, changeSummary: '结束学习后重新规划' });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(JSON.stringify({ sessions: env.app.getState().sessions, plan: env.app.getState().officialPlan }), before, '预览阶段不得改动数据');

  assert.equal(env.services.planService.discardPreview().ok, true);
  assert.equal(JSON.stringify({ sessions: env.app.getState().sessions, plan: env.app.getState().officialPlan }), before);
});

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

test('清理：影响面只包含"已取消且从未开始"的时段，已完成记录受保护', () => {
  const env = prepared({ plannedMinutes: 180 });
  const flexible = env.app.getState().sessions.filter((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.ok(flexible.length >= 2, '180 分钟应拆成至少两段，便于构造"一段完成、一段取消"的场景');
  const [firstSession, secondSession] = flexible;

  // 完成一段
  assert.equal(env.services.focusService.start(firstSession.id).ok, true);
  assert.equal(env.services.focusService.finish(firstSession.id, { actualMinutes: firstSession.plannedMinutes }).ok, true);
  // 取消另一段
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === secondSession.id ? { ...item, state: SESSION_STATE.CANCELLED, locked: false } : item,
      ),
    }),
    { reason: 'test-seed' },
  );

  const impact = evaluateCleanupImpact(env.app.getState());
  assert.equal(impact.removable.length, 1, '只有已取消的那一段可清理');
  assert.equal(impact.removable[0].id, secondSession.id);
  assert.equal(impact.keepCompleted, 1, '已完成记录被保护');

  const result = env.services.planService.applyCleanup([{ kind: 'cleanup.cancelledSessions' }]);
  assert.equal(result.ok, true);
  assert.equal(result.removedCount, 1);

  const after = env.app.getState().sessions;
  assert.equal(after.some((item) => item.id === secondSession.id), false, '已取消的记录应被清理');
  assert.equal(after.filter((item) => item.state === SESSION_STATE.COMPLETED).length, 1, '已完成记录必须保留');
});

test('清理：没有可清理内容时返回结构化错误，不会误删', () => {
  const env = prepared();
  const before = env.app.getState().sessions.length;
  const result = env.services.planService.applyCleanup([{ kind: 'cleanup.cancelledSessions' }]);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /没有可以清理/);
  assert.equal(env.app.getState().sessions.length, before, '数据必须保持不变');
});

test('清理：版本快照可只保留最近 N 个，当前正式计划不受影响', () => {
  const env = createTestApp();
  env.services.taskService.addTask(taskInput({ plannedMinutes: 60, deadlineDate: '2025-10-20' }));

  // 连续应用 7 次计划，制造 6 个历史快照
  for (let i = 0; i < 7; i += 1) {
    const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: `第 ${i + 1} 次规划` });
    assert.equal(preview.ok, true);
    assert.equal(env.services.planService.applyPreview().ok, true);
  }
  assert.equal(env.services.planService.getHistory().length, 6);

  const versionBefore = env.services.planService.getOfficialPlan().version;
  const result = env.services.planService.applyCleanup([{ kind: 'cleanup.planHistory', keep: 2 }]);
  assert.equal(result.ok, true);
  assert.equal(result.removedCount, 4);
  assert.equal(env.services.planService.getHistory().length, 2);
  assert.equal(env.services.planService.getOfficialPlan().version, versionBefore, '当前正式计划不受清理影响');
});

test('清理：已完成的学习记录永远不能被单条删除', () => {
  const env = prepared({ plannedMinutes: 45 });
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(env.services.focusService.start(session.id).ok, true);
  assert.equal(env.services.focusService.finish(session.id, { actualMinutes: 45 }).ok, true);

  const result = env.services.planService.applyCleanup([{ kind: 'session.delete', sessionId: session.id }]);
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /不能删除/);
  assert.equal(env.app.getState().sessions.length, 1);
});

/* ------------------------------------------------------------------ *
 * 导入预览（异常处理）
 * ------------------------------------------------------------------ */

test('导入预览：合法备份给出摘要但不写入任何数据', () => {
  const env = prepared();
  const exported = env.app.exportBackup();

  const target = createTestApp();
  const preview = target.app.previewImport(exported.text);
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.taskCount, 1);
  assert.ok(preview.summary.sessionCount >= 1);
  assert.equal(target.app.getState().tasks.length, 0, '预览阶段不得写入数据');
  assert.equal(target.app.getState().officialPlan, null);
});

test('导入预览：非法备份被拒绝，并逐条列出问题且现有数据不变', () => {
  const env = prepared();
  const before = JSON.stringify(env.app.getState());

  const badCases = [
    ['不是 JSON', '这不是 JSON'],
    ['缺少必需字段', JSON.stringify({ format: 'seven-day-study-planner/backup', state: { tasks: [] } })],
    ['字段类型错误', JSON.stringify({ format: 'seven-day-study-planner/backup', state: { tasks: 'nope', sessions: [], settings: {} } })],
  ];

  for (const [name, text] of badCases) {
    const preview = env.app.previewImport(text);
    assert.equal(preview.ok, false, `${name} 应被拒绝`);
    assert.ok(preview.errors.length > 0, `${name} 必须给出可读的错误`);
    assert.ok(preview.errors.every((issue) => typeof issue.message === 'string' && issue.message.length > 0));
  }
  assert.equal(JSON.stringify(env.app.getState()), before, '被拒绝的导入不得改动任何数据');
});

test('导入预览：任务总量与备份摘要一致，且导入后数据完整可用', async () => {
  const source = prepared({ plannedMinutes: 180 });
  const text = serializeBackup(buildBackup(source.app.getState(), { nowIso: source.app.clock() }));

  const target = createTestApp();
  const preview = target.app.previewImport(text);
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.taskCount, source.app.getState().tasks.length);
  assert.equal(preview.summary.sessionCount, source.app.getState().sessions.length);

  const imported = await target.app.importBackup(text);
  assert.equal(imported.ok, true);
  assert.equal(target.app.getState().tasks.length, source.app.getState().tasks.length);
  assert.ok(target.services.planService.getOfficialPlan(), '导入后正式计划应存在');

  const validation = target.app.getState();
  const taskIds = new Set(validation.tasks.map((task) => task.id));
  for (const session of validation.sessions) {
    assert.ok(taskIds.has(session.taskId), '导入后时段不得引用不存在的任务');
  }
});

/* ------------------------------------------------------------------ *
 * 异常与边界
 * ------------------------------------------------------------------ */

test('异常：保存失败时不写内存，界面会收到可读通知（不静默丢失）', () => {
  const env = prepared();
  const before = env.app.getState().sessions.length;
  env.adapter.save = () => ({ ok: false, error: new Error('磁盘已满') });

  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  const result = env.services.focusService.start(session.id);
  assert.equal(result.ok, false);
  assert.equal(env.app.getState().sessions.length, before);
  assert.equal(env.app.getState().sessions.find((item) => item.id === session.id).state, SESSION_STATE.FLEXIBLE);
  assert.ok(env.app.getNotifications().some((n) => /磁盘已满/.test(n.message)));
});

test('边界：没有可执行时段时工作台的服务调用全部安全返回', () => {
  const env = createTestApp();
  assert.equal(env.services.focusService.getRunningSession(), null);
  assert.equal(env.services.focusService.start('ses_missing').ok, false);
  assert.equal(env.services.focusService.pause('ses_missing').ok, false);
  assert.equal(env.services.focusService.resume('ses_missing').ok, false);
  assert.equal(env.services.focusService.evaluateFinish('ses_missing').ok, false);
  assert.deepEqual(env.services.focusService.todayStats(NOW.date), {
    plannedMinutes: 0,
    actualMinutes: 0,
    completedCount: 0,
    totalCount: 0,
  });
  assert.equal(env.services.planService.cleanupImpact().removable.length, 0);
});

test('边界：计划状态与版本在记录学习后保持一致（不回退、不漂移）', () => {
  const env = prepared({ plannedMinutes: 90 });
  const versionBefore = env.app.getState().officialPlan.version;
  const statusBefore = env.app.getState().officialPlan.status;
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);

  assert.equal(env.services.focusService.start(session.id).ok, true);
  assert.equal(env.services.focusService.finish(session.id, { actualMinutes: 30 }).ok, true);

  const plan = env.app.getState().officialPlan;
  assert.equal(plan.version, versionBefore);
  assert.equal(plan.status, statusBefore === PLAN_STATUS.FEASIBLE ? PLAN_STATUS.FEASIBLE : plan.status);
  const task = env.app.getState().tasks[0];
  assert.equal(task.plannedMinutes, 90, '任务预计用时不会被"已学 30 分钟"改写');
});
