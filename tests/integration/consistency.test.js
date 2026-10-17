/**
 * 任务与计划时段的数据一致性测试。
 *
 * 这一组测试针对用户实际报告的缺陷：
 *   「"m" 未完成时段合计 120 分钟，但剩余工作量只有 60 分钟。」
 *   「"o" 未完成时段合计 120 分钟，但剩余工作量只有 0 分钟。」
 * 以及随之而来的"任务删不掉""重新打开后任务不见了"。
 *
 * 核心不变量：剩余工作量 ≥ 未完成计划时段合计。
 * 任何让剩余工作量变小的操作，都必须在同一次提交里同步时段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_STATE } from '../../src/domain/session.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { remainingMinutesForTask } from '../../src/domain/task.js';
import { validateAppState } from '../../src/domain/schemas.js';
import { reconcileState, REPAIR_CODE } from '../../src/domain/reconcile.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/** 建任务 → 生成并应用计划，返回环境与任务 */
function planned(options = {}) {
  const env = createTestApp(options.adapter ? { adapter: options.adapter } : {});
  const created = env.services.taskService.addTask(
    taskInput({ title: options.title ?? '任务', plannedMinutes: options.plannedMinutes ?? 120, deadlineDate: '2025-10-20' }),
  );
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  return { ...env, task: env.app.getState().tasks.find((item) => item.id === created.task.id) };
}

/** 断言不变量成立：剩余工作量 ≥ 未完成时段合计 */
function assertInvariant(state, label) {
  for (const task of state.tasks ?? []) {
    if (task.status === TASK_STATUS.DELETED) continue;
    const pending = (state.sessions ?? [])
      .filter((s) => s.taskId === task.id && s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED)
      .reduce((sum, s) => sum + (s.plannedMinutes ?? 0), 0);
    const remaining = remainingMinutesForTask(task, state.sessions ?? []);
    assert.ok(
      pending <= remaining,
      `${label}：「${task.title}」未完成时段 ${pending} 分钟 > 剩余工作量 ${remaining} 分钟`,
    );
  }
  const validation = validateAppState(state);
  assert.equal(validation.ok, true, `${label}：整体校验失败 —— ${validation.errors?.map((e) => e.message).join('; ')}`);
}

/* ================================================================== *
 * 用户报告的两条错误
 * ================================================================== */

test('一致性：把预计总用时改小后，超出的未完成时段被同步取消（不再报"剩余工作量只有 60 分钟"）', () => {
  const env = planned({ title: 'm', plannedMinutes: 120 });
  assert.equal(
    env.app.getState().sessions.filter((s) => s.state === SESSION_STATE.FLEXIBLE).reduce((sum, s) => sum + s.plannedMinutes, 0),
    120,
  );

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { plannedMinutes: 60 } }],
  });
  assert.equal(preview.ok, true, `改小工作量不应再被校验拦下：${preview.issues?.map((i) => i.message).join('; ')}`);
  assert.equal(env.services.planService.applyPreview().ok, true);

  const state = env.app.getState();
  assertInvariant(state, '改小工作量后');
  const task = state.tasks.find((item) => item.id === env.task.id);
  assert.equal(task.plannedMinutes, 60);
});

test('一致性：标记完成后未完成时段被取消（不再报"剩余工作量只有 0 分钟"），且已完成记录保留', () => {
  const env = planned({ title: 'o', plannedMinutes: 120 });
  const taskId = env.task.id;

  // 先真实完成其中一段，留下一条学习历史
  const state0 = env.app.getState();
  const first = state0.sessions.find((s) => s.taskId === taskId && s.state === SESSION_STATE.FLEXIBLE);
  assert.ok(first);
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === first.id ? { ...s, state: SESSION_STATE.COMPLETED, actualMinutes: s.plannedMinutes, completedAt: new Date().toISOString() } : s,
      ),
    }),
    { reason: 'seed-completed' },
  );

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.status', taskId, to: TASK_STATUS.COMPLETED }],
  });
  assert.equal(preview.ok, true, `标记完成不应再被校验拦下：${preview.issues?.map((i) => i.message).join('; ')}`);
  assert.equal(env.services.planService.applyPreview().ok, true);

  const state = env.app.getState();
  assertInvariant(state, '标记完成后');

  const task = state.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(remainingMinutesForTask(task, state.sessions), 0, '完成后剩余工作量应为 0');

  const pending = state.sessions.filter((s) => s.taskId === taskId && s.state === SESSION_STATE.FLEXIBLE);
  assert.equal(pending.length, 0, '不应再有未完成时段');

  const history = state.sessions.filter((s) => s.taskId === taskId && s.state === SESSION_STATE.COMPLETED);
  assert.equal(history.length, 1, '已完成的学习记录必须保留');
});

