#!/usr/bin/env node
/**
 * Cloudflare Pages 的构建脚本（零依赖）。
 *
 * 为什么需要它：
 * Cloudflare Pages 会把仓库里**所有**文件当作静态资源发布，且没有
 * "排除某个目录"的配置项（官方建议在构建命令里删）。
 * 仓库里有 versions/（60 个历史快照，60 MB）与 tests/ 等与站点无关的内容，
 * 全部发布既慢又多暴露历史页面。
 *
 * 做法：把站点实际需要的文件复制到 dist/pages/，构建输出目录指向它。
 * 这样发布的内容是**白名单**而不是"仓库全集"，新增目录不会被意外发布。
 *
 * 站点需要的只有：index.html + src/（index.html 只引用 ./src/）。
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const out = join(root, 'dist', 'pages');

/** 必须发布的条目（白名单） */
const INCLUDE = ['index.html', 'src'];

async function exists(path) {
  return (await stat(path).catch(() => null)) !== null;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

let copied = 0;
for (const entry of INCLUDE) {
  const from = join(root, entry);
  if (!(await exists(from))) {
    console.error(`缺少必需文件：${entry}`);
    process.exit(1);
  }
  await cp(from, join(out, entry), {
    recursive: true,
    filter: (source) => !source.includes('.DS_Store'),
  });
  copied += 1;
}

// 自检：入口文件必须在，且引用的模块目录必须存在
if (!(await exists(join(out, 'index.html')))) {
  console.error('构建产物缺少 index.html');
  process.exit(1);
}
if (!(await exists(join(out, 'src', 'main.js')))) {
  console.error('构建产物缺少 src/main.js');
  process.exit(1);
}

console.log(`已生成 dist/pages（${copied} 个条目）：index.html + src/`);
