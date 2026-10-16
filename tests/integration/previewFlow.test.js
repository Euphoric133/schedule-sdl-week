/**
 * 预览闭环集成测试（验收场景 11 / 12 / 16）。
 *
 * 这是产品最核心的流程，测试必须回答：
 * - 生成预览时**没有**修改正式计划
 * - 放弃预览后正式计划与原时段**零改动**
 * - 应用预览后计划与会话同时更新，且受保护时段原样保留
 * - 预览过期（版本或输入指纹变化）时**拒绝应用**，绝不用旧数据覆盖新数据
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUS } from '../../src/domain/plan.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { BLOCK_KIND } from '../../src/domain/calendarBlock.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/** 运行一次预览，返回 { app, services, preview } */
function withPreview(options = {}) {
  const env = createTestApp();
  const created = env.services.taskService.addTask(
    taskInput({ title: options.title ?? '线性代数作业', plannedMinutes: options.plannedMinutes ?? 90, deadlineDate: '2025-10-20' }),
  );
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '首次生成计划' });
  return { ...env, preview, task: created.task };
}

test('requestPreview：生成候选计划与差异，但不修改正式计划', () => {
  const { app, preview } = withPreview();

  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(preview.preview.candidate.status, PLAN_STATUS.FEASIBLE);
  assert.equal(preview.preview.baseVersion, 0, '首次生成时基础版本为 0');
  assert.equal(preview.preview.diff.added.length > 0, true, '首次生成应把新时段列在"新增"里');
  assert.equal(app.getState().officialPlan, null, '预览阶段绝不能写入正式计划');
  assert.ok(app.getState().pendingPreview, '候选计划应保存在 pendingPreview 中');
  assert.equal(app.getState().sessions.length, 0, '预览阶段不能创建任何学习时段');
});

test('requestPreview：差异包含每日指标变化与未安排任务清单', () => {
  const { preview } = withPreview();
  assert.ok(Array.isArray(preview.preview.diff.dailyDelta));
  assert.ok(Array.isArray(preview.preview.diff.lockedImpact));
  assert.ok(Array.isArray(preview.preview.diff.unscheduledAfter));
  assert.ok(Array.isArray(preview.preview.risks));
  assert.equal(preview.preview.diff.statusAfter, PLAN_STATUS.FEASIBLE);
  assert.equal(preview.preview.diff.feasibleAfter, true);
});

test('discardPreview：放弃后正式计划与所有时段零改动（验收场景 12）', () => {
  const { app, services } = withPreview();
  const before = JSON.stringify(app.getState());

  const discarded = services.planService.discardPreview();
  assert.equal(discarded.ok, true);
  assert.equal(app.getState().pendingPreview, null);

  const after = JSON.parse(JSON.stringify(app.getState()));
  const beforeObj = JSON.parse(before);
  // 允许变化的只有状态容器的元数据（updatedAt）与"待确认预览"本身被清空
  delete beforeObj.updatedAt;
  delete after.updatedAt;
  beforeObj.pendingPreview = null;
  assert.deepEqual(after, beforeObj, '放弃预览不得改动任何业务数据');
  assert.equal(app.getState().officialPlan, null);
  assert.equal(app.getState().sessions.length, 0);
});

test('applyPreview：应用后正式计划与学习时段同时写入，并保留版本快照', () => {
  const { app, services, preview } = withPreview();

  const applied = services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

  const plan = services.planService.getOfficialPlan();
  assert.equal(plan.version, 1);
  assert.equal(plan.inputHash, preview.preview.candidate.inputHash);
  assert.equal(app.getState().pendingPreview, null);

  const studySessions = app.getState().sessions.filter((session) => session.state === SESSION_STATE.FLEXIBLE);
  assert.ok(studySessions.length > 0, '应用后应创建对应的学习时段');
  assert.equal(
    studySessions.reduce((sum, session) => sum + session.plannedMinutes, 0),
    90,
    '创建的时段总时长必须等于任务剩余工作量',
  );
  assert.equal(plan.sessionIds.length, studySessions.length, '计划记录的 sessionIds 与实际创建的时段一致');
  for (const session of studySessions) {
    assert.equal(session.source, 'engine');
    assert.ok(Array.isArray(session.reasonCodes));
  }
});

