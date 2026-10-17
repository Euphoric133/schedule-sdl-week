/**
 * 每日视图（日期为列、任务为内容）测试。
 *
 * 关注点：
 * - 日期列正确（来自计划窗口，不擅自扩大）；
 * - 学习任务与固定任务都能显示，且视觉类别可区分；
 * - 没有具体时间的任务不会被隐藏；
 * - 排序稳定、可解释（重复渲染顺序不变）；
 * - 状态（已完成 / 进行中 / 已过期 / 已锁定）显示正确，不混淆；
 * - 不存在缓冲时间等已移除功能的元素。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDayCards, compareCards, deriveStatus, gridStepsFor, GRID_QUANTUM_MINUTES, MIN_CARD_STEPS } from '../../src/ui/board.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { FIXED_ACTIVITY_TYPE } from '../../src/domain/fixedActivity.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

function planned() {
  const env = createTestApp();
  const a = env.services.taskService.addTask(taskInput({ title: '线性代数作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }));
  const b = env.services.taskService.addTask(taskInput({ title: '英语阅读', subject: '英语', plannedMinutes: 60, deadlineDate: '2025-10-19' }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  return env;
}

/* ================================================================== *
 * 日期列
 * ================================================================== */

test('日期列：页面渲染出 7 个连续日期列，且没有时间列/时间刻度', async () => {
  const rendered = await renderWeekPage();
  try {
    const { main } = rendered;
    const columns = main.byClass('day-board__col');
    assert.equal(columns.length, 7, '应有 7 个日期列');

    // 不存在最左侧"时间"表头、也不存在小时刻度
    assert.equal(main.byClass('timeline__corner').length, 0, '不应有"时间"表头');
    assert.equal(main.byClass('timeline__hour').length, 0, '不应有小时刻度行');
    // 说明：不能直接用 includes('时间')，因为"休息时间"本身就包含"时间"
    const headers = main.all().filter((node) => node.textContent.trim() === '时间');
    assert.equal(headers.length, 0, '页面上不应残留"时间"列标题');

    // 每一列都有表头，日期连续
    const nums = main.byClass('day-board__num').map((node) => node.textContent);
    assert.equal(nums.length, 7);
    for (let i = 1; i < nums.length; i += 1) {
      assert.ok(nums[i] > nums[i - 1], `日期列应按时间递增：${nums[i - 1]} → ${nums[i]}`);
    }
  } finally {
    rendered.cleanup();
  }
});

test('网格：5 分钟为一个标准格，卡片高度按时长取整数格', () => {
  assert.equal(GRID_QUANTUM_MINUTES, 5, '基准时长必须是 5 分钟');
  assert.equal(gridStepsFor(5), MIN_CARD_STEPS, '5 分钟 = 最小可点击格数');
  assert.equal(gridStepsFor(10), MIN_CARD_STEPS);
  assert.equal(gridStepsFor(15), MIN_CARD_STEPS);
  assert.equal(gridStepsFor(30), 6, '30 分钟 = 6 格');
  assert.equal(gridStepsFor(45), 9);
  assert.equal(gridStepsFor(60), 12, '60 分钟正好是 30 分钟的两倍');
  assert.equal(gridStepsFor(90), 18);
  assert.equal(gridStepsFor(120), 24);

  // 非 5 分钟倍数向上取整，不丢失时长
  assert.equal(gridStepsFor(7), MIN_CARD_STEPS);
  assert.equal(gridStepsFor(32), 7, '32 分钟向上取整为 7 格（35 分钟的量）');
  // 倍数关系严格成立
  assert.equal(gridStepsFor(60) / gridStepsFor(30), 2);
  assert.equal(gridStepsFor(120) / gridStepsFor(60), 2);
});

/* ================================================================== *
 * 内容与状态
 * ================================================================== */

