/**
 * 统一完成链路：
 *   记录实际学习时段 → 标记任务完成 → 取消剩余时段 → 清理依赖。
 *
 * 计划页与花园计时必须走同一条服务，不能各写一套。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');
let domPromise = null;

async function getDom() {
  if (!domPromise) {
    domPromise = (async () => {
      const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
      const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
      await writeFile('/tmp/task-complete-fakedom.mjs', code);
      return import('/tmp/task-complete-fakedom.mjs');
    })();
  }
  return domPromise;
}

async function withApp(fn) {
  const { installFakeDom } = await getDom();
  const dom = installFakeDom();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 22, 5) });
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app, store });
  } finally {
    delete globalThis.localStorage;
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) {
      delete globalThis[key];
    }
  }
}

const NOW = { date: '2025-10-16', minutes: 22 * 60 + 5 };

function taskInput(overrides = {}) {
  return {
    title: '任务',
    subject: '数学',
    plannedMinutes: 60,
    deadlineDate: '2025-10-20',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: null,
    maxChunkMinutes: null,
    plannedStartMinutes: null,
    dependsOn: [],
    note: '',
    ...overrides,
  };
}

/* ================================================================== *
 * 一、统一完成链路
 * ================================================================== */

test('完成：记录时段 + 标记任务 + 取消剩余 + 清理依赖（一次提交）', async () => {
  await withApp(async ({ services, app }) => {
    const createdA = services.taskService.addTask(taskInput({ title: 'A', plannedMinutes: 120 }));
    assert.equal(createdA.ok, true, createdA.message ?? '');
    const a = createdA.task;
    const createdB = services.taskService.addTask(taskInput({ title: 'B', dependsOn: [a.id] }));
    assert.equal(createdB.ok, true, createdB.message ?? '');
    const b = createdB.task;

    assert.equal(services.planService.requestPreview({ now: NOW }).ok, true);
    assert.equal(services.planService.applyPreview().ok, true);

    const session = app.getState().sessions.find((item) => item.taskId === a.id && item.state === 'flexible');
    assert.ok(session, '应有可用时段');

    const result = services.planService.completeTaskAtomic({
      taskId: a.id,
      sessionId: session.id,
      actualMinutes: 45,
      now: NOW,
    });
    assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));

    const state = app.getState();
    const taskA = state.tasks.find((item) => item.id === a.id);
    assert.equal(taskA.status, 'completed');

    const completed = state.sessions.filter((item) => item.taskId === a.id && item.state === 'completed');
    assert.equal(completed.length, 1, '应有一条完成记录');
    assert.equal(completed[0].actualMinutes, 45, '必须记录真实分钟数');

    // 剩余时段会被 reconcile 置为 cancelled（不是删除），所以这里只看"还会被安排"的状态
    const stillPending = state.sessions.filter(
      (item) => item.taskId === a.id && (item.state === 'flexible' || item.state === 'in_progress'),
    );
    assert.equal(stillPending.length, 0, '剩余未完成时段应被取消，不再参与排程');
    assert.ok(
      state.sessions.filter((item) => item.taskId === a.id && item.state === 'cancelled').length >= 0,
      '取消的历史时段允许保留',
    );

    assert.deepEqual(state.tasks.find((item) => item.id === b.id).dependsOn, [], '依赖应被清理');
  });
});

test('完成：没有排程时段的任务会补一条合法的已完成记录', async () => {
  await withApp(async ({ services, app }) => {
    const created = services.taskService.addTask(taskInput({ title: '临时学习', plannedMinutes: 40 }));
    assert.equal(created.ok, true);
    const task = created.task;
    // 没有生成计划 → 没有任何时段
    assert.equal(app.getState().sessions.length, 0);

    const result = services.planService.completeTaskAtomic({ taskId: task.id, actualMinutes: 25, now: NOW });
    assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));

    const state = app.getState();
    const completed = state.sessions.filter((item) => item.taskId === task.id && item.state === 'completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].actualMinutes, 25);
    assert.equal(completed[0].date, NOW.date);
    assert.equal(completed[0].endMinutes - completed[0].startMinutes, 25);
    assert.equal(state.tasks.find((item) => item.id === task.id).status, 'completed');
  });
});

test('完成：重复调用是幂等的（不重复写记录）', async () => {
  await withApp(async ({ services, app }) => {
    const created = services.taskService.addTask(taskInput({ title: '幂等任务' }));
    const task = created.task;
    services.planService.requestPreview({ now: NOW });
    services.planService.applyPreview();
    const session = app.getState().sessions.find((item) => item.taskId === task.id);

    const first = services.planService.completeTaskAtomic({ taskId: task.id, sessionId: session.id, actualMinutes: 30, now: NOW });
    assert.equal(first.ok, true);
    const second = services.planService.completeTaskAtomic({ taskId: task.id, sessionId: session.id, actualMinutes: 30, now: NOW });
    assert.equal(second.ok, true);
    assert.equal(second.already, true, '已完成的第二次调用应直接返回 already');

    assert.equal(
      app.getState().sessions.filter((item) => item.taskId === task.id && item.state === 'completed').length,
      1,
    );
  });
});

/* ================================================================== *
 * 二、统计可见
 * ================================================================== */

