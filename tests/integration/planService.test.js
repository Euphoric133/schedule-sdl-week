/**
 * 计划服务集成测试。
 *
 * 覆盖产品最核心的数据安全规则：
 * - 预览过期（基础版本变化 / 输入指纹变化）时**拒绝应用**，绝不用旧数据覆盖新数据（验收场景 16）
 * - 应用计划会保留历史版本，可撤销（验收场景 12 的"放弃后不变"由 discard 保证）
 * - 已完成的学习记录不能因为应用新计划而从计划中消失（硬约束 H9）
 * - 撤销时版本号继续递增，避免版本号指向两份不同的计划
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUS, createEmptyPlan } from '../../src/domain/plan.js';
import { blockBuffer, blockRest, blockFromSession, createBlock } from '../../src/domain/calendarBlock.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { makeSession } from '../helpers/fixtures.js';
import { createTestApp, taskInput } from '../helpers/app.js';

/**
 * 构造一份结构完整（含七天统计）的候选计划。
 * 这里**手工**给出 days 而不调用 buildCandidatePlan，是为了让本测试能精确控制输入，
 * 从而验证 applyPlan 自身的校验与事务行为。
 */
function candidateWith({ windowStart = '2025-10-16', version = 1, sessions = [], studyBlock } = {}) {
  const blocks = [];
  if (studyBlock) blocks.push(studyBlock);
  blocks.push(blockRest({ id: 'blk_rest', date: windowStart, startMinutes: 1005, endMinutes: 1015 }));
  blocks.push(blockBuffer({ id: 'blk_buf', date: windowStart, startMinutes: 1015, endMinutes: 1033 }));

  const days = [];
  const studyMinutes = studyBlock ? studyBlock.endMinutes - studyBlock.startMinutes : 0;
  for (let i = 0; i < 7; i += 1) {
    const [y, m, d] = windowStart.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    days.push({
      date,
      weekday: ((Math.floor(Date.UTC(y, m - 1, d + i) / 86400000) + 4) % 7) || 7,
      windowMinutes: 420,
      fixedMinutes: 60,
      reservedMinutes: 0,
      netCapacityMinutes: 360,
      bufferMinutes: 36,
      bufferUsedMinutes: 0,
      schedulableMinutes: 324,
      studyMinutes: i === 0 ? studyMinutes : 0,
      restMinutes: i === 0 ? 10 : 0,
      sessionCount: i === 0 && studyBlock ? 1 : 0,
      overloadMinutes: 0,
      freeWindows: [],
    });
  }

  return {
    planId: 'pln_candidate',
    version,
    status: PLAN_STATUS.FEASIBLE,
    generatedAt: '2025-10-16T20:30:00+08:00',
    windowStart,
    windowEnd: '2025-10-22',
    engineVersion: 'engine@0.1.0',
    policyHash: 'policy-a',
    inputHash: 'input-a',
    blocks,
    sessionIds: sessions.map((s) => s.id),
    days,
    unscheduled: [],
    diagnostics: [],
    metrics: { totalStudyMinutes: studyMinutes, totalTaskRemainingMinutes: 0, bufferReservedMinutes: 18, restMinutes: 10, subjectSwitches: 0 },
  };
}

test('buildCandidatePlan：按窗口生成七天统计，并把块归入正确日期', () => {
  const { services } = createTestApp();
  const plan = services.planService.buildCandidatePlan({
    blocks: [
      createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005, subject: '数学' }),
      createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020, subject: '英语' }),
      blockRest({ id: 'b3', date: '2025-10-16', startMinutes: 1005, endMinutes: 1015 }),
    ],
    windowStart: '2025-10-16',
  });

  assert.equal(plan.days.length, 7);
  const day16 = plan.days.find((d) => d.date === '2025-10-16');
  const day17 = plan.days.find((d) => d.date === '2025-10-17');
  assert.equal(day16.studyMinutes, 45);
  assert.equal(day16.restMinutes, 10);
  assert.equal(day16.sessionCount, 1);
  assert.equal(day17.studyMinutes, 60);
  assert.equal(plan.metrics.totalStudyMinutes, 105);
  assert.deepEqual(plan.sessionIds, plan.blocks.filter((b) => b.kind === 'study' && b.refId).map((b) => b.refId));
});

