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
import { validateSettings } from '../domain/schemas.js';
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
    case 'focus.record':
      return focusRecordOp(state, op, ctx);
    case 'fixedActivity.add':
      return fixedActivityAddOp(state, op, ctx);
    case 'fixedActivity.update':
      return fixedActivityUpdateOp(state, op, ctx);
    case 'fixedActivity.remove':
      return removeOp(state, op, ctx, 'fixedActivities', '固定活动');
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
      case 'focus.record':
        parts.push(op.completed ? '记录一个完成的番茄钟' : '记录一次提前结束的专注');
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

  return { ok: true, state: { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)) }, issues: [] };
}

function taskStatusOp(state, op, ctx) {
  const task = (state.tasks ?? []).find((item) => item.id === op.taskId);
  if (!task) return { ok: false, state, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: op.taskId })] };

  const { task: next, issue } = transitionTaskStatus(task, op.to, { nowIso: ctx.nowIso });
  if (issue) return { ok: false, state, issues: [issue] };

  // 取消/删除任务时，未完成的时段一并取消（已完成记录保留）
  const shouldCancelSessions = op.to === TASK_STATUS.CANCELLED || op.to === TASK_STATUS.DELETED;
  const sessions = shouldCancelSessions
    ? (state.sessions ?? []).map((session) =>
        session.taskId === op.taskId && session.state !== SESSION_STATE.COMPLETED && session.state !== SESSION_STATE.CANCELLED
          ? { ...session, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: ctx.nowIso }
          : session,
      )
    : state.sessions;

  return {
    ok: true,
    state: { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)), sessions },
    issues: [],
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

/**
 * 记录一次专注（番茄钟）。
 *
 * 三条不变式：
 * 1. **只记录真实投入**：`focusedSeconds` 来自真实时间戳算出的差值，
 *    中途结束的记录 `completed: false`，绝不记为完成。
 * 2. **一轮番茄 ≠ 任务完成**：这里只更新"已投入时长"，任务状态由用户决定。
 * 3. **不重复**：同一轮结束会带一个唯一来源键，重复提交会被忽略（见 recordFocusInState）。
 */
function focusRecordOp(state, op, ctx) {
  const focusedSeconds = Math.max(0, Math.round(Number(op.focusedSeconds) || 0));
  if (focusedSeconds <= 0) {
    return { ok: false, state, issues: [error(C.RANGE, 'focus.focusedSeconds', '专注时长必须大于 0 秒。', { focusedSeconds })] };
  }
  if (focusedSeconds > 12 * 60 * 60) {
    return { ok: false, state, issues: [error(C.RANGE, 'focus.focusedSeconds', '单次专注时长不能超过 12 小时。', { focusedSeconds })] };
  }

  const record = {
    id: op.recordId ?? `fcr_${Math.random().toString(36).slice(2, 10)}`,
    date: op.date,
    startedAt: op.startedAt ?? null,
    endedAt: op.endedAt ?? ctx.nowIso,
    focusedSeconds,
    completed: Boolean(op.completed),
    round: Number.isInteger(op.round) ? op.round : null,
    sessionId: op.sessionId ?? null,
    taskId: op.taskId ?? null,
    taskTitle: op.taskTitle ?? null,
    source: op.source ?? 'pomodoro',
    createdAt: ctx.nowIso,
  };

  const existing = state.focusRecords ?? [];
  // 幂等保护：同一个来源键只允许写入一次，重复提交直接忽略
  if (op.sourceKey && existing.some((item) => item.sourceKey === op.sourceKey)) {
    return { ok: true, state, issues: [], duplicate: true, record: existing.find((item) => item.sourceKey === op.sourceKey) };
  }

  return {
    ok: true,
    state: { ...state, focusRecords: [...existing, { ...record, sourceKey: op.sourceKey ?? null }] },
    issues: [],
    record,
    createdId: record.id,
  };
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
 * 设置与计划窗口
 * ------------------------------------------------------------------ */

function settingsUpdateOp(state, op) {
  const next = { ...(state.settings ?? {}), ...(op.settings ?? {}) };
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
