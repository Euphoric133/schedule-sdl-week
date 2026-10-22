/**
 * 需求 B 验收：计时数据口径、排序、完成回写与幂等。
 *
 * 全部使用固定数据与假桥，不依赖真实时间/网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { completeStudyTask, listStudyTasks } from '../../src/services/gardenSync.js';

/** 造一个假花园（记录 dispatch、维护任务表） */
function makeFakeGarden(tasks = []) {
  const calls = [];
  const state = { tasks: tasks.map((task) => ({ ...task })), timer: { status: 'idle', phase: 'focus', activeTaskId: null } };
  const bridge = {
    getState: () => state,
    dispatch: (action) => {
      calls.push(action);
      if (action.type === 'task/update') {
        state.tasks = state.tasks.map((task) => (task.id === action.id ? { ...task, ...action.patch } : task));
      }
    },
  };
  return { bridge, state, calls };
}

function makeTask(overrides = {}) {
  return { id: 't1', title: '两小时项目', status: 'not_started', plannedMinutes: 120, priorCompletedMinutes: 0, importance: 3, ...overrides };
}

/* ================================================================== *
 * 清单与时长口径（B-01 ~ B-08）
 * ================================================================== */

test('B-01 无已完成记录时，计时时长 = 任务计划时长（2 小时 = 120 分钟）', () => {
  const list = listStudyTasks({ tasks: [makeTask()], sessions: [], map: {} });
  assert.equal(list.length, 1);
  assert.equal(list[0].minutes, 120);
});

test('B-02 已填 30 分钟已完成时，剩余 90 分钟', () => {
  const list = listStudyTasks({ tasks: [makeTask({ priorCompletedMinutes: 30 })], sessions: [], map: {} });
  assert.equal(list[0].minutes, 90);
});

test('B-03 已有 45 分钟的已完成时段，剩余 75 分钟', () => {
  const sessions = [{ taskId: 't1', date: '2025-10-16', startMinutes: 480, endMinutes: 525, state: 'completed' }];
  const list = listStudyTasks({ tasks: [makeTask()], sessions, map: {} });
  assert.equal(list[0].minutes, 75);
});

test('B-04 未完成的排程片段不能缩短计时时长（4 段 30 分钟仍是 120 分钟）', () => {
  const sessions = [
    { taskId: 't1', date: '2025-10-16', startMinutes: 1343, endMinutes: 1373, state: 'flexible' },
    { taskId: 't1', date: '2025-10-16', startMinutes: 1373, endMinutes: 1403, state: 'flexible' },
    { taskId: 't1', date: '2025-10-17', startMinutes: 1343, endMinutes: 1373, state: 'flexible' },
    { taskId: 't1', date: '2025-10-17', startMinutes: 1373, endMinutes: 1403, state: 'flexible' },
  ];
  const list = listStudyTasks({ tasks: [makeTask()], sessions, map: {} });
  assert.equal(list[0].minutes, 120);
  assert.equal(list[0].startMinutes, 1343, '开始时间取最早的一段');
});

test('B-05 40 分钟任务已完成 10 分钟 → 30 分钟，开始时间取最早未完成片段', () => {
  const sessions = [
    { taskId: 't1', date: '2025-10-16', startMinutes: 400, endMinutes: 410, state: 'completed' },
    { taskId: 't1', date: '2025-10-16', startMinutes: 600, endMinutes: 620, state: 'flexible' },
  ];
  const list = listStudyTasks({ tasks: [makeTask({ plannedMinutes: 40 })], sessions, map: {} });
  assert.equal(list[0].minutes, 30);
  assert.equal(list[0].startMinutes, 600);
});

test('B-06 排序：有时间按时间升序在前，同时间按重要度降序，再按标题/id', () => {
  const tasks = [
    { id: 'b', title: 'B', status: 'not_started', plannedMinutes: 30, importance: 3, priorCompletedMinutes: 0 },
    { id: 'a', title: 'A', status: 'not_started', plannedMinutes: 30, importance: 1, priorCompletedMinutes: 0 },
    { id: 'c', title: 'C', status: 'not_started', plannedMinutes: 30, importance: 5, priorCompletedMinutes: 0 },
    { id: 'n', title: 'N', status: 'not_started', plannedMinutes: 30, importance: 9, priorCompletedMinutes: 0 },
  ];
  const sessions = [
    { taskId: 'b', date: '2025-10-16', startMinutes: 1343, endMinutes: 1373, state: 'flexible' },
    { taskId: 'a', date: '2025-10-16', startMinutes: 1260, endMinutes: 1290, state: 'flexible' },
    { taskId: 'c', date: '2025-10-16', startMinutes: 1343, endMinutes: 1373, state: 'flexible' },
  ];
  const list = listStudyTasks({ tasks, sessions, map: {} });
  assert.deepEqual(list.map((item) => item.plannerId), ['a', 'c', 'b', 'n']);
});

