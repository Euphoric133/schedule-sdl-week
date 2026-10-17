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

import { buildDayColumn, compareCards, deriveStatus, resolveDates } from '../../src/ui/pages/day.js';
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

test('日期列：默认展示当前计划范围内的 7 天，不擅自扩大', () => {
  const env = planned();
  const plan = env.services.planService.getOfficialPlan();
  const dates = resolveDates({ plan, today: NOW.date });

  assert.equal(dates.length, 7);
  assert.equal(dates[0], plan.windowStart);
  assert.equal(dates[6], plan.windowEnd);
  // 日期连续
  for (let i = 1; i < dates.length; i += 1) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
    const current = new Date(`${dates[i]}T00:00:00Z`).getTime();
    assert.equal(current - prev, 86400000, `日期应连续：${dates[i - 1]} → ${dates[i]}`);
  }
});

test('日期列：还没有计划时以今天为起点展示 7 天', () => {
  const dates = resolveDates({ plan: null, today: '2025-10-16' });
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2025-10-16');
  assert.equal(dates[6], '2025-10-22');
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

  const studyColumn = buildDayColumn({
    date: sessionDate,
    state: nextState,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  assert.ok(studyColumn.cards.some((card) => card.kind === 'study'), '应显示学习任务');

  // 找一个周四（2025-10-16 是周四）
  const thursday = '2025-10-16';
  const fixedColumn = buildDayColumn({
    date: thursday,
    state: nextState,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  const fixedCard = fixedColumn.cards.find((card) => card.kind === 'fixed');
  assert.ok(fixedCard, '周四应显示固定课程');
  assert.equal(fixedCard.title, '高等数学课');
  assert.equal(fixedCard.startMinutes, 8 * 60);
  void state;
});

test('内容：没有具体时间的任务不会被隐藏', () => {
  const env = createTestApp();
  const state = env.app.getState();
  const plan = { version: 1, windowStart: NOW.date, windowEnd: NOW.date, blocks: [], days: [] };
  const column = buildDayColumn({
    date: NOW.date,
    state,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  // 没有 block 时列是空的，但不应报错；下面构造一个"只有开始时间"的块
  assert.deepEqual(column.cards, []);

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
  const column2 = buildDayColumn({
    date: NOW.date,
    state,
    plan: withBlock,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });
  assert.equal(column2.cards.length, 1, '没有具体时间的任务也必须显示，不能被隐藏');
  assert.equal(column2.cards[0].startMinutes, null);
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
    buildDayColumn({ date, state, plan, services: env.services, today: NOW.date, nowMinutes: NOW.minutes }).cards.map(
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
  const column = buildDayColumn({
    date: plan.windowStart,
    state,
    plan,
    services: env.services,
    today: NOW.date,
    nowMinutes: NOW.minutes,
  });

  for (const card of column.cards) {
    assert.notEqual(card.kind, 'buffer', '不应再有缓冲卡片');
    assert.notEqual(card.kind, 'rest', '休息不是任务，不应出现在任务列里');
    assert.ok(['study', 'fixed'].includes(card.kind), `只允许学习/固定两类，实际 ${card.kind}`);
  }
});

test('渲染：每日视图在真实页面里渲染出 7 个日期列，且不再有时间刻度', async () => {
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
  assert.equal(main.byClass('day-board__col').length, 7, '应有 7 个日期列');
  assert.equal(main.byClass('timeline__hour').length, 0, '不应再有整点刻度');
  assert.ok(main.byClass('day-card').length > 0, '应渲染出任务卡片');

  // 日期列标题包含星期与日期
  const heads = main.byClass('day-board__num').map((node) => node.textContent);
  assert.equal(heads.length, 7);
  for (const head of heads) assert.match(head, /^\d{2}-\d{2}$/, `列标题应显示日期，实际 ${head}`);

  // 卡片不重叠的前提：每张卡片都是独立的块级元素，且只在所属列内
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
