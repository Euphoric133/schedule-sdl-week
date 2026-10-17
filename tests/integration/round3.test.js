/**
 * 第三轮回归测试。
 *
 * 覆盖：
 * 1. 休息时间保存（含"点了没反应"这个真实缺陷的复现与修复）
 * 2. 「设置休息」两种模式（今晚 / 每周固定）
 * 3. 已完成 / 已删除任务的历史残留不再锁定时间
 * 4. 规划开始时间（默认下一个整点、可指定、不排过去）
 * 5. 固定日程与休息的自动避让、可拆分 / 不可拆分
 * 6. 科目管理（新增 / 改名同步任务 / 删除保护 / 孤儿科目）
 * 7. 统计柱状图口径与 0/无数据区分
 * 8. 偏好设置不再有"可学习时间（按星期）"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';
import { SESSION_STATE } from '../../src/domain/session.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { nextHourAfter, resolveSearchStart } from '../../src/engine/capacity.js';
import { barChart } from '../../src/ui/components.js';
import { normalizeSubjectName } from '../../src/domain/subject.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/* ================================================================== *
 * 测试用的最小 DOM（与 ui-smoke 共用同一份打桩实现）
 * ================================================================== */

let domModule = null;
async function getDom() {
  if (domModule) return domModule;
  const smoke = await readFile(join(projectRoot, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
  const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
  const target = '/tmp/round3-fakedom.mjs';
  await writeFile(target, code);
  domModule = await import(target);
  return domModule;
}

async function withApp(clockIso, fn) {
  const { installFakeDom } = await getDom();
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(clockIso) });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const cleanup = () => {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) {
      delete globalThis[key];
    }
  };
  try {
    return await fn({ dom, instance, services: instance.services, app: instance.app, flush });
  } finally {
    cleanup();
  }
}

const bodyButtons = (dom) => dom.document.body.all().filter((node) => node.tagName === 'BUTTON');
const findButton = (dom, label) => bodyButtons(dom).find((node) => node.textContent.trim() === label);
const setInput = (dom, id, value) => {
  const node = dom.document.body.all().find((item) => item.id === id);
  assert.ok(node, `找不到输入框 ${id}`);
  node.value = value;
  node.dispatch('input', {});
  node.dispatch('change', {});
  return node;
};

/* ================================================================== *
 * 一、休息时间保存（修复"点了没反应"）
 * ================================================================== */

test('休息：通过表单提交可以真正保存，并且会立刻出现在看板上', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, instance, services, app, flush }) => {
    dom.location.hash = '#/week';
    instance.shell.render();

    services.ui.openRestForm(null);
    setInput(dom, 'rf-title', '睡觉');
    setInput(dom, 'rf-startDate', '2025-10-16');
    setInput(dom, 'rf-start', '22:00');
    setInput(dom, 'rf-endDate', '2025-10-17');
    setInput(dom, 'rf-end', '08:00');

    const submit = findButton(dom, '添加休息时间');
    assert.ok(submit, '应当有提交按钮');
    submit.click();
    await flush();

    const rests = app.getState().restPeriods ?? [];
    assert.equal(rests.length, 1, '点击后必须真的写入数据（不能"没反应"）');
    assert.equal(rests[0].title, '睡觉');
    assert.equal(rests[0].startMinutes, 22 * 60);
    assert.equal(rests[0].endMinutes, 8 * 60);

    // 两个日期片段
    assert.equal(services.restService.forDate('2025-10-16').length, 1);
    assert.equal(services.restService.forDate('2025-10-17').length, 1);

    // 保存后不需要手动刷新，看板立即出现休息卡片
    const cards = dom.appHost.children[0].byClass('day-card--rest');
    assert.ok(cards.length >= 1, '保存后休息应立即显示在日期列中');
  });
});

test('休息：非法输入会给出明确提示，而不是静默失败', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, instance, services, app, flush }) => {
    services.ui.openRestForm(null);
    setInput(dom, 'rf-title', '睡觉');
    setInput(dom, 'rf-startDate', '2025-10-16');
    setInput(dom, 'rf-start', '10:00');
    setInput(dom, 'rf-endDate', '2025-10-16');
    setInput(dom, 'rf-end', '10:00'); // 起止相同
    findButton(dom, '添加休息时间').click();
    await flush();

    assert.equal((app.getState().restPeriods ?? []).length, 0, '非法输入不得写入');
    const alerts = dom.document.body.all().filter((node) => node.classList?.contains('notice--danger'));
    assert.ok(alerts.length > 0, '必须显示错误提示');
    assert.match(alerts.map((node) => node.textContent).join(' '), /相同|无法确定/);
  });
});

