/**
 * 硬约束校验器测试（H1–H10）。
 *
 * 这些是**负向测试**：故意构造违反约束的计划，断言校验器必须报错。
 * 它们的作用不是"证明计划正确"，而是保证**校验器本身没有失效** ——
 * 一旦有人不小心放宽了某个检查，这里会立刻失败。
 *
 * 另外也覆盖正向情况：合法计划必须通过，避免校验器过严导致"永远出不了计划"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONSTRAINT, describeViolations, validatePlanConstraints } from '../../src/engine/constraints.js';
import { buildPolicy } from '../../src/engine/policy.js';

const NOW = { date: '2025-10-16', minutes: 20 * 60 };
const policy = buildPolicy({});

/** 每天 16:00–23:00 可学习 */
function windowsEveryDay(startMinutes = 16 * 60, endMinutes = 23 * 60) {
  const map = {};
  for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes, endMinutes }];
  return map;
}

const settings = () => ({ studyWindows: windowsEveryDay(), ...buildPolicy({}) });

function task(overrides = {}) {
  return {
    id: 'tsk_1',
    title: '任务',
    subject: '数学',
    plannedMinutes: 90,
    deadlineDate: '2025-10-25',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
    status: 'not_started',
    ...overrides,
  };
}

function studyBlock(overrides = {}) {
  const block = {
    id: 'blk_1',
    kind: 'study',
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 16 * 60 + 45,
    refId: 'ses_1',
    taskId: 'tsk_1',
    subject: '数学',
    locked: false,
    derived: false,
    ...overrides,
  };
  return block;
}

function validate({ blocks, tasks = [task()], sessions = [], fixedActivities = [], settingsOverride = {} }) {
  return validatePlanConstraints({
    plan: { blocks },
    tasks,
    sessions,
    fixedActivities,
    settings: { ...settings(), ...settingsOverride },
    now: NOW,
    policy,
    plannedMinutesByTask: new Map(tasks.map((item) => [item.id, item.plannedMinutes])),
    placedMinutesByTask: new Map(),
  });
}

/* ------------------------------------------------------------------ *
 * 正向：合法计划必须通过
 * ------------------------------------------------------------------ */

test('合法计划通过全部约束校验', () => {
  const result = validate({
    blocks: [studyBlock(), studyBlock({ id: 'blk_2', refId: 'ses_2', startMinutes: 17 * 60, endMinutes: 17 * 60 + 45 })],
  });
  assert.equal(result.ok, true, describeViolations(result.violations));
  assert.deepEqual(result.violations, []);
});

/* ------------------------------------------------------------------ *
 * 负向：逐条构造违规
 * ------------------------------------------------------------------ */

test('H1：学习时段与固定活动重叠必须报错', () => {
  const result = validate({
    blocks: [
      studyBlock(),
      { id: 'blk_fix', kind: 'fixed', date: '2025-10-16', startMinutes: 16 * 60 + 15, endMinutes: 17 * 60, refId: 'fix_1' },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H1));
});

test('H2：两个学习时段相互重叠必须报错', () => {
  const result = validate({
    blocks: [
      studyBlock({ id: 'blk_a', refId: 'ses_a' }),
      studyBlock({ id: 'blk_b', refId: 'ses_b', startMinutes: 16 * 60 + 30, endMinutes: 17 * 60 + 15 }),
    ],
  });
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.constraint === CONSTRAINT.H2);
  assert.ok(violation);
  assert.equal(violation.details.overlap, 15);
});

test('H3：学习时段超出允许的学习时间必须报错', () => {
  const result = validate({
    blocks: [studyBlock({ startMinutes: 14 * 60, endMinutes: 15 * 60 })], // 允许窗口是 16:00–23:00
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H3));
});

test('H4：计划完成晚于截止时间时给出风险告警（不谎称按时完成）', () => {
  const result = validate({
    blocks: [studyBlock({ date: '2025-10-26', startMinutes: 16 * 60, endMinutes: 16 * 60 + 45 })],
    tasks: [task({ deadlineDate: '2025-10-20' })],
  });
  assert.equal(result.ok, true, '容量不足导致的逾期是事实，不应判为数据非法');
  const warning = result.warnings.find((w) => w.constraint === CONSTRAINT.H4);
  assert.ok(warning);
  assert.match(warning.message, /晚于截止时间/);
});

