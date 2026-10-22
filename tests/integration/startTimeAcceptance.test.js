/**
 * 需求 A 验收：任务开始时间严格生效。
 *
 * 夹具：固定时钟 2025-10-16（周四），默认可学习窗口 07:00–23:00（需要时临时放宽到 23:30）。
 * 断言全部落在具体分钟数、诊断码与未安排原因上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksOfTask, serviceContext, studyBlocks } from '../helpers/engine.js';

const DATE = '2025-10-16';
const at = (hours, minutes = 0) => hours * 60 + minutes;

/** 某个任务已排入的总分钟数 */
const minutesOf = (plan, taskId) =>
  blocksOfTask(plan, taskId).reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
const T2223 = at(22, 23);

async function withEnv(nowMinutes, fn, options = {}) {
  const env = await serviceContext({ now: { date: DATE, minutes: nowMinutes }, ...options });
  try {
    return await fn(env);
  } finally {
    env.cleanup();
  }
}

/* ---------------- A-01 ---------------- */

test('A-01 任务开始 22:23 时第一个片段正好从 22:23 开始', async () => {
  await withEnv(at(22, 5), (env) => {
    const task = env.addTask({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: T2223, splittable: false });
    const result = env.run();

    assert.equal(result.ok, true, result.issues.map((i) => i.message).join('; '));
    const blocks = blocksOfTask(result.plan, task.id);
    assert.equal(blocks.length, 1, '不可拆分任务应只有一个片段');
    assert.equal(blocks[0].startMinutes, 1343);
    assert.equal(blocks[0].endMinutes, 1373);
    assert.ok(blocks.every((b) => b.startMinutes >= 1343));
  });
});

/* ---------------- A-02 ---------------- */

test('A-02 没填开始时间时仍按默认整点（21:05 → 22:00）', async () => {
  await withEnv(at(21, 5), (env) => {
    const task = env.addTask({ title: '普通任务', plannedMinutes: 30 });
    const result = env.run();

    assert.equal(result.ok, true, result.issues.map((i) => i.message).join('; '));
    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].startMinutes, 1320, '默认从 22:00 开始');
  });
});

/* ---------------- A-03 ---------------- */

test('A-03 高优先级任务先占最早时段，低优先级任务的严格开始时间顺延', async () => {
  await withEnv(at(22, 5), (env) => {
    env.setUniformWindow(7 * 60, at(23, 30));
    const important = env.addTask({ title: '重要任务', plannedMinutes: 30, importance: 5, deadlineTime: '23:30' });
    const anchored = env.addTask({
      title: '指定开始时间任务',
      plannedMinutes: 30,
      plannedStartMinutes: T2223,
      importance: 1,
      deadlineTime: '23:30',
    });
    const result = env.run();

    assert.equal(result.ok, true, result.issues.map((i) => i.message).join('; '));
    const importantBlocks = blocksOfTask(result.plan, important.id);
    const anchoredBlocks = blocksOfTask(result.plan, anchored.id);

    assert.equal(importantBlocks[0].startMinutes, 1343, '重要任务应先占 22:23');
    assert.equal(anchoredBlocks[0].startMinutes, 1373, '被占用的任务应顺延到 22:53');
    assert.ok(anchoredBlocks.every((b) => b.startMinutes >= 1343));
  });
});

/* ---------------- A-04 ---------------- */

test('A-04 固定日程占住开始时间时顺延，并给出 planned_start_delayed 诊断', async () => {
  await withEnv(at(22, 5), (env) => {
    env.setUniformWindow(7 * 60, at(23, 30));
    env.addFixedActivity({ title: '临时会议', start: '22:23', end: '23:00' });
    const task = env.addTask({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: T2223, splittable: false, deadlineTime: '23:30' });
    const result = env.run();

    const blocks = blocksOfTask(result.plan, task.id);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startMinutes, 1380, '固定日程结束后（23:00）再开始');
    const delayed = result.diagnostics.find((d) => d.code === 'planned_start_delayed');
    assert.ok(delayed, '必须有 planned_start_delayed 诊断，不能静默顺延');
    assert.match(delayed.message, /22:23/);
    assert.match(delayed.message, /23:00/);
  });
});

/* ---------------- A-05 ---------------- */

test('A-05 70 分钟不可拆分任务在 22:23 之后放不下时如实报告未安排', async () => {
  await withEnv(at(22, 5), (env) => {
    const task = env.addTask({ title: '大作业', plannedMinutes: 70, plannedStartMinutes: T2223, splittable: false });
    const result = env.run();

    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.every((b) => b.startMinutes >= 1343), '不允许排到 22:23 之前');
    assert.ok(blocks.every((b) => b.endMinutes <= 1440), '不允许排到 23:00 之后');
    if (blocks.length === 0) {
      const entry = result.unscheduled.find((item) => item.taskId === task.id);
      assert.ok(entry, '放不下时必须进未安排列表');
      assert.equal(entry.reasonCode, 'non_splittable_no_slot');
      assert.ok(entry.reasonText.length > 0);
    }
  });
});

