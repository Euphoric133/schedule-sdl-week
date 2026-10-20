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

test('侧边栏：点击「专注花园」直接打开独立窗口，不切换页面', async () => {
  await withUi(async ({ dom, instance, services }) => {
    const calls = [];
    const originalOpen = globalThis.open;
    globalThis.open = (url, name, features) => {
      calls.push({ url, name, features });
      return { focus() {} };
    };
    try {
      dom.location.hash = '#/home';
      instance.shell.render();
      const navItem = dom.appHost.children[0].byClass('app-nav__link--window')[0];
      assert.ok(navItem, '侧边栏应有"打开窗口"式的导航项');
      assert.equal(navItem.tagName, 'BUTTON', '必须是 button，才能由点击直接触发新窗口');
      assert.equal(navItem.getAttribute('href'), null, '不应带有页面跳转的 href');

      navItem.click();

      assert.equal(calls.length, 1, '点击应调用一次 window.open');
      assert.match(calls[0].url, /^blob:/, '应通过 Blob URL 打开（两种版本都可用）');
      assert.match(calls[0].features, /width=\d+/, '应指定窗口尺寸');
      assert.match(calls[0].features, /height=\d+/, '应指定窗口尺寸');
      assert.equal(dom.location.hash, '#/home', '点击不应改变当前页面（不是页面跳转）');
    } finally {
      globalThis.open = originalOpen;
    }
  });
});

test('侧边栏：重复点击复用同一个窗口，不会开出一堆', async () => {
  await withUi(async ({ dom, instance }) => {
    const names = [];
    const originalOpen = globalThis.open;
    globalThis.open = (url, name) => {
      names.push(name);
      return { focus() {} };
    };
    try {
      instance.shell.render();
      const navItem = dom.appHost.children[0].byClass('app-nav__link--window')[0];
      navItem.click();
      navItem.click();
      assert.deepEqual(names, ['focus-garden-window', 'focus-garden-window'], '窗口名必须固定，才能复用');
    } finally {
      globalThis.open = originalOpen;
    }
  });
});

test('启动器页：不再内嵌 iframe，而是提供打开窗口的按钮', async () => {
  await withUi(async ({ dom, instance }) => {
    dom.location.hash = '#/garden';
    instance.shell.render();
    const main = dom.appHost.children[0].byClass('app-main')[0];

    assert.equal(
      main.all().filter((node) => node.tagName === 'IFRAME').length,
      0,
      '不应再把花园嵌在页面里',
    );

    const buttons = main.all().filter((node) => node.tagName === 'BUTTON' && node.textContent.trim() === '打开专注花园窗口');
    assert.ok(buttons.length >= 1, '应提供"打开专注花园窗口"按钮');

    const opened = [];
    const originalOpen = globalThis.open;
    globalThis.open = (url) => {
      opened.push(url);
      return { focus() {} };
    };
    try {
      buttons[0].click();
      assert.equal(opened.length, 1, '点击按钮应打开窗口');
    } finally {
      globalThis.open = originalOpen;
    }
  });
});

test('启动器页：开关被拦截时给出可执行的提示，而不是静默失败', async () => {
  await withUi(async ({ dom, instance }) => {
    const originalOpen = globalThis.open;
    globalThis.open = () => null; // 模拟被拦截
    try {
      const result = instance.services.ui.openGardenWindow();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'blocked');
      const notices = dom.document.body.all().filter((node) => node.classList?.contains('notice--danger'));
      assert.ok(notices.length > 0, '必须给出提示');
      assert.match(notices.map((node) => node.textContent).join(' '), /拦截|弹出窗口/);
    } finally {
      globalThis.open = originalOpen;
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
