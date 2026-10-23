/**
 * 排程策略（Policy）：所有可调参数与枚举的集中定义。
 *
 * 设计原因：
 * - 阈值散落在算法各处会导致"改一个数字要翻十个文件"，也无法向用户解释"为什么这样排"。
 *   因此引擎只从 `policy` 读取决策参数，`policy` 的唯一来源是输入里的 `settings`。
 * - 稳定枚举（原因码、诊断码）集中定义，保证界面文案、测试断言与文档三者一致。
 */

import { DEFAULT_WEIGHTS } from '../domain/schemas.js';

/** 引擎版本：任何会改变排程结果的算法改动都必须递增 */
export const ENGINE_VERSION = 'engine@1.1.0';

/** 策略版本：参数结构变化时递增（用于排查"为什么同样的数据结果不同"） */
export const POLICY_VERSION = 'policy@1.0.0';

/** 默认规划窗口天数 */
export const WINDOW_DAYS = 7;

/**
 * 未安排任务的原因码。
 * 每一类都必须有对应的中文说明与建议处理方式（见 REASON_TEXT / REASON_SUGGESTIONS）。
 */
export const UNSCHEDULED_REASON = Object.freeze({
  INSUFFICIENT_CAPACITY: 'insufficient_capacity', // 窗口内可用容量不足
  TAIL_TOO_SMALL: 'tail_too_small', // 尾部余量小于最短片段，且无法合并
  BLOCKED_BY_DEPENDENCY: 'blocked_by_dependency', // 前置任务未完成或不可行
  DEPENDENCY_UNREACHABLE: 'dependency_unreachable', // 前置任务被取消/删除，永远无法满足
  NON_SPLITTABLE_NO_SLOT: 'non_splittable_no_slot', // 不可拆分任务找不到能一次放下的连续时段
  DEADLINE_PASSED: 'deadline_passed', // 截止时间已过
  DEADLINE_TOO_CLOSE: 'deadline_too_close', // 截止前剩余可用时间放不下这个任务
  PLANNED_START_UNREACHABLE: 'planned_start_unreachable', // 计划开始时间之后没有足够可用时间
  WINDOW_TOO_NARROW: 'window_too_narrow', // 可用窗口为空或过窄
  DAILY_CAP_REACHED: 'daily_cap_reached', // 触达每日学习上限或每日片段数上限
  OVERLOADED: 'overloaded', // 总需求超过总容量（整体超载）
});

