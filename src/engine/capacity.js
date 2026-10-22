/**
 * 容量计算：把"用户允许学习的时间"减去"已经被占用的时间"，得到可排程的空闲区间。
 *
 * 这是整个排程里最基础也最容易算错的一步。需求中的关键定义在这里落地：
 *
 *   windowMinutes(d)   = 当日允许学习窗口（按星期配置，支持跨午夜）
 *   fixedMinutes(d)    = 固定活动（课程/睡眠/用餐…）合并后的占用
 *   reservedMinutes(d) = 锁定 / 进行中 / 已完成时段的占用（硬保留，H10 / H9）
 *   netCapacity(d)     = windowMinutes − 上述占用（区间合并去重，重叠只扣一次）
 *   bufferMinutes(d)   = floor(netCapacity × bufferRatio)   ← 缓冲功能已移除，恒为 0
 *   schedulable(d)     = netCapacity − buffer             ← 真正可以放任务的分钟数
 *
 * 计划休息与之不同，是引擎实际插入到时间轴上的块。两者分属不同 kind，统计分开、区间不重叠（H8）。
 *
 * 本模块不读取系统时钟、不访问 DOM，全部输入显式传入。
 */

import {
  addDays,
  MINUTES_PER_DAY,
  overlapLength,
  parseTimeString,
  splitOvernightSpan,
  weekday,
} from '../domain/time.js';
import { mergeSpans } from '../domain/fixedActivity.js';
import { DIAGNOSTIC_CODE } from './policy.js';

/* ------------------------------------------------------------------ *
 * 区间运算（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 把区间限制在 [0, MINUTES_PER_DAY) 之内。
 * 跨午夜的区间必须先经 splitOvernightSpan 切成按天的片段。
 */
export function clipSpan(span, date) {
  const start = Math.max(0, span.startMinutes);
  const end = Math.min(MINUTES_PER_DAY, span.endMinutes);
  return end > start ? { date: date ?? span.date, startMinutes: start, endMinutes: end } : null;
}

/** 合并同一天的区间（去重、排序、相邻相接也合并） */
export function mergeDaySpans(spans, date) {
  return mergeSpans(spans.filter((span) => span.date === date).map((span) => clipSpan(span, date)).filter(Boolean)).filter(
    (span) => span.date === date,
  );
}

/**
 * 规范某一天的可学习窗口。
 *
 * 必须考虑跨午夜：窗口 22:00–02:00 是"开始日"的配置，但 00:00–02:00 实际落在下一天。
 * 因此某一天的可学习时间 = 前一天窗口的跨夜尾部 ∪ 当天窗口。
 * 不做这一步，跨午夜窗口会凭空多出或丢失可用分钟数（这是真实踩过的坑）。
 */
export function normalizeStudyWindows(date, studyWindows) {
  const sources = [];
  for (const sourceDate of [addDays(date, -1), date]) {
    const list = studyWindows?.[weekday(sourceDate)] ?? studyWindows?.[String(weekday(sourceDate))] ?? [];
    for (const raw of list) {
      const startMinutes = typeof raw.startMinutes === 'number' ? raw.startMinutes : parseTimeString(raw.start);
      let endMinutes = typeof raw.endMinutes === 'number' ? raw.endMinutes : parseTimeString(raw.end);
      if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY; // 跨夜
      for (const part of splitOvernightSpan({ date: sourceDate, startMinutes, endMinutes })) {
        if (part.date !== date) continue;
        sources.push({ date, startMinutes: part.startMinutes, endMinutes: part.endMinutes });
      }
    }
  }
  return mergeDaySpans(sources, date);
}

/**
 * 从允许窗口里挖掉占用区间，返回空闲区间（升序、互不重叠）。
 *
 * @param {Array<{startMinutes:number,endMinutes:number}>} windows 当日允许窗口
 * @param {Array<{startMinutes:number,endMinutes:number}>} blocked 当日占用（固定活动 + 保留时段）
 */
export function subtractSpans(windows, blocked) {
  const free = [];
  for (const window of windows) {
    let cursor = window.startMinutes;
    for (const block of blocked) {
      if (block.endMinutes <= cursor) continue;
      if (block.startMinutes >= window.endMinutes) break;
      if (block.startMinutes > cursor) {
        free.push({ startMinutes: cursor, endMinutes: Math.min(block.startMinutes, window.endMinutes) });
      }
      cursor = Math.max(cursor, block.endMinutes);
      if (cursor >= window.endMinutes) break;
    }
    if (cursor < window.endMinutes) free.push({ startMinutes: cursor, endMinutes: window.endMinutes });
  }
  return free.filter((span) => span.endMinutes > span.startMinutes);
}

/* ------------------------------------------------------------------ *
 * 每日容量
 * ------------------------------------------------------------------ */

