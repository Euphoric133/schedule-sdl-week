/**
 * 专注花园页。
 *
 * 花园是一个**独立的单文件应用**（React 已打包、样式内联、挂载到它自己的 #root）。
 * 它和本应用是两套完全独立的运行时，因此这里用 **iframe 的 `srcdoc`** 承载：
 * - 它的全局样式、`#root`、localStorage 键、键盘快捷键都不会污染规划器；
 * - 内联而不是引用外部文件，所以**多文件版与单文件版（dist/standalone.html）都能打开**。
 *
 * 数据说明（重要）：
 * iframe 的 `srcdoc` 继承父页面的源，因此花园用的是**同一个站点**的 localStorage，
 * 只是它存的是自己的键。也就是说：花园的番茄记录不会出现在规划器的任务里，
 * 规划器的任务也不会出现在花园里——两边各自独立，但都会在刷新后保留。
 *
 * 「在新窗口打开」用 Blob URL：同样继承当前源，数据与内嵌时是同一份，
 * 不会出现"内嵌里记的专注记录，新窗口里看不到"的问题。
 */

import { button, card, notice } from '../components.js';
import { el, toast } from '../dom.js';
import { FOCUS_GARDEN_HTML } from '../../embed/focusGardenHtml.js';

export function renderGarden() {
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '专注花园' }),
        el('p.page-head__sub', {
          text: '内置的独立番茄钟应用：专注计时、任务、历史与统计都在它自己里面完成，和规划器的数据互不影响。',
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('在新窗口打开', {
          size: 'sm',
          variant: 'primary',
          onClick: () => openInNewWindow(),
        }),
      ]),
    ]),
  );

  nodes.push(
    notice({
      level: 'info',
      title: '这是一个独立应用，数据与规划器分开保存',
      message:
        '花园有自己的任务、专注记录与设置（保存在同一个站点的本地存储里，刷新后仍在）。规划器的学习任务不会同步进花园；如果需要按规划来专注，在花园里新建对应任务即可。',
    }),
  );

  nodes.push(
    card({
      title: '专注花园',
      hint: '如果下方区域显示空白，可以用右上角「在新窗口打开」，或检查浏览器是否阻止了内嵌页面',
      flush: true,
      body: el('div.garden-frame-host', {}, [
        el('iframe', {
          class: 'garden-frame',
          title: '专注花园',
          srcdoc: FOCUS_GARDEN_HTML,
          // 让花园拥有完整权限：它需要 localStorage 保存专注记录
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
          allow: 'fullscreen',
          loading: 'eager',
        }),
      ]),
    }),
  );

  return nodes;
}

/**
 * 在新窗口打开花园。
 *
 * 用 Blob URL 而不是 `srcdoc`：新窗口需要一个真实可导航的地址，
 * 而 Blob URL 继承当前源，因此 localStorage 与内嵌时是同一份数据。
 */
function openInNewWindow() {
  try {
    const blob = new Blob([FOCUS_GARDEN_HTML], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const opened = globalThis.open?.(url, '_blank', 'noopener');
    if (!opened) {
      URL.revokeObjectURL(url);
      toast('浏览器拦截了新窗口，请允许本站弹出窗口后重试。', 'error', 8000);
      return;
    }
    // 给新窗口留出加载时间再回收，避免地址立刻失效
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    toast(`无法打开新窗口：${error?.message ?? error}`, 'error', 8000);
  }
}
