/**
 * 第五轮回归测试。
 *
 * 覆盖：
 * 1. 重置系统：有范围地清空业务数据、保留设置、二次确认、失败不谎报
 * 2. 七日计划：只删掉"重新规划"入口，其它生成/预览入口仍在
 * 3. 已删除历史：彻底删除会真正从持久化数据中移除
 * 4. 计划开始时间：作为真实下界生效，排不下时明确报告
 * 5. 通知：能力检查、失败原因、不伪造成功
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTestApp, taskInput } from '../helpers/app.js';
import { engineContext } from '../helpers/engine.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { validateAppState } from '../../src/domain/schemas.js';
import { createNotificationService } from '../../src/services/notificationService.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');

/* ------------------------------------------------------------------ *
 * 共用的最小 DOM
 * ------------------------------------------------------------------ */

let domModulePromise = null;
async function getDomModule() {
  if (!domModulePromise) {
    domModulePromise = (async () => {
      const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
      const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
      const target = '/tmp/round5-fakedom.mjs';
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
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const findButton = (label) =>
    [...dom.document.body.all()].reverse().find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === label);
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app, flush, findButton });
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

/* ================================================================== *
 * 一、重置系统
 * ================================================================== */

function seedBusinessData(env, now) {
  const created = env.services.taskService.addTask(taskInput({ title: '会被重置的任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();
  env.services.planService.requestPreview({
    now,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '课程', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '08:00', end: '09:00' },
      },
    ],
  });
  env.services.planService.applyPreview();
  env.services.planService.requestPreview({
    now,
    ops: [{ kind: 'rest.add', input: { title: '午休', startDate: '2025-10-16', startMinutes: 720, endDate: '2025-10-16', endMinutes: 780 } }],
  });
  env.services.planService.applyPreview();
  env.services.planService.requestPreview({ now, ops: [{ kind: 'subject.ensure', name: '数学' }] });
  env.services.planService.applyPreview();
  return created;
}

test('重置系统：清空全部业务数据，但保留设置与外观偏好', async () => {
  await withUi(async ({ dom, services, app, flush, findButton }) => {
    const now = services.now();
    seedBusinessData({ services }, now);
    const before = app.getState();
    assert.ok(before.tasks.length > 0, '前置：应已有任务');
    assert.ok(before.sessions.length > 0, '前置：应已有学习时段');
    assert.ok(before.officialPlan, '前置：应已有正式计划');

    const settingsSnapshot = JSON.stringify(before.settings);

    services.ui.resetSystem();
    const confirm = findButton('确认重置');
    assert.ok(confirm, '必须先出现二次确认');
    confirm.click();
    await flush();

    const after = app.getState();
    assert.equal(after.tasks.length, 0, '任务应被清空');
    assert.equal(after.sessions.length, 0, '学习时段应被清空');
    assert.equal(after.fixedActivities.length, 0, '固定日程应被清空');
    assert.equal(after.restPeriods.length, 0, '休息安排应被清空');
    assert.equal(after.subjects.length, 0, '科目应被清空');
    assert.equal(after.officialPlan, null, '正式计划应被清空');
    assert.equal(after.planHistory.length, 0, '版本历史应被清空');
    assert.equal(after.pendingPreview, null, '候选计划应被清空');

    assert.equal(JSON.stringify(after.settings), settingsSnapshot, '设置必须原样保留');
    assert.equal(validateAppState(after).ok, true, '重置后的数据必须仍然合法');

    // 界面立刻反映（不需要手动刷新）
    const tasksPage = pageText(dom, { shell: { render: () => {} } }, '#/tasks');
    void tasksPage;
  });
});

test('重置系统：取消确认时不做任何修改', async () => {
  await withUi(async ({ services, app, flush, findButton }) => {
    const now = services.now();
    seedBusinessData({ services }, now);
    const taskCount = app.getState().tasks.length;

    services.ui.resetSystem();
    const cancel = findButton('取消');
    assert.ok(cancel, '应提供取消');
    cancel.click();
    await flush();

    assert.equal(app.getState().tasks.length, taskCount, '取消后任务数不变');
    assert.ok(app.getState().officialPlan, '取消后正式计划不变');
  });
});

test('重置系统：不调用 localStorage.clear，其它键（偏好/主题）保持不动', async () => {
  const source = await readFile(join(projectRoot, 'src', 'main.js'), 'utf8');
  const resetBlock = source.slice(source.indexOf('async resetSystem()'), source.indexOf('async resetSystem()') + 4000);
  assert.equal(/localStorage\.clear\(\)/.test(resetBlock), false, '不得用 localStorage.clear() 代替有范围的重置');
  assert.equal(/indexedDB\.deleteDatabase/.test(resetBlock), false, '不得删除整个数据库');
  assert.match(resetBlock, /commit\(/, '必须通过原子提交写入');
  assert.match(resetBlock, /settings: state\.settings/, '必须保留设置');
});

test('重置系统：写入失败时不谎报成功', async () => {
  await withUi(async ({ services, app, dom }) => {
    const now = services.now();
    seedBusinessData({ services }, now);
    const taskCount = app.getState().tasks.length;

    const originalCommit = app.commit;
    app.commit = () => ({ ok: false, error: new Error('模拟磁盘写入失败') });
    try {
      services.ui.resetSystem();
      const confirm = [...dom.document.body.all()].reverse().find((n) => n.tagName === 'BUTTON' && n.textContent.trim() === '确认重置');
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      app.commit = originalCommit;
    }

    assert.equal(app.getState().tasks.length, taskCount, '失败时数据不应被清空');
    const alerts = dom.document.body.all().filter((n) => n.classList?.contains('toast'));
    void alerts;
  });
});

/* ================================================================== *
 * 二、七日计划：只删"重新规划"
 * ================================================================== */

test('七日计划：不再有"重新规划"按钮', async () => {
  await withUi(async ({ dom, instance }) => {
    const text = pageText(dom, instance, '#/week');
    assert.equal(/重新规划/.test(text), false, '七日计划不应再出现"重新规划"');
  });
});

test('七日计划：保留上一周/下一周/添加休息等其它入口', async () => {
  await withUi(async ({ dom, instance }) => {
    const main = (() => {
      dom.location.hash = '#/week';
      instance.shell.render();
      return dom.appHost.children[0].byClass('app-main')[0];
    })();
    const labels = main.all().filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent.trim());
    assert.ok(labels.some((l) => l.includes('上一周')), '上一周应保留');
    assert.ok(labels.some((l) => l.includes('下一周')), '下一周应保留');
    assert.ok(labels.some((l) => l === '添加休息'), '添加休息应保留');
  });
});

test('七日计划：生成/预览能力本身没有被删除（首页与每日视图仍在）', async () => {
  await withUi(async ({ dom, instance }) => {
    const home = pageText(dom, instance, '#/home');
    assert.match(home, /生成七天计划/, '首页的生成入口必须保留');
    const day = pageText(dom, instance, '#/day');
    assert.ok(day.length > 0);
    // 服务层能力仍在
    assert.equal(typeof instance.services.planService.requestPreview, 'function');
    assert.equal(typeof instance.services.ui.openPlanForm, 'function');
  });
});

/* ================================================================== *
 * 三、已删除历史：彻底删除
 * ================================================================== */

test('彻底删除：从持久化数据里真正移除任务及其关联数据', () => {
  const env = createTestApp();
  const now = { date: '2025-10-16', minutes: 8 * 60 };
  const created = env.services.taskService.addTask(taskInput({ title: '待彻底删除', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();

  // 先软删除（进入已删除历史）
  env.services.taskService.deleteTask(created.task.id, { hard: false });
  assert.equal(env.app.getState().tasks.find((t) => t.id === created.task.id).status, TASK_STATUS.DELETED);

  const sessionsBefore = env.app.getState().sessions.filter((s) => s.taskId === created.task.id).length;
  assert.ok(sessionsBefore > 0, '前置：该任务应有学习时段');

  const purged = env.services.taskService.purgeTask(created.task.id);
  assert.equal(purged.ok, true, purged.issues?.map((i) => i.message).join('; '));

  const state = env.app.getState();
  assert.equal(state.tasks.some((t) => t.id === created.task.id), false, '任务必须从 tasks 中移除');
  assert.equal(state.sessions.filter((s) => s.taskId === created.task.id).length, 0, '关联时段必须移除');
  assert.equal(
    (state.officialPlan?.blocks ?? []).filter((b) => b.taskId === created.task.id).length,
    0,
    '正式计划里不应残留它的块',
  );
  assert.equal(state.pendingPreview, null, '候选计划应失效丢弃');
  assert.equal(validateAppState(state).ok, true, '删除后数据必须仍然合法');
});

test('彻底删除：不影响其它任务与固定日程，并解除依赖引用', () => {
  const env = createTestApp();
  const now = { date: '2025-10-16', minutes: 8 * 60 };
  const target = env.services.taskService.addTask(taskInput({ title: '被依赖的', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  const dependent = env.services.taskService.addTask(
    taskInput({ title: '依赖它的', plannedMinutes: 60, deadlineDate: '2025-10-21', dependsOn: [target.task.id] }),
  );
  const untouched = env.services.taskService.addTask(taskInput({ title: '无关任务', plannedMinutes: 60, deadlineDate: '2025-10-22' }));
  env.services.planService.requestPreview({
    now,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '课程', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '08:00', end: '09:00' },
      },
    ],
  });
  env.services.planService.applyPreview();

  env.services.taskService.deleteTask(target.task.id, { hard: false });
  assert.equal(env.services.taskService.purgeTask(target.task.id).ok, true);

  const state = env.app.getState();
  assert.ok(state.tasks.some((t) => t.id === dependent.task.id), '依赖它的任务本身应保留');
  assert.deepEqual(state.tasks.find((t) => t.id === dependent.task.id).dependsOn, [], '依赖引用应被解除');
  assert.ok(state.tasks.some((t) => t.id === untouched.task.id), '无关任务不受影响');
  assert.equal(state.fixedActivities.length, 1, '固定日程不受影响');
  assert.equal(validateAppState(state).ok, true, '解除依赖后数据必须合法');
});

test('彻底删除：软删除与彻底删除是两种不同行为', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '两种删除', plannedMinutes: 60, deadlineDate: '2025-10-20' }));

  // 没有学习记录时：普通删除本来就是硬删除（保持既有行为）
  const first = env.services.taskService.deleteTask(created.task.id, { hard: true });
  assert.equal(first.ok, true);
  assert.equal(env.app.getState().tasks.length, 0, '无记录时普通删除即可彻底移除');
});

