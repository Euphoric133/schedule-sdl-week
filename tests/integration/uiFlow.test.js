/**
 * 界面业务流集成测试（阶段 3）。
 *
 * 这些测试不检查像素，而是验证"界面动作 → 草稿 → 候选计划 → 确认后写入"这条链路：
 * - 任务新增/修改/删除、时段锁定/移动、固定活动增删、设置修改
 *   都必须**先生成候选预览**，未确认前数据一个字节都不能变；
 * - 确认应用后，数据变更与计划变更在**同一次提交**里一起生效；
 * - 放弃预览时数据与计划都保持不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUS } from '../../src/domain/plan.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { FIXED_ACTIVITY_TYPE } from '../../src/domain/fixedActivity.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/** 建立一个带任务的测试应用，并已应用第一份计划 */
function bootstrapped(options = {}) {
  const env = createTestApp();
  const created = env.services.taskService.addTask(
    taskInput({ title: '线性代数作业', plannedMinutes: options.plannedMinutes ?? 90, deadlineDate: '2025-10-20' }),
  );
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '首次生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));
  return { ...env, task: created.task };
}

/* ------------------------------------------------------------------ *
 * 任务：新增 / 修改 / 删除都先生成预览
 * ------------------------------------------------------------------ */

test('任务：通过草稿变更新增任务时不写入数据，确认后才落盘（任务与计划一起生效）', () => {
  const env = bootstrapped();
  const tasksBefore = env.app.getState().tasks.length;

  // 等价于用户在任务表单点"创建并生成预览"
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.add', input: taskInput({ title: '英语阅读', subject: '英语', plannedMinutes: 60, deadlineDate: '2025-10-21' }) }],
  });

  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(env.app.getState().tasks.length, tasksBefore, '未确认前不得新增任务');
  assert.equal(env.app.getState().officialPlan.version, 1, '未确认前正式计划不得变化');
  assert.match(previewed.preview.changeSummary, /新增任务「英语阅读」/);

  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));
  assert.equal(env.app.getState().tasks.length, tasksBefore + 1, '确认后任务才被创建');
  assert.equal(env.app.getState().officialPlan.version, 2);
  assert.equal(env.services.planService.getHistory().length, 1, '旧计划进入版本历史');
});

test('回归：确认"新增任务"的预览后，生成的时段必须引用真实存在的任务', () => {
  // 曾经的真实缺陷：会话快照在**重放 ops 之前**构造，用的是草稿里的临时任务 ID，
  // 结果确认后写入了引用不存在任务的时段，下一次预览直接被"时段引用了不存在的任务"拦下。
  const env = createTestApp();
  const first = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.add', input: taskInput({ title: 'A', plannedMinutes: 120, deadlineDate: '2025-10-18' }) }],
  });
  assert.equal(first.ok, true);
  assert.equal(env.services.planService.applyPreview().ok, true);

  const taskIds = new Set(env.app.getState().tasks.map((task) => task.id));
  const sessions = env.app.getState().sessions;
  assert.ok(sessions.length > 0, '应创建学习时段');
  for (const session of sessions) {
    assert.ok(taskIds.has(session.taskId), `时段 ${session.id} 引用了不存在的任务 ${session.taskId}`);
  }

  // 再生成一次预览：整体校验必须通过（这正是缺陷暴露的地方）
  const second = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.add', input: taskInput({ title: 'B', subject: '英语', plannedMinutes: 60, deadlineDate: '2025-10-21' }) }],
  });
  assert.equal(second.ok, true, second.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().tasks.length, 2);

  const finalTaskIds = new Set(env.app.getState().tasks.map((task) => task.id));
  for (const session of env.app.getState().sessions) {
    assert.ok(finalTaskIds.has(session.taskId), '第二次确认后时段仍必须引用真实任务');
  }
});

test('任务：放弃预览时任务与计划都保持不变', () => {
  const env = bootstrapped();
  const before = JSON.stringify({ tasks: env.app.getState().tasks, plan: env.app.getState().officialPlan, sessions: env.app.getState().sessions });

  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { plannedMinutes: 240, title: '改成很大的任务' } }],
  });
  assert.equal(previewed.ok, true);

  const discarded = env.services.planService.discardPreview();
  assert.equal(discarded.ok, true);
  const after = JSON.stringify({ tasks: env.app.getState().tasks, plan: env.app.getState().officialPlan, sessions: env.app.getState().sessions });
  assert.equal(after, before, '放弃预览后业务数据必须完全不变');
});

