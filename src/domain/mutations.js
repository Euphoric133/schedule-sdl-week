/**
 * 纯状态变更函数（draft mutations）。
 *
 * 为什么需要单独一层：
 * "修改数据"不会立即写入，而是先变成一份**草稿**去生成候选计划，
 * 只有用户确认后才真正落盘。因此同一套变更逻辑需要被用在两条路径上：
 *
 *   1. 服务层直接写入（taskService.addTask 等）
 *   2. 构造草稿状态 → 交给排程引擎预览（planService.requestPreview）
 *
 * 如果两条路径各写一遍变更逻辑，迟早会出现"预览看到的"与"确认后写入的"不一致。
 * 因此这里把变更抽成**纯函数**：输入状态 + 参数 → 输出新状态或结构化错误，
 * 不访问存储、不读时钟、不产生 ID（ID 由调用方注入）。
 */

import {
  TASK_STATUS,
  applyTaskPatch,
  createTask,
  transitionTaskStatus,
  validateTask,
} from '../domain/task.js';
import { SESSION_STATE } from '../domain/session.js';
import {
  FIXED_ACTIVITY_TYPE,
  RECURRENCE_KIND,
  createFixedActivity,
  validateFixedActivity,
} from '../domain/fixedActivity.js';
import { checkTaskDependencies } from '../domain/graph.js';
import { reconcileTaskSessions } from './reconcile.js';
import { defaultSettings, validateSettings } from '../domain/schemas.js';
import { createRestPeriod, validateRestPeriod } from './restPeriod.js';
import { createSubject, isSameSubjectName, normalizeSubjectName, validateSubjectName } from './subject.js';
import { VALIDATION_CODES as C, error, mergeResults, result } from '../domain/validation.js';

/**
 * 应用一次状态变更。返回 `{ ok, state, issues }`；失败时 `state` 为原始状态（不做任何修改）。
 *
 * @param {object} state 当前状态
 * @param {object} op 变更描述
 * @param {object} ctx { idFactory, nowIso }
 */
export function applyDraftOp(state, op, ctx) {
  switch (op.kind) {
    case 'task.add':
      return addTaskOp(state, op, ctx);
    case 'task.update':
      return updateTaskOp(state, op, ctx);
    case 'task.status':
      return taskStatusOp(state, op, ctx);
    case 'task.delete':
      return deleteTaskOp(state, op, ctx);
    case 'task.purge':
      return purgeTaskOp(state, op, ctx);
    case 'session.lock':
      return sessionLockOp(state, op, ctx);
    case 'session.move':
      return sessionMoveOp(state, op, ctx);
    case 'session.cancel':
      return sessionCancelOp(state, op, ctx);
    case 'session.complete':
      return sessionCompleteOp(state, op, ctx);
    case 'session.pause':
      return sessionPauseOp(state, op, ctx);
    case 'session.extend':
      return sessionExtendOp(state, op, ctx);
    case 'session.delete':
      return sessionDeleteOp(state, op);
    case 'cleanup.cancelledSessions':
      return cleanupCancelledSessionsOp(state, op);
    case 'cleanup.planHistory':
      return cleanupPlanHistoryOp(state, op);
    case 'fixedActivity.add':
      return fixedActivityAddOp(state, op, ctx);
    case 'fixedActivity.update':
      return fixedActivityUpdateOp(state, op, ctx);
    case 'fixedActivity.remove':
      return removeOp(state, op, ctx, 'fixedActivities', '固定活动');
    case 'subject.ensure':
      return subjectEnsureOp(state, op, ctx);
    case 'subject.rename':
      return subjectRenameOp(state, op, ctx);
    case 'subject.remove':
      return subjectRemoveOp(state, op);
    case 'rest.add':
      return restAddOp(state, op, ctx);
    case 'rest.update':
      return restUpdateOp(state, op, ctx);
    case 'rest.remove':
      return restRemoveOp(state, op);
    case 'settings.update':
      return settingsUpdateOp(state, op);
    case 'window.shift':
      return windowShiftOp(state, op, ctx);
    default:
      return {
        ok: false,
        state,
        issues: [error(C.ENUM, 'op.kind', `未知的变更类型：${JSON.stringify(op.kind)}。`, { kind: op.kind })],
      };
  }
}

