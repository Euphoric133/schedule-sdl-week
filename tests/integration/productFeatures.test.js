/**
 * 新功能集成测试：外观/壁纸偏好、通知调度与权限、番茄钟服务与任务联动、
 * 奖励资格的防重复、统计口径、以及"刷新后数据仍在"。
 *
 * 这些测试都用**注入的时钟与固定随机源**，因此结果可复现，
 * 不需要等待真实时间流逝，也不依赖真实随机数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REWARDS,
  NOTIFICATION_TYPE,
  REWARD_TRIGGER,
  THEME,
  WALLPAPER_FIT,
  defaultPreferences,
  loadPreferences,
  savePreferences,
} from '../../src/services/preferences.js';
import { createAppearanceService } from '../../src/services/appearanceService.js';
import { createNotificationService } from '../../src/services/notificationService.js';
import { createPomodoroService, END_REASON } from '../../src/services/pomodoroService.js';
import { createRewardService, computeEntitlement, computeProgress } from '../../src/services/rewardService.js';
import { createStatsService, computeStreak } from '../../src/services/statsService.js';
import { buildBackup, serializeBackup } from '../../src/storage/backup.js';
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
  const pomodoro = createPomodoroService({
    appearanceService: appearance,
    app: env.app,
    now: () => NOW,
    nowMs: () => currentMs,
  });
  const rewards = createRewardService({ appearanceService: appearance, app: env.app, now: () => NOW });
  const stats = createStatsService({ app: env.app, now: () => NOW });

  // 完成的专注写入业务数据（与 main.js 的接线保持一致）
  pomodoro.setRecordSink((record) => {
    const state = env.app.getState();
    const entry = {
      id: `fcr_test_${state.focusRecords.length + 1}`,
      date: record.date,
      focusedSeconds: record.focusedSeconds,
      completed: record.completed,
      round: record.round,
      sessionId: record.sessionId,
      taskId: record.taskId,
      taskTitle: record.taskTitle,
      sourceKey: `pomodoro:${record.sessionId ?? 'none'}:${record.phase}:${record.round}`,
      createdAt: new Date(currentMs).toISOString(),
    };
    env.app.commit((current) => ({ ...current, focusRecords: [...(current.focusRecords ?? []), entry] }), {
      reason: 'focus-record',
    });
  });

  return {
    ...env,
    appearance,
    notifications,
    pomodoro,
    rewards,
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

test('偏好：默认值完整，包含外观、通知、专注与奖励四个分区', () => {
  const prefs = defaultPreferences();
  assert.equal(prefs.appearance.theme, THEME.SYSTEM);
  assert.equal(prefs.appearance.wallpaper.enabled, false);
  assert.equal(prefs.notifications.enabled, false, '默认不开启通知，必须由用户主动开启');
  assert.equal(prefs.notifications.permission, 'default');
  assert.equal(prefs.focus.focusMinutes, 25);
  assert.equal(prefs.focus.shortBreakMinutes, 5);
  assert.equal(prefs.rewards.items.length, DEFAULT_REWARDS.length);
  assert.equal(prefs.rewards.triggers[REWARD_TRIGGER.FOCUS_MINUTES].enabled, true, '默认启用"每 25 分钟专注给一次机会"');
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
    prefs.focus.focusMinutes = 45;
    savePreferences(prefs);

    const reloaded = loadPreferences();
    assert.equal(reloaded.appearance.theme, THEME.DARK, '主题刷新后保留');
    assert.equal(reloaded.focus.focusMinutes, 45, '专注时长刷新后保留');
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
    assert.equal(prefs.appearance.theme, THEME.SYSTEM);
    assert.ok(Array.isArray(prefs.rewards.items));
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
    assert.equal(prefs.focus.focusMinutes, 25, '缺失的专注字段补默认值');
    assert.equal(prefs.rewards.items.length, DEFAULT_REWARDS.length, '缺失的奖励项补默认值');
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

test('外观：壁纸显示参数有范围保护（模糊与遮罩不会写到离谱的值）', () => {
  const { service } = makeAppearance();
  service.updateWallpaperSettings({ blur: 999 });
  assert.equal(service.getPreferences().appearance.wallpaper.blur, 20, '模糊上限 20px');
  service.updateWallpaperSettings({ blur: -5 });
  assert.equal(service.getPreferences().appearance.wallpaper.blur, 0, '模糊下限 0');
  service.updateWallpaperSettings({ scrim: 5 });
  assert.equal(service.getPreferences().appearance.wallpaper.scrim, 0.95, '遮罩上限 0.95（保留一点背景可见）');
  service.updateWallpaperSettings({ scrim: -1 });
  assert.equal(service.getPreferences().appearance.wallpaper.scrim, 0);
});

test('外观：未知的显示方式被拒绝', () => {
  const { service } = makeAppearance();
  const result = service.updateWallpaperSettings({ fit: 'stretch' });
  assert.equal(result.ok, false);
  assert.equal(service.getPreferences().appearance.wallpaper.fit, WALLPAPER_FIT.COVER);
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

test('通知：专注结束时按真实时间戳提醒（休眠后补发一次）', () => {
  const originalNotification = globalThis.Notification;
  const originalStorage = globalThis.localStorage;
  const sent = [];
  const store = new Map();

  globalThis.Notification = function FakeNotification(title, options) {
    sent.push({ title, body: options?.body });
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
      now: () => NOW,
      clock: () => new Date(FIXED_MS).toISOString(),
    });
    notifications.setEnabled(true);

    const endsAtMs = Date.now() - 1000; // 已经结束 1 秒（模拟刚从休眠恢复）
    const context = { runningFocus: { sessionId: 'ses_9', endsAtMs, taskTitle: '英语阅读' } };

    assert.equal(notifications.check(context).fired, 1);
    assert.equal(sent.find((item) => /专注结束/.test(item.title))?.body.includes('英语阅读'), true);
    assert.equal(notifications.check(context).fired, 0, '不重复提醒');
  } finally {
    // 确保不会把调度定时器带出测试（服务本身不再偷偷起定时器，这里是双保险）
    notifications?.stop();
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

test('番茄钟：开始专注会记录关联任务，完成后写入一条真实记录', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '线性代数作业', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks[0];

  const started = env.pomodoro.startFocus({ taskId: task.id, taskTitle: task.title });
  assert.equal(started.ok, true);
  assert.equal(env.pomodoro.getTimer().taskTitle, '线性代数作业');

  env.advance(25 * 60_000); // 走完整个专注阶段
  const ended = env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  assert.equal(ended.completed, true);
  assert.equal(ended.focusedSeconds, 1500);
  assert.equal(ended.round, 1);

  const records = env.app.getState().focusRecords;
  assert.equal(records.length, 1);
  assert.equal(records[0].completed, true);
  assert.equal(records[0].focusedSeconds, 1500);
  assert.equal(records[0].taskId, task.id);
});

test('番茄钟：中途结束按实际时长记录，且**不**计入完成的番茄', () => {
  const env = makeEnv();
  env.pomodoro.startFocus({});
  env.advance(7 * 60_000 + 30_000); // 只专注了 7.5 分钟

  const ended = env.pomodoro.endPhase({ reason: END_REASON.STOPPED });
  assert.equal(ended.completed, false, '中途结束不算完成');
  assert.equal(ended.focusedSeconds, 450);
  assert.equal(ended.round, 0, '轮数不增加');

  const stats = env.pomodoro.todayStats();
  assert.equal(stats.completedRounds, 0);
  assert.equal(stats.earlyEndedRounds, 1);
  assert.equal(stats.focusedMinutes, 8, '实际时长照样记录（7.5 分钟四舍五入为 8）');
});

test('番茄钟：一轮番茄结束**不会**把任务标记为完成', () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '英语阅读', plannedMinutes: 120, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks[0];

  env.pomodoro.startFocus({ taskId: task.id, taskTitle: task.title });
  env.advance(25 * 60_000);
  env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  const after = env.app.getState().tasks.find((item) => item.id === task.id);
  assert.equal(after.status, 'not_started', '计时结束不等于任务完成，必须由用户决定');
  assert.equal(after.plannedMinutes, 120, '任务计划时长不会被计时改写');
});

test('番茄钟：暂停期间的真实时间不计入专注', () => {
  const env = makeEnv();
  env.pomodoro.startFocus({});

  env.advance(5 * 60_000);
  env.pomodoro.resumeMarkPause();
  const paused = env.pomodoro.pause();
  assert.equal(paused.ok, true);

  env.advance(30 * 60_000); // 暂停了半小时
  env.pomodoro.resume();

  env.advance(20 * 60_000); // 恢复后再专注 20 分钟，正好走完 25 分钟
  const ended = env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  assert.equal(ended.completed, true);
  assert.equal(ended.focusedSeconds, 1500, '暂停的 30 分钟没有被计入');
});

test('番茄钟：完整走完一轮后进入休息阶段选项（不自动开始，除非用户开启）', () => {
  const env = makeEnv();
  env.pomodoro.startFocus({});
  env.advance(25 * 60_000);
  const ended = env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  assert.equal(ended.nextPhase, 'short_break');
  assert.equal(ended.autoStarted, false, '默认不自动进入下一阶段');
  assert.equal(env.pomodoro.getTimer().phase, 'idle', '阶段结束后回到空闲，由用户决定下一步');

  const session = env.pomodoro.startBreak({ long: false });
  assert.equal(session.ok, true);
  assert.equal(session.timer.phase, 'short_break');
  assert.equal(session.timer.durationSeconds, 5 * 60);
});

test('番茄钟：开启自动进入下一阶段后，休息会立刻开始', () => {
  const env = makeEnv();
  env.pomodoro.setConfig({ autoStartNext: true });
  env.pomodoro.startFocus({});
  env.advance(25 * 60_000);
  const ended = env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  assert.equal(ended.autoStarted, true);
  assert.equal(env.pomodoro.getTimer().phase, 'short_break');
});

test('番茄钟：休息阶段不写入学习记录（休息不是学习投入）', () => {
  const env = makeEnv();
  env.pomodoro.startBreak({ long: false });
  env.advance(5 * 60_000);
  const ended = env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });

  assert.equal(ended.focusedSeconds, 0, '休息阶段的"专注时长"为 0');
  assert.equal(env.app.getState().focusRecords.length, 0, '不应产生学习记录');
});

test('番茄钟：放弃不会写入任何记录', () => {
  const env = makeEnv();
  env.pomodoro.startFocus({});
  env.advance(10 * 60_000);
  env.pomodoro.discard();

  assert.equal(env.app.getState().focusRecords.length, 0);
  assert.equal(env.pomodoro.getTimer().phase, 'idle');
});

test('番茄钟：设置会被保存并在刷新后保留', () => {
  const env = makeEnv();
  env.pomodoro.setConfig({ focusMinutes: 45, shortBreakMinutes: 8, roundsBeforeLongBreak: 3 });
  const config = env.pomodoro.readConfig();
  assert.equal(config.focusMinutes, 45);
  assert.equal(config.shortBreakMinutes, 8);
  assert.equal(config.roundsBeforeLongBreak, 3);
  assert.equal(env.appearance.getPreferences().focus.focusMinutes, 45, '写入了偏好（可持久化）');
});

test('番茄钟：设置值有边界保护（不会接受 0 或超大值）', () => {
  const env = makeEnv();
  env.pomodoro.setConfig({ focusMinutes: 0, shortBreakMinutes: 9999, roundsBeforeLongBreak: -3 });
  const config = env.pomodoro.readConfig();
  assert.equal(config.focusMinutes, 1, '最小 1 分钟');
  assert.equal(config.shortBreakMinutes, 60, '最大 60 分钟');
  assert.equal(config.roundsBeforeLongBreak, 1, '最小 1 轮');
});

/* ================================================================== *
 * 奖励：资格推导、防重复、结果与动画一致
 * ================================================================== */

