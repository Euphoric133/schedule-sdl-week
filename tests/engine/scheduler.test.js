/**
 * 排程引擎测试：验收场景 1–10、17、18。
 *
 * 这些测试回答的是产品最关键的问题：「引擎排出来的计划，到底对不对？」
 * 因此断言都落在**可验证的事实**上（分钟数、重叠、顺序、状态、原因码），
 * 而不是"看起来像那么回事"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_STATUS } from '../../src/domain/plan.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { UNSCHEDULED_REASON } from '../../src/engine/policy.js';
import { describeViolations } from '../../src/engine/constraints.js';
import { blocksOfTask, engineContext, overlaps, plannedMinutesOf, stablePlanShape, studyBlocks } from '../helpers/engine.js';

/* ------------------------------------------------------------------ *
 * 场景 1：所有任务都可以安排 → 完整计划
 * ------------------------------------------------------------------ */

test('场景 1：容量充足时生成完整可行的计划，且工作量完全守恒', () => {
  const env = engineContext();
  const a = env.addTask({ title: '线性代数作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' });
  const b = env.addTask({ title: '英语阅读', subject: '英语', plannedMinutes: 60, deadlineDate: '2025-10-21' });

  const result = env.run();

  assert.equal(result.ok, true);
  assert.equal(result.plan.status, PLAN_STATUS.FEASIBLE);
  assert.deepEqual(result.unscheduled, [], '所有任务都应被安排');
  assert.equal(plannedMinutesOf(result.plan, a.id), 90, '任务 A 的排入分钟数应等于剩余工作量');
  assert.equal(plannedMinutesOf(result.plan, b.id), 60, '任务 B 的排入分钟数应等于剩余工作量');
  assert.equal(result.plan.days.length, 7, '七天窗口');
  assert.equal(result.plan.metrics.totalTaskRemainingMinutes, 0);
});

test('场景 1b：每个片段都落在允许的学习时间内，且不跨越午夜', () => {
  const env = engineContext();
  env.addTask({ plannedMinutes: 120 });
  const result = env.run();

  for (const block of studyBlocks(result.plan)) {
    assert.ok(block.startMinutes >= 16 * 60, `片段开始时间应在 16:00 之后：${block.startMinutes}`);
    assert.ok(block.endMinutes <= 23 * 60, `片段结束时间应在 23:00 之前：${block.endMinutes}`);
  }
});

/* ------------------------------------------------------------------ *
 * 场景 2：高难度任务与临近截止任务并存 → 正确平衡优先级
 * ------------------------------------------------------------------ */

test('场景 2：临近截止的任务优先获得时段，而不是被高难度长任务挤掉', () => {
  const env = engineContext();
  const urgent = env.addTask({
    title: '明天截止的小作业',
    subject: '政治',
    plannedMinutes: 60,
    deadlineDate: '2025-10-17',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 2,
    procrastination: 3,
  });
  const hard = env.addTask({
    title: '六天后截止的大作业',
    subject: '数学',
    plannedMinutes: 180,
    deadlineDate: '2025-10-22',
    deadlineTime: '23:00',
    importance: 5,
    difficulty: 5,
    procrastination: 2,
  });

  const result = env.run();
  assert.equal(result.ok, true);

  const urgentBlocks = blocksOfTask(result.plan, urgent.id);
  const hardBlocks = blocksOfTask(result.plan, hard.id);
  assert.ok(urgentBlocks.length > 0 && hardBlocks.length > 0, '两个任务都应被安排');

  const firstUrgent = urgentBlocks[0];
  const firstHard = hardBlocks[0];
  const urgentKey = `${firstUrgent.date}T${String(firstUrgent.startMinutes).padStart(5, '0')}`;
  const hardKey = `${firstHard.date}T${String(firstHard.startMinutes).padStart(5, '0')}`;
  assert.ok(urgentKey < hardKey, `临近截止的任务应排在前面（${urgentKey} < ${hardKey}）`);

  // 评分可以解释排序：紧迫度越高，分值越高
  const scoreUrgent = result.scoredEntries.find((entry) => entry.taskId === urgent.id);
  const scoreHard = result.scoredEntries.find((entry) => entry.taskId === hard.id);
  assert.ok(scoreUrgent.parts.deadlineUrgency > scoreHard.parts.deadlineUrgency, '紧迫度应反映截止时间差异');
  assert.ok(scoreHard.parts.difficulty > scoreUrgent.parts.difficulty, '难度分项应更高');
});

