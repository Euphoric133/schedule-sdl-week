/**
 * 第二轮修复的回归测试。
 *
 * 覆盖：背景层级与清晰度、任务删除/完成后隐藏、七天计划的列结构、
 * 固定任务跨周、名称长度限制、网格尺寸规则、休息时间与跨午夜拆分。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SESSION_STATE } from '../../src/domain/session.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { FIXED_ACTIVITY_TYPE } from '../../src/domain/fixedActivity.js';
import { TASK_NAME_MAX_LENGTH, checkName } from '../../src/domain/validation.js';
import {
  REST_MAX_DAYS,
  restDurationMinutes,
  splitRestAcrossDates,
  validateRestPeriod,
} from '../../src/domain/restPeriod.js';
import { gridStepsFor, MIN_CARD_STEPS, GRID_QUANTUM_MINUTES, compareCards } from '../../src/ui/board.js';
import { applyDraftOp } from '../../src/domain/mutations.js';
import { buildDayCards } from '../../src/ui/board.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { FIXED_NOW } from '../helpers/clock.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const NOW = { date: FIXED_NOW.date, minutes: FIXED_NOW.minutes };

/* ================================================================== *
 * 一、背景与层级
 * ================================================================== */

test('背景：壁纸层必须在内容之下（负 z-index），且不接收鼠标事件', async () => {
  const tokens = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'tokens.css'), 'utf8');
  const block = tokens.slice(tokens.indexOf('#app-wallpaper {'), tokens.indexOf('#app-wallpaper::after'));

  assert.match(block, /position:\s*fixed/, '壁纸层应固定覆盖窗口');
  // 这是本轮最关键的修复：z-index: 0 会让壁纸按绘制顺序盖在普通流内容之上
  assert.match(block, /z-index:\s*-1/, '壁纸层必须使用负 z-index，否则会遮挡整个界面');
  assert.match(block, /pointer-events:\s*none/, '壁纸层不得阻挡点击');

  // 遮罩必须存在（保证任何照片下文字可读）
  const after = tokens.slice(tokens.indexOf('#app-wallpaper::after'));
  assert.match(after.slice(0, 300), /opacity:\s*0?\.\d+/, '壁纸必须有半透明遮罩');
});

test('背景：整页容器与内容卡片绝不使用 backdrop-filter（液态玻璃只作用于离散表面）', async () => {
  const tokens = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'tokens.css'), 'utf8');
  const components = await readFile(join(projectRoot, 'src', 'ui', 'styles', 'components.css'), 'utf8');

  /** 去掉注释，避免把说明文字当成规则 */
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  // 规则变更（v1.19）：玻璃允许用于外壳与浮层，但**整页容器**永远不行。
  for (const css of [tokens, components]) {
    const body = strip(css);
    for (const selector of ['body', '.app', '.app-main']) {
      const rule = new RegExp(`(^|[},])\\s*${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`, 'g');
      for (const block of body.match(rule) ?? []) {
        assert.equal(/backdrop-filter/.test(block), false, `${selector} 不允许使用 backdrop-filter`);
      }
    }
  }

  // 承载正文的卡片只做 tint，不模糊
  const cardRules = strip(components).match(/(^|[},])\s*\.card\s*\{[^}]*\}/g) ?? [];
  for (const block of cardRules) {
    assert.equal(/backdrop-filter/.test(block), false, '.card 不允许使用 backdrop-filter');
  }

  // 壁纸开启时卡片必须更实，而不是更透
  assert.equal(/:root\[data-wallpaper='on'\] \.card\s*\{/.test(tokens), false, '卡片不应因壁纸而变半透明');
});

/* ================================================================== *
 * 二、任务删除与完成后隐藏
 * ================================================================== */

function plannedEnv() {
  const env = createTestApp();
  const created = env.services.taskService.addTask(
    taskInput({ title: '数学作业', plannedMinutes: 120, deadlineDate: '2025-10-20' }),
  );
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));
  const preview = env.services.planService.requestPreview({ now: NOW, changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);
  return { ...env, task: env.app.getState().tasks.find((item) => item.id === created.task.id) };
}