test('奖励：资格由真实进度推导——没有学习记录时没有机会', () => {
  const env = makeEnv();
  const eligibility = env.rewards.eligibility();
  assert.equal(eligibility.totalRemaining, 0);
  assert.ok(eligibility.perTrigger.some((item) => item.trigger === REWARD_TRIGGER.FOCUS_MINUTES && item.enabled));
});

test('奖励：累计专注达到阈值后获得机会，且同一份进度只能兑换一次', () => {
  const env = makeEnv();
  // 直接构造两条真实的专注记录（共 60 分钟）
  env.app.commit(
    (state) => ({
      ...state,
      focusRecords: [
        { id: 'f1', date: NOW.date, focusedSeconds: 1500, completed: true },
        { id: 'f2', date: NOW.date, focusedSeconds: 1500, completed: true },
      ],
    }),
    { reason: 'test-seed' },
  );

  // 默认阈值 25 分钟 → 60 分钟 = 2 次机会
  const first = env.rewards.eligibility();
  assert.equal(first.totalRemaining, 2);

  const drawn = env.rewards.draw();
  assert.equal(drawn.ok, true);
  const after = env.rewards.eligibility();
  assert.equal(after.totalRemaining, 1, '抽一次只消耗一次机会');
});

test('奖励：反复调用写进度不会重复发奖（幂等）', () => {
  const state = {
    sessions: [{ state: 'completed', actualMinutes: 120 }],
    focusRecords: [{ focusedSeconds: 900, completed: true }],
    tasks: [{ status: 'completed' }, { status: 'completed' }],
  };
  const triggers = defaultPreferences().rewards.triggers;

  const progress = computeProgress(state);
  const a = computeEntitlement({ progress, triggers, ledger: {} });
  const b = computeEntitlement({ progress, triggers, ledger: {} });
  assert.deepEqual(a.totalRemaining, b.totalRemaining, '同样的进度必须算出同样的机会数');

  // 已经用掉一次之后，机会数只减少一次
  const ledger = { [REWARD_TRIGGER.FOCUS_MINUTES]: 1 };
  const c = computeEntitlement({ progress, triggers, ledger });
  assert.equal(c.totalRemaining, a.totalRemaining - 1);
});