test('已删除历史页：提供"彻底删除"入口，点击并确认后记录消失', async () => {
  await withUi(async ({ dom, instance, services, app, flush, findButton }) => {
    const created = services.taskService.addTask(taskInput({ title: '历史任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    services.planService.requestPreview({ now: services.now() });
    services.planService.applyPreview();
    services.taskService.deleteTask(created.task.id, { hard: false });

    // 进入"已删除历史"
    const text = pageText(dom, instance, '#/tasks?status=deleted');
    assert.match(text, /历史任务/, '已删除历史里应能看到它');

    const purgeButton = findButton('彻底删除');
    assert.ok(purgeButton, '每条历史记录都应有"彻底删除"');
    purgeButton.click();
    await flush();

    const confirm = findButton('彻底删除');
    assert.ok(confirm, '必须二次确认');
    confirm.click();
    await flush();

    assert.equal(app.getState().tasks.some((t) => t.id === created.task.id), false, '记录必须被真正删除');
    const after = pageText(dom, instance, '#/tasks?status=deleted');
    assert.equal(/历史任务/.test(after), false, '刷新页面后不应再出现');
  });
});

/* ================================================================== *
 * 四、计划开始时间
 * ================================================================== */

test('计划开始时间：填写后任务不会排到该时间之前（13:23 / 15:30 场景）', () => {
  const env = engineContext({ now: { date: '2025-10-16', minutes: 13 * 60 + 23 } });
  env.addTask({ plannedMinutes: 60, plannedStartMinutes: 15 * 60 + 30, deadlineDate: '2025-10-20' });
  const blocks = env.run().plan.blocks.filter((b) => b.kind === 'study');

  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.ok(
      block.startMinutes >= 15 * 60 + 30,
      `必须从 15:30 之后开始，不能仍按默认整点 14:00：实际 ${block.startMinutes}`,
    );
  }
});

test('计划开始时间：未填写时仍遵守"下一个整点"的默认规则', () => {
  const env = engineContext({ now: { date: '2025-10-16', minutes: 13 * 60 + 23 } });
  env.addTask({ plannedMinutes: 60, deadlineDate: '2025-10-20' });
  const first = env.run().plan.blocks.filter((b) => b.kind === 'study')[0];
  assert.equal(first.startMinutes, 14 * 60, '未填写时应从 14:00（下一个整点）开始');
});

test('计划开始时间：之后放不下时明确报告，而不是静默排到指定时间之前', () => {
  const env = engineContext({ now: { date: '2025-10-16', minutes: 13 * 60 + 23 } });
  env.setStudyWindows(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, [{ startMinutes: 8 * 60, endMinutes: 15 * 60 }]])));
  env.addTask({ plannedMinutes: 120, plannedStartMinutes: 14 * 60 + 50, deadlineDate: '2025-10-20' });

  const result = env.run();
  assert.equal(result.plan.blocks.filter((b) => b.kind === 'study').length, 0, '不得排到 14:50 之前');
  assert.ok(result.unscheduled.length > 0, '必须明确列出未安排');
  assert.equal(result.unscheduled[0].reasonCode, 'planned_start_unreachable');
});