test('一致性：增加"已完成时长"后，未完成时段同步收缩', () => {
  const env = planned({ title: 'p', plannedMinutes: 120 });

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { priorCompletedMinutes: 30 } }],
  });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  assertInvariant(env.app.getState(), '增加已完成时长后');
  const task = env.app.getState().tasks.find((item) => item.id === env.task.id);
  assert.equal(remainingMinutesForTask(task, env.app.getState().sessions), 90);
});

/* ================================================================== *
 * 删除任务
 * ================================================================== */

test('删除：已排入计划的任务可以删除，关联的未完成时段被取消，学习记录保留', () => {
  const env = planned({ title: '待删除', plannedMinutes: 120 });
  const taskId = env.task.id;

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.delete', taskId, hard: true }],
  });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const state = env.app.getState();
  const task = state.tasks.find((item) => item.id === taskId);
  assert.ok(task, '有历史时不物理删除，而是软删除');
  assert.equal(task.status, TASK_STATUS.DELETED);

  const own = state.sessions.filter((s) => s.taskId === taskId);
  assert.ok(own.length > 0, '时段记录保留（作为历史）');
  assert.equal(own.every((s) => s.state === SESSION_STATE.CANCELLED), true, '未完成时段应被取消');
  assertInvariant(state, '删除任务后');
});

test('删除：尚未排入计划的任务可以直接删除，不留下任何时段', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '未排程任务', plannedMinutes: 60, deadlineDate: '2025-10-25' }));
  assert.equal(created.ok, true);

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.delete', taskId: created.task.id, hard: true }],
  });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const state = env.app.getState();
  assert.equal(state.tasks.length, 0, '没有历史的任务被彻底删除');
  assert.equal(state.sessions.length, 0);
});

test('删除：截止日期已过的任务仍然可以删除（过期不是删除的阻碍）', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '过期任务', plannedMinutes: 60, deadlineDate: '2025-01-05' }));
  assert.equal(created.ok, true);

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.delete', taskId: created.task.id }],
  });
  assert.equal(preview.ok, true, `过期任务必须可删除：${preview.issues?.map((i) => i.message).join('; ')}`);
  assert.equal(env.services.planService.applyPreview().ok, true);
});

/* ================================================================== *
 * 新增任务与每日视图的数据来源
 * ================================================================== */

test('新增：任务保存后立刻出现在任务列表；未排程时每日视图给出明确状态而不是消失', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '新任务', plannedMinutes: 90, deadlineDate: '2025-10-25' }));
  assert.equal(created.ok, true);

  const views = env.services.taskService.listTaskViews();
  assert.equal(views.length, 1, '任务列表必须包含新任务');
  assert.equal(views[0].task.title, '新任务');
  assert.equal(views[0].sessions.length, 0, '还没有任何计划时段');
  assert.equal(views[0].remainingMinutes, 90);

  // 未排程的任务不会被伪造时段
  const state = env.app.getState();
  assert.equal(state.sessions.length, 0, '不得为了显示任务而伪造计划时段');

  // 生成计划后才有时段，且任务的 remaining 与时段一致
  assert.equal(env.services.planService.requestPreview({ now: NOW }).ok, true);
  assert.equal(env.services.planService.applyPreview().ok, true);
  const after = env.services.taskService.listTaskViews()[0];
  assert.ok(after.sessions.length > 0);
  assertInvariant(env.app.getState(), '生成计划后');
});

test('重排：连续应用两次计划不会产生重复时段', () => {
  const env = planned({ title: '重排任务', plannedMinutes: 180 });

  for (let i = 0; i < 3; i += 1) {
    const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: `第 ${i + 2} 次规划` });
    assert.equal(preview.ok, true, preview.issues?.map((m) => m.message).join('; '));
    assert.equal(env.services.planService.applyPreview().ok, true);
  }

  const state = env.app.getState();
  const active = state.sessions.filter((s) => s.taskId === env.task.id && s.state === SESSION_STATE.FLEXIBLE);
  const total = active.reduce((sum, s) => sum + s.plannedMinutes, 0);
  assert.equal(total, 180, `有效时段的合计应等于剩余工作量，实际 ${total}`);
  const keys = active.map((s) => `${s.date}|${s.startMinutes}|${s.endMinutes}`);
  assert.equal(new Set(keys).size, keys.length, '不应出现时间完全相同的重复时段');
  assertInvariant(state, '多次重排后');
});

