/**
 * 应用外壳：顶栏、侧边导航、主内容出口。
 *
 * 设计原因：页面模块只负责"往主内容区渲染什么"，导航与变更订阅由外壳统一处理，
 * 避免每个页面各自绑定 hashchange 或 subscribe 造成重复渲染与内存泄漏。
 */

import { append, clear, downloadText, el, toast } from './dom.js';
import { ROUTES, parseHash } from './router.js';
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
  const shell = el('div.app', {}, [brand, topbar, nav, main]);
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
    for (const route of ROUTES) {
      const isActive = route.path === activePath;
      navList.appendChild(
        el('li', {}, [
          el(
            'a.app-nav__link',
            {
              href: `#/${route.path}`,
              'aria-current': isActive ? 'page' : null,
            },
            [el('span', { text: route.label })],
          ),
        ]),
      );
    }
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
    renderNav(route.path);
    renderNavFoot();
    renderBanner();
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
      // 页面上下文：页面只能通过这些只读入口取数据，不直接访问存储
      const content = page({ app, services, route, now, today: now().date });
      append(main, content);
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

  return { render, get currentRoute() { return currentRoute; }, main };
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
