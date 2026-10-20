/**
 * Task 领域模型测试。
 *
 * 覆盖需求中与任务直接相关的硬性规则：
 * - 不可拆分任务的最短/最长时段必须等于总时长（否则必定被拆开，违反 H5 的前提）
 * - 剩余工作量由"预计总用时 − 已完成"推导，不信任任何独立存储的剩余字段
 * - 前置任务不能自引用、不能重复、不能悬空（悬空由整体校验负责）
 * - 状态迁移受白名单约束，非法迁移返回结构化错误而不是静默忽略
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULABLE_TASK_STATUSES,
  TASK_STATUS,
  applyTaskPatch,
  canTransitionTask,
  completedMinutesForTask,
  createTask,
  createTaskDraft,
  findCyclicDependencyCandidate,
  pendingPlannedMinutesForTask,
  remainingMinutesForTask,
  sessionCompletedMinutes,
  transitionTaskStatus,
  validateTask,
} from '../../src/domain/task.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { FIXED_NOW_ISO } from '../helpers/clock.js';
import { makeSession, makeTask, testContext } from '../helpers/fixtures.js';

test('createTask 生成完整实体：默认状态、时间戳与 ID', () => {
  const ctx = testContext();
  const task = makeTask({ title: '  英语精读  ', subject: ' 英语 ' }, ctx);

  assert.match(task.id, /^tsk_/);
  assert.equal(task.title, '英语精读', '名称应去除首尾空格');
  assert.equal(task.subject, '英语');
  assert.equal(task.status, TASK_STATUS.NOT_STARTED);
  assert.equal(task.createdAt, FIXED_NOW_ISO);
  assert.equal(task.updatedAt, FIXED_NOW_ISO);
  assert.equal(task.startedAt, null);
  assert.equal(task.completedAt, null);
  assert.deepEqual(task.dependsOn, []);
});

test('createTaskDraft 的数值默认值本身合法（用户只需要填名称、科目与截止日期）', () => {
  const draft = createTaskDraft();
  const task = createTask({ ...draft, title: '示例任务', subject: '示例科目', deadlineDate: '2025-10-20' }, testContext());
  const validation = validateTask(task);
  assert.equal(
    validation.ok,
    true,
    `草稿默认值应当合法，实际错误：${validation.errors.map((i) => `${i.code} ${i.path}`).join('; ')}`,
  );
  assert.equal(draft.plannedMinutes % 5, 0, '默认时长应是 5 的倍数，便于整齐拆分');
  // 最短/最长学习时段现在是**可选**字段，草稿默认留空（由排程器按系统默认值决定）
  assert.equal(draft.minChunkMinutes, null, '最短学习时段默认留空');
  assert.equal(draft.maxChunkMinutes, null, '最长学习时段默认留空');
  assert.equal(draft.plannedStartMinutes, null, '计划开始时间默认留空');
});

test('validateTask：必填字段、评分范围、状态枚举都会产生结构化错误', () => {
  const base = makeTask();

  const missingTitle = validateTask({ ...base, title: '   ' });
  assert.equal(missingTitle.ok, false);
  assert.ok(missingTitle.errors.some((i) => i.code === VALIDATION_CODES.REQUIRED && i.path.endsWith('.title')));

  const badImportance = validateTask({ ...base, importance: 9 });
  assert.equal(badImportance.ok, false);
  assert.ok(badImportance.errors.some((i) => i.code === VALIDATION_CODES.RANGE && i.path.endsWith('.importance')));

  const badStatus = validateTask({ ...base, status: 'doing' });
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.errors.some((i) => i.code === VALIDATION_CODES.ENUM && i.path.endsWith('.status')));

  const zeroMinutes = validateTask({ ...base, plannedMinutes: 0 });
  assert.equal(zeroMinutes.ok, false);
  assert.ok(zeroMinutes.errors.some((i) => i.path.endsWith('.plannedMinutes')));
});

test('validateTask：可拆分任务的 min/max 必须合法且 min ≤ max', () => {
  const base = makeTask();
  const inverted = validateTask({ ...base, minChunkMinutes: 90, maxChunkMinutes: 30 });
  assert.equal(inverted.ok, false);
  assert.ok(inverted.errors.some((i) => i.code === VALIDATION_CODES.TASK_MIN_MAX_CHUNK));

  const valid = validateTask({ ...base, minChunkMinutes: 30, maxChunkMinutes: 30 });
  assert.equal(valid.ok, true, 'min == max 是合法的（等长切片）');
});

test('validateTask：不可拆分任务的时长字段必须等于总时长（V011）', () => {
  const atomic = makeTask({ splittable: false, plannedMinutes: 120, minChunkMinutes: 120, maxChunkMinutes: 120 });
  assert.equal(validateTask(atomic).ok, true);

  const wrong = validateTask({ ...atomic, minChunkMinutes: 30, maxChunkMinutes: 60 });
  assert.equal(wrong.ok, false);
  const issue = wrong.errors.find((i) => i.code === VALIDATION_CODES.TASK_ATOMIC_MISMATCH);
  assert.ok(issue);
  assert.equal(issue.details.plannedMinutes, 120);
});

test('validateTask：依赖列表不能自引用、不能重复（V012 / V050）', () => {
  const base = makeTask();
  const selfRef = validateTask({ ...base, dependsOn: [base.id] });
  assert.equal(selfRef.ok, false);
  assert.ok(selfRef.errors.some((i) => i.code === VALIDATION_CODES.TASK_DEPENDENCY_SELF));

  const duplicated = validateTask({ ...base, dependsOn: ['tsk_a', 'tsk_a'] });
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.errors.some((i) => i.code === VALIDATION_CODES.ENTITY_DUPLICATE_ID));
});

test('剩余工作量推导：已完成时段按实际时长计入，未完成时段不计入', () => {
  const ctx = testContext();
  const task = makeTask({ plannedMinutes: 120 }, ctx);
  const sessions = [
    makeSession({ taskId: task.id, plannedMinutes: 45, startMinutes: 960, endMinutes: 1005, state: 'flexible' }, ctx),
    makeSession({ taskId: task.id, startMinutes: 1080, endMinutes: 1125, state: 'completed', actualMinutes: 30 }, ctx),
  ];

  assert.equal(completedMinutesForTask(task.id, sessions), 30, '已完成按实际时长（30）而不是计划时长（45）计算');
  assert.equal(remainingMinutesForTask(task, sessions), 90);
  assert.equal(pendingPlannedMinutesForTask(task.id, sessions), 45);
});

test('剩余工作量：已取消/已完成的返回 0，且不会出现负数', () => {
  const ctx = testContext();
  const task = makeTask({ plannedMinutes: 60 }, ctx);
  const overCompleted = makeSession({ taskId: task.id, plannedMinutes: 90, state: 'completed', actualMinutes: 90 }, ctx);

  assert.equal(remainingMinutesForTask({ ...task, status: TASK_STATUS.COMPLETED }, [overCompleted]), 0);
  assert.equal(remainingMinutesForTask({ ...task, status: TASK_STATUS.CANCELLED }, []), 0);
  assert.equal(remainingMinutesForTask({ ...task, status: TASK_STATUS.DELETED }, []), 0);
  assert.equal(remainingMinutesForTask(task, [overCompleted]), 0, '超额完成时剩余量被夹到 0，不产生负数');
});

test('sessionCompletedMinutes：优先实际时长，缺省退回计划时长', () => {
  assert.equal(sessionCompletedMinutes({ state: 'completed', plannedMinutes: 45, actualMinutes: 30 }), 30);
  assert.equal(sessionCompletedMinutes({ state: 'completed', plannedMinutes: 45, actualMinutes: null }), 45);
  assert.equal(sessionCompletedMinutes(null), 0);
});

test('状态迁移白名单：合法路径通过，非法路径返回结构化错误且不修改原对象', () => {
  const ctx = testContext();
  const task = makeTask({}, ctx);

  assert.equal(canTransitionTask(TASK_STATUS.NOT_STARTED, TASK_STATUS.IN_PROGRESS), true);
  assert.equal(canTransitionTask(TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED), false);

  const started = transitionTaskStatus(task, TASK_STATUS.IN_PROGRESS, { nowIso: FIXED_NOW_ISO });
  assert.equal(started.issue, null);
  assert.equal(started.task.status, TASK_STATUS.IN_PROGRESS);
  assert.equal(started.task.startedAt, FIXED_NOW_ISO);
  assert.equal(task.status, TASK_STATUS.NOT_STARTED, '原对象保持不变（纯函数）');

  // NOT_STARTED → DELETED 是允许的（软删除）；这里用 COMPLETED → CANCELLED 这种真正非法的迁移
  const completed = transitionTaskStatus(task, TASK_STATUS.COMPLETED, { nowIso: FIXED_NOW_ISO }).task;
  const illegal = transitionTaskStatus(completed, TASK_STATUS.CANCELLED, { nowIso: FIXED_NOW_ISO });
  assert.equal(illegal.issue.code, VALIDATION_CODES.ENUM);
  assert.equal(illegal.task, completed, '非法迁移必须返回原对象，绝不产生半更新状态');

  // 软删除是允许的（保留历史），因此不应产生错误
  const softDeleted = transitionTaskStatus(task, TASK_STATUS.DELETED, { nowIso: FIXED_NOW_ISO });
  assert.equal(softDeleted.issue, null);
  assert.equal(softDeleted.task.deletedAt, FIXED_NOW_ISO);
});

test('撤销完成：completed → in_progress 时清空 completedAt', () => {
  const task = makeTask();
  const completed = transitionTaskStatus(task, TASK_STATUS.COMPLETED, { nowIso: FIXED_NOW_ISO }).task;
  assert.equal(completed.completedAt, FIXED_NOW_ISO);
  const reopened = transitionTaskStatus(completed, TASK_STATUS.IN_PROGRESS, { nowIso: FIXED_NOW_ISO });
  assert.equal(reopened.issue, null);
  assert.equal(reopened.task.completedAt, null);
});

test('applyTaskPatch：白名单过滤 + 不可拆分时自动对齐时长字段', () => {
  const task = makeTask({ plannedMinutes: 90, splittable: true, minChunkMinutes: 30, maxChunkMinutes: 60 });

  const patched = applyTaskPatch(task, { plannedMinutes: 120, splittable: false, id: 'hacked', status: 'completed' }, { nowIso: FIXED_NOW_ISO });
  assert.equal(patched.id, task.id, 'id 不在白名单内，不能被修改');
  assert.equal(patched.status, task.status, 'status 必须通过状态迁移修改，不能被 patch 直接改');
  assert.equal(patched.plannedMinutes, 120);
  assert.equal(patched.minChunkMinutes, 120, '不可拆分时最短时段自动对齐为总时长');
  assert.equal(patched.maxChunkMinutes, 120);
  assert.equal(patched.updatedAt, FIXED_NOW_ISO);
  assert.equal(task.plannedMinutes, 90, '原对象不被修改');
});

test('applyTaskPatch：min > max 时把 max 抬高到 min，交给校验器给出提示', () => {
  const task = makeTask({ minChunkMinutes: 30, maxChunkMinutes: 60 });
  const patched = applyTaskPatch(task, { minChunkMinutes: 90 }, { nowIso: FIXED_NOW_ISO });
  assert.equal(patched.maxChunkMinutes, 90);
});

test('applyTaskPatch：依赖列表去重', () => {
  const task = makeTask();
  const patched = applyTaskPatch(task, { dependsOn: ['tsk_a', 'tsk_a', 'tsk_b'] }, { nowIso: FIXED_NOW_ISO });
  assert.deepEqual(patched.dependsOn, ['tsk_a', 'tsk_b']);
});

test('可排程状态集合只包含未开始与进行中', () => {
  assert.deepEqual([...SCHEDULABLE_TASK_STATUSES], [TASK_STATUS.NOT_STARTED, TASK_STATUS.IN_PROGRESS]);
});

test('findCyclicDependencyCandidate：能识别会形成环的前置任务候选', () => {
  const ctx = testContext();
  const a = makeTask({ title: 'A' }, ctx);
  const b = makeTask({ title: 'B', dependsOn: [a.id] }, ctx);
  const c = makeTask({ title: 'C', dependsOn: [b.id] }, ctx);

  assert.equal(findCyclicDependencyCandidate(a.id, c.id, [a, b, c]), true, 'A 依赖 C 会形成 A→C→B→A 的环');
  assert.equal(findCyclicDependencyCandidate(c.id, a.id, [a, b, c]), false, 'C 依赖 A 是合法方向');
  assert.equal(findCyclicDependencyCandidate(c.id, 'tsk_missing', [a, b, c]), false, '悬空引用不属于环，由校验器单独报错');
});