test('休息：保存失败时不会抛异常静默退出（异常也会显示为错误）', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, services, app, flush }) => {
    // 故意让保存入口抛异常，验证表单不会"点了没反应"
    const original = services.ui.saveRest;
    services.ui.saveRest = () => {
      throw new Error('模拟写入失败');
    };
    try {
      services.ui.openRestForm(null);
      setInput(dom, 'rf-title', '休息');
      setInput(dom, 'rf-startDate', '2025-10-16');
      setInput(dom, 'rf-start', '12:00');
      setInput(dom, 'rf-endDate', '2025-10-16');
      setInput(dom, 'rf-end', '13:00');
      findButton(dom, '添加休息时间').click();
      await flush();

      const alerts = dom.document.body.all().filter((node) => node.classList?.contains('notice--danger'));
      assert.ok(alerts.length > 0, '异常必须变成用户可见的错误提示');
      assert.match(alerts.map((node) => node.textContent).join(' '), /模拟写入失败/);
      assert.equal((app.getState().restPeriods ?? []).length, 0);
    } finally {
      services.ui.saveRest = original;
    }
  });
});

/* ================================================================== *
 * 二、「设置休息」两种模式
 * ================================================================== */

test('设置休息：模式 A（仅今晚）保存为一次性休息，重复保存会替换而不是重复创建', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, services, app, flush }) => {
    services.ui.openRestSettings();
    assert.ok(findButton(dom, '仅设置今晚休息'), '应有"仅设置今晚休息"模式');
    findButton(dom, '保存').click();
    await flush();

    const first = app.getState().restPeriods ?? [];
    assert.equal(first.length, 1, '应保存一条休息');
    assert.equal(first[0].startDate, '2025-10-16', '开始日期必须是今天');
    assert.equal(first[0].endDate, '2025-10-17', '默认跨夜到明天');
    assert.equal((app.getState().fixedActivities ?? []).length, 0, '一次性休息不得变成每周重复规则');

    // 再保存一次：应替换，不是新增
    services.ui.openRestSettings();
    findButton(dom, '保存').click();
    await flush();
    assert.equal((app.getState().restPeriods ?? []).length, 1, '今晚已有安排时应替换，不得重复创建');
  });
});

test('设置休息：模式 B（固定睡觉时间）保存为每周重复规则，并跨周生效', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, services, app, flush }) => {
    services.ui.openRestSettings();
    findButton(dom, '固定睡觉时间').click();
    findButton(dom, '保存').click();
    await flush();

    // 固定任务是"候选计划"的一部分，需要确认后才写入
    const applied = services.planService.applyPreview();
    assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));

    const fixed = app.getState().fixedActivities ?? [];
    assert.equal(fixed.length, 1, '应写入一条固定任务');
    assert.equal(fixed[0].type, 'sleep');
    assert.equal(fixed[0].recurrence.kind, 'weekly');
    assert.equal(fixed[0].recurrence.daysOfWeek.length, 7);
    assert.equal((app.getState().restPeriods ?? []).length, 0, '重复规则不得保存成一次性休息');

    // 跨午夜：当天 22:00–24:00，次日 00:00–08:00
    const tonight = services.fixedActivityService.forDate('2025-10-16');
    const tomorrow = services.fixedActivityService.forDate('2025-10-17');
    assert.ok(tonight.some((item) => item.startMinutes === 22 * 60 && item.endMinutes === 1440), '当天应显示 22:00–24:00');
    assert.ok(tomorrow.some((item) => item.startMinutes === 0 && item.endMinutes === 8 * 60), '次日应显示 00:00–08:00');

    // 下一周同样的规则仍然生效
    assert.ok(services.fixedActivityService.forDate('2025-10-23').length > 0, '下周同一天仍有固定睡觉时间');
  });
});

/* ================================================================== *
 * 三、历史记录不再锁定时间
 * ================================================================== */

