/**
 * 浏览器通知服务：真实权限状态 + 真实时间调度 + 不重复提醒。
 *
 * 必须区分三件不同的事，界面上也不能混淆：
 * 1. **浏览器权限**（Notification.permission）：由用户授权，应用无法绕过；
 * 2. **应用开关**（偏好里的 notifications.enabled）：用户是否希望收到提醒；
 * 3. **页面内提示条**（toast）：与应用内弹窗是两种完全不同的东西。
 *
 * 调度的可靠性边界（如实告知，不夸大）：
 * - 页面打开时：使用 `setInterval` + **真实时间戳**比较，不依赖"每秒减一"的计数；
 *   计算机休眠或标签页被节流后，下一次检查会用真实时间补齐，不会漂移。
 * - 页面完全关闭后：本应用**不做**这种提醒。Web Notification 在没有 Service Worker
 *   与推送服务的情况下无法在页面关闭后触发；要支持它需要 HTTPS、Service Worker、
 *   推送服务器与用户订阅，属于另一个量级的工程，本项目不承诺、也不假装支持。
 */

import { NOTIFICATION_TYPE } from './preferences.js';

/** 检查间隔：30 秒。用真实时间比较，因此不需要更密集。 */
const CHECK_INTERVAL_MS = 30_000;

/** 已提醒记录的存储键（持久化，保证刷新页面不会重复提醒） */
const LEDGER_KEY = 'studyPlanner:v1:notified';

/** 通知类型的中文文案模板 */
export const NOTIFICATION_TYPE_LABELS_ZH = Object.freeze({
  [NOTIFICATION_TYPE.SESSION_SOON]: '下一项学习即将开始',
  [NOTIFICATION_TYPE.PLAN_START]: '今天的计划开始时间',
  [NOTIFICATION_TYPE.FOCUS_END]: '专注计时结束',
  [NOTIFICATION_TYPE.DAILY_SUMMARY]: '今日计划概览',
});

/** 浏览器原生权限状态 → 界面可读文案 */
export function describePermission(permission, supported) {
  if (!supported) {
    return {
      level: 'unsupported',
      label: '当前浏览器不支持通知',
      detail: '这个浏览器没有提供通知能力（常见于部分移动端浏览器或隐私模式）。页面内的提示条仍然可用。',
      canRequest: false,
    };
  }
  switch (permission) {
    case 'granted':
      return { level: 'granted', label: '已允许', detail: '浏览器已允许本应用发送通知。', canRequest: false };
    case 'denied':
      return {
        level: 'denied',
        label: '已被拒绝',
        detail:
          '你之前拒绝了通知权限。浏览器不允许网页再次弹出授权询问，需要你在浏览器的地址栏图标（或"网站设置 → 通知"）里手动改回"允许"，然后回到本页重新开启。',
        canRequest: false,
      };
    default:
      return { level: 'default', label: '尚未授权', detail: '还没有向浏览器申请通知权限。点击"启用通知"时会发起申请。', canRequest: true };
  }
}

/**
 * @param {object} options
 * @param {object} options.appearanceService 读取/更新偏好
 * @param {Function} options.now 返回 { date, minutes }（由入口注入固定时钟，便于测试）
 * @param {Function} [options.clock] 返回 ISO 时间字符串
 */
