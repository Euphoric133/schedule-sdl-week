/**
 * SchedulePlan（正式计划 / 候选计划）领域模型与容量计算。
 *
 * 术语：
 * - 正式计划（officialPlan）：用户已确认、当前生效的计划，只有一个。
 * - 候选计划（candidate）：引擎生成、等待用户确认的计划，不写入正式计划。
 * - 计划快照（PlanSnapshot）：历史版本，用于撤销。
 *
 * 关键规则（对应硬约束 H8/H10 与需求中的"缓冲"定义）：
 * - netCapacity(d)  = studyWindows 时长 − 固定活动 − 锁定/进行中/已完成时段（已合并去重）
 * - bufferMinutes(d)= floor(netCapacity(d) × bufferRatio)      ← 逐日 10%，不跨日挪用
 * - schedulable(d)  = netCapacity(d) − bufferMinutes(d)
 * - 计划休息（rest）是引擎实际插入的块，与机动缓冲是**两个不同 kind**，统计分开、区间不重叠。
 */

import { VALIDATION_CODES as C, error, isPlainObject, result } from './validation.js';
import {
  addDays,
  dateRange,
  isOverlapping,
  MINUTES_PER_DAY,
  parseTimeString,
  splitOvernightSpan,
  weekday,
} from './time.js';
import { BLOCK_KIND, groupBlocksByDate, validateBlocks } from './calendarBlock.js';
import { mergeSpans } from './fixedActivity.js';

/** 可行性状态 */
export const PLAN_STATUS = Object.freeze({
  FEASIBLE: 'feasible', // 完整满足要求
  PARTIALLY_FEASIBLE: 'partially_feasible', // 部分任务可安排
  INFEASIBLE: 'infeasible', // 当前约束下不存在完整可行计划
  INVALID_INPUT: 'invalid_input', // 输入错误 / 缺少必要信息 / 数据自相矛盾
});

export const PLAN_STATUS_VALUES = Object.freeze(Object.values(PLAN_STATUS));

export const PLAN_STATUS_LABELS_ZH = Object.freeze({
  feasible: '完整可行',
  partially_feasible: '部分可行',
  infeasible: '不可行',
  invalid_input: '输入不合法',
});

/** 默认规划窗口天数 */
export const PLAN_WINDOW_DAYS = 7;

/** 引擎版本：任何会改变排程结果的算法改动都必须递增，用于预览过期检测与结果对照 */
export const ENGINE_VERSION = 'engine@0.1.0';

/** 计算从 startDate 开始的七天（含当天）窗口 */
export function planWindow(startDate, days = PLAN_WINDOW_DAYS) {
  return { startDate, endDate: addDays(startDate, days - 1), days };
}

/** 空计划：新用户尚未确认任何计划时的初始状态（不是"假计划"，所有统计为 0） */
export function createEmptyPlan({ planId, version = 0, windowStart, days = PLAN_WINDOW_DAYS, nowIso, policyHash = null }) {
  const window = planWindow(windowStart, days);
  return {
    planId,
    version,
    status: PLAN_STATUS.FEASIBLE,
    generatedAt: nowIso,
    windowStart: window.startDate,
    windowEnd: window.endDate,
    engineVersion: ENGINE_VERSION,
    policyHash,
    inputHash: null,
    blocks: [],
    sessionIds: [],
    days: window_range_days(window.startDate, window.endDate).map((date) => emptyDayMetrics(date)),
    unscheduled: [],
    diagnostics: [],
    metrics: { totalStudyMinutes: 0, totalTaskRemainingMinutes: 0, bufferReservedMinutes: 0, restMinutes: 0, subjectSwitches: 0 },
  };
}

function window_range_days(startDate, endDate) {
  return dateRange(startDate, endDate);
}

/** 单日统计的零值结构（days 数组的元素形状，UI 依赖它保持稳定） */
export function emptyDayMetrics(date) {
  return {
    date,
    weekday: weekday(date),
    windowMinutes: 0,
    fixedMinutes: 0,
    reservedMinutes: 0,
    netCapacityMinutes: 0,
    bufferMinutes: 0,
    bufferUsedMinutes: 0,
    schedulableMinutes: 0,
    studyMinutes: 0,
    restMinutes: 0,
    sessionCount: 0,
    overloadMinutes: 0,
    freeWindows: [],
  };
}

/* ------------------------------------------------------------------ *
 * 区间运算
 * ------------------------------------------------------------------ */

/** 把区间裁剪到 [0, MINUTES_PER_DAY)（跨夜段由调用方先切分） */
function clipToDay(span) {
  const start = Math.max(0, span.startMinutes);
  const end = Math.min(MINUTES_PER_DAY, span.endMinutes);
  return end > start ? { date: span.date, startMinutes: start, endMinutes: end } : null;
}