test('内容：学习任务与固定任务都出现在对应日期里，并有可区分的类型', () => {
  const env = planned();
  env.services.fixedActivityService.list(); // 触达服务
  const state = env.app.getState();
  const plan = env.services.planService.getOfficialPlan();

  // 加一个每周四的固定课（固定时间）
  env.app.commit(
    (s) => ({
      ...s,
      fixedActivities: [
        {
          id: 'fx_1',
          title: '高等数学课',
          type: FIXED_ACTIVITY_TYPE.CLASS,
          recurrence: { kind: 'weekly', daysOfWeek: [4] },
          startMinutes: 8 * 60,
          endMinutes: 9 * 60 + 40,
          activeFrom: null,
          activeTo: null,
          movable: false,
          note: '',
        },
      ],
    }),
    { reason: 'test-seed' },
  );

  const nextState = env.app.getState();
  const sessionDate = (nextState.sessions ?? []).find((s) => s.state === SESSION_STATE.FLEXIBLE)?.date;
  assert.ok(sessionDate, '应有学习时段');

  const studyColumn = buildDayCards({
    date: sessionDate,
    state: nextState,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  assert.ok(studyColumn.some((card) => card.kind === 'study'), '应显示学习任务');

  // 找一个周四（2025-10-16 是周四）
  const thursday = '2025-10-16';
  const fixedColumn = buildDayCards({
    date: thursday,
    state: nextState,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  const fixedCard = fixedColumn.find((card) => card.kind === 'fixed');
  assert.ok(fixedCard, '周四应显示固定课程');
  assert.equal(fixedCard.title, '高等数学课');
  assert.equal(fixedCard.startMinutes, 8 * 60);
  void state;
});

test('内容：没有具体时间的任务不会被隐藏', () => {
  const env = createTestApp();
  const state = env.app.getState();
  const plan = { version: 1, windowStart: NOW.date, windowEnd: NOW.date, blocks: [], days: [] };
  const emptyCards = buildDayCards({
    date: NOW.date,
    state,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  // 没有 block 时列是空的，但不应报错；下面构造一个"没有具体时间"的块
  assert.deepEqual(emptyCards, []);

  const withBlock = {
    ...plan,
    blocks: [
      {
        id: 'blk_1',
        kind: 'study',
        date: NOW.date,
        startMinutes: null,
        endMinutes: null,
        refId: null,
        taskId: 'tsk_unknown',
        label: '没有具体时间的任务',
      },
    ],
  };
  const column2 = buildDayCards({
    date: NOW.date,
    state,
    plan: withBlock,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  assert.equal(column2.length, 1, '没有具体时间的任务也必须显示，不能被隐藏');
  assert.equal(column2[0].startMinutes, null);
});

test('状态：已完成 / 进行中 / 已过期 / 已锁定 不会混淆', () => {
  const base = { block: { startMinutes: 960, endMinutes: 1020 }, date: '2025-10-16', today: '2025-10-16', nowMinutes: 1230 };

  assert.equal(deriveStatus({ ...base, session: { state: SESSION_STATE.COMPLETED } }), 'completed');
  assert.equal(deriveStatus({ ...base, session: { state: SESSION_STATE.IN_PROGRESS } }), 'in_progress');
  assert.equal(deriveStatus({ ...base, session: { state: SESSION_STATE.FLEXIBLE, locked: true } }), 'locked');
  assert.equal(deriveStatus({ ...base, session: { state: SESSION_STATE.CANCELLED } }), 'cancelled');

  // 今天但已经过了结束时间 → 已过期
  assert.equal(deriveStatus({ ...base, session: { state: SESSION_STATE.FLEXIBLE } }), 'overdue');
  // 今天且还没到结束时间 → 待进行
  assert.equal(
    deriveStatus({ ...base, nowMinutes: 970, session: { state: SESSION_STATE.FLEXIBLE } }),
    'flexible',
  );
  // 未来日期 → 待进行
  assert.equal(
    deriveStatus({ ...base, date: '2025-10-18', session: { state: SESSION_STATE.FLEXIBLE } }),
    'flexible',
  );
  // 过去的日期 → 已过期
  assert.equal(
    deriveStatus({ ...base, date: '2025-10-15', session: { state: SESSION_STATE.FLEXIBLE } }),
    'overdue',
  );
});

/* ================================================================== *
 * 排序
 * ================================================================== */

test('排序：按开始时间、学习优先、标题、id 依次比较，结果确定', () => {
  const cards = [
    { kind: 'fixed', id: 'f2', title: '午餐', startMinutes: 720 },
    { kind: 'study', id: 's2', title: '英语', startMinutes: 960 },
    { kind: 'study', id: 's1', title: '数学', startMinutes: 720 },
    { kind: 'fixed', id: 'f1', title: '早课', startMinutes: 480 },
    { kind: 'study', id: 's3', title: '没有时间的任务', startMinutes: null },
  ];

  const sorted = [...cards].sort(compareCards);
  assert.deepEqual(
    sorted.map((card) => card.id),
    ['f1', 's1', 'f2', 's2', 's3'],
    '先按时间，再学习优先，没有时间的排最后',
  );

  // 重复排序结果一致（稳定）
  const again = [...cards].sort(compareCards).map((card) => card.id);
  assert.deepEqual(again, sorted.map((card) => card.id), '排序必须稳定，不能因重新渲染而变化');

  // 完全相同的时间与类型时按标题，再按 id
  const tie = [
    { kind: 'study', id: 'b', title: 'B 任务', startMinutes: 600 },
    { kind: 'study', id: 'a', title: 'A 任务', startMinutes: 600 },
  ].sort(compareCards);
  assert.deepEqual(tie.map((card) => card.id), ['a', 'b']);
});

test('排序：真实数据下同一天的多次渲染顺序完全一致', () => {
  const env = planned();
  const state = env.app.getState();
  const plan = env.services.planService.getOfficialPlan();
  const date = plan.windowStart;

  const runs = Array.from({ length: 5 }, () =>
    buildDayCards({ date, state, plan, services: env.services, today: NOW.date, nowMinutes: NOW.minutes }).map(
      (card) => card.id,
    ),
  );
  for (const run of runs) {
    assert.deepEqual(run, runs[0], '同样的数据必须得到同样的顺序');
  }
});

/* ================================================================== *
 * 与已移除功能的隔离
 * ================================================================== */

test('隔离：每日视图不再包含缓冲时间、番茄钟或转盘相关元素', () => {
  const env = planned();
  const state = env.app.getState();
  const plan = env.services.planService.getOfficialPlan();
  const columnCards = buildDayCards({
    date: plan.windowStart,
    state,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });

  for (const card of columnCards) {
    assert.notEqual(card.kind, 'buffer', '不应再有缓冲卡片');
    assert.notEqual(card.kind, 'rest', '休息不是任务，不应出现在任务列里');
    assert.ok(['study', 'fixed'].includes(card.kind), `只允许学习/固定两类，实际 ${card.kind}`);
  }
});

test('渲染：每日视图聚焦单日，同样没有任何时间刻度', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { join, resolve } = await import('node:path');

  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const src = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
  const code = src.slice(src.indexOf('class FakeClassList'), src.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
  await writeFile('/tmp/dayboard-fakedom.mjs', code);
  const { installFakeDom } = await import('/tmp/dayboard-fakedom.mjs');

  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 12, 30) });

  instance.services.taskService.addTask(
    taskInput({ title: '线性代数作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }),
  );
  const preview = instance.services.planService.requestPreview({ now: instance.services.now() });
  assert.equal(preview.ok, true);
  assert.equal(instance.services.planService.applyPreview().ok, true);

  dom.location.hash = '#/day';
  instance.shell.render();

  const main = dom.appHost.children[0].byClass('app-main')[0];
  assert.equal(main.byClass('day-board__col').length, 1, '每日视图聚焦一天，只有 1 个日期列');
  assert.equal(main.byClass('timeline__hour').length, 0, '不应有整点刻度');
  assert.equal(main.byClass('timeline__corner').length, 0, '不应有"时间"表头');

  const heads = main.byClass('day-board__num').map((node) => node.textContent);
  assert.equal(heads.length, 1);
  assert.match(heads[0], /^\d{2}-\d{2}$/, `列标题应显示日期，实际 ${heads[0]}`);

  const columns = main.byClass('day-board__col');
  const totalCards = columns.reduce((sum, column) => sum + column.byClass('day-card').length, 0);
  assert.equal(totalCards, main.byClass('day-card').length, '卡片不应重复出现在多个列里');

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
});

/* ------------------------------------------------------------------ *
 * 辅助：渲染真实的七天计划页
 * ------------------------------------------------------------------ */

async function renderWeekPage() {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { join, resolve } = await import('node:path');

  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const src = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
  const code = src.slice(src.indexOf('class FakeClassList'), src.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
  await writeFile('/tmp/dayboard-week-fakedom.mjs', code);
  const { installFakeDom } = await import('/tmp/dayboard-week-fakedom.mjs');

  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 12, 30) });

  instance.services.taskService.addTask(
    taskInput({ title: '数学作业', subject: '数学', plannedMinutes: 90, deadlineDate: '2025-10-20' }),
  );
  const preview = instance.services.planService.requestPreview({ now: instance.services.now() });
  assert.equal(preview.ok, true);
  assert.equal(instance.services.planService.applyPreview().ok, true);

  dom.location.hash = '#/week';
  instance.shell.render();

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

  return { dom, instance, main: dom.appHost.children[0].byClass('app-main')[0], cleanup };
}