/* ================================================================== *
 * 旧数据修复
 * ================================================================== */

test('修复：reconcileState 只取消未完成时段，保留已完成的学习历史', () => {
  const state = {
    tasks: [
      { id: 't1', title: '已完成但有残留时段', plannedMinutes: 120, status: TASK_STATUS.COMPLETED },
      { id: 't2', title: '被缩小', plannedMinutes: 60, status: TASK_STATUS.NOT_STARTED },
    ],
    sessions: [
      { id: 's1', taskId: 't1', date: '2025-10-16', startMinutes: 960, endMinutes: 1005, plannedMinutes: 45, actualMinutes: 45, state: SESSION_STATE.COMPLETED },
      { id: 's2', taskId: 't1', date: '2025-10-16', startMinutes: 1020, endMinutes: 1065, plannedMinutes: 45, actualMinutes: null, state: SESSION_STATE.FLEXIBLE },
      { id: 's3', taskId: 't2', date: '2025-10-16', startMinutes: 1080, endMinutes: 1140, plannedMinutes: 60, actualMinutes: null, state: SESSION_STATE.FLEXIBLE },
      { id: 's4', taskId: 't2', date: '2025-10-17', startMinutes: 1080, endMinutes: 1140, plannedMinutes: 60, actualMinutes: null, state: SESSION_STATE.FLEXIBLE },
    ],
  };

  const repaired = reconcileState(state, { nowIso: '2025-10-16T00:00:00.000Z' });
  assert.equal(repaired.changed, true);
  assert.ok(repaired.repairs.length >= 2);

  const byId = new Map(repaired.state.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s1').state, SESSION_STATE.COMPLETED, '已完成记录必须保留');
  assert.equal(byId.get('s2').state, SESSION_STATE.CANCELLED, '已关闭任务的未完成时段应取消');
  assert.equal(byId.get('s3').state, SESSION_STATE.FLEXIBLE, '容量足够的时段应保留');
  assert.equal(byId.get('s4').state, SESSION_STATE.CANCELLED, '超出剩余工作量的时段应取消（先取消最晚的）');
  assert.ok(repaired.repairs.some((r) => r.code === REPAIR_CODE.TASK_CLOSED));
  assert.ok(repaired.repairs.some((r) => r.code === REPAIR_CODE.OVER_SCHEDULED));
});

test('修复：加载历史坏数据时自动修复并提示用户，而不是显示空白应用', () => {
  const adapter = createMemoryAdapter();
  const env = planned({ title: 'o', plannedMinutes: 120, adapter });
  const taskId = env.task.id;

  // 模拟旧版本留下的坏数据：任务已完成但时段未取消。连写两次让主数据与备份都不一致。
  for (let i = 0; i < 2; i += 1) {
    env.app.commit(
      (state) => ({
        ...state,
        tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status: TASK_STATUS.COMPLETED } : task)),
        updatedAt: new Date(2025, 9, 16, 13, i).toISOString(),
      }),
      { reason: `simulate-old-${i}` },
    );
  }

  const reopened = createTestApp({ adapter });
  const state = reopened.app.getState();

  assert.equal(state.tasks.length, 1, '旧数据必须还能读出来（不能显示成空白应用）');
  assert.equal(state.tasks[0].status, TASK_STATUS.COMPLETED, '用户设置的状态被保留');
  assert.equal(
    state.sessions.filter((s) => s.state === SESSION_STATE.FLEXIBLE).length,
    0,
    '不一致的未完成时段已被取消',
  );
  assertInvariant(state, '加载旧数据后');
});

test('修复：结构损坏或其他错误不会被"修复"掩盖，仍然拒绝读取', () => {
  // 这不是可修复的类别（任务缺少必填字段），必须如实报错
  const env = createTestApp();
  const preview = env.app.previewImport(
    JSON.stringify({
      format: 'seven-day-study-planner/backup',
      state: {
        schemaVersion: 1,
        tasks: [{ id: 'broken' }],
        sessions: [],
        settings: {},
      },
    }),
  );
  assert.equal(preview.ok, false, '结构损坏必须被拒绝，不能被自动修复掩盖');
});