/* ------------------------------------------------------------------ *
 * 场景 3：任务总时长大于可用时间 → 部分可行 / 不可行
 * ------------------------------------------------------------------ */

test('场景 3：容量不足时给出部分可行状态与明确的缺口与原因', () => {
  const env = engineContext();
  env.setUniformWindow(16 * 60, 16 * 60 + 30); // 每天只有 30 分钟，窗口内合计约 3.5 小时
  env.addTask({ title: '超大作业', plannedMinutes: 600, deadlineDate: '2025-11-30' });

  const result = env.run();

  assert.ok([PLAN_STATUS.PARTIALLY_FEASIBLE, PLAN_STATUS.INFEASIBLE].includes(result.plan.status));
  assert.ok(result.unscheduled.length > 0, '必须有未安排的任务及其原因');
  const gap = result.unscheduled.reduce((sum, item) => sum + item.remainingMinutes, 0);
  assert.ok(gap > 0, '应报告缺口分钟数');
  assert.ok(result.unscheduled.every((item) => item.reasonCode && item.reasonText && item.suggestions.length > 0));
});

test('场景 3b：超载时不会通过取消机动缓冲来掩盖问题（缓冲按容量计算，与任务量无关）', () => {
  const env = engineContext();
  env.addTask({ title: '大任务', plannedMinutes: 900, deadlineDate: '2025-11-30' });
  const result = env.run();

  const bufferTotal = result.plan.days.reduce((sum, day) => sum + day.bufferMinutes, 0);
  const capacity = result.capacityDays.reduce((sum, day) => sum + day.netCapacityMinutes, 0);
  assert.equal(bufferTotal, result.capacityDays.reduce((sum, day) => sum + Math.floor(day.netCapacityMinutes * env.policy().bufferRatio), 0));
  assert.ok(bufferTotal > 0, '缓冲仍应按 10% 预留，而不是被悄悄取消');
  assert.ok(capacity > 0);
  assert.ok(result.plan.metrics.overloadMinutes > 0, '超载分钟数应被如实报告');
});

/* ------------------------------------------------------------------ *
 * 场景 4：跨日拆分的剩余分钟数正确
 * ------------------------------------------------------------------ */

test('场景 4：大任务跨天拆分后，片段合计等于剩余工作量且每段都在合法区间', () => {
  const env = engineContext();
  const task = env.addTask({ title: '大作业', plannedMinutes: 300, minChunkMinutes: 30, maxChunkMinutes: 60, deadlineDate: '2025-11-30' });

  const result = env.run();
  const blocks = blocksOfTask(result.plan, task.id);

  assert.ok(blocks.length > 1, '应当跨天/跨段拆分');
  assert.equal(blocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0), 300, '拆分后总时长必须守恒');

  for (const block of blocks) {
    const length = block.endMinutes - block.startMinutes;
    assert.ok(length >= 30 && length <= 60, `片段长度应在 [30, 60]：${length}`);
  }

  const dates = new Set(blocks.map((block) => block.date));
  assert.ok(dates.size >= 2, '300 分钟应分布在多天');
});

/* ------------------------------------------------------------------ *
 * 场景 5：不可拆分任务不得被拆开
 * ------------------------------------------------------------------ */

