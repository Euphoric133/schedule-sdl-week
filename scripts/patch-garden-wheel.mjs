#!/usr/bin/env node
/**
 * 对已构建的「专注花园」单文件应用打补丁。
 *
 * 目前包含两组、共 4 处补丁：
 *   A. 修复奖励转盘的旋转动画（见下）
 *   B. 暴露一个最小的联动桥 `window.__focusGardenBridge`
 *
 * 都是**新增/修正最小必要代码**，不改变花园已有的任何功能与交互。
 *
 * 背景：花园是预构建的单文件应用（React 已打包），没有源码。
 * 转盘的旋转逻辑在打包结果里，因此这个脚本对 `focus-garden.html` 做**精确的、可重复的**文本替换，
 * 并把改动写清楚，避免以后重新构建时"悄悄丢掉修复"。
 *
 * 三个真实缺陷（都在 `Tb` 组件里）：
 *
 * 1. `const Y = f ? 260 : (w ? 4200 : 0)`
 *    `w` 是"本会话里是否抽过奖"，首次为 false → 时长 0。
 *    于是点击后走 `if (Y === 0) { setAngle(最终角度); setSpinning(false); return }`：
 *    **角度一次性跳到终点、transition 还没生效就被关掉**，看起来就是"没转，直接出结果"。
 *
 * 2. `px(u.targetAngle, w ? 6 : 1)` —— 首次只转 1 圈，达不到"5~8 圈"的观感。
 *
 * 3. 结果卡片的条件是 `pending ? 卡片 : ...`，而 `pending` 在点击的那一刻就已写入，
 *    所以中奖礼物会和旋转同时出现，甚至早于旋转。
 *
 * 修复思路（不改变抽奖算法与奖励权重，动画只负责展示）：
 * - 用一个新的 ref 区分"挂载时恢复的待领取结果"（刷新后恢复，直接落到终点，符合恢复策略）
 *   与"用户刚点击产生的结果"（必须完整旋转 6 圈、4.2 秒）；
 * - 首次点击也给 6 圈 + 4.2 秒；
 * - 结果卡片改为"旋转结束后"才显示（`pending && !spinning`）。
 *
 * 用法：
 *   node scripts/patch-garden-wheel.mjs           # 打补丁（幂等）
 *   node scripts/patch-garden-wheel.mjs --check   # 只检查是否已打补丁
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const TARGET = join(projectRoot, 'focus-garden.html');

/** 每一处替换都写明原因；任何一处匹配失败立即报错，绝不"部分打补丁" */
const PATCHES = [
  {
    id: 'ref-for-restored-pending',
    // 短标记：补丁1的 to 文本里含有补丁3要替换的片段，不能用整段 to 判断是否已应用
    marker: 'g0=B.useRef(!0)',
    reason: '新增一个 ref，用来区分"刷新后恢复的待领取结果"与"用户刚点击产生的结果"',
    from: 'g=B.useRef(null);B.useEffect(()=>{if(!u){_(!1);return}const q=px(u.targetAngle,w?6:1),Y=f?260:w?4200:0;',
    to: 'g=B.useRef(null),g0=B.useRef(!0);B.useEffect(()=>{const K=g0.current;g0.current=!1;if(!u){_(!1);return}const q=px(u.targetAngle,f||K?0:6),Y=f?260:K?0:4200;',
  },
  {
    id: 'angle-continues-from-current',
    marker: 'const z=x+2160;',
    reason:
      'px() 返回的是绝对角度，每次抽奖都会把角度设回 ≈2160°，' +
      '第二次抽奖只会在原地挪几度（看起来几乎没转）。改为从**当前角度**继续累加至少 6 圈',
    from: 'const q=px(u.targetAngle,f||K?0:6),Y=f?260:K?0:4200;',
    to: 'const q=(()=>{const a=((360-u.targetAngle%360)%360+360)%360;if(f||K)return a;const z=x+2160;return z+(((a-z%360)%360)+360)%360;})(),Y=f?260:K?0:4200;',
  },
  {
    id: 'bridge-for-planner-sync',
    // 只把 React 的 state ref 与 dispatch 暴露出去，不包裹、不拦截任何现有逻辑
    marker: '__focusGardenBridge',
    reason:
      '向主应用暴露最小联动接口：getState 读取花园状态（供主应用显示番茄次数），' +
      'dispatch 用于把主应用的学习任务同步进花园、并自动开始计时',
    from: 'y.current=o;const S=d.warnings,b=B.useRef(!1);',
    to: 'y.current=o;globalThis.__focusGardenBridge={getState:()=>y.current,dispatch:f};const S=d.warnings,b=B.useRef(!1);',
  },
  {
    id: 'result-after-spin',
    marker: 'children:u&&!M?',
    reason: '中奖卡片必须等旋转结束（spinning 为 false）后再出现，不能与动画同时显示',
    from: 'children:u?s.jsxs("div",{className:"wheel-result__card",children:[',
    to: 'children:u&&!M?s.jsxs("div",{className:"wheel-result__card",children:[',
  },
];

async function main() {
  const checkOnly = process.argv.includes('--check');
  const html = await readFile(TARGET, 'utf8');

  // 逐条判断，支持"分次追加补丁"（每条都幂等）
  const pending = PATCHES.filter((patch) => !html.includes(patch.marker));
  if (checkOnly) {
    process.stdout.write(
      pending.length === 0 ? '专注花园转盘：补丁已应用\n' : `专注花园转盘：还有 ${pending.length} 处补丁未应用\n`,
    );
    process.exitCode = pending.length === 0 ? 0 : 1;
    return;
  }

  if (pending.length === 0) {
    process.stdout.write('专注花园转盘：补丁已全部应用，跳过（幂等）\n');
    return;
  }

  let patched = html;
  for (const patch of pending) {
    const occurrences = patched.split(patch.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `补丁「${patch.id}」期望匹配 1 处，实际匹配 ${occurrences} 处。\n` +
          '说明 focus-garden.html 可能已被重新构建（代码结构变了），请重新核对后再打补丁。',
      );
    }
    patched = patched.replace(patch.from, patch.to);
  }

  await writeFile(TARGET, patched, 'utf8');

  const before = Buffer.byteLength(html, 'utf8');
  const after = Buffer.byteLength(patched, 'utf8');
  process.stdout.write(`已修复专注花园转盘动画（本次应用 ${pending.length} 处）：\n`);
  for (const patch of pending) process.stdout.write(`  · ${patch.id}：${patch.reason}\n`);
  process.stdout.write(`文件大小：${before} → ${after} 字节（${relative(projectRoot, TARGET)}）\n`);
  process.stdout.write('下一步：node scripts/build-garden-embed.mjs && node scripts/build-standalone.mjs\n');
}

main().catch((error) => {
  process.stderr.write(`修复转盘动画失败：${error.message}\n`);
  process.exitCode = 1;
});