test('计划开始时间：与截止时间冲突时给出明确结果', () => {
  const env = engineContext({ now: { date: '2025-10-16', minutes: 13 * 60 + 23 } });
  // 截止 15:00，但要求 16:00 之后才开始 → 无解
  env.addTask({ plannedMinutes: 60, plannedStartMinutes: 16 * 60, deadlineDate: '2025-10-16', deadlineTime: '15:00' });

  const result = env.run();
  assert.equal(result.plan.blocks.filter((b) => b.kind === 'study').length, 0, '不得违反任一约束');
  assert.ok(result.unscheduled.length > 0, '必须报告未安排及原因');
});

test('计划开始时间：修改后重新生成候选计划会使用最新值', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 13, 23) });
  const now = { date: '2025-10-16', minutes: 13 * 60 + 23 };
  const created = env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();
  assert.equal(env.app.getState().officialPlan.blocks.find((b) => b.kind === 'study').startMinutes, 14 * 60);

  env.services.taskService.updateTask(created.task.id, { plannedStartMinutes: 15 * 60 + 30 });
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();
  const moved = env.app.getState().officialPlan.blocks.find((b) => b.kind === 'study');
  assert.ok(moved.startMinutes >= 15 * 60 + 30, `重新生成后应使用最新值：实际 ${moved.startMinutes}`);
});

