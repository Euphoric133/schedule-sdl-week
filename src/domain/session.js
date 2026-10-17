/**
 * StudySession（学习时段）领域模型。
 *
 * 核心设计决定（与需求中的"锁定机制"一一对应，但避免了状态组合爆炸）：
 *   生命周期 state : flexible | in_progress | completed | cancelled
 *   用户锁定 locked: boolean —— 表达"这个时段是用户钉住的，系统不得自动移动/缩短/拆分/覆盖"
 *
 * 需求中的四种状态在界面上的呈现为：
 *   flexible   → state='flexible'   && locked=false
 *   pinned     → state='flexible'   && locked=true
 *   in_progress→ state='in_progress'（开始时自动 locked=true，避免规划过程中被移动）
 *   completed  → state='completed'  （终态：引擎永不删除、移动、缩短或改回未完成）
 *
 * 时间表示：date + startMinutes + endMinutes（自当日 00:00 起，可 > 1440 表示跨午夜）。
 * plannedMinutes 是派生字段，但仍冗余存储，便于校验与排序；任何写入都经 createSession 计算。
 */

import {
  VALIDATION_CODES as C,
  checkEnum,
  checkNonNegativeInt,
  checkPositiveInt,
  checkRequiredString,
  error,
  isNonEmptyString,
  isPlainObject,
  result,
  warning,
} from './validation.js';
import { businessDateFor, isValidDateString, isValidTimeString, parseTimeString } from './time.js';

