/**
 * 第四轮回归测试。
 *
 * 覆盖：
 * 1. 计划不再无故延迟到 16:00（旧的"每天 7 小时"默认窗口）
 * 2. 截止时间真正约束排程
 * 3. 完成/删除的任务从普通任务列表消失，但仍保留在计划与统计里
 * 4. 可选字段：计划开始时间、已完成分钟、最短/最长学习时段
 * 5. 主题只剩浅色与深色，旧 `system` 值安全兼容
 * 6. 自动生成预览开关的两种行为
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTestApp, taskInput } from '../helpers/app.js';
import { engineContext } from '../helpers/engine.js';
import { defaultSettings } from '../../src/domain/schemas.js';
import { TASK_STATUS, claimedPriorMinutes, createTask, createTaskDraft, validateTask } from '../../src/domain/task.js';
import { createIdFactory } from '../../src/domain/ids.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { THEME, defaultPreferences, loadPreferences, normalizeTheme } from '../../src/services/preferences.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const MORNING = { date: '2025-10-16', minutes: 8 * 60 };

/* ================================================================== *
 * 一、16:00 延迟
 * ================================================================== */

test('排程：默认窗口不再是 16:00–23:00（每天 7 小时的遗留限制）', () => {
  const windows = defaultSettings().studyWindows;
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    const spans = windows[day];
    assert.equal(spans.length, 1);
    assert.ok(spans[0].startMinutes <= 8 * 60, `第 ${day} 天不应晚于 08:00 才开始：${spans[0].startMinutes}`);
    assert.ok(spans[0].endMinutes - spans[0].startMinutes > 7 * 60, '默认窗口不应只有 7 小时');
  }
  // 每天 7 小时 = 每周 49 小时，这是被废弃的旧限制
  assert.notEqual(defaultSettings().dailyStudyCapMinutes, 420, '不应再有每天 420 分钟的上限');
});

test('排程：早上规划时，学习任务从下一个整点开始，而不是拖到 16:00', () => {
  const env = engineContext({ now: MORNING });
  env.addTask({ plannedMinutes: 60, deadlineDate: '2025-10-16', deadlineTime: '13:00' });
  const result = env.run();

  const blocks = result.plan.blocks.filter((b) => b.kind === 'study');
  assert.ok(blocks.length > 0, '应当能排出学习时段');
  for (const block of blocks) {
    assert.ok(block.startMinutes < 16 * 60, `不应延迟到 16:00：实际 ${block.startMinutes}`);
    assert.ok(block.startMinutes >= 9 * 60, '也不应早于"下一个整点"起点');
  }
});

test('排程：清除固定日程后不会残留旧窗口限制（旧数据迁移）', async () => {
  const { migrateState } = await import('../../src/storage/migrations.js');
  const { createEmptyState } = await import('../../src/domain/schemas.js');
  const base = createEmptyState({ nowIso: '2025-10-16T00:00:00.000Z', windowStart: '2025-10-16' });

  const legacySettings = { ...defaultSettings() };
  legacySettings.studyWindows = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((day) => [day, [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }]]),
  );

  const migrated = migrateState({ ...base, settings: legacySettings });
  const spans = migrated.state.settings.studyWindows[4];
  assert.ok(spans[0].startMinutes < 16 * 60, '旧默认窗口应被升级');
  assert.ok(
    (migrated.issues ?? []).some((issue) => /16:00–23:00/.test(issue.message)),
    '升级必须明确告知用户',
  );

  // 用户自定义过的窗口一个字都不动
  const custom = { ...defaultSettings() };
  custom.studyWindows = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((day) => [day, [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }]]),
  );
  custom.studyWindows[4] = [{ startMinutes: 10 * 60, endMinutes: 12 * 60 }];
  const kept = migrateState({ ...base, settings: custom });
  assert.deepEqual(kept.state.settings.studyWindows[4], [{ startMinutes: 10 * 60, endMinutes: 12 * 60 }]);
});

/* ================================================================== *
 * 二、截止时间真实约束排程
 * ================================================================== */

test('排程：任务不会被安排到截止时间之后', () => {
  const env = engineContext({ now: MORNING });
  env.addTask({ title: '下午截止', plannedMinutes: 60, deadlineDate: '2025-10-16', deadlineTime: '13:00' });
  const result = env.run();

  const blocks = result.plan.blocks.filter((b) => b.kind === 'study');
  for (const block of blocks) {
    if (block.date !== '2025-10-16') continue;
    assert.ok(block.endMinutes <= 13 * 60, `片段 ${block.startMinutes}-${block.endMinutes} 超过了 13:00 截止`);
  }
});

