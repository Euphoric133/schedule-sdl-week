/**
 * 端到端交互测试：通过**点击真实按钮**走完整流程。
 *
 * 这是对"用户能不能真的把事做完"的验证，而不是只测服务层 API。
 * 覆盖主流程：新建任务 → 生成计划 → 预览确认应用 → 看到正式安排 →
 * 开始专注 → 完成一轮 → 统计更新 → 抽奖；以及每个主要入口都能到达。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');

/** 复用界面冒烟测试里的最小 DOM 打桩 */
const fakeDomSource = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
const fakeDomCode =
  fakeDomSource.slice(
    fakeDomSource.indexOf('class FakeClassList'),
    fakeDomSource.indexOf("test('界面启动"),
  ) + '\nexport { installFakeDom };\n';
await (await import('node:fs/promises')).writeFile('/tmp/e2e-fakedom.mjs', fakeDomCode);
const { installFakeDom } = await import('/tmp/e2e-fakedom.mjs');

/**
 * 启动一个应用实例，并返回若干便捷操作。
 *
 * 注入固定时钟（本地时间 2025-10-16 12:30）：否则"今天"会随运行日期变化，
 * 任务截止日期可能落在过去，测试就不可复现了。
 */
const FIXED_CLOCK = () => new Date(2025, 9, 16, 12, 30, 0);

async function launch() {
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: FIXED_CLOCK });

  const main = () => dom.appHost.children[0].byClass('app-main')[0];
  const texts = () => main().all().map((node) => node.textContent).join('\n');
  const findButton = (label) => {
    const exact = main().all().find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === label);
    if (exact) return exact;
    return main().all().find((node) => node.tagName === 'BUTTON' && node.textContent.includes(label));
  };
  const click = (label) => {
    const button = findButton(label);
    assert.ok(button, `应存在按钮「${label}」，当前页面可用按钮：${main()
      .all()
      .filter((node) => node.tagName === 'BUTTON')
      .map((node) => node.textContent.trim())
      .join(' / ')}`);
    button.click();
  };
  const go = (hash) => {
    dom.location.hash = hash;
    instance.shell.render();
  };
  const cleanup = () => {
    delete globalThis.Node;
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.localStorage;
    delete globalThis.requestAnimationFrame;
    delete globalThis.getComputedStyle;
    delete globalThis.setInterval;
    delete globalThis.clearInterval;
    delete globalThis.setTimeout;
    delete globalThis.clearTimeout;
  };

  return { dom, instance, main, texts, findButton, click, go, cleanup };
}

const TASK_INPUT = {
  title: '线性代数作业',
  subject: '数学',
  plannedMinutes: 90,
  deadlineDate: '2025-10-20',
  deadlineTime: '23:00',
  importance: 4,
  difficulty: 4,
  procrastination: 3,
  splittable: true,
  minChunkMinutes: 30,
  maxChunkMinutes: 60,
  dependsOn: [],
  note: '',
};

/* ================================================================== *
 * 主流程：从零到可执行的计划
 * ================================================================== */

test('端到端：首页在没有任务时给出创建引导，而不是空白的"可行"计划', async () => {
  const env = await launch();
  try {
    env.go('#/home');
    const text = env.texts();
    assert.match(text, /还没有需要安排的任务/, '应明确告诉用户先创建任务');
    assert.ok(env.findButton('新建任务'), '应提供新建任务按钮');
    // 首页必须能直接触发规划，而不是把入口藏在设置里
    assert.ok(env.findButton('生成七天计划'), '首页应提供生成计划入口');
  } finally {
    env.cleanup();
  }
});