test('冲突：已完成任务占用的时段不再阻止在同一时间安排固定任务', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 15, 0) });
  const now = { date: '2025-10-16', minutes: 15 * 60 };
  env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-16' }));
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();

  // 模拟用户报告的场景：13:00–14:00 写作业并已完成，现在 15:00 想在同一时段安排课程
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((session) => ({
        ...session,
        date: '2025-10-16',
        startMinutes: 13 * 60,
        endMinutes: 14 * 60,
        plannedMinutes: 60,
        actualMinutes: 60,
        state: SESSION_STATE.COMPLETED,
      })),
    }),
    { reason: 'seed' },
  );

  const result = env.services.planService.requestPreview({
    now,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '课程', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '13:00', end: '14:00' },
      },
    ],
  });

  assert.equal(result.ok, true, `已完成的历史时段不应再拦人：${result.issues?.map((i) => i.message).join('; ')}`);
  assert.equal(
    (result.issues ?? []).filter((issue) => issue.severity === 'error').length,
    0,
    '不应产生"与固定活动重叠"这类错误',
  );

  // 学习历史仍然保留
  const stillThere = env.app.getState().sessions.filter((s) => s.state === SESSION_STATE.COMPLETED);
  assert.equal(stillThere.length, 1, '已完成的学习记录必须保留');
});

test('冲突：已删除任务的时段不再参与冲突检测', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 15, 0) });
  const now = { date: '2025-10-16', minutes: 15 * 60 };
  const created = env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-16' }));
  env.services.planService.requestPreview({ now });
  env.services.planService.applyPreview();
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((session) => ({ ...session, date: '2025-10-16', startMinutes: 13 * 60, endMinutes: 14 * 60 })),
    }),
    { reason: 'seed' },
  );

  assert.equal(env.services.taskService.deleteTask(created.task.id, { hard: true }).ok, true);
  const pending = env.app.getState().sessions.filter(
    (session) => session.state !== SESSION_STATE.COMPLETED && session.state !== SESSION_STATE.CANCELLED,
  );
  assert.equal(pending.length, 0, '删除任务后不得留下仍然有效的时段');

  const result = env.services.planService.requestPreview({
    now,
    ops: [
      {
        kind: 'fixedActivity.add',
        input: { title: '课程', type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [4] }, start: '13:00', end: '14:00' },
      },
    ],
  });
  assert.equal(result.ok, true, '删除任务后同一时段必须可以安排其它内容');
});

test('冲突：真正有效的固定任务与休息仍然会参与检测', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 10, 0) });
  env.app.commit(
    (state) => ({
      ...state,
      fixedActivities: [
        {
          id: 'fx_class',
          title: '高数课',
          type: 'class',
          recurrence: { kind: 'weekly', daysOfWeek: [4] },
          startMinutes: 8 * 60,
          endMinutes: 10 * 60,
          activeFrom: null,
          activeTo: null,
          movable: false,
          note: '',
        },
      ],
    }),
    { reason: 'seed' },
  );

  // 与固定任务重叠的休息必须被如实报告
  const conflicts = env.services.restService.findConflicts({
    id: 'new',
    title: '休息',
    startDate: '2025-10-16',
    startMinutes: 9 * 60,
    endDate: '2025-10-16',
    endMinutes: 11 * 60,
  });
  assert.equal(conflicts.ok, false);
  assert.ok(conflicts.conflicts.some((item) => item.kind === 'fixed' && item.title === '高数课'));
});

test('冲突：旧的孤立时段在加载时被安全清理，已完成历史保留', async () => {
  const { migrateState } = await import('../../src/storage/migrations.js');
  const { createTestApp: makeApp } = await import('../helpers/app.js');
  const { validateAppState } = await import('../../src/domain/schemas.js');
  const env = makeApp();
  const base = env.app.getState();

  const session = (id, state, date) => ({
    id,
    taskId: 'tsk_gone',
    date,
    startMinutes: 13 * 60,
    endMinutes: 14 * 60,
    plannedMinutes: 60,
    actualMinutes: state === 'completed' ? 60 : 0,
    state,
    locked: false,
    source: 'engine',
    derived: false,
    createdAt: '2025-10-16T00:00:00.000Z',
    updatedAt: '2025-10-16T00:00:00.000Z',
  });

  const broken = {
    ...base,
    tasks: [],
    sessions: [session('ses_orphan', 'flexible', '2025-10-16'), session('ses_history', 'completed', '2025-10-15')],
  };

  const migrated = migrateState(broken);
  assert.equal(validateAppState(migrated.state).ok, true, '清理后数据必须能通过校验');
  const byId = new Map(migrated.state.sessions.map((item) => [item.id, item]));
  assert.equal(byId.get('ses_orphan').state, SESSION_STATE.CANCELLED, '孤立的有效时段应被取消');
  assert.equal(byId.get('ses_history').state, SESSION_STATE.COMPLETED, '已完成的历史记录必须保留');
  assert.deepEqual(migrated.state.tasks, [], '不得为了修复而伪造任务');
});

