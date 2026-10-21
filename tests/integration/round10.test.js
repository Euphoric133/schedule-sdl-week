/**
 * 计划开始时间（"希望从这个时间之后开始安排"）的精确性 + 短任务可排。
 *
 * 背景：之前有两个坑
 * 1. 任务总时长短于"最短时段"（默认 30 分钟）时，H6 校验把合法安排判成冲突，
 *    生成计划直接失败 —— 用户看到的是"填了 22:23 却什么都没排出来"。
 * 2. 因此需要确认：只要 22:23 之后放得下，时段就必须**正好**从 22:23 开始。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');
let domModulePromise = null;

async function getDomModule() {
  if (!domModulePromise) {
    domModulePromise = (async () => {
      const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
      const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
      const target = '/tmp/round10-fakedom.mjs';
      await writeFile(target, code);
      return import(target);
    })();
  }
  return domModulePromise;
}

async function withUi(fn) {
  const { installFakeDom } = await getDomModule();
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 13, 23) });
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app });
  } finally {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) delete globalThis[key];
  }
}

const NOW = { date: '2025-10-16', minutes: 13 * 60 + 23 };
const START_2223 = 22 * 60 + 23;

function taskInput(overrides = {}) {
  return {
    title: '晚自习',
    subject: '数学',
    plannedMinutes: 30,
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

/** 生成候选计划并取出学习时段 */
function planStudyBlocks(services) {
  const result = services.planService.requestPreview({ now: NOW });
  const pending = services.planService.getPendingPreview();
  const blocks = (pending?.candidate?.blocks ?? []).filter((block) => block.kind === 'study');
  return { result, blocks, pending };
}

test('计划开始时间：22:23 的任务必须正好从 22:23 开始', async () => {
  await withUi(async ({ services, app }) => {
    app.commit((state) => ({ ...state, tasks: [], sessions: [], officialPlan: null, pendingPreview: null }), { reason: 'clear' });
    services.taskService.addTask(taskInput({ plannedMinutes: 30, plannedStartMinutes: START_2223 }));

    const { result, blocks } = planStudyBlocks(services);
    assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));
    assert.equal(blocks.length, 1, '应排出一段学习时段');
    assert.equal(blocks[0].startMinutes, START_2223, '必须正好 22:23 开始，不能被取整或往后挪');
    assert.equal(blocks[0].endMinutes, START_2223 + 30);
  });
});

test('计划开始时间：短于"最短时段"的任务也能正常排（之前会被判冲突）', async () => {
  await withUi(async ({ services, app }) => {
    for (const minutes of [10, 15, 20, 25]) {
      app.commit((state) => ({ ...state, tasks: [], sessions: [], officialPlan: null, pendingPreview: null }), { reason: 'clear' });
      services.taskService.addTask(taskInput({ plannedMinutes: minutes, plannedStartMinutes: START_2223 }));

      const { result, blocks } = planStudyBlocks(services);
      assert.equal(result.ok, true, `${minutes} 分钟任务不应被判为冲突：${result.issues?.map((i) => i.message).join('; ')}`);
      assert.equal(blocks.length, 1, `${minutes} 分钟任务应排出一段`);
      assert.equal(blocks[0].startMinutes, START_2223, `${minutes} 分钟任务也应从 22:23 开始`);
      assert.equal(blocks[0].endMinutes - blocks[0].startMinutes, minutes);
    }
  });
});

test('计划开始时间：放不下时明确报告原因，而不是静默丢任务', async () => {
  await withUi(async ({ services, app }) => {
    app.commit((state) => ({ ...state, tasks: [], sessions: [], officialPlan: null, pendingPreview: null }), { reason: 'clear' });
    // 22:23 之后到 23:00 只剩 37 分钟，60 分钟放不下
    services.taskService.addTask(taskInput({ plannedMinutes: 60, plannedStartMinutes: START_2223 }));

    const { blocks, pending } = planStudyBlocks(services);
    assert.equal(blocks.length, 0, '放不下就不应排出学习时段');
    const unscheduled = pending?.unscheduled ?? [];
    assert.ok(unscheduled.length > 0, '必须有"未安排"记录，不能静默消失');
    assert.ok(unscheduled[0].reasonCode, '未安排记录必须有原因码');
    assert.ok(unscheduled[0].reasonText.length > 0, '原因必须能展示给用户');
  });
});

test('计划开始时间：没有填的任务仍按默认起点，不受别人的 22:23 影响', async () => {
  await withUi(async ({ services, app }) => {
    app.commit((state) => ({ ...state, tasks: [], sessions: [], officialPlan: null, pendingPreview: null }), { reason: 'clear' });
    services.taskService.addTask(taskInput({ title: '数学作业', plannedMinutes: 60, plannedStartMinutes: null }));
    services.taskService.addTask(taskInput({ title: '晚自习', plannedMinutes: 30, plannedStartMinutes: START_2223 }));

    const { result, blocks } = planStudyBlocks(services);
    assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));
    const evening = blocks.find((block) => block.startMinutes === START_2223);
    assert.ok(evening, '22:23 的任务应正好从 22:23 开始');
    const normal = blocks.find((block) => block.startMinutes < START_2223);
    assert.ok(normal, '没填开始时间的任务应仍排在更早的时间');
  });
});
