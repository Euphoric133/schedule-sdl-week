/**
 * 界面文案映射：把内部枚举值翻译成用户能读懂的中文。
 *
 * 为什么单独放一个模块：
 * 内部原因码（如 `insufficient_capacity`）、触发来源（如 `week-page`）是给程序看的，
 * 直接渲染到界面上等于把实现细节丢给用户。所有这类翻译集中在这里，
 * 新增枚举值时只需要补一行，并且有测试保证"每个枚举值都有中文文案"。
 */

import { UNSCHEDULED_REASON } from '../engine/policy.js';

/** 无法安排的原因（内部码 → 用户文案） */
export const REASON_LABELS_ZH = Object.freeze({
  [UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY]: '可用时间不足',
  [UNSCHEDULED_REASON.TAIL_TOO_SMALL]: '剩余时长过短',
  [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY]: '等待前置任务',
  [UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE]: '前置任务已失效',
  [UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT]: '没有足够长的连续空档',
  [UNSCHEDULED_REASON.DEADLINE_PASSED]: '截止时间已过',
  [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: '可学习时间过窄',
  [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: '已达每日上限',
  [UNSCHEDULED_REASON.OVERLOADED]: '总工作量超过可用时间',
});

/** 计划的调整来源（内部触发标识 → 用户文案） */
export const TRIGGER_LABELS_ZH = Object.freeze({
  'week-page': '七天计划页',
  'today-page': '今日总览',
  'day-page': '每日视图',
  'tasks-page': '任务列表',
  'task-form': '任务表单',
  'preview-page': '调整预览页',
  'preview-confirm': '确认应用',
  'preview-empty': '调整预览页',
  'activity-form': '固定活动表单',
  'activities-page': '固定活动页',
  'settings-page': '偏好设置',
  'settings-editor': '偏好设置',
  'session-detail': '时段详情',
  'focus-workbench': '专注工作台',
  'window-shift': '计划窗口滚动',
  shortcut: '键盘快捷键',
  ui: '界面操作',
  manual: '手动操作',
});

/** 安排原因（放位原因码 → 用户文案） */
export const PLACEMENT_REASON_LABELS_ZH = Object.freeze({
  preferred_focus_window: '落在你设置的偏好专注时段',
  same_subject_continuity: '与同科目时段相邻，减少科目切换',
  slot_fit: '与空闲时段长度贴合',
  earlier_slot: '安排在当日较早时间',
  urgent_deadline: '截止时间临近，优先安排',
  high_priority: '优先级较高',
  undersized_final_chunk: '该任务最后的收尾片段',
  dependency_order: '按前置任务顺序安排',
  spillover_to_next_day: '当日容量不足，顺延到之后日期',
  carry_over_reserved: '承接已锁定或已完成的部分',
});

/** 取中文文案，缺失时给一个中性兜底（绝不把内部码显示给用户） */
export function reasonLabel(code) {
  return REASON_LABELS_ZH[code] ?? '暂时无法安排';
}

export function triggerLabel(code) {
  return TRIGGER_LABELS_ZH[code] ?? '手动操作';
}

export function placementReasonLabel(code) {
  return PLACEMENT_REASON_LABELS_ZH[code] ?? '系统按优先级自动安排';
}

/** 校验问题的用户可见文本：只给中文消息，不带内部错误码与字段路径 */
export function issueMessage(issue) {
  if (!issue) return '出现了未知问题。';
  return issue.message ?? String(issue);
}
