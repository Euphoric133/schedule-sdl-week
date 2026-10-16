/**
 * 固定活动业务服务：课程、睡眠、用餐、社团等"不可移动的时间占用"。
 *
 * 与任务一样，所有修改都**先生成候选计划预览**，由用户确认后才写入：
 * 固定活动直接改变可用时间，改错会波及整份计划，因此必须让用户先看到影响。
 */

import { FIXED_ACTIVITY_TYPE, FIXED_ACTIVITY_TYPE_LABELS_ZH, occursOn } from '../domain/fixedActivity.js';
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

  /** 某天的全部固定活动（按开始时间排序），供每日视图展示 */
  function forDate(date) {
    return list()
      .filter((activity) => occursOn(activity, date))
      .sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /** 是否周末（展示用，不参与硬约束） */
  function isWeekendDate(date) {
    const day = weekday(date);
    return day === 6 || day === 7;
  }

  return { list, get, describeRecurrence, evaluateImpact, summary, forDate, occursOnDate, isWeekendDate };
}