/* ================================================================== *
 * 四、规划开始时间
 * ================================================================== */

test('开始时间：默认严格取"当前时刻之后的下一个整点"', () => {
  const cases = [
    [20 * 60 + 24, 21 * 60],
    [20 * 60 + 0, 21 * 60],
    [20 * 60 + 59, 21 * 60],
    [21 * 60 + 0, 22 * 60],
  ];
  for (const [minutes, expected] of cases) {
    assert.equal(nextHourAfter({ date: '2025-10-16', minutes }).minutes, expected, `now=${minutes} 应取 ${expected}`);
  }
  // 23:59 → 次日 00:00
  assert.deepEqual(nextHourAfter({ date: '2025-10-16', minutes: 23 * 60 + 59 }), { date: '2025-10-17', minutes: 0 });
});

test('开始时间：未指定时给出默认说明；指定在过去的时间会明确告知并调整', () => {
  const now = { date: '2025-10-16', minutes: 20 * 60 + 24 };

  const byDefault = resolveSearchStart({ now, requested: null });
  assert.equal(byDefault.start.minutes, 21 * 60);
  assert.equal(byDefault.diagnostics.length, 1, '默认行为也必须告知用户');
  assert.match(byDefault.diagnostics[0].message, /下一个整点/);

  const explicit = resolveSearchStart({ now, requested: { date: '2025-10-16', minutes: 22 * 60 } });
  assert.equal(explicit.start.minutes, 22 * 60, '用户指定时必须按指定时间开始');
  assert.equal(explicit.diagnostics.length, 0);

  const inPast = resolveSearchStart({ now, requested: { date: '2025-10-16', minutes: 9 * 60 } });
  assert.equal(inPast.start.minutes, 21 * 60, '过去的时间不能被当成未来');
  assert.equal(inPast.diagnostics.length, 1);
  assert.match(inPast.diagnostics[0].message, /已经过去/);
});

test('开始时间：不会生成过去的学习时段', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 20, 30) });
  const now = { date: '2025-10-16', minutes: 20 * 60 + 30 };
  env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-18' }));
  const result = env.services.planService.requestPreview({ now });
  assert.equal(result.ok, true);

  const todayBlocks = result.preview.candidate.blocks.filter((block) => block.date === '2025-10-16');
  for (const block of todayBlocks) {
    assert.ok(block.startMinutes >= 21 * 60, `今天的时段不得早于规划起点，实际 ${block.startMinutes}`);
  }
});

test('开始时间：用户指定开始时间后，今天的时段不早于该时间', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 14, 0) });
  const now = { date: '2025-10-16', minutes: 14 * 60 };
  env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-18' }));
  const result = env.services.planService.requestPreview({ now, startAt: '18:00' });
  assert.equal(result.ok, true);

  const todayBlocks = result.preview.candidate.blocks.filter((block) => block.date === '2025-10-16');
  for (const block of todayBlocks) {
    assert.ok(block.startMinutes >= 18 * 60, `指定 18:00 开始后不得早于 18:00，实际 ${block.startMinutes}`);
  }
});

/* ================================================================== *
 * 五、固定日程自动避让 / 拆分规则
 * ================================================================== */

test('排程：固定日程冲突不会让整个规划失败，任务会被安排到其它时段', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 6, 0) });
  const now = { date: '2025-10-16', minutes: 6 * 60 };
  // 一周的白天全部被课程占满，只留下晚上
  env.app.commit(
    (state) => ({
      ...state,
      fixedActivities: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
        id: `fx_${day}`,
        title: '课程',
        type: 'class',
        recurrence: { kind: 'weekly', daysOfWeek: [day] },
        startMinutes: 8 * 60,
        endMinutes: 18 * 60,
        activeFrom: null,
        activeTo: null,
        movable: false,
        note: '',
      })),
    }),
    { reason: 'seed' },
  );
  env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 120, deadlineDate: '2025-10-22' }));

  const result = env.services.planService.requestPreview({ now });
  assert.equal(result.ok, true, `不应因为固定日程而整体失败：${result.issues?.map((i) => i.message).join('; ')}`);

  const studyBlocks = result.preview.candidate.blocks.filter((block) => block.kind === 'study');
  assert.ok(studyBlocks.length > 0, '应仍能安排学习时段');
  for (const block of studyBlocks) {
    assert.ok(
      block.startMinutes >= 18 * 60 || block.endMinutes <= 8 * 60,
      `学习时段必须避开 08:00–18:00 的课程，实际 ${block.startMinutes}-${block.endMinutes}`,
    );
  }
});