export const SESSION_STATE = Object.freeze({
  FLEXIBLE: 'flexible',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const SESSION_STATE_VALUES = Object.freeze(Object.values(SESSION_STATE));

/** 用户界面上的四种显示状态 */
export const SESSION_DISPLAY_STATE = Object.freeze({
  FLEXIBLE: 'flexible',
  PINNED: 'pinned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
});

export const SESSION_SOURCE = Object.freeze({
  ENGINE: 'engine',
  USER_MOVE: 'user_move',
  USER_CREATE: 'user_create',
  CARRIED_OVER: 'carried_over',
});

export const SESSION_SOURCE_VALUES = Object.freeze(Object.values(SESSION_SOURCE));

/** 单个学习时段的最长允许时长（8 小时）：作为数据合法性的最后一道防线 */
export const SESSION_MAX_MINUTES = 8 * 60;

/** 合法生命周期迁移表 */
export const SESSION_TRANSITIONS = Object.freeze({
  [SESSION_STATE.FLEXIBLE]: [SESSION_STATE.IN_PROGRESS, SESSION_STATE.COMPLETED, SESSION_STATE.CANCELLED],
  [SESSION_STATE.IN_PROGRESS]: [SESSION_STATE.COMPLETED, SESSION_STATE.FLEXIBLE, SESSION_STATE.CANCELLED],
  [SESSION_STATE.COMPLETED]: [], // 终态：只能通过"撤销完成"这一显式且需要用户确认的操作处理，见 reopenSession
  [SESSION_STATE.CANCELLED]: [SESSION_STATE.FLEXIBLE], // 允许把误删的时段放回待排
});

export function canTransitionSession(from, to) {
  const allowed = SESSION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** 界面上展示的状态（四种之一） */
export function displayStateOf(session) {
  if (session.state === SESSION_STATE.COMPLETED) return SESSION_DISPLAY_STATE.COMPLETED;
  if (session.state === SESSION_STATE.IN_PROGRESS) return SESSION_DISPLAY_STATE.IN_PROGRESS;
  return session.locked ? SESSION_DISPLAY_STATE.PINNED : SESSION_DISPLAY_STATE.FLEXIBLE;
}

/** 该时段是否禁止被自动排程改动（硬约束） */
export function isLockedForScheduling(session) {
  return Boolean(session.locked) || session.state === SESSION_STATE.COMPLETED || session.state === SESSION_STATE.IN_PROGRESS;
}

/** 该时段是否计入"已完成工作量" */
export function isCompleted(session) {
  return session.state === SESSION_STATE.COMPLETED;
}

/** 时长（分钟） */
export function sessionLength(session) {
  return (session.endMinutes ?? 0) - (session.startMinutes ?? 0);
}

/** 计入已完成工作量的分钟数：优先实际学习时长 */
export function effectiveCompletedMinutes(session) {
  if (!isCompleted(session)) return 0;
  return session.actualMinutes ?? session.plannedMinutes ?? sessionLength(session);
}

/** 是否跨午夜（结束分钟数超过 1440） */
export function isOvernight(session) {
  return (session.endMinutes ?? 0) > 1440;
}

/**
 * 构造一个 StudySession。
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.date
 * @param {number|string} input.startMinutes 允许 'HH:mm' 或分钟数
 * @param {number|string} input.endMinutes   允许 'HH:mm' 或分钟数
 * @param {object} ctx { idFactory, nowIso, dayBoundaryHour? }
 */
export function createSession(input, ctx) {
  if (!isPlainObject(input)) throw new TypeError('createSession 需要对象输入');
  if (!ctx || typeof ctx.idFactory?.next !== 'function') throw new TypeError('createSession 需要 ctx.idFactory');
  if (typeof ctx.nowIso !== 'string') throw new TypeError('createSession 需要 ctx.nowIso');

  const startMinutes = resolveMinutes(input.startMinutes);
  let endMinutes = resolveMinutes(input.endMinutes);
  // 同一天内 end <= start 的输入按跨夜处理（例如 '23:00' → '00:30'）
  if (endMinutes <= startMinutes && startMinutes < 1440) endMinutes += 1440;

  const session = {
    id: ctx.idFactory.next('session'),
    taskId: input.taskId,
    date: input.date,
    startMinutes,
    endMinutes,
    plannedMinutes: endMinutes - startMinutes,
    actualMinutes: input.actualMinutes ?? null,
    state: input.state ?? SESSION_STATE.FLEXIBLE,
    locked: input.locked === true,
    source: input.source ?? SESSION_SOURCE.USER_CREATE,
    reasonCodes: Array.isArray(input.reasonCodes) ? [...input.reasonCodes] : [],
    planVersion: input.planVersion ?? null,
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    startedAt: null,
    completedAt: input.completedAt ?? null,
    history: [],
  };
  if (session.state === SESSION_STATE.IN_PROGRESS) session.locked = true;
  if (session.state === SESSION_STATE.COMPLETED) session.completedAt = session.completedAt ?? ctx.nowIso;
  return session;
}

function resolveMinutes(value) {
  if (typeof value === 'number') return Math.round(value);
  if (isValidTimeString(value)) return parseTimeString(value);
  throw new TypeError(`无法解析的时刻：${JSON.stringify(value)}（应为 'HH:mm' 或分钟数）`);
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 校验单个时段。
 * @param {object} session
 * @param {string} path
 * @param {{ taskExists?: (taskId: string) => boolean, dayBoundaryHour?: number }} [options]
 */
export function validateSession(session, path = 'session', options = {}) {
  const issues = [];

  if (!isPlainObject(session)) {
    return result([error(C.TYPE, path, '学习时段必须是一个对象。', { actual: typeof session })]);
  }

  const idIssue = checkRequiredString(session.id, `${path}.id`, '时段 ID', { maxLength: 64 });
  if (idIssue) issues.push(idIssue);

  const taskIssue = checkRequiredString(session.taskId, `${path}.taskId`, '所属任务 ID', { maxLength: 64 });
  if (taskIssue) issues.push(taskIssue);
  if (typeof options.taskExists === 'function' && isNonEmptyString(session.taskId, 64) && !options.taskExists(session.taskId)) {
    /**
     * 悬空引用要区分"还在占用时间的时段"和"已经完成的学习历史"。
     *
     * - 未完成的时段：它是**当前有效占位**，指向不存在的任务是真正的错误
     *   （会把那段时间永久锁住），必须报错并由 reconcile 取消。
     * - 已完成/已取消的时段：它只是一条历史记录，任务被彻底删除后链接自然会失效。
     *   这不应阻止数据读取，也不该被当成损坏数据——否则用户会打不开应用。
     */
    const isHistory = session.state === SESSION_STATE.COMPLETED || session.state === SESSION_STATE.CANCELLED;
    if (isHistory) {
      issues.push(
        warning(C.ENTITY_DANGLING_REF, `${path}.taskId`, `这条历史学习记录的任务已被删除（${session.taskId}），时长仍计入统计。`, {
          taskId: session.taskId,
        }),
      );
    } else {
      issues.push(
        error(C.ENTITY_DANGLING_REF, `${path}.taskId`, `时段引用了不存在的任务（${session.taskId}）。`, { taskId: session.taskId }),
      );
    }
  }

  if (!isValidDateString(session.date)) {
    issues.push(error(C.REQUIRED, `${path}.date`, '时段日期必须是合法的 YYYY-MM-DD。', { actual: session.date }));
  }

  const startIssue = checkNonNegativeInt(session.startMinutes, `${path}.startMinutes`, '开始时间', { max: 1440 });
  if (startIssue) issues.push(startIssue);
  const endIssue = checkPositiveInt(session.endMinutes, `${path}.endMinutes`, '结束时间', {
    min: 1,
    max: 1440 + SESSION_MAX_MINUTES,
  });
  if (endIssue) issues.push(endIssue);

  if (Number.isInteger(session.startMinutes) && Number.isInteger(session.endMinutes)) {
    const length = session.endMinutes - session.startMinutes;
    if (length <= 0) {
      issues.push(
        error(C.SESSION_EMPTY_SPAN, `${path}.endMinutes`, '学习时段的结束时间必须晚于开始时间（跨午夜请让结束分钟数大于 1440）。', {
          startMinutes: session.startMinutes,
          endMinutes: session.endMinutes,
        }),
      );
    } else if (length > SESSION_MAX_MINUTES) {
      issues.push(
        error(C.SESSION_LENGTH_INVALID, `${path}.plannedMinutes`, `单个学习时段不能超过 ${SESSION_MAX_MINUTES} 分钟（当前 ${length} 分钟）。`, {
          length,
          max: SESSION_MAX_MINUTES,
        }),
      );
    }
    if (session.plannedMinutes !== undefined && session.plannedMinutes !== length) {
      issues.push(
        error(C.SESSION_LENGTH_INVALID, `${path}.plannedMinutes`, `计划时长（${session.plannedMinutes}）与起止时间不符（应为 ${length}）。`, {
          plannedMinutes: session.plannedMinutes,
          expected: length,
        }),
      );
    }
  }

  const stateIssue = checkEnum(session.state, SESSION_STATE_VALUES, `${path}.state`, '时段状态');
  if (stateIssue) issues.push(stateIssue);

  if (typeof session.locked !== 'boolean') {
    issues.push(error(C.TYPE, `${path}.locked`, '锁定标记必须是布尔值。', { actual: typeof session.locked }));
  }
  if (session.state === SESSION_STATE.IN_PROGRESS && session.locked !== true) {
    issues.push(error(C.ENUM, `${path}.locked`, '进行中的时段必须处于锁定状态（锁定是硬约束，不是优先级加分）。', {}));
  }

  if (session.actualMinutes !== undefined && session.actualMinutes !== null) {
    const actualIssue = checkNonNegativeInt(session.actualMinutes, `${path}.actualMinutes`, '实际学习时长', { max: 24 * 60 });
    if (actualIssue) issues.push(actualIssue);
  }

  const sourceIssue = checkEnum(session.source, SESSION_SOURCE_VALUES, `${path}.source`, '时段来源');
  if (sourceIssue) issues.push(sourceIssue);

  // 业务日归属必须与规则一致（04:00 之前的时段属于前一天）
  if (isValidDateString(session.date) && Number.isInteger(session.startMinutes)) {
    const expected = businessDateFor(session.date, session.startMinutes, options.dayBoundaryHour);
    if (session.businessDate !== undefined && session.businessDate !== expected) {
      issues.push(
        error(C.SESSION_EMPTY_SPAN, `${path}.businessDate`, `业务日归属与规则不符：应为 ${expected}。`, {
          expected,
          actual: session.businessDate,
        }),
      );
    }
  }

  return result(issues);
}

/** 计算业务日归属（不落库，按需计算，避免冗余字段漂移） */
export function businessDateOf(session, dayBoundaryHour) {
  return businessDateFor(session.date, session.startMinutes, dayBoundaryHour);
}

/* ------------------------------------------------------------------ *
 * 状态迁移与锁定
 * ------------------------------------------------------------------ */

/** 通用迁移：返回 { session, issue } */
export function transitionSession(session, to, ctx = {}) {
  if (!canTransitionSession(session.state, to)) {
    return {
      session,
      issue: error(C.ENUM, 'session.state', `学习时段状态不能从「${session.state}」直接变为「${to}」。`, {
        from: session.state,
        to,
      }),
    };
  }
  return { session: { ...session, state: to, updatedAt: ctx.nowIso ?? session.updatedAt }, issue: null };
}

/**
 * 开始学习：flexible → in_progress，并按硬约束自动锁定（进行中的时段不得被重排移动）。
 */
export function startSession(session, ctx) {
  if (session.state === SESSION_STATE.IN_PROGRESS) return { session, issue: null };
  const { session: moved, issue } = transitionSession(session, SESSION_STATE.IN_PROGRESS, ctx);
  if (issue) return { session, issue };
  return { session: { ...moved, locked: true, startedAt: ctx.nowIso }, issue: null };
}

/**
 * 结束学习：in_progress → completed，记录实际时长。
 * actualMinutes 缺省用计划时长，但调用方（工作台）应显式传入真实秒表读数。
 */
export function completeSession(session, ctx, { actualMinutes } = {}) {
  if (session.state === SESSION_STATE.COMPLETED) return { session, issue: null };
  // flexible 与 in_progress 都可以转为 completed：
  // flexible 代表用户线下已经学完这一段，允许直接标记完成。
  if (session.state === SESSION_STATE.CANCELLED) {
    return {
      session,
      issue: error(C.ENUM, 'session.state', '已取消的时段不能直接标记完成，请先把它放回待排。', { state: session.state }),
    };
  }
  const { session: moved, issue } = transitionSession(session, SESSION_STATE.COMPLETED, ctx);
  if (issue) return { session, issue };
  const actual = Number.isFinite(actualMinutes) ? Math.max(0, Math.round(actualMinutes)) : session.plannedMinutes;
  return {
    session: { ...moved, actualMinutes: actual, completedAt: ctx.nowIso, startedAt: session.startedAt ?? null },
    issue: null,
  };
}

/**
 * 撤销完成：completed → in_progress。
 * 这是 completed 终态的唯一出口，**必须由用户显式确认**后调用；
 * 引擎在任何自动流程中都不得调用本函数。
 */
export function reopenSession(session, ctx) {
  if (session.state !== SESSION_STATE.COMPLETED) {
    return { session, issue: error(C.ENUM, 'session.state', '只有已完成的学习时段才能撤销完成。', { state: session.state }) };
  }
  return {
    session: { ...session, state: SESSION_STATE.IN_PROGRESS, actualMinutes: null, completedAt: null, updatedAt: ctx.nowIso },
    issue: null,
  };
}

/** 用户锁定：把时段钉在具体时间上（硬约束） */
export function lockSession(session, ctx = {}) {
  if (session.state === SESSION_STATE.COMPLETED) {
    return { session, issue: error(C.ENUM, 'session.locked', '已完成的时段无需锁定（它本来就不可被自动改动）。', {}) };
  }
  return { session: { ...session, locked: true, lockedAt: ctx.nowIso ?? session.lockedAt ?? null, updatedAt: ctx.nowIso ?? session.updatedAt }, issue: null };
}

/** 用户解锁：仅对未开始（flexible）的时段有效 */
export function unlockSession(session, ctx = {}) {
  if (session.state !== SESSION_STATE.FLEXIBLE) {
    return {
      session,
      issue: error(C.ENUM, 'session.locked', '只有未开始（flexible）的时段才能解除锁定；进行中和已完成的时段不可解锁。', { state: session.state }),
    };
  }
  return { session: { ...session, locked: false, lockedAt: null, updatedAt: ctx.nowIso ?? session.updatedAt }, issue: null };
}

/**
 * 用户手动移动/调整时段。
 * 尝试移动锁定时段会返回 issue（调用方必须先解锁并重新生成预览）；
 * 已完成时段一律拒绝改动。
 */
export function moveSession(session, next, ctx = {}) {
  if (session.state === SESSION_STATE.COMPLETED) {
    return { session, issue: error(C.ENUM, 'session.state', '已完成的学习时段不能被移动或调整。', { sessionId: session.id }) };
  }
  if (session.locked) {
    return {
      session,
      issue: error(C.ENUM, 'session.locked', '该时段已锁定，请先解除锁定再修改时间，以免自动规划把它移回原处。', { sessionId: session.id }),
    };
  }
  const startMinutes = resolveMinutes(next.startMinutes);
  let endMinutes = resolveMinutes(next.endMinutes);
  if (endMinutes <= startMinutes && startMinutes < 1440) endMinutes += 1440;
  const length = endMinutes - startMinutes;
  if (length <= 0 || length > SESSION_MAX_MINUTES) {
    return {
      session,
      issue: error(C.SESSION_LENGTH_INVALID, 'session.endMinutes', `时段长度必须在 1 – ${SESSION_MAX_MINUTES} 分钟之间。`, { length }),
    };
  }
  const entry = {
    at: ctx.nowIso ?? session.updatedAt,
    action: 'move',
    from: { date: session.date, startMinutes: session.startMinutes, endMinutes: session.endMinutes },
    to: { date: next.date ?? session.date, startMinutes, endMinutes },
  };
  return {
    session: {
      ...session,
      date: next.date ?? session.date,
      startMinutes,
      endMinutes,
      plannedMinutes: length,
      source: SESSION_SOURCE.USER_MOVE,
      updatedAt: ctx.nowIso ?? session.updatedAt,
      history: [...(session.history ?? []), entry],
    },
    issue: null,
  };
}

/* ------------------------------------------------------------------ *
 * 查询辅助（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 两个时段是否正重叠（半开区间）。
 *
 * 实现要点：先把两段换算到同一"基准日期"的坐标系（跨日整体平移 ±1440 分钟）再比较。
 * 不能只平移开始时间而用未平移的时长，否则跨夜时段与次日时段的比较会得出错误结论。
 */
export function sessionsOverlap(a, b) {
  if (a.id === b.id) return false;
  // 两段必须换算到**同一个基准日**才能比较；分别以对方日期为基准会得到自相矛盾的坐标系。
  const base = a.date;
  const spanA = toComparableSpan(a, base);
  const spanB = toComparableSpan(b, base);
  if (!spanA || !spanB) return false; // 日期相差超过一天，必然不重叠
  return spanA.start < spanB.end && spanB.start < spanA.end;
}

/**
 * 把时段换算到相对基准日的坐标（基准日的 00:00 作为原点）。
 * 与基准日相差超过一天时回传 null（不可能重叠）。
 */
function toComparableSpan(session, baseDate) {
  const dayDiff = dateToOrdinal(session.date) - dateToOrdinal(baseDate);
  if (Math.abs(dayDiff) > 1) return null;
  return { start: session.startMinutes + dayDiff * 1440, end: session.endMinutes + dayDiff * 1440 };
}

/** 日期字符串 → 天序号（本地纯日历运算，避免 Date 的时区陷阱） */
function dateToOrdinal(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/** 按状态过滤 */
export function filterByState(sessions, state) {
  return sessions.filter((s) => s.state === state);
}

/** 归属到某个业务日的全部时段（含跨夜时段的前半段） */
export function sessionsForBusinessDate(sessions, date, dayBoundaryHour) {
  return sessions.filter((s) => businessDateOf(s, dayBoundaryHour) === date);
}

/** 按 (日期, 开始时间, id) 稳定排序，保证渲染与测试输出确定 */
export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