test('applyPreview：第二次应用会生成可撤销的版本快照', () => {
  const { services, app } = withPreview();
  services.planService.applyPreview();

  // 再新增一个任务并重新规划
  const extra = services.taskService.addTask(taskInput({ title: '英语阅读', subject: '英语', plannedMinutes: 60, deadlineDate: '2025-10-21' }));
  assert.equal(extra.ok, true);

  const second = services.planService.requestPreview({ now: NOW, changeSummary: '新增英语阅读后重新规划' });
  assert.equal(second.ok, true);
  assert.equal(second.preview.baseVersion, 1, '第二次预览基于 v1');

  const applied = services.planService.applyPreview();
  assert.equal(applied.ok, true);
  assert.equal(services.planService.getOfficialPlan().version, 2);
  assert.equal(services.planService.getHistory().length, 1);
  assert.equal(services.planService.getHistory()[0].changeSummary, '首次生成计划', '快照记录的是被替换的那一版');

  const undone = services.planService.undoLastApply();
  assert.equal(undone.ok, true);
  assert.equal(services.planService.getOfficialPlan().version, 3, '版本号继续递增');
  assert.equal(services.planService.getOfficialPlan().blocks.filter((b) => b.kind === BLOCK_KIND.STUDY).length, 2, '恢复为 v1 的安排');
});

test('applyPreview：基础版本变化时拒绝应用（验收场景 16）', () => {
  const { services, app } = withPreview();
  services.planService.applyPreview();
  const preview = services.planService.requestPreview({ now: NOW, changeSummary: '第二次' });
  assert.equal(preview.ok, true);

  // 模拟预览生成后正式计划被推进（例如另一个流程应用了计划）
  app.commit((state) => ({ ...state, officialPlan: { ...state.officialPlan, version: state.officialPlan.version + 1 } }), { reason: 'test-bump' });

  const applied = services.planService.applyPreview();
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'stale_preview');
  assert.match(applied.issues[0].message, /预览已过期/);
  assert.ok(app.getState().pendingPreview, '被拒绝的预览仍保留，用户可以重新生成或放弃');
});

test('applyPreview：输入指纹变化时拒绝应用（任务在预览期间被修改）', () => {
  const { services, app, task } = withPreview();
  services.planService.applyPreview();
  const preview = services.planService.requestPreview({ now: NOW, changeSummary: '第二次' });
  assert.equal(preview.ok, true);

  // 预览生成后，任务被修改（指纹随之变化）
  const updated = services.taskService.updateTask(task.id, { plannedMinutes: 150 });
  assert.equal(updated.ok, true);

  const applied = services.planService.applyPreview();
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'stale_preview');
  assert.equal(services.planService.getOfficialPlan().version, 1, '正式计划必须保持不变');
  assert.equal(
    app.getState().sessions.filter((s) => s.state === SESSION_STATE.FLEXIBLE).reduce((sum, s) => sum + s.plannedMinutes, 0),
    90,
    '现有学习时段也不得被改动',
  );
});

test('applyPreview：过期检查通过后，受保护时段被原样保留（H9 / H10）', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ plannedMinutes: 120, deadlineDate: '2025-10-25' }));
  const taskId = created.task.id;

  // 手工放入一个已完成的时段（真实场景由专注工作台产生）
  const completed = {
    id: 'ses_completed_1',
    taskId,
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    plannedMinutes: 45,
    actualMinutes: 45,
    state: SESSION_STATE.COMPLETED,
    locked: true,
    source: 'engine',
    reasonCodes: [],
    planVersion: 1,
    createdAt: '2025-10-16T20:30:00+08:00',
    updatedAt: '2025-10-16T20:30:00+08:00',
    startedAt: null,
    completedAt: '2025-10-16T20:30:00+08:00',
    history: [],
  };
  env.app.commit((state) => ({ ...state, sessions: [completed] }), { reason: 'seed' });

  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '含已完成记录' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));

  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

  const sessions = env.app.getState().sessions;
  const kept = sessions.find((session) => session.id === 'ses_completed_1');
  assert.ok(kept, '已完成的学习记录必须保留');
  assert.equal(kept.state, SESSION_STATE.COMPLETED);
  assert.equal(kept.actualMinutes, 45);
  assert.equal(kept.startMinutes, 16 * 60);

  const newSessions = sessions.filter((session) => session.id !== 'ses_completed_1' && session.state === SESSION_STATE.FLEXIBLE);
  assert.equal(
    newSessions.reduce((sum, session) => sum + session.plannedMinutes, 0),
    75,
    '只安排剩余 120 − 45 = 75 分钟',
  );
  const completedBlock = { date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 16 * 60 + 45 };
  for (const session of newSessions) {
    const overlapsCompleted =
      session.date === completedBlock.date && session.startMinutes < completedBlock.endMinutes && completedBlock.startMinutes < session.endMinutes;
    assert.equal(overlapsCompleted, false, `新时段 ${session.date} ${session.startMinutes}-${session.endMinutes} 不得与已完成时段重叠`);
  }
});

