/**
 * 专注服务：开始 / 进行 / 结束一段学习，并记录实际时长。
 *
 * 设计原因：
 * - 工作台只负责"记录事实"（我学了多久），不负责"重新安排未来"。
 *   重新安排必须走候选计划 + 用户确认（阶段 2/3 的 planService.requestPreview）。
 *   这样就不会出现"点了结束，后面的计划被悄悄改掉"这种情况。
 * - 同一天只允许有一段进行中的时段，否则实际时长会互相污染，统计也不可信。
 */

import { SESSION_STATE, completeSession, startSession } from '../domain/session.js';

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

  return { getSession, getRunningSession, start, finish, todayStats };
}