/**
 * 依次应用多个变更（任一失败即整体放弃，保证草稿不会处于半应用状态）。
 *
 * 除了新状态，还会汇总每个操作返回的统计字段（`removedCount` / `removedMinutes` / `createdId`），
 * 这样服务层才能向用户报告"这次清理删掉了多少条"。
 */
export function applyDraftOps(state, ops, ctx) {
  let current = state;
  const issues = [];
  const summary = { removedCount: 0, removedMinutes: 0, createdIds: [] };

  for (const op of ops ?? []) {
    const applied = applyDraftOp(current, op, ctx);
    if (!applied.ok) return { ok: false, state, issues: applied.issues ?? issues };
    current = applied.state;
    issues.push(...(applied.issues ?? []));
    if (Number.isInteger(applied.removedCount)) summary.removedCount += applied.removedCount;
    if (Number.isInteger(applied.removedMinutes)) summary.removedMinutes += applied.removedMinutes;
    if (applied.createdId) summary.createdIds.push(applied.createdId);
  }

  return { ok: true, state: current, issues, ...summary };
}

/** 人类可读的变更摘要（写入版本历史与预览标题） */
export function describeDraftOps(ops) {
  const list = ops ?? [];
  if (list.length === 0) return '重新规划';
  const parts = [];
  for (const op of list) {
    switch (op.kind) {
      case 'task.add':
        parts.push(`新增任务「${op.input?.title ?? ''}」`);
        break;
      case 'task.update':
        parts.push(`修改任务`);
        break;
      case 'task.status':
        parts.push(op.to === TASK_STATUS.COMPLETED ? '完成任务' : op.to === TASK_STATUS.CANCELLED ? '取消任务' : '调整任务状态');
        break;
      case 'task.delete':
        parts.push('删除任务');
        break;
      case 'task.purge':
        parts.push('彻底删除任务历史');
        break;
      case 'session.lock':
        parts.push(op.locked ? '锁定时段' : '解锁时段');
        break;
      case 'session.move':
        parts.push('移动时段');
        break;
      case 'session.cancel':
        parts.push('取消时段');
        break;
      case 'session.complete':
        parts.push('记录已完成时段');
        break;
      case 'session.pause':
        parts.push(op.paused ? '暂停计时' : '继续计时');
        break;
      case 'session.extend':
        parts.push('延长当前时段');
        break;
      case 'session.delete':
        parts.push('清理历史时段记录');
        break;
      case 'cleanup.cancelledSessions':
        parts.push('清理已取消的时段记录');
        break;
      case 'cleanup.planHistory':
        parts.push('清理历史版本快照');
        break;
      case 'fixedActivity.add':
        parts.push(`新增固定活动「${op.input?.title ?? ''}」`);
        break;
      case 'fixedActivity.update':
        parts.push('修改固定活动');
        break;
      case 'fixedActivity.remove':
        parts.push('删除固定活动');
        break;
      case 'subject.ensure':
        parts.push(`新增科目「${op.name ?? ''}」`);
        break;
      case 'subject.rename':
        parts.push('重命名科目');
        break;
      case 'subject.remove':
        parts.push('删除科目');
        break;
      case 'rest.add':
        parts.push(`新增休息时间「${op.input?.title ?? ''}」`);
        break;
      case 'rest.update':
        parts.push('修改休息时间');
        break;
      case 'rest.remove':
        parts.push('删除休息时间');
        break;
      case 'settings.update':
        parts.push('修改偏好设置');
        break;
      case 'window.shift':
        parts.push(`把计划窗口移动到 ${op.windowStart}`);
        break;
      default:
        parts.push('调整');
    }
  }
  return parts.join('、');
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

function addTaskOp(state, op, ctx) {
  const input = op.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, state, issues: [error(C.TYPE, 'task', '任务数据必须是一个对象。')] };
  }
  const task = createTask(input, { idFactory: ctx.idFactory, nowIso: ctx.nowIso });
  const validation = validateTask(task, 'task');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };

  const dependencyIssues = checkTaskDependencies([...state.tasks, task]);
  if (dependencyIssues.length > 0) return { ok: false, state, issues: dependencyIssues };

  return { ok: true, state: { ...state, tasks: [...state.tasks, task] }, issues: [], createdId: task.id };
}