/**
 * 计算窗口内每一天的容量明细。
 *
 * @param {object} params
 * @param {string} params.windowStart
 * @param {string} params.windowEnd
 * @param {Record<number, Array>} params.studyWindows 按星期配置的允许窗口
 * @param {Array} params.fixedSpans 固定活动展开后的片段（按天）
 * @param {Array} params.reservedSpans 锁定 / 进行中 / 已完成时段（按天）
 * @param {number} params.bufferRatio 已废弃，恒为 0（缓冲功能已移除）
 * @returns {Array<object>} 按日期升序的容量明细，元素含 freeWindows 供放位使用
 */
export function computeWindowCapacity({
  windowStart,
  windowEnd,
  studyWindows,
  fixedSpans = [],
  reservedSpans = [],
  bufferRatio = 0,
  /** 本次规划的搜索起点：{ date, minutes }。早于它的时间不会被安排任何学习时段。 */
  searchStart = null,
  /** 当前时间 { date, minutes }：任何早于它的日期一律不产生可用容量（不排过去）。 */
  now = null,
}) {
  const days = [];
  for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
    // 过去的日期不产生新容量：过去只能有历史，不能再被安排
    if (now && date < now.date) {
      days.push(computeDayCapacity({ date, studyWindows, fixedSpans, reservedSpans, bufferRatio, earliestStartMinutes: 1440 }));
      continue;
    }
    const earliestStartMinutes =
      searchStart && searchStart.date === date
        ? Math.max(searchStart.minutes, now && now.date === date ? now.minutes : 0)
        : now && now.date === date
          ? 0
          : 0;
    days.push(computeDayCapacity({ date, studyWindows, fixedSpans, reservedSpans, bufferRatio, earliestStartMinutes }));
  }
  return days;
}

/** 单日容量明细 */
export function computeDayCapacity({ date, studyWindows, fixedSpans = [], reservedSpans = [], bufferRatio = 0, earliestStartMinutes = 0 }) {
  const rawWindows = normalizeStudyWindows(date, studyWindows);
  /**
   * 把允许窗口裁剪到"最早可以开始的时间"之后。
   *
   * 这是"计划开始时间"落地的地方：用户指定（或系统默认推导）一个起点后，
   * 起点之前的时间段不再参与放位，因此不会出现"现在 20:24，却给今天排了 09:00"这种过去时段。
   */
  const windows = Number.isInteger(earliestStartMinutes) && earliestStartMinutes > 0
    ? rawWindows
        .map((window) => ({
          ...window,
          startMinutes: Math.max(window.startMinutes, Math.min(earliestStartMinutes, window.endMinutes)),
        }))
        .filter((window) => window.endMinutes > window.startMinutes)
    : rawWindows;
  const fixedMerged = mergeDaySpans(fixedSpans, date);
  const reservedMerged = mergeDaySpans(reservedSpans, date);
  const occupied = mergeDaySpans([...fixedMerged, ...reservedMerged], date);

  const freeWindows = subtractSpans(windows, occupied);
  const windowMinutes = sumLength(windows);
  const fixedMinutes = sumLength(fixedMerged);
  const reservedMinutes = sumLength(reservedMerged);
  const netCapacityMinutes = sumLength(freeWindows);
  const bufferMinutes = Math.floor(netCapacityMinutes * bufferRatio);

  return {
    date,
    windows,
    freeWindows,
    fixedSpans: fixedMerged,
    reservedSpans: reservedMerged,
    windowMinutes,
    fixedMinutes,
    reservedMinutes,
    netCapacityMinutes,
    bufferMinutes,
    schedulableMinutes: netCapacityMinutes - bufferMinutes,
  };
}

/** 区间数组的总长度（分钟） */
export function sumLength(spans) {
  return spans.reduce((sum, span) => sum + (span.endMinutes - span.startMinutes), 0);
}

/* ------------------------------------------------------------------ *
 * 放位时的空闲区间维护
 * ------------------------------------------------------------------ */

/** 从空闲区间列表中扣除一段已放置的时间，返回新的列表（纯函数，不改动入参） */
export function consumeSlot(freeWindows, startMinutes, endMinutes) {
  const next = [];
  for (const window of freeWindows) {
    if (endMinutes <= window.startMinutes || startMinutes >= window.endMinutes) {
      next.push({ ...window });
      continue;
    }
    if (window.startMinutes < startMinutes) {
      next.push({ startMinutes: window.startMinutes, endMinutes: startMinutes });
    }
    if (endMinutes < window.endMinutes) {
      next.push({ startMinutes: endMinutes, endMinutes: window.endMinutes });
    }
  }
  return next;
}

/** 空闲区间里最长的连续长度（用于判断不可拆分任务能否一次放下） */
export function longestFreeSlot(freeWindows) {
  return freeWindows.reduce((max, window) => Math.max(max, window.endMinutes - window.startMinutes), 0);
}

/** 空闲区间中所有"长度 ≥ need"的槽位 */
export function slotsFitting(freeWindows, need) {
  return freeWindows
    .map((window) => ({ startMinutes: window.startMinutes, endMinutes: window.endMinutes, length: window.endMinutes - window.startMinutes }))
    .filter((slot) => slot.length >= need);
}