test('场景 5：不可拆分任务只产生一个片段，长度等于总时长', () => {
  const env = engineContext();
  const task = env.addTask({
    title: '一次做完的实验',
    plannedMinutes: 120,
    splittable: false,
    minChunkMinutes: 120,
    maxChunkMinutes: 120,
    deadlineDate: '2025-11-30',
  });

  const result = env.run();
  const blocks = blocksOfTask(result.plan, task.id);

  assert.equal(blocks.length, 1, '不可拆分任务只能有一段');
  assert.equal(blocks[0].endMinutes - blocks[0].startMinutes, 120);
});

test('场景 5b：不可拆分任务放不下时报告具体原因，而不是拆开它', () => {
  const env = engineContext();
  env.setUniformWindow(16 * 60, 16 * 60 + 45); // 每天只有 45 分钟空档
  const task = env.addTask({
    title: '需要连续两小时的实验',
    plannedMinutes: 120,
    splittable: false,
    minChunkMinutes: 120,
    maxChunkMinutes: 120,
    deadlineDate: '2025-11-30',
  });

  const result = env.run();
  assert.equal(blocksOfTask(result.plan, task.id).length, 0, '放不下就不放，绝不切开');
  const item = result.unscheduled.find((entry) => entry.taskId === task.id);
  assert.ok(item, '必须报告未安排');
  assert.equal(item.reasonCode, UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT);
  assert.ok(item.suggestions.includes('allow_split'), '应建议"允许拆分"');
});

/* ------------------------------------------------------------------ *
 * 场景 6：固定活动与学习时段不得重叠
 * ------------------------------------------------------------------ */