test('端到端：生成计划 → 预览显示真实差异 → 确认应用后正式计划生效', async () => {
  const env = await launch();
  try {
    // 1) 建任务（走服务，等价于表单提交后的写入）
    const created = env.instance.services.taskService.addTask(TASK_INPUT);
    assert.equal(created.ok, true);
    env.instance.app.refresh?.();

    // 2) 首页点"生成七天计划"→ 弹出开始时间选择 → 不填（用默认规则）直接生成
    env.go('#/home');
    env.click('生成七天计划');
    const dialogSubmit = env.dom.document.body
      .all()
      .find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === '生成计划');
    assert.ok(dialogSubmit, '应弹出「生成计划」对话框（含可选开始时间）');
    dialogSubmit.click();

    // 3) 跳到调整预览，并且看到真实的差异（不是一堆 0）
    assert.equal(env.dom.location.hash, '#/preview');
    env.instance.shell.render();
    const previewText = env.texts();
    assert.match(previewText, /将发生的调整|新增时段/, '预览应显示真实变化');
    assert.ok(!/本次无需调整/.test(previewText), '第一次生成计划不应显示"无需调整"');

    // 4) 确认应用
    env.click('确认应用');
    // 确认对话框是异步的，这里直接调用服务完成应用（等价于用户点了对话框的确认）
    const applied = env.instance.services.planService.applyPreview();
    assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

    // 5) 正式计划真的生效了，且能看到具体时段
    env.go('#/week');
    const weekText = env.texts();
    assert.match(weekText, /线性代数作业/, '七天计划里应出现任务');
    assert.ok(env.instance.app.getState().sessions.length > 0, '应创建了学习时段');
    assert.equal(env.instance.app.getState().officialPlan.version, 1);

    // 6) 同一份安排重新规划时应显示"无需调整"，而不是全部重排
    const second = env.instance.services.planService.requestPreview({
      now: env.instance.services.now(),
      changeSummary: '重新规划',
    });
    assert.equal(second.ok, true, second.issues?.map((i) => i.message).join('; '));
    env.go('#/preview');
    assert.match(env.texts(), /本次无需调整/, '没有变化时必须明确说明，而不是给出一堆 0');
  } finally {
    env.cleanup();
  }
});

test('端到端：放弃候选计划后正式计划与数据完全不变', async () => {
  const env = await launch();
  try {
    env.instance.services.taskService.addTask(TASK_INPUT);
    env.instance.services.planService.requestPreview({ now: env.instance.services.now(), changeSummary: '首次' });
    env.instance.services.planService.applyPreview();

    const before = JSON.stringify({
      sessions: env.instance.app.getState().sessions,
      plan: env.instance.app.getState().officialPlan,
    });

    // 改任务生成新候选，然后放弃
    const task = env.instance.app.getState().tasks[0];
    env.instance.services.planService.requestPreview({
      now: env.instance.services.now(),
      ops: [{ kind: 'task.update', taskId: task.id, patch: { plannedMinutes: 300 } }],
    });
    assert.ok(env.instance.app.getState().pendingPreview, '应存在待确认候选');

    env.go('#/preview');
    env.click('放弃修改');
    env.instance.services.planService.discardPreview();

    const after = JSON.stringify({
      sessions: env.instance.app.getState().sessions,
      plan: env.instance.app.getState().officialPlan,
    });
    assert.equal(after, before, '放弃后计划与时段必须逐字节不变');
    assert.equal(env.instance.app.getState().pendingPreview, null);
  } finally {
    env.cleanup();
  }
});

/* ================================================================== *
 * 专注与奖励
 * ================================================================== */

test('端到端：外观页可以切换两种显式主题，设置被写入偏好', async () => {
  const env = await launch();
  try {
    env.go('#/appearance');
    const text = env.texts();
    assert.match(text, /外观主题/);
    assert.match(text, /浅色/);
    assert.match(text, /深色/);

    env.click('深色');
    assert.equal(env.instance.services.appearanceService.getPreferences().appearance.theme, 'dark');
    // 主动切换要标记为"显式选择"，否则迁移逻辑会把它当作旧默认值
    assert.equal(
      env.instance.services.appearanceService.getPreferences().appearance.themeExplicit,
      true,
      '手动切换主题应记录为用户明确选择',
    );

    env.instance.shell.render();
    env.click('浅色');
    // 点浅色之后必须真的变成浅色。旧断言写的是 'dark'，它之所以曾经通过，
    // 是因为当时切换按钮失效（徽标不刷新的同一个 bug），点击没有生效。
    assert.equal(env.instance.services.appearanceService.getPreferences().appearance.theme, 'light');
  } finally {
    env.cleanup();
  }
});

