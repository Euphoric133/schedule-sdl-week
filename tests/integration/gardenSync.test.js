/**
 * 主应用 ↔ 专注花园 的数据联动测试。
 *
 * 这里用一个**假桥**模拟花园的 dispatch/getState，
 * 验证：任务同步的增/改/完成、自动开始计时的动作顺序、不抢占用户已开的计时、
 * 番茄数的读取，以及桥不可用时的降级行为。
 *
 * 注意：这些测试验证的是"联动协议与逻辑"，不是花园渲染本身；
 * 花园内部行为（完成时 +1 番茄）由它自己的代码保证，这里只读结果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoStartFocus,
  loadTaskMap,
  pomodorosByPlannerTask,
  readGardenSnapshot,
  saveTaskMap,
  syncTasksToGarden,
  toGardenDraft,
  waitForBridge,
} from '../../src/services/gardenSync.js';

/* ---------------- 测试替身 ---------------- */

/** 造一个假花园：记录 dispatch 调用，维护 tasks/timer */
function makeFakeGarden({ tasks = [], timer = {} } = {}) {
  const calls = [];
  const state = {
    tasks: [...tasks],
    timer: { status: 'idle', phase: 'focus', activeTaskId: null, targetAt: null, plannedSeconds: 0, ...timer },
  };
  let nextId = 1;
  const bridge = {
    getState: () => state,
    dispatch: (action) => {
      calls.push(action);
      if (action.type === 'task/create') {
        const draft = action.draft ?? {};
        state.tasks = [
          ...state.tasks,
          {
            id: `garden-${nextId++}`,
            name: draft.name ?? '',
            category: draft.category ?? '默认',
            estimatePomodoros: draft.estimatePomodoros ?? 1,
            completedPomodoros: 0,
            status: 'active',
            dueDate: draft.dueDate ?? null,
            plannedDate: draft.plannedDate ?? null,
          },
        ];
      }
      if (action.type === 'task/update') {
        state.tasks = state.tasks.map((task) => (task.id === action.id ? { ...task, ...action.patch } : task));
      }
      if (action.type === 'timer/reset') state.timer = { ...state.timer, status: 'idle', activeTaskId: null };
      if (action.type === 'timer/select-task') state.timer = { ...state.timer, activeTaskId: action.taskId };
      if (action.type === 'timer/start') state.timer = { ...state.timer, status: 'running', targetAt: (action.now ?? 0) + 1500_000 };
    },
  };
  return { bridge, state, calls };
}

const noSleep = async () => {};

/** 装一个内存版 localStorage（映射表需要持久化才可验证） */
function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

function clearStorage() {
  delete globalThis.localStorage;
}

const PLANNER_TASK = {
  id: 'tsk_1',
  title: '数学作业',
  subject: '数学',
  plannedMinutes: 50,
  importance: 4,
  deadlineDate: '2025-10-21',
  deadlineTime: '23:00',
  status: 'not_started',
};

/* ---------------- 字段映射 ---------------- */

test('映射：主应用任务被转成花园认识的字段', () => {
  const draft = toGardenDraft(PLANNER_TASK);
  assert.equal(draft.name, '数学作业');
  assert.equal(draft.category, '数学');
  assert.equal(draft.priority, 'high', '重要度 4 应映射为 high');
  assert.equal(draft.estimatePomodoros, 2, '50 分钟按 25 分钟/番茄折算为 2');
  assert.equal(draft.dueDate, '2025-10-21');
  assert.ok(!('note' in draft), '不应把备注等无关字段带过去');
});

test('映射：没有科目的任务用默认分类，名称过长会被截断', () => {
  const draft = toGardenDraft({ title: '一'.repeat(60), plannedMinutes: 10 });
  assert.equal(draft.category, '默认');
  assert.equal(draft.name.length, 40);
  assert.equal(draft.estimatePomodoros, 1, '10 分钟至少算 1 个番茄');
});

/* ---------------- 任务同步 ---------------- */

test('同步：首次把任务建进花园，并记下 id 映射', async () => {
  installStorage();
  const { bridge, state } = makeFakeGarden();
  const result = await syncTasksToGarden({ bridge, tasks: [PLANNER_TASK], map: {}, sleep: noSleep });

  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].name, '数学作业');
  assert.deepEqual(Object.keys(loadTaskMap()), ['tsk_1'], '应持久化映射，避免下次重复创建');
  clearStorage();
});

