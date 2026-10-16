/**
 * CalendarBlock（日历块）：时间轴渲染与统计的**统一视图模型**。
 *
 * 设计原因：
 * 七天视图与每日视图必须基于同一份数据、不能各算各的。因此所有时间轴只用一种结构：
 *   kind = 'study' | 'fixed' | 'rest' | 'buffer'
 * 由 StudySession / FixedActivity / 引擎派生的休息与缓冲统一映射而来。
 * 渲染层只消费 CalendarBlock[]，不再自己拼装数据，也不可能出现两个视图互相冲突。
 */

import { VALIDATION_CODES as C, error, isPlainObject, result } from './validation.js';
import { dateRange, formatMinutes, isOverlapping, MINUTES_PER_DAY, weekday } from './time.js';

export const BLOCK_KIND = Object.freeze({
  STUDY: 'study',
  FIXED: 'fixed',
  REST: 'rest',
  BUFFER: 'buffer',
});

export const BLOCK_KIND_VALUES = Object.freeze(Object.values(BLOCK_KIND));

export const BLOCK_KIND_LABELS_ZH = Object.freeze({
  study: '学习',
  fixed: '固定活动',
  rest: '计划休息',
  buffer: '机动缓冲',
});

/**
 * 构造一个日历块。id 必须由调用方提供（引擎用确定性派生 ID；services 层用 idFactory）。
 */
export function createBlock(input) {
  if (!isPlainObject(input)) throw new TypeError('createBlock 需要对象输入');
  const startMinutes = input.startMinutes;
  const endMinutes = input.endMinutes;
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes) || endMinutes <= startMinutes) {
    throw new RangeError(`日历块的时间无效：${startMinutes} → ${endMinutes}`);
  }
  return {
    id: input.id,
    kind: input.kind,
    date: input.date,
    startMinutes,
    endMinutes,
    refId: input.refId ?? null,
    taskId: input.taskId ?? null,
    subject: input.subject ?? null,
    label: input.label ?? '',
    locked: input.locked === true,
    derived: input.derived === true,
    meta: input.meta ?? {},
  };
}

/** StudySession → CalendarBlock */
export function blockFromSession(session, { task, label } = {}) {
  return createBlock({
    id: `blk_ses_${session.id}`,
    kind: BLOCK_KIND.STUDY,
    date: session.date,
    startMinutes: session.startMinutes,
    endMinutes: session.endMinutes,
    refId: session.id,
    taskId: session.taskId,
    subject: task?.subject ?? null,
    label: label ?? task?.title ?? '学习时段',
    locked: Boolean(session.locked),
    meta: { state: session.state, plannedMinutes: session.plannedMinutes },
  });
}

/** FixedActivity 的某一天实例 → CalendarBlock */
export function blockFromFixedActivity(activity, date, minutes) {
  return createBlock({
    id: `blk_fix_${activity.id}_${date}`,
    kind: BLOCK_KIND.FIXED,
    date,
    startMinutes: minutes.startMinutes,
    endMinutes: minutes.endMinutes,
    refId: activity.id,
    label: activity.title ?? '固定活动',
    meta: { type: activity.type ?? 'other' },
  });
}

/** 引擎插入的休息块 → CalendarBlock */
export function blockRest({ id, date, startMinutes, endMinutes, reasonCodes = [] }) {
  return createBlock({
    id,
    kind: BLOCK_KIND.REST,
    date,
    startMinutes,
    endMinutes,
    label: '休息',
    derived: true,
    meta: { reasonCodes },
  });
}

/** 引擎预留的机动缓冲块 → CalendarBlock */
export function blockBuffer({ id, date, startMinutes, endMinutes }) {
  return createBlock({
    id,
    kind: BLOCK_KIND.BUFFER,
    date,
    startMinutes,
    endMinutes,
    label: '机动缓冲',
    derived: true,
  });
}

/** 按业务日分组（Map<date, CalendarBlock[]>，每组按开始时间稳定排序） */
export function groupBlocksByDate(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (!map.has(block.date)) map.set(block.date, []);
    map.get(block.date).push(block);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.startMinutes - b.startMinutes) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return map;
}

/**
 * 每日统计。
 * 缓冲与休息**分开统计**（不同 kind 分区求和），绝不重复计算——这是硬约束 H8 的数据基础。
 */