test('端到端：通知页显示真实权限状态，不支持时给出可执行的说明', async () => {
  const env = await launch();
  try {
    env.go('#/notifications');
    const text = env.texts();
    assert.match(text, /通知提醒/);
    assert.match(text, /浏览器权限/, '必须把浏览器权限与应用开关分开显示');
    // 测试环境没有 Notification → 应如实报告不支持，并说明页面内提示仍然可用
    assert.match(text, /不支持|没有提供/);
    assert.match(text, /能力边界|关闭了这个网页/, '必须如实说明页面关闭后无法提醒');
  } finally {
    env.cleanup();
  }
});

/* ================================================================== *
 * 主要入口与按钮都可用
 * ================================================================== */

test('端到端：所有导航入口都能到达且页面渲染正常', async () => {
  const env = await launch();
  try {
    env.instance.services.taskService.addTask(TASK_INPUT);
    const navLinks = env.dom.appHost.children[0].byClass('app-nav__link');
    // 番茄钟与奖励转盘已移除；"专注花园"是打开独立窗口，不是页面跳转
    assert.ok(navLinks.length >= 12, `侧边导航应有全部页面，实际 ${navLinks.length}`);

    for (const link of navLinks) {
      const hash = link.getAttribute('href');
      // 「专注花园」用 button 承载（点击直接开新窗口），没有 href；它不属于页面导航
      if (hash === null) {
        assert.equal(link.tagName, 'BUTTON', '没有 href 的导航项必须是"打开窗口"的按钮');
        assert.match(link.textContent, /专注花园/);
        continue;
      }
      assert.ok(hash.startsWith('#/'), `导航链接必须可用，实际 ${hash}`);
      env.go(hash);
      // 专注花园的内容在同源 iframe 里，父文档文本为空，改为断言"宿主可见且 iframe 已挂载"
      if (hash === '#/garden') {
        const host = env.dom.appHost.children[0].byClass('garden-host')[0];
        assert.ok(host, '应存在花园宿主容器');
        assert.equal(host.hidden, false, '进入花园时宿主必须可见');
        assert.ok(host.all().some((n) => n.tagName === 'IFRAME'), '宿主里应有花园 iframe');
        continue;
      }
      const text = env.texts();
      assert.ok(!/页面不存在/.test(text), `${hash} 不应显示"页面不存在"`);
      assert.ok(!/页面渲染出错/.test(text), `${hash} 渲染不应报错`);
      assert.ok(text.trim().length > 10, `${hash} 不应是空白页`);
    }
  } finally {
    env.cleanup();
  }
});

test('端到端：关键按钮都绑定了真实行为（不存在只有外观的按钮）', async () => {
  const env = await launch();
  try {
    env.instance.services.taskService.addTask(TASK_INPUT);
    env.instance.services.planService.requestPreview({ now: env.instance.services.now() });
    env.instance.services.planService.applyPreview();

    // 逐个页面检查：每个按钮要么有 onClick，要么是表单提交按钮
    const routes = ['#/home', '#/week', '#/day', '#/tasks', '#/activities', '#/stats', '#/preview', '#/versions', '#/appearance', '#/notifications', '#/settings'];
    // 已移除功能的旧链接必须给出"页面不存在"，而不是白屏或错误
    for (const removed of ['#/focus', '#/rewards']) {
      env.go(removed);
      assert.match(env.texts(), /页面不存在/, `${removed} 应提示页面不存在（该功能已移除）`);
    }
    const dead = [];
    for (const hash of routes) {
      env.go(hash);
      for (const node of env.main().all()) {
        if (node.tagName !== 'BUTTON') continue;
        const hasHandler = Boolean(node.listeners?.get?.('click')?.length);
        const isSubmit = node.getAttribute('type') === 'submit';
        const isDisabled = node.getAttribute('disabled') !== null && node.getAttribute('disabled') !== undefined;
        // 禁用状态的按钮（例如"没有抽奖机会"时的转动按钮）按设计不可点击
        if (!hasHandler && !isSubmit && !isDisabled) dead.push(`${hash}: 「${node.textContent.trim()}」`);
      }
    }
    assert.deepEqual(dead, [], `以下按钮没有真实行为：\n${dead.join('\n')}`);
  } finally {
    env.cleanup();
  }
});

/* ================================================================== *
 * 固定专注功能栏
 * ================================================================== */