function updateTaskOp(state, op, ctx) {
  const task = (state.tasks ?? []).find((item) => item.id === op.taskId);
  if (!task) return { ok: false, state, issues: [error(C.REQUIRED, 'task', '要修改的任务不存在。', { taskId: op.taskId })] };
  if (op.patch === null || typeof op.patch !== 'object') {
    return { ok: false, state, issues: [error(C.TYPE, 'patch', '修改内容必须是一个对象。')] };
  }

  const next = applyTaskPatch(task, op.patch, { nowIso: ctx.nowIso });
  const validation = validateTask(next, 'task');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };

  const dependencyIssues = checkTaskDependencies(state.tasks.map((item) => (item.id === next.id ? next : item)));
  if (dependencyIssues.length > 0) return { ok: false, state, issues: dependencyIssues };

  /**
   * 编辑任务同样要同步时段。
   *
   * 典型场景：把"预计总用时"从 120 分钟改成 60 分钟（或把"已经完成"填成 30 分钟），
   * 剩余工作量变小了，但已经排好的 120 分钟时段还在——
   * 这就是用户看到的"未完成时段合计 120 分钟，但剩余工作量只有 60 分钟"。
   */
  const withTask = {
    ...state,
    tasks: state.tasks.map((item) => {
      if (item.id === next.id) return next;
      /**
       * 任务完成后再也不需要"等它"，因此把它从别人的 dependsOn 里移除。
       * 只清引用，不删任务、不删历史；与状态变更在同一个事务里完成，
       * 一旦整体校验失败就整体不生效。
       */
      if (op.to === TASK_STATUS.COMPLETED && Array.isArray(item.dependsOn) && item.dependsOn.includes(next.id)) {
        return { ...item, dependsOn: item.dependsOn.filter((id) => id !== next.id) };
      }
      return item;
    }),
  };
  const reconciled = reconcileTaskSessions(withTask, next.id, { nowIso: ctx.nowIso });

  return { ok: true, state: reconciled.state, issues: [], repairs: reconciled.repairs };
}

function taskStatusOp(state, op, ctx) {
  const task = (state.tasks ?? []).find((item) => item.id === op.taskId);
  if (!task) return { ok: false, state, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: op.taskId })] };

  const { task: next, issue } = transitionTaskStatus(task, op.to, { nowIso: ctx.nowIso });
  if (issue) return { ok: false, state, issues: [issue] };

  /**
   * 状态迁移必须**同时**处理关联的未完成时段。
   *
   * 这是本项目最严重缺陷的根因：以前只把任务状态改成 completed，
   * 但没有取消它已经排好的时段，于是出现"已完成，却还有 120 分钟未完成时段"，
   * 导致整体校验失败、任务删不掉、严重时下次打开应用数据读不出来。
   *
   * 现在的做法：先写入新状态，再由 reconcile 统一把时段对齐到新的剩余工作量
   * （完成任务时剩余工作量为 0，因此它的未完成时段会被全部取消；已完成记录保留）。
   */
  const withTask = {
    ...state,
    tasks: state.tasks.map((item) => {
      if (item.id === next.id) return next;
      /**
       * 任务完成后再也不需要"等它"，因此把它从别人的 dependsOn 里移除。
       * 只清引用，不删任务、不删历史；与状态变更在同一个事务里完成，
       * 一旦整体校验失败就整体不生效。
       */
      if (op.to === TASK_STATUS.COMPLETED && Array.isArray(item.dependsOn) && item.dependsOn.includes(next.id)) {
        return { ...item, dependsOn: item.dependsOn.filter((id) => id !== next.id) };
      }
      return item;
    }),
  };
  const reconciled = reconcileTaskSessions(withTask, next.id, { nowIso: ctx.nowIso });

  return {
    ok: true,
    state: reconciled.state,
    issues: [],
    repairs: reconciled.repairs,
  };
}

function deleteTaskOp(state, op, ctx) {
  const task = (state.tasks ?? []).find((item) => item.id === op.taskId);
  if (!task) return { ok: false, state, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: op.taskId })] };
  const hasHistory = (state.sessions ?? []).some((session) => session.taskId === op.taskId);

  if (!hasHistory && op.hard) {
    return { ok: true, state: { ...state, tasks: state.tasks.filter((item) => item.id !== op.taskId) }, issues: [] };
  }
  // 有历史记录 → 软删除（保留记录，可恢复）
  return taskStatusOp(state, { kind: 'task.status', taskId: op.taskId, to: TASK_STATUS.DELETED }, ctx);
}

