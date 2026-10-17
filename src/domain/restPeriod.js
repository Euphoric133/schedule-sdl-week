/**
 * 休息时间（rest period）的领域模型。
 *
 * 为什么单独建一个实体，而不是复用固定任务或学习任务：
 * - 它不是学习任务：不参与剩余工作量、不参与排程、不计入学习统计；
 * - 它也不是固定任务：固定任务是"不可移动的占用"（课程、睡眠），
 *   而休息是用户主动安排的放松时段，语义与视觉都不同，需要独立颜色与标签。
 * 把三者混成一种类型会让"完成、统计、排程"这些逻辑互相污染，因此独立建模。
 *
 * 关键设计：**一条完整安排 + 按日期拆分的显示片段**。
 * 用户只创建一条（例如 10-16 22:00 → 10-17 08:00），
 * 每日视图按**午夜边界**拆成两个片段分别显示在该日的列里。
 * 底层永远只有一条记录，因此修改/删除时所有片段会一起变，不会出现"半条休息"。
 */

import { isValidDateString, isValidTimeString, parseDateString, parseTimeString } from './time.js';
import { VALIDATION_CODES as C, error, result } from './validation.js';
import { TASK_NAME_MAX_LENGTH } from './validation.js';

/** 一天的分钟数（休息按午夜切分，不使用 04:00 业务日边界） */
const MINUTES_PER_DAY = 24 * 60;

/** 单条休息允许的最长跨度（天） */
export const REST_MAX_DAYS = 31;

/**
 * 创建一个休息安排实体（不做业务校验，校验请调用 validateRestPeriod）。
 * @param {object} input
 * @param {{ next: (kind: string) => string }} ctx.idFactory
 * @param {string} ctx.nowIso
 */
export function createRestPeriod(input, ctx) {
  if (!input || typeof input !== 'object') throw new TypeError('createRestPeriod 需要对象输入');
  if (!ctx || typeof ctx.idFactory?.next !== 'function') throw new TypeError('createRestPeriod 需要 ctx.idFactory');
  return {
    id: ctx.idFactory.next('rest'),
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    startDate: input.startDate,
    startMinutes: toMinutes(input, 'startMinutes', 'startTime'),
    endDate: input.endDate,
    endMinutes: toMinutes(input, 'endMinutes', 'endTime'),
    note: typeof input.note === 'string' ? input.note : '',
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
  };
}

/** 允许输入用 HH:mm 字符串，统一转成分钟数（便于与计划时段共用坐标体系） */
function toMinutes(input, minutesKey, timeKey) {
  if (Number.isInteger(input[minutesKey])) return input[minutesKey];
  if (isValidTimeString(input[timeKey])) return parseTimeString(input[timeKey]);
  return input[minutesKey];
}

/**
 * 校验一条休息安排。
 *
 * 规则（都给出用户能读懂的中文提示）：
 * - 名称必填且不超过统一上限；
 * - 开始/结束日期必须是真实日历日，时间必须是合法时刻；
 * - 结束不能早于开始；
 * - 同一天内开始与结束时间不能相同（无法判断意图）；
 * - 跨度不能超过 REST_MAX_DAYS 天。
 */
export function validateRestPeriod(rest, path = 'rest') {
  const issues = [];

  if (typeof rest?.title !== 'string' || rest.title.trim() === '') {
    issues.push(error(C.REQUIRED, `${path}.title`, '请填写休息时间名称。'));
  } else if ([...rest.title.trim()].length > TASK_NAME_MAX_LENGTH) {
    issues.push(
      error(C.STRING_TOO_LONG, `${path}.title`, `休息时间名称最多 ${TASK_NAME_MAX_LENGTH} 个字符。`, {
        max: TASK_NAME_MAX_LENGTH,
        actual: [...rest.title.trim()].length,
      }),
    );
  }

  if (!isValidDateString(rest?.startDate)) {
    issues.push(error(C.REQUIRED, `${path}.startDate`, '请选择休息的开始日期。'));
  }
  if (!isValidDateString(rest?.endDate)) {
    issues.push(error(C.REQUIRED, `${path}.endDate`, '请选择休息的结束日期。'));
  }
  if (!Number.isInteger(rest?.startMinutes) || rest.startMinutes < 0 || rest.startMinutes >= MINUTES_PER_DAY) {
    issues.push(error(C.RANGE, `${path}.startMinutes`, '请选择合法的开始时间。'));
  }
  if (!Number.isInteger(rest?.endMinutes) || rest.endMinutes < 0 || rest.endMinutes > MINUTES_PER_DAY) {
    issues.push(error(C.RANGE, `${path}.endMinutes`, '请选择合法的结束时间。'));
  }

  if (isValidDateString(rest?.startDate) && isValidDateString(rest?.endDate)) {
    if (rest.endDate < rest.startDate) {
      issues.push(error(C.RANGE, `${path}.endDate`, '结束日期不能早于开始日期。'));
    } else {
      const span = diffDaysLocal(rest.startDate, rest.endDate);
      if (span === 0 && rest.startMinutes === rest.endMinutes) {
        issues.push(
          error(C.RANGE, `${path}.endMinutes`, '开始和结束时间相同，无法确定休息时长；请调整结束时间或结束日期。'),
        );
      }
      if (span > REST_MAX_DAYS) {
        issues.push(error(C.RANGE, `${path}.endDate`, `单条休息最长支持 ${REST_MAX_DAYS} 天。`));
      }
    }
  }

  return result(issues);
}

