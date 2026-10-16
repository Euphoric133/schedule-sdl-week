#!/usr/bin/env node
/**
 * 生成单文件版本：把 CSS 与全部 ES Module 内联进一个 HTML。
 *
 * 为什么需要它：
 * 浏览器对 ES Module 有同源限制，`file://` 直接打开 index.html 时 import 会被拦截。
 * 内联成单文件后，dist/standalone.html 可以双击直接用（不需要服务器、没有任何依赖）。
 *
 * 实现说明（有意保持简单，但**不是**把源码拼在一起）：
 * 每个模块被包进一个 IIFE，并返回自己的导出对象；导入语句被改写成从"模块注册表"取值。
 * 这样做是必须的：项目里存在同名但不同实现的顶层声明
 * （例如 domain/plan.js 与 engine/capacity.js 都有 computeDayCapacity），
 * 直接拼接会导致重复声明报语法错误，或者更糟——静默用错实现。
 *
 * 约束（脚本会在违反时报错，而不是产出错误的包）：
 * - 只支持静态 import；出现动态 import 直接失败。
 * - 不支持 import 外部包（运行时零依赖）。
 * - 循环依赖会被拒绝（本项目当前没有循环依赖）。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目根目录 = 本脚本所在目录的上一级（scripts/ → 项目根）。
 * 显式用 dirname 计算，避免不同 Node 版本对 `new URL('..', fileUrl)` 的处理差异
 * 导致相对路径解析到错误目录（曾出现把 src/ 前缀吃掉、找不到模块的问题）。
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const ENTRY = join(projectRoot, 'src', 'main.js');
const OUT_DIR = join(projectRoot, 'dist');
const OUT_FILE = join(OUT_DIR, 'standalone.html');

/** 递归收集入口可达的所有本地模块（深度优先 → 依赖在前、入口在后） */
async function collectModules(file, collected = new Map(), stack = []) {
  const absolute = resolve(file);
  if (collected.has(absolute)) return collected;
  if (stack.includes(absolute)) {
    throw new Error(
      `检测到循环依赖，无法安全内联：${stack.map((p) => relative(projectRoot, p)).join(' → ')} → ${relative(projectRoot, absolute)}`,
    );
  }

  const source = await readFile(absolute, 'utf8');
  // 去掉注释后再检测动态 import：JSDoc 里的 `{import('./x.js').T}` 是类型注解，
  // 不是运行时代码，不该被当成动态导入拒绝掉。
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  if (/^\s*export\s+\*/m.test(source)) {
    throw new Error(`${relative(projectRoot, absolute)} 使用了 \`export * from\`，当前内联脚本不支持，请改为显式列出导出。`);
  }
  if (/\bimport\s*\(\s*['"`]/.test(codeOnly)) {
    throw new Error(`${relative(projectRoot, absolute)} 使用了动态 import()，当前内联脚本不支持，请改用静态 import。`);
  }

  const specifiers = [...source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?/gm)].map((m) => m[1]);
  const nextStack = [...stack, absolute];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) {
      throw new Error(
        `${relative(projectRoot, absolute)} 引入了外部依赖「${specifier}」。本项目的运行时代码必须零依赖（见 README 依赖政策）。`,
      );
    }
    await collectModules(resolve(dirname(absolute), specifier), collected, nextStack);
  }

  collected.set(absolute, { source, absolute });
  return collected;
}

/** 收集模块导出的名字（含 `export { X }` 再导出） */
function collectExportNames(source) {
  const named = new Set();
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm)) {
    for (const part of match[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/);
      const exported = (alias[1] ?? alias[0] ?? '').trim();
      if (exported) named.add(exported);
    }
  }
  for (const match of source.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    named.add(match[1]);
  }
  return named;
}

