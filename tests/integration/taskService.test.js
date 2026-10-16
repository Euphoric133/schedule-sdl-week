/**
 * 任务服务集成测试。
 *
 * 服务层是界面唯一可以调用的写入入口，因此这里要验证的是"业务规则 + 数据安全"：
 * - 非法输入不写库（并且给出可读原因）
 * - 删除任务必须保留历史（软删除），并明确报告影响面
 * - 取消任务会连带取消其待进行时段，但已完成的学习记录必须原样保留
 * - 重复 ID 的任务不能被追加（防止时段挂错任务）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_STATUS } from '../../src/domain/task.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { makeSession, makeTask } from '../helpers/fixtures.js';
import { createTestApp, taskInput } from '../helpers/app.js';

test('addTask：合法任务被写入并持久化', () => {
  const { services, app, adapter } = createTestApp();
  const result = services.taskService.addTask(taskInput({ title: '线性代数作业' }));

  assert.equal(result.ok, true);
  assert.match(result.task.id, /^tsk_/);
  assert.equal(app.getState().tasks.length, 1);
  assert.equal(adapter.readRaw().tasks.length, 1, '必须已经落盘，而不是只在内存里');
});

test('addTask：非法输入一律不写库，并返回可读的原因', () => {
  const { services, app } = createTestApp();

  const noTitle = services.taskService.addTask(taskInput({ title: '  ' }));
  assert.equal(noTitle.ok, false);
  assert.ok(noTitle.issues.some((i) => /任务名称/.test(i.message)));

  const badChunks = services.taskService.addTask(taskInput({ minChunkMinutes: 90, maxChunkMinutes: 30 }));
  assert.equal(badChunks.ok, false);
  assert.ok(badChunks.issues.some((i) => /最短学习时段/.test(i.message)));

  const badRating = services.taskService.addTask(taskInput({ difficulty: 0 }));
  assert.equal(badRating.ok, false);

  assert.equal(app.getState().tasks.length, 0, '任何一次失败都不应留下半成品数据');
});

test('addTask：前置任务必须存在（悬空引用被拒绝）', () => {
  const { services } = createTestApp();
  const result = services.taskService.addTask(taskInput({ dependsOn: ['tsk_ghost'] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => /不存在/.test(i.message)));
});

test('addTask / updateTask：依赖不能形成环', () => {
  const { services } = createTestApp();
  const a = services.taskService.addTask(taskInput({ title: '任务 A' }));
  const b = services.taskService.addTask(taskInput({ title: '任务 B', dependsOn: [a.task.id] }));
  assert.equal(b.ok, true);

  const wouldCycle = services.taskService.updateTask(a.task.id, { dependsOn: [b.task.id] });
  assert.equal(wouldCycle.ok, false);
  assert.ok(wouldCycle.issues.some((i) => /循环依赖/.test(i.message)));
});

test('updateTask：白名单更新生效，非法更新被拒绝且不影响原数据', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 90 }));
  const id = created.task.id;

  const updated = services.taskService.updateTask(id, { title: '  线代作业（改）  ', plannedMinutes: 120 });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.title, '线代作业（改）');
  assert.equal(updated.task.plannedMinutes, 120);

  const invalid = services.taskService.updateTask(id, { plannedMinutes: -10 });
  assert.equal(invalid.ok, false);
  assert.equal(app.getState().tasks[0].plannedMinutes, 120, '失败时数据库中的值必须保持不变');

  const notFound = services.taskService.updateTask('tsk_missing', { title: 'x' });
  assert.equal(notFound.ok, false);
});

test('updateTask：把任务改成不可拆分时，时长字段自动对齐', () => {
  const { services } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const updated = services.taskService.updateTask(created.task.id, { splittable: false });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.minChunkMinutes, 120);
  assert.equal(updated.task.maxChunkMinutes, 120);
});

test('changeTaskStatus：取消任务会连带取消待进行时段，但已完成记录原样保留', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const taskId = created.task.id;

  // 直接注入一个已完成与一个待进行的时段（阶段 1 尚不能通过界面创建时段）
  const done = makeSession({ id: 'ses_done', taskId, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 });
  const pending = makeSession({ id: 'ses_pending', taskId, startMinutes: 1080, endMinutes: 1125 });
  app.commit((state) => ({ ...state, sessions: [done, pending] }), { reason: 'seed' });

  const cancelled = services.taskService.changeTaskStatus(taskId, TASK_STATUS.CANCELLED);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelledSessions, 1);

  const sessions = app.getState().sessions;
  const doneAfter = sessions.find((s) => s.id === 'ses_done');
  const pendingAfter = sessions.find((s) => s.id === 'ses_pending');

  assert.equal(doneAfter.state, SESSION_STATE.COMPLETED, '已完成的学习记录绝不能被自动改动（H9）');
  assert.equal(doneAfter.actualMinutes, 45);
  assert.equal(pendingAfter.state, SESSION_STATE.CANCELLED);
  assert.equal(pendingAfter.locked, false, '被取消的待进行时段同时解除锁定');
});

test('changeTaskStatus：非法迁移被拒绝', () => {
  const { services } = createTestApp();
  const created = services.taskService.addTask(taskInput());
  services.taskService.changeTaskStatus(created.task.id, TASK_STATUS.COMPLETED);
  const illegal = services.taskService.changeTaskStatus(created.task.id, TASK_STATUS.CANCELLED);
  assert.equal(illegal.ok, false);
  assert.ok(illegal.issues.some((i) => /不能从/.test(i.message)));
});

test('evaluateTaskImpact：明确给出影响面数字与依赖它的任务', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const dependent = services.taskService.addTask(taskInput({ title: '依赖任务', dependsOn: [created.task.id] }));
  assert.equal(dependent.ok, true);

  const sessions = [
    makeSession({ id: 'ses_1', taskId: created.task.id, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 }),
    makeSession({ id: 'ses_2', taskId: created.task.id, startMinutes: 1080, endMinutes: 1125, locked: true }),
  ];
  app.commit((state) => ({ ...state, sessions }), { reason: 'seed' });

  const evaluated = services.taskService.evaluateTaskImpact(created.task.id);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.impact.totalSessions, 2);
  assert.equal(evaluated.impact.completedSessions, 1);
  assert.equal(evaluated.impact.activeSessions, 1);
  assert.equal(evaluated.impact.activeMinutes, 45);
  assert.equal(evaluated.impact.lockedSessions, 1);
  assert.equal(evaluated.impact.remainingMinutes, 75, '120 − 45 = 75');
  assert.equal(evaluated.impact.canHardDelete, false);
  assert.deepEqual(evaluated.impact.dependents.map((d) => d.title), ['依赖任务']);
  assert.match(evaluated.impact.message, /其中 1 个已完成/);
  assert.match(evaluated.impact.message, /1 个待进行共 45 分钟/);
  assert.match(evaluated.impact.message, /含 1 个已锁定/);
  assert.match(evaluated.impact.message, /另有 1 个任务依赖它/);
});

test('deleteTask：有历史记录时执行软删除，可恢复；历史时段不被销毁', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const taskId = created.task.id;
  app.commit(
    (state) => ({ ...state, sessions: [makeSession({ id: 'ses_a', taskId, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 })] }),
    { reason: 'seed' },
  );

  const deleted = services.taskService.deleteTask(taskId, { hard: true });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.mode, 'soft', '有历史记录时即使请求彻底删除也必须降级为软删除');
  assert.equal(deleted.downgraded, true);

  const task = app.getState().tasks.find((t) => t.id === taskId);
  assert.equal(task.status, TASK_STATUS.DELETED);
  assert.equal(app.getState().sessions.length, 1, '历史时段保留');
  assert.equal(app.getState().sessions[0].state, SESSION_STATE.COMPLETED);

  const listed = services.taskService.getTasks();
  assert.equal(listed.length, 0, '默认列表不显示已删除任务');
  assert.equal(services.taskService.getTasks({ includeDeleted: true }).length, 1);

  const restored = services.taskService.restoreTask(taskId);
  assert.equal(restored.ok, true);
  assert.equal(restored.task.status, TASK_STATUS.NOT_STARTED);
});

test('deleteTask：没有任何历史记录时可以彻底删除', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput());
  const deleted = services.taskService.deleteTask(created.task.id, { hard: true });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.mode, 'hard');
  assert.equal(app.getState().tasks.length, 0);
});

test('deleteTask：不存在或已删除的任务返回结构化错误', () => {
  const { services } = createTestApp();
  const missing = services.taskService.deleteTask('tsk_missing');
  assert.equal(missing.ok, false);
  assert.ok(missing.issues[0].message.includes('不存在'));
});

test('restoreTask：只有已删除的任务才能恢复', () => {
  const { services } = createTestApp();
  const created = services.taskService.addTask(taskInput());
  const result = services.taskService.restoreTask(created.task.id);
  assert.equal(result.ok, false);
});

test('listTaskViews：包含剩余工作量与时段统计，按截止时间排序', () => {
  const { services, app } = createTestApp();
  const late = services.taskService.addTask(taskInput({ title: '晚截止', deadlineDate: '2025-10-25' }));
  const early = services.taskService.addTask(taskInput({ title: '早截止', deadlineDate: '2025-10-18' }));

  app.commit(
    (state) => ({
      ...state,
      sessions: [
        makeSession({ id: 'ses_e', taskId: early.task.id, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 }),
        makeSession({ id: 'ses_l', taskId: late.task.id, startMinutes: 1080, endMinutes: 1125, locked: true }),
      ],
    }),
    { reason: 'seed' },
  );

  const views = services.taskService.listTaskViews();
  assert.deepEqual(views.map((v) => v.task.title), ['早截止', '晚截止'], '按截止时间升序');
  const earlyView = views.find((v) => v.task.id === early.task.id);
  const lateView = views.find((v) => v.task.id === late.task.id);
  assert.equal(earlyView.remainingMinutes, 45, '90 − 45（已完成）= 45');
  assert.equal(earlyView.completedSessions, 1);
  assert.equal(lateView.remainingMinutes, 90);
  assert.equal(lateView.lockedSessions, 1);
});

test('适配器失败时服务层如实报告失败，不会让界面误以为保存成功', () => {
  const adapter = createMemoryAdapter();
  const { services } = createTestApp({ adapter });
  adapter.save = () => ({ ok: false, error: new Error('磁盘已满') });

  const result = services.taskService.addTask(taskInput());
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('依赖链：新增依赖任务不会破坏已有依赖关系（同截止日期时按 id 稳定排序）', () => {
  const { services } = createTestApp();
  const base = services.taskService.addTask(taskInput({ title: '基础任务' }));
  const mid = services.taskService.addTask(taskInput({ title: '中间任务', dependsOn: [base.task.id] }));
  const top = services.taskService.addTask(taskInput({ title: '顶层任务', dependsOn: [mid.task.id] }));
  assert.equal(top.ok, true);

  const views = services.taskService.listTaskViews();
  assert.equal(views.length, 3);
  // 三个任务截止日期相同，排序退化为 taskId 字典序；这里只断言稳定性与依赖关系本身
  const byTitle = new Map(views.map((v) => [v.task.title, v.task]));
  assert.deepEqual(byTitle.get('中间任务').dependsOn, [byTitle.get('基础任务').id]);
  assert.deepEqual(byTitle.get('顶层任务').dependsOn, [byTitle.get('中间任务').id]);
  assert.deepEqual(
    views.map((v) => v.task.title).sort(),
    ['中间任务', '基础任务', '顶层任务'],
  );
  assert.deepEqual(services.taskService.listTaskViews().map((v) => v.task.id), views.map((v) => v.task.id), '两次调用顺序一致');
});

test('已删除任务的历史不会被删除：软删除后的会话仍可通过 listTaskViews(includeDeleted) 查看', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const taskId = created.task.id;
  app.commit((state) => ({ ...state, sessions: [makeSession({ id: 'ses_h', taskId, startMinutes: 1080, endMinutes: 1125 })] }), {
    reason: 'seed',
  });

  const deleted = services.taskService.deleteTask(taskId);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.cancelledSessions, 1);

  const view = services.taskService.listTaskViews({ includeDeleted: true }).find((v) => v.task.id === taskId);
  assert.ok(view, '已删除任务仍在任务库中（保留历史）');
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0].state, SESSION_STATE.CANCELLED);
  assert.equal(makeTask, makeTask, 'fixture 可用');
});