export function createNotificationService({ appearanceService, now, clock }) {
  let timer = null;
  let lastCheck = null;
  const recent = []; // 本次页面会话内已发出的通知（用于界面展示"刚才提醒了什么"）

  function supported() {
    return typeof globalThis.Notification === 'function';
  }

  function permission() {
    if (!supported()) return 'unsupported';
    return globalThis.Notification.permission ?? 'default';
  }

  function status() {
    const prefs = appearanceService.getPreferences().notifications;
    const described = describePermission(permission(), supported());
    return {
      ...described,
      enabled: prefs.enabled,
      // 真正"能收到通知"的条件：支持 + 已授权 + 用户开着开关
      active: supported() && permission() === 'granted' && prefs.enabled,
      advanceMinutes: prefs.advanceMinutes,
      types: prefs.types,
      quietHours: prefs.quietHours,
      lastCheck,
      recent: [...recent],
    };
  }

  /**
   * 申请权限。**只在用户点击按钮时调用**（浏览器要求用户手势），
   * 绝不在页面加载时自动弹窗。
   */
  async function requestPermission() {
    if (!supported()) {
      return { ok: false, permission: 'unsupported', message: '当前浏览器不支持通知，无法启用。' };
    }
    if (globalThis.Notification.permission === 'denied') {
      return {
        ok: false,
        permission: 'denied',
        message:
          '浏览器已经拒绝过通知权限，网页无法再次弹出询问。请在浏览器地址栏的图标里（或"网站设置 → 通知"）改为"允许"，然后回来重试。',
      };
    }
    try {
      const result = await globalThis.Notification.requestPermission();
      appearanceService.updatePreferences((prefs) => ({
        ...prefs,
        notifications: { ...prefs.notifications, permission: result },
      }));
      if (result === 'granted') {
        return { ok: true, permission: result, message: '已获得通知权限，可以在下面开启具体提醒类型。' };
      }
      if (result === 'denied') {
        return {
          ok: false,
          permission: result,
          message: '你拒绝了通知权限。应用不会发送任何通知；如果改变主意，可以在浏览器网站设置里重新允许。',
        };
      }
      return { ok: false, permission: result, message: '还没有授权。你可以稍后再点一次"启用通知"。' };
    } catch {
      return { ok: false, permission: permission(), message: '申请通知权限时出错，请检查浏览器设置后重试。' };
    }
  }

  /** 开启 / 关闭应用内提醒开关 */
  function setEnabled(enabled) {
    if (enabled && !supported()) {
      return { ok: false, message: '当前浏览器不支持通知，无法开启。' };
    }
    if (enabled && permission() !== 'granted') {
      return {
        ok: false,
        message:
          permission() === 'denied'
            ? '浏览器权限被拒绝，需要先在浏览器网站设置里允许通知。'
            : '还没有获得浏览器授权，请先点"启用通知"。',
      };
    }
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      notifications: { ...prefs.notifications, enabled: Boolean(enabled), permission: permission() },
    }));
    if (enabled) schedule();
    else stop();
    return { ok: true, message: enabled ? '已开启学习提醒。' : '已关闭学习提醒。' };
  }

  function setAdvanceMinutes(minutes) {
    const value = Math.min(120, Math.max(0, Math.round(Number(minutes) || 0)));
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      notifications: { ...prefs.notifications, advanceMinutes: value },
    }));
    return { ok: true, advanceMinutes: value };
  }

  function setType(type, enabled) {
    if (!Object.values(NOTIFICATION_TYPE).includes(type)) return { ok: false, message: '未知的提醒类型。' };
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      notifications: { ...prefs.notifications, types: { ...prefs.notifications.types, [type]: Boolean(enabled) } },
    }));
    return { ok: true };
  }

  function setQuietHours(patch = {}) {
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      notifications: { ...prefs.notifications, quietHours: { ...prefs.notifications.quietHours, ...patch } },
    }));
    return { ok: true };
  }

  /* ---------------- 已提醒记录（保证不重复） ---------------- */

  function readLedger() {
    try {
      const raw = globalThis.localStorage?.getItem(LEDGER_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeLedger(ledger) {
    try {
      globalThis.localStorage?.setItem(LEDGER_KEY, JSON.stringify(ledger));
    } catch {
      /* 写不进去只影响"刷新后不重复"的能力，不影响本次提醒 */
    }
  }

  /** 清理超过两天前的记录，避免无限增长 */
  function pruneLedger(ledger, todayDate) {
    const cutoff = new Date(`${todayDate}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - 2);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const output = {};
    for (const [key, value] of Object.entries(ledger)) {
      const day = String(value?.at ?? '').slice(0, 10);
      if (day >= cutoffKey) output[key] = value;
    }
    return output;
  }

  function alreadyNotified(key) {
    return Boolean(readLedger()[key]);
  }

  function markNotified(key, extra = {}) {
    const ledger = readLedger();
    ledger[key] = { at: new Date(clock?.() ?? Date.now()).toISOString(), ...extra };
    writeLedger(pruneLedger(ledger, now().date));
  }

  /* ---------------- 静音时段 ---------------- */

  function inQuietHours(minutesOfDay) {
    const quiet = appearanceService.getPreferences().notifications.quietHours;
    if (!quiet.enabled) return false;
    const { startMinutes, endMinutes } = quiet;
    // 跨午夜的区间（例如 22:00 → 07:00）
    if (startMinutes <= endMinutes) return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
    return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
  }

  /* ---------------- 发送 ---------------- */

  function deliver({ key, type, title, body, tag }) {
    if (alreadyNotified(key)) return { ok: false, reason: 'duplicate' };
    if (!appearanceService.getPreferences().notifications.types[type]) return { ok: false, reason: 'type-disabled' };
    if (!supported() || permission() !== 'granted') return { ok: false, reason: 'no-permission' };

    try {
      const notification = new globalThis.Notification(title, {
        body,
        tag: tag ?? key, // 相同 tag 会替换而不是叠加
        icon: undefined,
        silent: false,
      });
      notification.onclick = () => {
        globalThis.focus?.();
        notification.close?.();
      };
    } catch {
      return { ok: false, reason: 'failed' };
    }

    markNotified(key, { type, title, body });
    recent.unshift({ at: new Date(clock?.() ?? Date.now()).toISOString(), type, title, body });
    if (recent.length > 10) recent.pop();
    return { ok: true };
  }

  /** 供测试与"立即试一条"使用：直接发一条通知（仍然遵守权限与开关） */
  function sendTest() {
    return deliver({
      key: `test:${now().date}:${now().minutes}`,
      type: NOTIFICATION_TYPE.SESSION_SOON,
      title: '测试通知',
      body: '如果你看到了这条通知，说明提醒功能可以正常工作。',
      tag: 'test',
    });
  }

  /* ---------------- 调度 ---------------- */

  /** 每次检查时用于构造上下文的回调（由 schedule 注入，避免持有过期数据） */
  let getContext = () => ({});


  /**
   * 一次检查：根据**真实时间**判断是否有需要提醒的事项。
   * @param {object} context
   * @param {Array<object>} context.sessions 当前全部学习时段
   * @param {object|null} context.plan 正式计划
   * @param {object|null} context.runningFocus 正在进行的专注（含 endsAt 时间戳）
   */
  function check(context = {}) {
    lastCheck = new Date(clock?.() ?? Date.now()).toISOString();
    const prefs = appearanceService.getPreferences().notifications;
    if (!prefs.enabled || !supported() || permission() !== 'granted') return { fired: 0 };

    const current = now();
    if (inQuietHours(current.minutes)) return { fired: 0, quiet: true };

    let fired = 0;

    // 1) 专注计时结束：用绝对时间戳比较，页面被节流后也能补上
    const focus = context.runningFocus;
    if (focus?.endsAtMs && Number.isFinite(focus.endsAtMs)) {
      const remainingMs = focus.endsAtMs - Date.now();
      if (remainingMs <= 0) {
        const result = deliver({
          key: `focus_end:${focus.sessionId}:${focus.endsAtMs}`,
          type: NOTIFICATION_TYPE.FOCUS_END,
          title: '专注结束',
          body: `${focus.taskTitle ?? '当前任务'}的专注时间到了。休息一下，或者继续下一轮。`,
          tag: `focus-${focus.sessionId}`,
        });
        if (result.ok) fired += 1;
      }
    }

    // 2) 下一项学习即将开始
    if (prefs.types[NOTIFICATION_TYPE.SESSION_SOON]) {
      const upcoming = (context.sessions ?? [])
        .filter((session) => session.date === current.date && session.state === 'flexible' && !session.locked)
        .filter((session) => session.startMinutes > current.minutes)
        .sort((a, b) => a.startMinutes - b.startMinutes)[0];

      if (upcoming) {
        const minutesUntil = upcoming.startMinutes - current.minutes;
        if (minutesUntil <= prefs.advanceMinutes) {
          const result = deliver({
            key: `session_soon:${upcoming.id}:${current.date}`,
            type: NOTIFICATION_TYPE.SESSION_SOON,
            title: `${prefs.advanceMinutes > 0 ? `${prefs.advanceMinutes} 分钟后` : '马上'}开始学习`,
            body: `${taskTitle(context, upcoming)}　${formatClock(upcoming.startMinutes)} 开始（${upcoming.plannedMinutes} 分钟）。`,
            tag: `session-${upcoming.id}`,
          });
          if (result.ok) fired += 1;
        }
      }
    }

    // 3) 今天的计划开始时间（每天只提醒一次）
    if (prefs.types[NOTIFICATION_TYPE.PLAN_START]) {
      const todaySessions = (context.sessions ?? []).filter((session) => session.date === current.date && session.state !== 'cancelled');
      const first = todaySessions.sort((a, b) => a.startMinutes - b.startMinutes)[0];
      if (first && first.startMinutes > current.minutes) {
        const minutesUntil = first.startMinutes - current.minutes;
        if (minutesUntil <= prefs.advanceMinutes) {
          const result = deliver({
            key: `plan_start:${current.date}`,
            type: NOTIFICATION_TYPE.PLAN_START,
            title: '今天的学习从 ' + formatClock(first.startMinutes) + ' 开始',
            body: `今天共有 ${todaySessions.length} 个学习时段，合计 ${todaySessions.reduce((sum, s) => sum + s.plannedMinutes, 0)} 分钟。`,
            tag: `plan-start-${current.date}`,
          });
          if (result.ok) fired += 1;
        }
      }
    }

    // 4) 今日计划概览（每天一条，默认关闭）
    if (prefs.types[NOTIFICATION_TYPE.DAILY_SUMMARY]) {
      const todaySessions = (context.sessions ?? []).filter((session) => session.date === current.date && session.state !== 'cancelled');
      if (todaySessions.length > 0 && current.minutes >= 7 * 60) {
        const result = deliver({
          key: `daily_summary:${current.date}`,
          type: NOTIFICATION_TYPE.DAILY_SUMMARY,
          title: '今日学习概览',
          body: `今天安排了 ${todaySessions.length} 个时段，共 ${todaySessions.reduce((sum, s) => sum + s.plannedMinutes, 0)} 分钟。`,
          tag: `daily-${current.date}`,
        });
        if (result.ok) fired += 1;
      }
    }

    return { fired, checkedAt: lastCheck };
  }

  /**
   * 启动调度。
   * @param {() => object} buildContext 每次检查时构造上下文（避免持有过期数据）
   */
  function schedule(buildContext) {
    stop();
    const described = status();
    if (!described.active || typeof globalThis.setInterval !== 'function') return { ok: false, reason: 'inactive' };
    if (buildContext) getContext = buildContext;
    // 先立刻检查一次（页面可能刚从休眠或后台恢复）
    runCheck();
    timer = globalThis.setInterval(runCheck, CHECK_INTERVAL_MS);
    return { ok: true, intervalMs: CHECK_INTERVAL_MS };
  }

  function runCheck() {
    try {
      return check(getContext());
    } catch {
      return { fired: 0, error: true };
    }
  }

  function stop() {
    if (timer !== null) {
      globalThis.clearInterval?.(timer);
      timer = null;
    }
  }

  /** 页面重新可见时立刻补一次检查（标签页被节流期间可能错过了时间点） */
  function handleVisibility() {
    if (typeof document === 'undefined' || !document.addEventListener) return () => {};
    const onVisible = () => {
      if (document.visibilityState === 'visible') runCheck();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }

  function isScheduled() {
    return timer !== null;
  }

  return {
    supported,
    permission,
    status,
    requestPermission,
    setEnabled,
    setAdvanceMinutes,
    setType,
    setQuietHours,
    check,
    schedule,
    stop,
    isScheduled,
    sendTest,
    handleVisibility,
    /** 供测试清空"已提醒"记录 */
    resetLedger: () => writeLedger({}),
    alreadyNotified,
  };
}

function taskTitle(context, session) {
  const task = (context.tasks ?? []).find((item) => item.id === session.taskId);
  return task?.title ?? '学习任务';
}

function formatClock(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