test('排程：截止前来不及完成时，明确标记未安排且给出截止原因', () => {
  const env = engineContext({ now: MORNING });
  env.addTask({ title: '来不及', plannedMinutes: 120, deadlineDate: '2025-10-16', deadlineTime: '09:30' });
  const result = env.run();

  const blocks = result.plan.blocks.filter((b) => b.kind === 'study');
  assert.equal(blocks.length, 0, '不得排到截止时间之后');
  assert.ok(result.unscheduled.length > 0, '必须明确列出未能安排的任务');
  assert.equal(result.unscheduled[0].reasonCode, 'deadline_too_close');
  assert.match(result.unscheduled[0].reasonText, /截止时间之前/);
});

/* ================================================================== *
 * 三、可选字段
 * ================================================================== */

const taskContext = () => ({ idFactory: createIdFactory(), nowIso: '2025-10-16T00:00:00.000Z' });
const baseInput = () => ({
  ...createTaskDraft(),
  title: '作业',
  subject: '数学',
  plannedMinutes: 60,
  deadlineDate: '2025-10-20',
  deadlineTime: '23:00',
});

test('可选字段：三个字段都允许留空，留空保存为 null 而不是 0', () => {
  const task = createTask(baseInput(), taskContext());
  assert.equal(task.priorCompletedMinutes, null);
  assert.equal(task.minChunkMinutes, null);
  assert.equal(task.maxChunkMinutes, null);
  assert.equal(validateTask(task).ok, true, '留空必须是合法的');
});

test('可选字段：已经完成允许留空、允许填 0，两者在存储上可区分但计算一致', () => {
  const blank = createTask(baseInput(), taskContext());
  const zero = createTask({ ...baseInput(), priorCompletedMinutes: 0 }, taskContext());

  assert.equal(blank.priorCompletedMinutes, null);
  assert.equal(zero.priorCompletedMinutes, 0);
  assert.equal(claimedPriorMinutes(blank), 0);
  assert.equal(claimedPriorMinutes(zero), 0);
});

test('可选字段：已完成分钟不能超过总用时（留空不受影响）', () => {
  const over = createTask({ ...baseInput(), priorCompletedMinutes: 90 }, taskContext());
  assert.equal(validateTask(over).ok, false);
  assert.ok(validateTask(over).errors.some((issue) => issue.code === 'V015'));

  const blank = createTask(baseInput(), taskContext());
  assert.equal(validateTask(blank).ok, true);
});

test('可选字段：最短/最长的组合校验与"留空不产生 0 分钟片段"', () => {
  const bothFilled = createTask({ ...baseInput(), minChunkMinutes: 20, maxChunkMinutes: 40 }, taskContext());
  assert.equal(validateTask(bothFilled).ok, true);

  const reversed = createTask({ ...baseInput(), minChunkMinutes: 60, maxChunkMinutes: 30 }, taskContext());
  assert.equal(validateTask(reversed).ok, false, '最短大于最长必须被拒绝');
  assert.ok(validateTask(reversed).errors.some((issue) => issue.code === 'V010'));

  // 只填一个也合法
  assert.equal(validateTask(createTask({ ...baseInput(), minChunkMinutes: 20 }, taskContext())).ok, true);
  assert.equal(validateTask(createTask({ ...baseInput(), maxChunkMinutes: 40 }, taskContext())).ok, true);

  // 留空时排程器用系统默认值，不会生成 0 分钟片段
  const env = engineContext({ now: MORNING });
  env.addTask({ plannedMinutes: 60, minChunkMinutes: null, maxChunkMinutes: null });
  const result = env.run();
  for (const block of result.plan.blocks.filter((b) => b.kind === 'study')) {
    assert.ok(block.endMinutes - block.startMinutes >= 5, '不应生成无效的极短片段');
  }
});

test('可选字段：编辑任务时使用一致的规则（patch 里的空值保持可选语义）', async () => {
  const { applyTaskPatch } = await import('../../src/domain/task.js');
  const task = createTask({ ...baseInput(), minChunkMinutes: 30, maxChunkMinutes: 60 }, taskContext());
  const cleared = applyTaskPatch(task, { minChunkMinutes: '', maxChunkMinutes: null }, { nowIso: '2025-10-16T01:00:00.000Z' });
  assert.equal(cleared.minChunkMinutes, null, '清空后应保存为 null');
  assert.equal(cleared.maxChunkMinutes, null);
  assert.equal(validateTask(cleared).ok, true);
});

/* ================================================================== *
 * 四、计划开始时间
 * ================================================================== */