/**
 * 把「按星期配置的允许窗口」规范化为**某一天内**的窗口列表。
 *
 * 必须处理跨夜：窗口 22:00–02:00 属于开始日的配置，但 00:00–02:00 的可用时间实际落在下一天。
 * 因此某一天的可学习时间是「前一天的跨夜尾部」∪「当天的窗口」。
 * 不这样做，跨夜窗口会凭空多出或丢失可用分钟数。
 *
 * @param {string} date 目标日期
 * @param {Record<number, Array<{startMinutes?:number,endMinutes?:number,start?:string,end?:string}>>} studyWindows
 * @returns {Array<{startMinutes:number,endMinutes:number}>} 该日内的窗口（升序、已合并）
 */
export function normalizeDayWindows(date, studyWindows) {
  const sources = [];
  const candidates = [
    { key: addDays(date, -1), carryOver: true },
    { key: date, carryOver: false },
  ];
  for (const { key, carryOver } of candidates) {
    const list = studyWindows?.[weekday(key)] ?? [];
    for (const w of list) {
      const startMinutes = typeof w.startMinutes === 'number' ? w.startMinutes : parseTimeString(w.start);
      let endMinutes = typeof w.endMinutes === 'number' ? w.endMinutes : parseTimeString(w.end);
      if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY; // 跨夜
      for (const part of splitOvernightSpan({ date: key, startMinutes, endMinutes })) {
        if (part.date !== date) continue; // 只保留落在目标日的片段
        // 前一天窗口的"当天部分"仅是 00:00 之后的尾部，标志为 carryOver 便于诊断
        sources.push({ date, startMinutes: part.startMinutes, endMinutes: part.endMinutes, carryOver });
      }
    }
  }
  return mergeSpans(sources).map(({ startMinutes, endMinutes }) => ({ startMinutes, endMinutes }));
}

/**
 * 计算某天的空闲区间：允许窗口 − 已占用（固定活动 + 保留时段），并做重叠合并。
 * @param {string} date
 * @param {Array<{startMinutes:number,endMinutes:number}>} windows 当日允许窗口（已在当日坐标系内）
 * @param {Array<{date:string,startMinutes:number,endMinutes:number}>} occupied
 * @returns {Array<{startMinutes:number,endMinutes:number}>} 升序、互不重叠的空闲区间
 */
export function computeFreeWindows(date, windows, occupied) {
  const dayWindows = mergeSpans(
    windows
      .map((w) => ({ date, startMinutes: w.startMinutes, endMinutes: w.endMinutes }))
      .map(clipToDay)
      .filter(Boolean),
  ).filter((w) => w.date === date);

  const blocked = mergeSpans(
    occupied
      .filter((s) => s.date === date)
      .map(clipToDay)
      .filter(Boolean),
  ).filter((s) => s.date === date);

  const free = [];
  for (const win of dayWindows) {
    let cursor = win.startMinutes;
    for (const block of blocked) {
      if (block.endMinutes <= cursor) continue;
      if (block.startMinutes >= win.endMinutes) break;
      if (block.startMinutes > cursor) {
        free.push({ startMinutes: cursor, endMinutes: Math.min(block.startMinutes, win.endMinutes) });
      }
      cursor = Math.max(cursor, block.endMinutes);
      if (cursor >= win.endMinutes) break;
    }
    if (cursor < win.endMinutes) free.push({ startMinutes: cursor, endMinutes: win.endMinutes });
  }
  return free.filter((f) => f.endMinutes > f.startMinutes);
}

/**
 * 计算每日容量与缓冲。
 *
 * @param {object} params
 * @param {string} params.date
 * @param {Record<number, Array<{startMinutes:number,endMinutes:number}>>} params.studyWindows 按星期（1–7）给出的允许窗口
 * @param {Array} params.fixedSpans expandFixedActivities 的结果（已按日切分）
 * @param {Array} params.occupiedSpans 锁定 / 进行中 / 已完成时段（硬保留）
 * @param {number} params.bufferRatio 机动缓冲比例（默认 0.10）
 * @returns {object} 单日容量明细（含 freeWindows，供引擎放位使用）
 */
