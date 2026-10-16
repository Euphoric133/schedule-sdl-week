/**
 * 数据校验（schemas）测试。
 *
 * validateAppState 是所有数据入口（加载、导入、应用预览前）的最后一道关卡。
 * 它必须能明确区分"结构/引用错误"（阻断）与"仅提示"（可继续），
 * 否则界面就无法如实告诉用户"这份数据为什么不能用"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_WEIGHTS,
  PLAN_HISTORY_LIMIT,
  createEmptyState,
  defaultSettings,
  summarizeState,
  validateAppState,
  validateSettings,
  weekdayLabel,
} from '../../src/domain/schemas.js';
import { TASK_STATUS } from '../../src/domain/task.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { FIXED_NOW_ISO } from '../helpers/clock.js';
import { makeSession, makeState, makeTask, testContext } from '../helpers/fixtures.js';

test('defaultSettings：默认值本身必须通过自身校验（否则新用户一进来就被拦）', () => {
  const settings = defaultSettings();
  const validation = validateSettings(settings);
  assert.equal(validation.ok, true, validation.errors.map((i) => `${i.code} ${i.path}`).join('; '));
  assert.deepEqual(settings.weights, DEFAULT_WEIGHTS);
  assert.equal(settings.bufferRatio, 0.1);
  assert.equal(settings.planHistoryLimit, PLAN_HISTORY_LIMIT);
  assert.equal(settings.dayBoundaryHour, 4);
});

test('validateSettings：空闲的星期配置会给出提示（不是错误，但用户必须知道）', () => {
  const settings = defaultSettings();
  for (const day of [1, 2, 3, 4, 5, 6, 7]) settings.studyWindows[day] = [];
  const validation = validateSettings(settings);
  assert.equal(validation.ok, true, '没有学习窗口本身不是"非法数据"，而是"排不出计划"');
  assert.ok(validation.warnings.some((i) => i.code === VALIDATION_CODES.SETTINGS_NO_WINDOW));
});

test('validateSettings：缺少某一天的配置是错误（避免出现"某天被静默忽略"）', () => {
  const settings = defaultSettings();
  delete settings.studyWindows[3];
  const validation = validateSettings(settings);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.SETTINGS_NO_WINDOW && i.path.endsWith('.3')));
});

test('validateSettings：缓冲比例、权重、休息规则、时长规则的边界', () => {
  const bad = defaultSettings();
  bad.bufferRatio = 0.9;
  assert.equal(validateSettings(bad).ok, false);

  const negativeWeight = defaultSettings();
  negativeWeight.weights.difficulty = -1;
  assert.equal(validateSettings(negativeWeight).ok, false);

  const zeroWeights = defaultSettings();
  zeroWeights.weights = { deadlineUrgency: 0, difficulty: 0, importance: 0, procrastination: 0 };
  const sumIssue = validateSettings(zeroWeights);
  assert.equal(sumIssue.ok, false);
  assert.ok(sumIssue.errors.some((i) => i.code === VALIDATION_CODES.SETTINGS_WEIGHTS));

  const notNormalized = defaultSettings();
  notNormalized.weights = { deadlineUrgency: 1, difficulty: 1, importance: 1, procrastination: 1 };
  const normalizedIssue = validateSettings(notNormalized);
  assert.equal(normalizedIssue.ok, true, '权重和不为 1 只是提示（会自动归一化），不阻断');
  assert.ok(normalizedIssue.warnings.some((i) => i.code === VALIDATION_CODES.SETTINGS_WEIGHTS));

  const badRest = defaultSettings();
  badRest.restRule.restMinutes = 999;
  assert.equal(validateSettings(badRest).ok, false);

  const badChunks = defaultSettings();
  badChunks.defaultMinChunkMinutes = 90;
  badChunks.defaultMaxChunkMinutes = 30;
  assert.equal(validateSettings(badChunks).ok, false);

  const badBoundary = defaultSettings();
  badBoundary.dayBoundaryHour = 20;
  assert.equal(validateSettings(badBoundary).ok, false);
});

test('createEmptyState：全新状态是合法且完全空白的（没有任何虚构任务）', () => {
  const state = createEmptyState({ nowIso: FIXED_NOW_ISO, windowStart: '2025-10-16' });
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.fixedActivities, []);
  assert.deepEqual(state.planHistory, []);
  assert.equal(state.officialPlan, null);
  assert.equal(state.pendingPreview, null);
  assert.equal(validateAppState(state).ok, true);
});

test('validateAppState：拒绝比当前程序更新的数据结构（避免损坏数据）', () => {
  const state = { ...makeState(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  const validation = validateAppState(state);
  assert.equal(validation.ok, false);
  const issue = validation.errors.find((i) => i.code === VALIDATION_CODES.SCHEMA_VERSION_UNSUPPORTED);
  assert.ok(issue);
  assert.match(issue.message, /更新的版本/);
});

test('validateAppState：缺容器、缺设置、类型错误都会被指出', () => {
  assert.equal(validateAppState(null).ok, false);
  assert.equal(validateAppState({ ...makeState(), tasks: 'nope' }).ok, false);
  assert.equal(validateAppState({ ...makeState(), settings: null }).ok, false);
  assert.equal(validateAppState({ ...makeState(), schemaVersion: 0 }).ok, false);
});

test('validateAppState：重复 ID 被拒绝（否则时段会挂到错误的任务上）', () => {
  const ctx = testContext();
  const a = makeTask({ title: '任务 A' }, ctx);
  const b = { ...makeTask({ title: '任务 B' }, ctx), id: a.id };
  const validation = validateAppState({ ...makeState(), tasks: [a, b] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.ENTITY_DUPLICATE_ID));
});

test('validateAppState：悬空引用的任务与时段都会被指出', () => {
  const task = makeTask();
  const session = makeSession({ taskId: 'tsk_ghost' });
  const validation = validateAppState({ ...makeState(), tasks: [task], sessions: [session] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.ENTITY_DANGLING_REF && i.path.startsWith('sessions[')));
});

test('validateAppState：循环依赖被拒绝', () => {
  const ctx = testContext();
  const a = makeTask({ title: 'A' }, ctx);
  const b = makeTask({ title: 'B' }, ctx);
  const cyclicA = { ...a, dependsOn: [b.id] };
  const cyclicB = { ...b, dependsOn: [a.id] };
  const validation = validateAppState({ ...makeState(), tasks: [cyclicA, cyclicB] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.TASK_DEPENDENCY_CYCLE));
});

test('validateAppState：已完成时长超过预计总用时被拒绝（V015）', () => {
  const ctx = testContext();
  const task = makeTask({ plannedMinutes: 60 }, ctx);
  const session = makeSession({ taskId: task.id, startMinutes: 960, endMinutes: 1050, state: 'completed', actualMinutes: 90 }, ctx);
  const validation = validateAppState({ ...makeState(), tasks: [task], sessions: [session] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.TASK_OVER_COMPLETED));
});

test('validateAppState：未完成时段超过剩余工作量被拒绝（V016，防止重复安排已完成的工作）', () => {
  const ctx = testContext();
  const task = makeTask({ plannedMinutes: 60 }, ctx);
  const done = makeSession({ taskId: task.id, startMinutes: 960, endMinutes: 1020, state: 'completed', actualMinutes: 60 }, ctx);
  const pending = makeSession({ taskId: task.id, startMinutes: 1080, endMinutes: 1140, state: 'flexible' }, ctx);
  const validation = validateAppState({ ...makeState(), tasks: [task], sessions: [done, pending] });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((i) => i.code === VALIDATION_CODES.TASK_DURATION_INCONSISTENT));
});

test('validateAppState：已删除任务不参与时长一致性检查（历史记录可以保留）', () => {
  const ctx = testContext();
  const task = { ...makeTask({ plannedMinutes: 60 }, ctx), status: TASK_STATUS.DELETED, deletedAt: FIXED_NOW_ISO };
  const session = makeSession({ taskId: task.id, startMinutes: 960, endMinutes: 1050, state: 'flexible' }, ctx);
  const validation = validateAppState({ ...makeState(), tasks: [task], sessions: [session] });
  assert.equal(validation.ok, true, '已删除任务的历史时段不应导致数据被判定为损坏');
});

test('summarizeState：汇总口径正确，供顶栏与导入预览使用', () => {
  const ctx = testContext();
  const active = makeTask({ title: '进行中' }, ctx);
  const done = { ...makeTask({ title: '已完成' }, ctx), status: TASK_STATUS.COMPLETED };
  const deleted = { ...makeTask({ title: '已删除' }, ctx), status: TASK_STATUS.DELETED };
  const sessions = [
    makeSession({ taskId: active.id, state: 'completed', startMinutes: 960, endMinutes: 1020, actualMinutes: 60 }, ctx),
    makeSession({ taskId: active.id, state: 'flexible', startMinutes: 1080, endMinutes: 1140, locked: true }, ctx),
  ];
  const summary = summarizeState({ ...makeState(), tasks: [active, done, deleted], sessions });

  assert.equal(summary.taskCount, 2, '已删除任务不计入任务数');
  assert.equal(summary.activeTaskCount, 1);
  assert.equal(summary.completedTaskCount, 1);
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.completedSessionCount, 1);
  assert.equal(summary.lockedSessionCount, 1);
  assert.equal(summary.planVersion, 0);
  assert.equal(summary.hasPreview, false);
});

test('weekdayLabel 是界面文案的唯一定义处', () => {
  assert.equal(weekdayLabel('2025-10-16'), '周四');
  assert.equal(weekdayLabel('2025-10-19'), '周日');
  assert.equal(weekdayLabel('2025-10-20'), '周一');
});
