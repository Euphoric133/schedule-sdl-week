/**
 * 应用入口：把所有层装配起来（存储 → 服务 → 界面）。
 *
 * 依赖方向（保持单向，不要打破）：
 *   ui  →  services  →  { domain, storage }
 *   engine 只依赖 domain，不依赖 ui / storage / services
 *
 * 本文件不做任何业务判断：只负责选择适配器、注入时钟与 ID 工厂、注册路由。
 */

import { createAppState } from './services/appState.js';
import { createTaskService } from './services/taskService.js';
import { createPlanService } from './services/planService.js';
import { createFocusService } from './services/focusService.js';
import { createFixedActivityService } from './services/fixedActivityService.js';
import { createRestService } from './services/restService.js';
import { createAppearanceService } from './services/appearanceService.js';
import { createNotificationService } from './services/notificationService.js';
import { createStatsService } from './services/statsService.js';
import { loadPreferences, savePreferences } from './services/preferences.js';
import { createIdFactory } from './domain/ids.js';
import { applyDraftOp } from './domain/mutations.js';
import { confirmDialog } from './ui/modal.js';
import { toast } from './ui/dom.js';
import { addDays, wallTimeFromDateObject } from './domain/time.js';
import { createShell } from './ui/shell.js';
import { startRouter } from './ui/router.js';
import { renderToday } from './ui/pages/today.js';
import { renderWeek } from './ui/pages/week.js';
import { renderTasks } from './ui/pages/tasks.js';
import { renderPreview } from './ui/pages/preview.js';
import { renderSettings } from './ui/pages/settings.js';
import { renderDay } from './ui/pages/day.js';
import { renderHome } from './ui/pages/home.js';
import { renderAppearance } from './ui/pages/appearance.js';
import { renderNotifications } from './ui/pages/notifications.js';
import { renderStats } from './ui/pages/stats.js';
import { renderActivities } from './ui/pages/activities.js';
import { renderVersions } from './ui/pages/versions.js';
import { openTaskForm } from './ui/forms/taskForm.js';
import { openFixedActivityForm } from './ui/forms/fixedActivityForm.js';
import { openRestForm } from './ui/forms/restForm.js';
import { openSessionDetail } from './ui/forms/sessionDetail.js';

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 界面服务：把"打开表单 / 触发预览 / 应用或撤销"这类跨页面动作集中在一处，
 * 避免页面之间互相 import，也保证所有写操作都经过同一套"预览 → 确认"流程。
 *
 * 约定：这里的每个方法都返回 `{ ok, message?, preview?, plan? }`，绝不抛异常给页面。
 * 页面只需要根据 ok 决定是否 toast 提示，不用关心引擎与事务细节。
 */
