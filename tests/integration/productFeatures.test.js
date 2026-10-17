/**
 * 新功能集成测试：外观/壁纸偏好、通知调度与权限、番茄钟服务与任务联动、
 * 奖励资格的防重复、统计口径、以及"刷新后数据仍在"。
 *
 * 这些测试都用**注入的时钟与固定随机源**，因此结果可复现，
 * 不需要等待真实时间流逝，也不依赖真实随机数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NOTIFICATION_TYPE, THEME, defaultPreferences, loadPreferences, savePreferences } from '../../src/services/preferences.js';
import { createAppearanceService } from '../../src/services/appearanceService.js';
import { createNotificationService } from '../../src/services/notificationService.js';
import { createStatsService, computeStreak } from '../../src/services/statsService.js';
import { buildBackup, serializeBackup } from '../../src/storage/backup.js';
import { migrateState } from '../../src/storage/migrations.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };
const FIXED_MS = Date.parse('2025-10-16T12:30:00.000Z');

/** 建立一个可控偏好的外观服务（不依赖真实 localStorage） */
function makeAppearance(overrides = {}) {
  const preferences = { ...defaultPreferences(), ...overrides };
  const saved = [];
  const service = createAppearanceService({
    preferences,
    onChange: (next) => saved.push(next),
  });
  return { service, saved };
}

/** 建立一个"注入固定时钟"的完整应用环境 */
function makeEnv({ clockMs = FIXED_MS } = {}) {
  const env = createTestApp();
  let currentMs = clockMs;

  const { service: appearance } = makeAppearance();
  const notifications = createNotificationService({
    appearanceService: appearance,
    now: () => NOW,
    clock: () => new Date(currentMs).toISOString(),
  });
  const stats = createStatsService({ app: env.app, now: () => NOW });

  return {
    ...env,
    appearance,
    notifications,
    stats,
    advance: (ms) => {
      currentMs += ms;
    },
    setMs: (ms) => {
      currentMs = ms;
    },
    get ms() {
      return currentMs;
    },
  };
}

/* ================================================================== *
 * 偏好：默认值、深合并、损坏数据回退
 * ================================================================== */

test('偏好：默认值只包含外观与通知两个分区（番茄钟与转盘已移除）', () => {
  const prefs = defaultPreferences();
  assert.equal(prefs.appearance.theme, THEME.SYSTEM);
  assert.equal(prefs.appearance.wallpaper.enabled, false);
  assert.equal(prefs.notifications.enabled, false, '默认不开启通知，必须由用户主动开启');
  assert.equal(prefs.notifications.permission, 'default');
  assert.equal(prefs.notifications.advanceMinutes, 10);

  assert.equal('focus' in prefs, false, '番茄钟设置已移除');
  assert.equal('rewards' in prefs, false, '奖励转盘设置已移除');
});

