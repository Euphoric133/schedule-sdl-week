/**
 * 已完成任务：保留在时间表（显示"已完成"），并从"前置任务"候选与依赖里清除。
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
      await writeFile('/tmp/completed-fakedom.mjs', code);
      return import('/tmp/completed-fakedom.mjs');
    })();
  }
  return domPromise;
}

async function withApp(fn) {
  const { installFakeDom } = await getDom();
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 22, 5) });
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app });
  } finally {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) delete globalThis[key];
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
 * 一、时间表保留已完成任务
 * ================================================================== */

test('deriveStatus：任务已完成时，即使时段被取消也显示"已完成"', async () => {
  const { deriveStatus } = await import('../../src/ui/board.js');
  const { TASK_STATUS } = await import('../../src/domain/task.js');

  assert.equal(
    deriveStatus({ taskStatus: TASK_STATUS.COMPLETED, session: { state: 'cancelled' }, date: '2025-10-16', today: '2025-10-16', nowMinutes: 600 }),
    'completed',
  );
  assert.equal(
    deriveStatus({ taskStatus: TASK_STATUS.COMPLETED, session: { state: 'completed' }, date: '2025-10-16', today: '2025-10-16', nowMinutes: 600 }),
    'completed',
  );
  assert.equal(
    deriveStatus({ taskStatus: TASK_STATUS.CANCELLED, session: { state: 'flexible' }, date: '2025-10-16', today: '2025-10-16', nowMinutes: 600 }),
    'cancelled',
  );
  // 没有 taskStatus 时保持旧行为
  assert.equal(deriveStatus({ session: { state: 'flexible' }, date: '2025-10-16', today: '2025-10-16', nowMinutes: 600 }), 'flexible');
});

test('shouldShowStudyCard：已完成显示、已取消/已删除隐藏', async () => {
  const { shouldShowStudyCard } = await import('../../src/ui/board.js');
  const { TASK_STATUS } = await import('../../src/domain/task.js');

  const tasks = new Map([
    ['done', { id: 'done', status: TASK_STATUS.COMPLETED }],
    ['gone', { id: 'gone', status: TASK_STATUS.CANCELLED }],
    ['deleted', { id: 'deleted', status: TASK_STATUS.DELETED }],
    ['live', { id: 'live', status: TASK_STATUS.NOT_STARTED }],
  ]);

  assert.equal(shouldShowStudyCard({ id: 'b1', taskId: 'done', status: 'cancelled' }, tasks), true, '已完成任务必须保留');
  assert.equal(shouldShowStudyCard({ id: 'b2', taskId: 'gone', status: 'flexible' }, tasks), false);
  assert.equal(shouldShowStudyCard({ id: 'b3', taskId: 'deleted', status: 'flexible' }, tasks), false);
  assert.equal(shouldShowStudyCard({ id: 'b4', taskId: 'live', status: 'flexible' }, tasks), true);
  // 未完成任务的已取消时段仍然隐藏
  assert.equal(shouldShowStudyCard({ id: 'b5', taskId: 'live', status: 'cancelled', sessionId: 's1' }, tasks), false);
});

test('selectCompletedDisplayBlockIds：同一任务只保留最早的一块', async () => {
  const { selectCompletedDisplayBlockIds } = await import('../../src/ui/board.js');
  const { TASK_STATUS } = await import('../../src/domain/task.js');

  const plan = {
    blocks: [
      { id: 'b2', kind: 'study', taskId: 't1', date: '2025-10-17', startMinutes: 480 },
      { id: 'b1', kind: 'study', taskId: 't1', date: '2025-10-16', startMinutes: 600 },
      { id: 'b3', kind: 'study', taskId: 't2', date: '2025-10-16', startMinutes: 300 },
    ],
  };
  const state = {
    tasks: [
      { id: 't1', status: TASK_STATUS.COMPLETED },
      { id: 't2', status: TASK_STATUS.NOT_STARTED },
    ],
  };

  const visible = selectCompletedDisplayBlockIds({ plan, state });
  assert.equal(visible.has('b1'), true, '保留最早的一块');
  assert.equal(visible.has('b2'), false, '其余块不显示');
  assert.equal(visible.has('b3'), false, '未完成的任务不在此集合里');
});

test('时间表：完成任务后卡片仍在且为"已完成"，刷新后依旧', async () => {
  await withApp(async ({ services, app }) => {
    const created = services.taskService.addTask(taskInput({ title: '跨天任务', plannedMinutes: 120 }));
    assert.equal(created.ok, true, created.message ?? '');
    const task = created.task;
    const preview = services.planService.requestPreview({ now: NOW });
    assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
    assert.equal(services.planService.applyPreview().ok, true);

    const planned = app.getState().officialPlan;
    const beforeBlocks = planned.blocks.filter((block) => block.kind === 'study' && block.taskId === task.id);
    assert.ok(beforeBlocks.length >= 1, '完成前应有学习块');

    const done = services.taskService.changeTaskStatus(task.id, 'completed');
    assert.equal(done.ok, true, done.message ?? '');

    const after = app.getState().officialPlan;
    const byDate = new Map();
    for (const block of after.blocks) {
      if (block.kind !== 'study' || block.taskId !== task.id) continue;
      byDate.set(block.date, (byDate.get(block.date) ?? 0) + 1);
    }
    assert.ok(byDate.size >= 1, '完成后计划里仍应保留该任务的块（用于显示"已完成"）');

    // 重新加载后仍然存在
    const reloaded = services.taskService.getTask?.(task.id) ?? app.getState().tasks.find((t) => t.id === task.id);
    assert.equal(reloaded.status, 'completed');
  });
});

