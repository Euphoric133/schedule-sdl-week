/**
 * 专注花园的内嵌承载层（同源 iframe）。
 *
 * 为什么是 iframe，而不是把花园的 HTML/CSS 直接拼进本页面：
 * 花园是一个独立的单文件应用，自带 **44 KB 全局 CSS**（含 7 条 `body{}` 规则）、
 * 与本站 **16 个重名的 CSS 变量**、**66 个重名的类名**（`.card`、`.btn`、`.chart`…），
 * 还有挂在 `window` 上的快捷键（`1/2/3` 切换专注阶段，会和本应用 `1–9` 切页冲突）。
 * 直接拼接会同时弄坏两边。iframe 让它保持**零修改**，外观上无缝铺满内容区。
 *
 * 计时器为什么不会被打断（关键）：
 * - 这个 iframe **只创建一次**，之后只切换 `hidden`，从不重建、从不重写 `srcdoc`；
 * - 因此切换规划器页面不会卸载它的文档，花园里的 `setInterval` / 计时状态原样继续；
 * - 千万不要在别处对同一个 iframe 再次赋值 `srcdoc`——那等于刷新，计时会归零。
 *
 * 归属：iframe 的引用挂在**宿主元素** `host.__gardenFrame` 上，而不是模块级变量。
 * 这样每次启动的外壳各自持有自己的 iframe（多次启动/测试互不干扰），
 * 也不会因为模块缓存而误判"已经挂载过"。
 */

import { FOCUS_GARDEN_HTML } from '../embed/focusGardenHtml.js';

/** 宿主元素上保存 iframe 引用的键名 */
const FRAME_KEY = '__gardenFrame';

/**
 * 判断 iframe 是否仍然挂在文档里。
 * 真实浏览器用 `isConnected`；最小测试 DOM 没实现它，退回看 `parentNode`。
 */
function isAttached(node) {
  if (!node) return false;
  if (typeof node.isConnected === 'boolean') return node.isConnected;
  return Boolean(node.parentNode);
}

/**
 * 确保花园 iframe 已创建并挂载到宿主容器。
 *
 * 幂等：重复调用只会复用同一个元素。这是"计时器不被重置"的基础。
 *
 * @param {HTMLElement} host 宿主容器（shell 里的 #garden-host）
 * @returns {{created: boolean, frame: HTMLIFrameElement|null}}
 */
export function ensureGardenFrame(host) {
  if (!host) return { created: false, frame: null };

  const existing = host[FRAME_KEY];
  if (existing && isAttached(existing)) return { created: false, frame: existing };

  const frame = document.createElement('iframe');
  // 统一走 setAttribute：真实 DOM 与最小测试 DOM 行为一致
  frame.setAttribute('class', 'garden-frame');
  frame.setAttribute('title', '专注花园');
  frame.setAttribute('loading', 'eager');
  // 同源 iframe：花园需要 localStorage 保存专注记录，因此**不加** sandbox 限制
  frame.setAttribute('srcdoc', FOCUS_GARDEN_HTML);
  host.appendChild(frame);
  host[FRAME_KEY] = frame;
  return { created: true, frame };
}

/** 显示花园（进入 #/garden 时调用）：只切 hidden，不重建文档 */
export function showGardenFrame(host) {
  const result = ensureGardenFrame(host);
  if (host) host.hidden = false;
  return result;
}

/** 隐藏花园（离开 #/garden 时调用）：iframe 仍然留在 DOM 里，计时继续 */
export function hideGardenFrame(host) {
  if (host) host.hidden = true;
}

/** 取当前宿主里的 iframe（可能为 null） */
export function getGardenFrame(host) {
  return host?.[FRAME_KEY] ?? null;
}