test('applyPlan：应用候选计划后成为正式计划，并写入版本号与历史快照', () => {
  const { services, app } = createTestApp();
  const candidate = candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) });

  const first = services.planService.applyPlan(candidate, { changeSummary: '生成第一份计划' });
  assert.equal(first.ok, true, first.issues?.map((i) => i.message).join('; '));
  assert.equal(services.planService.getOfficialPlan().version, 1);
  assert.equal(services.planService.getHistory().length, 0, '第一份计划没有可撤销的前一版本');

  const second = services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { changeSummary: '新增一段英语' },
  );
  assert.equal(second.ok, true);
  assert.equal(services.planService.getOfficialPlan().version, 2);
  assert.equal(services.planService.getHistory().length, 1);
  assert.equal(services.planService.getHistory()[0].changeSummary, '生成第一份计划');
  assert.equal(app.getState().meta.lastPlanMutation.summary, '新增一段英语');
});

test('applyPlan：基础版本不匹配时拒绝应用（预览过期，对应验收场景 16）', () => {
  const { services } = createTestApp();
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: 'v1',
  });
  services.planService.applyPlan(candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }), {
    changeSummary: 'v2',
  });

  const stale = services.planService.applyPlan(
    candidateWith({ version: 3, studyBlock: createBlock({ id: 'b3', kind: 'study', date: '2025-10-18', startMinutes: 960, endMinutes: 1020 }) }),
    { expectedBaseVersion: 1, changeSummary: '过期预览' },
  );

  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_preview');
  assert.match(stale.issues[0].message, /预览已过期/);
  assert.equal(services.planService.getOfficialPlan().version, 2, '过期预览绝不能覆盖当前计划');
  assert.equal(services.planService.getOfficialPlan().blocks[0].date, '2025-10-17');
});

test('applyPlan：输入指纹变化时同样拒绝（任务或设置在预览期间被改动）', () => {
  const { services } = createTestApp();
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: 'v1',
  });

  const stale = services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { expectedBaseVersion: 1, expectedInputHash: 'input-different', changeSummary: '指纹不符' },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_preview');
});

test('applyPlan：候选计划缺少已完成的时段时被拒绝（H9：已完成记录必须保留）', () => {
  const { services, app } = createTestApp();
  const task = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const done = makeSession({ id: 'ses_done', taskId: task.task.id, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 });
  app.commit((state) => ({ ...state, sessions: [done] }), { reason: 'seed' });

  const withoutDone = services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 1080, endMinutes: 1125 }) }), {
    changeSummary: '遗漏已完成时段',
  });

  assert.equal(withoutDone.ok, false);
  assert.match(withoutDone.issues[0].message, /缺少 1 个已完成的学习时段/);
  assert.equal(services.planService.getOfficialPlan(), null, '被拒绝的计划不得成为正式计划');
});

test('applyPlan：包含已完成时段时正常应用，且这些时段被登记进计划', () => {
  const { services, app } = createTestApp();
  const task = services.taskService.addTask(taskInput({ plannedMinutes: 120 }));
  const done = makeSession({ id: 'ses_done', taskId: task.task.id, startMinutes: 960, endMinutes: 1005, state: 'completed', actualMinutes: 45 });
  app.commit((state) => ({ ...state, sessions: [done] }), { reason: 'seed' });

  const block = blockFromSession(done, { task: task.task });
  const result = services.planService.applyPlan(candidateWith({ sessions: [done], studyBlock: block }), { changeSummary: '含已完成记录' });

  assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));
  assert.deepEqual(services.planService.getOfficialPlan().sessionIds, ['ses_done']);
});

test('undoLastApply：恢复上一版本，但版本号继续递增（不使用旧号码）', () => {
  const { services } = createTestApp();
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: 'v1 内容',
  });
  services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { changeSummary: 'v2 内容' },
  );

  const undone = services.planService.undoLastApply();
  assert.equal(undone.ok, true);
  assert.equal(undone.undoneFrom, 2);
  assert.equal(undone.restoredFrom, 1);
  const plan = services.planService.getOfficialPlan();
  assert.equal(plan.version, 3, '版本号继续递增，避免与历史版本号指向不同内容');
  assert.equal(plan.blocks[0].date, '2025-10-16', '内容恢复到 v1');
  assert.equal(services.planService.getHistory().length, 0, '撤销后历史被弹出');
});