test('排程：不允许拆分的任务只会放进一个足够长的连续时段', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 6, 0) });
  const now = { date: '2025-10-16', minutes: 6 * 60 };
  env.services.taskService.addTask(
    taskInput({ title: '不可拆分', plannedMinutes: 90, splittable: false, minChunkMinutes: 90, maxChunkMinutes: 90, deadlineDate: '2025-10-18' }),
  );

  const result = env.services.planService.requestPreview({ now });
  assert.equal(result.ok, true);
  const blocks = result.preview.candidate.blocks.filter((block) => block.kind === 'study');
  assert.equal(blocks.length, 1, '不可拆分任务只能有一个片段');
  assert.equal(blocks[0].endMinutes - blocks[0].startMinutes, 90, '片段长度必须等于总时长');
});

test('排程：允许拆分的任务可以跨多个可用时段，且工作量守恒', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 6, 0) });
  const now = { date: '2025-10-16', minutes: 6 * 60 };
  env.services.taskService.addTask(
    taskInput({ title: '可拆分', plannedMinutes: 180, splittable: true, minChunkMinutes: 30, maxChunkMinutes: 60, deadlineDate: '2025-10-20' }),
  );

  const result = env.services.planService.requestPreview({ now });
  assert.equal(result.ok, true);
  const blocks = result.preview.candidate.blocks.filter((block) => block.kind === 'study');
  assert.ok(blocks.length > 1, '180 分钟且上限 60 分钟时应拆成多段');
  assert.equal(
    blocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0),
    180,
    '拆分后的总时长必须等于剩余工作量',
  );
});

test('排程：无法安排的任务会列出原因，而不是产生非法计划', () => {
  const env = createTestApp({ clock: () => new Date(2025, 9, 16, 6, 0) });
  const now = { date: '2025-10-16', minutes: 6 * 60 };
  // 只有一个 30 分钟的窗口，却要求 120 分钟不可拆分
  env.app.commit(
    (state) => ({
      ...state,
      settings: {
        ...state.settings,
        studyWindows: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, [{ startMinutes: 600, endMinutes: 630 }]])),
      },
    }),
    { reason: 'seed' },
  );
  env.services.taskService.addTask(
    taskInput({ title: '大任务', plannedMinutes: 120, splittable: false, minChunkMinutes: 120, maxChunkMinutes: 120, deadlineDate: '2025-10-18' }),
  );

  const result = env.services.planService.requestPreview({ now });
  assert.equal(result.ok, true, '排不下也应当生成一份（可能为空的）候选计划并说明原因');
  const unscheduled = result.preview.candidate.unscheduled ?? [];
  assert.ok(unscheduled.length > 0, '必须列出未能安排的任务');
  assert.ok(unscheduled[0].reasonText || unscheduled[0].reasonCode, '必须给出原因');
});

/* ================================================================== *
 * 六、科目管理
 * ================================================================== */

test('科目：新增会去重（前后空格不产生重复项）', () => {
  const env = createTestApp();
  const ctx = { idFactory: env.idFactory, nowIso: '2025-10-16T00:00:00.000Z' };
  let state = env.app.getState();
  const { applyDraftOp } = subjectMutations;
  const first = applyDraftOp(state, { kind: 'subject.ensure', name: '数学' }, ctx);
  state = first.state;
  const second = applyDraftOp(state, { kind: 'subject.ensure', name: '  数学 ' }, ctx);
  assert.equal(second.state.subjects.length, 1, '只差空格的同名科目不得重复创建');
  assert.equal(second.existing, true);
});