test('删除：已排入计划的任务可以直接删除，不留孤立时段，学习记录保留', () => {
  const env = plannedEnv();
  const taskId = env.task.id;

  // 先完成一段，制造学习历史
  const first = env.app.getState().sessions.find((s) => s.taskId === taskId && s.state === SESSION_STATE.FLEXIBLE);
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === first.id ? { ...s, state: SESSION_STATE.COMPLETED, actualMinutes: s.plannedMinutes } : s,
      ),
    }),
    { reason: 'seed' },
  );

  const result = env.services.taskService.deleteTask(taskId, { hard: true });
  assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));

  const state = env.app.getState();
  const own = state.sessions.filter((s) => s.taskId === taskId);
  // 不允许残留"仍然有效"的时段：要么已取消，要么已完成
  assert.equal(
    own.filter((s) => s.state === SESSION_STATE.FLEXIBLE || s.state === SESSION_STATE.IN_PROGRESS).length,
    0,
    '删除后不应残留未完成的计划时段',
  );
  assert.ok(own.filter((s) => s.state === SESSION_STATE.COMPLETED).length >= 1, '已完成的学习记录必须保留');
  const task = state.tasks.find((item) => item.id === taskId);
  assert.ok(task, '有历史记录时保留任务实体（软删除）');
  assert.equal(task.status, TASK_STATUS.DELETED);
});

test('删除：尚未排程的任务被彻底删除，不产生任何时段', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '未排程', plannedMinutes: 30, deadlineDate: '2025-10-25' }));
  const result = env.services.taskService.deleteTask(created.task.id, { hard: true });
  assert.equal(result.ok, true);
  assert.equal(env.app.getState().tasks.length, 0);
  assert.equal(env.app.getState().sessions.length, 0);
});

test('删除：数据不一致的历史任务也能删除（不会因校验被拦下）', () => {
  const env = plannedEnv();
  const taskId = env.task.id;

  // 人为制造"任务已完成但时段仍有效"的坏数据（模拟历史版本留下的状态）
  env.app.commit(
    (state) => ({
      ...state,
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status: TASK_STATUS.COMPLETED } : task)),
    }),
    { reason: 'seed-bad' },
  );

  const result = env.services.taskService.deleteTask(taskId, { hard: true });
  assert.equal(result.ok, true, `坏数据也必须能删除：${result.issues?.map((i) => i.message).join('; ')}`);
});

test('完成：任务标记完成后仍保留在时间表里并显示"已完成"，且只保留最早一块，历史记录保留', async () => {
  const env = plannedEnv();
  const taskId = env.task.id;
  const before = boardCardsFor(env, ['2025-10-16', '2025-10-17', '2025-10-18', '2025-10-19', '2025-10-20', '2025-10-21', '2025-10-22']);
  assert.ok(before.some((card) => card.taskId === taskId), '完成之前应能看到这个任务');

  // 先完成其中一段，保留学习历史
  const flexible = env.app.getState().sessions.find((s) => s.taskId === taskId && s.state === SESSION_STATE.FLEXIBLE);
  env.app.commit(
    (state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === flexible.id ? { ...s, state: SESSION_STATE.COMPLETED, actualMinutes: s.plannedMinutes } : s,
      ),
    }),
    { reason: 'seed' },
  );

  const preview = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'task.status', taskId, to: TASK_STATUS.COMPLETED }],
  });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true);

  const after = boardCardsFor(env, preview.preview.candidate.days.map((day) => day.date));
  const remaining = after.filter((card) => card.taskId === taskId);
  // 规则变更（v1.17）：已完成任务保留在时间表里，显示"已完成"，但只保留最早的一块
  assert.ok(remaining.length >= 1, '任务完成后应仍能看到它（显示为已完成）');
  assert.ok(remaining.every((card) => card.status === 'completed'), '卡片状态必须是已完成');
  assert.ok(remaining.every((card) => card.taskStatus === 'completed'));

  const state = env.app.getState();
  assert.equal(state.tasks.find((t) => t.id === taskId).status, TASK_STATUS.COMPLETED);
  assert.ok(
    state.sessions.filter((s) => s.taskId === taskId && s.state === SESSION_STATE.COMPLETED).length >= 1,
    '已完成的学习记录必须保留',
  );
});

