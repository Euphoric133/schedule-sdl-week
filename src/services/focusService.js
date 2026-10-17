/**
 * 专注服务：开始 / 进行 / 结束一段学习，并记录实际时长。
 *
 * 位置说明：番茄钟功能已从本应用移除（由独立的番茄钟页面承担），
 * 本服务只负责**记录一段真实学习**（开始 / 结束 / 实际时长），
 * 与计时器产品无关，也不包含任何倒计时逻辑。
 *
 * 设计原因：
 * - 本服务只负责"记录事实"（我学了多久），不负责"重新安排未来"。
 *   重新安排必须走候选计划 + 用户确认（planService.requestPreview）。
 *   这样就不会出现"点了结束，后面的计划被悄悄改掉"这种情况。
 * - 同一天只允许有一段进行中的时段，否则实际时长会互相污染，统计也不可信。
 */

import { SESSION_STATE, completeSession, startSession } from '../domain/session.js';
import { remainingMinutesForTask } from '../domain/task.js';

/**
 * @param {object} options
 * @param {object} options.app 应用状态容器（见 appState.js 的 createAppState）
 * @param {() => {date: string, minutes: number}} options.now
 */
export function createFocusService({ app, idFactory }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createFocusService 需要 app 状态容器');
  if (typeof idFactory?.next !== 'function') throw new TypeError('createFocusService 需要 idFactory');

  const nowIso = () => app.clock();

  function getSession(id) {
    return (app.getState()?.sessions ?? []).find((s) => s.id === id) ?? null;
  }

  function getRunningSession() {
    return (app.getState()?.sessions ?? []).find((s) => s.state === SESSION_STATE.IN_PROGRESS) ?? null;
  }

  /** 开始一段学习：flexible → in_progress，并自动锁定（进行中的时段不得被重排移动） */
  function start(sessionId) {
    const session = getSession(sessionId);
    if (!session) return { ok: false, issues: [{ severity: 'error', code: 'V001', path: 'session', message: '要开始的学习时段不存在。' }] };
    if (session.state === SESSION_STATE.COMPLETED) {
      return { ok: false, issues: [{ severity: 'error', code: 'V004', path: 'session.state', message: '该时段已经完成。' }] };
    }
    if (session.state === SESSION_STATE.CANCELLED) {
      return { ok: false, issues: [{ severity: 'error', code: 'V004', path: 'session.state', message: '该时段已取消，无法开始。' }] };
    }

    const running = getRunningSession();
    if (running && running.id !== sessionId) {
      return {
        ok: false,
        issues: [
          {
            severity: 'error',
            code: 'V004',
            path: 'session.state',
            message: `已经有一段学习正在进行（${running.date}）。请先结束它再开始新的时段，否则实际学习时长会统计错误。`,
          },
        ],
      };
    }

    const { session: next, issue } = startSession(session, { nowIso: nowIso() });
    if (issue) return { ok: false, issues: [issue] };

    const commitResult = app.commit((state) => ({ ...state, sessions: state.sessions.map((s) => (s.id === sessionId ? next : s)) }), {
      reason: 'focus-start',
    });
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true, session: next };
  }

  /**
   * 结束一段学习：in_progress → completed，写入实际时长。
   * @param {string} sessionId
   * @param {{actualMinutes?: number}} [options]
   */
  function finish(sessionId, { actualMinutes } = {}) {
    const session = getSession(sessionId);
    if (!session) return { ok: false, issues: [{ severity: 'error', code: 'V001', path: 'session', message: '学习时段不存在。' }] };

    const { session: next, issue } = completeSession(session, { nowIso: nowIso() }, { actualMinutes });
    if (issue) return { ok: false, issues: [issue] };

    // 结束学习会更新任务的剩余工作量；这里只记录事实，不触碰任何未来安排。
    const task = (app.getState().tasks ?? []).find((t) => t.id === session.taskId) ?? null;
    const shouldStartTask = task && task.status === 'not_started';

    const commitResult = app.commit(
      (state) => ({
        ...state,
        sessions: state.sessions.map((s) => (s.id === sessionId ? next : s)),
        tasks: shouldStartTask
          ? state.tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress', startedAt: t.startedAt ?? nowIso(), updatedAt: nowIso() } : t))
          : state.tasks,
      }),
      { reason: 'focus-finish' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };

    return {
      ok: true,
      session: next,
      taskStarted: Boolean(shouldStartTask),
      /** 剩余工作量是否仍需安排：由调用方决定是提示用户生成候选计划，还是就此结束 */
      needsReplan: true,
    };
  }

  /** 今日学习统计（仅统计已完成时段，口径与任务剩余量一致） */
  function todayStats(date) {
    const sessions = (app.getState()?.sessions ?? []).filter((s) => s.date === date);
    const completed = sessions.filter((s) => s.state === SESSION_STATE.COMPLETED);
    return {
      plannedMinutes: sessions.filter((s) => s.state !== SESSION_STATE.CANCELLED).reduce((sum, s) => sum + s.plannedMinutes, 0),
      actualMinutes: completed.reduce((sum, s) => sum + (s.actualMinutes ?? s.plannedMinutes), 0),
      completedCount: completed.length,
      totalCount: sessions.length,
    };
  }

  /**
   * 暂停 / 继续当前时段。
   *
   * 为什么放在服务层而不是界面：计时状态（已累计分钟数）属于数据，
   * 刷新页面后必须还能恢复，因此与其它数据一样走 `app.commit`。
   */
  function pause(sessionId, { elapsedMinutes } = {}) {
    const session = getSession(sessionId);
    if (!session) return fail('要暂停的学习时段不存在。');
    if (session.state !== SESSION_STATE.IN_PROGRESS) return fail('只有正在进行中的时段才能暂停。');
    if (session.paused) return { ok: true, session, alreadyPaused: true };

    const commitResult = app.commit(
      (state) => ({
        ...state,
        sessions: state.sessions.map((item) =>
          item.id === sessionId
            ? { ...item, paused: true, elapsedMinutes: normalizeElapsed(elapsedMinutes, item), updatedAt: nowIso() }
            : item,
        ),
      }),
      { reason: 'focus-pause' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true, session: getSession(sessionId) };
  }

  /** 继续计时（从暂停状态恢复） */
  function resume(sessionId, { elapsedMinutes } = {}) {
    const session = getSession(sessionId);
    if (!session) return fail('要继续的学习时段不存在。');
    if (session.state !== SESSION_STATE.IN_PROGRESS) return fail('只有正在进行中的时段才能继续。');
    if (!session.paused) return { ok: true, session, alreadyRunning: true };

    const commitResult = app.commit(
      (state) => ({
        ...state,
        sessions: state.sessions.map((item) =>
          item.id === sessionId
            ? { ...item, paused: false, elapsedMinutes: normalizeElapsed(elapsedMinutes, item), updatedAt: nowIso() }
            : item,
        ),
      }),
      { reason: 'focus-resume' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true, session: getSession(sessionId) };
  }

  /**
   * 评估"结束这一段"时的分支。
   *
   * 提前完成或超时都不允许自动改动后续安排，而是把可选处理方式告诉界面：
   * - 还有剩余工作量 → 建议"顺延剩余工作"（生成重排预览）
   * - 实际时长少于计划 → 询问是否顺延或就此结束
   * - 实际时长超过计划 → 询问是否延长本段（占用缓冲）或占用后续时段
   */
  function evaluateFinish(sessionId, { actualMinutes } = {}) {
    const session = getSession(sessionId);
    if (!session) return fail('学习时段不存在。');
    const task = (app.getState()?.tasks ?? []).find((item) => item.id === session.taskId) ?? null;
    const actual = Number.isFinite(actualMinutes) ? Math.max(0, Math.round(actualMinutes)) : session.plannedMinutes;
    const completedTaskMinutes = (app.getState()?.sessions ?? [])
      .filter((item) => item.taskId === session.taskId && item.state === SESSION_STATE.COMPLETED)
      .reduce((sum, item) => sum + (item.actualMinutes ?? item.plannedMinutes ?? 0), 0);
    const remainingAfterThis = Math.max(0, (task?.plannedMinutes ?? 0) - completedTaskMinutes - actual);

    return {
      ok: true,
      session,
      task,
      actualMinutes: actual,
      planMinutes: session.plannedMinutes,
      differenceMinutes: actual - session.plannedMinutes,
      isOverrun: actual > session.plannedMinutes,
      isEarly: actual < session.plannedMinutes,
      remainingAfterThis,
      taskWillBeComplete: remainingAfterThis === 0,
      options: buildFinishOptions({ session, actual, remainingAfterThis }),
    };
  }

  function buildFinishOptions({ session, actual, remainingAfterThis }) {
    const options = [
      { code: 'complete', label: '记录实际时长并结束本段', description: '不改动后续安排，剩余工作由你决定是否重新规划。' },
    ];
    if (remainingAfterThis > 0) {
      options.push({
        code: 'replan',
        label: '结束并重新规划剩余工作',
        description: '先生成候选计划预览，确认后才会调整后续安排。',
      });
    } else {
      options.push({
        code: 'complete_task',
        label: '结束并把这个任务标记为已完成',
        description: '剩余工作量为 0，可以一并把任务标记完成。',
      });
    }
    if (actual > session.plannedMinutes) {
      options.push({
        code: 'extend',
        label: `延长本段到 ${actual} 分钟`,
        description: '把多出来的时间记在本段上（会占用后面的空白时间，需要生成预览确认）。',
      });
      options.push({
        code: 'keep_plan',
        label: '只记录实际时长，计划保持不变',
        description: '计划里这一段仍是原来的时长，实际投入更长。',
      });
    }
    void session;
    return options;
  }

  function fail(message) {
    return { ok: false, issues: [{ severity: 'error', code: 'V001', path: 'focus', message }] };
  }

  function normalizeElapsed(value, session) {
    if (!Number.isInteger(value) || value < 0) return session.elapsedMinutes ?? 0;
    return Math.min(value, 24 * 60);
  }

  /** 任务剩余工作量（工作台展示"还剩多少"时使用） */
  function remainingMinutes(taskId) {
    const task = (app.getState()?.tasks ?? []).find((item) => item.id === taskId) ?? null;
    if (!task) return 0;
    return remainingMinutesForTask(task, app.getState()?.sessions ?? []);
  }

  return { getSession, getRunningSession, start, pause, resume, finish, evaluateFinish, todayStats, remainingMinutes };
}