test('科目：改名后引用它的任务一起更新', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '作业', subject: '数学' }));
  assert.equal(created.ok, true);
  const ctx = { idFactory: env.idFactory, nowIso: '2025-10-16T00:00:00.000Z' };
  const { applyDraftOp } = subjectMutations;

  let state = env.app.getState();
  state = applyDraftOp(state, { kind: 'subject.ensure', name: '数学' }, ctx).state;
  const subject = state.subjects[0];
  const renamed = applyDraftOp(state, { kind: 'subject.rename', subjectId: subject.id, name: '高等数学' }, ctx);

  assert.equal(renamed.ok, true);
  assert.equal(renamed.state.subjects[0].name, '高等数学');
  assert.equal(renamed.state.tasks[0].subject, '高等数学', '任务上的科目名必须同步更新');
});

test('科目：删除仍被引用的科目会被拒绝；指定替换科目后才会迁移', () => {
  const env = createTestApp();
  env.services.taskService.addTask(taskInput({ title: '作业', subject: '数学' }));
  const ctx = { idFactory: env.idFactory, nowIso: '2025-10-16T00:00:00.000Z' };
  const { applyDraftOp } = subjectMutations;

  let state = env.app.getState();
  state = applyDraftOp(state, { kind: 'subject.ensure', name: '数学' }, ctx).state;
  state = applyDraftOp(state, { kind: 'subject.ensure', name: '英语' }, ctx).state;
  const math = state.subjects.find((item) => item.name === '数学');

  const refused = applyDraftOp(state, { kind: 'subject.remove', subjectId: math.id }, ctx);
  assert.equal(refused.ok, false, '仍被引用时必须拒绝删除');
  assert.match(refused.issues[0].message, /还有 1 个任务在用/);

  const migrated = applyDraftOp(state, { kind: 'subject.remove', subjectId: math.id, reassignTo: '英语' }, ctx);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.state.subjects.length, 1);
  assert.equal(migrated.state.tasks[0].subject, '英语', '必须迁移到替换科目，不能留下无法识别的引用');
});

test('科目：历史任务里未登记的科目会被识别为"孤儿"，可一键收编', () => {
  const env = createTestApp();
  env.app.commit(
    (state) => ({
      ...state,
      tasks: [
        {
          ...taskSeed('t1', '旧任务', '物理实验'),
        },
      ],
      subjects: [],
    }),
    { reason: 'seed' },
  );
  const orphans = env.services.subjectService.listOrphans();
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].name, '物理实验');
  assert.equal(orphans[0].usageCount, 1);

  // 收编后不再是孤儿，任务仍然能正常显示科目
  const ctx = { idFactory: env.idFactory, nowIso: '2025-10-16T00:00:00.000Z' };
  const ensured = subjectMutations.applyDraftOp(env.app.getState(), { kind: 'subject.ensure', name: '物理实验' }, ctx);
  assert.equal(ensured.ok, true, ensured.issues?.map((i) => i.message).join('; '));
  env.app.commit(() => ensured.state, { reason: 'subject-ensure' });
  assert.equal(env.services.subjectService.listOrphans().length, 0);
  assert.equal(env.services.subjectService.list().length, 1);
  assert.equal(env.app.getState().tasks[0].subject, '物理实验');
});

test('科目：旧数据加载时会把任务里的科目整理成列表，且不改动任务', async () => {
  const { migrateState } = await import('../../src/storage/migrations.js');
  const env = createTestApp();
  const base = env.app.getState();
  const raw = {
    ...base,
    subjects: undefined,
    tasks: [taskSeed('t1', 'A', '数学'), taskSeed('t2', 'B', '  数学 ')],
  };
  const migrated = migrateState(raw);
  assert.equal(migrated.state.subjects.length, 1, '只差空格的同名科目应合并为一项');
  assert.equal(migrated.state.tasks[0].subject, '数学', '不得静默修改任务数据');
  assert.equal(migrated.state.tasks[1].subject, '  数学 ', '不得静默修改任务数据');
});

/* ================================================================== *
 * 七、统计柱状图
 * ================================================================== */

async function withDom(fn) {
  const { installFakeDom } = await getDom();
  installFakeDom();
  try {
    return await fn();
  } finally {
    for (const key of [
      'Node', 'addEventListener', 'removeEventListener', 'document', 'window', 'location', 'localStorage',
      'requestAnimationFrame', 'getComputedStyle', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ]) {
      delete globalThis[key];
    }
  }
}

