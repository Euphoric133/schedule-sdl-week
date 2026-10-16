/**
 * 任务业务服务：任务库的读取视图与"直接写入"入口。
 *
 * 职责边界（重要）：
 * - **状态变更的唯一实现是 `domain/mutations.js`**。本层不再自己拼接新状态，
 *   而是构造对应的 `op` 交给 `applyDraftOp`，再把结果提交持久化。
 *   这样"预览草稿"与"直接写入"走的是同一套逻辑，不可能出现两者不一致。
 * - 本层负责：读取视图（含剩余工作量、影响面评估）与提交持久化。
 * - 排程相关操作（候选计划、差异预览、应用、撤销）在 `planService` 中。
 * - 界面统一走"先生成预览、确认后写入"，不会直接调用本层的写入方法；
 *   本层的写入方法保留给内部调用、导入与自动化测试使用。
 */

import { TASK_STATUS, remainingMinutesForTask } from '../domain/task.js';
import { SESSION_STATE } from '../domain/session.js';
import { applyDraftOp } from '../domain/mutations.js';
import { VALIDATION_CODES as C, error, result } from '../domain/validation.js';

/**
 * @param {object} options
 * @param {object} options.app 应用状态容器（见 appState.js 的 createAppState）
 * @param {{ next: (kind: string) => string }} options.idFactory
 */
