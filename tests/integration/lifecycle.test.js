/**
 * 端到端生命周期测试（不涉及 DOM）。
 *
 * 这个文件把"用户会做的事"串成完整流程，用来回答一个关键问题：
 * 阶段 1 交付的这套地基，能否撑住后面四个阶段的全部功能？
 *
 * 覆盖：
 * 1. 新用户 → 创建任务 → 刷新 → 数据仍在
 * 2. 完成一段学习 → 剩余工作量正确减少 → 不重复安排已完成的工作
 * 3. 生成正式计划 → 再改数据 → 旧预览失效（不能被旧数据覆盖）
 * 4. 导入导出往返
 * 5. 删除任务保留历史
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUS } from '../../src/domain/plan.js';
import { TASK_STATUS, remainingMinutesForTask } from '../../src/domain/task.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { createBlock } from '../../src/domain/calendarBlock.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { createTestApp, taskInput } from '../helpers/app.js';

/** 构造一份最小但结构完整的候选计划（含七天统计），供端到端流程使用 */
function buildPlan(services, { version, studyDate, subject = '数学', taskId = null, inputHash = null }) {
  const block = createBlock({
    id: `blk_${studyDate}`,
    kind: 'study',
    date: studyDate,
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    subject,
    taskId,
    refId: null,
    label: '学习时段',
  });
  return services.planService.buildCandidatePlan({
    blocks: [block],
    windowStart: '2025-10-16',
    status: PLAN_STATUS.FEASIBLE,
    version,
    inputHash: inputHash ?? `input-${studyDate}-v${version}`,
  });
}

test('端到端：新用户创建任务 → 刷新页面 → 任务与统计数据仍在', () => {
  const adapter = createMemoryAdapter();

  const first = createTestApp({ adapter });
  const created = first.services.taskService.addTask(taskInput({ title: '第一周作业', plannedMinutes: 120 }));
  assert.equal(created.ok, true);

  // 模拟刷新：用同一份存储重新装配
  const second = createTestApp({ adapter });
  assert.equal(second.loadReport.fromStorage, true);

  const views = second.services.taskService.listTaskViews();
  assert.equal(views.length, 1);
  assert.equal(views[0].task.title, '第一周作业');
  assert.equal(views[0].remainingMinutes, 120);
  assert.equal(second.app.getSummary().activeTaskCount, 1);
});

test('端到端：完成一段学习后剩余工作量减少，且不会重复安排已完成的部分', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 90 }));
  const taskId = created.task.id;

  // 引擎（阶段 2）会把任务切成 45 分钟的片段；这里手工写入一段以验证后续行为
  const session = {
    id: 'ses_1',
    taskId,
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    plannedMinutes: 45,
    actualMinutes: null,
    state: SESSION_STATE.FLEXIBLE,
    locked: false,
    source: 'engine',
    reasonCodes: [],
    planVersion: null,
    createdAt: '2025-10-16T20:30:00+08:00',
    updatedAt: '2025-10-16T20:30:00+08:00',
    startedAt: null,
    completedAt: null,
    history: [],
  };
  app.commit((state) => ({ ...state, sessions: [session] }), { reason: 'seed' });

  assert.equal(remainingMinutesForTask(services.taskService.getTask(taskId), app.getState().sessions), 90, '已排但未完成不算已完成');

  // 开始并结束这一段（实际学了 45 分钟）
  const started = services.focusService.start('ses_1');
  assert.equal(started.ok, true);
  assert.equal(started.session.locked, true, '进行中的时段自动锁定');

  const finished = services.focusService.finish('ses_1', { actualMinutes: 45 });
  assert.equal(finished.ok, true);
  assert.equal(finished.session.state, SESSION_STATE.COMPLETED);
  assert.equal(finished.taskStarted, true, '首次学习会把任务置为进行中');

  const task = services.taskService.getTask(taskId);
  assert.equal(task.status, TASK_STATUS.IN_PROGRESS);
  assert.equal(remainingMinutesForTask(task, app.getState().sessions), 45, '90 − 45 = 45，已完成部分不会被重复安排');
  assert.equal(finished.needsReplan, true, '结束时提示需要重新规划，而不是自动改动后续安排');
});

