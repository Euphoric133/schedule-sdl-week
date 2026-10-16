#!/usr/bin/env node
/**
 * 零依赖静态文件服务器（仅用于本地开发预览）。
 *
 * 为什么需要它：
 * 浏览器对 ES Module 有同源限制，直接以 file:// 打开 index.html 时
 * `import` 会被 CORS 拦截。开发时用这个脚本起一个本地服务器即可。
 * 生产/离线使用可直接打开 dist/standalone.html（由 build-standalone.mjs 生成）。
 *
 * 用法：node scripts/serve.mjs [端口]
 * 安全：只监听 127.0.0.1（不对外网开放），只读取当前项目目录内的文件。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录 = 本脚本所在目录的上一级（scripts/ → 项目根）
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const port = Number.parseInt(process.argv[2] ?? process.env.PORT ?? '4173', 10);
const host = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const requested = decodeURIComponent(url.pathname);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');

    // 路径穿越防护：解析后的绝对路径必须仍在项目目录内
    const target = resolve(join(projectRoot, normalize(relative)));
    if (target !== projectRoot && !target.startsWith(projectRoot + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 拒绝访问：请求的路径不在项目目录内。');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 找不到：${relative}`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 服务器错误：${err.message}`);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`七天学习规划器已启动：http://${host}:${port}/\n`);
  process.stdout.write('按 Ctrl+C 停止。所有数据仅保存在浏览器本地。\n');
});