test('计划开始时间：留空时不影响排程，填了则从该时间之后开始考虑', () => {
  const withoutPref = engineContext({ now: MORNING });
  withoutPref.addTask({ plannedMinutes: 60 });
  const first = withoutPref.run().plan.blocks.filter((b) => b.kind === 'study')[0];
  assert.ok(first.startMinutes >= 9 * 60 && first.startMinutes < 10 * 60, '留空时从下一个整点开始');

  const withPref = engineContext({ now: MORNING });
  withPref.addTask({ plannedMinutes: 60, plannedStartMinutes: 10 * 60 });
  const second = withPref.run().plan.blocks.filter((b) => b.kind === 'study')[0];
  assert.ok(second.startMinutes >= 10 * 60, `应从 10:00 之后开始：实际 ${second.startMinutes}`);
});

test('计划开始时间：不能覆盖任务优先级与截止时间', () => {
  const env = engineContext({ now: MORNING });
  // 低优先级任务设置了更早的开始时间
  env.addTask({
    title: '低优先',
    plannedMinutes: 60,
    plannedStartMinutes: 9 * 60,
    importance: 1,
    difficulty: 1,
    procrastination: 1,
    deadlineDate: '2025-10-25',
  });
  env.addTask({
    title: '紧急',
    plannedMinutes: 60,
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    deadlineDate: '2025-10-16',
    deadlineTime: '12:00',
  });

  const result = env.run();
  const blocks = result.plan.blocks.filter((b) => b.kind === 'study');
  const urgent = blocks.find((b) => b.label === '紧急');
  assert.ok(urgent, '紧急任务必须被安排');
  assert.ok(blocks[0].label === '紧急', '更紧急的任务应排在前面，不能被"更早的开始时间"挤掉');
});

test('计划开始时间：非法值被拒绝', () => {
  const bad = createTask({ ...baseInput(), plannedStartMinutes: 99 * 60 }, taskContext());
  assert.equal(validateTask(bad).ok, false);
});

/* ================================================================== *
 * 五、任务列表：完成/删除后不再残留
 * ================================================================== */

async function withUiApp(fn) {
  const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
  const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
  const target = '/tmp/round4-fakedom.mjs';
  await writeFile(target, code);
  const { installFakeDom } = await import(`${target}?v=${Date.now()}`);
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 8, 0) });
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app });
  } finally {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) delete globalThis[key];
  }
}

const pageText = (dom, instance, hash) => {
  dom.location.hash = hash;
  instance.shell.render();
  return dom.appHost.children[0].byClass('app-main')[0].textContent;
};

test('任务列表：「全部」只显示仍然有效的任务，不含已完成/已取消/已删除', async () => {
  await withUiApp(async ({ dom, instance, app }) => {
    const a = instance.services.taskService.addTask(taskInput({ title: '待办任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    const b = instance.services.taskService.addTask(taskInput({ title: '完成的任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    const c = instance.services.taskService.addTask(taskInput({ title: '删除的任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    assert.equal(a.ok && b.ok && c.ok, true);

    app.commit(
      (state) => ({
        ...state,
        tasks: state.tasks.map((task) => {
          if (task.id === b.task.id) return { ...task, status: TASK_STATUS.COMPLETED };
          if (task.id === c.task.id) return { ...task, status: TASK_STATUS.DELETED, deletedAt: '2025-10-16T00:00:00.000Z' };
          return task;
        }),
      }),
      { reason: 'seed' },
    );

    const all = pageText(dom, instance, '#/tasks?status=all');
    assert.match(all, /待办任务/);
    assert.equal(/完成的任务/.test(all), false, '已完成任务不应出现在"全部"里');
    assert.equal(/删除的任务/.test(all), false, '已删除任务不应出现在"全部"里');

    // 历史状态仍可单独查看
    assert.match(pageText(dom, instance, '#/tasks?status=completed'), /完成的任务/);
    assert.match(pageText(dom, instance, '#/tasks?status=deleted'), /删除的任务/);
  });
});

test('任务列表：完成任务后仍保留学习记录，并继续以"已完成"出现在计划里', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 0, 0) });
  const now = { date: '2025-10-16', minutes: 0 };
  const created = env.services.taskService.addTask(
    taskInput({ title: '会被完成', plannedMinutes: 60, deadlineDate: '2025-10-18' }),
  );
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();

  // 完成其中一段并保留记录
  const session = env.app.getState().sessions.find((s) => s.taskId === created.task.id);
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, state: SESSION_STATE.COMPLETED, actualMinutes: s.plannedMinutes } : s,
      ),
    }),
    { reason: 'seed' },
  );
  env.services.planService.requestPreview({ now, ops: [{ kind: 'task.status', taskId: created.task.id, to: TASK_STATUS.COMPLETED }] });
  const applied = env.services.planService.applyPreview();
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

  const state = env.app.getState();
  assert.ok(
    state.sessions.some((s) => s.taskId === created.task.id && s.state === SESSION_STATE.COMPLETED),
    '已完成的学习记录必须保留（时间表与统计仍要显示）',
  );
  assert.equal(
    state.sessions.filter((s) => s.taskId === created.task.id && s.state === SESSION_STATE.FLEXIBLE).length,
    0,
    '完成后不应留下仍参与排程的时段',
  );
});

