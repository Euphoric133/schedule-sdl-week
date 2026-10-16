/**
 * 任务业务服务：所有对 Task / StudySession 的修改都必须经过这里。
 *
 * 职责边界（重要）：
 * - 本层负责「校验 + 影响面计算 + 写入」，不负责「排程」。
 * - 排程相关操作（生成候选计划、差异预览、应用、撤销）在 planService 中，
 *   并由预览机制统一收口。阶段 1 尚未实现引擎，因此本层的任务修改会立即落盘；
 *   阶段 2/3 引入候选计划后，界面必须在修改任务时先生成预览（见 CHANGELOG 已知限制）。
 * - 删除任务必须明确告知影响面；有历史时段的只做软删除，避免损坏计划数据。
 */

import {
  TASK_STATUS,
  applyTaskPatch,
  createTask,
  remainingMinutesForTask,
  transitionTaskStatus,
  validateTask,
} from '../domain/task.js';
import { SESSION_STATE } from '../domain/session.js';
import { checkTaskDependencies } from '../domain/graph.js';
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
   * 创建 / 修改
   * ---------------------------------------------------------------- */

  /**
   * 创建任务（含前置依赖校验与整体状态校验）。
   *
   * 注意：这里对**外部输入**做防御性检查。界面层与导入层可能把 null / 字符串直接传进来，
   * 服务层必须返回结构化错误而不是抛异常——否则一次误操作就会让页面白屏。
   */
  function addTask(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return {
        ok: false,
        issues: [error(C.TYPE, 'task', '任务数据必须是一个对象（包含名称、科目、预计用时与截止时间）。', {
          actual: Array.isArray(input) ? 'array' : typeof input,
        })],
      };
    }

    const candidate = createTask(input, { idFactory, nowIso: nowIso() });
    const validation = validateTask(candidate, 'task');
    if (!validation.ok) return { ok: false, issues: validation.issues };

    const dependencyIssues = checkDependencies(candidate);
    if (dependencyIssues.length > 0) return { ok: false, issues: dependencyIssues };

    const commitResult = app.commit((state) => ({ ...state, tasks: [...state.tasks, candidate] }), { reason: 'task-add' });
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true, task: candidate, warnings: validation.warnings };
  }

  /** 编辑任务：只更新白名单字段，返回新对象（旧对象保持不变，便于撤销与对比） */
  function updateTask(id, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, issues: [error(C.TYPE, 'patch', '修改内容必须是一个对象。', { actual: typeof patch })] };
    }
    const task = getTask(id);
    if (!task) return { ok: false, issues: [error(C.REQUIRED, 'task', '要修改的任务不存在。', { taskId: id })] };

    const next = applyTaskPatch(task, patch, { nowIso: nowIso() });
    const validation = validateTask(next, 'task');
    if (!validation.ok) return { ok: false, issues: validation.issues };

    const dependencyIssues = checkDependencies(next, { ignoreSelf: true });
    if (dependencyIssues.length > 0) return { ok: false, issues: dependencyIssues };

    const commitResult = app.commit(
      (state) => ({ ...state, tasks: state.tasks.map((t) => (t.id === id ? next : t)) }),
      { reason: 'task-update' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true, task: next, warnings: validation.warnings };
  }

  /** 状态迁移（完成 / 取消 / 恢复 / 重新开始） */
  function changeTaskStatus(id, to) {
    const task = getTask(id);
    if (!task) return { ok: false, issues: [error(C.REQUIRED, 'task', '任务不存在。', { taskId: id })] };
    const { task: next, issue } = transitionTaskStatus(task, to, { nowIso: nowIso() });
    if (issue) return { ok: false, issues: [issue] };

    // 取消任务时，未完成的时段应一并取消，避免它们继续占用计划（已完成记录保留）
    const sessions = getSessionsForTask(id);
    const cancelSessions = to === TASK_STATUS.CANCELLED || to === TASK_STATUS.DELETED;
    const nextSessions = cancelSessions
      ? app.getState().sessions.map((s) =>
          s.taskId === id && s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED
            ? { ...s, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: nowIso() }
            : s,
        )
      : app.getState().sessions;

    const commitResult = app.commit(
      (state) => ({ ...state, tasks: state.tasks.map((t) => (t.id === id ? next : t)), sessions: nextSessions }),
      { reason: 'task-status' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return {
      ok: true,
      task: next,
      cancelledSessions: cancelSessions
        ? sessions.filter((s) => s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED).length
        : 0,
    };
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

    if (impact.totalSessions === 0 && hard) {
      const commitResult = app.commit((state) => ({ ...state, tasks: state.tasks.filter((t) => t.id !== id) }), {
        reason: 'task-delete-hard',
      });
      if (!commitResult.ok) return { ok: false, error: commitResult.error };
      return { ok: true, mode: 'hard', impact };
    }

    const statusResult = changeTaskStatus(id, TASK_STATUS.DELETED);
    if (!statusResult.ok) return statusResult;
    if (impact.totalSessions > 0 && !hard) {
      return { ok: true, mode: 'soft', impact, cancelledSessions: statusResult.cancelledSessions };
    }
    if (impact.totalSessions === 0 && !hard) {
      return { ok: true, mode: 'soft', impact, cancelledSessions: 0 };
    }
    // hard=true 但存在历史时段：出于数据安全拒绝物理删除，改为软删除
    return {
      ok: true,
      mode: 'soft',
      downgraded: true,
      impact,
      cancelledSessions: statusResult.cancelledSessions,
      warnings: [
        error(
          C.ENTITY_DANGLING_REF,
          'task',
          '该任务已有学习记录，已改为"软删除"以保留历史；如需彻底清除，请先删除其学习记录。',
          { taskId: id },
        ),
      ],
    };
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

  /**
   * 依赖校验：自引用 / 悬空 / 环。
   * 复用 domain/graph.js 的统一实现，避免界面、校验器与引擎三处各写一遍依赖规则。
   */
  function checkDependencies(candidate, { ignoreSelf = false } = {}) {
    const existing = (app.getState()?.tasks ?? []).filter((t) => (ignoreSelf ? t.id !== candidate.id : true));
    return checkTaskDependencies([...existing, candidate]);
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
