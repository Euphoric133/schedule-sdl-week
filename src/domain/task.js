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
  VALIDATION_CODES as C,
  checkEnum,
  checkPositiveInt,
  checkRequiredString,
  error,
  isNonEmptyString,
  isPlainObject,
  isPositiveInt,
  result,
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
export const TITLE_MAX_LENGTH = 120;
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
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
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
  const minChunkMinutes = splittable ? input.minChunkMinutes : plannedMinutes;
  const maxChunkMinutes = splittable ? input.maxChunkMinutes : plannedMinutes;

  return {
    id: ctx.idFactory.next('task'),
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    subject: typeof input.subject === 'string' ? input.subject.trim() : input.subject,
    plannedMinutes,
    deadlineDate: input.deadlineDate,
    deadlineTime: input.deadlineTime,
    importance: input.importance,
    difficulty: input.difficulty,
    procrastination: input.procrastination,
    splittable,
    minChunkMinutes,
    maxChunkMinutes,
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
export function validateTask(task, path = 'task') {
  const issues = [];

  if (!isPlainObject(task)) {
    return result([error(C.TYPE, path, '任务必须是一个对象。', { actual: typeof task })]);
  }

  const idIssue = checkRequiredString(task.id, `${path}.id`, '任务 ID', { maxLength: 64 });
  if (idIssue) issues.push(idIssue);

  const titleIssue = checkRequiredString(task.title, `${path}.title`, '任务名称', { maxLength: TITLE_MAX_LENGTH });
  if (titleIssue) issues.push(titleIssue);

  const subjectIssue = checkRequiredString(task.subject, `${path}.subject`, '所属科目', { maxLength: SUBJECT_MAX_LENGTH });
  if (subjectIssue) issues.push(subjectIssue);

  const plannedIssue = checkPositiveInt(task.plannedMinutes, `${path}.plannedMinutes`, '预计总用时', {
    min: 1,
    max: PLANNED_MINUTES_MAX,
  });
  if (plannedIssue) issues.push(plannedIssue);

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
    const minIssue = checkPositiveInt(task.minChunkMinutes, `${path}.minChunkMinutes`, '最短学习时段', {
      min: 5,
      max: PLANNED_MINUTES_MAX,
    });
    if (minIssue) issues.push(minIssue);
    const maxIssue = checkPositiveInt(task.maxChunkMinutes, `${path}.maxChunkMinutes`, '最长学习时段', {
      min: 5,
      max: PLANNED_MINUTES_MAX,
    });
    if (maxIssue) issues.push(maxIssue);
    if (isPositiveInt(task.minChunkMinutes) && isPositiveInt(task.maxChunkMinutes) && task.minChunkMinutes > task.maxChunkMinutes) {
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
  const remaining = (task.plannedMinutes ?? 0) - completedMinutesForTask(task.id, sessions);
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
  const completed = completedMinutesForTask(task.id, sessions);
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

  if (next.splittable === false) {
    next.minChunkMinutes = next.plannedMinutes;
    next.maxChunkMinutes = next.plannedMinutes;
  } else if (isPositiveInt(next.minChunkMinutes) && isPositiveInt(next.maxChunkMinutes) && next.minChunkMinutes > next.maxChunkMinutes) {
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