test('B-07 已完成 / 已取消 / 已删除的任务不出现', () => {
  const tasks = [
    makeTask({ id: 'x', status: 'completed' }),
    makeTask({ id: 'y', status: 'cancelled' }),
    makeTask({ id: 'z', status: 'deleted' }),
    makeTask({ id: 'ok', status: 'in_progress' }),
  ];
  const list = listStudyTasks({ tasks, sessions: [], map: {} });
  assert.deepEqual(list.map((item) => item.plannerId), ['ok']);
});

test('B-08 没有排程时段时 startMinutes 为 null，但仍然出现在清单里', () => {
  const list = listStudyTasks({ tasks: [makeTask({ plannedMinutes: 70, priorCompletedMinutes: 20 })], sessions: [], map: {} });
  assert.equal(list.length, 1);
  assert.equal(list[0].startMinutes, null);
  assert.equal(list[0].minutes, 50);
});

/* ================================================================== *
 * 完成回写与幂等（B-15 ~ B-21）
 * ================================================================== */

function makeTaskService(initial = { status: 'not_started' }) {
  const task = { id: 't1', title: '两小时项目', ...initial };
  return {
    task,
    changeTaskStatus(id, to) {
      if (task.status === to) return { ok: false, code: 'already_completed' };
      task.status = to;
      return { ok: true, task };
    },
  };
}

test('B-15 计时完成：规划器完成、花园 done、番茄 +1，只派发一次', () => {
  const { bridge, state, calls } = makeFakeGarden([{ id: 'g1', status: 'active', completedPomodoros: 2 }]);
  const taskService = makeTaskService();

  const result = completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', actualMinutes: 10 });

  assert.equal(result.ok, true);
  assert.equal(taskService.task.status, 'completed');
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].completedPomodoros, 3);
  assert.equal(calls.filter((call) => call.type === 'task/update').length, 1);
});

test('B-16 重复调用不会重复加番茄', () => {
  const { bridge, state, calls } = makeFakeGarden([{ id: 'g1', status: 'active', completedPomodoros: 2 }]);
  const taskService = makeTaskService();

  completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', actualMinutes: 10 });
  const second = completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', actualMinutes: 10 });

  assert.equal(second.ok, true);
  assert.equal(state.tasks[0].completedPomodoros, 3, '不得加两次');
  assert.equal(calls.filter((call) => call.type === 'task/update').length, 1);
});

test('B-17 放弃本次：不调用完成逻辑时数据完全不变', () => {
  const { bridge, state } = makeFakeGarden([{ id: 'g1', status: 'active', completedPomodoros: 2 }]);
  const taskService = makeTaskService();

  // 放弃 = 不调用 completeStudyTask
  assert.equal(taskService.task.status, 'not_started');
  assert.equal(state.tasks[0].status, 'active');
  assert.equal(state.tasks[0].completedPomodoros, 2);
  void bridge;
});

test('B-18 花园里找不到映射任务时，仍然完成规划器任务且不抛错', () => {
  const { bridge, calls } = makeFakeGarden([]);
  const taskService = makeTaskService();

  const result = completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g-missing' });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-garden-task');
  assert.equal(taskService.task.status, 'completed');
  assert.equal(calls.length, 0);
});

test('B-19 桥不可用时返回结构化失败，不抛异常', () => {
  const taskService = makeTaskService();
  const result = completeStudyTask({ bridge: null, taskService, plannerId: 't1', gardenId: 'g1' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-bridge');
  assert.equal(taskService.task.status, 'completed', '主应用仍然完成，不丢用户操作');
});

test('B-21 计时实际只专注 10 分钟，任务仍按完成处理', () => {
  const { bridge, state } = makeFakeGarden([{ id: 'g1', status: 'active', completedPomodoros: 0 }]);
  const taskService = makeTaskService();

  const result = completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', actualMinutes: 10 });

  assert.equal(result.ok, true);
  assert.equal(taskService.task.status, 'completed');
  assert.equal(state.tasks[0].completedPomodoros, 1);
});