/** 把模块源码改写成 IIFE：导入 → 从注册表取值，导出 → 返回导出对象 */
function transformModule(source, moduleId, exportsByAbsolute, idByAbsolute, absolute) {
  const importLines = [];
  let out = source;

  out = out.replace(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (match, clause, specifier) => {
    void match;
    const targetAbsolute = resolve(dirname(absolute), specifier);
    const targetId = idByAbsolute.get(targetAbsolute);
    if (!targetId) throw new Error(`无法解析导入路径：${specifier}（来自 ${moduleId}）`);
    const targetExports = exportsByAbsolute.get(targetAbsolute);
    if (!targetExports) throw new Error(`缺少导出信息：${targetId}`);

    const trimmed = clause.trim();
    const lines = [];
    if (trimmed.startsWith('*')) {
      // `import * as ns from '...'` → 命名空间对象
      const namespaceName = trimmed.replace(/^\*\s+as\s+/, '').trim();
      if (!namespaceName) throw new Error(`${moduleId} 中的 import * 写法无法解析：${trimmed}`);
      lines.push(`const ${namespaceName} = __modules__[${JSON.stringify(targetId)}].named;`);
    } else if (trimmed.startsWith('{')) {
      const rawClause = trimmed.replace(/^\{/, '').replace(/\}\s*$/, '');
      validateImportedNames(rawClause, targetExports, targetId, moduleId);
      const destructure = toDestructurePattern(rawClause);
      lines.push(`const {${destructure}} = __modules__[${JSON.stringify(targetId)}].named;`);
    } else {
      const parts = trimmed.split(',');
      const defaultName = parts[0].trim();
      if (defaultName) lines.push(`const ${defaultName} = __modules__[${JSON.stringify(targetId)}].named.default;`);
      const rest = parts.slice(1).join(',').trim();
      if (rest.startsWith('{')) {
        const rawClause = rest.replace(/^\{/, '').replace(/\}\s*$/, '');
        validateImportedNames(rawClause, targetExports, targetId, moduleId);
        const destructure = toDestructurePattern(rawClause);
        lines.push(`const {${destructure}} = __modules__[${JSON.stringify(targetId)}].named;`);
      }
    }
    importLines.push(lines.join('\n'));
    return '';
  });

  out = out.replace(/^\s*import\s+['"][^'"]+['"];?[ \t]*$/gm, '');

  /**
   * 导出表：`导出名 -> 本地名`。
   *
   * 必须区分这两种写法，否则会生成引用不存在变量的代码：
   * - `export function foo() {}`  → 导出名与本地名都是 foo；
   * - `export { bar as POMODORO_END_REASON }` → 导出名是 POMODORO_END_REASON，本地名是 bar。
   *   只记录导出名（旧实现的做法）会让注册表里出现 `POMODORO_END_REASON`，
   *   但模块作用域里根本没有这个变量，单文件版本一启动就 ReferenceError。
   */
  const exportMap = new Map();
  // 导出名必须在删除 export 关键字**之前**收集：删除之后源码里就没有 "export" 了。
  for (const match of out.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    exportMap.set(match[1], match[1]);
  }

  out = out.replace(/^\s*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (match, body) => {
    void match;
    for (const part of body.split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      const local = (alias[0] ?? '').trim();
      const exported = (alias[1] ?? alias[0] ?? '').trim();
      if (exported && local) exportMap.set(exported, local);
    }
    return '';
  });
  // 删除 export 关键字：这些名字已经在上面记录过，剥离后不影响运行
  out = out.replace(/^([ \t]*)export[ \t]+((?:async[ \t]+)?(?:const|let|var|function|class))/gm, '$1$2');

  if (/^export\s+default\s/m.test(source)) {
    out = out.replace(/^([ \t]*)export[ \t]+default[ \t]+/gm, '$1const __default__ = ');
    exportMap.set('default', '__default__');
  }

  if (/^[ \t]*export[ \t]/m.test(out)) {
    const leftover = out.match(/^[ \t]*export[ \t].*$/m)?.[0]?.trim();
    throw new Error(`${moduleId} 中仍有无法处理的 export 语法：${leftover}`);
  }
  if (/^[ \t]*import[ \t]/m.test(out)) {
    const leftover = out.match(/^[ \t]*import[ \t].*$/m)?.[0]?.trim();
    throw new Error(`${moduleId} 中仍有无法处理的 import 语法：${leftover}`);
  }

  // 导出名与本地名不同的，补一个等价的本地 const，让注册表可以按导出名直接引用
  const aliases = [...exportMap.entries()]
    .filter(([exported, local]) => exported !== local && exported !== 'default')
    .map(([exported, local]) => `const ${exported} = ${local};`);

  const namedEntries = [...exportMap.keys()].map((exported) =>
    exported === 'default' ? 'default: __default__' : toObjectProperty(exported),
  );
  const body = [importLines.filter(Boolean).join('\n'), out, aliases.join('\n')]
    .filter((part) => part.trim().length > 0)
    .join('\n');

  return `__modules__[${JSON.stringify(moduleId)}] = (function () {\n${body}\nreturn { named: {${namedEntries.join(', ')}} };\n})();`;
}

