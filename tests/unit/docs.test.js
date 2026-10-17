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
  'src/services/preferences.js',
  'src/services/appearanceService.js',
  'src/services/notificationService.js',
  'src/services/statsService.js',
  'src/storage/wallpaperStore.js',
  'src/ui/labels.js',
  'src/ui/pages/home.js',
  'src/ui/pages/appearance.js',
  'src/ui/pages/notifications.js',
  'src/ui/pages/stats.js',
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

test('CHANGELOG 记录了每个版本的改动、测试结果与已知问题', async () => {
  const changelog = await readFile(join(projectRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[1\.0\.0\]/, '必须包含当前版本条目');
  assert.match(changelog, /测试结果/, 'CHANGELOG 必须记录真实测试结果');
  assert.match(changelog, /已知限制|已知问题/, 'CHANGELOG 必须记录已知限制');
});

test('ARCHITECTURE 说明了分层与单向依赖，并覆盖引擎与新服务层', async () => {
  const arch = await readFile(join(projectRoot, 'ARCHITECTURE.md'), 'utf8');
  assert.match(arch, /src\/domain/);
  assert.match(arch, /src\/engine/, '必须说明引擎的分层位置');
  assert.match(arch, /单向|依赖方向/);
  assert.match(arch, /mutations/, '必须说明草稿变更层（写入路径唯一实现）');
});

test('样式：响应式与主题覆盖到所有关键结构（不只是背景变色）', async () => {
  const tokens = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'tokens.css'), 'utf8');
  const components = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'components.css'), 'utf8');

  // 主题：三种选择都要有对应规则，并且深色下重定义了**语义色**而不是只改背景
  assert.match(tokens, /\[data-theme='dark'\]/, '必须有显式深色主题');
  assert.match(tokens, /prefers-color-scheme: dark/, '必须支持跟随系统');
  for (const token of ['--color-surface', '--color-text', '--color-border', '--color-primary']) {
    const darkBlock = tokens.slice(tokens.indexOf("[data-theme='dark']"));
    assert.ok(darkBlock.includes(token), `深色主题必须重定义 ${token}，否则会出现"只有背景变色"`);
  }

  // 壁纸：固定遮罩保证可读性（显示方式/模糊/遮罩的可调项已按需求移除）
  assert.match(tokens, /#app-wallpaper/, '壁纸必须是独立的背景层');
  assert.match(tokens, /#app-wallpaper::after/, '壁纸必须有遮罩层，保证文字可读');

  // 响应式：窄屏必须重新布局，而不是让侧边栏挤掉内容
  assert.match(components, /@media \(max-width: 900px\)/, '必须有窄屏断点');
  assert.match(components, /grid-template-areas:\s*\n?\s*'brand'/, '窄屏应改为单列布局');

  // 动画必须尊重"减少动态效果"偏好
  assert.match(tokens, /prefers-reduced-motion/, '必须支持减少动态效果');
});

test('样式：焦点可见性与屏幕阅读器工具类存在（可访问性基础）', async () => {
  const components = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'components.css'), 'utf8');
  assert.match(components, /:focus-visible/, '必须有可见的键盘焦点样式');
  assert.match(components, /\.sr-only/, '必须有屏幕阅读器专用工具类');
  // 番茄钟与固定专注栏已移除：不应再残留它们的样式
  assert.equal(/\.focus-bar/.test(components), false, '固定专注栏已移除');
  assert.equal(/\.focus-timer/.test(components), false, '番茄钟计时环已移除');
  assert.equal(/\.wheel__/.test(components), false, '奖励转盘已移除');
});