test('奖励：中奖结果与转盘角度所依据的下标一致（不会"动画停 A、结果 B"）', () => {
  const env = makeEnv();
  env.app.commit(
    (state) => ({ ...state, focusRecords: [{ id: 'f1', date: NOW.date, focusedSeconds: 3600, completed: true }] }),
    { reason: 'test-seed' },
  );

  const items = env.rewards.listItems({ includeDisabled: false });
  const result = env.rewards.draw();
  assert.equal(result.ok, true);

  // 服务返回的下标必须在奖项列表范围内，且指向同一个奖项
  assert.ok(result.index >= 0 && result.index < items.length);
  assert.equal(items[result.index].id, result.item.id, '下标必须指向被抽中的那个奖项');
  assert.equal(result.entry.label, result.item.label, '记录里的奖项与返回结果一致');
});

test('奖励：只启用一个奖项时如实告知结果被固定，不假装是随机', () => {
  const env = makeEnv();
  env.app.commit(
    (state) => ({ ...state, focusRecords: [{ id: 'f1', date: NOW.date, focusedSeconds: 3600, completed: true }] }),
    { reason: 'test-seed' },
  );
  // 只留下一个启用项
  const items = env.rewards.listItems();
  for (const item of items.slice(1)) env.rewards.toggleItem(item.id, false);

  const result = env.rewards.draw();
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
  assert.match(result.message, /只有一个|一定是它/);
});