export const REASON_TEXT = Object.freeze({
  [UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY]: '七天窗口内的可用学习容量不足。',
  [UNSCHEDULED_REASON.TAIL_TOO_SMALL]: '尾部剩余时长小于该任务的最短学习时段，且无法并入其它片段。',
  [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY]: '前置任务尚未完成，不能提前安排。',
  [UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE]: '前置任务已被取消或删除，该任务永远无法满足依赖条件。',
  [UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT]: '该任务不可拆分，但窗口内没有足够长的连续时段一次放下。',
  [UNSCHEDULED_REASON.DEADLINE_PASSED]: '截止时间已过，安排也无法按时完成。',
  [UNSCHEDULED_REASON.PLANNED_START_UNREACHABLE]:
    '该任务的「计划开始时间」之后没有足够长的连续时段：按这个时刻起算，每天的可用时间都短于它的最短学习时段。',
  [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: '允许学习的时间窗口为空或过窄。',
  [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: '已触达每日学习上限或每日片段数上限。',
  [UNSCHEDULED_REASON.OVERLOADED]: '所有任务的剩余工作量之和超过了窗口内的可用容量。',
});

/** 每个原因码对应的可选处理方式（界面按钮用） */
export const REASON_SUGGESTIONS = Object.freeze({
  [UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY]: ['extend_window', 'accept_partial', 'move_deadline'],
  [UNSCHEDULED_REASON.TAIL_TOO_SMALL]: ['lower_min_chunk', 'merge_chunks', 'move_deadline'],
  [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY]: ['finish_dependency', 'remove_dependency'],
  [UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE]: ['remove_dependency', 'restore_dependency', 'cancel_task'],
  [UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT]: ['allow_split', 'extend_window', 'move_deadline'],
  [UNSCHEDULED_REASON.DEADLINE_PASSED]: ['move_deadline', 'cancel_task'],
  [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: ['extend_window'],
  // 建议：把开始时间提前、或延后睡觉时间——两条都直接对应这个原因
  [UNSCHEDULED_REASON.PLANNED_START_UNREACHABLE]: ['earlier_start', 'extend_window', 'allow_split'],
  [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: ['raise_daily_cap', 'extend_window'],
  [UNSCHEDULED_REASON.OVERLOADED]: ['accept_partial', 'extend_window', 'move_deadline', 'cancel_task'],
});

/** 诊断码：不阻止出计划，但必须让用户看到 */
export const DIAGNOSTIC_CODE = Object.freeze({
  INPUT_WARNING: 'input_warning', // 输入存在非阻断性问题（如权重和不为 1）
  PINNED_CONFLICT: 'pinned_conflict', // 锁定时段之间或与固定活动冲突
  WINDOW_OVERLAP: 'window_overlap', // 允许窗口之间重叠（已合并，仅提示）
  NO_CAPACITY: 'no_capacity', // 窗口内完全没有可用学习时间
  OVERLOAD: 'overload', // 总需求 > 总容量
  DAILY_CAP_REACHED: 'daily_cap_reached',
  UNDERSIZED_FINAL_CHUNK: 'undersized_final_chunk', // 尾部片段小于最短时段（已按设置允许）
  DEADLINE_AT_RISK: 'deadline_at_risk',
  DEADLINE_LATE: 'deadline_late',
  DEPENDENCY_CYCLE: 'dependency_cycle',
  RESERVED_BLOCK_OVERLAP: 'reserved_block_overlap', // 锁定时段与固定活动重叠（数据冲突）
  /** 任务的计划开始时间早于本次规划的搜索起点，被上移（如实告知，不静默） */
  PLANNED_START_CLAMPED: 'planned_start_clamped',
  /** 任务的严格开始时间被占用/顺延：告诉用户"计划 HH:mm，实际 HH:mm，原因是..." */
  PLANNED_START_DELAYED: 'planned_start_delayed',
  /** 规划开始时间相关（默认取下一个整点 / 用户指定 / 指定的时间已经过去） */
  START_TIME_DEFAULT: 'start_time_default',
  START_TIME_USER: 'start_time_user',
  START_TIME_IN_PAST: 'start_time_in_past',
  START_TIME_INVALID: 'start_time_invalid',
});

/** 截止风险等级 */
export const RISK_LEVEL = Object.freeze({
  ON_TIME: 'on_time',
  TIGHT: 'tight',
  AT_RISK: 'at_risk',
  IMPOSSIBLE: 'impossible',
});

export const RISK_LABELS_ZH = Object.freeze({
  on_time: '可按期完成',
  tight: '时间较紧',
  at_risk: '有逾期风险',
  impossible: '按当前容量无法完成',
});

/**
 * 由用户设置构造引擎策略。
 *
 * 引擎不直接读 `settings` 的散字段，而是统一经过这里：
 * 这样"默认值从哪来""缺字段怎么办"只有一处答案，也便于给策略算指纹。
 *
 * @param {object} settings 用户设置（结构见 domain/schemas.js 的 defaultSettings）
 * @returns {object} 冻结的策略对象
 */
export function buildPolicy(settings = {}) {
  const weights = normalizeWeights(settings.weights ?? DEFAULT_WEIGHTS);
  const restRule = settings.restRule ?? {};

  return Object.freeze({
    version: POLICY_VERSION,
    engineVersion: ENGINE_VERSION,

    /** 优先级权重（已归一化，四项之和为 1） */
    weights,

    /** 缓冲比例：功能已移除，恒为 0 */
    /**
     * 缓冲时间功能已移除：这里固定为 0，即"不再为每天预留机动时间"。
     *
     * 保留这个字段（而不是删掉）是为了让引擎内部的容量公式保持一处实现，
     * 避免大量调用点跟着改；语义上它现在恒为 0，任何设置都无法改变它。
     */
    bufferRatio: 0,

    /**
     * 最晚睡觉时间（分钟）；null = 不限制。
     *
     * 这是**硬约束**，不是软偏好：容量计算会把每天的可学习窗口截断到
     * min(窗口结束, 本值) 之前。因此排出来的计划里不会出现"22:30 之后还在学"。
     *
     * 只在 0–1440 之间的整数才生效；其它值（含 null）一律按"不限制"处理，
     * 避免设置里填了脏数据就让整个排程算错。
     */
    latestSleepMinutes:
      Number.isInteger(settings.latestSleepMinutes) && settings.latestSleepMinutes > 0 && settings.latestSleepMinutes <= 1440
        ? settings.latestSleepMinutes
        : null,

    /** 业务日边界小时 */
    dayBoundaryHour: Number.isInteger(settings.dayBoundaryHour) ? settings.dayBoundaryHour : 4,

    /** 任务默认片段长度（任务未填时使用） */
    defaultMinChunkMinutes: positiveInt(settings.defaultMinChunkMinutes, 30),
    defaultMaxChunkMinutes: positiveInt(settings.defaultMaxChunkMinutes, 60),

    /** 不可拆分任务的合法时长范围（超出范围需要提示用户） */
    nonSplittableMinMinutes: positiveInt(settings.nonSplittableMinMinutes, 15),
    nonSplittableMaxMinutes: positiveInt(settings.nonSplittableMaxMinutes, 180),

    /** 尾段小于最短时段时是否允许放置（默认允许，且只在计划尾部出现一次） */
    allowUndersizedFinalChunk: settings.allowUndersizedFinalChunk !== false,

    /** 连续学习自适应 */
    adaptiveContinuousLimit: settings.adaptiveContinuousLimit !== false,
    baseContinuousMinutes: positiveInt(settings.baseContinuousMinutes, 90),
    continuousDifficultyFactor: Object.freeze({ 1: 0.6, 2: 0.8, 3: 1, 4: 1.2, 5: 1.4 }),

    /** 休息规则 */
    restAfterContinuousMinutes: positiveInt(restRule.afterContinuousMinutes, 50),
    restMinutes: nonNegativeInt(restRule.restMinutes, 10),
    extraRestOnSubjectSwitch: nonNegativeInt(restRule.extraOnSubjectSwitch, 0),

    /** 科目切换惩罚（软偏好，参与放位评分） */
    subjectSwitchPenaltyMinutes: nonNegativeInt(settings.subjectSwitchPenaltyMinutes, 30),

    /** 偏好专注时段（软偏好） */
    preferredFocusWindows: (settings.preferredFocusWindows ?? []).map((w) => ({
      startMinutes: typeof w.startMinutes === 'number' ? w.startMinutes : 0,
      endMinutes: typeof w.endMinutes === 'number' ? w.endMinutes : 0,
    })),

    /** 每日限制 */
    maxSessionsPerDay: positiveInt(settings.maxSessionsPerDay, 24),
    dailyStudyCapMinutes: Number.isInteger(settings.dailyStudyCapMinutes) ? settings.dailyStudyCapMinutes : null,

    /** 截止紧迫度的评分窗口（小时）：7 天 */
    deadlineHorizonHours: 7 * 24,

    /** 风险评估窗口（天） */
    riskWindowDays: positiveInt(settings.riskWindowDays, 30),

    /** 局部优化迭代上界（固定值保证结果确定且有界） */
    optimizationPasses: 3,
    optimizationMaxEvaluations: 200,

    /** 评分权重（放位用，单位与分钟量级对齐） */
    placementScore: Object.freeze({
      preferredWindow: 1000,
      sameSubjectContinuity: 200,
      slotFit: 100,
      earlierSlot: 50,
      subjectSwitchPenalty: -30,
      deadlineDistance: -10,
    }),
  });
}

/** 权重归一化：和不为 1 时按比例缩放（和为 0 时退回默认值，避免出现 NaN 评分） */
export function normalizeWeights(weights) {
  const keys = ['deadlineUrgency', 'difficulty', 'importance', 'procrastination'];
  const raw = {};
  let sum = 0;
  for (const key of keys) {
    const value = Number(weights?.[key]);
    raw[key] = Number.isFinite(value) && value >= 0 ? value : 0;
    sum += raw[key];
  }
  if (sum <= 0) {
    return Object.freeze({ ...DEFAULT_WEIGHTS });
  }
  const normalized = {};
  for (const key of keys) normalized[key] = raw[key] / sum;
  return Object.freeze(normalized);
}

function clamp01_05(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.1;
  return Math.min(0.5, Math.max(0, number));
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 连续学习上限：按难度自适应（难度越高，单段越长），供放位时限制同一科目连续学习的时长 */
export function continuousLimitFor(difficulty, policy) {
  const base = policy.baseContinuousMinutes;
  if (!policy.adaptiveContinuousLimit) return base;
  const factor = policy.continuousDifficultyFactor[difficulty] ?? 1;
  const scaled = Math.round(base * factor);
  return Math.min(180, Math.max(25, scaled));
}

/** 片段时长是否合法（供校验器与测试共用，避免两处规则不一致） */
export function isFragmentLengthAllowed(task, minutes, policy) {
  if (task.splittable === false) {
    return minutes === task.plannedMinutes;
  }
  const minChunk = Number.isInteger(task.minChunkMinutes) ? task.minChunkMinutes : policy.defaultMinChunkMinutes;
  const maxChunk = Number.isInteger(task.maxChunkMinutes) ? task.maxChunkMinutes : policy.defaultMaxChunkMinutes;
  return minutes >= Math.min(minChunk, maxChunk) && minutes <= Math.max(minChunk, maxChunk);
}
