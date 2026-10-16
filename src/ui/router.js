/**
 * 极简 hash 路由。
 *
 * 为什么用 hash 而不是 History API：应用需要能直接以 file:// 打开（单文件版本），
 * 也常在本地静态服务器上运行；hash 路由在这两种情况下都不需要服务器配合重写路径。
 */

export const ROUTES = Object.freeze([
  { path: 'today', label: '今日总览', title: '今日总览' },
  { path: 'week', label: '七天计划', title: '七天计划' },
  { path: 'tasks', label: '任务列表', title: '任务列表' },
  { path: 'preview', label: '调整预览', title: '调整预览' },
  { path: 'focus', label: '专注工作台', title: '专注工作台' },
  { path: 'settings', label: '偏好设置', title: '偏好设置' },
]);

export const DEFAULT_ROUTE = 'today';

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
  const known = ROUTES.some((r) => r.path === requested);
  if (!known) {
    return { path: requested, params, unknownPath: requested };
  }
  return { path: requested, params, unknownPath: null };
}

/** 跳转到指定路由（会触发 hashchange，由应用统一渲染） */
export function navigate(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  globalThis.location.hash = `#/${path}${query ? `?${query}` : ''}`;
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