test('偏好：保存后能读回，刷新页面（重新读取）仍然有效', () => {
  const original = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  try {
    const prefs = defaultPreferences();
    prefs.appearance.theme = THEME.DARK;
    prefs.notifications.advanceMinutes = 30;
    savePreferences(prefs);

    const reloaded = loadPreferences();
    assert.equal(reloaded.appearance.theme, THEME.DARK, '主题刷新后保留');
    assert.equal(reloaded.notifications.advanceMinutes, 30, '通知提前时间刷新后保留');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('偏好：存储损坏时回退默认值，不影响应用启动', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => '{不是合法 JSON',
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    const prefs = loadPreferences();
    assert.equal(prefs.appearance.theme, THEME.SYSTEM, '损坏的偏好回退默认主题');
    assert.equal(prefs.notifications.enabled, false, '损坏的偏好回退默认通知设置');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('偏好：老数据缺少新增字段时用默认值补齐，不会崩', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ appearance: { theme: 'dark' } }),
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    const prefs = loadPreferences();
    assert.equal(prefs.appearance.theme, 'dark', '保留用户已有设置');
    assert.equal(prefs.notifications.advanceMinutes, 10, '缺失的通知字段补默认值');
    // 旧数据里如果还带着 focus / rewards 字段，读取时被忽略（不影响启动，也不清空用户数据）
    assert.equal('focus' in prefs, false);
    assert.equal('rewards' in prefs, false);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

/* ================================================================== *
 * 外观：主题与壁纸
 * ================================================================== */

test('外观：切换主题会更新偏好并通知订阅者（三种主题都可切换）', () => {
  const { service, saved } = makeAppearance();
  for (const theme of [THEME.DARK, THEME.LIGHT, THEME.SYSTEM]) {
    const result = service.setTheme(theme);
    assert.equal(result.ok, true);
    assert.equal(service.getPreferences().appearance.theme, theme);
  }
  assert.ok(saved.length >= 3, '每次变更都应通知订阅者');
});

test('外观：未知主题被拒绝，不会写坏偏好', () => {
  const { service } = makeAppearance();
  const before = service.getPreferences().appearance.theme;
  const result = service.setTheme('rainbow');
  assert.equal(result.ok, false);
  assert.equal(service.getPreferences().appearance.theme, before);
});

test('外观：壁纸只有"启用/关闭"开关，图片本身通过 IndexedDB 保存', () => {
  const { service } = makeAppearance();
  // 关闭时不会丢图片信息（只切换 enabled）
  service.setWallpaperEnabled(false);
  assert.equal(service.getPreferences().appearance.wallpaper.enabled, false);
  service.setWallpaperEnabled(true);
  assert.equal(service.getPreferences().appearance.wallpaper.enabled, true);

  // 显示方式/模糊/遮罩等可调项已按要求移除
  const wallpaper = service.getPreferences().appearance.wallpaper;
  assert.equal('fit' in wallpaper, false, '显示方式设置应已移除');
  assert.equal('blur' in wallpaper, false, '模糊设置应已移除');
  assert.equal('scrim' in wallpaper, false, '遮罩设置应已移除');
});

test('外观：壁纸层节点会在需要时自动创建（这是"上传成功但看不到"的根因）', () => {
  const created = [];
  const fakeLayer = { id: 'app-wallpaper', style: {}, setAttribute() {} };
  const fakeBody = {
    firstChild: null,
    appendChild(node) {
      created.push(node);
      return node;
    },
    insertBefore(node) {
      created.push(node);
      return node;
    },
  };
  const fakeDocument = {
    documentElement: { style: { setProperty() {} }, setAttribute() {}, style2: {} },
    body: fakeBody,
    getElementById: () => null,
    createElement: () => fakeLayer,
  };

  const original = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const { service } = makeAppearance();
    service.applyAll();
    assert.equal(created.length, 1, '没有壁纸层时必须补建一个，否则图片永远显示不出来');
    assert.equal(created[0].id, 'app-wallpaper');
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test('外观：没有 document 时（测试/无头环境）主题应用安全跳过，不抛异常', () => {
  const { service } = makeAppearance();
  assert.doesNotThrow(() => service.applyAll());
  assert.doesNotThrow(() => service.setTheme(THEME.DARK));
});

/* ================================================================== *
 * 通知：权限、开关、去重、静音
 * ================================================================== */

test('通知：浏览器不支持时如实报告，且无法开启', async () => {
  const { service: appearance } = makeAppearance();
  const notifications = createNotificationService({ appearanceService: appearance, now: () => NOW, clock: () => new Date(FIXED_MS).toISOString() });

  // 测试环境没有 Notification 构造函数
  assert.equal(notifications.supported(), false);
  const status = notifications.status();
  assert.equal(status.level, 'unsupported');
  assert.equal(status.active, false);
  assert.match(status.detail, /不支持|没有提供/);

  const enabled = notifications.setEnabled(true);
  assert.equal(enabled.ok, false, '不支持时不允许开启');
  const permission = await notifications.requestPermission();
  assert.equal(permission.ok, false);
});

test('通知：权限被拒绝时给出可执行的解决指引，而不是死路', () => {
  const original = globalThis.Notification;
  globalThis.Notification = function FakeNotification() {};
  globalThis.Notification.permission = 'denied';
  try {
    const { service: appearance } = makeAppearance();
    const notifications = createNotificationService({
      appearanceService: appearance,
      now: () => NOW,
      clock: () => new Date(FIXED_MS).toISOString(),
    });

    const status = notifications.status();
    assert.equal(status.level, 'denied');
    assert.equal(status.canRequest, false, '被拒绝后不能再次弹窗询问');
    assert.match(status.detail, /地址栏|网站设置/, '必须告诉用户去哪里改');
    assert.equal(notifications.setEnabled(true).ok, false);
  } finally {
    if (original === undefined) delete globalThis.Notification;
    else globalThis.Notification = original;
  }
});

test('通知：已授权且开启后，到点发送且同一提醒不会重复发送', async () => {
  const originalNotification = globalThis.Notification;
  const originalStorage = globalThis.localStorage;
  const sent = [];
  const store = new Map();
  let notifications = null;
  let reloaded = null;

  globalThis.Notification = function FakeNotification(title, options) {
    sent.push({ title, body: options?.body });
  };
  globalThis.Notification.permission = 'granted';
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  try {
    const { service: appearance } = makeAppearance();
    notifications = createNotificationService({
      appearanceService: appearance,
      now: () => NOW,
      clock: () => new Date(FIXED_MS).toISOString(),
    });

    // 已经授权时不应再次申请（幂等），也不会因为缺少 requestPermission 而失败
    const permission = await notifications.requestPermission();
    assert.equal(permission.ok, true);
    assert.equal(permission.alreadyGranted, true, '已授权时应直接返回，不重复申请');
    assert.equal(notifications.setEnabled(true).ok, true);

    const session = {
      id: 'ses_1',
      date: NOW.date,
      startMinutes: NOW.minutes + 8, // 8 分钟后开始，提前 10 分钟提醒 → 应该提醒
      endMinutes: NOW.minutes + 53,
      plannedMinutes: 45,
      state: 'flexible',
      locked: false,
      taskId: 'tsk_1',
    };
    const context = { sessions: [session], tasks: [{ id: 'tsk_1', title: '线性代数' }] };

    const first = notifications.check(context);
    assert.ok(first.fired >= 1, '应当发出至少一条提醒');
    assert.ok(
      sent.some((item) => /开始学习/.test(item.title)),
      '应包含"下一项学习即将开始"的提醒',
    );
    // 今日简报与"即将开始"是两种不同的提醒，可以同时存在，但都不允许重复
    const sentAfterFirst = sent.length;

    const second = notifications.check(context);
    assert.equal(second.fired, 0, '同一条提醒不得重复发送');
    assert.equal(sent.length, sentAfterFirst, '重复检查不会产生新通知');

    // 模拟刷新页面：新建一个服务实例，但"已提醒记录"在持久化存储里
    reloaded = createNotificationService({
      appearanceService: appearance,
      now: () => NOW,
      clock: () => new Date(FIXED_MS).toISOString(),
    });
    const third = reloaded.check(context);
    assert.equal(third.fired, 0, '刷新页面后也不得重复提醒');
    assert.equal(sent.length, sentAfterFirst, '刷新后通知总数不变');
  } finally {
    // 确保不会把调度定时器带出测试（服务本身不再偷偷起定时器，这里是双保险）
    notifications?.stop();
    reloaded?.stop();
    if (originalNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = originalNotification;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

test('通知：静音时段内不发送任何提醒（支持跨午夜区间）', () => {
  const originalNotification = globalThis.Notification;
  const originalStorage = globalThis.localStorage;
  const sent = [];
  const store = new Map();
  globalThis.Notification = function FakeNotification(title) {
    sent.push(title);
  };
  globalThis.Notification.permission = 'granted';
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  let notifications = null;
  try {
    const { service: appearance } = makeAppearance();
    notifications = createNotificationService({
      appearanceService: appearance,
      // 现在是 23:30，落在 22:00 → 07:00 的静音区间里
      now: () => ({ date: NOW.date, minutes: 23 * 60 + 30 }),
      clock: () => new Date(FIXED_MS).toISOString(),
    });
    notifications.setEnabled(true);
    notifications.setQuietHours({ enabled: true, startMinutes: 22 * 60, endMinutes: 7 * 60 });

    const context = {
      sessions: [
        { id: 'ses_2', date: NOW.date, startMinutes: 23 * 60 + 35, endMinutes: 23 * 60 + 80, plannedMinutes: 45, state: 'flexible', locked: false },
      ],
    };
    const result = notifications.check(context);
    assert.equal(result.fired, 0);
    assert.equal(result.quiet, true, '应当报告"处于静音时段"');
    assert.equal(sent.length, 0);
  } finally {
    // 确保不会把调度定时器带出测试（服务本身不再偷偷起定时器，这里是双保险）
    notifications.stop();
    if (originalNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = originalNotification;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

test('通知：关闭的应用开关会阻止发送（即使浏览器已授权）', () => {
  const originalNotification = globalThis.Notification;
  const originalStorage = globalThis.localStorage;
  const sent = [];
  globalThis.Notification = function FakeNotification(title) {
    sent.push(title);
  };
  globalThis.Notification.permission = 'granted';
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  let notifications = null;
  try {
    const { service: appearance } = makeAppearance();
    notifications = createNotificationService({
      appearanceService: appearance,
      now: () => NOW,
      clock: () => new Date(FIXED_MS).toISOString(),
    });
    // 刻意不开 setEnabled(true)
    const result = notifications.check({
      sessions: [{ id: 'ses_3', date: NOW.date, startMinutes: NOW.minutes + 1, endMinutes: NOW.minutes + 46, plannedMinutes: 45, state: 'flexible' }],
    });
    assert.equal(result.fired, 0);
    assert.equal(sent.length, 0);
  } finally {
    // 确保不会把调度定时器带出测试（服务本身不再偷偷起定时器，这里是双保险）
    notifications.stop();
    if (originalNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = originalNotification;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

/* ================================================================== *
 * 番茄钟服务：阶段流转与任务联动
 * ================================================================== */

test('统计：没有数据时明确说明无数据，不显示估算值', () => {
  const env = makeEnv();
  assert.equal(env.stats.hasAnyData(), false);

  const todayStats = env.stats.today();
  assert.equal(todayStats.actualMinutes, 0);
  assert.equal(todayStats.completedSessions, 0);
  assert.equal(todayStats.streak.current, 0);

  const taskStats = env.stats.tasks();
  assert.equal(taskStats.completionRate, null, '没有任务时完成率是"未知"，不是 0%');
  assert.equal(env.stats.bySubject().length, 0);
});

test('统计：完成时段后实际时长与科目分布正确', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '线性代数作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks[0];

  env.app.commit(
    (state) => ({
      ...state,
      sessions: [
        { id: 'ses_1', taskId: task.id, date: NOW.date, startMinutes: 960, endMinutes: 1005, plannedMinutes: 45, actualMinutes: 45, state: 'completed' },
        { id: 'ses_2', taskId: task.id, date: NOW.date, startMinutes: 1020, endMinutes: 1065, plannedMinutes: 45, actualMinutes: 30, state: 'completed' },
        { id: 'ses_3', taskId: task.id, date: NOW.date, startMinutes: 1080, endMinutes: 1125, plannedMinutes: 45, actualMinutes: null, state: 'flexible' },
      ],
    }),
    { reason: 'test-seed' },
  );

  assert.equal(env.stats.hasAnyData(), true);
  const todayStats = env.stats.today();
  assert.equal(todayStats.actualMinutes, 75, '实际时长 = 45 + 30，未完成的时段不计入');
  assert.equal(todayStats.completedSessions, 2);
  assert.equal(todayStats.totalSessions, 3);
  assert.equal(todayStats.plannedMinutes, 135, '计划时长包含未完成的时段');

  const subjects = env.stats.bySubject();
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0].subject, '数学');
  assert.equal(subjects[0].minutes, 75);
});

test('统计：任务完成率与逾期任务按真实截止日期计算', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '已完成', plannedMinutes: 60, deadlineDate: '2025-10-15' }));
  env.services.taskService.addTask(taskInput({ title: '已逾期', plannedMinutes: 60, deadlineDate: '2025-10-14' }));
  env.services.taskService.addTask(taskInput({ title: '今天到期', plannedMinutes: 60, deadlineDate: NOW.date }));
  env.services.taskService.addTask(taskInput({ title: '未完成', plannedMinutes: 60, deadlineDate: '2025-10-25' }));
  const first = env.app.getState().tasks.find((task) => task.title === '已完成');
  env.services.taskService.changeTaskStatus(first.id, 'completed');

  const taskStats = env.stats.tasks();
  assert.equal(taskStats.total, 4);
  assert.equal(taskStats.completed, 1);
  assert.equal(taskStats.active, 3);
  assert.equal(taskStats.overdue.length, 1);
  assert.equal(taskStats.overdue[0].title, '已逾期');
  assert.equal(taskStats.overdue[0].daysLate, 2, '10-14 到 10-16 是 2 天');
  assert.equal(taskStats.dueToday.length, 1);
  assert.equal(taskStats.completionRate, 0.25);
});

test('统计：连续学习天数只统计有真实完成记录的日子', () => {
  const state = {
    sessions: [
      { state: 'completed', date: '2025-10-16' },
      { state: 'completed', date: '2025-10-15' },
      { state: 'completed', date: '2025-10-14' },
      { state: 'completed', date: '2025-10-11' },
      { state: 'flexible', date: '2025-10-13' },
    ],
    focusRecords: [],
  };
  const streak = computeStreak(state, '2025-10-16');
  assert.equal(streak.current, 3, '16/15/14 连续三天（13 号没有完成记录）');
  assert.equal(streak.longest, 3);
  assert.equal(streak.activeDays, 4);
});

test('统计：今天还没开始时，连续天数从昨天算起（不会早上就断签）', () => {
  const state = { sessions: [{ state: 'completed', date: '2025-10-15' }, { state: 'completed', date: '2025-10-14' }], focusRecords: [] };
  const streak = computeStreak(state, '2025-10-16');
  assert.equal(streak.current, 2, '今天还没学习不应该把连续记录清零');
});

test('持久化：导入缺少新增字段的旧备份时自动补齐，不丢原有数据', async () => {
  const legacy = {
    format: 'seven-day-study-planner/backup',
    state: {
      schemaVersion: 1,
      tasks: [
        {
          id: 'tsk_old',
          title: '旧任务',
          subject: '数学',
          plannedMinutes: 60,
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
          note: '',
          createdAt: '2025-10-01T00:00:00.000Z',
          updatedAt: '2025-10-01T00:00:00.000Z',
        },
      ],
      sessions: [],
      settings: defaultPreferences() && undefined,
    },
  };
  // settings 用真实默认设置
  const { defaultSettings } = await import('../../src/domain/schemas.js');
  legacy.state.settings = defaultSettings();

  const target = createTestApp();
  const preview = target.app.previewImport(JSON.stringify(legacy));
  assert.equal(preview.ok, true, preview.errors?.map((i) => i.message).join('; '));

  const imported = await target.app.importBackup(JSON.stringify(legacy));
  assert.equal(imported.ok, true);
  const state = target.app.getState();
  assert.equal(state.tasks.length, 1, '旧任务被保留');
  // 番茄钟与转盘功能已移除：不再要求这些字段存在
  assert.equal('focusRecords' in state, false, '不再创建番茄记录容器');
  assert.equal('rewardHistory' in state, false, '不再创建奖励历史容器');
});

/* ================================================================== *
 * 剩余时长：可由用户声明"已完成的时长"，剩余是派生值
 * ================================================================== */

test('剩余时长：手工声明的已完成时长会减少剩余工作量，排程不再重复安排', () => {
  const env = makeEnv();
  env.services.taskService.addTask(
    taskInput({ title: '线性代数作业', plannedMinutes: 120, deadlineDate: '2025-10-20', priorCompletedMinutes: 30 }),
  );
  const task = env.app.getState().tasks[0];
  assert.equal(task.priorCompletedMinutes, 30, '声明值被保存');

  // 剩余 = 120 − 30 = 90
  assert.equal(env.services.taskService.listTaskViews()[0].remainingMinutes, 90);

  // 引擎只排剩余的部分
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  const scheduled = preview.preview.candidate.blocks
    .filter((block) => block.kind === 'study' && block.taskId === task.id)
    .reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
  assert.equal(scheduled, 90, `只应安排剩余的 90 分钟，实际 ${scheduled}`);
});

test('剩余时长：应用内完成记录与手工声明会加在一起', () => {
  const env = makeEnv();
  env.services.taskService.addTask(
    taskInput({ title: '英语阅读', plannedMinutes: 100, deadlineDate: '2025-10-20', priorCompletedMinutes: 25 }),
  );
  const task = env.app.getState().tasks[0];

  // 应用内又完成 45 分钟
  env.app.commit(
    (state) => ({
      ...state,
      sessions: [
        { id: 'ses_1', taskId: task.id, date: NOW.date, startMinutes: 960, endMinutes: 1005, plannedMinutes: 45, actualMinutes: 45, state: 'completed' },
      ],
    }),
    { reason: 'test-seed' },
  );

  assert.equal(env.services.taskService.listTaskViews()[0].remainingMinutes, 30, '剩余 = 100 − 25 − 45');
});

test('剩余时长：声明值超过预计总用时会被校验拒绝（不允许负数剩余）', () => {
  const env = makeEnv();
  const created = env.services.taskService.addTask(
    taskInput({ title: '超额声明', plannedMinutes: 60, deadlineDate: '2025-10-20', priorCompletedMinutes: 90 }),
  );
  assert.equal(created.ok, false, '不能声明比总用时更多的已完成时长');
  assert.ok(created.issues.some((issue) => issue.severity === 'error'));
});

test('剩余时长：不填声明值时行为与以前完全一致（向后兼容）', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '普通任务', plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const view = env.services.taskService.listTaskViews()[0];
  assert.equal(view.task.priorCompletedMinutes, 0);
  assert.equal(view.remainingMinutes, 90);
});

/* ================================================================== *
 * 成就：全部由真实记录推导
 * ================================================================== */

test('成就：没有记录时全部未达成，且给出目标而不是空徽章', () => {
  const env = makeEnv();
  const achievements = env.stats.achievements();
  assert.ok(achievements.length >= 4);
  assert.equal(achievements.every((item) => item.achieved), false);
  assert.equal(achievements.every((item) => item.target > 0), true, '每个成就都应有明确目标');
  assert.equal(achievements.every((item) => typeof item.description === 'string' && item.description.length > 0), true);
});

test('成就：完成第一个学习时段后"第一次学习"达成', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '任务', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks[0];

  const before = env.stats.achievements().find((item) => item.id === 'first_session');
  assert.equal(before.achieved, false);

  env.app.commit(
    (state) => ({
      ...state,
      sessions: [
        {
          id: 'ses_1',
          taskId: task.id,
          date: NOW.date,
          startMinutes: 960,
          endMinutes: 1020,
          plannedMinutes: 60,
          actualMinutes: 60,
          state: 'completed',
        },
      ],
    }),
    { reason: 'test-seed' },
  );

  const after = env.stats.achievements().find((item) => item.id === 'first_session');
  assert.equal(after.achieved, true);
  assert.equal(after.current, 1);
  assert.equal(after.ratio, 1);
});

test('成就：累计十小时按真实完成的学习时长推导', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '长任务', plannedMinutes: 600, deadlineDate: '2025-10-25' }));
  const task = env.app.getState().tasks[0];

  const makeSessions = (minutes) => [
    {
      id: 'ses_big',
      taskId: task.id,
      date: NOW.date,
      startMinutes: 0,
      endMinutes: minutes,
      plannedMinutes: minutes,
      actualMinutes: minutes,
      state: 'completed',
    },
  ];

  env.app.commit((state) => ({ ...state, sessions: makeSessions(9 * 60) }), { reason: 'test-seed' });
  let achievement = env.stats.achievements().find((item) => item.id === 'ten_hours');
  assert.equal(achievement.current, 9, '9 小时应显示 9 小时');
  assert.equal(achievement.achieved, false);

  env.app.commit((state) => ({ ...state, sessions: makeSessions(10 * 60) }), { reason: 'test-seed' });
  achievement = env.stats.achievements().find((item) => item.id === 'ten_hours');
  assert.equal(achievement.achieved, true);
});

test('成就：连续三天只在真的连续时达成', () => {
  const env = makeEnv();
  env.app.commit(
    (state) => ({
      ...state,
      sessions: [
        { id: 's1', date: '2025-10-16', state: 'completed', plannedMinutes: 45, actualMinutes: 45, taskId: 't', startMinutes: 960, endMinutes: 1005 },
        { id: 's2', date: '2025-10-15', state: 'completed', plannedMinutes: 45, actualMinutes: 45, taskId: 't', startMinutes: 960, endMinutes: 1005 },
        { id: 's3', date: '2025-10-11', state: 'completed', plannedMinutes: 45, actualMinutes: 45, taskId: 't', startMinutes: 960, endMinutes: 1005 },
      ],
    }),
    { reason: 'test-seed' },
  );

  const streakThree = env.stats.achievements().find((item) => item.id === 'streak_three');
  assert.equal(streakThree.current, 2, '16 号与 15 号连续两天，11 号断开');
  assert.equal(streakThree.achieved, false);
});

/* ==================================================================== *
 * 缓冲时间移除：旧计划里的缓冲时段必须被安全忽略
 * ==================================================================== */

test('兼容：加载含缓冲时段的旧计划时，缓冲块被移除且其它数据不受影响', async () => {
  const { defaultSettings } = await import('../../src/domain/schemas.js');
  const legacyState = {
    schemaVersion: 1,
    createdAt: '2025-10-01T00:00:00.000Z',
    updatedAt: '2025-10-01T00:00:00.000Z',
    timeZone: null,
    settings: defaultSettings(),
    tasks: [
      {
        id: 'tsk_keep',
        title: '保留的任务',
        subject: '数学',
        plannedMinutes: 60,
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
        note: '',
        createdAt: '2025-10-01T00:00:00.000Z',
        updatedAt: '2025-10-01T00:00:00.000Z',
      },
    ],
    sessions: [
      {
        id: 'ses_keep',
        taskId: 'tsk_keep',
        date: '2025-10-16',
        startMinutes: 960,
        endMinutes: 1020,
        plannedMinutes: 60,
        actualMinutes: null,
        state: 'flexible',
        locked: false,
        source: 'engine',
        planVersion: 1,
        createdAt: '2025-10-01T00:00:00.000Z',
        updatedAt: '2025-10-01T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        history: [],
      },
    ],
    fixedActivities: [],
    officialPlan: {
      planId: 'pln_old',
      version: 1,
      windowStart: '2025-10-16',
      windowEnd: '2025-10-22',
      status: 'feasible',
      generatedAt: '2025-10-01T00:00:00.000Z',
      engineVersion: 'engine@1.0.0',
      inputHash: 'old',
      blocks: [
        {
          id: 'blk_study',
          kind: 'study',
          date: '2025-10-16',
          startMinutes: 960,
          endMinutes: 1020,
          refId: 'ses_keep',
          taskId: 'tsk_keep',
          label: '保留的任务',
          locked: false,
        },
        {
          id: 'blk_buffer',
          kind: 'buffer',
          date: '2025-10-16',
          startMinutes: 1020,
          endMinutes: 1062,
          refId: 'buf_old',
          label: '机动缓冲',
        },
      ],
      days: ['2025-10-16', '2025-10-17', '2025-10-18', '2025-10-19', '2025-10-20', '2025-10-21', '2025-10-22'].map((date) => ({
        date,
        studyMinutes: date === '2025-10-16' ? 60 : 0,
        fixedMinutes: 0,
        restMinutes: 0,
        bufferMinutes: 42,
        reservedMinutes: 0,
        netCapacityMinutes: 420,
        status: 'normal',
      })),
      metrics: { totalStudyMinutes: 60, bufferReservedMinutes: 42 },
      unscheduled: [],
    },
    planHistory: [],
    pendingPreview: null,
    meta: {},
  };

  const result = migrateState(JSON.parse(JSON.stringify(legacyState)));
  assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));

  const blocks = result.state.officialPlan.blocks;
  assert.equal(blocks.filter((block) => block.kind === 'buffer').length, 0, '旧缓冲时段应被移除');
  assert.equal(blocks.filter((block) => block.kind === 'study').length, 1, '学习时段必须保留');
  assert.equal(result.state.officialPlan.days[0].bufferMinutes, 0, '每日缓冲统计应归零');
  assert.equal(result.state.tasks.length, 1, '任务数据不受影响');
  assert.equal(result.state.sessions.length, 1, '学习时段不受影响');
});