export function computeDailyStats(blocks, date) {
  const stats = {
    date,
    studyMinutes: 0,
    restMinutes: 0,
    bufferMinutes: 0,
    fixedMinutes: 0,
    sessionCount: 0,
    firstStudyStart: null,
    lastStudyEnd: null,
  };
  for (const block of blocks) {
    if (block.date !== date) continue;
    const length = block.endMinutes - block.startMinutes;
    switch (block.kind) {
      case BLOCK_KIND.STUDY:
        stats.studyMinutes += length;
        stats.sessionCount += 1;
        stats.firstStudyStart = stats.firstStudyStart === null ? block.startMinutes : Math.min(stats.firstStudyStart, block.startMinutes);
        stats.lastStudyEnd = stats.lastStudyEnd === null ? block.endMinutes : Math.max(stats.lastStudyEnd, block.endMinutes);
        break;
      case BLOCK_KIND.REST:
        stats.restMinutes += length;
        break;
      case BLOCK_KIND.BUFFER:
        stats.bufferMinutes += length;
        break;
      case BLOCK_KIND.FIXED:
        stats.fixedMinutes += length;
        break;
      default:
        break;
    }
  }
  return stats;
}

/** 计算窗口内每一天的统计，返回按日期升序的数组 */
export function computeWindowStats(blocks, startDate, endDate) {
  return dateRange(startDate, endDate).map((date) => computeDailyStats(blocks, date));
}

/** 单个块的展示文案，例如 '学习 · 线性代数作业（45 分钟）' */
export function describeBlock(block) {
  const kind = BLOCK_KIND_LABELS_ZH[block.kind] ?? block.kind;
  const time = `${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}`;
  const length = block.endMinutes - block.startMinutes;
  return `${kind} ${time} · ${block.label}（${length} 分钟）`;
}

/**
 * 校验一天的块集合是否存在非法的正重叠。
 * 允许的重叠规则（有意为之）：
 *  - 固定活动之间允许重叠（例如"睡眠"与"通勤"数据可以嵌套），它们只影响可用时间，不构成冲突。
 *  - 学习/休息/缓冲三类相互之间不得重叠（H1/H2/H8）。
 * @returns {object[]} 校验问题列表（结构见 validation.js 的 ValidationIssue）
 */
export function detectBlockOverlaps(blocks, date) {
  const issues = [];
  const schedulable = blocks.filter((b) => b.date === date && b.kind !== BLOCK_KIND.FIXED);
  for (let i = 0; i < schedulable.length; i += 1) {
    for (let j = i + 1; j < schedulable.length; j += 1) {
      const a = schedulable[i];
      const b = schedulable[j];
      if (isOverlapping(a.startMinutes, a.endMinutes, b.startMinutes, b.endMinutes)) {
        issues.push(
          error(
            C.ENTITY_OVERLAP,
            `blocks[${date}]`,
            `${date} 的「${a.label}」(${formatMinutes(a.startMinutes)}–${formatMinutes(a.endMinutes)}) 与「${b.label}」(${formatMinutes(b.startMinutes)}–${formatMinutes(b.endMinutes)}) 时间重叠。`,
            { date, a: a.id, b: b.id, overlap: Math.min(a.endMinutes, b.endMinutes) - Math.max(a.startMinutes, b.startMinutes) },
          ),
        );
      }
    }
  }
  return issues;
}

/** 校验一组块的整体结构合法性（非重叠 + 基本字段） */
export function validateBlocks(blocks) {
  const issues = [];
  if (!Array.isArray(blocks)) {
    return result([error(C.TYPE, 'blocks', '日历块集合必须是数组。', { actual: typeof blocks })]);
  }
  const byDate = groupBlocksByDate(blocks);
  for (const [date, list] of byDate) {
    for (const block of list) {
      if (!BLOCK_KIND_VALUES.includes(block.kind)) {
        issues.push(error(C.ENUM, `blocks[${block.id}].kind`, `未知的块类型：${block.kind}。`, { kind: block.kind }));
      }
      if (!Number.isInteger(block.startMinutes) || !Number.isInteger(block.endMinutes) || block.endMinutes <= block.startMinutes) {
        issues.push(error(C.SESSION_EMPTY_SPAN, `blocks[${block.id}]`, `块的时间区间无效：${block.startMinutes} → ${block.endMinutes}。`));
      }
      if (block.startMinutes < 0 || block.endMinutes > 2 * MINUTES_PER_DAY) {
        issues.push(error(C.RANGE, `blocks[${block.id}]`, '块的时间区间超出合理范围（0 – 2880 分钟）。'));
      }
    }
    issues.push(...detectBlockOverlaps(list, date));
  }
  return result(issues);
}

/** 判定某个日期是否为周末（用于展示，不参与排程硬约束） */
export function isWeekend(date) {
  const day = weekday(date);
  return day === 6 || day === 7;
}