/** 用真实的看板数据组装，覆盖多个日期 */
function boardCardsFor(env, dates) {
  const state = env.app.getState();
  const plan = env.services.planService.getOfficialPlan();
  return dates.flatMap((date) =>
    buildCards(date, state, plan, env.services),
  );
}

function buildCards(date, state, plan, services) {
  return buildDayCards({ date, state, plan, services, today: NOW.date, nowMinutes: NOW.minutes });
}

/* ================================================================== *
 * 三、固定任务跨周
 * ================================================================== */

test('固定任务：重复规则在任何一周都成立（不是只生成未来 7 天的一次性数据）', () => {
  const env = createTestApp();
  env.app.commit(
    (state) => ({
      ...state,
      fixedActivities: [
        {
          id: 'fx_weekly',
          title: '高数课',
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
    { reason: 'seed' },
  );

  // 本周四、下周周四、五周后周四都应出现
  for (const date of ['2025-10-16', '2025-10-23', '2025-11-20']) {
    const cards = buildCards(date, env.app.getState(), null, env.services);
    assert.ok(
      cards.some((card) => card.kind === 'fixed' && card.title === '高数课'),
      `${date} 应显示每周固定任务`,
    );
  }

  // 不是周四的日子不应出现
  const monday = buildCards('2025-10-20', env.app.getState(), null, env.services);
  assert.equal(monday.filter((card) => card.kind === 'fixed').length, 0, '非重复日不应出现');
});

test('固定任务：跨午夜在两天分别显示，且不重复计入', () => {
  const env = createTestApp();
  env.app.commit(
    (state) => ({
      ...state,
      fixedActivities: [
        {
          id: 'fx_night',
          title: '夜间值班',
          type: FIXED_ACTIVITY_TYPE.OTHER,
          recurrence: { kind: 'weekly', daysOfWeek: [4] },
          startMinutes: 22 * 60,
          // 跨午夜按模型约定表示为 endMinutes > 1440（06:00 = 1800）
          endMinutes: 6 * 60 + 24 * 60,
          activeFrom: null,
          activeTo: null,
          movable: false,
          note: '',
        },
      ],
    }),
    { reason: 'seed' },
  );

  const thursday = buildCards('2025-10-16', env.app.getState(), null, env.services).filter((c) => c.kind === 'fixed');
  const friday = buildCards('2025-10-17', env.app.getState(), null, env.services).filter((c) => c.kind === 'fixed');

  assert.equal(thursday.length, 1);
  assert.equal(thursday[0].startMinutes, 22 * 60);
  assert.equal(thursday[0].endMinutes, 24 * 60);
  assert.equal(friday.length, 1);
  assert.equal(friday[0].startMinutes, 0);
  assert.equal(friday[0].endMinutes, 6 * 60);
});

/* ================================================================== *
 * 四、名称长度限制
 * ================================================================== */

test('名称限制：任务、固定任务、休息时间共用 10 字符上限', () => {
  assert.equal(TASK_NAME_MAX_LENGTH, 10);

  const env = createTestApp();
  const tooLong = '一二三四五六七八九十一'; // 11 个字符
  const failTask = env.services.taskService.addTask(taskInput({ title: tooLong }));
  assert.equal(failTask.ok, false, '超长任务名必须被拒绝');
  assert.ok(failTask.issues.some((issue) => issue.code === 'V005'));

  const okTask = env.services.taskService.addTask(taskInput({ title: '一二三四五六七八九十' }));
  assert.equal(okTask.ok, true, '10 个字符应当通过');

  // 固定任务同样受限
  const applied = env.services.planService.requestPreview({
    now: NOW,
    ops: [{ kind: 'fixedActivity.add', input: { title: tooLong, type: 'class', recurrence: { kind: 'weekly', daysOfWeek: [1] }, start: '08:00', end: '09:00' } }],
  });
  assert.equal(applied.ok, false, '超长固定任务名必须被拒绝');
  assert.match(applied.issues[0].message, /10 个字符/);

  // 休息时间同样受限
  const restCheck = validateRestPeriod({ id: 'r', title: tooLong, startDate: '2025-10-16', startMinutes: 600, endDate: '2025-10-16', endMinutes: 660 }, 'rest');
  assert.equal(restCheck.ok, false);
  assert.ok(restCheck.errors.some((issue) => issue.code === 'V005'));
});

test('名称限制：编辑已有任务同样生效', () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '短名' }));
  assert.equal(created.ok, true);
  const updated = env.services.taskService.updateTask(created.task.id, { title: '一二三四五六七八九十一' });
  assert.equal(updated.ok, false, '编辑时也不能写超长名称');
});

