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
  // 说明：它是"打开独立窗口"，但路由仍然保留，供地址栏直达启动器页
});

test('侧边栏：「专注花园」是普通页面入口（不再开新窗口）', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/home';
    instance.shell.render();

    const gardenLink = dom.appHost.children[0].byClass('app-nav__link').find((node) => node.textContent.includes('专注花园'));
    assert.ok(gardenLink, '侧边栏应有花园入口');
    assert.equal(gardenLink.tagName, 'A', '应为普通链接');
    assert.equal(gardenLink.getAttribute('href'), '#/garden');

    let opened = 0;
    const originalOpen = globalThis.open;
    globalThis.open = () => {
      opened += 1;
      return null;
    };
    try {
      gardenLink.click?.();
    } finally {
      globalThis.open = originalOpen;
    }
    assert.equal(opened, 0, '点击导航不应打开新窗口');
  });
});

test('内嵌：进入花园时显示常驻 iframe，隐藏普通页面区域', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();

    const shell = dom.appHost.children[0];
    const host = shell.byClass('garden-host')[0];
    const main = shell.byClass('app-main')[0];

    assert.ok(host, '应有花园宿主容器');
    assert.equal(host.hidden, false, '进入花园时宿主必须可见');
    assert.equal(main.hidden, true, '花园路由下普通页面区域应隐藏');

    const frame = host.all().find((node) => node.tagName === 'IFRAME');
    assert.ok(frame, '宿主里应有 iframe');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    assert.ok(srcdoc.length > 100_000, `srcdoc 应为完整应用，实际 ${srcdoc.length}`);
    assert.match(srcdoc, /^<!doctype html>/i);
    assert.ok(srcdoc.includes('id="root"'), '应包含花园的 #root 挂载点');
    assert.equal(frame.getAttribute('title'), '专注花园', 'iframe 需要无障碍名称');
    assert.equal(frame.getAttribute('sandbox'), null, '不加 sandbox，保证花园功能与存储不被限制');
  });
});

test('计时不中断：切换页面后仍是同一个 iframe，srcdoc 不被重写', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();

    const shell = dom.appHost.children[0];
    const host = shell.byClass('garden-host')[0];
    const first = host.all().find((node) => node.tagName === 'IFRAME');
    const firstSrcdoc = first.getAttribute('srcdoc');
    assert.ok(first, '第一次进入应创建 iframe');

    // 切走 → 再切回，来回多次
    for (let i = 0; i < 3; i += 1) {
      dom.location.hash = '#/home';
      instance.shell.render();
      assert.equal(host.hidden, true, '离开花园时宿主应隐藏');
      assert.ok(host.all().some((node) => node.tagName === 'IFRAME'), '隐藏时 iframe 仍必须留在 DOM 里');

      dom.location.hash = '#/garden';
      instance.shell.render();
      assert.equal(host.hidden, false, '回到花园时宿主应重新可见');
    }

    const frames = host.all().filter((node) => node.tagName === 'IFRAME');
    assert.equal(frames.length, 1, '任何情况下都只应有一个 iframe（不重复创建）');
    assert.equal(frames[0], first, '必须是同一个 DOM 节点（重建会重置计时器）');
    assert.equal(frames[0].getAttribute('srcdoc'), firstSrcdoc, 'srcdoc 不能被重写（重写等于刷新，计时归零）');
  });
});

test('不加 sandbox：花园需要同源存储来保存专注记录', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();
    const frame = dom.appHost.children[0].byClass('garden-host')[0].all().find((n) => n.tagName === 'IFRAME');
    assert.equal(frame.getAttribute('sandbox'), null, '有 sandbox 会限制 localStorage 或脚本，花园功能会失效');
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