/* ================================================================== *
 * 六、主题
 * ================================================================== */

test('主题：只剩浅色与深色，旧的 system 会被映射成显式主题', () => {
  assert.deepEqual(Object.keys(THEME).sort(), ['DARK', 'LIGHT']);
  // 产品默认值已由浅色改为深色（深空是当前主基调），浅色仍可手动切换
  assert.equal(defaultPreferences().appearance.theme, THEME.DARK);
  assert.equal(normalizeTheme('system', { prefersDark: true }), THEME.DARK);
  assert.equal(normalizeTheme('system', { prefersDark: false }), THEME.LIGHT);
  assert.equal(normalizeTheme('rainbow'), THEME.DARK, '未知值回落到默认主题（深色），不能崩');
});

test('主题：旧偏好里的 system 在读取时被安全转换', () => {
  const original = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  try {
    const prefs = defaultPreferences();
    prefs.appearance.theme = 'system';
    globalThis.localStorage.setItem('studyPlanner:v1:preferences', JSON.stringify(prefs));
    const loaded = loadPreferences();
    assert.ok(loaded.appearance.theme === THEME.LIGHT || loaded.appearance.theme === THEME.DARK);
    assert.notEqual(loaded.appearance.theme, 'system');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('外观页：不再渲染"跟随系统"选项', async () => {
  await withUiApp(async ({ dom, instance }) => {
    const text = pageText(dom, instance, '#/appearance');
    assert.equal(/跟随系统/.test(text), false, '不应再出现"跟随系统"');
    assert.match(text, /浅色/);
    assert.match(text, /深色/);
  });
});

/* ================================================================== *
 * 七、自动生成预览
 * ================================================================== */

test('预览开关：默认开启，改动后直接生成候选计划且不重复询问', async () => {
  await withUiApp(async ({ dom, instance, services, app }) => {
    assert.equal(app.getState().settings.autoPreview, true, '默认应保持原有行为（自动生成）');

    const result = services.ui.previewWith(
      [{ kind: 'task.add', input: taskInput({ title: '新任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }) }],
      { changeSummary: '新增任务', navigate: false },
    );
    assert.equal(result.ok, true);
    assert.equal(Boolean(result.deferred), false, '开启时不应再弹确认');
    assert.ok(services.planService.getPendingPreview(), '应已生成候选计划');
    assert.equal(app.getState().officialPlan?.version ?? 0, 0, '未确认前不得应用为正式计划');

    // 不应出现"是否生成预览"的对话框
    const dialogText = dom.document.body.all().map((n) => n.textContent).join(' ');
    assert.equal(/要现在更新学习计划吗/.test(dialogText), false);
  });
});

test('预览开关：关闭时先询问；选择"暂不生成"只保存数据、不动正式计划', async () => {
  await withUiApp(async ({ dom, instance, services, app }) => {
    app.commit((state) => ({ ...state, settings: { ...state.settings, autoPreview: false } }), { reason: 'seed' });

    const result = services.ui.previewWith(
      [{ kind: 'task.add', input: taskInput({ title: '先存不排', plannedMinutes: 60, deadlineDate: '2025-10-20' }) }],
      { changeSummary: '新增任务', navigate: false },
    );
    assert.equal(Boolean(result.deferred), true, '关闭时应先询问');
    assert.equal(services.planService.getPendingPreview(), null, '询问阶段不应生成候选计划');

    // 点"暂不生成"
    const cancel = [...dom.document.body.all()].reverse().find((n) => n.tagName === 'BUTTON' && n.textContent.trim() === '暂不生成');
    assert.ok(cancel, '应提供"暂不生成"选项');
    cancel.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(app.getState().tasks.length, 1, '数据必须被保存');
    assert.equal(app.getState().officialPlan?.version ?? 0, 0, '正式计划不能被偷偷替换');
    assert.equal(services.planService.getPendingPreview(), null, '也不应留下一个候选计划');
  });
});

test('设置：autoPreview 会被持久化', () => {
  const env = createTestApp();
  const applied = env.services.planService.requestPreview({
    now: { date: '2025-10-16', minutes: 8 * 60 },
    ops: [{ kind: 'settings.update', settings: { autoPreview: false } }],
  });
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  assert.equal(env.app.getState().settings.autoPreview, false, '设置必须写入状态（刷新后仍有效）');
});