/**
 * 把 ES Module 的别名语法转成对象解构语法。
 * `{ foo as bar, baz }` → `foo: bar, baz`
 * 不转换会得到 `const { foo as bar } = ...`，这是非法语法（`as` 不是 JS 关键字）。
 */
function toDestructurePattern(clause) {
  return clause
    .split(',')
    .map((part) => {
      const raw = part.trim();
      if (!raw) return '';
      const alias = raw.split(/\s+as\s+/);
      return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : raw;
    })
    .filter(Boolean)
    .join(', ');
}

/** 把导出名转成导出对象的属性写法：`bar` → `bar`；`a as b` 已在收集阶段拆成 b */
function toObjectProperty(name) {
  const alias = name.split(/\s+as\s+/);
  if (alias.length === 2) return `${alias[1].trim()}: ${alias[0].trim()}`;
  return name;
}

/** 校验导入的命名确实存在，避免产出一个运行到一半才报错的包 */
function validateImportedNames(destructure, exportedNames, targetId, importerId) {
  for (const part of destructure.split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    const name = raw.split(/\s+as\s+/)[0].trim();
    if (!name) continue;
    if (!exportedNames.has(name)) {
      throw new Error(`${importerId} 从 ${targetId} 导入了不存在的导出「${name}」。请检查拼写或补充导出。`);
    }
  }
}

async function main() {
  const modules = await collectModules(ENTRY);

  const idByAbsolute = new Map();
  for (const absolute of modules.keys()) {
    idByAbsolute.set(absolute, relative(projectRoot, absolute).split(sep).join('/'));
  }

  const exportsByAbsolute = new Map();
  for (const [absolute, { source }] of modules) {
    exportsByAbsolute.set(absolute, collectExportNames(source));
  }

  const parts = [];
  for (const [absolute, { source }] of modules) {
    const moduleId = idByAbsolute.get(absolute);
    parts.push(
      `/* ==== ${moduleId} ==== */\n${transformModule(source, moduleId, exportsByAbsolute, idByAbsolute, absolute)}`,
    );
  }

  const cssFiles = [
    join(projectRoot, 'src', 'ui', 'styles', 'tokens.css'),
    join(projectRoot, 'src', 'ui', 'styles', 'base.css'),
    join(projectRoot, 'src', 'ui', 'styles', 'components.css'),
  ];
  const css = (await Promise.all(cssFiles.map((file) => readFile(file, 'utf8')))).join('\n\n');

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
   修改源码后重新运行：node scripts/build-standalone.mjs
   结构：__modules__ 是模块注册表；每个模块被包在 IIFE 内，避免同名声明互相冲突。 */
(function () {
'use strict';
var __modules__ = Object.create(null);
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
