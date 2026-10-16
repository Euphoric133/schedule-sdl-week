/**
 * 文档一致性测试。
 *
 * 为什么需要：README 里写的运行命令、目录结构、依赖政策一旦与实际不符，
 * 未来接手的人（包括下一个会话的 AI）就会被误导。这些断言很便宜，但能防止文档腐烂。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const REQUIRED_FILES = [
  'index.html',
  'package.json',
  'README.md',
  'PROJECT_SPEC.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'docs/ACCEPTANCE.md',
  'scripts/serve.mjs',
  'scripts/build-standalone.mjs',
  'src/main.js',
  'src/domain/time.js',
  'src/domain/task.js',
  'src/domain/session.js',
  'src/domain/calendarBlock.js',
  'src/domain/plan.js',
  'src/domain/schemas.js',
  'src/storage/storagePort.js',
  'src/storage/localStorageAdapter.js',
  'src/storage/migrations.js',
  'src/storage/backup.js',
  'src/services/appState.js',
  'src/services/taskService.js',
  'src/services/planService.js',
  'src/services/focusService.js',
  'src/ui/shell.js',
  'src/ui/router.js',
  'src/ui/styles/tokens.css',
];

test('项目必需文件都存在（阶段 1 交付清单）', async () => {
  for (const file of REQUIRED_FILES) {
    const info = await stat(join(projectRoot, file)).catch(() => null);
    assert.ok(info?.isFile(), `缺少必需文件：${file}`);
  }
});

test('package.json 保持零运行时依赖，且测试脚本可执行', async () => {
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {}, '运行时依赖必须为空（零依赖原则）');
  assert.deepEqual(pkg.devDependencies, {}, '开发依赖必须为空（测试使用 Node 内置 node:test）');
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.serve, /scripts\/serve\.mjs/);
  assert.match(pkg.scripts['build:standalone'], /scripts\/build-standalone\.mjs/);
  assert.equal(pkg.type, 'module');
});

test('源码中不存在外部包导入（运行时零依赖）', async () => {
  const { readdir } = await import('node:fs/promises');

  async function walk(dir) {
    const entries = await readdir(join(projectRoot, dir), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await walk(rel)));
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
    return files;
  }

  const files = await walk('src');
  assert.ok(files.length >= 20, '应当收集到全部源码模块');
  for (const file of files) {
    const source = await readFile(join(projectRoot, file), 'utf8');
    const external = [...source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'".][^'"]*)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(external, [], `${file} 引入了外部依赖：${external.join(', ')}`);
  }
});

test('索引页引用了入口模块与三份样式，且提供了无脚本提示', async () => {
  const html = await readFile(join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /type="module" src="\.\/src\/main\.js"/);
  assert.match(html, /tokens\.css/);
  assert.match(html, /base\.css/);
  assert.match(html, /components\.css/);
  assert.match(html, /<noscript>/);
  assert.match(html, /id="app"/);
});

test('README 记录了实际的运行命令与依赖政策（防止文档与实际不符）', async () => {
  const readme = await readFile(join(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /node scripts\/serve\.mjs/, 'README 必须写明开发运行命令');
  assert.match(readme, /node --test/, 'README 必须写明测试命令');
  assert.match(readme, /build-standalone\.mjs/, 'README 必须说明单文件构建');
  assert.match(readme, /依赖政策|零依赖/, 'README 必须写明依赖政策');
});

test('CHANGELOG 记录了阶段 1 的改动与已知限制', async () => {
  const changelog = await readFile(join(projectRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /阶段 1|0\.1\.0/, 'CHANGELOG 必须包含阶段 1 条目');
  assert.match(changelog, /已知限制|已知问题/, 'CHANGELOG 必须记录已知限制');
});

test('ARCHITECTURE 说明了分层与单向依赖，并记录引擎尚未实现', async () => {
  const arch = await readFile(join(projectRoot, 'ARCHITECTURE.md'), 'utf8');
  assert.match(arch, /src\/domain/);
  assert.match(arch, /src\/engine/, '必须为阶段 2 的引擎预留并说明分层');
  assert.match(arch, /单向|依赖方向/);
});
