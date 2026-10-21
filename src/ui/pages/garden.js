/**
 * 专注花园（页面占位）。
 *
 * 实际内容由 `ui/gardenFrame.js` 里的**常驻 iframe** 提供：
 * 它挂在外壳的 `#garden-host` 上，切换页面时只切 `hidden`，从不重建，
 * 因此花园里的计时器在你切到别的页面时仍然继续走。
 *
 * 这里只保留一个空实现：花园路由的 `main` 区域是隐藏的，
 * 页面函数返回空数组即可（不渲染任何额外 DOM，避免与 iframe 抢空间）。
 *
 * 为什么用 iframe 而不是把花园拼进本页：见 `ui/gardenFrame.js` 顶部说明
 * （44 KB 全局 CSS、16 个重名变量、66 个重名类名、1/2/3 快捷键冲突）。
 */

export function renderGarden() {
  return [];
}