test('H5：不可拆分任务被拆成多段必须报错', () => {
  const atomic = task({ splittable: false, plannedMinutes: 90, minChunkMinutes: 90, maxChunkMinutes: 90 });
  const result = validate({
    tasks: [atomic],
    blocks: [
      studyBlock({ id: 'blk_a', refId: 'ses_a', endMinutes: 16 * 60 + 45 }),
      studyBlock({ id: 'blk_b', refId: 'ses_b', startMinutes: 17 * 60, endMinutes: 17 * 60 + 45 }),
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H5));
});

test('H6：片段超过最长时段必须报错', () => {
  const result = validate({
    blocks: [studyBlock({ endMinutes: 16 * 60 + 90 })], // 90 分钟 > 最长 60
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H6));
});

test('H6b：片段短于最短时段且不是被允许的收尾片段时必须报错', () => {
  const strictPolicy = buildPolicy({ allowUndersizedFinalChunk: false });
  const result = validatePlanConstraints({
    plan: { blocks: [studyBlock({ endMinutes: 16 * 60 + 20 })] }, // 20 分钟 < 最短 30
    tasks: [task()],
    sessions: [],
    fixedActivities: [],
    settings: settings(),
    now: NOW,
    policy: strictPolicy,
    plannedMinutesByTask: new Map([['tsk_1', 90]]),
    placedMinutesByTask: new Map(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H6));
});

test('H6c：跨午夜结束的片段必须报错（跨夜要拆成两天分别记录）', () => {
  const result = validate({
    blocks: [studyBlock({ startMinutes: 22 * 60, endMinutes: 25 * 60 })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H6 && /跨越了午夜/.test(v.message)));
});

test('H7：依赖任务早于前置任务结束必须报错', () => {
  const first = task({ id: 'tsk_1', title: '先做', plannedMinutes: 90 });
  const second = task({ id: 'tsk_2', title: '再做', plannedMinutes: 90, dependsOn: ['tsk_1'] });
  const result = validate({
    tasks: [first, second],
    blocks: [
      studyBlock({ id: 'blk_1', refId: 'ses_1', taskId: 'tsk_1', date: '2025-10-17', startMinutes: 16 * 60, endMinutes: 17 * 60 }),
      studyBlock({ id: 'blk_2', refId: 'ses_2', taskId: 'tsk_2', date: '2025-10-16', startMinutes: 16 * 60, endMinutes: 17 * 60 }),
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H7));
});

test('H7b：前置任务已完成时不受时间先后限制', () => {
  const first = task({ id: 'tsk_1', title: '先做', status: 'completed' });
  const second = task({ id: 'tsk_2', title: '再做', dependsOn: ['tsk_1'] });
  const result = validate({
    tasks: [first, second],
    blocks: [studyBlock({ id: 'blk_2', refId: 'ses_2', taskId: 'tsk_2' })],
  });
  assert.equal(result.ok, true, describeViolations(result.violations));
});

test('H8：计划休息与机动缓冲重叠必须报错', () => {
  const result = validate({
    blocks: [
      studyBlock(),
      { id: 'blk_rest', kind: 'rest', date: '2025-10-16', startMinutes: 17 * 60, endMinutes: 17 * 60 + 15, derived: true },
      { id: 'blk_buf', kind: 'buffer', date: '2025-10-16', startMinutes: 17 * 60 + 5, endMinutes: 17 * 60 + 30, derived: true },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H8));
});

test('H8b：两个休息块相互重叠也会报错（统计会重复计算）', () => {
  const result = validate({
    blocks: [
      { id: 'blk_r1', kind: 'rest', date: '2025-10-16', startMinutes: 17 * 60, endMinutes: 17 * 60 + 20, derived: true },
      { id: 'blk_r2', kind: 'rest', date: '2025-10-16', startMinutes: 17 * 60 + 10, endMinutes: 17 * 60 + 30, derived: true },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H8));
});

test('H9：已完成的学习时段在候选计划中消失必须报错', () => {
  const sessions = [
    {
      id: 'ses_done',
      taskId: 'tsk_1',
      date: '2025-10-16',
      startMinutes: 16 * 60,
      endMinutes: 16 * 60 + 45,
      state: 'completed',
      locked: true,
      plannedMinutes: 45,
    },
  ];
  const result = validate({ blocks: [studyBlock({ id: 'blk_other', refId: 'ses_other', startMinutes: 18 * 60, endMinutes: 19 * 60 })], sessions });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H9));
  assert.equal(result.protectedSessions.protectedCount, 1);
});

test('H10：锁定的学习时段在候选计划中消失必须报错', () => {
  const sessions = [
    {
      id: 'ses_locked',
      taskId: 'tsk_1',
      date: '2025-10-17',
      startMinutes: 20 * 60,
      endMinutes: 20 * 60 + 30,
      state: 'flexible',
      locked: true,
      plannedMinutes: 30,
    },
  ];
  const result = validate({ blocks: [studyBlock({ id: 'blk_other', refId: 'ses_other' })], sessions });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.constraint === CONSTRAINT.H10));
});

test('受保护时段原样保留时通过校验', () => {
  const sessions = [
    {
      id: 'ses_done',
      taskId: 'tsk_1',
      date: '2025-10-16',
      startMinutes: 16 * 60,
      endMinutes: 16 * 60 + 45,
      state: 'completed',
      locked: true,
      plannedMinutes: 45,
    },
  ];
  const result = validate({ blocks: [studyBlock({ id: 'blk_keep', refId: 'ses_done' })], sessions });
  assert.equal(result.ok, true, describeViolations(result.violations));
});

test('违规信息可读：能汇总成给用户看的多行文本', () => {
  const result = validate({
    blocks: [studyBlock({ startMinutes: 14 * 60, endMinutes: 15 * 60 })],
  });
  const text = describeViolations(result.violations);
  assert.match(text, /^\[H3\]/);
  assert.ok(text.length > 10);
});