/**
 * 彻底删除一个任务：从持久化数据里真正移除它，并清掉不再需要的关联数据。
 *
 * 与 `task.delete`（软删除）的区别：
 * - `task.delete`：把状态改成 deleted，记录保留在"已删除历史"里，可以恢复；
 * - `task.purge`：任务本身从 `tasks` 里消失，**它的学习时段也一并移除**，
 *   正式计划里引用它的块会被删掉，其它任务对它的依赖会被解除。
 *
 * 为什么要一起清掉这些：
 * 1. 只删任务会留下"引用了不存在任务的时段"（V052），下次打开会报警告甚至拒绝读取；
 * 2. `dependsOn` 里留着已删除任务的 ID 会让依赖校验（V013）失败，导致整个应用无法保存；
 * 3. 正式计划里残留它自己的块，会让时间表/看板继续显示一个已经不存在的任务。
 *
 * 不动的东西：其它任何任务、固定日程、休息安排、已完成的其他任务记录、设置。
 */
function purgeTaskOp(state, op, ctx) {
  const task = (state.tasks ?? []).find((item) => item.id === op.taskId);
  if (!task) return { ok: false, state, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: op.taskId })] };

  const ownSessions = (state.sessions ?? []).filter((session) => session.taskId === op.taskId);
  const ownSessionIds = new Set(ownSessions.map((session) => session.id));

  // 1) 移除任务本身
  const tasks = (state.tasks ?? []).filter((item) => item.id !== op.taskId);
  // 2) 顺带解除其它任务对它的依赖（否则会留下无法满足的依赖）
  const cleanedTasks = tasks.map((item) => {
    if (!Array.isArray(item.dependsOn) || item.dependsOn.length === 0) return item;
    if (!item.dependsOn.includes(op.taskId)) return item;
    return { ...item, dependsOn: item.dependsOn.filter((id) => id !== op.taskId), updatedAt: ctx.nowIso };
  });

  // 3) 移除它的全部学习时段（含已完成：用户明确要求彻底删除）
  const sessions = (state.sessions ?? []).filter((session) => session.taskId !== op.taskId);

  // 4) 正式计划里移除引用这些时段/任务的块，避免时间表继续显示已删除内容
  const stripPlan = (plan) => {
    if (!plan || !Array.isArray(plan.blocks)) return plan;
    const blocks = plan.blocks.filter(
      (block) =>
        !(block.kind === 'study' && block.taskId === op.taskId) &&
        !(block.refId && ownSessionIds.has(block.refId)),
    );
    if (blocks.length === plan.blocks.length) return plan;
    return { ...plan, blocks };
  };

  return {
    ok: true,
    state: {
      ...state,
      tasks: cleanedTasks,
      sessions,
      officialPlan: stripPlan(state.officialPlan),
      // 候选计划基于旧数据生成，已经失效：直接丢弃，避免"应用后引用不存在的任务"
      pendingPreview: null,
    },
    issues: [],
    purged: {
      taskId: op.taskId,
      removedSessions: ownSessions.length,
      removedDependencies: (state.tasks ?? []).filter(
        (item) => item.id !== op.taskId && Array.isArray(item.dependsOn) && item.dependsOn.includes(op.taskId),
      ).length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 学习时段
 * ------------------------------------------------------------------ */

function sessionLockOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.COMPLETED) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.locked', '已完成的时段无需锁定。', {})] };
  }
  if (!op.locked && session.state !== SESSION_STATE.FLEXIBLE) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.locked', '只有未开始的时段才能解除锁定。', { state: session.state })] };
  }
  return {
    ok: true,
    state: {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === op.sessionId
          ? { ...item, locked: Boolean(op.locked), lockedAt: op.locked ? ctx.nowIso : null, updatedAt: ctx.nowIso }
          : item,
      ),
    },
    issues: [],
  };
}

function sessionMoveOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.COMPLETED) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.state', '已完成的学习时段不能被移动。', {})] };
  }
  if (session.locked && !op.force) {
    return {
      ok: false,
      state,
      issues: [error(C.ENUM, 'session.locked', '该时段已锁定，请先解除锁定再移动（锁定是硬约束）。', { sessionId: op.sessionId })],
    };
  }

  const next = {
    ...session,
    date: op.date ?? session.date,
    startMinutes: op.startMinutes,
    endMinutes: op.endMinutes,
    plannedMinutes: op.endMinutes - op.startMinutes,
    locked: op.lock === true ? true : op.lock === false ? false : session.locked,
    source: 'user_move',
    updatedAt: ctx.nowIso,
    history: [
      ...(session.history ?? []),
      {
        at: ctx.nowIso,
        action: 'move',
        from: { date: session.date, startMinutes: session.startMinutes, endMinutes: session.endMinutes },
        to: { date: op.date ?? session.date, startMinutes: op.startMinutes, endMinutes: op.endMinutes },
      },
    ],
  };

  const length = next.endMinutes - next.startMinutes;
  if (!Number.isInteger(next.startMinutes) || !Number.isInteger(next.endMinutes) || length <= 0 || length > 8 * 60) {
    return { ok: false, state, issues: [error(C.SESSION_LENGTH_INVALID, 'session', '时段长度必须在 1 分钟到 8 小时之间。', { length })] };
  }

  return { ok: true, state: { ...state, sessions: state.sessions.map((item) => (item.id === next.id ? next : item)) }, issues: [] };
}

function sessionCancelOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.COMPLETED) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.state', '已完成的学习记录不能被取消（它是历史事实）。', {})] };
  }
  return {
    ok: true,
    state: {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === op.sessionId ? { ...item, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: ctx.nowIso } : item,
      ),
    },
    issues: [],
  };
}

function sessionCompleteOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.CANCELLED) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.state', '已取消的时段不能标记完成。', {})] };
  }
  const actualMinutes = Number.isInteger(op.actualMinutes) ? op.actualMinutes : session.plannedMinutes;
  if (actualMinutes < 0 || actualMinutes > 24 * 60) {
    return { ok: false, state, issues: [error(C.RANGE, 'session.actualMinutes', '实际学习时长必须在 0 到 24 小时之间。', { actualMinutes })] };
  }
  return {
    ok: true,
    state: {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === op.sessionId
          ? { ...item, state: SESSION_STATE.COMPLETED, actualMinutes, completedAt: ctx.nowIso, updatedAt: ctx.nowIso }
          : item,
      ),
    },
    issues: [],
  };
}

/**
 * 暂停计时：把进行中的时段标记为暂停，并记录已累计的分钟数。
 * 这里保持 `state='in_progress'`（它仍然是"正在进行"的那一段），
 * 只在 `paused: true` 上区分停下来还是走着——这样容量与锁定语义都不受影响。
 */
function sessionPauseOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state !== SESSION_STATE.IN_PROGRESS) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.state', '只有正在进行中的时段才能暂停或继续。', { state: session.state })] };
  }
  return {
    ok: true,
    state: {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === op.sessionId
          ? { ...item, paused: Boolean(op.paused), elapsedMinutes: normalizeActual(op.elapsedMinutes, item), updatedAt: ctx.nowIso }
          : item,
      ),
    },
    issues: [],
  };
}

/**
 * 延长当前时段（用户选择"占用后面的时间把这一段做完"）。
 * 只延长到用户给定的新结束时间；如果会与非固定活动重叠，由引擎的硬约束校验拦下。
 */
function sessionExtendOp(state, op, ctx) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.COMPLETED) {
    return { ok: false, state, issues: [error(C.ENUM, 'session.state', '已完成的时段不能再延长。', {})] };
  }
  const endMinutes = op.endMinutes;
  const length = endMinutes - session.startMinutes;
  if (!Number.isInteger(endMinutes) || length <= 0 || length > 8 * 60) {
    return { ok: false, state, issues: [error(C.SESSION_LENGTH_INVALID, 'session', '延长后的时段长度必须在 1 分钟到 8 小时之间。', { endMinutes })] };
  }
  return {
    ok: true,
    state: {
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === op.sessionId
          ? {
              ...item,
              endMinutes,
              plannedMinutes: length,
              source: 'user_move',
              updatedAt: ctx.nowIso,
              history: [
                ...(item.history ?? []),
                { at: ctx.nowIso, action: 'extend', from: { endMinutes: item.endMinutes }, to: { endMinutes } },
              ],
            }
          : item,
      ),
    },
    issues: [],
  };
}

/** 删除单条历史时段记录（仅用于用户显式触发的清理） */
function sessionDeleteOp(state, op) {
  const session = (state.sessions ?? []).find((item) => item.id === op.sessionId);
  if (!session) return { ok: false, state, issues: [error(C.REQUIRED, 'session', '学习时段不存在。', { sessionId: op.sessionId })] };
  if (session.state === SESSION_STATE.COMPLETED) {
    return {
      ok: false,
      state,
      issues: [error(C.ENUM, 'session.state', '已完成的学习记录属于历史事实，不能删除。', { sessionId: op.sessionId })],
    };
  }
  return { ok: true, state: { ...state, sessions: state.sessions.filter((item) => item.id !== op.sessionId) }, issues: [] };
}