export function createTaskService({ app, idFactory }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createTaskService 需要 app 状态容器');
  if (!idFactory || typeof idFactory.next !== 'function') throw new TypeError('createTaskService 需要 idFactory');

  const nowIso = () => app.clock();

  function getTasks({ includeDeleted = false } = {}) {
    const tasks = app.getState()?.tasks ?? [];
    return includeDeleted ? tasks : tasks.filter((t) => t.status !== TASK_STATUS.DELETED);
  }

  function getTask(id) {
    return (app.getState()?.tasks ?? []).find((t) => t.id === id) ?? null;
  }

  function getSessionsForTask(id) {
    return (app.getState()?.sessions ?? []).filter((s) => s.taskId === id);
  }

  /* ---------------------------------------------------------------- *
   * 影响面评估（删除 / 修改前必须先算，用于告知用户）
   * ---------------------------------------------------------------- */

  /**
   * 计算删除或大改某任务的影响面，供确认弹窗展示。
   * 绝不使用模糊表述，所有数字都来自真实数据。
   */
  function evaluateTaskImpact(id) {
    const task = getTask(id);
    if (!task) {
      return { ok: false, issues: [error(C.REQUIRED, 'task', '该任务不存在（可能已被删除）。', { taskId: id })] };
    }
    const sessions = getSessionsForTask(id);
    const active = sessions.filter((s) => s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED);
    const completed = sessions.filter((s) => s.state === SESSION_STATE.COMPLETED);
    const locked = sessions.filter((s) => s.locked && s.state !== SESSION_STATE.COMPLETED);
    const minutes = active.reduce((sum, s) => sum + (s.plannedMinutes ?? 0), 0);
    const dependents = (app.getState()?.tasks ?? []).filter((t) => (t.dependsOn ?? []).includes(id));

    return {
      ok: true,
      impact: {
        taskId: id,
        title: task.title,
        subject: task.subject,
        totalSessions: sessions.length,
        activeSessions: active.length,
        activeMinutes: minutes,
        completedSessions: completed.length,
        lockedSessions: locked.length,
        remainingMinutes: remainingMinutesForTask(task, sessions),
        dependents: dependents.map((t) => ({ id: t.id, title: t.title })),
        canHardDelete: sessions.length === 0,
        /** 面向用户的完整影响说明（不省略任何会影响计划的数字） */
        message:
          sessions.length === 0
            ? `「${task.title}」没有任何已排时段或完成记录，可以彻底删除（不可恢复）。`
            : `「${task.title}」已有 ${sessions.length} 个学习时段记录（其中 ${completed.length} 个已完成，${active.length} 个待进行共 ${minutes} 分钟` +
              `${locked.length > 0 ? `，含 ${locked.length} 个已锁定` : ''}）。` +
              (dependents.length > 0 ? `另有 ${dependents.length} 个任务依赖它：${dependents.map((t) => t.title).join('、')}。` : '') +
              '删除将把该任务标记为已删除、其待进行时段一并取消，已完成的学习记录会保留，此操作可通过"显示已删除"恢复。',
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * 写入（统一委托给 domain/mutations.js 的纯函数）
   * ---------------------------------------------------------------- */

  /**
   * 应用一次变更并提交持久化（内部共用）。
   * @param {object} op 变更描述（见 domain/mutations.js）
   * @param {{reason: string, unwrap?: (payload: object) => object}} options
   */
  function applyAndCommit(op, { reason, unwrap }) {
    const applied = applyDraftOp(app.getState(), op, { idFactory, nowIso: nowIso() });
    if (!applied.ok) return { ok: false, issues: applied.issues ?? [] };

    const commitResult = app.commit(() => applied.state, { reason });
    if (!commitResult.ok) return { ok: false, error: commitResult.error, issues: [] };

    const payload = {
      issues: applied.issues ?? [],
      removedCount: applied.removedCount,
      removedMinutes: applied.removedMinutes,
      createdId: applied.createdId,
    };
    return unwrap ? unwrap(payload) : { ok: true, ...payload };
  }

  /** 创建任务 */
  function addTask(input) {
    return applyAndCommit({ kind: 'task.add', input }, {
      reason: 'task-add',
      unwrap: ({ createdId, issues }) => {
        const task = getTask(createdId);
        if (!task) return { ok: false, issues: issues ?? [] };
        return { ok: true, task, warnings: issues.filter((issue) => issue.severity === 'warning') };
      },
    });
  }

  /** 编辑任务（只更新白名单字段；返回新对象，旧对象保持不变） */
  function updateTask(id, patch) {
    return applyAndCommit({ kind: 'task.update', taskId: id, patch }, {
      reason: 'task-update',
      unwrap: ({ issues }) => {
        const task = getTask(id);
        if (!task) return { ok: false, issues: issues ?? [] };
        return { ok: true, task, warnings: issues.filter((issue) => issue.severity === 'warning') };
      },
    });
  }

  /** 状态迁移（完成 / 取消 / 恢复 / 重新开始）；取消与删除会连带取消待进行时段 */
  function changeTaskStatus(id, to) {
    const before = app.getState().sessions ?? [];
    const cancellableBefore = before.filter(
      (session) => session.taskId === id && session.state !== SESSION_STATE.COMPLETED && session.state !== SESSION_STATE.CANCELLED,
    ).length;

    return applyAndCommit({ kind: 'task.status', taskId: id, to }, {
      reason: 'task-status',
      unwrap: () => {
        const task = getTask(id);
        if (!task) return { ok: false };
        return { ok: true, task, cancelledSessions: task.status === TASK_STATUS.DELETED || task.status === TASK_STATUS.CANCELLED ? cancellableBefore : 0 };
      },
    });
  }

  /**
   * 删除任务。
   * - 有历史时段 → 软删除（保留记录，可恢复），并取消其待进行时段。
   * - 无历史时段且 hard=true → 物理移除。
   * 无论哪种都必须先调用 evaluateTaskImpact 并让用户确认。
   */
  function deleteTask(id, { hard = false } = {}) {
    const evaluated = evaluateTaskImpact(id);
    if (!evaluated.ok) return evaluated;
    const { impact } = evaluated;
    const willBeHard = impact.totalSessions === 0 && hard;

    return applyAndCommit({ kind: 'task.delete', taskId: id, hard }, {
      reason: willBeHard ? 'task-delete-hard' : 'task-delete-soft',
      unwrap: () => {
        if (willBeHard) return { ok: true, mode: 'hard', impact };
        return {
          ok: true,
          mode: 'soft',
          impact,
          cancelledSessions: impact.activeSessions,
          downgraded: hard && impact.totalSessions > 0,
          warnings:
            hard && impact.totalSessions > 0
              ? [
                  error(
                    C.ENTITY_DANGLING_REF,
                    'task',
                    '该任务已有学习记录，已改为"软删除"以保留历史；如需彻底清除，请先清理它的学习记录。',
                    { taskId: id },
                  ),
                ]
              : [],
        };
      },
    });
  }

  /** 恢复软删除的任务 */
  function restoreTask(id) {
    const task = getTask(id);
    if (!task) return { ok: false, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: id })] };
    if (task.status !== TASK_STATUS.DELETED) {
      return { ok: false, issues: [error(C.ENUM, 'task.status', '只有已删除的任务才能恢复。', { status: task.status })] };
    }
    return changeTaskStatus(id, TASK_STATUS.NOT_STARTED);
  }

  /* ---------------------------------------------------------------- *
   * 查询辅助
   * ---------------------------------------------------------------- */

  /** 任务库视图数据：任务 + 其时段摘要 + 剩余工作量 */
  function listTaskViews({ includeDeleted = false, sort = 'deadline' } = {}) {
    const sessions = app.getState()?.sessions ?? [];
    const views = getTasks({ includeDeleted }).map((task) => {
      const own = sessions.filter((s) => s.taskId === task.id);
      return {
        task,
        sessions: own,
        activeSessions: own.filter((s) => s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED).length,
        completedSessions: own.filter((s) => s.state === SESSION_STATE.COMPLETED).length,
        lockedSessions: own.filter((s) => s.locked).length,
        remainingMinutes: remainingMinutesForTask(task, sessions),
      };
    });

    const byDeadline = (a, b) => {
      const ka = `${a.task.deadlineDate}T${a.task.deadlineTime}`;
      const kb = `${b.task.deadlineDate}T${b.task.deadlineTime}`;
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.task.id < b.task.id ? -1 : 1;
    };
    const byCreated = (a, b) => (a.task.createdAt < b.task.createdAt ? -1 : 1);

    return views.sort(sort === 'created' ? byCreated : byDeadline);
  }

  return {
    getTasks,
    getTask,
    getSessionsForTask,
    listTaskViews,
    evaluateTaskImpact,
    addTask,
    updateTask,
    changeTaskStatus,
    deleteTask,
    restoreTask,
  };
}

/** 供测试与 UI 复用的空结果构造 */
export function emptyResult() {
  return result([]);
}