test('同步：已映射的任务再次同步时只更新，不重复创建', async () => {
  installStorage();
  const { bridge, state } = makeFakeGarden();
  await syncTasksToGarden({ bridge, tasks: [PLANNER_TASK], map: {}, sleep: noSleep });

  const second = await syncTasksToGarden({
    bridge,
    tasks: [{ ...PLANNER_TASK, title: '数学作业（改）', plannedMinutes: 75 }],
    map: loadTaskMap(),
    sleep: noSleep,
  });

  assert.equal(second.created, 0, '不应再创建');
  assert.equal(second.updated, 1);
  assert.equal(state.tasks.length, 1, '花园里仍只有一个任务');
  assert.equal(state.tasks[0].name, '数学作业（改）');
  assert.equal(state.tasks[0].estimatePomodoros, 3);
  clearStorage();
});

test('同步：主应用里完成的任务，在花园里标记为 done（保留其专注记录）', async () => {
  installStorage();
  const { bridge, state } = makeFakeGarden();
  await syncTasksToGarden({ bridge, tasks: [PLANNER_TASK], map: {}, sleep: noSleep });

  const result = await syncTasksToGarden({
    bridge,
    tasks: [{ ...PLANNER_TASK, status: 'completed' }],
    map: loadTaskMap(),
    sleep: noSleep,
  });

  assert.equal(result.done, 1);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks.length, 1, '不应删除任务（否则会丢掉它的番茄记录）');
  clearStorage();
});

test('同步：桥不可用时返回原因，不抛错', async () => {
  const result = await syncTasksToGarden({ bridge: null, tasks: [PLANNER_TASK] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-bridge');
});

/* ---------------- 自动开始计时 ---------------- */

test('任务名：计划开始时间会显示在花园任务名里（22:23 晚自习）', async () => {
  const { toGardenDraft, formatStartLabel } = await import('../../src/services/gardenSync.js');
  assert.equal(formatStartLabel({ plannedStartMinutes: 1343 }), '22:23');
  assert.equal(formatStartLabel({ plannedStartMinutes: null }), '');
  assert.equal(toGardenDraft({ ...PLANNER_TASK, plannedStartMinutes: 1343 }).name, '22:23 数学作业');
  assert.equal(toGardenDraft(PLANNER_TASK).name, '数学作业', '没设开始时间就不加前缀');
});

test('自动开始：按任务时长设置专注时长（70 分钟任务 = 70 分钟计时器）', () => {
  const { bridge, calls } = makeFakeGarden();
  autoStartFocus({ bridge, gardenTaskId: 'garden-1', minutes: 70, now: 1000 });

  const settingsCall = calls.find((call) => call.type === 'settings/update');
  assert.ok(settingsCall, '应先改专注时长');
  assert.equal(settingsCall.patch.focusMinutes, 70);
  assert.deepEqual(
    calls.map((call) => call.type),
    ['settings/update', 'timer/reset', 'timer/select-task', 'timer/start'],
    '顺序：先改时长，再 reset → select → start',
  );
});

test('自动开始：动作顺序必须是 reset → select-task → start', () => {
  const { bridge, calls } = makeFakeGarden();
  const result = autoStartFocus({ bridge, gardenTaskId: 'garden-1', now: 1000 });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.type), ['timer/reset', 'timer/select-task', 'timer/start']);
  assert.equal(calls[1].taskId, 'garden-1');
  assert.equal(calls[2].now, 1000);
});

test('自动开始：不抢占用户自己开的、正在跑的其他任务', () => {
  const { bridge, calls } = makeFakeGarden({ timer: { status: 'running', activeTaskId: 'garden-9' } });
  const result = autoStartFocus({ bridge, gardenTaskId: 'garden-1' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'busy');
  assert.equal(calls.length, 0, '不应打断用户正在进行的专注');
});

test('自动开始：已经在专注同一任务时不重复启动', () => {
  const { bridge, calls } = makeFakeGarden({ timer: { status: 'running', activeTaskId: 'garden-1' } });
  const result = autoStartFocus({ bridge, gardenTaskId: 'garden-1' });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-running');
  assert.equal(calls.length, 0);
});

/* ---------------- 番茄数读取 ---------------- */

test('番茄数：从花园自己的存储里读出每个主应用任务的完成数', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  store.set('studyPlanner:v1:gardenMap', JSON.stringify({ tsk_1: 'garden-1', tsk_2: 'garden-2' }));
  store.set(
    'focus-garden/tasks',
    JSON.stringify([
      { id: 'garden-1', name: '数学作业', completedPomodoros: 3 },
      { id: 'garden-2', name: '英语', completedPomodoros: 0 },
    ]),
  );
  store.set('focus-garden/sessions', JSON.stringify([{ id: 's1', phase: 'focus', outcome: 'completed' }]));

  try {
    const counts = pomodorosByPlannerTask(loadTaskMap());
    assert.deepEqual(counts, { tsk_1: 3, tsk_2: 0 });

    const snapshot = readGardenSnapshot();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.tasks.length, 2);
    assert.equal(snapshot.sessions.length, 1);
  } finally {
    delete globalThis.localStorage;
  }
});