test('奖励：没有机会时拒绝抽奖，并解释如何获得机会', () => {
  const env = makeEnv();
  const result = env.rewards.draw();
  assert.equal(result.ok, false);
  assert.match(result.message, /没有抽奖机会|完成/);
});

test('奖励：奖项管理（新增/编辑/启用/删除）与至少保留一项的保护', () => {
  const env = makeEnv();

  const added = env.rewards.addItem({ label: '看一集动画', emoji: '📺', weight: 2 });
  assert.equal(added.ok, true);
  assert.equal(env.rewards.listItems().some((item) => item.id === added.item.id), true);

  const renamed = env.rewards.updateItem(added.item.id, { label: '看动画 20 分钟', weight: 5 });
  assert.equal(renamed.ok, true);
  const updated = env.rewards.listItems().find((item) => item.id === added.item.id);
  assert.equal(updated.label, '看动画 20 分钟');
  assert.equal(updated.weight, 5);

  env.rewards.toggleItem(added.item.id, false);
  assert.equal(env.rewards.listItems({ includeDisabled: false }).some((item) => item.id === added.item.id), false);

  // 空名称与超长名称被拒绝/截断
  assert.equal(env.rewards.addItem({ label: '   ' }).ok, false);
  const long = env.rewards.addItem({ label: 'x'.repeat(50) });
  assert.equal(long.ok, false, '超长名称应被拒绝而不是悄悄截断');
  assert.match(long.message, /30/);

  // 删除到只剩一项时会被拒绝（否则转盘无法转动）
  const all = env.rewards.listItems();
  for (const item of all.slice(1)) {
    const removed = env.rewards.removeItem(item.id);
    assert.equal(removed.ok, true, `应能删除 ${item.label}`);
  }
  const remaining = env.rewards.listItems();
  assert.equal(remaining.length, 1);
  const refused = env.rewards.removeItem(remaining[0].id);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /至少/);
});