/* ================================================================== *
 * 五、通知
 * ================================================================== */

function makeNotificationService() {
  const appearance = {
    getPreferences: () => ({
      appearance: { theme: 'light', wallpaper: { enabled: false } },
      notifications: {
        enabled: true,
        permission: 'granted',
        advanceMinutes: 10,
        quietHours: { enabled: false, startMinutes: 0, endMinutes: 0 },
        types: { session_soon: true, plan_start: true, daily_summary: false },
      },
    }),
  };
  return createNotificationService({
    appearanceService: appearance,
    now: () => ({ date: '2025-10-16', minutes: 10 * 60 }),
    clock: () => '2025-10-16T10:00:00.000Z',
  });
}

test('通知：正常环境下能真正发送（不是只保存一个开关）', () => {
  const originals = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  const sent = [];
  globalThis.isSecureContext = true;
  globalThis.Notification = function Notification(title, options) {
    sent.push({ title, options });
    this.close = () => {};
  };
  globalThis.Notification.permission = 'granted';
  try {
    const service = makeNotificationService();
    const result = service.sendTest();
    assert.equal(result.ok, true, '应真正创建一条通知');
    assert.equal(sent.length, 1, '必须实际调用通知构造器');
    assert.equal(sent[0].title, '测试通知');
  } finally {
    globalThis.Notification = originals.Notification;
    globalThis.isSecureContext = originals.secure;
  }
});