/* ------------------------------------------------------------------ *
 * 清理（只在用户显式触发时执行；绝不自动删除历史）
 * ------------------------------------------------------------------ */

/**
 * 计算清理影响面（不修改任何数据）。
 * @returns {{removable: object[], removableMinutes: number, keepCompleted: number, keepActive: number}}
 */
export function evaluateCleanupImpact(state) {
  const sessions = state.sessions ?? [];
  const removable = sessions.filter(
    (session) => session.state === SESSION_STATE.CANCELLED && session.actualMinutes === null && !session.startedAt,
  );
  return {
    removable,
    removableMinutes: removable.reduce((sum, session) => sum + (session.plannedMinutes ?? 0), 0),
    keepCompleted: sessions.filter((session) => session.state === SESSION_STATE.COMPLETED).length,
    keepActive: sessions.filter((session) => session.state === SESSION_STATE.FLEXIBLE || session.state === SESSION_STATE.IN_PROGRESS).length,
    historyCount: (state.planHistory ?? []).length,
  };
}

/** 清理"已取消且从未开始过"的时段记录（保留已完成与正在进行的记录） */
function cleanupCancelledSessionsOp(state, op) {
  const impact = evaluateCleanupImpact(state);
  if (impact.removable.length === 0) {
    return { ok: false, state, issues: [error(C.REQUIRED, 'sessions', '没有可以清理的已取消记录。', {})] };
  }
  void op;
  const removableIds = new Set(impact.removable.map((session) => session.id));
  return {
    ok: true,
    state: { ...state, sessions: (state.sessions ?? []).filter((session) => !removableIds.has(session.id)) },
    issues: [],
    removedCount: impact.removable.length,
    removedMinutes: impact.removableMinutes,
  };
}

/**
 * 清理历史版本快照，只保留最近 N 个。
 * 当前正式计划永远保留（它不在 planHistory 里）。
 */
function cleanupPlanHistoryOp(state, op) {
  const keep = Number.isInteger(op.keep) && op.keep > 0 ? op.keep : 5;
  const history = state.planHistory ?? [];
  if (history.length <= keep) {
    return { ok: false, state, issues: [error(C.REQUIRED, 'planHistory', `历史版本只有 ${history.length} 个，无需清理。`, {})] };
  }
  const removed = history.length - keep;
  return { ok: true, state: { ...state, planHistory: history.slice(0, keep) }, issues: [], removedCount: removed };
}

/* ------------------------------------------------------------------ *
 * 固定活动
 * ------------------------------------------------------------------ */

function fixedActivityAddOp(state, op, ctx) {
  const input = op.input;
  if (input === null || typeof input !== 'object') {
    return { ok: false, state, issues: [error(C.TYPE, 'fixedActivity', '固定活动数据必须是一个对象。')] };
  }
  const activity = createFixedActivity(input, { idFactory: ctx.idFactory, nowIso: ctx.nowIso });
  const validation = validateFixedActivity(activity, 'fixedActivity');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };
  return { ok: true, state: { ...state, fixedActivities: [...(state.fixedActivities ?? []), activity] }, issues: [], createdId: activity.id };
}

function fixedActivityUpdateOp(state, op, ctx) {
  const activity = (state.fixedActivities ?? []).find((item) => item.id === op.activityId);
  if (!activity) return { ok: false, state, issues: [error(C.REQUIRED, 'fixedActivity', '固定活动不存在。', { activityId: op.activityId })] };

  const next = { ...activity, ...sanitizeFixedActivityPatch(op.patch), updatedAt: ctx.nowIso };
  const validation = validateFixedActivity(next, 'fixedActivity');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };
  return {
    ok: true,
    state: { ...state, fixedActivities: state.fixedActivities.map((item) => (item.id === next.id ? next : item)) },
    issues: [],
  };
}