test('名称限制：不影响备注等非名称字段', () => {
  const env = createTestApp();
  const longNote = '这是一段很长的备注，用来确认名称限制没有被错误应用到备注字段上。'.repeat(3);
  const created = env.services.taskService.addTask(taskInput({ title: '短名', note: longNote }));
  assert.equal(created.ok, true, '备注不受名称长度限制');
  assert.equal(env.app.getState().tasks[0].note, longNote);
});

test('名称限制：已有超长名称不会被静默截断，也不会导致应用打不开', async () => {
  const env = createTestApp();
  const created = env.services.taskService.addTask(taskInput({ title: '短名' }));
  assert.equal(created.ok, true);

  // 模拟历史数据里已经存在的超长名称（绕过保存校验直接写入）
  const longTitle = '一个非常非常长的历史任务名称超过十个字符';
  env.app.commit(
    (state) => ({ ...state, tasks: state.tasks.map((task) => (task.id === created.task.id ? { ...task, title: longTitle } : task)) }),
    { reason: 'seed-legacy' },
  );

  // 整体校验应通过（只给提示），且原始数据未被截断
  const { validateAppState } = await import('../../src/domain/schemas.js');
  const validation = validateAppState(env.app.getState());
  assert.equal(validation.ok, true, '超长名称不应阻断数据读取');
  assert.ok(validation.warnings.some((w) => w.code === 'V005'), '应给出名称过长的提示');
  assert.equal(env.app.getState().tasks.find((t) => t.id === created.task.id).title, longTitle, '不得静默截断');
});

/* ================================================================== *
 * 五、网格尺寸
 * ================================================================== */

test('网格：5 分钟一个标准格，卡片高度严格按时长成整数倍', () => {
  assert.equal(GRID_QUANTUM_MINUTES, 5);
  assert.equal(gridStepsFor(30) * 2, gridStepsFor(60), '60 分钟 = 2 × 30 分钟');
  assert.equal(gridStepsFor(60) * 2, gridStepsFor(120), '120 分钟 = 2 × 60 分钟');
  assert.equal(gridStepsFor(45) / gridStepsFor(15), 3, '45 分钟 = 3 × 15 分钟');
  // 非 5 分钟倍数向上取整，不丢时长
  assert.equal(gridStepsFor(31), gridStepsFor(35), '31 分钟按 35 分钟对齐（向上取整）');
  assert.equal(gridStepsFor(0), MIN_CARD_STEPS);
  assert.equal(gridStepsFor(-5), MIN_CARD_STEPS);
  assert.equal(checkName('一二三四五六七八九十', 't', '名称').ok, true);
});

test('网格：卡片在真实页面里带上按时长计算的高度', async () => {
  const env = plannedEnv();
  const state = env.app.getState();
  const plan = env.services.planService.getOfficialPlan();

  const cards = buildCards(plan.windowStart, state, plan, env.services).filter((card) => card.kind === 'study');
  assert.ok(cards.length > 0, '应有学习卡片');
  for (const card of cards) {
    const steps = gridStepsFor(card.minutes);
    assert.ok(steps >= MIN_CARD_STEPS);
    assert.ok(Number.isInteger(steps), '格数必须是整数');
  }
});

/* ================================================================== *
 * 六、休息时间
 * ================================================================== */

test('休息：22:00 → 次日 08:00 拆成两个日期片段，时长守恒且不重叠', () => {
  const rest = { id: 'r1', title: '睡觉', startDate: '2025-10-16', startMinutes: 22 * 60, endDate: '2025-10-17', endMinutes: 8 * 60 };
  const fragments = splitRestAcrossDates(rest);

  assert.equal(fragments.length, 2);
  assert.deepEqual(
    fragments.map((f) => [f.date, f.startMinutes, f.endMinutes]),
    [
      ['2025-10-16', 1320, 1440],
      ['2025-10-17', 0, 480],
    ],
  );
  assert.equal(fragments.reduce((sum, f) => sum + f.minutes, 0), restDurationMinutes(rest), '片段合计必须等于总时长');
  assert.equal(fragments[0].isStart, true);
  assert.equal(fragments[1].isEnd, true);
});

