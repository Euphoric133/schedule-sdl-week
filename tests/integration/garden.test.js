/**
 * 专注花园（内嵌独立应用）的集成测试。
 *
 * 关注点：
 * - 侧边栏入口存在，且位置正确（学习统计之后）；
 * - 页面用 iframe + srcdoc 承载，内容确实是花园那份单文件应用；
 * - 提供"在新窗口打开"；
 * - 内联模块与源文件保持一致（避免改了源文件忘记重新生成）；
 * - 单文件版（dist/standalone.html）里也能打开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');

let domModulePromise = null;
async function getDomModule() {
  if (!domModulePromise) {
    domModulePromise = (async () => {
      const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
      const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
      const target = '/tmp/garden-fakedom.mjs';
      await writeFile(target, code);
      return import(target);
    })();
  }
  return domModulePromise;
}

async function withUi(fn) {
  const { installFakeDom } = await getDomModule();
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 13, 23) });
  try {
    return await fn({ dom, instance, services: instance.services });
  } finally {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) delete globalThis[key];
  }
}

/* ================================================================== *
 * 入口与位置
 * ================================================================== */

test('侧边栏：有「专注花园」入口，且紧跟在「学习统计」之后', async () => {
  const { ROUTES } = await import('../../src/ui/router.js');
  const paths = ROUTES.map((route) => route.path);
  const gardenIndex = paths.indexOf('garden');
  assert.ok(gardenIndex >= 0, '路由表里必须有 garden');
  assert.equal(paths[gardenIndex - 1], 'stats', '应紧跟在"学习统计"之后');

  const garden = ROUTES.find((route) => route.path === 'garden');
  assert.equal(garden.label, '专注花园');
  assert.ok(garden.icon, '导航项应有图标');
});

test('渲染：花园页用 iframe + srcdoc 承载，内容就是那份单文件应用', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();

    const main = dom.appHost.children[0].byClass('app-main')[0];
    const iframe = main.all().find((node) => node.tagName === 'IFRAME');
    assert.ok(iframe, '页面必须包含一个 iframe');

    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    assert.ok(srcdoc.length > 100_000, `srcdoc 应该是完整应用，实际 ${srcdoc.length} 字符`);
    assert.match(srcdoc, /^<!doctype html>/i, '应当是完整的 HTML 文档');
    assert.ok(srcdoc.includes('id="root"'), '应当包含花园的 #root 挂载点');
    assert.ok(srcdoc.trimEnd().endsWith('</html>'), '应当是完整的 HTML 结尾');

    // 花园需要脚本与本地存储；sandbox 必须放行，否则页面会是空白
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    assert.match(sandbox, /allow-scripts/, 'sandbox 必须允许脚本');
    assert.match(sandbox, /allow-same-origin/, 'sandbox 必须允许同源（否则 localStorage 不可用）');

    assert.equal(iframe.getAttribute('title'), '专注花园', 'iframe 需要无障碍名称');
  });
});

test('渲染：提供「在新窗口打开」，并对弹窗被拦给出提示', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();
    const main = dom.appHost.children[0].byClass('app-main')[0];
    const openButton = main.all().find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === '在新窗口打开');
    assert.ok(openButton, '应有"在新窗口打开"按钮');

    // 模拟被浏览器拦截：不应抛异常，且要给出提示
    const originalOpen = globalThis.open;
    const originalUrl = globalThis.URL;
    globalThis.open = () => null;
    globalThis.URL = Object.assign(function URL() {}, { createObjectURL: () => 'blob:probe', revokeObjectURL: () => {} });
    try {
      assert.doesNotThrow(() => openButton.click());
    } finally {
      globalThis.open = originalOpen;
      globalThis.URL = originalUrl;
    }
  });
});

/* ================================================================== *
 * 内容一致性
 * ================================================================== */

test('内联模块：与 focus-garden.html 保持一致（改了源文件必须重新生成）', async () => {
  const { FOCUS_GARDEN_HTML } = await import('../../src/embed/focusGardenHtml.js');
  const source = await readFile(join(projectRoot, 'focus-garden.html'), 'utf8');

  assert.ok(FOCUS_GARDEN_HTML.length > 100_000, '内联内容不应为空');

  // 生成时会去掉依赖相对路径的图标/manifest 外链（srcdoc 里无法解析），
  // 因此只比较"去掉这些外链后的内容"。
  const normalize = (html) =>
    html
      .replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '')
      .replace(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>\s*/gi, '');

  assert.equal(
    FOCUS_GARDEN_HTML,
    normalize(source),
    '内联内容与源文件不一致：请运行 node scripts/build-garden-embed.mjs 重新生成',
  );
});

test('内联模块：不含未转义的 </script（否则单文件版会被截断）', async () => {
  const moduleSource = await readFile(join(projectRoot, 'src', 'embed', 'focusGardenHtml.js'), 'utf8');
  assert.equal(/<\/script/i.test(moduleSource), false, '模块源码里不能出现未转义的 </script');
  assert.ok(moduleSource.includes('<\\/script'), '应使用 <\\/script 转义');
});

test('单文件版：内联了花园，且脚本结构完整', async () => {
  const distPath = join(projectRoot, 'dist', 'standalone.html');
  const exists = await stat(distPath).then(() => true).catch(() => false);
  assert.equal(exists, true, '需要先运行 node scripts/build-standalone.mjs');

  const html = await readFile(distPath, 'utf8');
  assert.ok(html.includes('id=\\"root\\"') || html.includes('id="root"'), '单文件版应包含花园的 #root 标记');
  // 整个包只应有一个 </script>（即包自己的结束标签），否则说明字符串把脚本提前截断了
  const closings = html.match(/<\/script>/gi) ?? [];
  assert.equal(closings.length, 1, `</script> 应只有 1 个，实际 ${closings.length} 个`);
  assert.ok(html.trimEnd().endsWith('</html>'), '产物应完整结束');
});