function createUiService({ services }) {
  /** 统一处理一次"带数据变更的预览请求" */
  function previewWith(ops, options = {}) {
    const result = services.planService.requestPreview({
      now: services.now(),
      ops,
      changeSummary: options.changeSummary,
      trigger: options.trigger ?? 'ui',
    });
    if (!result.ok) {
      const first = result.issues?.[0];
      return {
        ok: false,
        message: first?.message ?? '无法生成计划预览。',
        issues: result.issues ?? [],
        status: result.status ?? null,
      };
    }
    if (options.navigate !== false) globalThis.location.hash = '#/preview';
    return { ok: true, preview: result.preview };
  }

  /** 仅重新规划（不修改任何数据），例如用户手动点"重新规划" */
  function replan(options = {}) {
    return previewWith([], { ...options, changeSummary: options.changeSummary ?? '重新规划' });
  }

  return {
    /** 当前本地日期（表单默认值等使用；由入口的时钟注入，便于测试固定时间） */
    today: () => services.now().date,

    /** 打开任务表单（新建或编辑） */
    openTaskForm(taskId) {
      const task = taskId ? services.taskService.getTask(taskId) : null;
      openTaskForm({ task, services });
    },

    /** 打开固定活动表单 */
    openFixedActivityForm(activityId) {
      const activity = activityId ? services.fixedActivityService.get(activityId) : null;
      openFixedActivityForm({ activity, services });
    },

    /** 打开休息时间表单（新建或编辑） */
    openRestForm(restId) {
      const rest = restId ? services.restService.get(restId) : null;
      openRestForm({ rest, services });
    },

    /**
     * 把一段学习标记为已完成（走"候选计划 → 预览 → 确认"的既有流程，
     * 这样任务状态与计划时段的一致性由同一条路径保证）。
     */
    completeSession(card) {
      return this.previewWith(
        [{ kind: 'session.complete', sessionId: card.sessionId, actualMinutes: card.minutes }],
        { changeSummary: '记录一段已完成的学习', trigger: 'plan-board' },
      );
    },

    /**
     * 删除一个学习任务。
     *
     * 为什么这里是"直接删除"而不是走预览：
     * 删除任务本身是用户明确的意图，且 `task.delete` 变更已经在同一次提交里
     * 通过 reconcile 取消了它的未完成时段——因此不会留下孤立时段，
     * 也不会因为"剩余工作量与时段数量不一致"被校验拦住（用户报告的正是这个死结）。
     * 删除完成后提示用户可重新规划，把"是否重排"留给用户决定。
     */
    async deleteTask(taskId) {
      const impact = services.taskService.evaluateTaskImpact(taskId);
      if (!impact.ok) {
        toast(impact.issues?.[0]?.message ?? '找不到这个任务。', 'error', 8000);
        return { ok: false, issues: impact.issues };
      }
      const info = impact.impact;
      const confirmed = await confirmDialog({
        title: `删除任务「${info.title}」？`,
        message: '任务会从列表和七天计划中移除，它未完成的学习时段也会一并取消。',
        bullets: [
          info.completedSessions > 0
            ? `已完成 ${info.completedSessions} 段学习记录会保留（成为历史，不影响统计口径）`
            : '没有已完成的学习记录',
          info.activeSessions > 0 ? `将取消 ${info.activeSessions} 个未完成的时段` : '没有未完成的时段',
          info.dependents.length > 0
            ? `有 ${info.dependents.length} 个任务依赖它：${info.dependents.map((item) => item.title).join('、')}`
            : '没有其它任务依赖它',
        ],
        confirmLabel: '删除',
        confirmVariant: 'danger',
      });
      if (!confirmed) return { ok: false, cancelled: true };

      const result = services.taskService.deleteTask(taskId, { hard: info.canHardDelete });
      if (!result.ok) {
        toast(result.error?.message ?? result.issues?.[0]?.message ?? '删除失败，数据没有被修改。', 'error', 9000);
        return result;
      }
      toast('任务已删除。需要重新安排其它任务时，可以点「重新规划」。', 'success', 6000);
      return result;
    },

    /**
     * 保存一条休息安排（新增或修改）。
     *
     * 为什么不像学习任务那样走"候选计划预览"：
     * 休息不参与排程（不会被移动、也不会改变学习任务的位置），
     * 因此没有必要让用户为它确认一整份计划差异。
     * 但它仍然是**同一次原子提交**，失败时数据保持原样。
     */
    saveRest(op) {
      const applied = applyDraftOp(app.getState(), op, { idFactory, nowIso: nowIso() });
      if (!applied.ok) return { ok: false, issues: applied.issues ?? [] };
      const written = app.commit(() => applied.state, { reason: op.kind });
      if (!written.ok) {
        return { ok: false, issues: [{ severity: 'error', message: written.error?.message ?? '保存失败，数据没有被修改。' }] };
      }
      return { ok: true, createdId: applied.createdId ?? null };
    },

    /** 删除一条休息安排（它的所有日期片段会一起消失） */
    async deleteRest(restId) {
      const rest = services.restService.get(restId);
      if (!rest) {
        toast('这条休息时间已经不存在。', 'error');
        return { ok: false };
      }
      const dates = services.restService.datesOf(restId);
      const confirmed = await confirmDialog({
        title: `删除休息时间「${rest.title}」？`,
        message: '这次休息在所有日期的显示都会一起移除。',
        bullets: dates.length > 1 ? [`涉及 ${dates.length} 天：${dates.join('、')}`] : ['只涉及 1 天'],
        confirmLabel: '删除',
        confirmVariant: 'danger',
      });
      if (!confirmed) return { ok: false, cancelled: true };

      const applied = applyDraftOp(app.getState(), { kind: 'rest.remove', restId }, { idFactory, nowIso: nowIso() });
      if (!applied.ok) {
        toast(applied.issues?.[0]?.message ?? '删除失败。', 'error');
        return { ok: false, issues: applied.issues };
      }
      const written = app.commit(() => applied.state, { reason: 'rest-remove' });
      if (!written.ok) {
        toast(written.error?.message ?? '删除失败，数据没有被修改。', 'error');
        return { ok: false };
      }
      toast('休息时间已删除。', 'success');
      return { ok: true };
    },

    /** 打开时段详情抽屉 */
    openSessionDetail(sessionId) {
      openSessionDetail({ sessionId, services });
    },

    /** 触发重新规划（无数据变更） */
    requestPreview: replan,

    /** 带数据变更的预览（任务表单、设置页、时段操作都走这里） */
    previewWith,

    /** 应用待确认计划 */
    applyPreview: () => services.planService.applyPreview(),
    /** 放弃待确认计划 */
    discardPreview: () => services.planService.discardPreview(),
    /** 撤销上一次计划变更 */
    undoLastPlan: () => services.planService.undoLastApply(),

    /**
     * 清理历史记录（用户显式触发；绝不自动删除）。
     * @param {Array<object>} ops 清理操作
     */
    cleanup(ops) {
      return services.planService.applyCleanup(ops);
    },

    /** 导入前的预览（校验但不写入） */
    previewImport: (text) => services.app.previewImport(text),

    /** 把计划窗口向前/向后移动若干天（保留已完成历史，重排未来七天） */
    shiftWindow(days) {
      const current = services.planService.getOfficialPlan();
      const base = current?.windowStart ?? services.now().date;
      const windowStart = addDays(base, days);
      return previewWith([{ kind: 'window.shift', windowStart, windowDays: 7 }], {
        changeSummary: `把计划窗口移动到 ${windowStart}`,
        trigger: 'window-shift',
      });
    },
  };
}

