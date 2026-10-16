#!/usr/bin/env node
/**
 * 生成单文件版本：把 CSS 与全部 ES Module 内联进一个 HTML。
 *
 * 为什么需要它：
 * 浏览器对 ES Module 有同源限制，`file://` 直接打开 index.html 时 import 会被拦截。
 * 内联成单文件后，dist/standalone.html 可以双击直接用（不需要服务器、没有任何依赖）。
 *
 * 实现说明（有意保持简单）：
 * - 不使用任何打包工具。本项目的模块是扁平的静态 import/export，没有动态 import、没有循环依赖，
 *   因此"拓扑排序 + 去掉 import/export 关键字 + 拼接"即可得到等价结果。
 * - 若将来引入动态 import 或 node_modules 依赖，本脚本会明确报错而不是产出错误的包。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目根目录 = 本脚本所在目录的上一级（scripts/ → 项目根）。
 * 这里显式用 dirname 计算，避免不同 Node 版本对 `new URL('..', fileUrl)` 的处理差异
 * 导致相对路径解析到错误目录（曾出现把 src/ 前缀吃掉、找不到模块的问题）。
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const ENTRY = join(projectRoot, 'src', 'main.js');
const OUT_DIR = join(projectRoot, 'dist');
const OUT_FILE = join(OUT_DIR, 'standalone.html');

/** 递归收集入口可达的所有本地模块（深度优先，返回依赖在前、入口在后的顺序） */
async function collectModules(file, collected = new Map(), stack = []) {
  const absolute = resolve(file);
  if (collected.has(absolute)) return collected;
  if (stack.includes(absolute)) {
    throw new Error(`检测到循环依赖，无法安全内联：${stack.map((p) => relative(projectRoot, p)).join(' → ')} → ${relative(projectRoot, absolute)}`);
  }

  const source = await readFile(absolute, 'utf8');
  // 只检测真正的动态 import（避免把注释或字符串里的 "import (" 误判为动态导入）
  if (/\bimport\s*\(\s*['"`]/.test(source)) {
    throw new Error(`${relative(projectRoot, absolute)} 使用了动态 import()，当前内联脚本不支持，请改用静态 import。`);
  }

  const specifiers = [...source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?/gm)].map((m) => m[1]);
  const nextStack = [...stack, absolute];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) {
      throw new Error(`${relative(projectRoot, absolute)} 引入了外部依赖「${specifier}」。本项目的运行时代码必须零依赖（见 README 依赖政策）。`);
    }
    const target = resolve(dirname(absolute), specifier);
    await collectModules(target, collected, nextStack);
  }

  collected.set(absolute, { source, absolute });
  return collected;
}

/** 去掉 import/export 关键字：所有模块在同一个函数作用域内，顶级 const/function 名称必须唯一 */
function stripModuleSyntax(source, modulePath) {
  const label = relative(projectRoot, modulePath);
  let out = source;

  // 副作用 import：'./x.js'  →  已在同一作用域，直接删除
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?[ \t]*$/gm, '');

  // 带 from 的 import：只保留默认导入的别名（本项目默认导入与本地名同名）
  out = out.replace(
    /^\s*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?[ \t]*$/gm,
    (match, clause) => {
      const trimmed = clause.trim();
      const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(trimmed);
      if (defaultMatch) return `const ${defaultMatch[1]} = ${defaultMatch[1]};`;
      return ''; // 命名导入已在同一作用域内可用
    },
  );

  // export { a, b as c }
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');

  // export const/let/var/function/class
  out = out.replace(/^(\s*)export\s+(const|let|var|function|class|async)/gm, '$1$2');

  if (/^\s*export\s/m.test(out)) {
    const leftover = out.match(/^\s*export\s.*$/m)?.[0]?.trim();
    throw new Error(`${label} 中仍有无法处理的 export 语法：${leftover}`);
  }
  if (/^\s*import\s/m.test(out)) {
    const leftover = out.match(/^\s*import\s.*$/m)?.[0]?.trim();
    throw new Error(`${label} 中仍有无法处理的 import 语法：${leftover}`);
  }
  return out;
}

async function main() {
  const modules = await collectModules(ENTRY);

  const cssFiles = [
    join(projectRoot, 'src', 'ui', 'styles', 'tokens.css'),
    join(projectRoot, 'src', 'ui', 'styles', 'base.css'),
    join(projectRoot, 'src', 'ui', 'styles', 'components.css'),
  ];
  const css = (await Promise.all(cssFiles.map((file) => readFile(file, 'utf8')))).join('\n\n');

  const parts = [];
  for (const [absolute, { source }] of modules) {
    parts.push(`/* ==== ${relative(projectRoot, absolute).split(sep).join('/')} ==== */\n${stripModuleSyntax(source, absolute)}`);
  }

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>七天学习规划器（单文件版）</title>
<meta name="description" content="纯本地运行的七天学习规划器单文件版本，可直接双击打开。" />
<style>
${css}
</style>
</head>
<body>
<a class="skip-link" href="#main-content">跳到主内容</a>
<div id="app"></div>
<noscript><p style="max-width:720px;margin:48px auto;font-family:system-ui,sans-serif">本应用需要启用 JavaScript。</p></noscript>
<script>
/* 由 scripts/build-standalone.mjs 生成，请勿手工编辑。
   修改源码后重新运行：node scripts/build-standalone.mjs */
(function () {
'use strict';
${parts.join('\n\n')}
})();
</script>
</body>
</html>
`;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, html, 'utf8');

  const sizeKb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  process.stdout.write(`已生成 ${relative(projectRoot, OUT_FILE)}（${sizeKb} KB，内联 ${modules.size} 个模块）\n`);
  process.stdout.write('可直接双击该文件在浏览器中打开。\n');
}

main().catch((err) => {
  process.stderr.write(`生成单文件版本失败：${err.message}\n`);
  process.exitCode = 1;
});