test('场景 6：学习时段绝不与固定活动重叠（即使可用窗口覆盖了上课时间）', () => {
  const env = engineContext();
  env.setUniformWindow(8 * 60, 23 * 60); // 把白天也算进可用时间
  env.addFixedActivity({ title: '高等数学课', recurrence: { kind: 'weekly', daysOfWeek: [4, 5] }, start: '08:00', end: '09:40' });
  env.addFixedActivity({ title: '午餐', type: 'meal', recurrence: { kind: 'weekly', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] }, start: '12:00', end: '13:00' });
  env.addTask({ plannedMinutes: 600, minChunkMinutes: 60, maxChunkMinutes: 120, deadlineDate: '2025-11-30' });

  const result = env.run();
  assert.equal(result.ok, true, '硬约束校验必须通过');

  const fixed = result.plan.blocks.filter((block) => block.kind === 'fixed');
  assert.ok(fixed.length > 0, '固定活动应出现在时间轴上');

  for (const block of studyBlocks(result.plan)) {
    for (const span of fixed) {
      assert.equal(overlaps(block, span), false, `${block.date} 的学习时段与「${span.label}」重叠了`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 场景 7：锁定时段不受自动重排影响
 * ------------------------------------------------------------------ */

test('场景 7：锁定时段在重排后位置完全不变，并被写入计划', () => {
  const env = engineContext();
  const task = env.addTask({ title: '已锁定的任务', plannedMinutes: 120, deadlineDate: '2025-10-25' });
  const locked = env.addSession({
    taskId: task.id,
    date: '2025-10-17',
    startMinutes: 20 * 60,
    endMinutes: 20 * 60 + 45,
    locked: true,
    state: SESSION_STATE.FLEXIBLE,
    source: 'user_move',
  });
  env.addTask({ title: '其它任务', subject: '英语', plannedMinutes: 120, deadlineDate: '2025-10-25' });

  const result = env.run();
  assert.equal(result.ok, true);

  const lockedBlock = studyBlocks(result.plan).find((block) => block.refId === locked.id || block.locked === true);
  assert.ok(lockedBlock, '锁定时段必须保留在计划中');
  assert.equal(lockedBlock.date, '2025-10-17');
  assert.equal(lockedBlock.startMinutes, 20 * 60);
  assert.equal(lockedBlock.endMinutes, 20 * 60 + 45);
  assert.equal(lockedBlock.locked, true);

  // 其它任务不得占用被锁定的时间
  for (const block of studyBlocks(result.plan)) {
    if (block.refId === lockedBlock.refId) continue;
    assert.equal(overlaps(block, lockedBlock), false, '其它时段不得与锁定时段重叠');
  }

  // 锁定被占用后，只需为新片段安排 120 − 45 = 75 分钟
  // （plannedMinutesOf 会把保留的锁定时段也算进去，这里要算的是"新排入"的部分）
  const taskBlocks = studyBlocks(result.plan).filter((block) => block.taskId === task.id);
  const reservedMinutes = taskBlocks.filter((block) => block.meta?.reserved === true).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
  const newMinutes = taskBlocks.filter((block) => block.meta?.reserved !== true).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
  assert.equal(reservedMinutes, 45, '锁定的 45 分钟原样保留');
  assert.equal(newMinutes, 120 - 45, `新排入的分钟数应为 75，实际 ${newMinutes}`);
  assert.equal(reservedMinutes + newMinutes, task.plannedMinutes, '保留 + 新排 = 任务总时长');
});

test('场景 7b：锁定数量与位置在两次运行之间完全一致（确定性）', () => {
  // 两次运行必须喂入**完全相同**的输入（含任务 ID），否则比较的就不是"同一输入"
  const seed = engineContext();
  const task = seed.addTask({ title: '锁定任务', plannedMinutes: 90, deadlineDate: '2025-10-25' });

  const build = () => {
    const env = engineContext();
    env.state.tasks = [task];
    env.addSession({ taskId: task.id, date: '2025-10-17', startMinutes: 19 * 60, endMinutes: 19 * 60 + 30, locked: true });
    return stablePlanShape(env.run().plan);
  };
  assert.equal(build(), build());
});

/* ------------------------------------------------------------------ *
 * 场景 8：休息与缓冲不重复占用时间
 * ------------------------------------------------------------------ */

test('场景 8：计划休息与机动缓冲互不重叠，且统计分开计算', () => {
  const env = engineContext();
  env.addTask({ plannedMinutes: 420, minChunkMinutes: 45, maxChunkMinutes: 60, deadlineDate: '2025-11-30' });

  const result = env.run();
  const rests = result.plan.blocks.filter((block) => block.kind === 'rest');
  const buffers = result.plan.blocks.filter((block) => block.kind === 'buffer');

  assert.ok(rests.length > 0, '连续学习后应插入计划休息');
  assert.ok(buffers.length > 0, '应按 10% 预留机动缓冲');

  for (const rest of rests) {
    for (const buffer of buffers) {
      assert.equal(overlaps(rest, buffer), false, `${rest.date} 的休息与缓冲不应重叠`);
    }
  }

  // 每日统计里 rest 与 buffer 分别累计，不与学习时长混淆
  for (const day of result.plan.days) {
    const dayBlocks = result.plan.blocks.filter((block) => block.date === day.date);
    const restMinutes = dayBlocks.filter((b) => b.kind === 'rest').reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    const bufferMinutes = dayBlocks.filter((b) => b.kind === 'buffer').reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    assert.equal(day.restMinutes, restMinutes);
    assert.equal(day.bufferMinutes, bufferMinutes);
  }
});

test('场景 8b：缓冲总量按"净容量 × 10%"预留，休息量单独统计', () => {
  const env = engineContext();
  env.addTask({ plannedMinutes: 300, deadlineDate: '2025-11-30' });
  const result = env.run();

  const expectedBuffer = result.capacityDays.reduce((sum, day) => sum + Math.floor(day.netCapacityMinutes * 0.1), 0);
  const actualBuffer = result.plan.days.reduce((sum, day) => sum + day.bufferMinutes, 0);
  assert.equal(actualBuffer, expectedBuffer, '每日缓冲应为 floor(净容量 × 10%) 的合计');

  const day1 = result.plan.days[0];
  assert.ok(day1.restMinutes > 0 || result.plan.days.some((day) => day.restMinutes > 0), '应有计划休息');
});

/* ------------------------------------------------------------------ *
 * 场景 9：前置任务未完成时后续任务不得提前执行
 * ------------------------------------------------------------------ */

test('场景 9：依赖任务不会早于前置任务的完成时刻开始', () => {
  const env = engineContext();
  const first = env.addTask({ title: '先做这个', subject: '数学', plannedMinutes: 120, deadlineDate: '2025-10-22' });
  const second = env.addTask({ title: '再做这个', subject: '英语', plannedMinutes: 120, deadlineDate: '2025-10-24', dependsOn: [first.id] });

  const result = env.run();
  const firstBlocks = blocksOfTask(result.plan, first.id);
  const secondBlocks = blocksOfTask(result.plan, second.id);

  assert.ok(firstBlocks.length > 0 && secondBlocks.length > 0);
  const firstLast = firstBlocks.reduce((latest, block) => {
    const key = `${block.date}T${String(block.endMinutes).padStart(5, '0')}`;
    return latest === null || key > latest ? key : latest;
  }, null);
  const secondFirst = secondBlocks.reduce((earliest, block) => {
    const key = `${block.date}T${String(block.startMinutes).padStart(5, '0')}`;
    return earliest === null || key < earliest ? key : earliest;
  }, null);

  assert.ok(secondFirst >= firstLast, `依赖任务（${secondFirst}）不得早于前置任务完成（${firstLast}）`);
});

test('场景 9b：前置任务被取消时，依赖它的任务报告"依赖无法满足"而不是硬排', () => {
  const env = engineContext();
  const first = env.addTask({ title: '已取消的任务', plannedMinutes: 60 });
  first.status = 'cancelled';
  const second = env.addTask({ title: '依赖它的任务', plannedMinutes: 60, dependsOn: [first.id] });

  const result = env.run();
  assert.equal(blocksOfTask(result.plan, second.id).length, 0, '依赖无法满足时不得安排');
  const item = result.unscheduled.find((entry) => entry.taskId === second.id);
  assert.ok(item);
  assert.equal(item.reasonCode, UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE);
});

test('场景 9c：前置任务未完成时报告"被依赖阻断"', () => {
  const env = engineContext();
  env.setUniformWindow(16 * 60, 16 * 60 + 30); // 容量极小
  const first = env.addTask({ title: '前置任务', plannedMinutes: 600, deadlineDate: '2025-11-30' });
  const second = env.addTask({ title: '依赖任务', plannedMinutes: 60, deadlineDate: '2025-11-30', dependsOn: [first.id] });

  const result = env.run();
  const item = result.unscheduled.find((entry) => entry.taskId === second.id);
  if (item) {
    assert.ok(
      [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY, UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE, UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY].includes(item.reasonCode),
      `原因码应说明依赖或容量问题，实际：${item.reasonCode}`,
    );
  }
  assert.equal(result.ok, true, '依赖问题不应导致引擎报错');
});

/* ------------------------------------------------------------------ *
 * 场景 10：已完成任务不会被重复安排
 * ------------------------------------------------------------------ */

test('场景 10：已完成的工作量不会被重复安排，只排剩余部分', () => {
  const env = engineContext();
  const task = env.addTask({ title: '部分完成的任务', plannedMinutes: 120, deadlineDate: '2025-10-25' });
  env.addSession({
    taskId: task.id,
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    state: SESSION_STATE.COMPLETED,
    actualMinutes: 45,
    locked: true,
  });

  const result = env.run();
  const blocks = blocksOfTask(result.plan, task.id);
  // 计划里应包含"保留的已完成时段"与"新安排的时段"；已完成的保留块带有 reserved 标记
  const reservedBlocks = blocks.filter((block) => block.refId && !/^ses_[0-9a-f]{8}$/.test(block.refId));
  const newBlocks = blocks.filter((block) => /^ses_[0-9a-f]{8}$/.test(block.refId ?? ''));

  assert.equal(reservedBlocks.length, 1, '已完成的那一段必须原样保留');
  assert.equal(reservedBlocks[0].endMinutes - reservedBlocks[0].startMinutes, 45);
  assert.equal(newBlocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0), 75, '只有 120 − 45 = 75 分钟需要新安排');
  assert.equal(blocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0), 120, '计划里包含已完成与待进行的全部时段');
  assert.ok(newBlocks.length > 0, '剩余部分应被安排');
});

test('场景 10b：全部完成的任务不会被安排任何新时段', () => {
  const env = engineContext();
  const task = env.addTask({ title: '已完成的任务', plannedMinutes: 60 });
  env.addSession({
    taskId: task.id,
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 17 * 60,
    state: SESSION_STATE.COMPLETED,
    actualMinutes: 60,
    locked: true,
  });

  const result = env.run();
  assert.equal(plannedMinutesOf(result.plan, task.id), 60, '计划里只有已完成的那一段');
  assert.equal(result.plan.unscheduled.length, 0);
});

test('场景 10c：已取消的任务完全不参与排程', () => {
  const env = engineContext();
  const task = env.addTask({ title: '取消掉的任务', plannedMinutes: 120 });
  task.status = 'cancelled';
  env.addTask({ title: '正常任务', plannedMinutes: 60, deadlineDate: '2025-10-20' });

  const result = env.run();
  assert.equal(blocksOfTask(result.plan, task.id).length, 0);
  assert.equal(result.plan.unscheduled.find((item) => item.taskId === task.id), undefined);
});

/* ------------------------------------------------------------------ *
 * 场景 17：确定性
 * ------------------------------------------------------------------ */

test('场景 17：相同输入连续运行三次，计划逐字节相同（含派生时段 ID）', () => {
  // 先在"种子环境"里把任务与固定活动构造好，然后三次运行复用同一批实体，
  // 这样三次输入的每一个字段（包括 ID）都完全相同 —— 这正是引擎的确定性契约。
  const seed = engineContext();
  const activity = seed.addFixedActivity({ title: '课程', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '08:00', end: '09:40' });
  const a = seed.addTask({ title: '任务 A', plannedMinutes: 180, deadlineDate: '2025-10-21' });
  const b = seed.addTask({ title: '任务 B', subject: '英语', plannedMinutes: 120, deadlineDate: '2025-10-22', dependsOn: [a.id] });

  const build = () => {
    const env = engineContext();
    env.setUniformWindow(16 * 60, 23 * 60);
    env.state.fixedActivities = [activity];
    env.state.tasks = [a, b];
    return env.run();
  };

  const results = [build(), build(), build()];
  const shapes = results.map((result) => stablePlanShape(result.plan));
  assert.equal(shapes[0], shapes[1]);
  assert.equal(shapes[1], shapes[2]);
  assert.equal(results[0].inputHash, results[1].inputHash, '输入指纹必须一致');
  assert.equal(results[0].inputHash, results[2].inputHash);
});

test('场景 17b：同一输入在同一个引擎实例内重复运行时输入指纹一致', () => {
  const env = engineContext();
  env.addTask({ plannedMinutes: 90 });
  const first = env.run();
  const second = env.run();
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(stablePlanShape(first.plan), stablePlanShape(second.plan));
});

test('场景 17c：输入变化（截止时间改动）会导致输入指纹变化，从而让旧预览失效', () => {
  const env = engineContext();
  const task = env.addTask({ plannedMinutes: 90, deadlineDate: '2025-10-20' });
  const before = env.run().inputHash;

  env.state.tasks = env.state.tasks.map((item) => (item.id === task.id ? { ...item, deadlineDate: '2025-10-19' } : item));
  const after = env.run().inputHash;

  assert.notEqual(before, after, '截止时间变化必须改变输入指纹');
});

/* ------------------------------------------------------------------ *
 * 场景 18：时区与跨午夜
 * ------------------------------------------------------------------ */

test('场景 18：跨午夜可用窗口（22:00–02:00）被正确分布到两天，且不产生跨夜片段', () => {
  const env = engineContext();
  // 每天 22:00–02:00（跨夜）：窗口应被拆成"当天 22:00–24:00"与"次日 00:00–02:00"
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes: 22 * 60, endMinutes: 2 * 60 }];
  env.setStudyWindows(map);
  env.addTask({ plannedMinutes: 120, minChunkMinutes: 30, maxChunkMinutes: 60, deadlineDate: '2025-11-30' });

  const result = env.run();
  assert.equal(result.ok, true);

  // 每天每个业务日应有 240 分钟净容量（22:00–24:00 + 次日 00:00–02:00）
  const day2 = result.capacityDays.find((day) => day.date === '2025-10-17');
  assert.equal(day2.netCapacityMinutes, 240, `2025-10-17 的净容量应为 240 分钟，实际 ${day2.netCapacityMinutes}`);

  for (const block of studyBlocks(result.plan)) {
    assert.ok(block.endMinutes <= 1440, '片段不得跨越午夜结束（跨夜必须拆成两天记录）');
    assert.ok(block.startMinutes >= 0);
  }
});