test('奖励：恢复默认奖项会替换列表，但历史记录保留', () => {
  const env = makeEnv();
  env.app.commit(
    (state) => ({
      ...state,
      focusRecords: [{ id: 'f1', date: NOW.date, focusedSeconds: 3600, completed: true }],
    }),
    { reason: 'test-seed' },
  );
  env.rewards.draw();
  const historyBefore = env.rewards.history().length;

  env.rewards.removeItem(env.rewards.listItems()[0].id);
  const restored = env.rewards.restoreDefaults();
  assert.equal(restored.ok, true);
  assert.equal(env.rewards.listItems().length, DEFAULT_REWARDS.length);
  assert.equal(env.rewards.history().length, historyBefore, '历史不受影响');
});

test('奖励：中奖记录与实际抽奖次数一致，并可以标记为已领取', () => {
  const env = makeEnv();
  env.app.commit(
    // 30 分钟专注，阈值 25 分钟 → 恰好 1 次机会
    (state) => ({ ...state, focusRecords: [{ id: 'f1', date: NOW.date, focusedSeconds: 1800, completed: true }] }),
    { reason: 'test-seed' },
  );

  const first = env.rewards.draw();
  const second = env.rewards.draw();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, '30 分钟只够换 1 次机会（阈值 25 分钟）');

  const history = env.rewards.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].claimedAt, null);

  assert.equal(env.rewards.markClaimed(history[0].id).ok, true);
  assert.ok(env.rewards.history()[0].claimedAt, '确认领取后记录领取时间');

  const stats = env.rewards.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.claimed, 1);
});

/* ================================================================== *
 * 统计：口径正确、空数据如实
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
  assert.equal(env.stats.focus().totalRounds, 0);
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

test('统计：番茄统计区分完成与提前结束', () => {
  const env = makeEnv();
  env.app.commit(
    (state) => ({
      ...state,
      focusRecords: [
        { id: 'f1', date: NOW.date, focusedSeconds: 1500, completed: true, taskTitle: '数学' },
        { id: 'f2', date: NOW.date, focusedSeconds: 600, completed: false, taskTitle: '数学' },
        { id: 'f3', date: NOW.date, focusedSeconds: 1500, completed: true, taskTitle: '英语' },
      ],
    }),
    { reason: 'test-seed' },
  );

  const focus = env.stats.focus();
  assert.equal(focus.completedRounds, 2);
  assert.equal(focus.earlyEndedRounds, 1);
  assert.equal(focus.totalMinutes, 60, '(1500 + 600 + 1500) / 60 = 60 分钟');
  assert.equal(focus.completedMinutes, 50);
  assert.equal(focus.averageCompletedMinutes, 25);
  assert.ok(Math.abs(focus.completionRate - 2 / 3) < 1e-9);
  assert.equal(focus.byTask[0].taskTitle, '数学');
});

/* ================================================================== *
 * 数据持久化：刷新后一切仍在
 * ================================================================== */

test('持久化：任务、时段、番茄记录、奖励历史、奖励账本在同一份数据里往返', async () => {
  const env = makeEnv();
  env.services.taskService.addTask(taskInput({ title: '线性代数作业', plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks[0];

  env.pomodoro.startFocus({ taskId: task.id, taskTitle: task.title });
  env.advance(25 * 60_000);
  env.pomodoro.endPhase({ reason: END_REASON.COMPLETED });
  env.rewards.draw();

  const before = env.app.getState();
  assert.ok(before.focusRecords.length > 0);
  assert.ok((before.rewardHistory ?? []).length > 0 || (before.rewardLedger ?? {}) !== undefined);

  // 导出 → 在空白应用里导入
  const text = serializeBackup(buildBackup(before, { nowIso: env.app.clock() }));
  const target = createTestApp();
  const imported = await target.app.importBackup(text);

  assert.equal(imported.ok, true, imported.issues?.map((i) => i.message).join('; '));
  const after = target.app.getState();
  assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.sessions.length, before.sessions.length);
  assert.equal(after.focusRecords.length, before.focusRecords.length, '番茄记录被完整导出与导入');
  assert.equal(after.focusRecords[0].focusedSeconds, 1500);
  assert.equal(after.rewardHistory.length, before.rewardHistory.length, '奖励历史被完整导出与导入');
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
  assert.deepEqual(state.focusRecords, [], '缺少的新字段补为空数组');
  assert.deepEqual(state.rewardHistory, [], '缺少的新字段补为空数组');
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