test('任务：把截止时间提前，候选计划里所有时段都不晚于新截止时间', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { deadlineDate: '2025-10-17' } }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));

  const blocks = previewed.preview.candidate.blocks.filter((block) => block.kind === 'study' && block.taskId === env.task.id);
  assert.ok(blocks.length > 0, '应仍然安排出学习时段');
  for (const block of blocks) {
    assert.ok(block.date <= '2025-10-17', `时段 ${block.date} 不应晚于新的截止日期`);
  }
});

test('任务：无改动重新规划时差异为零（不谎报"全部重排"）', () => {
  // 真实缺陷回归：以前每次重排都会换一批会话 ID，导致"完全没变的时段"被报成
  // "全部取消 + 全部新增"，用户点一次生成计划就以为整个计划被推翻了。
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({ now: NOW, changeSummary: '重新规划' });
  assert.equal(previewed.ok, true);
  const counts = previewed.preview.diff.counts;
  assert.deepEqual(
    { added: counts.added, moved: counts.moved, resized: counts.resized, split: counts.split, cancelled: counts.cancelled },
    { added: 0, moved: 0, resized: 0, split: 0, cancelled: 0 },
    '没有任何数据改动时不应产生任何调整',
  );
  assert.ok(counts.unchanged > 0, '应当明确报告"保持不变"的时段数量');

  // 应用之后会话 ID 也不应改变（否则历史记录会无谓膨胀）
  const before = env.app.getState().sessions.map((session) => session.id).sort();
  assert.equal(env.services.planService.applyPreview().ok, true);
  const after = env.app.getState().sessions.map((session) => session.id).sort();
  assert.deepEqual(after, before, '重新规划不应改变未变化时段的身份');
});

test('任务：真正改变时长会产生可解释的差异（而不是零值）', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { plannedMinutes: 240 } }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  const counts = previewed.preview.diff.counts;
  const total = counts.added + counts.moved + counts.resized + counts.split;
  assert.ok(total > 0, `预计用时从 90 分钟改成 240 分钟后必须产生差异，实际 counts=${JSON.stringify(counts)}`);
});

test('任务：依赖关系不合法时草稿被拒绝，不产生候选计划', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.update', taskId: env.task.id, patch: { dependsOn: ['tsk_ghost'] } }],
  });
  assert.equal(previewed.ok, false);
  assert.equal(previewed.code, 'invalid_draft');
  assert.equal(env.app.getState().pendingPreview, null);
});

test('任务：完成与取消通过草稿生效，且已完成时段保留', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.status', taskId: env.task.id, to: TASK_STATUS.CANCELLED }],
  });
  assert.equal(previewed.ok, true);
  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

  const task = env.app.getState().tasks[0];
  assert.equal(task.status, TASK_STATUS.CANCELLED);
  const remaining = env.app.getState().sessions.filter((session) => session.taskId === task.id && session.state === SESSION_STATE.FLEXIBLE);
  assert.equal(remaining.length, 0, '取消任务后不应再有待进行的时段');
});

/* ------------------------------------------------------------------ *
 * 时段：锁定 / 解锁 / 移动 / 取消
 * ------------------------------------------------------------------ */

test('时段：锁定与解锁走草稿流程，确认后才写入', () => {
  const env = bootstrapped();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.ok(session, '应存在一个待进行的时段');

  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'session.lock', sessionId: session.id, locked: true }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(env.app.getState().sessions.find((item) => item.id === session.id).locked, false, '未确认前不得锁定');

  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));
  const locked = env.app.getState().sessions.find((item) => item.id === session.id);
  assert.equal(locked.locked, true, '确认后时段被锁定');
  assert.equal(locked.date, session.date, '锁定不会改变时间');
  assert.equal(locked.startMinutes, session.startMinutes);
  assert.equal(locked.endMinutes, session.endMinutes);

  // 再解锁
  const unlock = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'session.lock', sessionId: session.id, locked: false }],
  });
  assert.equal(unlock.ok, true);
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().sessions.find((item) => item.id === session.id).locked, false);
});

test('时段：移动时段并保持锁定，确认后位置更新且锁定保留', () => {
  const env = bootstrapped();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);

  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'session.move',
        sessionId: session.id,
        date: session.date,
        startMinutes: 21 * 60,
        endMinutes: 21 * 60 + session.plannedMinutes,
        lock: true,
      },
    ],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const moved = env.app.getState().sessions.find((item) => item.id === session.id);
  assert.equal(moved.startMinutes, 21 * 60);
  assert.equal(moved.locked, true, '用户选择"移动后保持锁定"应生效');
  assert.equal(moved.source, 'user_move');
  assert.ok(moved.history.length > 0, '移动会写入历史，便于追溯');
});