/**
 * 把一条休息安排按**午夜边界**拆成若干"某一天内的片段"。
 *
 * 例：10-16 22:00 → 10-17 08:00 拆成
 *   10-16 22:00–24:00（1440 表示当天结束）
 *   10-17 00:00–08:00
 *
 * 不变量（有测试覆盖）：
 * - 所有片段合计分钟数 = 完整安排的分钟数（不重复、不遗漏）；
 * - 同一日期最多一个片段（因为按午夜切分）；
 * - 片段之间不重叠。
 *
 * @returns {Array<{restId: string, title: string, date: string, startMinutes: number, endMinutes: number, minutes: number, isStart: boolean, isEnd: boolean, segmentIndex: number, segmentCount: number}>}
 */
export function splitRestAcrossDates(rest) {
  if (!rest || !isValidDateString(rest.startDate) || !isValidDateString(rest.endDate)) return [];
  if (!Number.isInteger(rest.startMinutes) || !Number.isInteger(rest.endMinutes)) return [];

  const fragments = [];
  const startOrdinal = parseDateString(rest.startDate);
  const endOrdinal = parseDateString(rest.endDate);
  if (endOrdinal < startOrdinal) return [];

  let ordinal = startOrdinal;
  while (ordinal <= endOrdinal) {
    const date = ordinalToDate(ordinal);
    const isStart = ordinal === startOrdinal;
    const isEnd = ordinal === endOrdinal;

    // 片段在该日内的起止：首日从开始时间起，末日到结束时间止，中间整天
    const from = isStart ? rest.startMinutes : 0;
    const to = isEnd ? rest.endMinutes : MINUTES_PER_DAY;

    // 结束时间恰为 00:00 的末日不产生片段（前一天已经覆盖到 24:00）
    if (to > from) {
      fragments.push({
        restId: rest.id,
        title: rest.title,
        date,
        startMinutes: from,
        endMinutes: to,
        minutes: to - from,
        isStart,
        isEnd,
      });
    }

    ordinal += 1;
  }

  return fragments.map((fragment, index) => ({
    ...fragment,
    segmentIndex: index,
    segmentCount: fragments.length,
  }));
}

/** 完整安排的时长（分钟），用于与片段合计做守恒校验 */
export function restDurationMinutes(rest) {
  if (!rest || !isValidDateString(rest.startDate) || !isValidDateString(rest.endDate)) return 0;
  const span = diffDaysLocal(rest.startDate, rest.endDate);
  if (span < 0) return 0;
  return span * MINUTES_PER_DAY + (rest.endMinutes - rest.startMinutes);
}

/** 判断某条休息是否在指定日期有显示片段 */
export function restOccursOn(rest, date) {
  return splitRestAcrossDates(rest).some((fragment) => fragment.date === date);
}

/* ------------------------------------------------------------------ *
 * 内部工具（与 time.js 的序数算法保持一致，避免重复引入实现差异）
 * ------------------------------------------------------------------ */

function diffDaysLocal(from, to) {
  return parseDateString(to) - parseDateString(from);
}

function ordinalToDate(ordinal) {
  const date = new Date(Date.UTC(1970, 0, 1));
  date.setUTCDate(date.getUTCDate() + ordinal);
  return date.toISOString().slice(0, 10);
}
