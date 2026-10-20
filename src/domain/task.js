/**
 * Task（学习任务）领域模型。
 *
 * 核心设计决定：
 * 1. **Task 与 StudySession 严格分离**。Task 只描述「要做什么、多久、什么时候前必须完成」；
 *    具体安排在哪些时段由 StudySession 表达。一个 Task 可以拥有 0..N 个 StudySession。
 * 2. **剩余工作量是推导值，不是存储字段**：
 *      completedMinutes(task) = Σ session[state==='completed'].actualMinutes ?? plannedMinutes
 *      remainingMinutes(task) = plannedMinutes − completedMinutes(task)
 *    这样「任务时长、已完成、剩余」三者天然不会漂移；任何不一致都由校验器报 V015/V016，
 *    而不是靠界面各自维护一个数字。
 * 3. 不包含任何 UI / 存储 / 引擎逻辑，纯数据 + 纯函数。
 */

import {
  TASK_NAME_MAX_LENGTH,
  VALIDATION_CODES as C,
  checkEnum,
  checkPositiveInt,
  checkRequiredString,
  error,
  isNonEmptyString,
  isPlainObject,
  isPositiveInt,
  result,
  warning,
} from './validation.js';
import { isValidDateString, isValidTimeString } from './time.js';

/** 任务状态 */
export const TASK_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DELETED: 'deleted', // 软删除：保留历史时段，但不参与排程
});

export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS));

/** 参与排程的状态（未开始、进行中） */
export const SCHEDULABLE_TASK_STATUSES = Object.freeze([TASK_STATUS.NOT_STARTED, TASK_STATUS.IN_PROGRESS]);

/** 主观评分范围（1–5 级，映射到 0–100 由 engine/priority.js 负责） */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** 任务名称与科目长度上限 */
/**
 * 任务名称长度上限。
 *
 * 统一由 `validation.js` 的 TASK_NAME_MAX_LENGTH 决定，
 * 这里保留一个别名供既有代码引用，避免出现两套数字。
 */
export const TITLE_MAX_LENGTH = TASK_NAME_MAX_LENGTH;

/** 学习片段时长的合法下限（分钟）——与排程器的最小粒度一致 */
export const CHUNK_MINUTES_FLOOR = 5;

/** 计划开始时间（可选）的合法范围：一天内的分钟数 */
export const PLANNED_START_MIN = 0;
export const PLANNED_START_MAX = 24 * 60;
export const SUBJECT_MAX_LENGTH = 40;

/** 单任务预计用时的硬上限（一周 7×24 小时），防止误输入 999999 分钟 */
export const PLANNED_MINUTES_MAX = 7 * 24 * 60;

/** 合法状态迁移表：from → 允许的 to 集合 */
export const TASK_TRANSITIONS = Object.freeze({
  [TASK_STATUS.NOT_STARTED]: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.DELETED],
  [TASK_STATUS.IN_PROGRESS]: [TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED, TASK_STATUS.DELETED, TASK_STATUS.NOT_STARTED],
  [TASK_STATUS.COMPLETED]: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.DELETED],
  [TASK_STATUS.CANCELLED]: [TASK_STATUS.NOT_STARTED, TASK_STATUS.DELETED],
  [TASK_STATUS.DELETED]: [TASK_STATUS.NOT_STARTED], // 仅"恢复已删除任务"
});

