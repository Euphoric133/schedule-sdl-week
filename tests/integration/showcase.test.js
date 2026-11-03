/**
 * 演示页（showcase.html）的静态验收。
 *
 * 它不测"好不好看"，只确保：
 * - 文件存在、是单文件、无外链依赖；
 * - 规格要求的章节都在；
 * - 两个入口链接真实可用（产品地址 / 版本时间线）；
 * - 没有用 emoji 当图标。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const deckPath = join(projectRoot, 'showcase.html');
let cached = null;

async function deck() {
  if (!cached) cached = await readFile(deckPath, 'utf8');
  return cached;
}

test('演示页：文件存在且是非空单文件 HTML', async () => {
  const info = await stat(deckPath);
  assert.ok(info.size > 20_000, `showcase.html 太小（${info.size} 字节）`);
  const html = await deck();
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<style>'), '样式必须内联');
  assert.ok(html.includes('<script>'), '脚本必须内联');
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('演示页：20 页且每页都有可读标题', async () => {
  const html = await deck();
  const slides = html.match(/class="slide"/g) ?? [];
  assert.ok(slides.length >= 18 && slides.length <= 24, `页数应在 18–24 之间，实际 ${slides.length}`);
  for (let i = 1; i <= slides.length; i += 1) {
    assert.ok(html.includes(`id="slide-${i}"`), `缺少第 ${i} 页的锚点`);
  }
});

test('演示页：规格要求的章节都在', async () => {
  const html = await deck();
  const required = [
    'AI 学习规划与执行助手',
    '产品介绍',
    '现场演示',
    '开发过程',
    '测试与反思',
    '目标人群',
    '需求分析',
    '确定性排程',
    '任务拆分',
    '预览确认',
    '专注',
    'AI 只提议',
    '质量证据',
    '版本',
    '反思',
    '特别鸣谢',
  ];
  for (const keyword of required) {
    assert.ok(html.includes(keyword), `演示缺少章节关键词：${keyword}`);
  }
});

test('演示页：两个入口链接真实存在', async () => {
  const html = await deck();
  assert.ok(html.includes('https://powerschedule-bfq.pages.dev/'), '缺少现场演示地址');
  assert.ok(html.includes('href="versions/index.html"'), '缺少版本时间线链接');

  // 版本时间线必须真的在仓库里，而且指向的 59 个文件都在
  const versionsIndex = await readFile(join(projectRoot, 'versions', 'index.html'), 'utf8');
  const links = [...versionsIndex.matchAll(/href="([^"]+\.html)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 59, `版本页应列出全部历史版本，实际 ${links.length}`);
  for (const link of links) {
    const info = await stat(join(projectRoot, 'versions', link)).then(() => true).catch(() => false);
    assert.ok(info, `版本页链接指向不存在的文件：${link}`);
  }
});

test('演示页：除产品地址外没有任何外部资源', async () => {
  const html = await deck();
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
  const external = urls.filter((u) => !u.startsWith('https://powerschedule-bfq.pages.dev'));
  assert.deepEqual(external, [], `不应引用外部资源：${external.join(', ')}`);
  assert.equal(/<link[^>]+href="http/i.test(html), false, '不应有外部样式表');
  assert.equal(/<img\s/i.test(html), false, '不应使用外部图片（用内联 SVG）');
  assert.equal(/@import\s+url\(/i.test(html), false, '不应 @import 外部字体');
});

test('演示页：不使用 emoji 充当图标', async () => {
  const html = await deck();
  // 排除配色/说明里的符号；这里只拦图形性 emoji 区段
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) ?? [];
  assert.deepEqual(emoji, [], `发现 emoji：${emoji.join(' ')}`);
  assert.ok(html.includes('<svg'), '图标应使用内联 SVG');
});

test('演示页：放映交互齐全（翻页/全屏/备注/总览/深链/打印）', async () => {
  const html = await deck();
  for (const [name, pattern] of [
    ['方向键翻页', /ArrowRight/],
    ['PageUp/PageDown', /PageUp/],
    ['Home/End', /'Home'/],
    ['F 全屏', /requestFullscreen/],
    ['N 备注', /notes-on/],
    ['G 总览', /overview/],
    ['深链 #slide-N', /#slide-/],
    ['打印分页', /@page\s*\{[^}]*landscape/],
    ['减少动态效果', /prefers-reduced-motion/],
    ['16:9 自适应缩放', /--scale/],
  ]) {
    assert.match(html, pattern, `缺少${name}`);
  }
});

test('演示页：数字来自真实仓库（测试数/提交数/版本数）', async () => {
  const html = await deck();
  assert.ok(html.includes('853'), '应写入真实测试数 853');
  assert.ok(html.includes('93'), '应写入真实提交数 93');
  assert.ok(html.includes('59'), '应写入真实版本数 59');
  assert.ok(html.includes('0'), '应写入零依赖');
  assert.ok(/数据截至\s*2026-10-30/.test(html), '页脚应标注数据截止日期');
});