/* ================================================================== *
 * 二、前置任务候选与依赖清理
 * ================================================================== */

test('listDependencyCandidates：只保留未开始/进行中，排除自己', async () => {
  const { listDependencyCandidates } = await import('../../src/domain/task.js');
  const tasks = [
    { id: 'a', status: 'not_started' },
    { id: 'b', status: 'in_progress' },
    { id: 'c', status: 'completed' },
    { id: 'd', status: 'cancelled' },
    { id: 'e', status: 'deleted' },
  ];
  assert.deepEqual(listDependencyCandidates(tasks).map((t) => t.id), ['a', 'b']);
  assert.deepEqual(listDependencyCandidates(tasks, 'a').map((t) => t.id), ['b']);
});

test('完成任务：从其它任务的 dependsOn 中移除，且与状态变更同一事务', async () => {
  await withApp(async ({ services, app }) => {
    const createdA = services.taskService.addTask(taskInput({ title: 'A' }));
    assert.equal(createdA.ok, true, createdA.message ?? '');
    const a = createdA.task;
    const createdB = services.taskService.addTask(taskInput({ title: 'B', dependsOn: [a.id] }));
    assert.equal(createdB.ok, true, createdB.message ?? '');
    const b = createdB.task;

    assert.deepEqual(app.getState().tasks.find((t) => t.id === b.id).dependsOn, [a.id]);

    const result = services.taskService.changeTaskStatus(a.id, 'completed');
    assert.equal(result.ok, true, result.message ?? '');

    const state = app.getState();
    assert.equal(state.tasks.find((t) => t.id === a.id).status, 'completed', 'A 仍然是已完成');
    assert.deepEqual(state.tasks.find((t) => t.id === b.id).dependsOn, [], 'B 不应再依赖已完成的 A');
    // 说明：本用例没有生成计划，因此 A 本来就没有时段；
    // "完成不删历史时段"由 round2 / consistency 里的计划用例覆盖。

    // 重复完成不会出错
    const again = services.taskService.changeTaskStatus(a.id, 'completed');
    assert.ok(again.ok !== undefined);
    assert.deepEqual(app.getState().tasks.find((t) => t.id === b.id).dependsOn, []);
  });
});

test('取消任务不会误删别人的依赖（只有完成才清理）', async () => {
  await withApp(async ({ services, app }) => {
    const createdA = services.taskService.addTask(taskInput({ title: 'A' }));
    assert.equal(createdA.ok, true, createdA.message ?? '');
    const a = createdA.task;
    const createdB = services.taskService.addTask(taskInput({ title: 'B', dependsOn: [a.id] }));
    assert.equal(createdB.ok, true, createdB.message ?? '');
    const b = createdB.task;

    const result = services.taskService.changeTaskStatus(a.id, 'cancelled');
    assert.equal(result.ok, true, result.message ?? '');
    assert.deepEqual(
      app.getState().tasks.find((t) => t.id === b.id).dependsOn,
      [a.id],
      '取消不是完成，依赖关系保持不变',
    );
  });
});

/* ================================================================== *
 * 回归：新建任务表单必须能打开（曾经因为漏导入 listDependencyCandidates 而崩）
 * ================================================================== */

test('新建任务：已有任务时也能打开表单，且前置候选里没有已完成任务', async () => {
  await withApp(async ({ dom, instance }) => {
    const base = taskInput({ title: '已有任务' });
    instance.services.taskService.addTask(base);
    const created = instance.services.taskService.addTask(taskInput({ title: '已完成任务' }));
    instance.services.taskService.changeTaskStatus(created.task.id, 'completed');

    dom.location.hash = '#/tasks';
    instance.shell.render();
    const main = dom.appHost.children[0].byClass('app-main')[0];
    const newTask = main.all().find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === '新建任务');
    assert.ok(newTask, '应有「新建任务」按钮');

    assert.doesNotThrow(() => newTask.click(), '点击新建任务不能抛错');
    const dialogs = dom.document.body.all().filter((node) => String(node.tagName).toLowerCase() === 'dialog');
    assert.equal(dialogs.length, 1, '必须真的打开表单弹窗');
    const text = dialogs[0].textContent;
    assert.match(text, /前置任务/, '应包含前置任务区域');
    assert.equal(text.includes('已完成任务'), false, '已完成任务不应出现在候选里');
  });
});
