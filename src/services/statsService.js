/**
 * 学习统计服务。
 *
 * 唯一的数据来源是**真实记录**：已完成的学习时段（`sessions`）、
 * 番茄钟记录（`focusRecords`）、奖励历史（`rewardHistory`）、任务状态。
 * 这里不读取计划、不估算、不为了"图表好看"补数字——
 * 没有数据时如实返回 0，并告诉界面该怎么显示空状态。
 */

import { addDays, dateRange, diffDays, weekday } from '../domain/time.js';
import { TASK_STATUS, completedMinutesForTask, remainingMinutesForTask } from '../domain/task.js';

/** 一天的统计聚合 */
export function aggregateDay(state, date) {
  const sessions = (state.sessions ?? []).filter((session) => session.date === date && session.state !== 'cancelled');
  const completed = sessions.filter((session) => session.state === 'completed');
  const plannedMinutes = sessions.reduce((sum, session) => sum + (session.plannedMinutes ?? 0), 0);
  const actualMinutes = completed.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
  const focusRecords = (state.focusRecords ?? []).filter((record) => record.date === date);
  const focusCompleted = focusRecords.filter((record) => record.completed);

  const bySubject = new Map();
  for (const session of completed) {
    const task = (state.tasks ?? []).find((item) => item.id === session.taskId);
    const subject = task?.subject ?? '未分类';
    const minutes = session.actualMinutes ?? session.plannedMinutes ?? 0;
    bySubject.set(subject, (bySubject.get(subject) ?? 0) + minutes);
  }

  return {
    date,
    plannedMinutes,
    actualMinutes,
    completedSessions: completed.length,
    totalSessions: sessions.length,
    scheduledMinutes: plannedMinutes,
    pomodoroCompleted: focusCompleted.length,
    pomodoroEarly: focusRecords.length - focusCompleted.length,
    focusedMinutes: Math.round(focusRecords.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
    bySubject: [...bySubject.entries()].map(([subject, minutes]) => ({ subject, minutes })).sort((a, b) => b.minutes - a.minutes),
  };
}

/** 连续学习天数：从今天（或昨天）往回数，有真实完成记录才算 */
export function computeStreak(state, today) {
  const days = new Set((state.sessions ?? []).filter((s) => s.state === 'completed').map((s) => s.date));
  for (const record of state.focusRecords ?? []) {
    if (record.completed) days.add(record.date);
  }
  if (days.size === 0) return { current: 0, longest: 0, lastActiveDate: null, activeDays: 0 };

  // 当前连续：允许"今天还没开始"，从昨天开始算，避免早上一睁眼就断签
  let current = 0;
  let cursor = days.has(today) ? today : addDays(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  // 历史最长：把所有活跃日期排序后找最长连续段
  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (diffDays(sorted[index - 1], sorted[index]) === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }

  return {
    current,
    longest: Math.max(longest, current),
    lastActiveDate: sorted[sorted.length - 1],
    activeDays: days.size,
  };
}

/**
 * @param {object} options
 * @param {object} options.app 业务状态容器
 * @param {Function} options.now 返回 { date, minutes }
 */
export function createStatsService({ app, now }) {
  /** 最近 N 天的逐日统计（含今天），用于柱状图与折线 */
  function daily({ days = 7, endDate } = {}) {
    const state = app.getState();
    const end = endDate ?? now().date;
    const dates = dateRange(addDays(end, -(days - 1)), end);
    return dates.map((date) => aggregateDay(state, date));
  }

  /** 本周（周一到周日）与上周对比 */
  function weekly() {
    const state = app.getState();
    const today = now().date;
    const weekdayIndex = weekday(today); // 1 = 周一
    const monday = addDays(today, -(weekdayIndex - 1));
    const thisWeek = dateRange(monday, addDays(monday, 6));
    const lastMonday = addDays(monday, -7);
    const lastWeek = dateRange(lastMonday, addDays(lastMonday, 6));

    const sum = (dates) =>
      dates.reduce(
        (total, date) => {
          const day = aggregateDay(state, date);
          return {
            plannedMinutes: total.plannedMinutes + day.plannedMinutes,
            actualMinutes: total.actualMinutes + day.actualMinutes,
            completedSessions: total.completedSessions + day.completedSessions,
            pomodoroCompleted: total.pomodoroCompleted + day.pomodoroCompleted,
          };
        },
        { plannedMinutes: 0, actualMinutes: 0, completedSessions: 0, pomodoroCompleted: 0 },
      );

    return {
      weekStart: monday,
      weekEnd: addDays(monday, 6),
      thisWeek: sum(thisWeek.filter((date) => date <= today)),
      lastWeek: sum(lastWeek),
      days: thisWeek.map((date) => aggregateDay(state, date)),
    };
  }

  /** 按科目汇总（全部历史） */
  function bySubject() {
    const state = app.getState();
    const totals = new Map();
    for (const session of state.sessions ?? []) {
      if (session.state !== 'completed') continue;
      const task = (state.tasks ?? []).find((item) => item.id === session.taskId);
      const subject = task?.subject ?? '未分类';
      const minutes = session.actualMinutes ?? session.plannedMinutes ?? 0;
      totals.set(subject, (totals.get(subject) ?? 0) + minutes);
    }
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
    return [...totals.entries()]
      .map(([subject, minutes]) => ({ subject, minutes, share: total > 0 ? minutes / total : 0 }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  /** 任务完成情况：完成率、逾期、未安排 */
  function tasks() {
    const state = app.getState();
    const today = now().date;
    const list = (state.tasks ?? []).filter((task) => task.status !== TASK_STATUS.DELETED);
    const completed = list.filter((task) => task.status === TASK_STATUS.COMPLETED);
    const cancelled = list.filter((task) => task.status === TASK_STATUS.CANCELLED);
    const active = list.filter((task) => task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS);

    const overdue = active.filter((task) => task.deadlineDate && task.deadlineDate < today);
    const dueToday = active.filter((task) => task.deadlineDate === today);
    const considered = list.length - cancelled.length;

    return {
      total: list.length,
      completed: completed.length,
      cancelled: cancelled.length,
      active: active.length,
      overdue: overdue.map((task) => ({
        id: task.id,
        title: task.title,
        deadlineDate: task.deadlineDate,
        remainingMinutes: remainingMinutesForTask(task, state.sessions ?? []),
        daysLate: task.deadlineDate ? diffDays(task.deadlineDate, today) : 0,
      })),
      dueToday: dueToday.map((task) => ({ id: task.id, title: task.title, remainingMinutes: remainingMinutesForTask(task, state.sessions ?? []) })),
      completionRate: considered > 0 ? completed.length / considered : null,
      progress: active.map((task) => {
        const done = completedMinutesForTask(task, state.sessions ?? []);
        return {
          id: task.id,
          title: task.title,
          subject: task.subject,
          plannedMinutes: task.plannedMinutes,
          completedMinutes: done,
          remainingMinutes: Math.max(0, task.plannedMinutes - done),
          ratio: task.plannedMinutes > 0 ? Math.min(1, done / task.plannedMinutes) : 0,
        };
      }),
    };
  }

  /** 专注轮数统计（区分"完成"与"中途结束"） */
  function focus({ days = 30 } = {}) {
    const state = app.getState();
    const today = now().date;
    const from = addDays(today, -(days - 1));
    const records = (state.focusRecords ?? []).filter((record) => record.date >= from && record.date <= today);
    const completed = records.filter((record) => record.completed);
    const early = records.filter((record) => !record.completed);

    // 按天分布（用于图表）
    const byDay = new Map();
    for (const record of records) {
      const entry = byDay.get(record.date) ?? { date: record.date, completed: 0, early: 0, minutes: 0 };
      if (record.completed) entry.completed += 1;
      else entry.early += 1;
      entry.minutes += Math.round((record.focusedSeconds ?? 0) / 60);
      byDay.set(record.date, entry);
    }

    // 按任务分布（谁最消耗专注）
    const byTask = new Map();
    for (const record of records) {
      const key = record.taskTitle ?? '（未关联任务）';
      byTask.set(key, (byTask.get(key) ?? 0) + Math.round((record.focusedSeconds ?? 0) / 60));
    }

    return {
      totalRounds: records.length,
      completedRounds: completed.length,
      earlyEndedRounds: early.length,
      totalMinutes: Math.round(records.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
      completedMinutes: Math.round(completed.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60),
      averageCompletedMinutes: completed.length > 0 ? Math.round(completed.reduce((sum, r) => sum + (r.focusedSeconds ?? 0), 0) / 60 / completed.length) : 0,
      completionRate: records.length > 0 ? completed.length / records.length : null,
      days: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      byTask: [...byTask.entries()].map(([taskTitle, minutes]) => ({ taskTitle, minutes })).sort((a, b) => b.minutes - a.minutes),
    };
  }

  /** 奖励统计 */
  function rewards() {
    const state = app.getState();
    const entries = state.rewardHistory ?? [];
    const today = now().date;
    const byLabel = new Map();
    for (const entry of entries) byLabel.set(entry.label, (byLabel.get(entry.label) ?? 0) + 1);
    return {
      total: entries.length,
      today: entries.filter((entry) => entry.date === today).length,
      last7Days: entries.filter((entry) => entry.date >= addDays(today, -6)).length,
      claimed: entries.filter((entry) => entry.claimedAt).length,
      byLabel: [...byLabel.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    };
  }

  /** 今日概览（首页使用） */
  function today() {
    const state = app.getState();
    const date = now().date;
    const day = aggregateDay(state, date);
    const streak = computeStreak(state, date);
    const taskStats = tasks();
    return { ...day, streak, tasks: taskStats };
  }

  /** 是否完全没有数据（界面据此显示"还没有可统计的数据"而不是一堆 0 的图） */
  function hasAnyData() {
    const state = app.getState();
    return (
      (state.sessions ?? []).some((session) => session.state === 'completed') ||
      (state.focusRecords ?? []).length > 0 ||
      (state.rewardHistory ?? []).length > 0
    );
  }

  return { daily, weekly, bySubject, tasks, focus, rewards, today, hasAnyData, aggregateDay: (date) => aggregateDay(app.getState(), date) };
}
