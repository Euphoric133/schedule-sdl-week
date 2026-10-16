/**
 * 脚本冒烟测试（对应"最终必须能真正运行"的交付要求）。
 *
 * 这里不使用浏览器，而是验证：
 * - 本地静态服务器能启动并正确返回 index.html 与模块文件，且拒绝路径穿越
 * - 单文件版本能被成功生成，且生成物内联了全部模块、没有残留的 import/export 语法
 *
 * 说明：真实的浏览器渲染验收由 docs/ACCEPTANCE.md 的人工步骤覆盖，
 * 因为目前没有安装 jsdom 之类的 DOM 实现（依赖政策：非必要不新增依赖）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 tests/integration/，因此需要向上一级到 tests/，再向上一级到项目根目录
const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const nodeBin = process.execPath;

/** 启动脚本并等待其输出指定文本（或超时） */
function runScript(args, { readyPattern, timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(nodeBin, args, { cwd: projectRoot });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`脚本超时未就绪：${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!settled && readyPattern && readyPattern.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ child, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (readyPattern) {
        rejectPromise(new Error(`脚本提前退出（code=${code}）\nstdout: ${stdout}\nstderr: ${stderr}`));
      } else {
        resolvePromise({ code, stdout: () => stdout, stderr: () => stderr });
      }
    });
  });
}

test('本地静态服务器：能返回 index.html，且仅监听回环地址', async (t) => {
  const port = 4187;
  const { child, stdout } = await runScript(['scripts/serve.mjs', String(port)], { readyPattern: /http:\/\/127\.0\.0\.1/ });
  t.after(() => child.kill('SIGKILL'));

  assert.match(stdout(), /127\.0\.0\.1/);

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /src\/main\.js/);

  const module = await fetch(`http://127.0.0.1:${port}/src/main.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type') ?? '', /javascript/);

  const css = await fetch(`http://127.0.0.1:${port}/src/ui/styles/tokens.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /css/);
});

test('本地静态服务器：拒绝目录穿越与不存在的路径', async (t) => {
  const port = 4188;
  const { child } = await runScript(['scripts/serve.mjs', String(port)], { readyPattern: /http:\/\/127\.0\.0\.1/ });
  t.after(() => child.kill('SIGKILL'));

  const missing = await fetch(`http://127.0.0.1:${port}/no-such-file.js`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`http://127.0.0.1:${port}/../../etc/hosts`);
  assert.ok([403, 404].includes(traversal.status), `路径穿越必须被拒绝，实际 ${traversal.status}`);
});

test('单文件构建：生成 dist/standalone.html，内联全部模块且没有残留模块语法', async () => {
  const distFile = join(projectRoot, 'dist', 'standalone.html');
  await rm(distFile, { force: true });

  const { code, stdout, stderr } = await runScript(['scripts/build-standalone.mjs']);
  assert.equal(code, 0, stderr());

  const info = await stat(distFile);
  assert.ok(info.size > 10_000, '生成物应当包含全部代码');

  const html = await readFile(distFile, 'utf8');
  assert.match(stdout(), /已生成 dist\/standalone\.html/);
  assert.match(html, /<style>/, '样式必须被内联');
  assert.match(html, /id="app"/);
  assert.match(html, /七天学习规划器/, '标题必须保留');

  // 关键：内联后不能残留顶层 import / export 语句，否则浏览器会直接报语法错误
  const scriptBody = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  assert.equal(/^\s*import\s/m.test(scriptBody), false, '内联脚本中不应残留 import 语句');
  assert.equal(/^\s*export\s/m.test(scriptBody), false, '内联脚本中不应残留 export 语句');

  // 语法自检：把内联脚本当作普通脚本解析一次，能提前发现拼接造成的语法错误
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(scriptBody);
  }, '内联脚本必须能被解析（语法正确）');
});