/** 判断状态迁移是否合法 */
export function canTransitionTask(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/* ------------------------------------------------------------------ *
 * 创建
 * ------------------------------------------------------------------ */

/**
 * 创建任务的默认输入（UI 表单初值 / 测试构造用）。
 * 注意：这里不生成虚构的示例任务数据，只是字段默认值。
 */
export function createTaskDraft() {
  return {
    title: '',
    subject: '',
    plannedMinutes: 60,
    deadlineDate: '',
    deadlineTime: '23:00',
    importance: 3,
    difficulty: 3,
    procrastination: 3,
    splittable: true,
    /**
     * 以下三个字段都是**可选**的，空值统一用 `null` 表示（不是 0，也不是空字符串）：
     * - priorCompletedMinutes：留空 = 还没开始做（等价 0 分钟）；显式填 0 也合法
     * - minChunkMinutes / maxChunkMinutes：留空 = 由排程器按系统默认规则决定
     * 把"留空"和"填 0"区分开，是为了让界面能如实回显用户到底填了什么。
     */
    minChunkMinutes: null,
    maxChunkMinutes: null,
    /** 计划开始时间（分钟，0–1440）；null = 不限制，从本次规划起点开始考虑 */
    plannedStartMinutes: null,
    /** "已经完成"同样是可选项；草稿里用空值表示"用户还没填" */
    priorCompletedMinutes: null,
    dependsOn: [],
    note: '',
  };
}

/**
 * 由用户输入构造一个完整 Task 实体（不校验；校验请调用 validateTask）。
 * @param {object} input 见 createTaskDraft
 * @param {object} ctx
 * @param {{ next: (kind: string) => string }} ctx.idFactory
 * @param {string} ctx.nowIso 当前时间（ISO 字符串，由调用方提供，保证可测）
 */
export function createTask(input, ctx) {
  if (!isPlainObject(input)) throw new TypeError('createTask 需要对象输入');
  if (!ctx || typeof ctx.idFactory?.next !== 'function') throw new TypeError('createTask 需要 ctx.idFactory');
  if (typeof ctx.nowIso !== 'string') throw new TypeError('createTask 需要 ctx.nowIso（ISO 时间字符串）');

  const splittable = input.splittable !== false;
  const plannedMinutes = input.plannedMinutes;
  /**
   * 可拆分任务保留用户填的（可能为空）最短/最长时段；
   * 不可拆分任务没有"分段"概念，min/max 就应当等于总时长。
   */
  const minChunkMinutes = splittable ? normalizeOptionalMinutes(input.minChunkMinutes) : plannedMinutes;
  const maxChunkMinutes = splittable ? normalizeOptionalMinutes(input.maxChunkMinutes) : plannedMinutes;

  return {
    id: ctx.idFactory.next('task'),
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    subject: typeof input.subject === 'string' ? input.subject.trim() : input.subject,
    plannedMinutes,
    /**
     * 用户手工声明的"已经完成的时长"（应用之外的学习，例如纸质作业）。
     * 剩余时长 = plannedMinutes − (priorCompletedMinutes + 应用内完成记录)，始终是派生值。
     */
    priorCompletedMinutes: normalizeOptionalCompleted(input.priorCompletedMinutes),
    deadlineDate: input.deadlineDate,
    deadlineTime: input.deadlineTime,
    importance: input.importance,
    difficulty: input.difficulty,
    procrastination: input.procrastination,
    splittable,
    minChunkMinutes,
    maxChunkMinutes,
    /** 计划开始时间：只作为"最早考虑时间"的偏好，不是硬锁（见 engine/placer.js） */
    plannedStartMinutes: normalizeOptionalMinutes(input.plannedStartMinutes),
    dependsOn: Array.isArray(input.dependsOn) ? [...new Set(input.dependsOn)] : [],
    status: TASK_STATUS.NOT_STARTED,
    note: typeof input.note === 'string' ? input.note : '',
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    deletedAt: null,
  };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 校验单个任务的结构与内部一致性（不含跨任务依赖检查，那需要全量任务表）。
 * @param {object} task
 * @param {string} path 数据路径前缀，如 'tasks[0]'
 * @returns {{ok: boolean, errors: object[], warnings: object[], issues: object[]}}
 */
export function validateTask(task, path = 'task', { lenientName = false } = {}) {
  const issues = [];

  if (!isPlainObject(task)) {
    return result([error(C.TYPE, path, '任务必须是一个对象。', { actual: typeof task })]);
  }

  const idIssue = checkRequiredString(task.id, `${path}.id`, '任务 ID', { maxLength: 64 });
  if (idIssue) issues.push(idIssue);

  /**
   * 名称：空名称是错误；超长在"保存"时是错误，在"加载"时只给提示。
   *
   * 为什么要区分：历史版本没有长度限制，已有数据里可能存在更长的名称。
   * 如果加载时直接判错，用户会打不开应用（这比名称过长严重得多）。
   * 因此加载时降级为 warning，让用户自己编辑修正，且**不截断原始数据**。
   */
  const titleIssue = checkRequiredString(task.title, `${path}.title`, '任务名称', {
    maxLength: TITLE_MAX_LENGTH,
    countCodePoints: true,
  });
  if (titleIssue) {
    if (lenientName && titleIssue.code === C.STRING_TOO_LONG) {
      issues.push(
        warning(
          titleIssue.code,
          `${path}.title`,
          `「${String(task.title).slice(0, 20)}」的名称超过 ${TASK_NAME_MAX_LENGTH} 个字符，请编辑时精简（数据本身未被修改）。`,
          titleIssue.details,
        ),
      );
    } else {
      issues.push(titleIssue);
    }
  }

  const subjectIssue = checkRequiredString(task.subject, `${path}.subject`, '所属科目', { maxLength: SUBJECT_MAX_LENGTH });
  if (subjectIssue) issues.push(subjectIssue);

  const plannedIssue = checkPositiveInt(task.plannedMinutes, `${path}.plannedMinutes`, '预计总用时', {
    min: 1,
    max: PLANNED_MINUTES_MAX,
  });
  if (plannedIssue) issues.push(plannedIssue);

  /**
   * "已经完成（分钟）"：**可选**。
   * - 留空（null / 缺失）= 还没开始做，按 0 计算；
   * - 显式 0 合法；
   * - 唯一硬性要求：不能超过预计总用时（否则剩余工作量会变成负数，排程无法解释）。
   */
  if (task.priorCompletedMinutes !== undefined && task.priorCompletedMinutes !== null) {
    const prior = task.priorCompletedMinutes;
    if (!Number.isInteger(prior) || prior < 0) {
      issues.push(
        error(
          C.RANGE,
          `${path}.priorCompletedMinutes`,
          '已完成时长可以留空，或填写大于等于 0 的整数分钟。',
          { actual: prior },
        ),
      );
    } else if (Number.isFinite(task.plannedMinutes) && prior > task.plannedMinutes) {
      issues.push(
        error(
          C.TASK_OVER_COMPLETED,
          `${path}.priorCompletedMinutes`,
          `已完成时长（${prior} 分钟）不能超过预计总用时（${task.plannedMinutes} 分钟）。`,
          { prior, plannedMinutes: task.plannedMinutes },
        ),
      );
    }
  }

  /**
   * "计划开始时间"：**可选**，表示"希望任务从这个时间之后开始被考虑"。
   * 它不是锁定时间段，也不是固定日程；留空表示不做时间偏好。
   */
  if (task.plannedStartMinutes !== undefined && task.plannedStartMinutes !== null) {
    const start = task.plannedStartMinutes;
    if (!Number.isInteger(start) || start < PLANNED_START_MIN || start > PLANNED_START_MAX) {
      issues.push(
        error(
          C.RANGE,
          `${path}.plannedStartMinutes`,
          '计划开始时间可以留空，或填写 00:00 – 24:00 之间的时刻。',
          { actual: start },
        ),
      );
    }
  }

  // 截止日期与时间：必须是**真实存在**的日历日与合法时刻
  // （例如 2025-02-30 或 25:99 必须在这里被拦住，而不是留给引擎去处理）
  if (!isNonEmptyString(task.deadlineDate, 10)) {
    issues.push(error(C.REQUIRED, `${path}.deadlineDate`, '截止日期不能为空，格式为 YYYY-MM-DD。'));
  } else if (!isValidDateString(task.deadlineDate)) {
    issues.push(
      error(C.RANGE, `${path}.deadlineDate`, `截止日期不是真实存在的日期（当前 ${task.deadlineDate}），请检查月份与日号。`, {
        actual: task.deadlineDate,
      }),
    );
  }
  if (!isNonEmptyString(task.deadlineTime, 5)) {
    issues.push(error(C.REQUIRED, `${path}.deadlineTime`, '截止时间不能为空，格式为 HH:mm。'));
  } else if (!isValidTimeString(task.deadlineTime)) {
    issues.push(
      error(C.RANGE, `${path}.deadlineTime`, `截止时间不是合法的时刻（当前 ${task.deadlineTime}），应形如 23:00。`, {
        actual: task.deadlineTime,
      }),
    );
  }

  for (const [key, label] of [
    ['importance', '重要程度'],
    ['difficulty', '难度'],
    ['procrastination', '拖延风险'],
  ]) {
    const value = task[key];
    if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
      issues.push(
        error(C.RANGE, `${path}.${key}`, `${label}必须是 ${RATING_MIN} – ${RATING_MAX} 的整数（当前 ${JSON.stringify(value)}）。`, {
          actual: value,
          min: RATING_MIN,
          max: RATING_MAX,
        }),
      );
    }
  }

  const statusIssue = checkEnum(task.status, TASK_STATUS_VALUES, `${path}.status`, '任务状态');
  if (statusIssue) issues.push(statusIssue);

  if (typeof task.splittable !== 'boolean') {
    issues.push(error(C.TYPE, `${path}.splittable`, '是否允许拆分必须是布尔值。', { actual: typeof task.splittable }));
  }

  // —— 拆分相关一致性 ——
  if (task.splittable === false) {
    if (isPositiveInt(task.plannedMinutes)) {
      if (task.minChunkMinutes !== task.plannedMinutes || task.maxChunkMinutes !== task.plannedMinutes) {
        issues.push(
          error(
            C.TASK_ATOMIC_MISMATCH,
            `${path}.maxChunkMinutes`,
            `不可拆分任务的最短/最长时段必须等于其总时长（${task.plannedMinutes} 分钟），当前为 ${task.minChunkMinutes} / ${task.maxChunkMinutes}。`,
            { plannedMinutes: task.plannedMinutes, min: task.minChunkMinutes, max: task.maxChunkMinutes },
          ),
        );
      }
    }
  } else if (task.splittable === true) {
    /**
     * 最短 / 最长学习时段：**可选**。
     * 留空表示"不额外限制，由排程器按系统默认值与可用时间决定"，
     * 因此这里只在用户**填了值**时才校验（不能把空值当成 0 分钟）。
     */
    const minHas = task.minChunkMinutes !== undefined && task.minChunkMinutes !== null;
    const maxHas = task.maxChunkMinutes !== undefined && task.maxChunkMinutes !== null;

    if (minHas) {
      const minIssue = checkPositiveInt(task.minChunkMinutes, `${path}.minChunkMinutes`, '最短学习时段', {
        min: CHUNK_MINUTES_FLOOR,
        max: PLANNED_MINUTES_MAX,
      });
      if (minIssue) issues.push(minIssue);
    }
    if (maxHas) {
      const maxIssue = checkPositiveInt(task.maxChunkMinutes, `${path}.maxChunkMinutes`, '最长学习时段', {
        min: CHUNK_MINUTES_FLOOR,
        max: PLANNED_MINUTES_MAX,
      });
      if (maxIssue) issues.push(maxIssue);
    }
    if (minHas && maxHas && isPositiveInt(task.minChunkMinutes) && isPositiveInt(task.maxChunkMinutes) && task.minChunkMinutes > task.maxChunkMinutes) {
      issues.push(
        error(
          C.TASK_MIN_MAX_CHUNK,
          `${path}.minChunkMinutes`,
          `最短学习时段（${task.minChunkMinutes} 分钟）不能大于最长学习时段（${task.maxChunkMinutes} 分钟）。`,
          { min: task.minChunkMinutes, max: task.maxChunkMinutes },
        ),
      );
    }
  }

  const dependsOnIssue = validateDependsOnShape(task, path);
  if (dependsOnIssue) issues.push(dependsOnIssue);

  // —— 时间戳审计字段 ——
  for (const key of ['createdAt', 'updatedAt']) {
    if (!isNonEmptyString(task[key], 40)) {
      issues.push(error(C.REQUIRED, `${path}.${key}`, `${key} 必须是非空的时间字符串。`));
    }
  }

  return result(issues);
}

/** dependsOn 必须是字符串数组且不含自身引用 */
function validateDependsOnShape(task, path) {
  if (task.dependsOn === undefined) return null;
  if (!Array.isArray(task.dependsOn)) {
    return error(C.TYPE, `${path}.dependsOn`, '前置任务必须是 ID 数组。', { actual: typeof task.dependsOn });
  }
  for (const [idx, dep] of task.dependsOn.entries()) {
    if (!isNonEmptyString(dep, 64)) {
      return error(C.TYPE, `${path}.dependsOn[${idx}]`, '前置任务 ID 必须是非空字符串。', { actual: dep });
    }
    if (dep === task.id) {
      return error(C.TASK_DEPENDENCY_SELF, `${path}.dependsOn[${idx}]`, '任务不能依赖自己。', { id: task.id });
    }
  }
  if (new Set(task.dependsOn).size !== task.dependsOn.length) {
    return error(C.ENTITY_DUPLICATE_ID, `${path}.dependsOn`, '前置任务列表中存在重复项。', { dependsOn: task.dependsOn });
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 工作量推导（唯一权威定义）
 * ------------------------------------------------------------------ */

/** 单个 StudySession 计入"已完成工作量"的分钟数：优先实际时长，缺省用计划时长 */
export function sessionCompletedMinutes(session) {
  if (!session || typeof session !== 'object') return 0;
  if (session.actualMinutes !== undefined && session.actualMinutes !== null) return session.actualMinutes;
  return session.plannedMinutes ?? 0;
}

/**
 * 汇总某任务的已完成分钟数。
 * @param {string} taskId
 * @param {object[]} sessions 全部时段（函数内部按 taskId 过滤）
 */
export function completedMinutesForTask(taskId, sessions = []) {
  let total = 0;
  for (const s of sessions) {
    if (s && s.taskId === taskId && s.state === 'completed') total += sessionCompletedMinutes(s);
  }
  return total;
}

/**
 * 任务已完成的总时长 = **用户手工声明的部分** + **应用内完成记录**。
 *
 * 为什么需要"手工声明"：很多学习发生在应用之外（纸质作业、线下课程、别的设备）。
 * 只统计应用内记录会让这些任务永远显示"还剩全部"，排程也会重复安排已经做完的部分。
 * 用户在任务里填"已完成 30 分钟"就是把这个事实告诉系统。
 *
 * 注意：剩余时长**依然是派生值**（预计总用时 − 已完成），从不单独存储，
 * 因此不会出现"剩余时长与记录不一致"的脏数据。
 */
/**
 * "已经完成（分钟）"的可选值归一化。
 *
 * 规则（与界面提示一致）：
 * - 留空（null / undefined / ''）→ `null`，表示"还没开始做"，计算时按 0 处理；
 * - 显式 0 → `0`，是一种真实输入，保留；
 * - 正数 → 向下取整的整数分钟；
 * - 负数或非数字 → `null`（交给校验器报错，而不是悄悄当成 0）。
 */
function normalizeOptionalCompleted(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < 0) return null;
  return Math.floor(number);
}

/**
 * "最短/最长学习时段"与"计划开始时间"的可选值归一化：
 * 留空或非法 → `null`（表示不使用用户自定义值），正数 → 整数分钟。
 */
function normalizeOptionalMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

/**
 * 读取"已经完成"的分钟数。
 *
 * `null`（用户留空）与 `0`（用户明确填 0）在这里都按 0 分钟参与计算——
 * 这是**明确定义的默认规则**，不是把两种输入混为一谈：
 * 存储上它们依然可区分（界面会如实回显用户填了什么）。
 */
export function claimedPriorMinutes(task) {
  const value = task?.priorCompletedMinutes;
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** 合计已完成时长（手工声明 + 应用内完成记录） */
export function totalCompletedMinutesForTask(task, sessions = []) {
  if (!task) return 0;
  return claimedPriorMinutes(task) + completedMinutesForTask(task.id, sessions);
}

/**
 * 汇总某任务当前**未完成**时段的计划分钟数（排除 completed；包含 flexible / in_progress）。
 * 与 completedMinutes 一起用于 V016 一致性校验。
 */
export function pendingPlannedMinutesForTask(taskId, sessions = []) {
  let total = 0;
  for (const s of sessions) {
    if (s && s.taskId === taskId && s.state !== 'completed' && s.state !== 'cancelled') total += s.plannedMinutes ?? 0;
  }
  return total;
}

/**
 * 剩余工作量（引擎排程的唯一依据）。
 * 已取消/已完成任务返回 0；clamp 到 ≥ 0（超额完成不会产生负数需求）。
 */
export function remainingMinutesForTask(task, sessions = []) {
  if (!task) return 0;
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED || task.status === TASK_STATUS.DELETED) {
    return 0;
  }
  const remaining = (task.plannedMinutes ?? 0) - totalCompletedMinutesForTask(task, sessions);
  return remaining > 0 ? remaining : 0;
}

/**
 * 任务的三重一致性校验（跨任务与时段）：
 *   T1 已完成分钟数 ≤ 预计总用时        （否则 V015）
 *   T2 未完成时段的计划总长 ≤ 剩余工作量（否则 V016）
 * 不比较"必须完全相等"是有意为之：7 天窗口之外的任务不会被排入，
 * 因此未排完不等于数据错误；这里只拦截**超出**这种真正矛盾的情况。
 */
export function validateTaskDurationConsistency(task, sessions, path = 'task') {
  const issues = [];
  const completed = totalCompletedMinutesForTask(task, sessions);
  if (completed > task.plannedMinutes) {
    issues.push(
      error(
        C.TASK_OVER_COMPLETED,
        `${path}.plannedMinutes`,
        `"${task.title}" 的已完成时长（${completed} 分钟）超过了预计总用时（${task.plannedMinutes} 分钟）。请调大预计总用时，或撤销某段完成的记录。`,
        { taskId: task.id, completed, plannedMinutes: task.plannedMinutes },
      ),
    );
  }
  const pending = pendingPlannedMinutesForTask(task.id, sessions);
  const remaining = remainingMinutesForTask(task, sessions);
  if (pending > remaining) {
    issues.push(
      error(
        C.TASK_DURATION_INCONSISTENT,
        `${path}.plannedMinutes`,
        `"${task.title}" 未完成时段合计 ${pending} 分钟，但剩余工作量只有 ${remaining} 分钟（已排时段超过了剩余工作量）。请重新规划或调整预计总用时。`,
        { taskId: task.id, pending, remaining },
      ),
    );
  }
  return result(issues);
}

/* ------------------------------------------------------------------ *
 * 修改
 * ------------------------------------------------------------------ */

/** 允许被直接修改的字段白名单（防止 UI 误改 id / 审计字段 / 推导字段） */
export const TASK_PATCHABLE_FIELDS = Object.freeze([
  'title',
  'subject',
  'plannedMinutes',
  'deadlineDate',
  'deadlineTime',
  'importance',
  'difficulty',
  'procrastination',
  'splittable',
  'minChunkMinutes',
  'maxChunkMinutes',
  'dependsOn',
  'note',
  'priorCompletedMinutes',
  'plannedStartMinutes',
]);

/**
 * 应用一次局部修改，返回**新对象**（不修改入参，便于撤销与预览）。
 * 处理两个衍生规则：
 * - splittable 变为 false：把 min/max 对齐到计划总用时；计划用时变化时同步对齐。
 * - splittable 为 true 且时长变化后 min > max：把 max 抬到 min（并保留提示由校验器输出）。
 */
export function applyTaskPatch(task, patch, ctx) {
  if (!isPlainObject(patch)) throw new TypeError('patch 必须是对象');
  if (!ctx || typeof ctx.nowIso !== 'string') throw new TypeError('applyTaskPatch 需要 ctx.nowIso');

  const next = { ...task, dependsOn: [...(task.dependsOn ?? [])] };
  for (const key of Object.keys(patch)) {
    if (!TASK_PATCHABLE_FIELDS.includes(key)) continue;
    next[key] = patch[key];
  }
  if (Array.isArray(next.dependsOn)) next.dependsOn = [...new Set(next.dependsOn)];
  if (typeof next.title === 'string') next.title = next.title.trim();
  if (typeof next.subject === 'string') next.subject = next.subject.trim();

  // 可选字段：把空字符串/undefined 统一成 null，保证"留空"语义不会退化成 0
  for (const key of ['priorCompletedMinutes', 'minChunkMinutes', 'maxChunkMinutes', 'plannedStartMinutes']) {
    if (!(key in next)) continue;
    const value = next[key];
    if (value === undefined || value === null || value === '') {
      next[key] = null;
    } else if (typeof value === 'string' && value.trim() === '') {
      next[key] = null;
    }
  }

  if (next.splittable === false) {
    next.minChunkMinutes = next.plannedMinutes;
    next.maxChunkMinutes = next.plannedMinutes;
  } else if (
    isPositiveInt(next.minChunkMinutes) &&
    isPositiveInt(next.maxChunkMinutes) &&
    next.minChunkMinutes > next.maxChunkMinutes
  ) {
    // 用户同时填了最短与最长，且最短更大：以"最短"为准抬高最长（校验器仍会给出提示）
    next.maxChunkMinutes = next.minChunkMinutes;
  }

  next.updatedAt = ctx.nowIso;
  return next;
}

/**
 * 状态迁移，返回 { task, issue }。
 * 非法迁移返回原任务 + 结构化错误，绝不静默忽略。
 */
export function transitionTaskStatus(task, to, ctx) {
  if (!ctx || typeof ctx.nowIso !== 'string') throw new TypeError('transitionTaskStatus 需要 ctx.nowIso');
  if (!canTransitionTask(task.status, to)) {
    return {
      task,
      issue: error(
        C.ENUM,
        'task.status',
        `任务状态不能从「${task.status}」直接变为「${to}」。`,
        { from: task.status, to },
      ),
    };
  }
  const next = { ...task, status: to, updatedAt: ctx.nowIso };
  if (to === TASK_STATUS.IN_PROGRESS && !next.startedAt) next.startedAt = ctx.nowIso;
  if (to === TASK_STATUS.COMPLETED) next.completedAt = ctx.nowIso;
  if (to === TASK_STATUS.CANCELLED) next.cancelledAt = ctx.nowIso;
  if (to === TASK_STATUS.DELETED) next.deletedAt = ctx.nowIso;
  if (to === TASK_STATUS.NOT_STARTED) {
    next.startedAt = null;
    next.completedAt = null;
    next.cancelledAt = null;
    next.deletedAt = null;
  }
  if (to === TASK_STATUS.IN_PROGRESS && task.status === TASK_STATUS.COMPLETED) next.completedAt = null;
  return { task: next, issue: null };
}

/** 依赖图工具：找出依赖会形成环的候选（用于 UI 在选择前置任务时禁用非法选项） */
export function findCyclicDependencyCandidate(taskId, candidateDepId, tasks = []) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [candidateDepId];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (node && Array.isArray(node.dependsOn)) stack.push(...node.dependsOn);
  }
  return false;
}
