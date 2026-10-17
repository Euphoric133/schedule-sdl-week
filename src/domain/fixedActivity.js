/**
 * FixedActivity（固定活动）领域模型：课程、睡眠、用餐、社团、通勤等。
 *
 * 设计决定：
 * 1. 只支持两种重复方式（覆盖绝大多数真实场景，且易于校验）：
 *      { kind: 'once',   date: 'YYYY-MM-DD' }
 *      { kind: 'weekly', daysOfWeek: [1..7] }   // 1=周一 … 7=周日
 * 2. 固定活动默认 movable=false：引擎不移动、不拆分、不缩短它们，它们是容量的扣减项。
 * 3. 跨午夜（如睡眠 23:30–07:00）统一表示为 endMinutes > 1440，由 expandFixedActivities
 *    负责切成"每天一段"，因此时间轴永远不会出现负长度或跨日错位的块。
 * 4. 固定活动之间允许重叠（例如"通勤"落在"课程"区间内），但可用时间的计算会先做区间合并，
 *    因此重叠不会导致容量被重复扣减。
 */

import {
  TASK_NAME_MAX_LENGTH,
  VALIDATION_CODES as C,
  checkEnum,
  checkNonNegativeInt,
  checkRequiredString,
  error,
  isNonEmptyString,
  isPlainObject,
  result,
  warning,
} from './validation.js';
import {
  addDays,
  dateRange,
  isValidDateString,
  isValidTimeString,
  MINUTES_PER_DAY,
  overlapLength,
  parseTimeString,
  splitOvernightSpan,
  weekday,
} from './time.js';

export const FIXED_ACTIVITY_TYPE = Object.freeze({
  CLASS: 'class',
  SLEEP: 'sleep',
  MEAL: 'meal',
  CLUB: 'club',
  COMMUTE: 'commute',
  OTHER: 'other',
});

export const FIXED_ACTIVITY_TYPE_VALUES = Object.freeze(Object.values(FIXED_ACTIVITY_TYPE));

export const FIXED_ACTIVITY_TYPE_LABELS_ZH = Object.freeze({
  class: '课程',
  sleep: '睡眠',
  meal: '用餐',
  club: '社团活动',
  commute: '通勤',
  other: '其他',
});

export const RECURRENCE_KIND = Object.freeze({ ONCE: 'once', WEEKLY: 'weekly' });
export const RECURRENCE_KIND_VALUES = Object.freeze(Object.values(RECURRENCE_KIND));

/** 固定活动时长上限（24 小时），防止误输入 */
export const FIXED_ACTIVITY_MAX_MINUTES = MINUTES_PER_DAY;

/**
 * 构造固定活动。
 * @param {object} input { title, type, recurrence, start, end, activeFrom?, activeTo?, movable?, note? }
 *   start / end 支持 'HH:mm' 或分钟数；end <= start 且 start < 1440 时按跨夜处理。
 * @param {object} ctx { idFactory, nowIso }
 */
export function createFixedActivity(input, ctx) {
  if (!isPlainObject(input)) throw new TypeError('createFixedActivity 需要对象输入');
  if (!ctx || typeof ctx.idFactory?.next !== 'function') throw new TypeError('createFixedActivity 需要 ctx.idFactory');
  if (typeof ctx.nowIso !== 'string') throw new TypeError('createFixedActivity 需要 ctx.nowIso');

  const startMinutes = resolveMinutes(input.start ?? input.startMinutes);
  let endMinutes = resolveMinutes(input.end ?? input.endMinutes);
  if (endMinutes <= startMinutes && startMinutes < MINUTES_PER_DAY) endMinutes += MINUTES_PER_DAY;

  return {
    id: ctx.idFactory.next('fixedActivity'),
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    type: input.type ?? FIXED_ACTIVITY_TYPE.OTHER,
    recurrence: normalizeRecurrence(input.recurrence),
    startMinutes,
    endMinutes,
    activeFrom: input.activeFrom ?? null,
    activeTo: input.activeTo ?? null,
    movable: input.movable === true,
    note: typeof input.note === 'string' ? input.note : '',
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
  };
}

function normalizeRecurrence(recurrence) {
  if (!isPlainObject(recurrence)) return recurrence;
  if (recurrence.kind === RECURRENCE_KIND.WEEKLY) {
    const days = Array.isArray(recurrence.daysOfWeek) ? recurrence.daysOfWeek.map(Number) : [];
    return { kind: RECURRENCE_KIND.WEEKLY, daysOfWeek: [...new Set(days)].sort((a, b) => a - b) };
  }
  return { ...recurrence };
}