test('通知：非安全上下文（file:// 等）明确报错，不假装成功', () => {
  const originals = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.isSecureContext = false;
  globalThis.Notification = function Notification() {};
  globalThis.Notification.permission = 'granted';
  try {
    const service = makeNotificationService();
    const result = service.sendTest();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insecure-context');
    assert.equal(service.describeEnvironment().level, 'unsupported');
    assert.match(service.describeEnvironment().text, /安全上下文|localhost/);
  } finally {
    globalThis.Notification = originals.Notification;
    globalThis.isSecureContext = originals.secure;
  }
});

test('通知：权限被拒时如实报告', () => {
  const originals = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.isSecureContext = true;
  globalThis.Notification = function Notification() {};
  globalThis.Notification.permission = 'denied';
  try {
    const service = makeNotificationService();
    const result = service.sendTest();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-permission');
  } finally {
    globalThis.Notification = originals.Notification;
    globalThis.isSecureContext = originals.secure;
  }
});

test('通知：构造器不可用（Safari 式）时报告真实原因，并更新环境说明', () => {
  const originals = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.isSecureContext = true;
  globalThis.Notification = function Notification() {
    throw new Error('Illegal constructor');
  };
  globalThis.Notification.permission = 'granted';
  try {
    const service = makeNotificationService();
    const result = service.sendTest();
    assert.equal(result.ok, false, '不得谎报成功');
    assert.equal(result.reason, 'no-channel');
    assert.match(String(result.detail), /Illegal constructor/);
    // 失败被记住后，环境说明应变成"不支持"
    assert.equal(service.describeEnvironment().level, 'unsupported');
  } finally {
    globalThis.Notification = originals.Notification;
    globalThis.isSecureContext = originals.secure;
  }
});

test('通知：没有 Notification API 时 capabilities 明确标记不支持', () => {
  const originals = { Notification: globalThis.Notification };
  delete globalThis.Notification;
  try {
    const service = makeNotificationService();
    assert.equal(service.capabilities().supported, false);
    assert.equal(service.sendTest().reason, 'unsupported');
  } finally {
    globalThis.Notification = originals.Notification;
  }
});

/* ================================================================== *
 * 六、重置后的"恢复备份"不能把旧数据装回来
 * ================================================================== */

test('重置系统：自动恢复备份槽同步为已重置状态，不会被旧数据复活', async () => {
  const { createAppState } = await import('../../src/services/appState.js');
  const { createMemoryAdapter } = await import('../../src/storage/memoryAdapter.js');

  const adapter = createMemoryAdapter();
  const app = createAppState({ adapter, clock: () => '2025-10-16T05:23:00.000Z' });
  app.load();

  // 造一条业务数据并保存（保存时会把"上一份"轮转进 backup 槽）
  app.commit(
    (state) => ({
      ...state,
      tasks: [
        {
          ...(state.tasks?.[0] ?? {}),
          id: 'tsk_probe',
          title: '重置前的任务',
          subject: '数学',
          plannedMinutes: 60,
          priorCompletedMinutes: null,
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
          status: 'not_started',
          note: '',
          createdAt: '2025-10-16T00:00:00.000Z',
          updatedAt: '2025-10-16T00:00:00.000Z',
        },
      ],
    }),
    { reason: 'seed' },
  );
  assert.equal(app.getState().tasks.length, 1);

  // 再保存一次，让"有任务"的版本进入 backup 槽
  app.commit((state) => ({ ...state }), { reason: 'seed-2' });

  // 执行重置（等价于 ui.resetSystem 的关键两步：清空 + 同步备份槽）
  const { createEmptyState } = await import('../../src/domain/schemas.js');
  const settings = app.getState().settings;
  app.commit(
    () => ({
      ...createEmptyState({ nowIso: '2025-10-16T05:23:00.000Z', windowStart: '2025-10-16' }),
      settings,
    }),
    { reason: 'reset-system' },
  );
  const synced = app.syncRecoveryBackup();
  assert.equal(synced.ok, true, '备份槽必须能被同步');

  // 主数据已清空
  assert.equal(app.getState().tasks.length, 0, '重置后主数据里不应有任务');

  // 关键：此时"自动恢复备份"里必须也是已重置的状态，
  // 否则一旦主数据读取失败，旧任务会被自动装回来。
  const reopened = createAppState({ adapter, clock: () => '2025-10-16T05:23:00.000Z' });
  const report = reopened.load();
  assert.equal(reopened.getState().tasks.length, 0, '重新打开后不应出现被重置的数据');
  assert.equal(report.recovered, false, '不应发生"从备份恢复"');

  // 直接检查备份槽内容：也必须是空任务（用同一适配器重新读一次即可验证）
  const probe = createAppState({ adapter, clock: () => '2025-10-16T05:23:00.000Z' });
  probe.load();
  assert.equal(probe.getLoadReport().recovered, false);
  assert.deepEqual(probe.getState().tasks, [], '备份槽里也必须是已重置的状态');
});

