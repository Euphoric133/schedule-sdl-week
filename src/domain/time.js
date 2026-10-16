/**
 * 时间工具：项目中**唯一**允许做日期/时刻运算的模块。
 *
 * 设计原因（重要，勿绕过）：
 * 1. 排程引擎必须确定性可测，因此引擎内部的"现在"永远是外部传入的墙上时间，绝不读系统时钟。
 * 2. 项目只处理"用户本地墙上时间"（单个时区），不处理多时区转换，因此所有内部表示都绕开
 *    Date 的隐式 UTC 解析，统一使用 [日期字符串 + 分钟数]。
 * 3. `new Date('2025-10-16')` 会被解析成 UTC 午夜，在东八区会表现为 10-16 08:00，是经典的一天偏移
 *    bug。本模块用 `Date.UTC` 构造纯日历日来避开它，并禁止在其它模块直接解析日期字符串。
 *
 * 三种表示：
 * - WallDate      'YYYY-MM-DD'  日历日
 * - WallTime      'HH:mm'       墙上时刻（不携带日期/时区）
 * - WallDateTime  { date, minutes }  minutes 为自当日 00:00 起的分钟数（可 > 1440 表示跨午夜）
 */

/** 一天 1440 分钟 */
export const MINUTES_PER_DAY = 1440;
/** 默认业务日边界小时：04:00 之前仍算作前一天（夜间学习归属更符合直觉） */
export const DEFAULT_DAY_BOUNDARY_HOUR = 4;

export const WEEKDAY_NAMES_ZH = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/* ------------------------------------------------------------------ *
 * 校验与解析
 * ------------------------------------------------------------------ */

/** @returns {boolean} 是否为合法的 'YYYY-MM-DD' 且是真实存在的日期 */
export function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  return true;
}