test('番茄数：存储损坏或缺失时安全降级为空，不影响页面', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: () => {},
    removeItem: () => {},
  };
  store.set('focus-garden/tasks', '{ 坏掉的 json');
  try {
    assert.deepEqual(readGardenSnapshot(), { tasks: [], sessions: [], available: false });
    assert.deepEqual(pomodorosByPlannerTask({}), {});
  } finally {
    delete globalThis.localStorage;
  }
});

test('映射：损坏的映射表被忽略，只保留合法的字符串对', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ a: 'g1', b: 123, c: '', d: 'g4' }),
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    assert.deepEqual(loadTaskMap(), { a: 'g1', d: 'g4' });
    assert.equal(saveTaskMap({ x: 'g5' }), true);
  } finally {
    delete globalThis.localStorage;
  }
});

/* ---------------- 等桥就绪 ---------------- */

test('等桥：桥出现后立即返回；超时返回 null', async () => {
  const frame = { contentWindow: {} };
  let tries = 0;
  const sleep = async () => {
    tries += 1;
    if (tries === 2) frame.contentWindow.__focusGardenBridge = { getState: () => ({}), dispatch: () => {} };
  };
  const bridge = await waitForBridge(frame, { timeoutMs: 1000, intervalMs: 1, sleep });
  assert.ok(bridge, '桥出现后应返回它');

  const missing = await waitForBridge({ contentWindow: {} }, { timeoutMs: 0, intervalMs: 1, sleep: noSleep });
  assert.equal(missing, null, '超时应返回 null 而不是抛错');
});

/* ================================================================== *
 * 完成学习任务 → 发放转盘机会
 * ================================================================== */

function installGrantStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

test('发放机会：第一次完成 +1，同一任务重复完成不再加', async () => {
  installGrantStorage();
  try {
    const { grantStudyTaskSpin } = await import('../../src/services/gardenSync.js');
    const calls = [];
    const bridge = { getState: () => ({ tasks: [], timer: {} }), dispatch: (action) => calls.push(action) };

    const first = grantStudyTaskSpin({ bridge, plannerId: 't1' });
    assert.equal(first.ok, true);
    assert.equal(calls.filter((call) => call.type === 'spin/grant').length, 1);

    const second = grantStudyTaskSpin({ bridge, plannerId: 't1' });
    assert.equal(second.ok, true);
    assert.equal(second.already, true, '同一任务只发一次');
    assert.equal(calls.filter((call) => call.type === 'spin/grant').length, 1);

    const other = grantStudyTaskSpin({ bridge, plannerId: 't2' });
    assert.equal(other.ok, true);
    assert.equal(calls.filter((call) => call.type === 'spin/grant').length, 2, '不同任务各发一次');
  } finally {
    delete globalThis.localStorage;
  }
});

test('发放机会：桥不可用返回结构化失败，且不写发放记录', async () => {
  installGrantStorage();
  try {
    const { grantStudyTaskSpin, loadSpinGrants } = await import('../../src/services/gardenSync.js');
    const result = grantStudyTaskSpin({ bridge: null, plannerId: 't1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-bridge');
    assert.deepEqual(loadSpinGrants(), [], '失败时不能记成"已发放"，否则机会永久丢失');
  } finally {
    delete globalThis.localStorage;
  }
});

test('发放机会：完成回写带 grantSpin 时，同一个任务只发一次', async () => {
  installGrantStorage();
  try {
    const { completeStudyTask } = await import('../../src/services/gardenSync.js');
    const calls = [];
    const state = { tasks: [{ id: 'g1', status: 'active', completedPomodoros: 0 }], timer: {} };
    const bridge = {
      getState: () => state,
      dispatch: (action) => {
        calls.push(action);
        if (action.type === 'task/update') {
          state.tasks = state.tasks.map((task) => (task.id === action.id ? { ...task, ...action.patch } : task));
        }
      },
    };
    const taskService = {
      status: 'not_started',
      changeTaskStatus(id, to) {
        if (this.status === to) return { ok: false, code: 'already_completed' };
        this.status = to;
        return { ok: true };
      },
    };

    completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', grantSpin: true });
    assert.equal(calls.filter((call) => call.type === 'spin/grant').length, 1);

    completeStudyTask({ bridge, taskService, plannerId: 't1', gardenId: 'g1', grantSpin: true });
    assert.equal(calls.filter((call) => call.type === 'spin/grant').length, 1, '重复完成不得再发');
  } finally {
    delete globalThis.localStorage;
  }
});
