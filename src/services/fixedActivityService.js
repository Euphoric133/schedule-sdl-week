/**
 * 固定活动业务服务：课程、睡眠、用餐、社团等"不可移动的时间占用"。
 *
 * 与任务一样，所有修改都**先生成候选计划预览**，由用户确认后才写入：
 * 固定活动直接改变可用时间，改错会波及整份计划，因此必须让用户先看到影响。
 */

import { FIXED_ACTIVITY_TYPE, FIXED_ACTIVITY_TYPE_LABELS_ZH, occursOn } from '../domain/fixedActivity.js';
import { addDays, splitOvernightSpan } from '../domain/time.js';
import { weekday } from '../domain/time.js';
import { VALIDATION_CODES as C, error } from '../domain/validation.js';

/**
 * @param {object} options
 * @param {ReturnType<import('./appState.js').createAppState>} options.app
 * @param {{ next: (kind: string) => string }} options.idFactory
 */
export function createFixedActivityService({ app }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createFixedActivityService 需要 app 状态容器');

  function list() {
    return [...(app.getState()?.fixedActivities ?? [])].sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
      return a.id < b.id ? -1 : 1;
    });
  }

  function get(id) {
    return (app.getState()?.fixedActivities ?? []).find((activity) => activity.id === id) ?? null;
  }

  /** 判断某个固定活动是否在某天生效（界面预览"本周实际占用"时使用） */
  function occursOnDate(id, date) {
    const activity = get(id);
    return activity ? occursOn(activity, date) : false;
  }

  /**
   * 影响面评估：删除或修改一个固定活动会减少/增加多少可用时间。
   * 用于确认弹窗里给出真实数字，而不是模糊的"确定要删除吗"。
   */
  function evaluateImpact(id, dateRange) {
    const activity = get(id);
    if (!activity) {
      return { ok: false, issues: [error(C.REQUIRED, 'fixedActivity', '固定活动不存在。', { activityId: id })] };
    }
    const length = activity.endMinutes - activity.startMinutes;
    const dates = dateRange ?? [];
    const affectedDates = dates.filter((date) => occursOn(activity, date));

    return {
      ok: true,
      impact: {
        activityId: id,
        title: activity.title,
        type: activity.type,
        typeLabel: FIXED_ACTIVITY_TYPE_LABELS_ZH[activity.type] ?? activity.type,
        minutesPerOccurrence: length,
        occurrencesInWindow: affectedDates.length,
        totalMinutesInWindow: affectedDates.length * length,
        affectedDates,
        recurrenceText: describeRecurrence(activity),
        message:
          affectedDates.length === 0
            ? `「${activity.title}」在当前七天窗口内不会生效，删除它不会改变本周安排。`
            : `删除「${activity.title}」会让这七天多出 ${affectedDates.length * length} 分钟可用时间（${affectedDates.length} 次 × ${length} 分钟）。`,
      },
    };
  }

  /** 人类可读的重复规则说明 */
  function describeRecurrence(activity) {
    if (!activity?.recurrence) return '未设置';
    if (activity.recurrence.kind === 'once') return `仅 ${activity.recurrence.date}`;
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return `每${(activity.recurrence.daysOfWeek ?? []).map((day) => names[day - 1]).join('、')}`;
  }

  /** 按类型分组统计（界面总览用） */
  function summary() {
    const byType = new Map();
    for (const activity of list()) {
      const key = activity.type ?? FIXED_ACTIVITY_TYPE.OTHER;
      if (!byType.has(key)) byType.set(key, { type: key, label: FIXED_ACTIVITY_TYPE_LABELS_ZH[key] ?? key, count: 0 });
      byType.get(key).count += 1;
    }
    return [...byType.values()].sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
  }

  /**
   * 某天要显示的固定任务片段（按开始时间排序）。
   *
   * 跨午夜的固定任务（例如 22:00 → 次日 06:00）必须**按日期拆开**：
   * 当天显示 22:00–24:00，次日显示 00:00–06:00。
   * 以前这里直接返回原始活动（end < start），时间轴/看板会把它当成
   * "22:00 到 06:00"这样跨天的区间，导致显示错位与"跨午夜处理不正确"。
   */
  function forDate(date) {
    const fragments = [];
    // 还要看"前一天"的发生：周四 22:00 → 周五 06:00 的尾部属于周五，
    // 但重复规则只写在周四上。因此必须从 date 与 date-1 两个基数各展开一次，
    // 再按**片段自身日期**过滤，才既不会漏掉跨夜尾部，也不会重复计入。
    const baseDates = [addDays(date, -1), date];

    for (const activity of list()) {
      for (const baseDate of baseDates) {
        if (!occursOn(activity, baseDate)) continue;
        for (const part of splitOvernightSpan({
          date: baseDate,
          startMinutes: activity.startMinutes,
          endMinutes: activity.endMinutes,
        })) {
          if (part.date !== date) continue;
          fragments.push({
            ...activity,
            date,
            startMinutes: part.startMinutes,
            endMinutes: part.endMinutes,
            /** 原始活动是否跨午夜（模型约定：跨夜时 endMinutes > 1440） */
            spansMidnight: activity.endMinutes > 1440,
          });
        }
      }
    }
    return fragments.sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
  }

  /** 是否周末（展示用，不参与硬约束） */
  function isWeekendDate(date) {
    const day = weekday(date);
    return day === 6 || day === 7;
  }

  return { list, get, describeRecurrence, evaluateImpact, summary, forDate, occursOnDate, isWeekendDate };
}
