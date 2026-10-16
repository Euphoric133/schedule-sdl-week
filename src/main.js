/**
 * 应用入口：把所有层装配起来（存储 → 服务 → 界面）。
 *
 * 依赖方向（保持单向，不要打破）：
 *   ui  →  services  →  { domain, storage }
 *   engine（阶段 2）只依赖 domain，不依赖 ui / storage / services
 *
 * 本文件不做任何业务判断：只负责选择适配器、注入时钟与 ID 工厂、注册路由。
 */

import { createAppState } from './services/appState.js';
import { createTaskService } from './services/taskService.js';
import { createPlanService } from './services/planService.js';
import { createFocusService } from './services/focusService.js';
import { createIdFactory } from './domain/ids.js';
import { wallTimeFromDateObject } from './domain/time.js';
import { createShell } from './ui/shell.js';
import { startRouter } from './ui/router.js';
import { renderToday } from './ui/pages/today.js';
import { renderWeek } from './ui/pages/week.js';
import { renderTasks } from './ui/pages/tasks.js';
import { renderPreview } from './ui/pages/preview.js';
import { renderSettings } from './ui/pages/settings.js';
import { renderFocus } from './ui/pages/focus.js';
import { openTaskForm } from './ui/pages/taskForm.js';

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 界面服务：把"打开某个表单/对话框"这类跨页面动作集中在一处，避免页面之间互相 import */
function createUiService({ services }) {
  return {
    /** 当前本地日期（表单默认值等使用；由入口的时钟注入，便于测试固定时间） */
    today: () => services.now().date,
    openTaskForm(taskId) {
      const task = taskId ? services.taskService.getTask(taskId) : null;
      openTaskForm({ task, services });
    },
    /** 阶段 3 实现：生成候选计划并跳转到预览页 */
    requestReplan() {
      return {
        ok: false,
        reason: 'engine_not_implemented',
        message: '排程引擎将在阶段 2 实现，届时"生成计划 / 重新规划"会在这里产生候选计划与差异预览。',
      };
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
  services.planService = createPlanService({ app, idFactory });
  services.focusService = createFocusService({ app, idFactory, now: services.now });
  services.ui = createUiService({ services });

  const todayWall = services.now();
  const pages = {
    today: renderToday,
    week: renderWeek,
    tasks: renderTasks,
    preview: renderPreview,
    settings: renderSettings,
    focus: renderFocus,
  };

  const shell = createShell({
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

  return { app, services, shell, loadReport };
}

// 浏览器环境自动启动；测试环境（无 DOM）导入本模块不会产生副作用。
// 启动结果挂在 globalThis.__APP__ 上，便于在浏览器控制台排查问题（本地应用，不存在安全暴露面）。
if (typeof document !== 'undefined' && document.getElementById('app')) {
  const instance = boot();
  globalThis.__APP__ = instance;
}
