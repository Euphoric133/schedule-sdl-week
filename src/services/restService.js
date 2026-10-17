/**
 * 休息时间服务：把"完整休息安排"投影成"每天的显示片段"，并提供冲突检查。
 *
 * 为什么需要这一层：
 * 底层只保存一条完整的休息安排（例如 10-16 22:00 → 10-17 08:00），
 * 但每日视图要按时段所在的日期分别显示（今天 22:00–24:00、明天 00:00–08:00）。
 * 拆分逻辑放在 domain（纯函数、可单测），本层负责查询与冲突检查。
 */

import { createDraftRest } from '../domain/restPeriod.js';
import { occursOn } from '../domain/fixedActivity.js';
import { overlapLength } from '../domain/time.js';
import { splitRestAcrossDates } from '../domain/restPeriod.js';

/**
 * @param {object} options
 * @param {ReturnType<import('./appState.js').createAppState>} options.app
 */
export function createRestService({ app }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createRestService 需要 app 状态容器');

  function list() {
    return [...(app.getState()?.restPeriods ?? [])].sort((a, b) => {
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
      return a.id < b.id ? -1 : 1;
    });
  }

  function get(id) {
    return (app.getState()?.restPeriods ?? []).find((item) => item.id === id) ?? null;
  }

  /**
   * 某一天要显示的休息片段（已按午夜边界拆分）。
   * 每次都是实时计算，因此修改/删除一条安排会自动影响它所有的片段。
   */
  function forDate(date) {
    return list()
      .flatMap((rest) => splitRestAcrossDates(rest))
      .filter((fragment) => fragment.date === date)
      .sort((a, b) => a.startMinutes - b.startMinutes || (a.restId < b.restId ? -1 : 1));
  }

  /** 某条休息安排覆盖到的所有日期（用于"影响面"提示） */
  function datesOf(restId) {
    const rest = get(restId);
    if (!rest) return [];
    return [...new Set(splitRestAcrossDates(rest).map((fragment) => fragment.date))];
  }

  /**
   * 检查一条（待保存或已存在）休息安排是否与其它安排冲突。
   *
   * 冲突不是"错误"——休息本来就是占时间的行为，可能确实与课程重叠。
   * 因此这里只**如实报告**重叠的对象与分钟数，由界面提示用户确认，
   * 绝不静默覆盖或删除别人的安排。
   *
   * @returns {{ok: boolean, conflicts: Array<{kind: string, title: string, date: string, startMinutes: number, endMinutes: number, overlapMinutes: number}>}}
   */
  function findConflicts(rest, { ignoreRestId = rest?.id ?? null } = {}) {
    if (!rest) return { ok: true, conflicts: [] };
    const state = app.getState();
    const fragments = splitRestAcrossDates(rest);
    const conflicts = [];

    for (const fragment of fragments) {
      // 与固定任务重叠
      for (const activity of state.fixedActivities ?? []) {
        if (!occursOn(activity, fragment.date)) continue;
        const overlap = spanOverlap(fragment, activity);
        if (overlap > 0) {
          conflicts.push({
            kind: 'fixed',
            title: activity.title,
            date: fragment.date,
            startMinutes: activity.startMinutes,
            endMinutes: activity.endMinutes,
            overlapMinutes: overlap,
          });
        }
      }

      // 与已有的学习时段重叠（只看仍会发生的时段）
      for (const session of state.sessions ?? []) {
        if (session.date !== fragment.date) continue;
        if (session.state === 'cancelled') continue;
        const overlap = spanOverlap(fragment, session);
        if (overlap > 0) {
          const task = (state.tasks ?? []).find((item) => item.id === session.taskId);
          conflicts.push({
            kind: 'study',
            title: task?.title ?? '学习任务',
            date: fragment.date,
            startMinutes: session.startMinutes,
            endMinutes: session.endMinutes,
            overlapMinutes: overlap,
          });
        }
      }

      // 与其它休息安排重叠
      for (const other of state.restPeriods ?? []) {
        if (other.id === ignoreRestId) continue;
        for (const otherFragment of splitRestAcrossDates(other)) {
          if (otherFragment.date !== fragment.date) continue;
          const overlap = spanOverlap(fragment, otherFragment);
          if (overlap > 0) {
            conflicts.push({
              kind: 'rest',
              title: other.title,
              date: fragment.date,
              startMinutes: otherFragment.startMinutes,
              endMinutes: otherFragment.endMinutes,
              overlapMinutes: overlap,
            });
          }
        }
      }
    }

    return { ok: conflicts.length === 0, conflicts: dedupeConflicts(conflicts) };
  }

  /** 空白草稿（表单初始化用） */
  function draft(overrides = {}) {
    return createDraftRest(overrides);
  }

  return { list, get, forDate, datesOf, findConflicts, draft };
}

/** 两个区间在同一天的重叠分钟数 */
function spanOverlap(a, b) {
  if (!Number.isInteger(a.startMinutes) || !Number.isInteger(a.endMinutes)) return 0;
  if (!Number.isInteger(b.startMinutes) || !Number.isInteger(b.endMinutes)) return 0;
  return overlapLength({ startMinutes: a.startMinutes, endMinutes: a.endMinutes }, { startMinutes: b.startMinutes, endMinutes: b.endMinutes });
}

/** 同一对象在多天重叠时只保留一条提示（附带天数） */
function dedupeConflicts(conflicts) {
  const seen = new Map();
  for (const conflict of conflicts) {
    const key = `${conflict.kind}|${conflict.title}|${conflict.date}`;
    if (!seen.has(key)) seen.set(key, conflict);
  }
  return [...seen.values()];
}
