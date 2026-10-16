/**
 * 极简 hash 路由。
 *
 * 为什么用 hash 而不是 History API：应用需要能直接以 file:// 打开（单文件版本），
 * 也常在本地静态服务器上运行；hash 路由在这两种情况下都不需要服务器配合重写路径。
 */

export const ROUTES = Object.freeze([
  { path: 'home', label: '首页', title: '今日总览', icon: '🏠' },
  { path: 'week', label: '七天计划', title: '七天计划', icon: '🗓' },
  { path: 'day', label: '每日视图', title: '每日视图', icon: '📆' },
  { path: 'tasks', label: '学习任务', title: '学习任务', icon: '✅' },
  { path: 'activities', label: '固定日程', title: '固定日程', icon: '📌' },
  { path: 'focus', label: '专注番茄钟', title: '专注番茄钟', icon: '⏱' },
  { path: 'rewards', label: '奖励转盘', title: '奖励转盘', icon: '🎡' },
  { path: 'stats', label: '学习统计', title: '学习统计', icon: '📊' },
  { path: 'preview', label: '调整预览', title: '调整预览', icon: '🔍' },
  { path: 'versions', label: '版本历史', title: '版本历史', icon: '🕘' },
  { path: 'appearance', label: '外观主题', title: '外观主题', icon: '🎨' },
  { path: 'notifications', label: '通知提醒', title: '通知提醒', icon: '🔔' },
  { path: 'settings', label: '偏好设置', title: '偏好设置', icon: '⚙️' },
]);

export const DEFAULT_ROUTE = 'home';

/**
 * 解析当前 location.hash → { path, params, unknownPath }。
 *
 * 注意：未知路由时 **不会**把 path 悄悄改成默认页，而是把原路径放进 unknownPath，
 * 由外壳显示明确的"页面不存在"提示。静默回退到首页会让用户以为自己点错了页面。
 */
export function parseHash(hash = globalThis.location?.hash ?? '') {
  const raw = String(hash).replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const requested = pathPart || DEFAULT_ROUTE;
  const params = new URLSearchParams(queryPart ?? '');
  // 兼容旧链接：#/today 曾经是首页，改名为 home 后旧书签仍然可用
  const normalized = requested === 'today' ? 'home' : requested;
  const known = ROUTES.some((route) => route.path === normalized);
  if (!known) {
    return { path: requested, params, unknownPath: requested };
  }
  return { path: normalized, params, unknownPath: null };
}

/** 跳转到指定路由（会触发 hashchange，由应用统一渲染） */
export function navigate(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  globalThis.location.hash = `#/${path}${query ? `?${query}` : ''}`;
}

/** 读取当前路由的查询参数（供页面在事件处理里构造新链接） */
export function currentParams() {
  const hash = globalThis.location?.hash ?? '';
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(query);
}

/**
 * 用一个补丁更新当前路由的查询参数（不改变 path）。
 * 用于"每日视图切换日期""任务列表切换筛选"这类不跳页的状态变化。
 */
export function updateParams(patch = {}) {
  const hash = globalThis.location?.hash ?? `#/${DEFAULT_ROUTE}`;
  const [pathPart] = hash.split('?');
  const params = currentParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  globalThis.location.hash = `${pathPart}${query ? `?${query}` : ''}`;
}

/**
 * 启动路由监听。
 * @param {(route: {path: string, params: URLSearchParams, unknownPath: string|null}) => void} handler
 * @returns {() => void} 取消监听
 */
export function startRouter(handler) {
  const dispatch = () => handler(parseHash(globalThis.location.hash));
  globalThis.addEventListener('hashchange', dispatch);
  dispatch();
  return () => globalThis.removeEventListener('hashchange', dispatch);
}