/** 某段是否落在偏好专注时段内（软偏好，用于放位评分） */
export function preferredOverlapMinutes(startMinutes, endMinutes, preferredFocusWindows) {
  let total = 0;
  for (const window of preferredFocusWindows ?? []) {
    if (window.endMinutes <= window.startMinutes) continue;
    total += overlapLength(startMinutes, endMinutes, window.startMinutes, window.endMinutes);
  }
  return total;
}

/** 某段是否完全落在允许窗口内（硬约束 H3 的判定基础） */
export function isWithinWindows(date, startMinutes, endMinutes, studyWindows) {
  const windows = normalizeStudyWindows(date, studyWindows);
  return windows.some((window) => startMinutes >= window.startMinutes && endMinutes <= window.endMinutes);
}

/* ------------------------------------------------------------------ *
 * 规划搜索起点
 * ------------------------------------------------------------------ */

/**
 * 计算"当前时刻之后的下一个整点"。
 *
 * 规则是**严格之后**，不是"把分钟向上取整"：
 *   20:24 → 21:00    20:00 → 21:00    20:59 → 21:00    21:00 → 22:00
 *
 * 到 24:00 时顺延到下一天 00:00（由调用方按窗口与允许时间再裁剪）。
 *
 * @param {{date: string, minutes: number}} now
 * @returns {{date: string, minutes: number}}
 */
export function nextHourAfter(now) {
  const next = Math.floor(now.minutes / 60) * 60 + 60;
  if (next < 1440) return { date: now.date, minutes: next };
  const days = Math.floor(next / 1440);
  return { date: addDays(now.date, days), minutes: next % 1440 };
}

/**
 * 解析本次规划的搜索起点，并给出**用户可见**的说明。
 *
 * 返回值里的 diagnostics 会被合入计划的诊断信息，最终显示在预览页上，
 * 因此"开始时间被调整过"永远不是静默发生的。
 *
 * @param {object} params
 * @param {{date: string, minutes: number}} params.now
 * @param {{date: string, minutes: number}|null} params.requested
 */
export function resolveSearchStart({ now, requested, earliestTaskStart = null }) {
  const fallback = nextHourAfter(now);
  const diagnostics = [];

  if (!requested || typeof requested !== 'object') {
    /**
     * 默认取"下一个整点"，但**让位于用户给任务填的更早开始时间**：
     * 现在 22:05、某任务要求 22:23 开始，就应该从 22:23 开始规划，
     * 而不是被整点规则顶到 23:00（那样 22:23 永远轮不到）。
     * 只对今天生效，且该时间不能早于现在。
     */
    const honoursTaskStart =
      Number.isInteger(earliestTaskStart) &&
      earliestTaskStart >= now.minutes &&
      earliestTaskStart < fallback.minutes;

    const start = honoursTaskStart ? { date: fallback.date, minutes: earliestTaskStart } : fallback;
    diagnostics.push({
      code: DIAGNOSTIC_CODE.START_TIME_DEFAULT,
      level: 'info',
      date: fallback.date,
      message: honoursTaskStart
        ? `未指定规划开始时间；有任务要求从 ${formatMinutesLocal(earliestTaskStart)} 开始，因此本次从 ${formatMinutesLocal(earliestTaskStart)} 开始规划。`
        : `未指定规划开始时间，从当前时刻之后的下一个整点开始规划（${formatMinutesLocal(fallback.minutes)}）；若任务指定了更早的开始时间，则从该时间开始。`,
    });
    return { start, diagnostics, source: honoursTaskStart ? 'task-start' : 'default' };
  }

  if (!Number.isInteger(requested.minutes) || requested.minutes < 0 || requested.minutes > 1440) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.START_TIME_INVALID,
      level: 'warning',
      date: fallback.date,
      message: `开始时间不合法，已改为从 ${formatMinutesLocal(fallback.minutes)} 开始规划。`,
    });
    return { start: fallback, diagnostics, source: 'fallback-invalid' };
  }

  const requestedDate = typeof requested.date === 'string' && requested.date >= now.date ? requested.date : now.date;
  const isPast = requestedDate < now.date || (requestedDate === now.date && requested.minutes < now.minutes);

  if (isPast) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.START_TIME_IN_PAST,
      level: 'warning',
      date: fallback.date,
      message: `你指定的开始时间（${formatMinutesLocal(requested.minutes)}）已经过去，已改为从 ${formatMinutesLocal(fallback.minutes)} 开始规划。`,
    });
    return { start: fallback, diagnostics, source: 'fallback-past' };
  }

  return { start: { date: requestedDate, minutes: requested.minutes }, diagnostics, source: 'user' };
}

function formatMinutesLocal(minutes) {
  const clamped = Math.max(0, Math.min(1440, minutes));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
