/**
 * 文字安全层的静态约束。
 *
 * 这些断言保护的是"文字不跑出容器"的**根因**，
 * 但它们不能代替真实浏览器的 DevTools 测量。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const readStyle = (name) => readFile(join(projectRoot, 'src', 'ui', 'styles', name), 'utf8');
const readSource = (path) => readFile(join(projectRoot, 'src', path), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function rulesFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(^|[},])\\s*${escaped}\\s*\\{[^}]*\\}`, 'g')) ?? [];
}

test('根因：flex/grid 文字子项允许收缩（min-width: 0）', async () => {
  const css = stripComments(await readStyle('components.css'));
  // 关键容器必须声明 min-width: 0，否则 flex 子项不肯收缩
  for (const selector of ['.page-head > *', '.card__head > *', '.notice > *', '.task-item__head > *', '.app-topbar__meta > *']) {
    assert.ok(css.includes(selector), `缺少 ${selector} 的收缩声明`);
  }
  assert.match(css, /\.task-item__head > div:first-child\s*\{[^}]*min-width:\s*0/);
});

test('单行文字：省略号 + title 可回溯', async () => {
  const css = stripComments(await readStyle('components.css'));
  const block = css.slice(css.indexOf('.app-nav__link,'));
  assert.match(block, /text-overflow:\s*ellipsis/);
  assert.match(block, /white-space:\s*nowrap/);

  const components = await readSource('ui/components.js');
  assert.match(components, /task-item__title', \{ text: task\.title, title: task\.title \}/, '任务标题必须带 title');
  assert.match(components, /card__title', \{ text: title, title \}/, '卡片标题必须带 title');
});

test('多行文字：允许换行并断词', async () => {
  const css = stripComments(await readStyle('components.css'));
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.card__hint,|\.card__hint\s*\{/, '卡片提示应参与换行规则');
  // 正文容器不允许被设成 nowrap
  const hintRules = rulesFor(css, '.card__hint');
  for (const rule of hintRules) {
    assert.equal(/white-space:\s*nowrap/.test(rule), false, '正文不能 nowrap');
  }
});

test('看板卡片：标题最多两行，标签可省略', async () => {
  const css = stripComments(await readStyle('components.css'));
  const title = rulesFor(css, '.day-card__title').join('\n');
  assert.match(title, /-webkit-line-clamp:\s*2/, '固定高度卡片标题应限制两行');
  const tag = rulesFor(css, '.day-tag').join('\n');
  assert.match(tag, /text-overflow:\s*ellipsis/);
  // 原有的 nowrap 必须被显式改回 normal，否则 line-clamp 不生效
  assert.match(title, /white-space:\s*normal/, '标题必须显式允许换行');
});

test('按钮：允许长文案换行且不超出容器', async () => {
  const css = stripComments(await readStyle('components.css'));
  const btn = rulesFor(css, '.btn').join('\n');
  assert.match(btn, /max-width:\s*100%/);
  assert.match(css, /\.form-actions \.btn,[\s\S]*?white-space:\s*normal/, '操作区按钮应允许换行');
  assert.match(css, /\.form-actions\s*\{[^}]*flex-wrap:\s*wrap/, '按钮组应可换行');
});

test('输入框：显式允许收缩（含原生日期/时间控件）', async () => {
  const css = stripComments(await readStyle('components.css'));
  assert.match(css, /^input,\nselect,\ntextarea\s*\{[^}]*min-width:\s*0/m);
  assert.match(css, /input\[type='date'\],[\s\S]*?min-width:\s*0/, '日期/时间控件需要显式 min-width: 0');
});

test('弹窗：不超出视口且内部可滚动', async () => {
  const css = stripComments(await readStyle('components.css'));
  const dialog = rulesFor(css, 'dialog').join('\n');
  assert.match(dialog, /max-height:\s*calc\(100vh - 48px\)/);
  assert.match(dialog, /overflow:\s*auto/);
  assert.match(dialog, /max-width:\s*min\(720px, calc\(100vw - 32px\)\)/);
});

test('禁止用全局 overflow: hidden 掩盖溢出', async () => {
  const files = await Promise.all(['tokens.css', 'base.css', 'components.css'].map(readStyle));
  for (const css of files) {
    const clean = stripComments(css).replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
    for (const selector of ['body', '.app', '.app-main']) {
      const block = rulesFor(clean, selector).join('\n');
      assert.equal(/overflow:\s*hidden/.test(block), false, `${selector} 不允许 overflow: hidden`);
    }
  }
});

test('表格容器仍可横向滚动（不是被裁掉）', async () => {
  const css = stripComments(await readStyle('components.css'));
  const wrap = rulesFor(css, '.table-wrap').join('\n');
  assert.match(wrap, /overflow-x:\s*auto/, '宽表格应能横向滚动');
});