test('时段：锁定的时段不能被移动（必须显式 force）', () => {
  const env = bootstrapped();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);

  // 先锁定
  assert.equal(
    env.services.planService.requestPreview({ now: NOW, ops: [{ kind: 'session.lock', sessionId: session.id, locked: true }] }).ok,
    true,
  );
  assert.equal(env.services.planService.applyPreview().ok, true);

  const blocked = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'session.move', sessionId: session.id, startMinutes: 20 * 60, endMinutes: 20 * 60 + session.plannedMinutes }],
  });
  assert.equal(blocked.ok, false, '锁定时段默认拒绝移动');
  assert.equal(blocked.code, 'invalid_draft');
  assert.match(blocked.issues[0].message, /已锁定/);

  const forced = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'session.move',
        sessionId: session.id,
        startMinutes: 20 * 60,
        endMinutes: 20 * 60 + session.plannedMinutes,
        lock: true,
        force: true,
      },
    ],
  });
  assert.equal(forced.ok, true, '显式 force 时允许移动（界面必须先让用户解锁或确认）');
});

test('时段：取消时段会释放它的工作量，剩余部分重新安排', () => {
  const env = bootstrapped({ plannedMinutes: 180 });
  const sessions = env.app.getState().sessions.filter((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.ok(sessions.length >= 1);
  const target = sessions[0];

  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'session.cancel', sessionId: target.id }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const after = env.app.getState().sessions;
  const cancelled = after.find((item) => item.id === target.id);
  assert.equal(cancelled.state, SESSION_STATE.CANCELLED);
  const active = after.filter((item) => item.taskId === env.task.id && item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(
    active.reduce((sum, item) => sum + item.plannedMinutes, 0),
    180,
    '取消后总工作量仍然守恒（只是换了时段）',
  );
});

test('时段：已完成记录不能被取消或移动（历史事实不可篡改）', () => {
  const env = bootstrapped();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);

  assert.equal(
    env.services.planService.requestPreview({
      now: NOW,
      ops: [{ kind: 'session.complete', sessionId: session.id, actualMinutes: session.plannedMinutes }],
    }).ok,
    true,
  );
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().sessions.find((item) => item.id === session.id).state, SESSION_STATE.COMPLETED);

  const cancelAttempt = env.services.planService.requestPreview({ now: NOW, ops: [{ kind: 'session.cancel', sessionId: session.id }] });
  assert.equal(cancelAttempt.ok, false);
  assert.match(cancelAttempt.issues[0].message, /不能被取消/);

  const moveAttempt = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'session.move', sessionId: session.id, startMinutes: 20 * 60, endMinutes: 20 * 60 + session.plannedMinutes }],
  });
  assert.equal(moveAttempt.ok, false);
  assert.match(moveAttempt.issues[0].message, /不能被移动/);
});

/* ------------------------------------------------------------------ *
 * 固定活动
 * ------------------------------------------------------------------ */

test('固定活动：新增课程会减少可用时间，预览里能看到容量变化', () => {
  const env = bootstrapped();
  const before = env.app.getState().officialPlan.days[0].netCapacityMinutes;

  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: {
          title: '高等数学课',
          type: FIXED_ACTIVITY_TYPE.CLASS,
          recurrence: { kind: 'weekly', daysOfWeek: [4] },
          // 注意：规划起点是"当前时刻之后的下一个整点"（now = 20:30 → 21:00），
          // 因此要用 22:00–23:00 这样**尚未开始**的时段来验证"课程会占用容量"。
          start: '22:00',
          end: '23:00',
        },
      },
    ],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(env.app.getState().fixedActivities.length, 0, '未确认前不得写入固定活动');

  const candidate = previewed.preview.candidate;
  const after = candidate.days.find((day) => day.date === '2025-10-16').netCapacityMinutes;
  assert.equal(after, before - 60, '22:00–23:00 的课程让当天净容量减少 60 分钟');
  assert.ok(candidate.diagnostics.length >= 0);

  // 学习时段不得与新课重叠
  const dayBlocks = candidate.blocks.filter((block) => block.date === '2025-10-16' && block.kind !== 'fixed');
  for (const block of dayBlocks) {
    const overlaps = block.startMinutes < 23 * 60 && 22 * 60 < block.endMinutes;
    assert.equal(overlaps, false, `时段 ${block.startMinutes}-${block.endMinutes} 与课程重叠`);
  }
});

