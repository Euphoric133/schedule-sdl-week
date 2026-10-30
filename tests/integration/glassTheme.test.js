/**
 * 液态玻璃主题的静态约束。
 *
 * 这些断言保护的是**可读性与性能边界**，不是具体像素：
 * 玻璃可以有，但不能回到"整页发蒙"的老路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const readStyle = (name) => readFile(join(projectRoot, 'src', 'ui', 'styles', name), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('令牌：浅色与深色都定义了完整的 --glass-* 变量', async () => {
  const css = await readStyle('tokens.css');
  const required = [
    '--glass-blur',
    '--glass-saturate',
    '--glass-bg',
    '--glass-bg-strong',
    '--glass-border',
    '--glass-highlight',
    '--glass-shadow',
    '--glass-shadow-hover',
    '--glass-radius-lg',
    '--glass-radius-md',
    '--glass-noise-opacity',
  ];
  for (const token of required) {
    assert.ok(css.includes(token), `缺少令牌 ${token}`);
  }

  const dark = css.slice(css.indexOf(":root[data-theme='dark']"));
  for (const token of ['--glass-bg', '--glass-border', '--glass-shadow']) {
    assert.ok(dark.includes(token), `深色主题缺少 ${token}`);
  }
});

test('可读性：整页容器不允许 backdrop-filter', async () => {
  const components = stripComments(await readStyle('components.css'));
  for (const selector of ['body', '.app', '.app-main']) {
    const pattern = new RegExp(`(^|[},])\\s*${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`, 'g');
    for (const block of components.match(pattern) ?? []) {
      assert.equal(/backdrop-filter/.test(block), false, `${selector} 不能模糊（会让整页发蒙）`);
    }
  }
});

test('可读性：内容卡片只做 tint，不模糊', async () => {
  const components = stripComments(await readStyle('components.css'));
  const cardBlocks = components.match(/(^|[},])\s*\.card\s*\{[^}]*\}/g) ?? [];
  assert.ok(cardBlocks.length >= 1);
  for (const block of cardBlocks) {
    assert.equal(/backdrop-filter/.test(block), false);
  }
});

test('玻璃：外壳与浮层确实使用了模糊 + 饱和度', async () => {
  const components = stripComments(await readStyle('components.css'));
  const shell = components.slice(components.indexOf('.app-brand,'));
  assert.match(shell, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s*saturate\(var\(--glass-saturate\)\)/);
  assert.match(components, /-webkit-backdrop-filter/, '必须同时写 -webkit 前缀');

  const dialog = components.slice(components.indexOf('dialog {'));
  assert.match(dialog, /blur\(var\(--glass-blur-strong\)\)/, '弹窗应使用更强的模糊');
});

test('玻璃：四层材质齐备（底色 / 模糊 / 边缘光 / 投影）', async () => {
  const components = stripComments(await readStyle('components.css'));
  const shell = components.slice(components.indexOf('.app-brand,'));
  assert.match(shell, /background:\s*var\(--glass-bg\)/, '半透明底色');
  assert.match(shell, /backdrop-filter/, '模糊');
  assert.match(shell, /inset 0 1px 0 var\(--glass-highlight\)/, '顶部内侧高光');
  assert.match(shell, /inset 0 -1px 0 var\(--glass-shade\)/, '底部内侧暗边');
});

test('壁纸：玻璃更实，且氛围层自动隐藏', async () => {
  const tokens = await readStyle('tokens.css');
  const base = stripComments(await readStyle('base.css'));
  assert.match(tokens, /:root\[data-wallpaper='on'\]\s*\{[\s\S]*--glass-bg-card/, '壁纸下卡片应更不透明');
  assert.match(base, /:root\[data-wallpaper='on'\]\s+\.ambient-field\s*\{\s*display:\s*none/, '壁纸下应隐藏氛围层');
});

test('氛围层：固定层、不接收事件、不漂移到内容之上', async () => {
  const base = stripComments(await readStyle('base.css'));
  const block = base.slice(base.indexOf('.ambient-field {'));
  assert.match(block, /position:\s*fixed/);
  assert.match(block, /z-index:\s*-2/, '必须在壁纸（-1）之下');
  assert.match(block, /pointer-events:\s*none/);
  assert.match(base, /@keyframes ambient-drift/);
});

test('降级：不支持 backdrop-filter / 减少透明 / 减少动态 / 强制颜色 / 打印', async () => {
  const tokens = await readStyle('tokens.css');
  const components = await readStyle('components.css');
  const base = await readStyle('base.css');

  assert.match(tokens, /@supports not \(\(backdrop-filter: blur\(1px\)\)/, '需要 @supports 降级');
  assert.match(tokens, /prefers-reduced-transparency: reduce/, '需要减少透明度支持');
  assert.match(components, /prefers-reduced-transparency: reduce/);
  assert.match(components, /forced-colors: active/, '需要强制颜色模式处理');
  assert.match(components, /@media print/, '需要打印样式');
  assert.match(base, /prefers-reduced-motion: reduce[\s\S]*ambient-field/, '减少动态时氛围层停止漂移');
});

test('移动端：模糊降档', async () => {
  const components = stripComments(await readStyle('components.css'));
  const mobile = components.slice(components.indexOf('@media (max-width: 720px)'));
  assert.match(mobile, /blur\(var\(--glass-blur-soft\)\)/, '移动端应使用更小的模糊');
});

test('无外部依赖：样式里不出现远程资源', async () => {
  for (const name of ['tokens.css', 'base.css', 'components.css']) {
    const css = await readStyle(name);
    assert.equal(/url\(\s*['"]?https?:/i.test(css), false, `${name} 不应引用远程资源`);
  }
});

test('样式语法：三份样式表都没有损坏的注释或多/漏的大括号', async () => {
  for (const name of ['tokens.css', 'base.css', 'components.css']) {
    const css = await readStyle(name);

    // 注释必须成对（曾经有一段注释丢了开头，导致它后面的 .app 规则被整条丢弃）
    let stack = 0;
    let extraClose = 0;
    for (const match of css.matchAll(/\/\*|\*\//g)) {
      if (match[0] === '/*') stack += 1;
      else if (stack > 0) stack -= 1;
      else extraClose += 1;
    }
    assert.equal(stack, 0, `${name} 有未闭合的注释`);
    assert.equal(extraClose, 0, `${name} 有多余的 */`);

    assert.equal(css.split('{').length, css.split('}').length, `${name} 大括号不配对`);

    // 不能出现"裸文本"式伪注释（* === 开头却没有 /*）
    assert.equal(/(^|\n)\s*\*\s*=+/.test(css), false, `${name} 出现没有 /* 的注释残片`);
  }
});

test('结构：外壳三块与卡片都带 data-glass（镜面高光只作用于声明过的表面）', async () => {
  const shellSource = await readFile(join(projectRoot, 'src', 'ui', 'shell.js'), 'utf8');
  const componentsSource = await readFile(join(projectRoot, 'src', 'ui', 'components.js'), 'utf8');
  const boardSource = await readFile(join(projectRoot, 'src', 'ui', 'board.js'), 'utf8');
  const domSource = await readFile(join(projectRoot, 'src', 'ui', 'dom.js'), 'utf8');
  const modalSource = await readFile(join(projectRoot, 'src', 'ui', 'modal.js'), 'utf8');

  // 品牌区由一个指向首页的链接构成（可键盘聚焦、可回车），仍然必须带 data-glass
  assert.match(shellSource, /el\('a\.app-brand',\s*\{\s*'data-glass': ''/, '品牌区应带 data-glass');
  assert.match(shellSource, /href: '#\/home'/, '品牌区应是指回首页的链接');
  assert.match(shellSource, /el\('header\.app-topbar',\s*\{\s*'data-glass': '' \}/, '顶栏应带 data-glass');
  assert.match(shellSource, /el\('nav\.app-nav',\s*\{[^}]*'data-glass': ''/, '侧边栏应带 data-glass');
  assert.match(componentsSource, /'data-glass': ''/, 'card/metric 应带 data-glass');
  assert.match(boardSource, /'data-glass': ''/, 'day-card 应带 data-glass');
  assert.match(domSource, /'data-glass': ''/, 'toast 应带 data-glass');
  assert.match(modalSource, /setAttribute\('data-glass', ''\)/, '弹窗应带 data-glass');
});

test('结构：背景氛围层存在且不进入无障碍树', async () => {
  const shellSource = await readFile(join(projectRoot, 'src', 'ui', 'shell.js'), 'utf8');
  assert.match(shellSource, /el\('div\.ambient-field',\s*\{\s*'aria-hidden': 'true' \}\)/, '氛围层必须 aria-hidden');
});
