/**
 * 数据一致性修复（reconcile）。
 *
 * 这个模块存在的唯一原因：**计划时段与任务的剩余工作量必须始终对得上**。
 *
 * 不变量（整个应用都依赖它）：
 *
 *   任务预计总用时 − 已完成时长 = 剩余工作量 ≥ 未完成计划时段合计
 *
 * 破坏这个不变量的操作有一大类共同特征：**剩余工作量变小了，但已排的未完成时段没有跟着变**。
 * 具体包括：
 *   - 把任务标记为完成 / 取消 / 删除（剩余工作量直接归 0）
 *   - 把"预计总用时"改小
 *   - 增加"已经完成"的时长
 *   - 完成某一段时段后，实际时长把剩余量吃掉了
 *
 * 以前这些操作只改任务、不改时段，于是留下"已排 120 分钟但只剩 0 分钟"的状态。
 * 这个状态会让整体校验（V016）失败，进而导致：预览被拒绝、任务删不掉、
 * 严重时整个数据在下次打开时无法通过校验而显示为空。
 *
 * 因此所有会改变"剩余工作量"的操作，都必须在**同一次提交**里调用这里的函数，
 * 让时段与任务保持同步。这里只做两件事，且都是确定性的：
 *   1. 任务已经不需要再做（完成/取消/删除）→ 取消它所有未完成的时段；
 *   2. 未完成时段合计超过剩余工作量 → 按确定顺序取消超出部分。
 *
 * 已完成的时段属于学习历史，**永远不会**被这里取消或删除。
 */

import { SESSION_STATE } from './session.js';
import { TASK_STATUS, completedMinutesForTask, remainingMinutesForTask } from './task.js';

/** 修复报告的严重级别：info 表示只是同步清理，warning 表示旧数据需要修正 */
export const REPAIR_CODE = Object.freeze({
  TASK_CLOSED: 'task_closed', // 任务已完成/取消/删除，未完成时段被取消
  OVER_SCHEDULED: 'over_scheduled', // 未完成时段超过剩余工作量
  DANGLING_SESSION: 'dangling_session', // 时段引用了不存在的任务
  OVER_COMPLETED: 'over_completed', // 已完成时长超过预计总用时
});

/** 任务是否已经"不需要再安排学习" */
function isClosedTask(task) {
  return (
    task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED || task.status === TASK_STATUS.DELETED
  );
}

/** 未完成（仍会占用计划）的时段 */
function isPending(session) {
  return session.state !== SESSION_STATE.COMPLETED && session.state !== SESSION_STATE.CANCELLED;
}

/**
 * 让指定任务的时段与它的剩余工作量对齐。
 *
 * @param {object} state 当前状态（不会被就地修改）
 * @param {string} taskId
 * @param {object} options
 * @param {string} options.nowIso 取消时段时写入的更新时间
 * @returns {{state: object, repairs: object[]}}
 */
export function reconcileTaskSessions(state, taskId, { nowIso }) {
  const task = (state.tasks ?? []).find((item) => item.id === taskId);
  const repairs = [];
  if (!task) return { state, repairs };

  const own = (state.sessions ?? []).filter((session) => session.taskId === taskId);
  const pending = own.filter(isPending);
  if (pending.length === 0) return { state, repairs };

  // 情况 1：任务已经不需要再做 → 未完成时段全部取消（已完成的保留为历史）
  if (isClosedTask(task)) {
    const cancelledIds = new Set(pending.map((session) => session.id));
    return {
      state: {
        ...state,
        sessions: (state.sessions ?? []).map((session) =>
          cancelledIds.has(session.id)
            ? { ...session, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: nowIso }
            : session,
        ),
      },
      repairs: [
        {
          code: REPAIR_CODE.TASK_CLOSED,
          taskId,
          taskTitle: task.title,
          detail: `任务「${task.title}」已${statusText(task.status)}，其 ${pending.length} 个未完成的学习时段已取消（已完成的学习记录保留）。`,
          cancelledCount: pending.length,
        },
      ],
    };
  }

  // 情况 2：未完成时段合计超过剩余工作量 → 取消超出部分
  const remaining = remainingMinutesForTask(task, state.sessions ?? []);
  const pendingMinutes = pending.reduce((sum, session) => sum + (session.plannedMinutes ?? 0), 0);
  if (pendingMinutes <= remaining) return { state, repairs };

  // 确定性顺序：先取消"日期最晚、开始最晚"的时段，尽量保住近期的安排。
  // （顺序固定，因此同一份数据每次修复结果都一样，便于测试与排查。）
  const ordered = [...pending].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.startMinutes !== b.startMinutes) return b.startMinutes - a.startMinutes;
    return a.id < b.id ? 1 : -1;
  });

  let excess = pendingMinutes - remaining;
  const cancelledIds = new Set();
  for (const session of ordered) {
    if (excess <= 0) break;
    cancelledIds.add(session.id);
    excess -= session.plannedMinutes ?? 0;
  }

  return {
    state: {
      ...state,
      sessions: (state.sessions ?? []).map((session) =>
        cancelledIds.has(session.id)
          ? { ...session, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: nowIso }
          : session,
      ),
    },
    repairs: [
      {
        code: REPAIR_CODE.OVER_SCHEDULED,
        taskId,
        taskTitle: task.title,
        detail: `任务「${task.title}」的未完成时段（${pendingMinutes} 分钟）超过了剩余工作量（${remaining} 分钟），已取消 ${cancelledIds.size} 个最晚的时段。`,
        cancelledCount: cancelledIds.size,
      },
    ],
  };
}

