/**
 * 应用外壳：顶栏、侧边导航、主内容出口。
 *
 * 设计原因：页面模块只负责"往主内容区渲染什么"，导航与变更订阅由外壳统一处理，
 * 避免每个页面各自绑定 hashchange 或 subscribe 造成重复渲染与内存泄漏。
 */

import { append, clear, downloadText, el, startTicker, stopTicker, toast } from './dom.js';
import { ROUTES, parseHash } from './router.js';
import { formatSeconds, remainingSecondsOf } from '../services/pomodoroTimer.js';
import { PHASE_LABELS_ZH } from '../services/pomodoroService.js';
import { button, notice } from './components.js';

/**
 * @param {object} options
 * @param {HTMLElement} options.root 挂载点（通常是 body 下的 #app-host）
 * @param {object} options.app 应用状态容器（见 services/appState.js 的 createAppState）
 * @param {object} options.services 业务服务集合（taskService / planService / focusService / ui …）
 * @param {Record<string, (ctx: object) => Node|Node[]>} options.pages 路由 → 渲染函数
 * @param {() => {date:string, minutes:number}} options.now 读取当前墙钟时间（由入口注入，便于测试固定时间）
 * @param {{ date: string, weekday: string }|null} [options.todayInfo]
 */
export function createShell({ root, app, services, pages, now, todayInfo = null }) {
  clear(root);

  const brand = el('div.app-brand', {}, [el('span.app-brand__mark'), el('span', { text: '七天学习规划器' })]);

  const todayLabel = el('span', { text: todayInfo ? `今天 ${todayInfo.date} ${todayInfo.weekday}` : '今天' });
  const planLabel = el('span');
  const exportButton = button('导出备份', { size: 'sm', onClick: () => handleExport() });
  const importButton = button('导入备份', { size: 'sm', onClick: () => handleImportClick() });
  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'visually-hidden',
    on: {
      change: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const result = await app.importFile(file);
        if (!result.ok) {
          const first = result.issues?.find((i) => i.severity === 'error');
          toast(`导入失败，现有数据未做任何修改。${first ? ` 原因：${first.message}` : ''}`, 'error', 8000);
        } else {
          toast(`导入成功：${result.summary?.taskCount ?? 0} 个任务、${result.summary?.sessionCount ?? 0} 个学习时段。`, 'success');
        }
      },
    },
  });

  const topbar = el('header.app-topbar', {}, [
    el('div.app-topbar__meta', {}, [todayLabel, planLabel]),
    el('div.app-topbar__actions', {}, [fileInput, importButton, exportButton]),
  ]);

  const navList = el('ul.app-nav__list');
  const navFoot = el('div.app-nav__foot');
  const nav = el('nav.app-nav', { 'aria-label': '主导航' }, [navList, navFoot]);
  const banner = el('div', { id: 'global-banner', style: { margin: 'var(--space-4) var(--space-5) 0' } });

  const main = el('main.app-main', { id: 'main-content', tabindex: '-1' });
  const toastHost = el('div', { id: 'toast-host', 'aria-live': 'polite', style: { position: 'fixed', right: 'var(--space-4)', bottom: 'var(--space-4)', zIndex: '50', maxWidth: '360px' } });

  // 布局区域：brand / topbar / nav / main（toast 与全局横幅是浮层，不参与网格）
  /**
   * 固定专注功能栏：计时进行中时出现在每一页顶部。
   *
   * 为什么需要：番茄钟要求"开始一项任务后能直接进入专注模式，不必反复切换页面"。
   * 有了这条常驻栏，用户在周视图、任务列表或设置页都能看到剩余时间，
   * 并且可以就地暂停 / 结束 / 回到专注页。
   */
  const focusBar = el('div.focus-bar', { hidden: true, role: 'status', 'aria-live': 'polite' });

  const shell = el('div.app', {}, [brand, topbar, nav, main, focusBar]);
  installKeyboardShortcuts({ app, services, render: () => renderCurrent() });
  root.appendChild(shell);
  root.appendChild(banner);
  root.appendChild(toastHost);

  function handleExport() {
    const { text, filename } = app.exportBackup();
    downloadText(filename, text);
    app.markBackupExported();
    toast(`已导出备份文件：${filename}`, 'success');
  }

  function handleImportClick() {
    fileInput.click();
  }

  function renderNav(activePath) {
    clear(navList);
    ROUTES.forEach((route, index) => {
      const isActive = route.path === activePath;
      navList.appendChild(
        el('li', {}, [
          el(
            'a.app-nav__link',
            {
              href: `#/${route.path}`,
              'aria-current': isActive ? 'page' : null,
              // 把快捷键写进无障碍名称，键盘用户不必先看帮助
              title: `快捷键 ${index + 1}`,
            },
            [
              el('span', { text: route.label }),
              el('span', { class: 'app-nav__key', text: String(index + 1), 'aria-hidden': 'true' }),
            ],
          ),
        ]),
      );
    });
  }

  function renderNavFoot() {
    clear(navFoot);
    const summary = app.getSummary();
    append(navFoot, [
      el('div', { text: `计划版本：${summary.planVersion > 0 ? `v${summary.planVersion}` : '尚未生成'}` }),
      el('div', { text: `状态：${summary.planStatus ? planStatusLabel(summary.planStatus) : '—'}` }),
      el('div', { text: `任务：${summary.activeTaskCount} 个待安排` }),
      el('div', { text: `时段：${summary.sessionCount} 个（已完成 ${summary.completedSessionCount}）` }),
      el('div', { text: `历史版本：${summary.historyCount} 个` }),
    ]);
    planLabel.textContent = summary.planVersion > 0 ? `正式计划 v${summary.planVersion}` : '尚未生成正式计划';
  }

  function renderBanner() {
    clear(banner);
    const report = app.getLoadReport();
    const nodes = [];
    if (report.usedMemoryFallback) {
      nodes.push(
        notice({
          level: 'warning',
          title: '本次数据不会自动保存',
          message: '当前浏览器环境不可用本地存储（可能是隐私模式）。任务与计划只保存在页面内存中，刷新后会丢失。请使用"导出备份"保存数据。',
        }),
      );
    }
    if (report.error) {
      nodes.push(
        notice({
          level: 'danger',
          title: '本地数据读取失败',
          message: `${report.error.message ?? '未知原因'}（磁盘上的数据没有被修改，可尝试导入备份恢复。）`,
        }),
      );
    }
    if (report.recovered) {
      nodes.push(notice({ level: 'warning', title: '已从自动备份恢复', message: '主数据无法读取，已使用最近一次自动备份启动，请检查计划是否符合预期。' }));
    }
    for (const notification of app.getNotifications()) {
      nodes.push(notice({ level: notification.level === 'error' ? 'danger' : notification.level, message: notification.message }));
    }
    append(banner, nodes);
  }

  let currentRoute = null;

  function render(route = parseHash()) {
    currentRoute = route;
    // 页面切换时先停掉上一个页面的心跳，避免计时器在后台继续跑
    stopTicker();

    // 防御：异步任务（例如心跳或延迟重绘）可能在文档已经卸载后才回来。
    // 此时重建 DOM 只会抛错，直接返回才是正确行为。
    if (typeof document === 'undefined') return;
    renderNav(route.path);
    renderNavFoot();
    renderBanner();
    // 专注栏要在每一页都刷新：计时中切到任意页面都能看到剩余时间并暂停/结束
    renderFocusBar();
    const page = pages[route.path];
    clear(main);
    if (!page || route.unknownPath) {
      append(main, [
        notice({
          level: 'danger',
          title: '页面不存在',
          message: `没有找到「${route.unknownPath ?? route.path}」对应的页面。请从左侧导航选择一个页面。`,
          actions: [button('回到今日总览', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/today'; } })],
        }),
      ]);
      return;
    }
    try {
      // 页面上下文：页面只能通过这些只读入口取数据，不直接访问存储。
      // `requestTick` 让"需要每秒刷新"的页面（如计时工作台）注册心跳。
      let tickRequested = false;
      const requestTick = (callback = () => shellRender()) => {
        tickRequested = true;
        startTicker(callback);
      };
      const content = page({ app, services, route, now, today: now().date, requestTick, renderPage: () => shellRender() });
      append(main, content);
      if (!tickRequested) stopTicker();
    } catch (err) {
      // 单个页面渲染失败不能让整个应用白屏：显示错误并给出重试入口
      append(main, [
        notice({
          level: 'danger',
          title: '页面渲染出错',
          message: `${err.message}。这通常是程序缺陷，请把此信息与操作步骤一起反馈；你的数据没有被修改。`,
          actions: [button('重新加载页面', { onClick: () => globalThis.location.reload() })],
        }),
      ]);
      // 同时打印到控制台，便于排查
      // eslint-disable-next-line no-console
      console.error('[page render failed]', err);
    }
  }

  /** 局部刷新当前页面（计时心跳使用，避免重建整个外壳） */
  function shellRender() {
    render(currentRoute ?? parseHash());
  }

  /**
   * 渲染固定专注栏。
   *
   * 它只显示与操作当前计时，不修改任何业务数据；
   * 结束操作会跳到专注页，让用户看到完整的结束选项（提前结束/顺延等），
   * 而不是在这里偷偷把记录写掉。
   */
  function renderFocusBar() {
    clear(focusBar);
    const pomodoro = services.pomodoroService;
    if (!pomodoro) {
      focusBar.hidden = true;
      return;
    }
    const timer = pomodoro.getTimer();
    if (timer.phase === 'idle') {
      focusBar.hidden = true;
      document?.documentElement?.setAttribute('data-focus-bar', 'off');
      return;
    }
    document?.documentElement?.setAttribute('data-focus-bar', 'on');

    const remaining = remainingSecondsOf(timer, Date.now());
    const paused = Boolean(timer.paused);
    const phaseLabel = PHASE_LABELS_ZH[timer.phase] ?? '专注';

    focusBar.hidden = false;
    append(focusBar, [
      el('span.focus-bar__dot', { class: paused ? 'is-paused' : null, 'aria-hidden': 'true' }),
      el('span.focus-bar__phase', { text: paused ? `${phaseLabel}（已暂停）` : phaseLabel }),
      el('strong.focus-bar__time', { text: formatSeconds(remaining) }),
      el('span.focus-bar__task', { text: timer.taskTitle ?? '未关联任务' }),
      el('div.focus-bar__actions', {}, [
        el('button.btn.btn--sm', {
          type: 'button',
          on: {
            click: () => {
              if (timer.paused) pomodoro.resume();
              else {
                pomodoro.pause();
                pomodoro.resumeMarkPause();
              }
              renderFocusBar();
              shellRender();
            },
          },
          text: paused ? '继续' : '暂停',
        }),
        el('button.btn.btn--sm', {
          type: 'button',
          on: { click: () => { globalThis.location.hash = '#/focus'; } },
          text: '回到专注',
        }),
        el('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          on: {
            click: () => {
              pomodoro.discard();
              renderFocusBar();
              shellRender();
            },
          },
          text: '放弃',
        }),
      ]),
    ]);
  }

  return { render, renderCurrent: shellRender, get currentRoute() { return currentRoute; }, main, renderFocusBar };
}