export function computeDayCapacity({ date, studyWindows, fixedSpans, occupiedSpans = [], bufferRatio = 0.1 }) {
  const windows = normalizeDayWindows(date, studyWindows);
  const windowMinutes = windows.reduce((sum, w) => sum + (w.endMinutes - w.startMinutes), 0);

  const fixedDay = mergeSpans(fixedSpans.filter((s) => s.date === date).map(clipToDay).filter(Boolean));
  const reservedDay = mergeSpans(occupiedSpans.filter((s) => s.date === date).map(clipToDay).filter(Boolean));
  const occupied = mergeSpans([...fixedDay, ...reservedDay]);

  const freeWindows = computeFreeWindows(date, windows, [...fixedSpans, ...occupiedSpans]);
  const netCapacityMinutes = freeWindows.reduce((sum, f) => sum + (f.endMinutes - f.startMinutes), 0);
  const bufferMinutes = Math.floor(netCapacityMinutes * bufferRatio);
  const fixedMinutes = fixedDay.reduce((sum, s) => sum + (s.endMinutes - s.startMinutes), 0);
  const reservedMinutes = reservedDay.reduce((sum, s) => sum + (s.endMinutes - s.startMinutes), 0);

  return {
    ...emptyDayMetrics(date),
    windowMinutes,
    fixedMinutes,
    reservedMinutes,
    netCapacityMinutes,
    bufferMinutes,
    schedulableMinutes: netCapacityMinutes - bufferMinutes,
    freeWindows,
    // 合并后的占用仅用于调试与后续放位校验，避免调用方重复计算
    mergedOccupied: occupied,
  };
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/**
 * 由块集合汇总窗口统计。
 * 注意 buffer 与 rest 分别累加（H8：不得重复计算）。
 */
export function computePlanMetrics(blocks) {
  const metrics = {
    totalStudyMinutes: 0,
    totalTaskRemainingMinutes: 0,
    bufferReservedMinutes: 0,
    restMinutes: 0,
    subjectSwitches: 0,
  };
  const byDate = groupBlocksByDate(blocks);
  for (const [, list] of byDate) {
    let lastSubject = null;
    for (const block of list) {
      const length = block.endMinutes - block.startMinutes;
      if (block.kind === BLOCK_KIND.STUDY) {
        metrics.totalStudyMinutes += length;
        if (lastSubject !== null && block.subject !== lastSubject) metrics.subjectSwitches += 1;
        if (block.subject) lastSubject = block.subject;
      } else if (block.kind === BLOCK_KIND.REST) {
        metrics.restMinutes += length;
      } else if (block.kind === BLOCK_KIND.BUFFER) {
        metrics.bufferReservedMinutes += length;
      }
    }
  }
  return metrics;
}

/** 校验计划结构（供引擎与存储层复用） */
export function validatePlan(plan, path = 'plan') {
  const issues = [];
  if (!isPlainObject(plan)) {
    return result([error(C.TYPE, path, '计划必须是一个对象。', { actual: typeof plan })]);
  }
  if (!Number.isInteger(plan.version) || plan.version < 0) {
    issues.push(error(C.RANGE, `${path}.version`, '计划版本号必须是非负整数。', { actual: plan.version }));
  }
  if (!PLAN_STATUS_VALUES.includes(plan.status)) {
    issues.push(error(C.ENUM, `${path}.status`, `计划状态非法：${JSON.stringify(plan.status)}。`, { actual: plan.status }));
  }
  if (!Array.isArray(plan.days) || plan.days.length === 0) {
    issues.push(error(C.REQUIRED, `${path}.days`, '计划必须包含每日统计（days 不能为空）。'));
  } else {
    const expected = dateRange(plan.windowStart, plan.windowEnd);
    if (plan.days.length !== expected.length) {
      issues.push(
        error(C.RANGE, `${path}.days`, `每日统计数量（${plan.days.length}）与窗口天数（${expected.length}）不一致。`, {
          actual: plan.days.length,
          expected: expected.length,
        }),
      );
    }
  }
  if (!Array.isArray(plan.blocks)) {
    issues.push(error(C.TYPE, `${path}.blocks`, 'blocks 必须是数组。'));
  } else {
    issues.push(...validateBlocks(plan.blocks).issues);
  }
  if (!Array.isArray(plan.unscheduled)) {
    issues.push(error(C.TYPE, `${path}.unscheduled`, 'unscheduled 必须是数组。'));
  }
  return result(issues);
}

/** 计划是否被判定为可完整满足 */
export function isFeasible(plan) {
  return plan?.status === PLAN_STATUS.FEASIBLE;
}

/** 判断两个块是否正重叠（用于测试与断言） */
export function blocksOverlap(a, b) {
  if (a.date !== b.date) return false;
  return isOverlapping(a.startMinutes, a.endMinutes, b.startMinutes, b.endMinutes);
}

/** 版本快照：用于撤销 */
export function createPlanSnapshot({ plan, nowIso, changeSummary, trigger = 'manual' }) {
  return {
    version: plan.version,
    planId: plan.planId,
    inputHash: plan.inputHash,
    createdAt: nowIso,
    changeSummary,
    trigger,
    plan,
  };
}
