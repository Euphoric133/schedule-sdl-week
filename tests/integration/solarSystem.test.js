/**
 * 首页「七天太阳系」与品牌 Logo 的验收测试。
 *
 * 这些断言覆盖的是"结构性承诺"，而不是视觉细节：
 * - Logo 必须是内联 SVG（不是 emoji、不是图片请求）；
 * - 太阳系必须承载 7 个核心模块，且都是真实链接；
 * - 每个链接都要有可访问名称；
 * - 数据模型在空数据 / 有计划 / 有统计时都不报错，且口径来自服务层；
 * - 窄屏必须有降级布局（轨道列表），而不是把桌面轨道硬缩小。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOLAR_BODIES,
  SOLAR_ORBITS,
  buildSolarSystemModel,
  compactDuration,
  planetPosition,
} from '../../src/ui/solarSystem.js';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (rel) => readFile(join(projectRoot, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * 品牌 Logo
 * ------------------------------------------------------------------ */

test('Logo：钟表主题，内联 SVG，viewBox 24，颜色全部走令牌', async () => {
  const components = await read('src/ui/components.js');
  const block = components.slice(components.indexOf('export function brandMark'), components.indexOf('首页：七天太阳系'));

  assert.match(block, /<svg viewBox="0 0 24 24"/, '应内联 SVG（viewBox 24）');
  assert.match(block, /role="presentation"/, '应为装饰角色');
  assert.match(block, /aria-hidden="true"/, '应对辅助技术隐藏');
  assert.match(block, /focusable="false"/, '不应可聚焦');

  // 钟表主题：表盘 + 指针 + 刻度，不再出现数字 7 的折线
  assert.match(block, /class="brand-dial"/, '应有表盘');
  assert.match(block, /class="brand-hands"/, '应有指针组');
  assert.ok(!block.includes('M7 7.5 H16 L9.5 16.5'), '不应再使用「7」字形');

  // 颜色只能来自 CSS 变量 / currentColor
  const colorAttrs = [...block.matchAll(/(?:stroke|fill)="([^"]+)"/g)].map((m) => m[1]);
  for (const value of colorAttrs) {
    const ok = value === 'none' || value === 'currentColor' || value.startsWith('var(--');
    assert.ok(ok, `发现硬编码颜色：${value}`);
  }

  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(block), 'Logo 内不得使用 emoji');
});