/** 只允许修改固定活动的可编辑字段，避免把 id / createdAt 之类的字段改坏 */
function sanitizeFixedActivityPatch(patch = {}) {
  const allowed = ['title', 'type', 'recurrence', 'startMinutes', 'endMinutes', 'activeFrom', 'activeTo', 'movable', 'note'];
  const out = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

function removeOp(state, op, ctx, collection, label) {
  const items = state[collection] ?? [];
  const id = op.activityId ?? op.id;
  if (!items.some((item) => item.id === id)) {
    return { ok: false, state, issues: [error(C.REQUIRED, collection, `${label}不存在。`, { id })] };
  }
  void ctx;
  return { ok: true, state: { ...state, [collection]: items.filter((item) => item.id !== id) }, issues: [] };
}

/* ------------------------------------------------------------------ *
 * 科目字典
 * ------------------------------------------------------------------ */

/**
 * 确保某个科目存在（任务表单提交新科目时使用）。
 * 已存在（归一化后同名）时直接复用，不重复创建。
 */
function subjectEnsureOp(state, op, ctx) {
  const validation = validateSubjectName(op.name, 'subject');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };

  const name = normalizeSubjectName(op.name);
  const existing = (state.subjects ?? []).find((item) => isSameSubjectName(item.name, name));
  if (existing) {
    return { ok: true, state, issues: [], createdId: existing.id, existing: true, subjectName: existing.name };
  }

  const subject = createSubject(name, { idFactory: ctx.idFactory, nowIso: ctx.nowIso });
  return {
    ok: true,
    state: { ...state, subjects: [...(state.subjects ?? []), subject] },
    issues: [],
    createdId: subject.id,
    subjectName: subject.name,
  };
}

/**
 * 重命名科目：**同一次提交里**把所有引用它的任务一起改名。
 *
 * 这样"改了科目名，任务还显示旧名字"不可能发生——任务与字典永远同步。
 */
function subjectRenameOp(state, op, ctx) {
  const subjects = state.subjects ?? [];
  const target = subjects.find((item) => item.id === op.subjectId);
  if (!target) return { ok: false, state, issues: [error(C.REQUIRED, 'subject', '科目不存在。', { subjectId: op.subjectId })] };

  const validation = validateSubjectName(op.name, 'subject');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };
  const name = normalizeSubjectName(op.name);

  const duplicated = subjects.find((item) => item.id !== target.id && isSameSubjectName(item.name, name));
  if (duplicated) {
    return {
      ok: false,
      state,
      issues: [
        error(C.ENUM, 'subject.name', `已经有一个叫「${duplicated.name}」的科目了，请换一个名字。`, {
          duplicatedId: duplicated.id,
        }),
      ],
    };
  }
  if (isSameSubjectName(target.name, name)) return { ok: true, state, issues: [], changed: false };

  return {
    ok: true,
    state: {
      ...state,
      subjects: subjects.map((item) => (item.id === target.id ? { ...item, name } : item)),
      // 任务里的科目名同步更新，界面与统计立刻一致
      tasks: (state.tasks ?? []).map((task) =>
        isSameSubjectName(task.subject, target.name) ? { ...task, subject: name, updatedAt: ctx.nowIso } : task,
      ),
    },
    issues: [],
    renamedTasks: (state.tasks ?? []).filter((task) => isSameSubjectName(task.subject, target.name)).length,
  };
}

/**
 * 删除科目。
 *
 * 若仍有任务引用它：**拒绝**，除非调用方显式给出 `reassignTo`（另一个科目名）。
 * 绝不静默删除，否则那些任务会变成"科目不存在"的孤儿引用。
 */
function subjectRemoveOp(state, op) {
  const subjects = state.subjects ?? [];
  const target = subjects.find((item) => item.id === op.subjectId);
  if (!target) return { ok: false, state, issues: [error(C.REQUIRED, 'subject', '科目不存在。', { subjectId: op.subjectId })] };

  const referencing = (state.tasks ?? []).filter((task) => isSameSubjectName(task.subject, target.name));
  if (referencing.length > 0 && !op.reassignTo) {
    return {
      ok: false,
      state,
      issues: [
        error(
          C.ENUM,
          'subject',
          `「${target.name}」还有 ${referencing.length} 个任务在用，先把这些任务改成别的科目，或指定一个替换科目再删除。`,
          { referencingCount: referencing.length, taskTitles: referencing.slice(0, 5).map((task) => task.title) },
        ),
      ],
    };
  }

  let tasks = state.tasks ?? [];
  if (referencing.length > 0) {
    const reassignName = normalizeSubjectName(op.reassignTo);
    tasks = tasks.map((task) => (isSameSubjectName(task.subject, target.name) ? { ...task, subject: reassignName } : task));
  }

  return {
    ok: true,
    state: { ...state, subjects: subjects.filter((item) => item.id !== target.id), tasks },
    issues: [],
    reassignedCount: referencing.length,
  };
}

