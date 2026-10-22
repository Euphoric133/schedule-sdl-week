/**
 * 专注花园「奖励转盘」的旋转动画与结果一致性测试。
 *
 * 背景：花园是预构建的单文件应用，转盘逻辑在打包代码里。
 * 这里不重写算法，而是**从实际产物中抽出角度函数求值**，
 * 用数值方式验证"指针停下的位置"与"抽中的奖励"始终一致。
 *
 * 覆盖：
 * - 每个扇区（1~16 个）抽中后，指针都精确停在该扇区内部；
 * - 每次新抽奖都转满 6 圈（而不是 1 圈）；
 * - 首次抽奖时长是 4.2 秒（修复前是 0，会直接跳到终点）；
 * - 中奖卡片在旋转结束后才出现；
 * - 抽奖守卫：有未领取结果 / 机会不足时不会重复抽奖、不会重复扣次数；
 * - 刷新恢复：挂载时已有的待领取结果直接落到终点，不重新随机。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..', '..');

/** 取产物里真实的 px / q1 实现并求值（不复制算法，避免"测试和实现各写一份"） */
function loadAngleMath(html) {
  const pxSrc = html.match(/function px\(i,u=6\)\{[^}]*\}/)?.[0];
  const q1Src = html.match(/function q1\(i,u\)\{[^}]*\}/)?.[0];
  assert.ok(pxSrc, '产物里应能找到 px（角度计算）');
  assert.ok(q1Src, '产物里应能找到 q1（扇区中心角）');
  // eslint-disable-next-line no-new-func
  return new Function(`${pxSrc}; ${q1Src}; return { px, q1 };`)();
}

async function loadEmbedded() {
  const { FOCUS_GARDEN_HTML } = await import('../../src/embed/focusGardenHtml.js');
  return FOCUS_GARDEN_HTML;
}

/* ================================================================== *
 * 一、结果与停止位置一致（数值验证）
 * ================================================================== */

test('转盘：任意扇区数量下，指针都精确停在该扇区内部', async () => {
  const html = await loadEmbedded();
  const { px, q1 } = loadAngleMath(html);

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16]) {
    const b = 360 / n;
    for (let k = 0; k < n; k += 1) {
      const target = q1(n, k);
      const angle = px(target, 6);

      // 扇区中心旋转后应正对指针（0°）
      const centerAfter = ((target + angle) % 360 + 360) % 360;
      assert.ok(
        centerAfter < 1e-9 || Math.abs(centerAfter - 360) < 1e-9,
        `n=${n} k=${k}：扇区中心没有对准指针（${centerAfter}）`,
      );

      // 只有一个奖励时整圆是一块，不需要再判断边界
      if (n === 1) continue;

      const startAfter = ((k * b + angle) % 360 + 360) % 360;
      const endAfter = (((k + 1) * b + angle) % 360 + 360) % 360;
      const inside = startAfter > endAfter ? 0 >= startAfter || 0 < endAfter : 0 >= startAfter && 0 < endAfter;
      assert.ok(inside, `n=${n} k=${k}：指针落在了别的扇区（start=${startAfter}, end=${endAfter}）`);
    }
  }
});

test('转盘：每次新抽奖都转满 6 圈（修复前首次只有 1 圈）', async () => {
  const html = await loadEmbedded();
  const { px, q1 } = loadAngleMath(html);

  for (const n of [2, 5, 8, 12]) {
    for (let k = 0; k < n; k += 1) {
      const target = q1(n, k);
      const alignOnly = ((360 - (target % 360)) % 360 + 360) % 360;
      const turns = (px(target, 6) - alignOnly) / 360;
      assert.equal(turns, 6, `n=${n} k=${k}：额外圈数应为 6，实际 ${turns}`);
    }
  }
});

/* ================================================================== *
 * 二、动画本身不再"瞬间跳到终点"
 * ================================================================== */

test('动画：首次抽奖不再是 0 秒（修复前会直接跳到结果）', async () => {
  const html = await loadEmbedded();

  assert.match(html, /Y=f\?260:K\?0:4200/, '新抽奖时长应为 4200ms，只有"刷新恢复"才是 0');
  assert.equal(
    /Y=f\?260:w\?4200:0/.test(html),
    false,
    '不应再使用"本会话是否抽过奖"决定时长（首次会是 0 秒，动画根本不会开始）',
  );
  assert.equal(
    /px\(u\.targetAngle,w\?6:1\)/.test(html),
    false,
    '不应再出现"首次只转 1 圈"的写法',
  );
  // 新抽奖的圈数逻辑：从当前角度继续累加 2160°（= 6 圈）
  assert.match(html, /const z=x\+2160;/, '新抽奖应从当前角度再累加 6 圈');
  assert.match(html, /if\(f\|\|K\)return a;/, '恢复/reducedMotion 时不做额外累加');
});