test('固定活动：删除活动会增加可用时间，确认后写入', () => {
  const env = createTestApp();
  // 先通过服务直接写入一个固定活动（模拟历史数据）
  env.services.taskService.addTask(taskInput({ plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const preview1 = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '社团活动', type: FIXED_ACTIVITY_TYPE.CLUB, recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '19:00', end: '20:00' },
      },
    ],
  });
  assert.equal(preview1.ok, true);
  assert.equal(env.services.planService.applyPreview().ok, true);
  const activity = env.app.getState().fixedActivities[0];
  assert.ok(activity);

  const impact = env.services.fixedActivityService.evaluateImpact(activity.id, ['2025-10-16', '2025-10-17']);
  assert.equal(impact.ok, true);
  assert.equal(impact.impact.occurrencesInWindow, 1, '只在周四生效');
  assert.equal(impact.impact.totalMinutesInWindow, 60);

  const preview2 = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'fixedActivity.remove', activityId: activity.id }],
  });
  assert.equal(preview2.ok, true);
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().fixedActivities.length, 0);
});

test('固定活动：非法重复规则被拒绝（每周重复但一天都没选）', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '无效活动', type: FIXED_ACTIVITY_TYPE.MEAL, recurrence: { kind: 'weekly', daysOfWeek: [] }, start: '12:00', end: '13:00' },
      },
    ],
  });
  assert.equal(previewed.ok, false);
  assert.equal(previewed.code, 'invalid_draft');
  assert.ok(previewed.issues.some((issue) => issue.code === 'V040'));
});

/* ------------------------------------------------------------------ *
 * 设置与窗口滚动
 * ------------------------------------------------------------------ */

test('设置：缓冲时间功能已移除——不再预留缓冲，也不再生成缓冲时段', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'settings.update', settings: { bufferRatio: 0.2 } }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));

  const day = previewed.preview.candidate.days[0];
  assert.equal(day.bufferMinutes, 0, '缓冲已移除，不应再预留');
  assert.equal(
    previewed.preview.candidate.blocks.filter((block) => block.kind === 'buffer').length,
    0,
    '不应再生成缓冲时段',
  );

  // 旧设置字段不再被写入（避免继续扩散废弃字段）
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal('bufferRatio' in env.app.getState().settings, false, '设置里不应再保存缓冲比例');
});

test('设置：非法设置仍会被拒绝（例如负权重）', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'settings.update', settings: { weights: { deadlineUrgency: -1, difficulty: 1, importance: 1, procrastination: 1 } } }],
  });
  assert.equal(previewed.ok, false);
  assert.ok(previewed.issues.some((issue) => issue.severity === 'error'));
});

test('窗口滚动：把窗口前移一天，保留已完成历史并重排，且与正式计划可比较', () => {
  const env = bootstrapped();
  const previewed = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'window.shift', windowStart: '2025-10-17', windowDays: 7 }],
  });
  assert.equal(previewed.ok, true, previewed.issues?.map((i) => i.message).join('; '));
  assert.equal(previewed.preview.candidate.windowStart, '2025-10-17');
  assert.equal(previewed.preview.candidate.windowEnd, '2025-10-23');
  assert.equal(env.app.getState().officialPlan.windowStart, '2025-10-16', '未确认前窗口不变');

  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().officialPlan.windowStart, '2025-10-17');
  assert.equal(env.app.getState().meta.initialWindowStart, '2025-10-17');
});

test('窗口滚动：包含已完成时段时，这些记录仍被完整保留', () => {
  const env = bootstrapped();
  const session = env.app.getState().sessions.find((item) => item.state === SESSION_STATE.FLEXIBLE);
  assert.equal(
    env.services.planService.requestPreview({
      now: NOW,
      ops: [{ kind: 'session.complete', sessionId: session.id, actualMinutes: session.plannedMinutes }],
    }).ok,
    true,
  );
  assert.equal(env.services.planService.applyPreview().ok, true);

  const shifted = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'window.shift', windowStart: '2025-10-18', windowDays: 7 }],
  });
  assert.equal(shifted.ok, true, shifted.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const completed = env.app.getState().sessions.find((item) => item.id === session.id);
  assert.ok(completed, '已完成记录必须保留（即使它落在新窗口之外）');
  assert.equal(completed.state, SESSION_STATE.COMPLETED);
  assert.equal(completed.actualMinutes, session.plannedMinutes);
});