test('端到端：同一时间只允许一段学习在进行中（防止实际时长统计串味）', () => {
  const { services, app } = createTestApp();
  const task = services.taskService.addTask(taskInput({ plannedMinutes: 180 }));
  const makeRaw = (id, start) => ({
    id,
    taskId: task.task.id,
    date: '2025-10-16',
    startMinutes: start,
    endMinutes: start + 45,
    plannedMinutes: 45,
    actualMinutes: null,
    state: SESSION_STATE.FLEXIBLE,
    locked: false,
    source: 'engine',
    reasonCodes: [],
    planVersion: null,
    createdAt: '2025-10-16T20:30:00+08:00',
    updatedAt: '2025-10-16T20:30:00+08:00',
    startedAt: null,
    completedAt: null,
    history: [],
  });
  app.commit((state) => ({ ...state, sessions: [makeRaw('ses_a', 960), makeRaw('ses_b', 1080)] }), { reason: 'seed' });

  assert.equal(services.focusService.start('ses_a').ok, true);
  const second = services.focusService.start('ses_b');
  assert.equal(second.ok, false);
  assert.match(second.issues[0].message, /已经有一段学习正在进行/);
});

test('端到端：生成正式计划后修改数据 → 旧预览无法应用（不能被旧数据覆盖）', () => {
  const { services } = createTestApp();

  const v1 = services.planService.applyPlan(buildPlan(services, { version: 1, studyDate: '2025-10-16' }), {
    changeSummary: '生成第一份计划',
  });
  assert.equal(v1.ok, true, v1.issues?.map((i) => i.message).join('; '));
  const baseVersion = services.planService.getOfficialPlan().version;

  // 用户随后新增了任务（真实场景：预览生成后数据又变了）
  services.taskService.addTask(taskInput({ title: '预览期间新增的任务' }));

  const stale = services.planService.applyPlan(
    buildPlan(services, { version: baseVersion + 1, studyDate: '2025-10-17', inputHash: 'outdated-fingerprint' }),
    { expectedBaseVersion: baseVersion, expectedInputHash: 'outdated-fingerprint', changeSummary: '基于旧数据的计划' },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_preview');
  assert.equal(services.planService.getOfficialPlan().blocks[0].date, '2025-10-16', '正式计划保持不变');
});

test('端到端：导出 → 清空 → 导入，任务与计划一起回来', async () => {
  const { services, app } = createTestApp();
  services.taskService.addTask(taskInput({ title: '需要备份的任务' }));
  services.planService.applyPlan(buildPlan(services, { version: 1, studyDate: '2025-10-16' }), { changeSummary: '第一版' });

  const exported = app.exportBackup();

  // 用全新的应用实例导入
  const fresh = createTestApp();
  const imported = await fresh.app.importBackup(exported.text);
  assert.equal(imported.ok, true, imported.issues?.map((i) => i.message).join('; '));
  assert.equal(fresh.app.getState().tasks.length, 1);
  assert.equal(fresh.services.planService.getOfficialPlan().version, 1);
  assert.equal(fresh.app.getSummary().planVersion, 1);
});

test('端到端：删除任务保留历史，并如实报告影响面', () => {
  const { services, app } = createTestApp();
  const created = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const taskId = created.task.id;

  app.commit(
    (state) => ({
      ...state,
      sessions: [
        {
          id: 'ses_done',
          taskId,
          date: '2025-10-16',
          startMinutes: 960,
          endMinutes: 1005,
          plannedMinutes: 45,
          actualMinutes: 45,
          state: SESSION_STATE.COMPLETED,
          locked: true,
          source: 'engine',
          reasonCodes: [],
          planVersion: 1,
          createdAt: '2025-10-16T20:30:00+08:00',
          updatedAt: '2025-10-16T20:30:00+08:00',
          startedAt: '2025-10-16T20:30:00+08:00',
          completedAt: '2025-10-16T20:30:00+08:00',
          history: [],
        },
      ],
    }),
    { reason: 'seed' },
  );

  const impact = services.taskService.evaluateTaskImpact(taskId);
  assert.equal(impact.ok, true);
  assert.equal(impact.impact.completedSessions, 1);
  assert.equal(impact.impact.remainingMinutes, 75);

  const deleted = services.taskService.deleteTask(taskId);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.mode, 'soft');
  assert.equal(app.getState().sessions.length, 1, '已完成的学习记录保留');
  assert.equal(app.getState().sessions[0].state, SESSION_STATE.COMPLETED);
});