/** @returns {boolean} 是否为合法的 'HH:mm'（00:00 – 23:59） */
export function isValidTimeString(value) {
  if (typeof value !== 'string') return false;
  const m = TIME_RE.exec(value);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/** 解析 'YYYY-MM-DD' → { year, month, day }；非法输入抛错（调用方应先校验） */
export function parseDateString(value) {
  if (!isValidDateString(value)) {
    throw new TypeError(`不是合法的日期字符串（期望 YYYY-MM-DD）：${JSON.stringify(value)}`);
  }
  const m = DATE_RE.exec(value);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 解析 'HH:mm' → 自 00:00 起的分钟数 */
export function parseTimeString(value) {
  if (!isValidTimeString(value)) {
    throw new TypeError(`不是合法的时刻字符串（期望 HH:mm）：${JSON.stringify(value)}`);
  }
  const m = TIME_RE.exec(value);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分钟数 → 'HH:mm'（按 24 小时环绕；超出一日的分钟数会环绕，便于展示跨夜时段） */
export function formatMinutes(minutes) {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

/** 分钟数 → 'HH:mm'，跨夜时在末尾追加 '+1'（如 25:30 显示为 '01:30+1'） */
export function formatMinutesWithDayMark(minutes) {
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const base = formatMinutes(minutes);
  return dayOffset > 0 ? `${base}+${dayOffset}` : base;
}

/** 年月 → 天数（公历闰年规则） */
export function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/* ------------------------------------------------------------------ *
 * 基本运算
 * ------------------------------------------------------------------ */

/** 自公元 0 年起的天序号（纯日历运算，不含时区）。可用于排序与天数差。 */
export function dateToOrdinal(date) {
  const { year, month, day } = parseDateString(date);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/** 天序号 → 'YYYY-MM-DD' */
export function ordinalToDate(ordinal) {
  if (!Number.isInteger(ordinal)) throw new TypeError(`天序号必须是整数：${ordinal}`);
  const dt = new Date(Date.UTC(1970, 0, 1) + ordinal * 86400000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 日期加减天数，返回新的日期字符串 */
export function addDays(date, days) {
  return ordinalToDate(dateToOrdinal(date) + days);
}

/** 两个日期之间的整天数差（to - from） */
export function diffDays(from, to) {
  return dateToOrdinal(to) - dateToOrdinal(from);
}

/** 星期几：ISO 约定 1=周一 … 7=周日。1970-01-01 是周四（天序号 0），故偏移 +4。 */
export function weekday(date) {
  const raw = (dateToOrdinal(date) + 4) % 7;
  return raw === 0 ? 7 : raw;
}

/** 覆盖 [start, end] 的日期字符串数组（含两端）；start > end 时返回空数组 */
export function dateRange(start, end) {
  const n = diffDays(start, end);
  if (n < 0) return [];
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(addDays(start, i));
  return out;
}

/**
 * 时间段 → 分钟数。
 * 接受数值形式 `{ startMinutes, endMinutes }`（可 > 1440 表示跨夜）或字符串形式
 * `{ start: '22:00', end: '02:00' }`。字符串形式的 end ≤ start 视为跨夜，自动 +1440。
 * 若要显式表达跨夜且希望被识别，请传数值形式或使用字符串形式（本函数负责补 +1440）。
 */
export function spanToMinutes(span) {
  if (!span || typeof span !== 'object') throw new TypeError('时间段必须是 { start, end } 对象');
  const { start, end, startMinutes: sm, endMinutes: em } = span;
  if (typeof sm === 'number' && typeof em === 'number') {
    return { startMinutes: sm, endMinutes: em, lengthMinutes: em - sm };
  }
  const startMinutes = parseTimeString(start);
  let endMinutes = parseTimeString(end);
  if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY; // 跨夜（如 22:00–02:00）
  return { startMinutes, endMinutes, lengthMinutes: endMinutes - startMinutes };
}

/**
 * 判断 [start, end) 与 [otherStart, otherEnd) 是否正重叠。
 * 采用半开区间：end 与另一段的 start 相等不算重叠（16:00–17:00 与 17:00–18:00 相邻，合法）。
 */
export function isOverlapping(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

/** 两个半开区间的交集长度（分钟，无交集返回 0） */
export function overlapLength(start, end, otherStart, otherEnd) {
  const lo = Math.max(start, otherStart);
  const hi = Math.min(end, otherEnd);
  return hi > lo ? hi - lo : 0;
}

/**
 * 当天的日期字符串、星期与"业务日"归属。
 * 业务日边界：boundaryHour（默认 4）点之前的时刻属于前一个业务日。
 * 例：10-17 01:30 学习 → businessDate = '2025-10-16'。
 */
export function businessDateFor(date, minutes, boundaryHour = DEFAULT_DAY_BOUNDARY_HOUR) {
  const safeHour = Number.isInteger(boundaryHour) && boundaryHour >= 0 && boundaryHour <= 12 ? boundaryHour : DEFAULT_DAY_BOUNDARY_HOUR;
  return minutes < safeHour * 60 ? addDays(date, -1) : date;
}

/** 类似格式化：'2025-10-16 周四' */
export function formatDateWithWeekday(date) {
  return `${date} ${WEEKDAY_NAMES_ZH[weekday(date) - 1]}`;
}

/** 人类可读时长：95 → '1 小时 35 分钟'；45 → '45 分钟' */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m} 分钟`;
  if (m === 0) return `${sign}${h} 小时`;
  return `${sign}${h} 小时 ${m} 分钟`;
}

/* ------------------------------------------------------------------ *
 * 与 Date / 时间戳的桥接（仅在需要与浏览器或时区交互时使用）
 * ------------------------------------------------------------------ */

/**
 * 墙上时间 → UTC 毫秒（按给定 UTC 偏移解释）。
 * 这是唯一"确定性的墙钟 ↔ 时间戳"换算，测试可用固定偏移避免宿主机时区干扰。
 */
export function wallTimeToUtcOffsetMs(wall, offsetMinutes) {
  const { date, minutes = 0 } = wall;
  const { year, month, day } = parseDateString(date);
  const base = Date.UTC(year, month - 1, day) + minutes * 60000;
  return base - offsetMinutes * 60000;
}

/** UTC 毫秒 → 指定偏移下的墙上时间 */
export function toWallTimeFromUtcOffsetMs(ms, offsetMinutes) {
  const shifted = new Date(ms + offsetMinutes * 60000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * 从 Date 对象读取本地墙上时间（使用其本地 getter，不做 UTC 偏移推算）。
 * 仅用于"用户当前本地时间"这一场景；引擎内部禁止使用。
 */
export function wallTimeFromDateObject(dt = new Date()) {
  return {
    date: `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`,
    minutes: dt.getHours() * 60 + dt.getMinutes(),
    weekday: weekday(`${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`),
  };
}

/** 当前本地墙上时间（便捷函数；引擎不得调用） */
export function nowWallTime() {
  return wallTimeFromDateObject(new Date());
}

/** 两个墙上时刻的先后比较：a < b → -1，相等 → 0，a > b → 1（先比日期，再比分钟） */
export function compareWallTime(a, b) {
  const da = dateToOrdinal(a.date);
  const db = dateToOrdinal(b.date);
  if (da !== db) return da < db ? -1 : 1;
  const ma = a.minutes ?? 0;
  const mb = b.minutes ?? 0;
  if (ma !== mb) return ma < mb ? -1 : 1;
  return 0;
}

/** 把带日期的墙上时间点整体换算成"绝对分钟"（天序号 × 1440 + 分钟），便于比较与相减 */
export function absoluteMinutes(wall) {
  return dateToOrdinal(wall.date) * MINUTES_PER_DAY + (wall.minutes ?? 0);
}

/** 两个带日期的墙上时间点之间的分钟差（to - from） */
export function minutesBetweenWallTimes(from, to) {
  return absoluteMinutes(to) - absoluteMinutes(from);
}

/**
 * 把可能跨午夜的时段切成"每天一段"。
 *
 * 重要约定（调用方务必遵守）：返回的每一段，其 start/end 都是**该段自己日期内的分钟数**
 * （0 ≤ start < end ≤ 1440），不保留"跨日累加"的偏移。这样下游按天渲染与统计时不会错位。
 *
 * 例：{ date:'2025-10-16', startMinutes: 1410, endMinutes: 1470 } （23:30 → 次日 00:30）
 * → [{ date:'2025-10-16', startMinutes:1410, endMinutes:1440 },
 *    { date:'2025-10-17', startMinutes:0,    endMinutes:30   }]
 */
export function splitOvernightSpan(span) {
  const { date, startMinutes, endMinutes } = span;
  if (!isValidDateString(date)) throw new TypeError(`非法日期：${date}`);
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes)) {
    throw new TypeError('startMinutes / endMinutes 必须是整数');
  }
  if (startMinutes < 0) throw new RangeError(`起始分钟数不能为负：${startMinutes}`);
  if (endMinutes <= startMinutes) {
    throw new RangeError(`时段必须为非空正长度：${startMinutes} → ${endMinutes}`);
  }
  const parts = [];
  let cursorDate = date;
  let offset = startMinutes; // 自起始日 00:00 起的总偏移
  while (offset < endMinutes) {
    const boundary = (Math.floor(offset / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
    const chunkEnd = Math.min(endMinutes, boundary);
    parts.push({
      date: cursorDate,
      startMinutes: offset % MINUTES_PER_DAY,
      endMinutes: chunkEnd % MINUTES_PER_DAY === 0 ? MINUTES_PER_DAY : chunkEnd % MINUTES_PER_DAY,
    });
    if (chunkEnd >= endMinutes) break;
    cursorDate = addDays(cursorDate, 1);
    offset = chunkEnd;
  }
  return parts;
}