/* ---------------- A-06 ---------------- */

test('A-06 开始时间已过去时按默认起点处理并提示，不排到过去', async () => {
  await withEnv(at(21, 5), (env) => {
    const task = env.addTask({ title: '过期开始', plannedMinutes: 30, plannedStartMinutes: at(21, 0) });
    const result = env.run();

    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].startMinutes, 1320);
    assert.ok(result.diagnostics.some((d) => d.code === 'planned_start_clamped'));
    assert.ok(blocks.every((b) => b.startMinutes >= at(21, 5)));
  });
});

/* ---------------- A-07 ---------------- */

test('A-07 优化阶段不会把 22:23 的片段回填到更早', async () => {
  await withEnv(at(22, 5), (env) => {
    const task = env.addTask({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: T2223, splittable: false });
    const result = env.run({ optimizationPasses: 10 });

    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].startMinutes, 1343);
  });
});

/* ---------------- A-08 ---------------- */

test('A-08 10/15/20/25 分钟的短任务都精确排在 22:23', async () => {
  for (const minutes of [10, 15, 20, 25]) {
    // eslint-disable-next-line no-await-in-loop
    await withEnv(at(22, 5), (env) => {
      const task = env.addTask({ title: `${minutes} 分钟任务`, plannedMinutes: minutes, plannedStartMinutes: T2223, splittable: false });
      const result = env.run();

      assert.equal(result.ok, true, `${minutes} 分钟应能排：${result.issues.map((i) => i.message).join('; ')}`);
      const blocks = blocksOfTask(result.plan, task.id);
      assert.equal(blocks[0].startMinutes, 1343);
      assert.equal(blocks[0].endMinutes - blocks[0].startMinutes, minutes);
    });
  }
});

/* ---------------- A-09 ---------------- */

test('A-09 手动指定规划起点 23:00 时，任务开始时间被上移并提示', async () => {
  await withEnv(at(22, 5), (env) => {
    const task = env.addTask({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: T2223, deadlineTime: '23:30' });
    const result = env.run({ startAt: { date: DATE, minutes: 1380 } });

    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.every((b) => b.startMinutes >= 1380), '不得排到手动起点之前');
    assert.ok(result.diagnostics.some((d) => d.code === 'planned_start_clamped'));
  });
});

/* ---------------- A-10 ---------------- */

test('A-10 两个任务分别指定 22:23 与 22:53，各自严格生效', async () => {
  await withEnv(at(22, 5), (env) => {
    env.setUniformWindow(7 * 60, at(23, 30));
    const first = env.addTask({ title: 'A', plannedMinutes: 30, plannedStartMinutes: T2223, deadlineTime: '23:59' });
    const second = env.addTask({ title: 'B', plannedMinutes: 30, plannedStartMinutes: at(22, 53), deadlineTime: '23:59' });
    const result = env.run();

    const aBlocks = blocksOfTask(result.plan, first.id);
    const bBlocks = blocksOfTask(result.plan, second.id);
    assert.equal(aBlocks[0].startMinutes, T2223);
    assert.equal(bBlocks[0].startMinutes, at(22, 53));
  });
});

/* ---------------- A-11 ---------------- */

test('A-11 可拆分的 60 分钟任务：所有块不早于 22:23，总时长 60', async () => {
  await withEnv(at(22, 5), (env) => {
    env.setUniformWindow(7 * 60, at(23, 30));
    const task = env.addTask({ title: '长任务', plannedMinutes: 60, plannedStartMinutes: T2223, deadlineTime: '23:59' });
    const result = env.run();

    const blocks = blocksOfTask(result.plan, task.id);
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].startMinutes, T2223);
    assert.ok(blocks.every((b) => b.startMinutes >= T2223));
    assert.equal(minutesOf(result.plan, task.id), 60, '总排入时长应等于 60');
  });
});

/* ---------------- A-12 ---------------- */

test('A-12 相同输入连续两次生成得到完全一致的计划', async () => {
  await withEnv(at(22, 5), (env) => {
    const task = env.addTask({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: T2223, splittable: false });
    const one = env.run();
    const two = env.run();

    const shape = (plan) =>
      (plan?.blocks ?? []).map((b) => `${b.date}|${b.taskId ?? ''}|${b.startMinutes}|${b.endMinutes}|${b.kind}`);
    assert.deepEqual(shape(two.plan), shape(one.plan));
    assert.ok(blocksOfTask(one.plan, task.id).length >= 1);
    assert.ok(studyBlocks(one.plan).length >= 1);
  });
});