test('端到端：空数据状态下所有服务都能被安全调用（不会崩溃、不产生假数据）', () => {
  const { services, app } = createTestApp();

  assert.deepEqual(services.taskService.listTaskViews(), []);
  assert.equal(services.planService.getOfficialPlan(), null);
  assert.equal(services.planService.getHistory().length, 0);
  assert.equal(services.planService.undoLastApply().ok, false);
  assert.equal(services.focusService.getRunningSession(), null);
  assert.deepEqual(services.focusService.todayStats('2025-10-16'), {
    plannedMinutes: 0,
    actualMinutes: 0,
    completedCount: 0,
    totalCount: 0,
  });
  assert.equal(services.taskService.deleteTask('tsk_missing').ok, false);
  assert.equal(services.taskService.updateTask('tsk_missing', { title: 'x' }).ok, false);

  const plan = services.planService.ensureDisplayPlan('2025-10-16');
  assert.equal(plan.version, 0);
  assert.equal(plan.metrics.totalStudyMinutes, 0);
  assert.equal(app.getSummary().taskCount, 0);
});

test('端到端：破坏性输入不会损坏数据或崩溃（边界与鲁棒性，对应验收场景 19）', () => {
  const { services, app } = createTestApp();

  const cases = [
    ['空对象', {}],
    ['只有标题', { title: 'x' }],
    ['超长标题', taskInput({ title: 'a'.repeat(500) })],
    ['超大时长', taskInput({ plannedMinutes: 999999 })],
    ['负数时长', taskInput({ plannedMinutes: -60 })],
    ['非法日期', taskInput({ deadlineDate: '2025-02-30' })],
    ['非法时刻', taskInput({ deadlineTime: '25:99' })],
    ['依赖数组里混入非字符串', taskInput({ dependsOn: [null, 42] })],
    ['null', null],
  ];

  for (const [name, input] of cases) {
    const result = services.taskService.addTask(input);
    assert.equal(result.ok, false, `${name} 应被拒绝`);
    assert.ok(Array.isArray(result.issues) || result.error, `${name} 必须给出结构化原因`);
  }
  assert.equal(app.getState().tasks.length, 0, '所有失败都不应产生残留数据');

  // 服务层对 null / 非对象输入也必须返回结构化错误，而不是抛异常
  assert.doesNotThrow(() => services.taskService.addTask(null));
  assert.doesNotThrow(() => services.taskService.updateTask('tsk_x', null));
  assert.equal(services.taskService.updateTask(null, {}).ok, false);
});

test('端到端：相同输入重复运行框架性操作结果一致（为阶段 2 的引擎确定性打基础）', () => {
  const runOnce = () => {
    const { services } = createTestApp();
    services.taskService.addTask(taskInput({ title: '确定性验证', plannedMinutes: 90 }));
    const plan = services.planService.applyPlan(buildPlan(services, { version: 1, studyDate: '2025-10-16' }), { changeSummary: '一致性' });
    return {
      ok: plan.ok,
      version: plan.plan.version,
      days: plan.plan.days.map((d) => [d.date, d.studyMinutes, d.restMinutes, d.bufferMinutes]),
      blocks: plan.plan.blocks.map((b) => [b.kind, b.date, b.startMinutes, b.endMinutes]),
    };
  };

  assert.deepEqual(runOnce(), runOnce());
});