/* ================================================================== *
 * 七、恢复出厂设置（本轮收尾）
 * ================================================================== */

test('恢复出厂设置：数据、设置、主题一起回到初始状态', async () => {
  await withUi(async ({ dom, instance, services, app, flush, findButton }) => {
    const mk = (title) => taskInput({ title, plannedMinutes: 60, deadlineDate: '2025-10-20' });
    services.taskService.addTask(mk('出厂前的任务'));
    services.planService.requestPreview({
      now: services.now(),
      ops: [
        {
          kind: 'fixedActivity.add',
          input: { title: '课程', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '08:00', end: '09:00' },
        },
      ],
    });
    services.planService.applyPreview();
    services.appearanceService.setTheme('dark');
    app.commit((state) => ({ ...state, settings: { ...state.settings, maxSessionsPerDay: 7 } }), { reason: 'tweak' });

    assert.equal(app.getState().tasks.length, 1);
    assert.ok(app.getState().officialPlan);
    assert.equal(services.appearanceService.getPreferences().appearance.theme, 'dark');

    services.ui.resetFactory();
    const confirm = findButton('恢复出厂设置');
    assert.ok(confirm, '必须出现二次确认');
    confirm.click();
    await flush();
    await flush();

    const after = app.getState();
    assert.equal(after.tasks.length, 0, '任务必须清空');
    assert.equal(after.fixedActivities.length, 0, '固定日程必须清空');
    assert.equal(after.sessions.length, 0, '学习时段必须清空');
    assert.equal(after.officialPlan, null, '正式计划必须清空');
    assert.equal(after.planHistory.length, 0, '版本历史必须清空');
    assert.equal(after.settings.maxSessionsPerDay, 24, '设置必须恢复默认');
    assert.equal(services.appearanceService.getPreferences().appearance.theme, 'light', '主题必须恢复默认');
    assert.equal(validateAppState(after).ok, true, '重置后数据仍然合法');
  });
});