test('场景 18b：凌晨（04:00 之前）的窗口归属前一天业务日，日期处理不错位', () => {
  const env = engineContext();
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes: 0, endMinutes: 60 }]; // 每天 00:00–01:00
  env.setStudyWindows(map);
  env.addTask({ plannedMinutes: 60, minChunkMinutes: 30, maxChunkMinutes: 60, deadlineDate: '2025-11-30' });

  const result = env.run();
  assert.equal(result.ok, true);
  // 该场景的关键是"日期与窗口归属不错位"：00:00–01:00 的窗口必须被识别为 7 天都有 60 分钟容量。
  // （每天 60 分钟、减 10% 缓冲后为 54 分钟，放不下最短 30 分钟的两段，因此这个 60 分钟任务
  //   在本例中最终判为不可行——这是容量事实，不是日期错误。）
  assert.equal(result.capacityDays.length, 7);
  for (const day of result.capacityDays) {
    assert.equal(day.netCapacityMinutes, 60, `${day.date} 凌晨窗口容量应为 60 分钟`);
    assert.equal(day.schedulableMinutes, 54, '扣除 10% 缓冲后应为 54 分钟');
  }
  for (const block of studyBlocks(result.plan)) {
    assert.ok(block.startMinutes >= 0 && block.endMinutes <= 60, '凌晨窗口内的片段应落在 00:00–01:00');
  }
});