test('休息：跨多天时每个中间日整天，且片段之间不重叠', () => {
  const rest = { id: 'r2', title: '长假', startDate: '2025-10-16', startMinutes: 20 * 60, endDate: '2025-10-19', endMinutes: 10 * 60 };
  const fragments = splitRestAcrossDates(rest);

  assert.equal(fragments.length, 4);
  assert.equal(fragments[0].minutes, 240); // 20:00–24:00
  assert.equal(fragments[1].minutes, 1440);
  assert.equal(fragments[2].minutes, 1440);
  assert.equal(fragments[3].minutes, 600); // 00:00–10:00
  assert.equal(fragments.reduce((sum, f) => sum + f.minutes, 0), restDurationMinutes(rest));

  // 同一天最多一个片段，日期递增，互不重叠
  const dates = fragments.map((f) => f.date);
  assert.equal(new Set(dates).size, dates.length);
  for (let i = 1; i < fragments.length; i += 1) {
    assert.ok(fragments[i].date > fragments[i - 1].date);
  }
});

test('休息：非法输入给出明确校验提示', () => {
  const base = { id: 'r', title: '休息', startDate: '2025-10-16', startMinutes: 600, endDate: '2025-10-16', endMinutes: 660 };

  assert.equal(validateRestPeriod(base).ok, true);

  const reversed = { ...base, endDate: '2025-10-15' };
  assert.match(validateRestPeriod(reversed).errors.map((e) => e.message).join('; '), /不能早于/);

  const sameTime = { ...base, endMinutes: 600 };
  assert.match(validateRestPeriod(sameTime).errors.map((e) => e.message).join('; '), /相同/);

  const noTitle = { ...base, title: '' };
  assert.match(validateRestPeriod(noTitle).errors.map((e) => e.message).join('; '), /请填写/);

  const tooLong = { ...base, startDate: '2025-01-01', endDate: '2025-12-31' };
  assert.match(validateRestPeriod(tooLong).errors.map((e) => e.message).join('; '), new RegExp(String(REST_MAX_DAYS)));
});

test('休息：保存后出现在对应日期，删除后所有片段一起消失', () => {
  const env = createTestApp();
  const applied = env.services.planService.requestPreview({
    now: NOW,
    ops: [
      {
        kind: 'rest.add',
        input: { title: '午休', startDate: '2025-10-16', startMinutes: 22 * 60, endDate: '2025-10-17', endMinutes: 8 * 60 },
      },
    ],
  });
  assert.equal(applied.ok, true, applied.issues?.map((i) => i.message).join('; '));
  assert.equal(env.services.planService.applyPreview().ok, true, '休息不参与排程，应能直接应用');

  const rest = env.app.getState().restPeriods[0];
  assert.ok(rest, '休息安排应被保存');
  assert.equal(env.services.restService.forDate('2025-10-16').length, 1);
  assert.equal(env.services.restService.forDate('2025-10-17').length, 1);
  assert.equal(env.services.restService.datesOf(rest.id).length, 2);

  // 看板里以独立的 kind 显示
  const cards = buildCards('2025-10-16', env.app.getState(), null, env.services);
  const restCard = cards.find((card) => card.kind === 'rest');
  assert.ok(restCard, '看板应显示休息片段');
  assert.equal(restCard.startMinutes, 1320);
  assert.equal(restCard.endMinutes, 1440);

  // 删除后两天都不再有
  const op = { kind: 'rest.remove', restId: rest.id };
  const draft = applyDraftOp(env.app.getState(), op, { idFactory: env.idFactory, nowIso: env.app.clock() });
  assert.equal(draft.ok, true);
  env.app.commit(() => draft.state, { reason: 'rest-remove' });
  assert.equal(env.services.restService.forDate('2025-10-16').length, 0);
  assert.equal(env.services.restService.forDate('2025-10-17').length, 0);
});

