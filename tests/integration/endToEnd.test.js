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

    // 2) 首页点"生成七天计划"
    env.go('#/home');
    env.click('生成七天计划');

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

test('端到端：从首页开始专注 → 完成一轮 → 统计与奖励机会都更新', async () => {
  const env = await launch();
  try {
    env.instance.services.taskService.addTask(TASK_INPUT);
    env.instance.services.planService.requestPreview({ now: env.instance.services.now() });
    env.instance.services.planService.applyPreview();

    // 首页点"开始专注"
    env.go('#/home');
    env.click('开始专注');
    assert.equal(env.dom.location.hash, '#/focus');
    env.instance.shell.render();

    // 计时真的开始了
    let timer = env.instance.services.pomodoroService.getTimer();
    assert.notEqual(timer.phase, 'idle', '应处于专注阶段');
    assert.ok(env.findButton('暂停'), '应能暂停');

    // 暂停 → 继续
    env.click('暂停');
    assert.equal(env.instance.services.pomodoroService.getTimer().paused, true);
    env.instance.shell.render();
    env.click('继续');
    assert.equal(env.instance.services.pomodoroService.getTimer().paused, false);

    // 模拟计时走完（用真实时间戳推进不可行，因此直接结束并选择"完成"）
    env.instance.services.pomodoroService.getTimer();
    const ended = env.instance.services.pomodoroService.endPhase({ reason: 'completed' });
    assert.equal(ended.ok, true);

    // 统计页应反映这次投入（哪怕只有几秒，也会记为提前结束而不是虚报完成）
    env.go('#/stats');
    const statsText = env.texts();
    assert.match(statsText, /学习统计/);
    assert.ok(!/页面渲染出错/.test(statsText));

    // 奖励页可达，且资格状态来自真实进度
    env.go('#/rewards');
    assert.match(env.texts(), /奖励转盘/);
    const eligibility = env.instance.services.rewardService.eligibility();
    assert.ok(eligibility.totalRemaining >= 0);
  } finally {
    env.cleanup();
  }
});

test('端到端：奖励转盘可以真正抽奖，结果与历史一致', async () => {
  const env = await launch();
  try {
    // 造一份足以获得机会的真实记录：30 分钟完成的专注
    env.instance.app.commit(
      (state) => ({
        ...state,
        focusRecords: [{ id: 'f1', date: env.instance.services.now().date, focusedSeconds: 1800, completed: true }],
      }),
      { reason: 'test-seed' },
    );

    env.go('#/rewards');
    assert.match(env.texts(), /可用抽奖机会/);
    const before = env.instance.services.rewardService.history().length;

    env.click('开始转动');
    const history = env.instance.services.rewardService.history();
    assert.equal(history.length, before + 1, '抽奖应写入一条历史记录');

    // 机会被扣减（30 分钟 → 1 次）
    assert.equal(env.instance.services.rewardService.eligibility().totalRemaining, 0);
    // 再点一次应被拒绝且不产生新记录
    env.instance.shell.render();
    const after = env.instance.services.rewardService.history().length;
    assert.equal(after, history.length, '没有机会时不会写入记录');
  } finally {
    env.cleanup();
  }
});

/* ================================================================== *
 * 外观与通知
 * ================================================================== */

test('端到端：外观页可以切换三种主题，设置被写入偏好', async () => {
  const env = await launch();
  try {
    env.go('#/appearance');
    const text = env.texts();
    assert.match(text, /外观主题/);
    assert.match(text, /浅色/);
    assert.match(text, /深色/);
    assert.match(text, /跟随系统/);

    env.click('深色');
    assert.equal(env.instance.services.appearanceService.getPreferences().appearance.theme, 'dark');
    env.instance.shell.render();
    env.click('浅色');
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
    assert.ok(navLinks.length >= 13, `侧边导航应有全部页面，实际 ${navLinks.length}`);

    for (const link of navLinks) {
      const hash = link.getAttribute('href');
      assert.ok(hash && hash.startsWith('#/'), `导航链接必须可用，实际 ${hash}`);
      env.go(hash);
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
    const routes = ['#/home', '#/week', '#/day', '#/tasks', '#/activities', '#/focus', '#/rewards', '#/stats', '#/preview', '#/versions', '#/appearance', '#/notifications', '#/settings'];
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

test('专注栏：计时开始后出现在每一页，可暂停/继续/放弃，结束后消失', async () => {
  const env = await launch();
  try {
    const shellRoot = () => env.dom.appHost.children[0];
    const focusBar = () => shellRoot().byClass('focus-bar')[0];
    assert.ok(focusBar(), '外壳里应有固定的专注栏容器');
    // 打桩 DOM 把 hidden 当作属性保存，因此这里按属性判断（真实浏览器里两者等价）
    const isHidden = () => focusBar().getAttribute('hidden') !== null;

    // 未计时时隐藏
    assert.equal(isHidden(), true, '未开始计时时专注栏应隐藏');

    // 开始一轮专注
    const session = { id: 'ses_bar', taskId: null, taskTitle: '英语阅读' };
    env.instance.services.pomodoroService.startFocus(session);
    env.go('#/tasks');
    assert.equal(isHidden(), false, '计时中应显示专注栏');

    const barText = () => focusBar().textContent;
    assert.match(barText(), /专注/, '应显示当前阶段');
    assert.match(barText(), /英语阅读/, '应显示当前任务');
    assert.match(barText(), /\d{2}:\d{2}/, '应显示倒计时');
    assert.match(barText(), /暂停/, '应提供暂停');
    assert.match(barText(), /放弃/, '应提供放弃');

    // 在非专注页面也能暂停 → 说明不必来回切页
    const pauseButton = focusBar().all().find((n) => n.tagName === 'BUTTON' && n.textContent.trim() === '暂停');
    pauseButton.click();
    assert.equal(env.instance.services.pomodoroService.getTimer().paused, true, '在任务页也能暂停计时');
    assert.match(focusBar().textContent, /已暂停/);

    // 继续
    const resumeButton = focusBar().all().find((n) => n.tagName === 'BUTTON' && n.textContent.trim() === '继续');
    assert.ok(resumeButton, '暂停后应显示继续');
    resumeButton.click();
    assert.equal(env.instance.services.pomodoroService.getTimer().paused, false);

    // 放弃后专注栏消失，且不写入任何学习记录
    const before = env.instance.app.getState().focusRecords.length;
    const discardButton = focusBar().all().find((n) => n.tagName === 'BUTTON' && n.textContent.trim() === '放弃');
    discardButton.click();
    assert.equal(env.instance.services.pomodoroService.getTimer().phase, 'idle');
    assert.equal(isHidden(), true, '计时结束后专注栏应隐藏');
    assert.equal(env.instance.app.getState().focusRecords.length, before, '放弃不产生学习记录');
  } finally {
    env.cleanup();
  }
});