/**
 * 修复整份数据里所有可自动修复的不一致。
 *
 * 用于**加载旧数据**：用户的数据可能因为历史缺陷已经不一致，
 * 直接判定"无法读取"会让整个应用显示为空，这比修复更糟。
 * 这里逐项修复并返回完整的修复报告，由界面如实告知用户改了什么。
 *
 * 不做的事（有意为之）：
 * - 不删除任何已完成的时段（学习历史必须保留）；
 * - 不猜测用户的意图去"补"任务或时段；
 * - 不修改任务状态（状态由用户决定）。
 *
 * @param {object} state
 * @param {{nowIso: string}} options
 * @returns {{state: object, repairs: object[], changed: boolean}}
 */
export function reconcileState(state, { nowIso }) {
  let current = state;
  const repairs = [];

  /* 1) 悬空的未完成时段：引用的任务已不存在 */
  const taskIds = new Set((current.tasks ?? []).map((task) => task.id));
  const danglingPending = (current.sessions ?? []).filter(
    (session) => !taskIds.has(session.taskId) && isPending(session),
  );
  if (danglingPending.length > 0) {
    const ids = new Set(danglingPending.map((session) => session.id));
    current = {
      ...current,
      sessions: (current.sessions ?? []).map((session) =>
        ids.has(session.id) ? { ...session, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: nowIso } : session,
      ),
    };
    repairs.push({
      code: REPAIR_CODE.DANGLING_SESSION,
      detail: `有 ${danglingPending.length} 个学习时段指向已经不存在的任务，已取消这些时段。`,
      cancelledCount: danglingPending.length,
    });
  }

  /* 2) 已完成时长超过预计总用时 → 上调预计总用时以保留学习记录 */
  current = {
    ...current,
    tasks: (current.tasks ?? []).map((task) => {
      const completed = completedMinutesForTask(task.id, current.sessions ?? []);
      if (!Number.isInteger(task.plannedMinutes) || completed <= task.plannedMinutes) return task;
      repairs.push({
        code: REPAIR_CODE.OVER_COMPLETED,
        taskId: task.id,
        taskTitle: task.title,
        detail: `任务「${task.title}」的已完成时长（${completed} 分钟）超过预计总用时，已把预计总用时调整为 ${completed} 分钟以保留学习记录。`,
        from: task.plannedMinutes,
        to: completed,
      });
      return { ...task, plannedMinutes: completed };
    }),
  };

  /* 3) 逐任务对齐时段与剩余工作量 */
  for (const task of current.tasks ?? []) {
    const result = reconcileTaskSessions(current, task.id, { nowIso });
    current = result.state;
    repairs.push(...result.repairs);
  }

  return { state: current, repairs, changed: repairs.length > 0 };
}

/**
 * 把修复报告整理成一句用户能读懂的话（用于通知与加载提示）。
 * @param {object[]} repairs
 */
export function describeRepairs(repairs) {
  if (!repairs || repairs.length === 0) return '';
  const cancelled = repairs.reduce((sum, repair) => sum + (repair.cancelledCount ?? 0), 0);
  const parts = [];
  if (cancelled > 0) parts.push(`取消了 ${cancelled} 个与任务不一致的未完成时段`);
  const raised = repairs.filter((repair) => repair.code === REPAIR_CODE.OVER_COMPLETED).length;
  if (raised > 0) parts.push(`调整了 ${raised} 个任务的预计总用时以保留学习记录`);
  return parts.length > 0
    ? `已自动修正数据：${parts.join('，')}。已完成的学习记录都被保留。`
    : '已自动修正数据不一致。';
}

function statusText(status) {
  if (status === TASK_STATUS.COMPLETED) return '完成';
  if (status === TASK_STATUS.CANCELLED) return '取消';
  if (status === TASK_STATUS.DELETED) return '删除';
  return '关闭';
}