/* ------------------------------------------------------------------ *
 * 休息时间
 * ------------------------------------------------------------------ */

function restAddOp(state, op, ctx) {
  const input = op.input;
  if (input === null || typeof input !== 'object') {
    return { ok: false, state, issues: [error(C.TYPE, 'rest', '休息时间数据必须是一个对象。')] };
  }
  const rest = createRestPeriod(input, { idFactory: ctx.idFactory, nowIso: ctx.nowIso });
  const validation = validateRestPeriod(rest, 'rest');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };

  return {
    ok: true,
    state: { ...state, restPeriods: [...(state.restPeriods ?? []), rest] },
    issues: [],
    createdId: rest.id,
  };
}

function restUpdateOp(state, op, ctx) {
  const existing = (state.restPeriods ?? []).find((item) => item.id === op.restId);
  if (!existing) return { ok: false, state, issues: [error(C.REQUIRED, 'rest', '休息时间不存在。', { restId: op.restId })] };

  const next = {
    ...existing,
    title: op.patch?.title !== undefined ? String(op.patch.title).trim() : existing.title,
    startDate: op.patch?.startDate ?? existing.startDate,
    startMinutes: op.patch?.startMinutes ?? existing.startMinutes,
    endDate: op.patch?.endDate ?? existing.endDate,
    endMinutes: op.patch?.endMinutes ?? existing.endMinutes,
    note: op.patch?.note !== undefined ? op.patch.note : existing.note,
    updatedAt: ctx.nowIso,
  };
  const validation = validateRestPeriod(next, 'rest');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };

  return {
    ok: true,
    state: { ...state, restPeriods: state.restPeriods.map((item) => (item.id === next.id ? next : item)) },
    issues: [],
  };
}

function restRemoveOp(state, op) {
  const exists = (state.restPeriods ?? []).some((item) => item.id === op.restId);
  if (!exists) return { ok: false, state, issues: [error(C.REQUIRED, 'rest', '休息时间不存在。', { restId: op.restId })] };
  return {
    ok: true,
    state: { ...state, restPeriods: state.restPeriods.filter((item) => item.id !== op.restId) },
    issues: [],
    removedCount: 1,
  };
}

/* ------------------------------------------------------------------ *
 * 设置与计划窗口
 * ------------------------------------------------------------------ */

function settingsUpdateOp(state, op) {
  /**
   * 只接受"当前版本真实存在"的设置项。
   *
   * 为什么需要这层过滤：删掉的功能（例如机动缓冲）其字段可能还残留在旧数据或旧调用里。
   * 如果直接合并进来，废弃字段会被一直写回存储，越滚越多。
   * 这里以默认设置为键集合的白名单，未知字段一律丢弃（旧数据读取时仍然容忍，不会被拦下）。
   */
  const knownKeys = new Set(Object.keys(defaultSettings()));
  const patch = {};
  for (const [key, value] of Object.entries(op.settings ?? {})) {
    if (knownKeys.has(key)) patch[key] = value;
  }
  const next = { ...(state.settings ?? {}), ...patch };
  const validation = validateSettings(next, 'settings');
  if (!validation.ok) return { ok: false, state, issues: validation.issues };
  return { ok: true, state: { ...state, settings: next }, issues: validation.warnings };
}

function windowShiftOp(state, op, ctx) {
  void ctx;
  // 窗口滚动本身不修改业务数据：它改变的是"引擎在哪个七天窗口上求解"。
  // 但为了让候选计划与正式计划可比较，这里把窗口记录写进 pendingPreview，
  // 由 planService 在应用时把窗口一并写入新计划。
  return { ok: true, state, issues: [], windowStart: op.windowStart, windowDays: op.windowDays ?? 7 };
}

/** 归一化"已累计分钟数"：非法值退回时段原值，避免把计时数据写坏 */
function normalizeActual(value, session) {
  if (!Number.isInteger(value) || value < 0) return session.elapsedMinutes ?? 0;
  return Math.min(value, 24 * 60);
}

/* ------------------------------------------------------------------ *
 * 导出：供服务层复用的判定工具
 * ------------------------------------------------------------------ */

export { mergeResults, result };