/**
 * 全局键盘快捷键。
 *
 * 只做三件事，避免与浏览器快捷键冲突、也不做"隐藏功能"：
 * - `1`–`9`：按侧边导航顺序跳转页面（与界面上显示的顺序一致，可从导航项提示中看到）
 * - `g`：生成 / 重新规划（等价于点顶部的"生成计划"）
 * - `?`：显示快捷键帮助
 *
 * 在输入框、下拉框、文本域或可编辑元素中按键时一律不触发，
 * 因此不会影响用户正常打字。
 */
function installKeyboardShortcuts({ app, services, render }) {
  globalThis.addEventListener?.('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    const tag = String(target?.tagName ?? '').toLowerCase();
    const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
    if (editable) return;

    const key = event.key;
    if (key === '?' || (key === '/' && event.shiftKey)) {
      event.preventDefault();
      showShortcuts();
      return;
    }

    const index = Number.parseInt(key, 10);
    if (Number.isInteger(index) && index >= 1 && index <= ROUTES.length) {
      event.preventDefault();
      globalThis.location.hash = `#/${ROUTES[index - 1].path}`;
      return;
    }

    if (key === 'g' || key === 'G') {
      event.preventDefault();
      const result = services.ui.requestPreview({ changeSummary: '通过快捷键重新规划', trigger: 'shortcut' });
      if (!result.ok) toast(result.message, 'error', 8000);
      void app;
      void render;
    }
  });
}

/** 快捷键帮助（用普通文本，避免依赖额外的对话框实现） */
function showShortcuts() {
  const lines = ROUTES.map((route, index) => `${index + 1} = ${route.label}`).join('　');
  toast(`快捷键：${lines}　g = 生成/重新规划　? = 本帮助`, 'info', 9000);
}

function planStatusLabel(status) {
  const labels = {
    feasible: '完整可行',
    partially_feasible: '部分可行',
    infeasible: '不可行',
    invalid_input: '输入不合法',
  };
  return labels[status] ?? status;
}