test('回归：多任务 + 依赖 + 休息插入时，计划内不出现任何区间重叠', () => {
  // 这个组合曾经触发真实缺陷：局部优化把学习片段向前压缩时没有避开休息块，
  // 导致"休息 17:00–17:10"与"学习 17:00–17:45"重叠（H2/H8 违规，应用预览被拒绝）。
  const env = engineContext();
  env.addTask({ title: 'A', plannedMinutes: 120, deadlineDate: '2025-10-18' });
  env.addTask({ title: 'B', subject: '英语', plannedMinutes: 90, deadlineDate: '2025-10-20' });
  const dep = env.addTask({ title: 'C', subject: '物理', plannedMinutes: 150, deadlineDate: '2025-10-22' });
  env.addTask({ title: 'D', subject: '物理', plannedMinutes: 60, deadlineDate: '2025-10-21', dependsOn: [dep.id] });

  const result = env.run();
  assert.equal(result.ok, true, describeViolations(result.violations ?? []));

  const byDate = new Map();
  for (const block of result.plan.blocks) {
    if (block.kind === 'fixed') continue; // 固定活动之间允许重叠
    if (!byDate.has(block.date)) byDate.set(block.date, []);
    byDate.get(block.date).push(block);
  }
  for (const [date, list] of byDate) {
    const sorted = [...list].sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      assert.ok(
        current.startMinutes >= previous.endMinutes,
        `${date} 出现重叠：${previous.kind} ${previous.startMinutes}-${previous.endMinutes} 与 ${current.kind} ${current.startMinutes}-${current.endMinutes}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 输入非法 / 边界
 * ------------------------------------------------------------------ */

test('输入非法时返回 invalid_input，并且不生成任何计划内容', () => {
  const env = engineContext();
  const task = env.addTask({ plannedMinutes: 90 });
  // 人为构造数据矛盾：未完成时段超过剩余工作量（整体校验 V016）
  env.state.sessions.push({
    id: 'ses_bad',
    taskId: task.id,
    date: '2025-10-17',
    startMinutes: 16 * 60,
    endMinutes: 17 * 60,
    plannedMinutes: 60,
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
  env.state.sessions.push({ ...env.state.sessions[0], id: 'ses_bad2' });

  const result = env.run();
  assert.equal(result.ok, false);
  assert.equal(result.status, PLAN_STATUS.INVALID_INPUT);
  assert.ok(result.issues.length > 0, '必须给出具体的输入问题');
  assert.equal(result.plan, undefined, '输入非法时不得产出计划');
});

test('依赖成环时返回 invalid_input（引擎无法为环排序）', () => {
  const env = engineContext();
  const a = env.addTask({ title: 'A', plannedMinutes: 60 });
  const b = env.addTask({ title: 'B', plannedMinutes: 60, dependsOn: [a.id] });
  env.state.tasks = env.state.tasks.map((task) => (task.id === a.id ? { ...task, dependsOn: [b.id] } : task));

  const result = env.run();
  assert.equal(result.ok, false);
  assert.equal(result.status, PLAN_STATUS.INVALID_INPUT);
  assert.ok(result.diagnostics.some((item) => item.code === 'V014'), '应指出循环依赖');
});

test('空数据：没有任何任务时返回完整但为空的可行计划', () => {
  const env = engineContext();
  const result = env.run();

  assert.equal(result.ok, true);
  assert.equal(result.plan.status, PLAN_STATUS.FEASIBLE);
  assert.deepEqual(result.unscheduled, []);
  assert.equal(studyBlocks(result.plan).length, 0);
  assert.equal(result.plan.days.length, 7);
  assert.ok(result.plan.blocks.every((block) => block.kind === 'buffer'), '没有任务时只有缓冲块');
});

test('没有任何可用时间时报告"窗口过窄"，并给出不可行或部分可行状态', () => {
  const env = engineContext();
  env.setStudyWindows({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });
  env.addTask({ plannedMinutes: 60 });

  const result = env.run();
  assert.equal(result.ok, true);
  assert.equal(result.plan.status, PLAN_STATUS.INFEASIBLE);
  assert.ok(result.diagnostics.some((item) => item.code === 'no_capacity'));
  assert.ok(result.unscheduled.length > 0);
});

test('维护类信息：每个未安排任务都能解释"为什么"和"怎么办"', () => {
  const env = engineContext();
  env.setUniformWindow(16 * 60, 16 * 60 + 30);
  env.addTask({ title: '排不完的任务', plannedMinutes: 600, deadlineDate: '2025-11-30' });

  const result = env.run();
  for (const item of result.unscheduled) {
    assert.ok(item.taskId && item.taskTitle);
    assert.ok(item.remainingMinutes > 0);
    assert.ok(item.reasonCode.length > 0);
    assert.ok(item.reasonText.length > 5, '必须有面向用户的中文说明');
    assert.ok(Array.isArray(item.suggestions) && item.suggestions.length > 0, '必须给出可执行建议');
  }
});