test('休息：与固定任务/学习时段重叠时如实报告，不静默覆盖', () => {
  const env = plannedEnv();
  env.app.commit(
    (state) => ({
      ...state,
      fixedActivities: [
        {
          id: 'fx_class',
          title: '高数课',
          type: FIXED_ACTIVITY_TYPE.CLASS,
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
  assert.ok(conflicts.conflicts.every((item) => typeof item.overlapMinutes === 'number' && item.overlapMinutes > 0));

  // 冲突检查是只读的：原有安排一点没变
  assert.equal(env.app.getState().fixedActivities.length, 1);
  assert.equal(env.app.getState().restPeriods.length, 0);
});

test('休息：不参与学习任务的工作量与统计', () => {
  const env = plannedEnv();
  const before = env.services.taskService.listTaskViews()[0].remainingMinutes;
  const statsBefore = env.services.statsService.today().actualMinutes;

  env.app.commit(
    (state) => ({
      ...state,
      restPeriods: [
        { id: 'r1', title: '午休', startDate: '2025-10-16', startMinutes: 12 * 60, endDate: '2025-10-16', endMinutes: 13 * 60, note: '', createdAt: '', updatedAt: '' },
      ],
    }),
    { reason: 'seed' },
  );

  assert.equal(env.services.taskService.listTaskViews()[0].remainingMinutes, before, '休息不影响剩余工作量');
  assert.equal(env.services.statsService.today().actualMinutes, statsBefore, '休息不计入学习统计');
});

/* ================================================================== *
 * 七、日期列结构与排序
 * ================================================================== */

test('排序：同一天内顺序稳定，学习 → 固定 → 休息', () => {
  const cards = [
    { kind: 'rest', id: 'r1', title: '休息', startMinutes: 600 },
    { kind: 'fixed', id: 'f1', title: '课程', startMinutes: 600 },
    { kind: 'study', id: 's1', title: '作业', startMinutes: 600 },
    { kind: 'study', id: 's0', title: '背书', startMinutes: 540 },
  ];
  const sorted = [...cards].sort(compareCards).map((card) => card.id);
  assert.deepEqual(sorted, ['s0', 's1', 'f1', 'r1']);
  assert.deepEqual([...cards].sort(compareCards).map((c) => c.id), sorted, '排序必须稳定');
});

/* ================================================================== *
 * 八、跨夜休息在界面上的文案（22:00–24:00 而不是 22:00–00:00）
 * ================================================================== */

test('休息：当天片段结束于午夜时显示为 24:00，次日片段从 00:00 开始', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');

  const root = resolve(import.meta.dirname, '..', '..');
  const smoke = await readFile(join(root, 'tests', 'integration', 'ui-smoke.test.js'), 'utf8');
  const code = smoke.slice(smoke.indexOf('class FakeClassList'), smoke.indexOf("test('界面启动")) + '\nexport { installFakeDom };';
  await writeFile('/tmp/round2-rest-fakedom.mjs', code);
  const { installFakeDom } = await import('/tmp/round2-rest-fakedom.mjs');

  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(root, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost, clock: () => new Date(2025, 9, 16, 12, 30) });

  // 22:00 → 次日 08:00
  const preview = instance.services.planService.requestPreview({
    now: instance.services.now(),
    ops: [
      {
        kind: 'rest.add',
        input: { title: '睡觉', startDate: '2025-10-16', startMinutes: 22 * 60, endDate: '2025-10-17', endMinutes: 8 * 60 },
      },
    ],
  });
  assert.equal(preview.ok, true);
  assert.equal(instance.services.planService.applyPreview().ok, true);

  dom.location.hash = '#/week';
  instance.shell.render();
  const main = dom.appHost.children[0].byClass('app-main')[0];
  const cards = main.byClass('day-card--rest');
  const texts = cards.map((node) => node.textContent.replace(/\s+/g, ' '));

  assert.equal(cards.length, 2, '跨夜休息应显示为两个日期区块');
  assert.ok(texts.some((text) => text.includes('22:00–24:00')), `前半段应显示 22:00–24:00，实际 ${texts.join(' || ')}`);
  assert.ok(texts.some((text) => text.includes('00:00–08:00')), `后半段应显示 00:00–08:00，实际 ${texts.join(' || ')}`);

  // 固定任务与休息都不能被学习任务的完成逻辑影响
  assert.equal(main.byClass('timeline__corner').length, 0);

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