test('柱状图：一天一根柱子，计划与实际使用同一坐标', async () => withDom(() => {
  const chart = barChart({
    days: [
      { date: '2025-10-14', short: '14', actualMinutes: 0, plannedMinutes: 60 },
      { date: '2025-10-15', short: '15', actualMinutes: 30, plannedMinutes: 60 },
      { date: '2025-10-16', short: '16', actualMinutes: 60, plannedMinutes: 60 },
    ],
    height: 120,
  });
  const columns = chart.byClass('chart__col');
  assert.equal(columns.length, 3, '每天只应有一列（不是计划/实际两列）');
  assert.equal(chart.byClass('chart__bar').length, 2, '只有实际学习过的两天有柱子');
  assert.equal(chart.byClass('chart__zero').length, 1, '0 分钟的那天显示基线短划');
  assert.equal(chart.byClass('chart__track').length, 3, '计划时长用浅色轨道表示');

  // 同一坐标：30 分钟柱高是 60 分钟的一半
  const bars = chart.byClass('chart__bar').map((node) => Number.parseInt(String(node.style.height), 10));
  assert.equal(bars.length, 2);
  assert.equal(bars[0] * 2, bars[1], '柱子高度必须按真实数值成比例');
}));

test('柱状图：没有数据时给出明确说明，而不是画一条平线', async () => withDom(() => {
  const empty = barChart({ days: [] });
  assert.match(empty.textContent, /还没有/);
  const allZero = barChart({ days: [{ date: '2025-10-16', short: '16', actualMinutes: 0, plannedMinutes: 0 }] });
  assert.match(allZero.textContent, /还没有/, '全是 0 时也应说明没有数据');
}));

test('统计：图表数据来自与统计一致的逐日汇总，休息不计入学习时长', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '作业', plannedMinutes: 60, deadlineDate: '2025-10-20' }));
  const task = env.app.getState().tasks.find((item) => item.id === created.task.id);
  env.app.commit(
    (state) => ({
      ...state,
      sessions: [
        {
          id: 'ses_done',
          taskId: task.id,
          date: '2025-10-16',
          startMinutes: 600,
          endMinutes: 660,
          plannedMinutes: 60,
          actualMinutes: 45,
          state: SESSION_STATE.COMPLETED,
          locked: false,
          source: 'engine',
          derived: false,
          createdAt: '',
          updatedAt: '',
        },
      ],
      restPeriods: [
        { id: 'rst_1', title: '午休', startDate: '2025-10-16', startMinutes: 720, endDate: '2025-10-16', endMinutes: 780, note: '', createdAt: '', updatedAt: '' },
      ],
    }),
    { reason: 'seed' },
  );

  const day = env.services.statsService.aggregateDay('2025-10-16');
  assert.equal(day.actualMinutes, 45, '实际学习时长只统计学习时段');
  assert.equal(day.completedSessions, 1);
});

/* ================================================================== *
 * 八、偏好设置精简
 * ================================================================== */

test('偏好设置：不再显示"可学习时间（按星期）"，但底层数据仍被保留', async () => {
  await withApp('2025-10-16T20:24:00+08:00', async ({ dom, instance, app }) => {
    dom.location.hash = '#/settings';
    instance.shell.render();
    const main = dom.appHost.children[0].byClass('app-main')[0];
    const text = main.all().map((node) => node.textContent).join('\n');

    assert.equal(/可学习时间（按星期）/.test(text), false, '该区域必须整块删除');
    assert.equal(/每周可学习/.test(text), false, '对应的说明文字也要删除');
    assert.match(text, /科目管理/, '科目管理必须能在偏好设置里找到');

    // 数据仍然存在：排程器与容量计算依赖它
    const settings = app.getState().settings;
    assert.ok(settings.studyWindows && Object.keys(settings.studyWindows).length > 0, '可学习时间数据不能被删掉');
  });
});

/* ================================================================== *
 * 辅助
 * ================================================================== */

const subjectMutations = await import('../../src/domain/mutations.js');
function taskSeed(id, title, subject) {
  return {
    id,
    title,
    subject,
    plannedMinutes: 60,
    priorCompletedMinutes: 0,
    deadlineDate: '2025-10-20',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
    status: TASK_STATUS.NOT_STARTED,
    note: '',
    createdAt: '2025-10-16T00:00:00.000Z',
    updatedAt: '2025-10-16T00:00:00.000Z',
  };
}
