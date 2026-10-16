/**
 * 极简 DOM 工具。
 *
 * 设计原因：项目刻意不引入前端框架与第三方 DOM 库（零依赖），
 * 但也不希望每个页面各写一遍 createElement/appendChild 的样板代码。
 * 这里只提供最小可用的构建原语，全部返回真实 DOM 节点，不引入虚拟 DOM 概念。
 */

/**
 * 创建元素。
 * @param {string} tag 标签名，可用 'div.card' 或 'button.btn.btn--primary' 简写
 * @param {object} [props] 属性；特殊键：class / text / html / dataset / style / on
 * @param {Array<Node|string|null|undefined|false>} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = String(tag).split('.');
  const node = document.createElement(name || 'div');
  if (classes.length > 0) node.classList.add(...classes);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const cls of String(value).split(/\s+/).filter(Boolean)) node.classList.add(cls);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      // 仅用于本项目内部生成的静态标记，绝不放入用户输入
      node.innerHTML = String(value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [sk, sv] of Object.entries(value)) node.style.setProperty(sk, String(sv));
    } else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key === 'value') {
      node.value = value;
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** 批量追加子节点（忽略 null/undefined/false，便于条件渲染） */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else if (Array.isArray(child)) {
      append(parent, child);
    }
  }
  return parent;
}

/** 清空元素内容 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 用新内容替换容器内容 */
export function render(container, children) {
  clear(container);
  append(container, children);
  return container;
}

/** 查询 */
export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** 事件绑定卸载函数 */
export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}

/** 数字格式化：带千分位（用于分钟数等） */
export function num(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString('zh-CN');
}

/** 触发浏览器下载（导出备份用）；纯本地操作，不发起任何网络请求 */
export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // 释放引用，避免内存泄漏
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 轻量"每秒心跳"调度器。
 *
 * 用途：让进行中的计时器每秒刷新显示。
 * 设计约束：
 * - 同一时刻只允许一个心跳（重复注册会先替换旧的），避免多个页面叠加出多个定时器；
 * - 页面重新渲染时调用 `stopTicker()`，不会有定时器泄漏；
 * - 不使用 requestAnimationFrame（它在后台标签页会暂停，倒计时会停止更新）。
 */
let tickerHandle = null;

export function startTicker(callback, intervalMs = 1000) {
  stopTicker();
  tickerHandle = setInterval(() => {
    try {
      callback();
    } catch {
      // 单次刷新失败不应中断整个计时器
    }
  }, intervalMs);
  return tickerHandle;
}

export function stopTicker() {
  if (tickerHandle !== null) {
    clearInterval(tickerHandle);
    tickerHandle = null;
  }
}

export function isTickerRunning() {
  return tickerHandle !== null;
}

/** 提示条（页面级，轻量，不用 window.alert 打断用户） */
export function toast(message, level = 'info', timeoutMs = 4000) {
  const host = qs('#toast-host') ?? document.body;
  const node = el(`div.notice.notice--${level === 'error' ? 'danger' : level}`, { role: 'status' }, [
    el('div', { text: message }),
  ]);
  node.style.marginBottom = 'var(--space-2)';
  host.appendChild(node);
  setTimeout(() => node.remove(), timeoutMs);
  return node;
}