function resolveMinutes(value) {
  if (typeof value === 'number') return Math.round(value);
  if (isValidTimeString(value)) return parseTimeString(value);
  throw new TypeError(`无法解析的时刻：${JSON.stringify(value)}（应为 'HH:mm' 或分钟数）`);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

export function validateFixedActivity(activity, path = 'fixedActivity', { lenientName = false } = {}) {
  const issues = [];

  if (!isPlainObject(activity)) {
    return result([error(C.TYPE, path, '固定活动必须是一个对象。', { actual: typeof activity })]);
  }

  const idIssue = checkRequiredString(activity.id, `${path}.id`, '固定活动 ID', { maxLength: 64 });
  if (idIssue) issues.push(idIssue);

  // 固定任务与学习任务共用同一套名称规则（含长度上限），避免两处标准不一致
  const titleIssue = checkRequiredString(activity.title, `${path}.title`, '固定任务名称', {
    maxLength: TASK_NAME_MAX_LENGTH,
    countCodePoints: true,
  });
  if (titleIssue) {
    if (lenientName && titleIssue.code === VALIDATION_CODES.STRING_TOO_LONG) {
      issues.push(
        warning(
          titleIssue.code,
          `${path}.title`,
          `「${String(activity.title).slice(0, 20)}」的名称超过 ${TASK_NAME_MAX_LENGTH} 个字符，请编辑时精简（数据本身未被修改）。`,
          titleIssue.details,
        ),
      );
    } else {
      issues.push(titleIssue);
    }
  }

  const typeIssue = checkEnum(activity.type, FIXED_ACTIVITY_TYPE_VALUES, `${path}.type`, '固定活动类型');
  if (typeIssue) issues.push(typeIssue);

  const startIssue = checkNonNegativeInt(activity.startMinutes, `${path}.startMinutes`, '开始时间', { max: MINUTES_PER_DAY - 1 });
  if (startIssue) issues.push(startIssue);
  const endIssue = checkNonNegativeInt(activity.endMinutes, `${path}.endMinutes`, '结束时间', {
    min: 1,
    max: 2 * MINUTES_PER_DAY,
  });
  if (endIssue) issues.push(endIssue);

  if (Number.isInteger(activity.startMinutes) && Number.isInteger(activity.endMinutes)) {
    const length = activity.endMinutes - activity.startMinutes;
    if (length <= 0) {
      issues.push(error(C.SESSION_EMPTY_SPAN, `${path}.endMinutes`, '固定活动的结束时间必须晚于开始时间。', {
        startMinutes: activity.startMinutes,
        endMinutes: activity.endMinutes,
      }));
    } else if (length > FIXED_ACTIVITY_MAX_MINUTES) {
      issues.push(
        error(C.RANGE, `${path}.endMinutes`, `固定活动时长不能超过 ${FIXED_ACTIVITY_MAX_MINUTES} 分钟（当前 ${length}）。`, { length }),
      );
    }
  }

  const recurrenceIssue = validateRecurrence(activity.recurrence, `${path}.recurrence`);
  if (recurrenceIssue) issues.push(recurrenceIssue);

  for (const key of ['activeFrom', 'activeTo']) {
    const value = activity[key];
    if (value !== null && value !== undefined && !isValidDateString(value)) {
      issues.push(error(C.REQUIRED, `${path}.${key}`, `${key} 必须是合法的 YYYY-MM-DD 或留空。`, { actual: value }));
    }
  }
  if (isValidDateString(activity.activeFrom) && isValidDateString(activity.activeTo)) {
    if (activity.activeFrom > activity.activeTo) {
      issues.push(error(C.RANGE, `${path}.activeFrom`, '生效起始日期不能晚于生效结束日期。', {
        activeFrom: activity.activeFrom,
        activeTo: activity.activeTo,
      }));
    }
  }

  if (typeof activity.movable !== 'boolean') {
    issues.push(error(C.FIXED_ACTIVITY_MOVABLE, `${path}.movable`, 'movable 必须是布尔值。', { actual: typeof activity.movable }));
  }

  return result(issues);
}

function validateRecurrence(recurrence, path) {
  if (!isPlainObject(recurrence)) {
    return error(C.FIXED_ACTIVITY_RECURRENCE, path, '必须提供重复规则（一次性或每周重复）。', { actual: recurrence });
  }
  if (!RECURRENCE_KIND_VALUES.includes(recurrence.kind)) {
    return error(C.ENUM, `${path}.kind`, `重复规则只能是 once 或 weekly（当前 ${JSON.stringify(recurrence.kind)}）。`, {
      actual: recurrence.kind,
    });
  }
  if (recurrence.kind === RECURRENCE_KIND.ONCE) {
    if (!isValidDateString(recurrence.date)) {
      return error(C.REQUIRED, `${path}.date`, '一次性固定活动必须提供合法的日期（YYYY-MM-DD）。', { actual: recurrence.date });
    }
    return null;
  }
  if (!Array.isArray(recurrence.daysOfWeek) || recurrence.daysOfWeek.length === 0) {
    return error(C.FIXED_ACTIVITY_RECURRENCE, `${path}.daysOfWeek`, '每周重复必须至少选择一天。', { actual: recurrence.daysOfWeek });
  }
  for (const [idx, day] of recurrence.daysOfWeek.entries()) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      return error(C.RANGE, `${path}.daysOfWeek[${idx}]`, '星期取值必须是 1（周一）到 7（周日）。', { actual: day });
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 展开为具体日期的时间块
 * ------------------------------------------------------------------ */

/**
 * 判断固定活动是否在某一天生效（受 recurrence 与 activeFrom/activeTo 约束）。
 * 跨夜活动归属于其**开始日**：睡眠 23:30–07:00 只在 10-16 生效一份，覆盖到 10-17 早晨。
 */
export function occursOn(activity, date) {
  const { recurrence } = activity;
  if (!isPlainObject(recurrence)) return false;
  if (isNonEmptyString(activity.activeFrom, 10) && date < activity.activeFrom) return false;
  if (isNonEmptyString(activity.activeTo, 10) && date > activity.activeTo) return false;
  if (recurrence.kind === RECURRENCE_KIND.ONCE) return recurrence.date === date;
  if (recurrence.kind === RECURRENCE_KIND.WEEKLY) return recurrence.daysOfWeek.includes(weekday(date));
  return false;
}

/**
 * 展开一批固定活动为 [start, end) 区间（按日期分组）。
 *
 * 重要：跨夜活动会产生"属于下一天"的尾部片段（例如睡眠 23:30→07:00 在 10-17 产生 00:00–07:00），
 * 因此展开窗口必须比查询窗口多算一天，否则窗口首日的凌晨时段会漏掉。
 *
 * @param {object[]} activities
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Array<{ activityId: string, title: string, type: string, date: string, startMinutes: number, endMinutes: number }>}
 */
export function expandFixedActivities(activities, startDate, endDate) {
  const out = [];
  const scanStart = addDays(startDate, -1); // 多算一天，覆盖窗口首日的跨夜尾部
  for (const activity of activities ?? []) {
    if (!isPlainObject(activity)) continue;
    for (const date of dateRange(scanStart, endDate)) {
      if (!occursOn(activity, date)) continue;
      for (const part of splitOvernightSpan({
        date,
        startMinutes: activity.startMinutes,
        endMinutes: activity.endMinutes,
      })) {
        // 关键：按**片段自身归属的日期**过滤，而不是按"它由哪一天生成"过滤。
        // 否则跨夜活动落在查询首日的那一段（如 00:00–07:00）会被丢掉，
        // 导致窗口首日的凌晨时段凭空多出可用容量。
        if (part.date < startDate || part.date > endDate) continue;
        out.push({
          activityId: activity.id,
          title: activity.title,
          type: activity.type,
          date: part.date,
          startMinutes: part.startMinutes,
          endMinutes: part.endMinutes,
        });
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMinutes - b.startMinutes || (a.activityId < b.activityId ? -1 : 1)));
}

/**
 * 把一批区间合并为互不重叠的区间（含跨日处理）。
 * 这是"固定活动之间允许重叠，但容量只扣一次"的实现方式。
 * @param {Array<{date:string,startMinutes:number,endMinutes:number}>} spans
 */
export function mergeSpans(spans) {
  const byDate = new Map();
  for (const span of spans) {
    if (!byDate.has(span.date)) byDate.set(span.date, []);
    // 用绝对分钟数展平跨夜段，保证排序与合并正确
    byDate.get(span.date).push({ start: span.startMinutes, end: span.endMinutes });
  }
  const merged = [];
  for (const [date, list] of byDate) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let current = null;
    for (const span of list) {
      if (!current) {
        current = { ...span };
        continue;
      }
      if (span.start <= current.end) {
        current.end = Math.max(current.end, span.end);
      } else {
        merged.push({ date, startMinutes: current.start, endMinutes: current.end });
        current = { ...span };
      }
    }
    if (current) merged.push({ date, startMinutes: current.start, endMinutes: current.end });
  }
  return merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMinutes - b.startMinutes));
}

/** 一组区间在某日的合计占用分钟数（已做重叠合并，不会重复计算） */
export function totalMergedMinutes(spans, date) {
  return mergeSpans(spans.filter((s) => s.date === date)).reduce((sum, s) => sum + (s.endMinutes - s.startMinutes), 0);
}

/** 两个固定活动是否在同一时间正重叠（仅用于界面提示，不构成数据错误） */
export function fixedActivitiesOverlap(a, b, date) {
  if (!occursOn(a, date) || !occursOn(b, date)) return 0;
  const aParts = splitOvernightSpan({ date, startMinutes: a.startMinutes, endMinutes: a.endMinutes });
  const bParts = splitOvernightSpan({ date, startMinutes: b.startMinutes, endMinutes: b.endMinutes });
  let total = 0;
  for (const ap of aParts) {
    for (const bp of bParts) {
      if (ap.date !== bp.date) continue;
      total += overlapLength(ap.startMinutes, ap.endMinutes, bp.startMinutes, bp.endMinutes);
    }
  }
  return total;
}

/** 从活动集合中移除某个 id（返回新数组） */
export function removeFixedActivity(activities, id) {
  return activities.filter((a) => a.id !== id);
}