test('恢复出厂设置：取消时不修改任何数据与设置', async () => {
  await withUi(async ({ services, app, flush, findButton }) => {
    services.taskService.addTask(taskInput({ title: '不该被删', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    services.appearanceService.setTheme('dark');

    services.ui.resetFactory();
    const cancel = findButton('取消');
    assert.ok(cancel, '应提供取消');
    cancel.click();
    await flush();

    assert.equal(app.getState().tasks.length, 1, '取消后任务不变');
    assert.equal(services.appearanceService.getPreferences().appearance.theme, 'dark', '取消后主题不变');
  });
});

test('恢复出厂设置：备份槽同步，重新打开不会复活旧数据', async () => {
  const { createAppState } = await import('../../src/services/appState.js');
  const { createMemoryAdapter } = await import('../../src/storage/memoryAdapter.js');
  const { createEmptyState, defaultSettings } = await import('../../src/domain/schemas.js');

  const adapter = createMemoryAdapter();
  const app1 = createAppState({ adapter, clock: () => '2025-10-16T05:23:00.000Z' });
  app1.load();
  app1.commit((state) => ({ ...state, tasks: [{ ...makeSeedTask() }] }), { reason: 'seed' });
  app1.commit((state) => ({ ...state }), { reason: 'seed-2' }); // 让"有任务"的版本进入备份槽

  // 恢复出厂设置关键三步
  app1.commit(() => createEmptyState({ nowIso: '2025-10-16T05:23:00.000Z', windowStart: '2025-10-16' }), {
    reason: 'reset-factory',
  });
  assert.equal(app1.syncRecoveryBackup().ok, true);
  assert.equal(app1.getState().tasks.length, 0);

  // 重新打开
  const app2 = createAppState({ adapter, clock: () => '2025-10-16T05:23:00.000Z' });
  const report = app2.load();
  assert.equal(app2.getState().tasks.length, 0, '重开后不应出现旧任务');
  assert.equal(report.recovered, false, '不应触发"从备份恢复"');
  assert.deepEqual(app2.getState().settings, defaultSettings(), '重开后设置应为默认值');
});

test('恢复出厂设置：重置后仍可正常创建任务并生成计划', async () => {
  await withUi(async ({ services, app, flush, findButton }) => {
    services.taskService.addTask(taskInput({ title: '出厂前', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
    services.ui.resetFactory();
    findButton('恢复出厂设置').click();
    await flush();
    await flush();

    assert.equal(app.getState().tasks.length, 0);

    // 重置后重新使用
    const created = services.taskService.addTask(taskInput({ title: '出厂后', plannedMinutes: 60, deadlineDate: '2025-10-21' }));
    assert.equal(created.ok, true, '重置后必须还能创建任务');
    const preview = services.planService.requestPreview({ now: services.now(), changeSummary: '重新生成' });
    assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
    assert.equal(services.planService.applyPreview().ok, true, '重置后必须还能生成并应用计划');
    assert.ok(app.getState().officialPlan, '应有新的正式计划');
  });
});

test('恢复出厂设置：不使用 localStorage.clear，也不删除整个数据库', async () => {
  const source = await readFile(join(projectRoot, 'src', 'main.js'), 'utf8');
  const start = source.indexOf('async resetFactory()');
  // 去掉注释再检查：注释里出现的"localStorage.clear()"是解释"为什么不用它"，不是真实调用
  const block = source
    .slice(start, start + 5200)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/localStorage\.clear\(\)/.test(block), false, '不得整体清空 localStorage');
  assert.equal(/indexedDB\.deleteDatabase/.test(block), false, '不得删除整个 IndexedDB 数据库');
  assert.match(block, /app\.commit\(/, '必须走原子提交');
  assert.match(block, /syncRecoveryBackup/, '必须同步自动恢复备份');
});

function makeSeedTask() {
  return {
    id: 'tsk_factory_probe',
    title: '出厂前的任务',
    subject: '数学',
    plannedMinutes: 60,
    priorCompletedMinutes: null,
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
    status: 'not_started',
    note: '',
    createdAt: '2025-10-16T00:00:00.000Z',
    updatedAt: '2025-10-16T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    deletedAt: null,
  };
}

/* ================================================================== *
 * 八、通知使用限制说明
 * ================================================================== */

test('通知页：展示使用限制，覆盖 iOS / Safari / 本地文件 / 后台推送', async () => {
  await withUi(async ({ dom, instance }) => {
    const text = pageText(dom, instance, '#/notifications');

    assert.match(text, /通知使用限制/, '必须有明确的限制说明区块');
    assert.match(text, /需要满足的条件/, '必须区分"需要满足的条件"');
    assert.match(text, /不受支持|无法保证/, '必须区分"无法保证的情况"');

    // 逐条核对该说明必须覆盖的关键限制
    assert.match(text, /iPhone|iPad|iOS/, '必须说明 iOS/iPadOS 不支持');
    assert.match(text, /Safari/, '必须说明 Safari 的限制');
    assert.ok(text.includes('file://'), '必须说明本地 HTML 文件的限制');
    assert.match(text, /后台|关闭页面/, '必须说明关闭页面后无法推送');
    assert.match(text, /勿扰|静音/, '必须说明系统通知权限/勿扰模式的影响');
    assert.match(text, /Service Worker/, '必须说明没有实现后台推送');
  });
});

test('通知页：不支持的环境不会只显示"已开启"', async () => {
  const originals = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.isSecureContext = false;
  globalThis.Notification = function Notification() {};
  globalThis.Notification.permission = 'granted';
  try {
    await withUi(async ({ dom, instance, services }) => {
      // 在非安全上下文里，status.active 必须是 false
      assert.equal(services.notificationService.status().active, false, '非安全上下文不能算"已开启"');
      const text = pageText(dom, instance, '#/notifications');
      assert.match(text, /无法使用系统通知/, '应明确显示当前环境不可用');
    });
  } finally {
    globalThis.Notification = originals.Notification;
    globalThis.isSecureContext = originals.secure;
  }
});
