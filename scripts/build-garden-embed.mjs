#!/usr/bin/env node
/**
 * 把「专注花园」这个独立 HTML 内联成一个 ES 模块。
 *
 * 为什么需要它：
 * 花园是一个**单文件应用**（React 已打包、样式内联、挂载到 #root）。
 * 直接把它放进侧边栏有两种做法：
 *   1. iframe 指向外部文件 —— 单文件版（dist/standalone.html）会失效；
 *   2. 把整段 HTML 作为字符串内联，用 iframe 的 `srcdoc` 承载 —— 两种版本都能用。
 * 本项目选择第 2 种，因此需要一个"把 HTML 变成 JS 模块"的构建步骤。
 *
 * 关键细节（踩过才知道）：
 * - 单文件版会把所有模块塞进一个 <script> 标签里，
 *   所以生成的字面量里**绝不能出现 `</script`**，否则 HTML 解析器会提前结束脚本。
 *   这里按惯例写成 `<\/script`（JS 字符串里 `\/` 等价于 `/`）。
 * - 同理把 `<!--` 转义成 `<\!--`，避免被当作注释开始。
 *
 * 用法：
 *   node scripts/build-garden-embed.mjs
 * 重新生成（花园更新后）：
 *   用新的「专注花园」HTML 覆盖 focus-garden.html，再跑一次本脚本。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const SOURCE = join(projectRoot, 'focus-garden.html');
const OUT_DIR = join(projectRoot, 'src', 'embed');
const OUT_FILE = join(OUT_DIR, 'focusGardenHtml.js');

/**
 * 从 HTML 里去掉依赖相对路径的外链。
 *
 * `srcdoc` 里的相对地址会按**父页面**的地址解析，于是
 * `icons/icon.svg`、`manifest.webmanifest` 这类资源会 404（只是控制台噪音，
 * 不影响花园本身运行）。它们只用于"安装到桌面/标签页图标"，
 * 内嵌场景下没有意义，因此在内联副本里移除；源文件保持原样。
 */
function stripRelativeAssetLinks(html) {
  return html
    .replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '')
    .replace(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>\s*/gi, '');
}

/** 让字符串可以安全地放进 <script> 标签里 */
function escapeForScriptTag(text) {
  return text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

async function main() {
  const raw = await readFile(SOURCE, 'utf8');
  if (!raw.includes('id="root"')) {
    throw new Error('focus-garden.html 里找不到 #root 挂载点，可能不是专注花园的构建产物');
  }
  if (/<script[^>]+src=/i.test(raw)) {
    throw new Error('focus-garden.html 引用了外部脚本，内联后会失效；请先确认它能独立运行');
  }

  const cleaned = stripRelativeAssetLinks(raw);
  const escaped = escapeForScriptTag(JSON.stringify(cleaned));

  const module = `/**
 * 由 scripts/build-garden-embed.mjs 生成，请勿手工编辑。
 * 内容来源：focus-garden.html（${(cleaned.length / 1024).toFixed(1)} KB）
 * 重新生成：node scripts/build-garden-embed.mjs
 *
 * 说明：这里保存的是「专注花园」完整单文件应用的 HTML 文本，
 * 页面用 iframe 的 srcdoc 承载它，因此两种版本（多文件 / 单文件）都能打开。
 */
export const FOCUS_GARDEN_HTML = ${escaped};
`;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, module, 'utf8');

  const sizeKb = Math.round(Buffer.byteLength(module, 'utf8') / 1024);
  process.stdout.write(`已生成 ${relative(projectRoot, OUT_FILE)}（${sizeKb} KB）\n`);
}

main().catch((error) => {
  process.stderr.write(`生成专注花园内联模块失败：${error.message}\n`);
  process.exitCode = 1;
});
