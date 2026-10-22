/**
 * 花园内「学习任务计时」分区。
 *
 * 这里验证不依赖真实浏览器就能确定的部分：
 * - 任务清单的数据（开始时间、时长来自计划的时段）；
 * - 剩余时间格式化与"该不该现在开始"的判定；
 * - 面板注入的健壮性（没有 iframe / 没有文档时安静失败）。
 * 真实计时与点击行为需要浏览器验证，报告里会写明。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRemaining, mountStudyTimerPanel, schedulePhaseOf } from '../../src/ui/gardenPanel.js';
import { listStudyTasks } from '../../src/services/gardenSync.js';

/* ---------------- 数据：清单 ---------------- */

test('清单：开始时间与时长取自计划的最近一段时段', () => {
  const tasks = [
    { id: 't1', title: '晚自习', status: 'not_started', plannedMinutes: 90, priorCompletedMinutes: 0 },
    { id: 't2', title: '英语', status: 'in_progress', plannedMinutes: 40, priorCompletedMinutes: 10 },
    { id: 't3', title: '已完成', status: 'completed', plannedMinutes: 30, priorCompletedMinutes: 0 },
  ];
  const sessions = [
    { taskId: 't1', date: '2025-10-17', startMinutes: 1343, endMinutes: 1413, state: 'flexible' },
    { taskId: 't1', date: '2025-10-16', startMinutes: 480, endMinutes: 540, state: 'flexible' },
    { taskId: 't2', date: '2025-10-16', startMinutes: 600, endMinutes: 630, state: 'flexible' },
    { taskId: 't2', date: '2025-10-16', startMinutes: 700, endMinutes: 705, state: 'completed' },
  ];

  const list = listStudyTasks({ tasks, sessions, map: { t1: 'g1' } });
  assert.equal(list.length, 2, '已完成的任务不应出现在计时清单里');

  const first = list.find((item) => item.plannerId === 't1');
  assert.equal(first.startMinutes, 480, '应取最早的一段');
  // 口径变更（v1.12）：计时时长 = 任务剩余工作量，而不是单个片段的长度
  assert.equal(first.minutes, 90, 't1 计划 90 分钟、无已完成 → 90');
  assert.equal(first.gardenId, 'g1');

  const second = list.find((item) => item.plannerId === 't2');
  assert.equal(second.startMinutes, 600, '已完成的时段不参与');
  assert.equal(second.minutes, 25, 't2 计划 40 − 已填 10 − 已完成时段 5 = 25');
});

test('清单：没有排进计划时用任务自身剩余时长兜底', () => {
  const list = listStudyTasks({
    tasks: [{ id: 't9', title: '空闲任务', status: 'not_started', plannedMinutes: 70, priorCompletedMinutes: 20 }],
    sessions: [],
    map: {},
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].startMinutes, null, '没有计划时段就没有开始时间');
  assert.equal(list[0].minutes, 50, '剩余 = 计划 70 - 已完成 20');
});

test('清单：全部完成或取消时返回空，不报错', () => {
  assert.deepEqual(listStudyTasks({ tasks: [], sessions: [], map: {} }), []);
  assert.deepEqual(
    listStudyTasks({ tasks: [{ id: 'a', title: 'x', status: 'completed', plannedMinutes: 30 }], sessions: [], map: {} }),
    [],
  );
});

/* ---------------- 计时显示 ---------------- */

test('剩余时间格式化：mm:ss 与 h:mm:ss', () => {
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(9), '00:09');
  assert.equal(formatRemaining(65), '01:05');
  assert.equal(formatRemaining(600), '10:00');
  assert.equal(formatRemaining(3600), '1:00:00');
  assert.equal(formatRemaining(4200), '1:10:00');
  assert.equal(formatRemaining(-5), '00:00', '负数归零，不显示 -00:05');
});

test('到点判定：未到开始时间 / 正在进行 / 已过时段', () => {
  const task = { startMinutes: 1343, minutes: 70 };  // 22:23 开始，70 分钟
  assert.equal(schedulePhaseOf(task, { minutes: 1342 }), 'upcoming');
  assert.equal(schedulePhaseOf(task, { minutes: 1343 }), 'due', '到点即开始');
  assert.equal(schedulePhaseOf(task, { minutes: 1400 }), 'due');
  assert.equal(schedulePhaseOf(task, { minutes: 1413 }), 'overdue');
  assert.equal(schedulePhaseOf({ startMinutes: null, minutes: 30 }, { minutes: 600 }), 'upcoming');
});

/* ---------------- 注入健壮性 ---------------- */

test('注入：没有 iframe 或没有文档时安静失败，不抛错', () => {
  assert.equal(mountStudyTimerPanel(null), false);
  assert.equal(mountStudyTimerPanel({}), false);
  assert.equal(mountStudyTimerPanel({ contentDocument: null }), false);
  assert.equal(mountStudyTimerPanel({ get contentDocument() { throw new Error('cross-origin'); } }), false);
});
