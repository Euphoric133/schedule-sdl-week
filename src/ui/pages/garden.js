/**
 * 专注花园：在**独立窗口**里打开，而不是嵌在网站页面里。
 *
 * 为什么改成独立窗口：
 * - 花园是一个完整的番茄钟应用（自己的计时器、全屏布局、键盘快捷键），
 *   嵌在规划器的内容区里既浪费空间，也没法真正"全屏使用"；
 * - 独立窗口可以有自己的一整块屏幕，计时器不会因为切换规划器页面而被打断。
 *
 * 打开方式：**点击侧边栏时直接开窗**（必须由用户点击触发，否则会被浏览器拦截）。
 * 这个页面本身是"启动器"：从地址栏直接进入 #/garden、或窗口被拦截时，
 * 用户可以在这里再点一次按钮。
 *
 * 数据说明：花园用自己的一套 localStorage 键，和规划器的数据互不影响；
 * 关掉窗口再打开，专注记录仍然在（同一个站点）。
 */

import { button, card, notice } from '../components.js';
import { el, toast } from '../dom.js';
import { FOCUS_GARDEN_HTML } from '../../embed/focusGardenHtml.js';

/** 窗口名：用固定名字，重复点击会复用同一个窗口，而不是开出一堆 */
const WINDOW_NAME = 'focus-garden-window';

/**
 * 在独立窗口里打开花园。
 *
 * 细节：
 * - 把窗口尺寸设成"可用屏幕大小"，打开就是铺满屏的一整块工作区；
 *   想要系统级全屏，再按 macOS 的 ⌃⌘F（Windows/Linux 是 F11）即可。
 * - 用 Blob URL 而不是文件路径：单文件版（dist/standalone.html）旁边没有
 *   focus-garden.html，用相对路径会 404；Blob URL 两种版本都能用。
 * - **不 revoke**：这个窗口是一次长期使用的工具，用户随时可能刷新它；
 *   460 KB 的 Blob 占用可以忽略。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function openGardenWindow() {
  if (typeof globalThis.open !== 'function') return { ok: false, reason: 'unsupported' };

  let url = null;
  try {
    const blob = new Blob([FOCUS_GARDEN_HTML], { type: 'text/html;charset=utf-8' });
    url = URL.createObjectURL(blob);
  } catch (error) {
    return { ok: false, reason: 'blob-failed', message: error?.message ?? null };
  }

  const screenRef = globalThis.screen ?? {};
  const availWidth = Number.isFinite(screenRef.availWidth) ? screenRef.availWidth : 1440;
  const availHeight = Number.isFinite(screenRef.availHeight) ? screenRef.availHeight : 900;
  const width = Math.max(960, Math.round(availWidth * 0.98));
  const height = Math.max(640, Math.round(availHeight * 0.96));
  const left = Math.max(0, Math.round((availWidth - width) / 2));
  const top = Math.max(0, Math.round((availHeight - height) / 2));

  const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;

  let opened = null;
  try {
    opened = globalThis.open(url, WINDOW_NAME, features);
  } catch (error) {
    return { ok: false, reason: 'open-failed', message: error?.message ?? null };
  }

  if (!opened) {
    // 被浏览器拦截：保留 Blob 供用户再点一次，不做 revoke
    return { ok: false, reason: 'blocked' };
  }

  try {
    opened.focus();
  } catch {
    // 某些浏览器不允许 opener 调 focus，忽略即可
  }
  return { ok: true };
}

/** 统一处理"打开失败"的提示，避免每个调用点各写一套文案 */
export function reportOpenFailure(result) {
  if (!result || result.ok) return;
  if (result.reason === 'blocked') {
    toast('浏览器拦截了新窗口：请允许本站弹出窗口，然后点页面上的「打开专注花园」按钮重试。', 'error', 10000);
    return;
  }
  if (result.reason === 'unsupported') {
    toast('当前环境不允许打开新窗口，请用桌面浏览器访问。', 'error', 8000);
    return;
  }
  toast(`无法打开专注花园窗口：${result.message ?? '未知原因'}`, 'error', 8000);
}

export function renderGarden() {
  return [
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '专注花园' }),
        el('p.page-head__sub', {
          text: '在一个独立窗口里使用：铺满整个屏幕，计时不会被规划器的页面切换打断。',
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('打开专注花园窗口', {
          size: 'sm',
          variant: 'primary',
          onClick: () => reportOpenFailure(openGardenWindow()),
        }),
      ]),
    ]),

    notice({
      level: 'info',
      title: '它在一个单独的窗口里运行，不在本页面内',
      message:
        '专注花园是独立的番茄钟应用，有自己的任务、专注记录与设置。点左侧「专注花园」或上面的按钮，会打开一个新窗口；关掉窗口后专注记录仍然保留（存在同一个站点的本地存储里）。',
    }),

    card({
      title: '为什么用独立窗口',
      hint: '嵌在页面里没法真正全屏，也不适合长时间盯着计时器',
      body: el('ul', { style: { margin: 0, paddingLeft: '1.2em', lineHeight: '1.8' } }, [
        el('li', { text: '窗口会按屏幕大小打开，整块区域都是专注界面。' }),
        el('li', { text: '需要系统级全屏时，按 macOS 的 ⌃⌘F（Windows / Linux 是 F11）。' }),
        el('li', { text: '专注花园与规划器的数据各自独立：规划器的任务不会自动出现在花园里。' }),
        el('li', { text: '重复点击左侧「专注花园」会复用同一个窗口，不会开出一堆重复窗口。' }),
      ]),
    }),

    card({
      title: '窗口没有打开？',
      hint: '多半是被浏览器的弹窗拦截挡住了',
      body: el('div', {}, [
        el('div.card__hint', {
          text: '浏览器只允许"由用户点击"触发的新窗口。请允许本站弹出窗口后，点下面的按钮再试一次。',
        }),
        el('div.form-actions', { style: { justifyContent: 'flex-start', marginTop: 'var(--space-3)' } }, [
          button('打开专注花园窗口', {
            size: 'sm',
            onClick: () => reportOpenFailure(openGardenWindow()),
          }),
        ]),
      ]),
    }),
  ];
}