test('Logo：7 个刻度表达「七日」，且只在 ≥24px 绘制', async () => {
  const components = await read('src/ui/components.js');
  const block = components.slice(components.indexOf('export function brandMark'), components.indexOf('首页：七天太阳系'));
  assert.match(block, /Array\.from\(\{ length: 7 \}/, '应有 7 个刻度');
  assert.match(block, /const detailed = size >= 24;/, '细节应有尺寸门槛');
  assert.match(block, /\$\{detailed \? '<rect class="brand-badge"/, '徽标底按需渲染');
  assert.match(block, /\$\{detailed \? ticks : ''\}/, '刻度按需渲染');
});

test('Logo：指针指向由钟面角度换算，中心点压在指针交点', async () => {
  const components = await read('src/ui/components.js');
  const block = components.slice(components.indexOf('export function brandMark'), components.indexOf('首页：七天太阳系'));
  assert.match(block, /CENTER \+ Math\.sin\(rad\) \* radius/, '应按钟面角度换算横坐标');
  assert.match(block, /CENTER - Math\.cos\(rad\) \* radius/, '12 点朝上意味着纵坐标取负余弦');
  assert.match(block, /hand\(10, 3\.6\)/, '时针指向 10°');
  assert.match(block, /hand\(120, 6\.2\)/, '分针指向 120°（4 点）');
  assert.match(block, /r="1\.25" fill="var\(--color-accent\)"/, '中心点用强调色');
});

test('Logo：hover 让指针走一格，减少动态效果下静止', async () => {
  const css = await read('src/ui/styles/components.css');
  assert.match(css, /\.app-brand:hover \.brand-hands[\s\S]{0,80}transform: rotate\(30deg\)/, 'hover 应转动指针');
  assert.match(css, /transform-origin: 12px 12px/, '应绕表盘中心转动');
  assert.match(css, /animation: brand-tick 240s/, '走针应非常慢');
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]{0,200}\.brand-hands[\s\S]{0,120}animation: none/, '减少动态效果应停止走针');
});

/* ------------------------------------------------------------------ *
 * 太阳系结构
 * ------------------------------------------------------------------ */

test('太阳系：恰好承载 7 个核心模块，路由正确且互不重复', () => {
  assert.equal(SOLAR_BODIES.length, 7);
  const routes = SOLAR_BODIES.map((body) => body.route);
  assert.deepEqual(
    [...routes].sort(),
    ['activities', 'ai', 'day', 'garden', 'stats', 'tasks', 'week'],
    '7 个模块必须与约定一致',
  );
  assert.equal(new Set(routes).size, routes.length, '不允许重复路由');
  // 设置、外观、通知、版本历史、预览不塞进太阳系
  for (const excluded of ['settings', 'appearance', 'notifications', 'versions', 'preview']) {
    assert.ok(!routes.includes(excluded), `${excluded} 不应做成行星`);
  }
});

test('太阳系：轨道几何是确定的，且都落在舞台范围内', () => {
  assert.equal(SOLAR_ORBITS.length, 3);
  for (const body of SOLAR_BODIES) {
    const pos = planetPosition(body.orbit, body.angle);
    assert.ok(pos.x > 0 && pos.x < 100, `x 越界: ${pos.x}`);
    assert.ok(pos.y > 0 && pos.y < 100, `y 越界: ${pos.y}`);
  }
});

/* ------------------------------------------------------------------ *
 * 数据模型
 * ------------------------------------------------------------------ */

test('数据模型：空数据时给出可读的兜底文案，不抛异常', () => {
  const model = buildSolarSystemModel({
    state: { tasks: [], sessions: [], fixedActivities: [] },
    todayStats: { scheduledMinutes: 0, actualMinutes: 0 },
    weekStats: { thisWeek: { actualMinutes: 0 } },
    streak: { current: 0 },
    plan: null,
    today: '2026-10-30',
  });

  assert.equal(model.planets.length, 7);
  assert.equal(model.sun.value, '未安排');
  assert.ok(model.sun.ariaLabel.includes('今日总览'));
  const week = model.planets.find((p) => p.id === 'week');
  assert.equal(week.value, '尚未生成');
  assert.equal(week.detail, '去生成七天计划', '没有计划时应给下一步动作，而不是重复"尚未生成"');
});

test('数据模型：有计划与统计时使用真实数字', () => {
  const model = buildSolarSystemModel({
    state: {
      tasks: [
        { id: 't1', title: '数学', status: 'not_started', plannedMinutes: 90 },
        { id: 't2', title: '英语', status: 'completed', plannedMinutes: 60 },
      ],
      sessions: [
        { id: 's1', taskId: 't2', date: '2026-10-30', state: 'completed', plannedMinutes: 60, actualMinutes: 70 },
        { id: 's2', taskId: 't1', date: '2026-10-30', state: 'flexible', plannedMinutes: 40 },
      ],
      fixedActivities: [{ id: 'f1' }, { id: 'f2' }],
    },
    todayStats: { scheduledMinutes: 100, actualMinutes: 50 },
    weekStats: { thisWeek: { actualMinutes: 180 } },
    streak: { current: 3 },
    plan: { status: 'feasible', days: [{ studyMinutes: 60 }, { studyMinutes: 0 }, { studyMinutes: 30 }] },
    today: '2026-10-30',
    gardenFocusMinutes: 25,
  });

  assert.equal(model.sun.percent, 50, '50/100 应为 50%');
  assert.match(model.sun.detail, /已完成/);

  const byId = Object.fromEntries(model.planets.map((p) => [p.id, p]));
  assert.equal(byId.tasks.value, '1 个待办', '已完成任务不计入待办');
  assert.match(byId.tasks.detail, /剩余/);
  assert.equal(byId.day.value, '2 个时段');
  assert.equal(byId.week.detail, '完整可行');
  assert.equal(byId.week.value, '2 天有安排', '只有 studyMinutes>0 的天数计入');
  assert.equal(byId.stats.value, '3 小时');
  assert.match(byId.stats.detail, /连续 3 天/);
  assert.equal(byId.garden.value, '25 分钟');
  assert.equal(byId.activities.value, '2 条');
});

test('数据模型：每个天体都有可访问名称，包含名称与数值', () => {
  const model = buildSolarSystemModel({
    state: { tasks: [], sessions: [], fixedActivities: [] },
    todayStats: { scheduledMinutes: 0, actualMinutes: 0 },
    weekStats: { thisWeek: { actualMinutes: 0 } },
    streak: { current: 0 },
    plan: null,
    today: '2026-10-30',
  });
  for (const planet of model.planets) {
    assert.ok(planet.ariaLabel.startsWith(planet.name), '可访问名称应以模块名开头');
    assert.ok(planet.ariaLabel.includes(planet.value), '可访问名称应包含数值');
    assert.equal(planet.href, `#/${planet.route}`);
  }
});

test('compactDuration：分钟/小时的紧凑写法', () => {
  assert.equal(compactDuration(0), '0 分钟');
  assert.equal(compactDuration(45), '45 分钟');
  assert.equal(compactDuration(60), '1 小时');
  assert.equal(compactDuration(95), '1 小时 35 分');
  assert.equal(compactDuration(-5), '0 分钟');
});

/* ------------------------------------------------------------------ *
 * 组件与布局
 * ------------------------------------------------------------------ */

test('组件：太阳与行星都渲染为真实链接，并带 aria-label', async () => {
  const components = await read('src/ui/components.js');
  assert.match(components, /export function solarSystem/, '应导出 solarSystem 组件');
  // 行星/太阳用模板字符串拼类名（`a.solar__planet--${planet}...`），因此匹配反引号
  assert.match(components, /el\(\s*`a\.solar__planet/, '行星必须是 <a>');
  assert.match(components, /el\(\s*'a\.solar__sun'/, '太阳必须是 <a>');
  assert.match(components, /'aria-label': planet\.ariaLabel/, '行星需要可访问名称');
  assert.match(components, /'aria-hidden': 'true'/, '星点/轨道应为装饰并隐藏于无障碍树');
});

test('样式：窄屏存在降级布局（轨道列表），不是把桌面轨道整体缩小', async () => {
  const css = await read('src/ui/styles/components.css');
  /**
   * 注意：文件里有多处 `@media (max-width: 720px)`（例如液态玻璃的降级），
   * 必须挑出**包含太阳系规则**的那一块，不能取第一个。
   */
  const blocks = css.split('@media (max-width: 720px)').slice(1);
  /**
   * 用「真正的规则」定位，而不是 `.solar__stage` 这个字符串：
   * 文件开头的结构图注释里也出现过 .solar__stage / .solar__sky，
   * 按字符串找会命中注释，导致断言永远过不了（这里踩过一次）。
   */
  const mobileBlock = blocks.find((block) => /\.solar__orbits\s*\{\s*\n\s*display:\s*none/.test(block));
  assert.ok(mobileBlock, '应存在针对太阳系的 720px 断点');
  // 星点与轨道写在同一个选择器组里，一起隐藏
  assert.match(mobileBlock, /\.solar__sky[\s\S]{0,120}?display: none/, '窄屏应隐藏星点');
  assert.match(mobileBlock, /\.solar__orbits[\s\S]{0,120}?display: none/, '窄屏应隐藏椭圆轨道');
  assert.match(mobileBlock, /\.solar__stage[\s\S]{0,120}flex-direction: column/, '窄屏应切为纵向列表');
  assert.match(mobileBlock, /\.solar__planet[\s\S]{0,200}position: static/, '窄屏行星应回到文档流');
});

test('样式：减少动态效果时太阳系静止', async () => {
  const css = await read('src/ui/styles/components.css');
  const reduceBlocks = css.split('@media (prefers-reduced-motion: reduce)');
  const relevant = reduceBlocks.slice(1).join('');
  assert.match(relevant, /\.solar__star[\s\S]{0,120}animation: none/, '减少动态效果时应停止闪烁');
  assert.match(relevant, /\.solar__body[\s\S]{0,120}animation: none/, '减少动态效果时应停止呼吸');
});

/* ------------------------------------------------------------------ *
 * 首页整合与回归
 * ------------------------------------------------------------------ */

test('首页：使用太阳系替换了 hero 与四块磁贴，同时保留关键操作', async () => {
  const home = await read('src/ui/pages/home.js');
  assert.match(home, /solarSystem\(solarModel\)/, '首页应渲染太阳系');
  assert.match(home, /buildSolarSystemModel\(/, '首页应构建数据模型');
  assert.ok(!home.includes('home-tiles'), '旧的磁贴区块应被移除');
  assert.match(home, /home-solar__actions/, '操作条应保留在太阳系之外');
  // 关键功能仍在
  for (const feature of ['renderPlanCard', 'renderTodayList', 'renderWeekOverview']) {
    assert.ok(home.includes(feature), `${feature} 不应因改版而丢失`);
  }
});

test('首页：行星数据全部来自服务层，不自己另算统计', async () => {
  const home = await read('src/ui/pages/home.js');
  assert.match(home, /services\.statsService\.weekly\(\)/, '周统计应来自 statsService');
  assert.match(home, /todayStats/, '今日统计应来自 statsService.today()');
  // 太阳系模型模块本身不应 import 服务层（保持纯函数）
  const model = await read('src/ui/solarSystem.js');
  assert.ok(!/from '\.\.\/services\//.test(model), '数据模型模块不得依赖服务层');
  assert.ok(!/document\.|localStorage/.test(model), '数据模型模块不得触碰 DOM 或存储');
});

/* ------------------------------------------------------------------ *
 * 几何：行星必须严格落在轨道椭圆上（这是"脱离轨道"的回归守卫）
 * ------------------------------------------------------------------ */

test('几何：每个行星都严格满足所在轨道的椭圆方程', () => {
  for (const body of SOLAR_BODIES) {
    const ring = SOLAR_ORBITS[body.orbit];
    const { x, y } = planetPosition(body.orbit, body.angle);
    const dx = (x - 50) / ring.rx;
    const dy = (y - 50) / ring.ry;
    assert.ok(
      Math.abs(dx * dx + dy * dy - 1) < 1e-6,
      `${body.id} 不在椭圆轨道上：dx²+dy²=${(dx * dx + dy * dy).toFixed(9)}`,
    );
  }
});

test('几何：所有行星落在 12–88 的安全区内（留出球体、chip 与光晕的空间）', () => {
  for (const body of SOLAR_BODIES) {
    const { x, y } = planetPosition(body.orbit, body.angle);
    assert.ok(x >= 12 && x <= 88, `${body.id} 的 x=${x.toFixed(2)} 超出安全区`);
    assert.ok(y >= 12 && y <= 88, `${body.id} 的 y=${y.toFixed(2)} 超出安全区`);
  }
});

test('几何：外圈轨道完整落在面板内（宽度 ≤92%、高度 ≤88%）', () => {
  const outer = SOLAR_ORBITS[SOLAR_ORBITS.length - 1];
  assert.ok(outer.rx * 2 <= 92, `外圈宽度 ${outer.rx * 2}% 超出安全范围`);
  assert.ok(outer.ry * 2 <= 88, `外圈高度 ${outer.ry * 2}% 会被面板裁切`);
});

test('几何：轨道尺寸由 SOLAR_ORBITS 驱动，样式表不再手写第二套百分比', async () => {
  const components = await read('src/ui/components.js');
  // 组件用 ring.rx*2 / ring.ry*2 生成 CSS 变量
  assert.match(components, /'--orbit-w': `\$\{ring\.rx \* 2\}%`/, '轨道宽度应由 rx 驱动');
  assert.match(components, /'--orbit-h': `\$\{ring\.ry \* 2\}%`/, '轨道高度应由 ry 驱动');

  const css = await read('src/ui/styles/components.css');
  // 样式里轨道尺寸只允许用变量，不允许出现具体百分比
  const orbitWidthRules = [...css.matchAll(/\.solar__orbit[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  for (const rule of orbitWidthRules) {
    assert.ok(!/width:\s*\d+%/.test(rule), `轨道宽度不应写死：${rule.slice(0, 60)}`);
    assert.ok(!/height:\s*\d+%/.test(rule), `轨道高度不应写死：${rule.slice(0, 60)}`);
  }
});

test('几何：chip 朝远离太阳的一侧（上半区朝上、下半区朝下）', () => {
  const model = buildSolarSystemModel({
    state: { tasks: [], sessions: [], fixedActivities: [] },
    todayStats: { scheduledMinutes: 0, actualMinutes: 0 },
    weekStats: { thisWeek: { actualMinutes: 0 } },
    streak: { current: 0 },
    plan: null,
    today: '2026-10-30',
  });
  /**
   * 现在的规则不是"越往下越翻折"，而是"chip 朝远离太阳的一侧"：
   * 上半区（y < 50）的行星 chip 朝上，下半区朝下。
   * 这样 chip 总是伸向空旷处，也不会压住中间的太阳。
   */
  for (const planet of model.planets) {
    assert.equal(
      planet.flip,
      planet.y < 50,
      `${planet.id} 的 chip 方向应与所在半区一致（y=${planet.y.toFixed(1)}）`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 默认深色
 * ------------------------------------------------------------------ */

test('默认主题：defaultPreferences 为深色，且未标记为显式选择', async () => {
  const { defaultPreferences, THEME } = await import('../../src/services/preferences.js');
  const prefs = defaultPreferences();
  assert.equal(prefs.appearance.theme, THEME.DARK);
  assert.equal(prefs.appearance.themeExplicit, false, '默认值不是用户的明确选择');
});

test('默认主题：未知值回落到深色', async () => {
  const { normalizeTheme, THEME } = await import('../../src/services/preferences.js');
  assert.equal(normalizeTheme(undefined), THEME.DARK);
  assert.equal(normalizeTheme('unknown'), THEME.DARK);
  assert.equal(normalizeTheme(null), THEME.DARK);
});

test('默认主题：首屏 HTML 直接声明深色，避免闪白', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="zh-CN" data-theme="dark">/, '首帧应为深色');
  assert.match(html, /name="color-scheme" content="dark light"/, '应声明 color-scheme');
  assert.match(html, /name="theme-color" content="#0b1220"/, '应设置深空底色');
});

test('默认主题：首屏脚本只应用"用户明确选过的浅色"', async () => {
  const html = await read('index.html');
  assert.match(html, /themeExplicit === true/, '只有显式选择才在首帧改写主题');
  assert.match(html, /studyPlanner:v1:preferences/, '只读偏好键');
  // 首屏脚本不得触碰业务数据
  assert.ok(!/studyPlanner:v1:state/.test(html), '首屏脚本不应读取业务数据');
});

test('默认主题：迁移策略——显式选择保留、旧默认迁移为深色', async () => {
  const { normalizeTheme, THEME } = await import('../../src/services/preferences.js');
  // 显式选择过浅色 → 保留
  const explicitLight = { appearance: { theme: 'light', themeExplicit: true } };
  assert.equal(normalizeTheme(explicitLight.appearance.theme, { prefersDark: false }), THEME.LIGHT);
  // 旧数据（无 themeExplicit）由 normalizeAppearance 迁移为深色，这里通过 loadPreferences 的
  // 间接路径验证：normalizeTheme 本身不做迁移，迁移在 normalizeAppearance 里。
  const prefsSource = await read('src/services/preferences.js');
  assert.match(prefsSource, /appearance\.themeExplicit === true/, '应读取显式标记');
  assert.match(prefsSource, /theme = THEME\.DARK;/, '无标记时应迁移为深色');
});

/* ------------------------------------------------------------------ *
 * 空状态文案：彻底删除，且不留空占位
 * ------------------------------------------------------------------ */

test('首页空状态不再出现"先创建你的第一个任务"与解释句', async () => {
  const home = await read('src/ui/pages/home.js');
  // 只允许出现在注释里；渲染路径中不得有这两个字符串
  const code = home
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!code.includes('先创建你的第一个任务'), '标题文案应已删除');
  assert.ok(!code.includes('创建任务后，系统会自动排出'), '副标题文案应已删除');
});

test('首页空状态不渲染空的标题/副标题节点', async () => {
  const home = await read('src/ui/pages/home.js');
  // 用三元 + null 控制渲染，而不是渲染空字符串
  assert.match(home, /titleText \? el\('h1\.home-solar__title'/, '标题应按需渲染');
  assert.match(home, /subtitleText \? el\('p\.home-solar__sub'/, '副标题应按需渲染');
  assert.match(home, /: null;/, '空状态应返回 null');
});

/* ------------------------------------------------------------------ *
 * 星空：三层、数量、确定性
 * ------------------------------------------------------------------ */

test('星空：至少 130 颗，分三层，总数不超过 200', async () => {
  const components = await read('src/ui/components.js');
  assert.match(components, /far: \{ count: 90/, '远景层数量');
  assert.match(components, /mid: \{ count: 50/, '中景层数量');
  assert.match(components, /near: \{ count: 10/, '近景层数量');
  // 三层合计 150，落在 130–170 的区间内
  assert.match(components, /closest|near/, '近景层应存在');
});

test('星空：颜色分成冷白/淡蓝/淡金三档', async () => {
  const components = await read('src/ui/components.js');
  assert.match(components, /STAR_TONES = \['cool', 'cool', 'cool', 'blue', 'blue', 'gold'\]/);
  const tokens = await read('src/ui/styles/tokens.css');
  for (const token of ['--solar-star-cool', '--solar-star-blue', '--solar-star-gold', '--solar-star-near']) {
    assert.ok(tokens.includes(token), `缺少令牌 ${token}`);
  }
});

test('星空：星云与银河带使用令牌，不写死颜色', async () => {
  const css = await read('src/ui/styles/components.css');
  assert.match(css, /\.solar__nebula-blob--1[\s\S]{0,160}var\(--nebula-1\)/);
  assert.match(css, /\.solar__galaxy[\s\S]{0,200}var\(--galaxy-band\)/);
  // 星点不使用复杂 box-shadow（近景除外）
  assert.ok(!/\.solar__stars--far \.solar__star[\s\S]{0,120}box-shadow/.test(css), '远景不应带阴影');
});

/* ------------------------------------------------------------------ *
 * 行星细节
 * ------------------------------------------------------------------ */

test('行星细节：球体具备边缘暗化、高光与接触阴影', async () => {
  const css = await read('src/ui/styles/components.css');
  const body = css.slice(css.indexOf('.solar__body {'), css.indexOf('.solar__body {') + 2200);
  assert.match(body, /transparent 58%, rgba\(0, 0, 0, 0\.38\)/, '应有边缘暗化（limb darkening）');
  assert.match(body, /radial-gradient\(circle at 33% 22%/, '应有偏左上的高光');
  assert.match(body, /0 8px 14px -6px/, '应有接触阴影');
});

test('行星细节：土星环分为前后两半，并有球体投影', async () => {
  const components = await read('src/ui/components.js');
  assert.match(components, /solar__ring\.solar__ring--back/, '应渲染后半圈');
  assert.match(components, /solar__ring\.solar__ring--front/, '应渲染前半圈');
  assert.match(components, /solar__ring-shadow/, '应有球体在环上的阴影');

  const css = await read('src/ui/styles/components.css');
  assert.match(css, /\.solar__ring--back \{[\s\S]{0,160}inset\(0 0 50% 0\)/, '后半圈应裁剪上半部分');
  assert.match(css, /\.solar__ring--front \{[\s\S]{0,160}inset\(50% 0 0 0\)/, '前半圈应裁剪下半部分');
  assert.match(css, /transparent 47%/, '环里应有一条明显缝隙');
});

test('行星细节：地球月球有明暗面与轨道弧', async () => {
  const components = await read('src/ui/components.js');
  assert.match(components, /solar__moon-orbit/, '应有月球轨道弧');
  const css = await read('src/ui/styles/components.css');
  assert.match(css, /\.solar__moon \{[\s\S]{0,400}linear-gradient\(135deg/, '月球应有明暗交界');
});

test('行星细节：木星/土星是水平条带（渐变角度不能竖着）', async () => {
  const css = await read('src/ui/styles/components.css');
  const jupiter = css.slice(css.indexOf('.solar__planet--jupiter {'), css.indexOf('.solar__planet--jupiter {') + 900);
  assert.ok(!/repeating-linear-gradient\(\s*9\ddeg/.test(jupiter), '木星条带不应是竖的');
  assert.match(jupiter, /repeating-linear-gradient\(\s*0deg/, '木星应使用 0deg（水平条带）');
});