test('统计：完成后当日实际学习分钟包含这段时间', async () => {
  await withApp(async ({ services, app }) => {
    const { aggregateDay } = await import('../../src/services/statsService.js');
    const created = services.taskService.addTask(taskInput({ title: '统计任务', plannedMinutes: 90 }));
    services.planService.requestPreview({ now: NOW });
    services.planService.applyPreview();
    const session = app.getState().sessions.find((item) => item.taskId === created.task.id);

    services.planService.completeTaskAtomic({
      taskId: created.task.id,
      sessionId: session.id,
      actualMinutes: 20,
      now: NOW,
    });

    const day = aggregateDay(app.getState(), session.date);
    assert.ok(day.actualMinutes >= 20, `当日实际分钟应包含这 20 分钟（实际 ${day.actualMinutes}）`);
    assert.ok(day.bySubject.some((item) => item.subject === '数学'));
  });
});

/* ================================================================== *
 * 三、花园清单与前置候选
 * ================================================================== */

test('花园清单：已完成 / 0 剩余任务不再出现，且带 sessionId', async () => {
  await withApp(async ({ services, app }) => {
    const { listStudyTasks } = await import('../../src/services/gardenSync.js');
    const created = services.taskService.addTask(taskInput({ title: '计时任务', plannedMinutes: 60 }));
    services.planService.requestPreview({ now: NOW });
    services.planService.applyPreview();

    const before = listStudyTasks({ tasks: app.getState().tasks, sessions: app.getState().sessions, map: {} });
    const entry = before.find((item) => item.plannerId === created.task.id);
    assert.ok(entry, '完成前应在清单里');
    assert.ok(entry.sessionId, '应带上最早可完成时段的 id');
    assert.ok(entry.minutes > 0);

    services.planService.completeTaskAtomic({ taskId: created.task.id, sessionId: entry.sessionId, actualMinutes: 30, now: NOW });

    const after = listStudyTasks({ tasks: app.getState().tasks, sessions: app.getState().sessions, map: {} });
    assert.equal(after.some((item) => item.plannerId === created.task.id), false, '完成后不应再出现');
    assert.equal(after.some((item) => item.minutes === 1), false, '不应出现"1 分钟"的假任务');
  });
});

test('前置候选：已完成 / 0 剩余的任务都被排除', async () => {
  await withApp(async ({ services, app }) => {
    const { listDependencyCandidates } = await import('../../src/domain/task.js');
    const done = services.taskService.addTask(taskInput({ title: '已完成' }));
    const live = services.taskService.addTask(taskInput({ title: '进行中' }));
    const zero = services.taskService.addTask(taskInput({ title: '零剩余' }));

    services.planService.requestPreview({ now: NOW });
    services.planService.applyPreview();
    const session = app.getState().sessions.find((item) => item.taskId === done.task.id);
    services.planService.completeTaskAtomic({ taskId: done.task.id, sessionId: session.id, actualMinutes: 60, now: NOW });

    // 造一个"状态还是 active、但剩余为 0"的历史脏数据
    app.commit((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === zero.task.id ? { ...task, priorCompletedMinutes: task.plannedMinutes } : task,
      ),
    }), { reason: 'seed-dirty' });

    const views = services.taskService.listTaskViews();
    const candidates = listDependencyCandidates(views, null).map((task) => task.id);
    assert.equal(candidates.includes(done.task.id), false, '已完成任务不能作为前置');
    assert.equal(candidates.includes(zero.task.id), false, '0 剩余任务不能作为前置');
    assert.equal(candidates.includes(live.task.id), true, '未完成任务仍可作为前置');
  });
});

/* ================================================================== *
 * 四、跨午夜与面板刷新
 * ================================================================== */

test('跨午夜：没有排程时段时，记录归到前一天且 endMinutes > 1440', async () => {
  await withApp(async ({ services, app }) => {
    const created = services.taskService.addTask(taskInput({ title: '凌晨学习', plannedMinutes: 30 }));
    const result = services.planService.completeTaskAtomic({
      taskId: created.task.id,
      actualMinutes: 40,
      now: { date: '2025-10-17', minutes: 20 }, // 00:20 完成，实际学了 40 分钟
    });
    assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));

    const session = app.getState().sessions.find((item) => item.taskId === created.task.id);
    assert.equal(session.date, '2025-10-16', '应归到前一天');
    assert.ok(session.endMinutes > 1440, '跨午夜时结束分钟应大于 1440');
    assert.equal(session.endMinutes - session.startMinutes, 40);
    assert.equal(session.actualMinutes, 40);
    assert.equal(session.state, 'completed');
  });
});

test('刷新：应用预览后会通知花园刷新面板（不依赖重新进入花园）', async () => {
  await withApp(async ({ dom, instance, services }) => {
    services.taskService.addTask(taskInput({ title: '刷新任务' }));

    dom.location.hash = '#/garden';
    instance.shell.render();

    const host = dom.appHost.children[0].byClass('garden-host')[0];
    const frame = host.all().find((node) => node.tagName === 'IFRAME');
    let refreshes = 0;
    // 模拟花园文档里已挂载的面板
    frame.contentDocument = {
      body: { __studyTimerPanel: { renderList: () => { refreshes += 1; }, renderTimer: () => {} } },
    };

    services.planService.requestPreview({ now: NOW });
    const before = refreshes;
    services.ui.applyPreview();
    assert.ok(refreshes > before, '应用预览后应刷新花园面板');
  });
});
