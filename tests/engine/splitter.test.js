/**
 * 任务拆分测试。
 *
 * 拆分是"排不下还是数据不合法"的分水岭，因此这里重点验证：
 * - 合法片段守恒（Σ 片段 == 剩余工作量，或者把不合法尾部如实交回）
 * - 从不生成违反 [min, max] 的片段（唯一例外是用户显式允许的收尾片段）
 * - 不可拆分任务永远只有一个片段
 * - 结果确定（同输入同输出）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPolicy } from '../../src/engine/policy.js';
import { DEFAULT_MAX_FRAGMENTS_PER_TASK, SPLIT_STATUS, fragmentsConserveWorkload, splitAll, splitTask } from '../../src/engine/splitter.js';

const policy = buildPolicy({});
const splittable = (overrides = {}) => ({
  id: 'tsk_a',
  splittable: true,
  minChunkMinutes: 30,
  maxChunkMinutes: 60,
  plannedMinutes: 180,
  ...overrides,
});

const minutesOf = (fragments) => fragments.map((fragment) => fragment.minutes);

test('整块能放下时只产生一个片段', () => {
  const result = splitTask(splittable(), { remainingMinutes: 45, policy });
  assert.equal(result.status, SPLIT_STATUS.OK);
  assert.deepEqual(minutesOf(result.fragments), [45]);
  assert.equal(result.fragments[0].isFinal, true);
  assert.equal(result.fragments[0].undersized, false);
});

test('能整除时均匀切分，且总时长精确守恒', () => {
  const cases = [
    [60, [60]],
    [120, [60, 60]],
    [180, [60, 60, 60]],
    [90, [45, 45]], // 均匀切分优于 [60, 30]：片段更均衡，碎片更少
  ];
  for (const [remaining, expected] of cases) {
    const result = splitTask(splittable(), { remainingMinutes: remaining, policy });
    assert.equal(result.status, SPLIT_STATUS.OK, `${remaining} 分钟应可正常拆分`);
    assert.deepEqual(minutesOf(result.fragments), expected);
    assert.equal(fragmentsConserveWorkload(result.fragments, remaining), true, '片段总和必须等于剩余工作量');
  }
});

test('尾差通过均匀切分消除，不产生小于最短时段的片段', () => {
  // 130 分钟若贪心切分会得到 [60, 60, 10]，10 分钟不合法；正确做法是均匀分成 3 段
  const result = splitTask(splittable(), { remainingMinutes: 130, policy });
  assert.equal(result.status, SPLIT_STATUS.OK);
  assert.deepEqual(minutesOf(result.fragments), [44, 43, 43]);
  assert.equal(fragmentsConserveWorkload(result.fragments, 130), true);
  for (const fragment of result.fragments) {
    assert.ok(fragment.minutes >= 30 && fragment.minutes <= 60);
  }
});

test('无法合法切分时报告 tailMinutes，且不生成非法片段（allowUndersizedFinalChunk=false）', () => {
  const strict = buildPolicy({ allowUndersizedFinalChunk: false });
  const result = splitTask(splittable({ minChunkMinutes: 50, maxChunkMinutes: 50 }), { remainingMinutes: 130, policy: strict });

  assert.equal(result.status, SPLIT_STATUS.UNSPLITTABLE_TAIL);
  assert.equal(result.tailMinutes, 30, '应如实报告 30 分钟余量排不下');
  assert.equal(result.fragments.length, 2, '保留能合法切出的头部');
  assert.deepEqual(minutesOf(result.fragments), [50, 50]);
  for (const fragment of result.fragments) {
    assert.ok(fragment.minutes >= 50 && fragment.minutes <= 50, '不得生成非法片段');
  }
  assert.match(result.message, /最短学习时段/);
});

test('允许收尾片段偏短时，把偏短部分作为最后一段（默认行为）', () => {
  const result = splitTask(splittable({ minChunkMinutes: 50, maxChunkMinutes: 50 }), { remainingMinutes: 130, policy });
  assert.equal(result.status, SPLIT_STATUS.OK);
  assert.deepEqual(minutesOf(result.fragments), [50, 50, 30]);
  assert.equal(result.undersizedFinalAllowed, true);
  assert.equal(result.fragments[2].undersized, true, '收尾片段需被标记，便于诊断与界面提示');
  assert.equal(fragmentsConserveWorkload(result.fragments, 130), true, '允许偏短也仍然守恒');
});

test('剩余量本身短于最短时段时按设置决定：允许则作为单段，不允许则报错', () => {
  const allowed = splitTask(splittable(), { remainingMinutes: 20, policy });
  assert.equal(allowed.status, SPLIT_STATUS.OK);
  assert.deepEqual(minutesOf(allowed.fragments), [20]);
  assert.equal(allowed.fragments[0].undersized, true);

  const strict = buildPolicy({ allowUndersizedFinalChunk: false });
  const rejected = splitTask(splittable(), { remainingMinutes: 20, policy: strict });
  assert.equal(rejected.status, SPLIT_STATUS.UNSPLITTABLE_TAIL);
  assert.deepEqual(rejected.fragments, []);
  assert.equal(rejected.tailMinutes, 20);
});

test('不可拆分任务只产生一个片段，长度等于剩余工作量', () => {
  const atomic = { id: 'tsk_b', splittable: false, minChunkMinutes: 90, maxChunkMinutes: 90, plannedMinutes: 90 };
  const result = splitTask(atomic, { remainingMinutes: 90, policy });
  assert.equal(result.status, SPLIT_STATUS.OK);
  assert.deepEqual(minutesOf(result.fragments), [90]);
  assert.equal(result.fragments.length, 1, '不可拆分任务绝不能被切成多段');
});

test('不可拆分任务超过允许的最大时长时报错，而不是切开它', () => {
  const atomic = { id: 'tsk_b', splittable: false, minChunkMinutes: 300, maxChunkMinutes: 300, plannedMinutes: 300 };
  const result = splitTask(atomic, { remainingMinutes: 300, policy });
  assert.equal(result.status, SPLIT_STATUS.ATOMIC_TOO_LONG);
  assert.deepEqual(result.fragments, []);
  assert.equal(result.tailMinutes, 300);
  assert.match(result.message, /不可拆分/);
});

test('剩余工作量为 0 时返回 empty，不产生片段', () => {
  const result = splitTask(splittable(), { remainingMinutes: 0, policy });
  assert.equal(result.status, SPLIT_STATUS.EMPTY);
  assert.deepEqual(result.fragments, []);
});

test('片段数超过安全上界时明确报错，避免产生成千上万个片段', () => {
  const result = splitTask(splittable({ minChunkMinutes: 5, maxChunkMinutes: 5 }), { remainingMinutes: 1000, policy });
  assert.equal(result.status, SPLIT_STATUS.TOO_MANY_FRAGMENTS);
  assert.match(result.message, new RegExp(String(DEFAULT_MAX_FRAGMENTS_PER_TASK)));
});

test('min > max 的脏数据不会造成死循环（统一按 [小, 大] 处理）', () => {
  const result = splitTask(splittable({ minChunkMinutes: 60, maxChunkMinutes: 30 }), { remainingMinutes: 120, policy });
  assert.equal(result.status, SPLIT_STATUS.OK);
  assert.equal(fragmentsConserveWorkload(result.fragments, 120), true);
});

test('同样输入连续拆分多次结果完全一致（确定性）', () => {
  const run = () => splitTask(splittable({ minChunkMinutes: 35, maxChunkMinutes: 80 }), { remainingMinutes: 333, policy });
  assert.deepEqual(run(), run());
  assert.deepEqual(run(), run());
});

test('splitAll 汇总多个任务：成功进入 fragments，失败进入 failures', () => {
  const tasks = [
    { task: { id: 'tsk_ok', splittable: true, minChunkMinutes: 30, maxChunkMinutes: 60, plannedMinutes: 90 }, remainingMinutes: 90 },
    { task: { id: 'tsk_bad', splittable: false, minChunkMinutes: 500, maxChunkMinutes: 500, plannedMinutes: 500 }, remainingMinutes: 500 },
    { task: { id: 'tsk_zero', splittable: true, minChunkMinutes: 30, maxChunkMinutes: 60, plannedMinutes: 60 }, remainingMinutes: 0 },
  ];

  const { fragments, failures } = splitAll(tasks, { policy });
  assert.deepEqual([...new Set(fragments.map((fragment) => fragment.taskId))], ['tsk_ok']);
  assert.equal(fragments.reduce((sum, fragment) => sum + fragment.minutes, 0), 90);
  assert.equal(failures.length, 1, '只有真正失败的任务才进入 failures（0 剩余不算失败）');
  assert.equal(failures[0].taskId, 'tsk_bad');
  assert.equal(failures[0].status, SPLIT_STATUS.ATOMIC_TOO_LONG);
});