test('undoLastApply：没有可撤销版本时返回结构化错误', () => {
  const { services } = createTestApp();
  const result = services.planService.undoLastApply();
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /没有可以撤销/);
});

test('undoLastApply：撤销会导致新的已完成记录消失时被拒绝（保护学习事实）', () => {
  const { services, app } = createTestApp();
  const task = services.taskService.addTask(taskInput({ plannedMinutes: 180 }));
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: 'v1',
  });
  services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { changeSummary: 'v2' },
  );

  // 用户在 v2 之后完成了一段学习，这段时段不在 v1 的快照里
  const newDone = makeSession({ id: 'ses_new', taskId: task.task.id, startMinutes: 1080, endMinutes: 1125, state: 'completed', actualMinutes: 45 });
  app.commit((state) => ({ ...state, sessions: [newDone] }), { reason: 'seed' });

  const result = services.planService.undoLastApply();
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /无法撤销/);
  assert.equal(services.planService.getOfficialPlan().version, 2, '拒绝后正式计划保持不变');
});

test('listVersions：包含当前版本与历史版本，供界面展示', () => {
  const { services } = createTestApp();
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: '第一版',
  });
  services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { changeSummary: '第二版' },
  );

  const versions = services.planService.listVersions();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 2);
  assert.equal(versions[0].current, true);
  assert.equal(versions[0].summary, '当前正式计划');
  assert.equal(versions[1].summary, '第一版');
});

test('clearHistory：清空版本历史但保留当前正式计划', () => {
  const { services } = createTestApp();
  services.planService.applyPlan(candidateWith({ studyBlock: createBlock({ id: 'b1', kind: 'study', date: '2025-10-16', startMinutes: 960, endMinutes: 1005 }) }), {
    changeSummary: 'v1',
  });
  services.planService.applyPlan(
    candidateWith({ version: 2, studyBlock: createBlock({ id: 'b2', kind: 'study', date: '2025-10-17', startMinutes: 960, endMinutes: 1020 }) }),
    { changeSummary: 'v2' },
  );

  const cleared = services.planService.clearHistory();
  assert.equal(cleared.ok, true);
  assert.equal(services.planService.getHistory().length, 0);
  assert.equal(services.planService.getOfficialPlan().version, 2);
  assert.equal(services.planService.undoLastApply().ok, false, '清空后无法再撤销');
});

test('ensureDisplayPlan：没有正式计划时返回零值占位计划（不是假数据）', () => {
  const { services } = createTestApp();
  const plan = services.planService.ensureDisplayPlan('2025-10-16');
  assert.equal(plan.version, 0);
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.days.length, 7);
  assert.equal(plan.metrics.totalStudyMinutes, 0);
  assert.equal(services.planService.getOfficialPlan(), null, '占位计划不会变成正式计划');
});

test('isSessionProtected：锁定、进行中、已完成三种时段都受保护', () => {
  const { services } = createTestApp();
  assert.equal(services.planService.isSessionProtected({ state: SESSION_STATE.FLEXIBLE, locked: true }), true);
  assert.equal(services.planService.isSessionProtected({ state: SESSION_STATE.IN_PROGRESS, locked: true }), true);
  assert.equal(services.planService.isSessionProtected({ state: SESSION_STATE.COMPLETED, locked: false }), true);
  assert.equal(services.planService.isSessionProtected({ state: SESSION_STATE.FLEXIBLE, locked: false }), false);
});

test('unscheduledSummary：汇总未安排任务数量、分钟数与原因集合', () => {
  const { services } = createTestApp();
  const plan = {
    ...createEmptyPlan({ planId: 'pln', windowStart: '2025-10-16', nowIso: '2025-10-16T20:30:00+08:00' }),
    unscheduled: [
      { taskId: 'tsk_1', remainingMinutes: 40, reasonCode: 'insufficient_capacity' },
      { taskId: 'tsk_2', remainingMinutes: 20, reasonCode: 'tail_too_small' },
      { taskId: 'tsk_3', remainingMinutes: 10, reasonCode: 'insufficient_capacity' },
    ],
  };
  const summary = services.planService.unscheduledSummary(plan);
  assert.equal(summary.count, 3);
  assert.equal(summary.totalMinutes, 70);
  assert.deepEqual(summary.reasons.sort(), ['insufficient_capacity', 'tail_too_small']);
});