/**
 * 启动应用。
 * @param {object} [options]
 * @param {HTMLElement} [options.root] 挂载点
 * @param {() => Date} [options.clock] 时钟（测试可注入固定时间，保证渲染可复现）
 */
export function boot({ root = document.getElementById('app'), clock } = {}) {
  /** shell 在下面创建；外观变化回调可能在创建之前被触发，因此先声明 */
  let shell = null;
  if (!root) throw new Error('找不到挂载点 #app');

  const idFactory = createIdFactory();
  const readNow = typeof clock === 'function' ? clock : () => new Date();
  const nowIso = () => readNow().toISOString();

  const app = createAppState({ clock: nowIso });
  const loadReport = app.load();

  const services = {
    app,
    idFactory,
    now: () => wallTimeFromDateObject(readNow()),
  };

  services.taskService = createTaskService({ app, idFactory });
  services.fixedActivityService = createFixedActivityService({ app, idFactory });
  services.restService = createRestService({ app });

  /* —— 界面偏好与外观（主题、壁纸）—— */
  services.preferences = loadPreferences();
  services.appearanceService = createAppearanceService({
    preferences: services.preferences,
    onChange: (next) => {
      services.preferences = next;
      // 这里**刻意不触发整页重绘**。
      // 原因：主题与壁纸是通过 <html> 上的属性与 CSS 变量生效的，改动后浏览器会立刻重绘；
      // 如果再强制重建 DOM，会丢掉表单里正在输入的内容、打断动画，
      // 还会把重绘调度推到当前任务之后（在测试或快速切页时可能落到已卸载的环境里）。
      // 需要刷新自身状态的页面（设置页）用订阅回调局部更新自己。
    },
  });

  /* —— 通知提醒 —— */
  services.notificationService = createNotificationService({
    appearanceService: services.appearanceService,
    now: () => services.now(),
    clock: nowIso,
  });

  /* —— 学习统计 —— */
  services.statsService = createStatsService({ app, now: () => services.now() });
  services.planService = createPlanService({ app, idFactory });
  services.focusService = createFocusService({ app, idFactory, now: services.now });
  services.ui = createUiService({ services });

  const todayWall = services.now();
  // 主题必须在任何渲染之前落到 <html> 上：否则浅色主题下会先闪一下白底。
  services.appearanceService.applyAll();

  const pages = {
    home: renderHome,
    today: renderToday,
    week: renderWeek,
    day: renderDay,
    tasks: renderTasks,
    activities: renderActivities,
    preview: renderPreview,
    versions: renderVersions,
    settings: renderSettings,
    appearance: renderAppearance,
    notifications: renderNotifications,
    stats: renderStats,
  };

  shell = createShell({
    root,
    app,
    services,
    pages,
    now: services.now,
    todayInfo: { date: todayWall.date, weekday: WEEKDAY_LABELS[todayWall.weekday - 1] },
  });

  // 数据变化 → 重新渲染当前页面（合帧，避免一次操作触发多次重绘）
  let scheduled = false;
  app.subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    const schedule = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 0));
    schedule(() => {
      scheduled = false;
      shell.render();
    });
  });

  startRouter((route) => shell.render(route));

  // 恢复上次保存的壁纸（IndexedDB 异步，不阻塞首屏）
  services.appearanceService.restoreWallpaper();

  // 通知调度：只有在"支持 + 已授权 + 用户开启"时才会真正生效（服务内部判断）
  services.notificationService.schedule(() => ({
    sessions: app.getState().sessions ?? [],
    tasks: app.getState().tasks ?? [],
    plan: app.getState().officialPlan,
  }));
  services.notificationService.handleVisibility();

  return { app, services, shell, loadReport };
}

// 浏览器环境自动启动；测试环境（无 DOM）导入本模块不会产生副作用。
// 启动结果挂在 globalThis.__APP__ 上，便于在浏览器控制台排查问题（本地应用，不存在安全暴露面）。
if (typeof document !== 'undefined' && document.getElementById('app')) {
  const instance = boot();
  globalThis.__APP__ = instance;
}