test('动画：使用 4.2 秒的缓出过渡，并在旋转时开启', async () => {
  const html = await loadEmbedded();
  assert.match(
    html,
    /transition:M\?f\?"transform 260ms ease-out":"transform 4\.2s cubic-bezier\(0\.12, 0\.62, 0\.06, 1\)":"none"/,
    '旋转时应应用 4.2s cubic-bezier 过渡，静止时为 none',
  );
  assert.match(html, /transform:`rotate\(\$\{x\}deg\)`/, '角度必须真的写到 transform 上');
  assert.match(html, /transformOrigin:`\$\{we\}px \$\{we\}px`/, '旋转中心必须是转盘圆心');
  assert.match(html, /will-change:transform/, '转盘应声明 will-change:transform，减少重绘卡顿');
});

test('动画：结果卡片在旋转结束后才出现', async () => {
  const html = await loadEmbedded();
  assert.match(html, /children:u&&!M\?s\.jsxs\("div",\{className:"wheel-result__card"/, '中奖卡片必须等 spinning 结束');
  assert.equal(
    /children:u\?s\.jsxs\("div",\{className:"wheel-result__card"/.test(html),
    false,
    '不应在点击瞬间就显示中奖卡片',
  );
  // 旋转期间显示"正在旋转"，旋转结束后停止标记复位
  assert.match(html, /转盘正在旋转/, '旋转中应有明确的进行中文案');
  assert.match(html, /setTimeout\(\(\)=>_\(!1\),Y\+60\)/, '动画结束后必须复位 spinning 状态');
});

test('动画：刷新恢复不重新随机，直接落到已确定的结果', async () => {
  const html = await loadEmbedded();
  assert.match(html, /const K=g0\.current;g0\.current=!1;/, '需要区分"挂载时恢复"与"用户新点击"');
  assert.match(html, /K\?0:4200/, '恢复时长为 0（直接落到结果）');
  assert.match(html, /if\(f\|\|K\)return a;/, '恢复时不额外转圈');
});

test('动画：连续抽奖时角度从当前值继续累加，不会跳回起点', async () => {
  const html = await loadEmbedded();
  const m = html.match(/const q=\(\(\)=>\{[\s\S]*?\}\)\(\)/);
  assert.ok(m, '应能从产物中抽出角度计算表达式');

  // 直接求值产物里的真实表达式（参数：待领取结果、reducedMotion、是否恢复、当前角度）
  const compute = new Function('u', 'f', 'K', 'x', `return ${m[0].replace(/^const q=/, '')};`);
  const { q1 } = loadAngleMath(html);

  for (const n of [2, 5, 8, 12]) {
    let x = 0;
    for (let spin = 0; spin < 8; spin += 1) {
      const k = (spin * 3 + 1) % n;
      const target = q1(n, k);
      const next = compute({ targetAngle: target }, false, false, x);

      assert.ok(next - x >= 2160 - 1e-9, `n=${n} 第 ${spin + 1} 次：应至少再转 6 圈，实际 ${(next - x) / 360} 圈`);
      const align = ((360 - (target % 360)) % 360 + 360) % 360;
      assert.ok(Math.abs(((next % 360) + 360) % 360 - align) < 1e-9, `n=${n} 第 ${spin + 1} 次：最终角度未对准`);
      x = next;
    }
  }

  // 刷新恢复（f 或 K 为真）：给绝对角，不累加、不再随机
  const restored = compute({ targetAngle: q1(6, 2) }, false, true, 5000);
  assert.ok(restored < 360, `恢复时应直接给绝对角，实际 ${restored}`);
});

/* ================================================================== *
 * 三、抽奖守卫：不重复扣次数、不重复写记录
 * ================================================================== */

test('抽奖：有未领取结果或机会不足时，拒绝再次抽奖', async () => {
  const html = await loadEmbedded();
  // hx = 抽奖函数：机会不足或已有待领取结果时直接返回 null
  assert.match(
    html,
    /function hx\(i,u,d=Math\.random,o=Date\.now\(\)\)\{if\(md\(i\)\.available<=0\|\|i\.pendingSpin\)return null;/,
    '抽奖入口必须同时校验"可用次数"与"是否已有待领取结果"',
  );
  // 次数只在抽奖成功时 +1，且 result 由抽奖时确定
  assert.match(html, /usedCount:i\.usedCount\+1,totalSpins:i\.totalSpins\+1,pendingSpin:x/, '次数只能在确定结果时增加一次');
  assert.equal(
    (html.match(/usedCount:i\.usedCount\+1/g) ?? []).length,
    1,
    '扣次数的代码只应存在一处',
  );
});

test('抽奖：旋转期间开始按钮被禁用', async () => {
  const html = await loadEmbedded();
  assert.match(html, /const O=!d&&!M&&!u&&y\.length>0;/, '可抽奖条件必须排除"旋转中"与"有待领取结果"');
  assert.match(html, /onClick:h,disabled:!O/, '按钮在不可抽奖时必须 disabled');
});

test('抽奖：奖励为空或全部禁用时不启动旋转', async () => {
  const html = await loadEmbedded();
  // Pn = 只保留 enabled 且 weight > 0 的奖励
  assert.match(html, /function Pn\(i\)\{return i\.filter\(u=>u\.enabled&&Number\.isFinite\(u\.weight\)&&u\.weight>0\)\}/, '必须过滤掉禁用/无效奖励');
  assert.match(html, /y\.length>0/, '没有有效奖励时不应允许抽奖');
  assert.match(html, /还没有可抽取的奖励/, '空转盘要有明确提示');
});

/* ================================================================== *
 * 四、补丁可复现
 * ================================================================== */

test('补丁：可重复执行且状态一致（幂等）', async () => {
  const script = join(projectRoot, 'scripts', 'patch-garden-wheel.mjs');
  const { stdout } = await execFileAsync(process.execPath, [script, '--check']);
  assert.match(stdout, /补丁已应用|已全部应用/, 'focus-garden.html 应处于已打补丁状态');
});

test('补丁：内联副本与源文件同步（改完必须重新生成）', async () => {
  const source = await readFile(join(projectRoot, 'focus-garden.html'), 'utf8');
  const embedded = await loadEmbedded();
  const stripRelative = (html) =>
    html
      .replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '')
      .replace(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>\s*/gi, '');
  assert.equal(embedded, stripRelative(source), '内联副本不同步：请运行 node scripts/build-garden-embed.mjs');
});


/* ================================================================== *
 * 五、指针方向与抽奖规则（v1.14）
 * ================================================================== */

test('转盘：指针朝下（底边在上、顶点指向轮盘中心）', async () => {
  const html = await loadEmbedded();
  assert.match(
    html,
    /M \$\{we-9\} \$\{we-zt-12\} L \$\{we\+9\} \$\{we-zt-12\} L \$\{we\} \$\{we-zt\+10\} Z/,
    '指针应改为朝下的三角形',
  );
  assert.equal(
    /M \$\{we\} \$\{we-zt-12\} L \$\{we-9\} \$\{we-zt\+10\}/.test(html),
    false,
    '不应再保留朝上的旧 path',
  );
  // 指针的其它属性必须保持不变
  assert.match(html, /className:M\?"wheel-pointer wheel-pointer--spinning":"wheel-pointer"/, '旋转时的指针 tick 动画应保留');
  assert.match(html, /fill:"var\(--warm\)"/, '指针颜色不变');
});

test('转盘：抽奖规则改为可输入数字（1–100），两个入口各一处', async () => {
  const html = await loadEmbedded();
  // 不再有固定选项表
  assert.equal((html.match(/\[1,2,3,4,5,10\]\.map/g) ?? []).length, 0, '不应再有固定选项表');
  // 两个入口都换成花园自带的数字输入组件 In，且限制 1–100
  assert.match(html, /spin-rule-input"/, '成就页应有数字输入');
  assert.match(html, /spin-rule-input-settings"/, '设置页应有数字输入');
  assert.equal((html.match(/min:1,max:100/g) ?? []).length >= 2, true, '两个入口都应限制 1–100');
  assert.match(html, /Ge\(i\.ruleEvery,1,100/, '数据层必须允许最小 1');
});


/* ================================================================== *
 * 六、随机指针与发放机会（v1.16）
 * ================================================================== */

test('随机指针：落点在中奖扇区内部，且不再固定停在正中', async () => {
  const html = await loadEmbedded();
  const m = html.match(/function q1r\(i,u,d=Math\.random\)\{[^}]*\}/);
  assert.ok(m, '应存在 q1r（扇区内随机落点）');
  const q1r = new Function(`${m[0]}; return q1r;`)();

  for (const n of [2, 5, 8, 12]) {
    const b = 360 / n;
    for (let k = 0; k < n; k += 1) {
      for (const r of [0, 0.5, 0.999]) {
        const angle = q1r(n, k, () => r);
        assert.ok(angle >= k * b - 1e-9 && angle < (k + 1) * b, `n=${n} k=${k} r=${r} 落点跑出了扇区`);
      }
      // 同一扇区内，不同随机值必须得到不同角度（不是固定中心）
      assert.notEqual(q1r(n, k, () => 0), q1r(n, k, () => 0.999));
    }
  }
});

test('随机指针：抽奖使用同一个随机源生成落点并持久化', async () => {
  const html = await loadEmbedded();
  assert.match(html, /targetAngle:q1r\(v\.length,y,d\)/, '应使用随机落点');
  assert.equal(/targetAngle:q1\(v\.length,y\)/.test(html), false, '不应再固定对准扇区中心');
});

test('发放机会：新增 spin/grant 分支，且只增加 grantedCount', async () => {
  const html = await loadEmbedded();
  assert.match(html, /case"spin\/grant":\{[^}]*grantedCount:i\.spins\.grantedCount\+g/, '应有 spin/grant');
  assert.equal(/case"spin\/grant":\{[^}]*progressCount/.test(html), false, '不得改动 progressCount');
  assert.equal(/case"spin\/grant":\{[^}]*usedCount/.test(html), false, '不得改动 usedCount');
});