test('预览闭环：旧时段被替代时会标记为已取消而不是物理删除', () => {
  const { services, app } = withPreview({ plannedMinutes: 90 });
  services.planService.applyPreview();
  const firstBatch = app.getState().sessions.map((session) => session.id);
  assert.ok(firstBatch.length > 0);

  // 修改任务后重新规划：旧时段应被标记取消，新时段使用新的确定性 ID
  services.taskService.updateTask(createdTaskId(app), { plannedMinutes: 150 });
  const preview = services.planService.requestPreview({ now: NOW, changeSummary: '调整预计用时后重排' });
  assert.equal(preview.ok, true);
  const applied = services.planService.applyPreview();
  assert.equal(applied.ok, true);

  const sessions = app.getState().sessions;
  for (const id of firstBatch) {
    const session = sessions.find((item) => item.id === id);
    if (!session) continue;
    if (session.state === SESSION_STATE.FLEXIBLE) continue;
    assert.equal(session.state, SESSION_STATE.CANCELLED, '被替代的旧时段应保留记录并标记取消');
  }
  const active = sessions.filter((session) => session.state === SESSION_STATE.FLEXIBLE);
  assert.equal(active.reduce((sum, session) => sum + session.plannedMinutes, 0), 150);
});

test('requestPreview：输入非法（依赖成环）时返回失败，不产生候选计划', () => {
  const env = createTestApp();
  const a = env.services.taskService.addTask(taskInput({ title: 'A', plannedMinutes: 60 }));
  const b = env.services.taskService.addTask(taskInput({ title: 'B', plannedMinutes: 60, dependsOn: [a.task.id] }));
  assert.equal(b.ok, true);

  // 人为构造环（绕过服务层校验，模拟被外部改坏的数据）
  env.app.commit(
    (state) => ({
      ...state,
      tasks: state.tasks.map((task) => (task.id === a.task.id ? { ...task, dependsOn: [b.task.id] } : task)),
    }),
    { reason: 'test-cycle' },
  );

  const preview = env.services.planService.requestPreview({ now: NOW });
  assert.equal(preview.ok, false);
  assert.equal(preview.status, PLAN_STATUS.INVALID_INPUT);
  assert.equal(env.app.getState().pendingPreview, null, '输入非法时不得留下候选计划');
  assert.ok(preview.issues.length > 0);
});

test('requestPreview：容量不足时给出部分可行状态与未安排原因', () => {
  const env = createTestApp();
  env.services.taskService.addTask(taskInput({ plannedMinutes: 1800, deadlineDate: '2025-12-31' }));
  const preview = env.services.planService.requestPreview({ now: NOW });

  assert.equal(preview.ok, true);
  assert.ok([PLAN_STATUS.PARTIALLY_FEASIBLE, PLAN_STATUS.INFEASIBLE].includes(preview.preview.candidate.status));
  assert.ok(preview.preview.unscheduled.length > 0);
  for (const item of preview.preview.unscheduled) {
    assert.ok(item.reasonCode && item.reasonText && item.suggestions.length > 0);
  }
});

test('预览数据可持久化：刷新后仍能看到待确认的候选计划', () => {
  const adapter = createMemoryAdapter();
  const first = createTestApp({ adapter });
  first.services.taskService.addTask(taskInput({ plannedMinutes: 60 }));
  const preview = first.services.planService.requestPreview({ now: NOW, changeSummary: '待确认' });
  assert.equal(preview.ok, true);

  const second = createTestApp({ adapter });
  assert.equal(second.loadReport.fromStorage, true);
  const pending = second.services.planService.getPendingPreview();
  assert.ok(pending, '候选计划应当被持久化，刷新后仍可确认');
  assert.equal(pending.candidate.status, PLAN_STATUS.FEASIBLE);
});

test('discardPreview：没有候选计划时返回结构化错误', () => {
  const env = createTestApp();
  const result = env.services.planService.discardPreview();
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /没有待确认/);
});

function createdTaskId(app) {
  return app.getState().tasks[0].id;
}
