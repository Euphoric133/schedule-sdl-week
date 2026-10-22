/**
 * 数据结构定义、默认设置与整体校验。
 *
 * 这是"数据契约"的集中位置：存储层、迁移、导入导出、引擎输入校验都复用这里，
 * 避免同一个字段在三处各写一遍规则。
 *
 * 版本策略：
 * - `CURRENT_SCHEMA_VERSION` 是当前代码能读写的最高结构版本。
 * - 任何**破坏性**结构变更都必须递增它，并在 storage/migrations.js 添加迁移步骤。
 * - 递增时必须同步更新 ARCHITECTURE.md 与 CHANGELOG.md。
 */

import {
  VALIDATION_CODES as C,
  error,
  isNonEmptyString,
  isPlainObject,
  result,
  warning,
} from './validation.js';
import { SCHEDULABLE_TASK_STATUSES, TASK_STATUS, remainingMinutesForTask, validateTask } from './task.js';
import { SESSION_STATE, sessionLength, validateSession } from './session.js';
import { validateFixedActivity } from './fixedActivity.js';
import { checkTaskDependencies } from './graph.js';
import { DEFAULT_DAY_BOUNDARY_HOUR, MINUTES_PER_DAY, weekday } from './time.js';
import { PLAN_STATUS, validatePlan } from './plan.js';

/**
 * 当前结构版本。
 *
 * v2：新增 settings.latestSleepMinutes（最晚睡觉时间，硬性约束）。
 *     为什么必须升版本：v1 的数据里没有这个字段，必须由迁移补上默认值，
 *     否则"旧数据 + 新代码"会让排程读到 undefined，行为不可预测。
 */
export const CURRENT_SCHEMA_VERSION = 2;

/** 计划历史保留数量上限（撤销链长度） */
export const PLAN_HISTORY_LIMIT = 20;

/** 默认优先级权重（截止紧迫度 / 难度 / 重要程度 / 拖延风险） */
export const DEFAULT_WEIGHTS = Object.freeze({
  deadlineUrgency: 0.35,
  difficulty: 0.3,
  importance: 0.2,
  procrastination: 0.15,
});

/**
 * 默认设置。
 * 这些是"合理默认值"，全部可以在偏好设置页修改；修改后必须重新生成候选计划并让用户确认。
 */
/**
 * 默认"可学习时间"的历史包袱（重要，改之前请读完）。
 *
 * 早期版本曾把"每天最多规划 7 小时"写死在默认值里，于是默认窗口是
 * `16:00 – 23:00`（7 小时 / 天 = 49 小时 / 周）。
 * 后来把这个设置从界面上删掉了，但**默认值没有删**：
 * 于是无论用户怎么清空固定日程，排程器也只能从 16:00 之后找空档——
 * 这就是"计划总是延迟到下午 16:00 才开始"的真实原因。
 *
 * 现在默认窗口改为 `07:00 – 23:00`（覆盖正常作息），
 * 睡眠、上课这类不可用时间请用"固定日程"表达（它们会从窗口里被扣掉）。
 * 旧数据里的 16:00–23:00 由 migrations 里的兼容迁移升级，见 upgradeLegacyStudyWindows。
 */
export function defaultSettings() {
  const everyDay = () => [{ startMinutes: 7 * 60, endMinutes: 23 * 60 }];
  return {
    studyWindows: { 1: everyDay(), 2: everyDay(), 3: everyDay(), 4: everyDay(), 5: everyDay(), 6: everyDay(), 7: everyDay() },
    preferredFocusWindows: [
      { startMinutes: 19 * 60, endMinutes: 22 * 60 },
      { startMinutes: 9 * 60, endMinutes: 11 * 60 + 30 },
    ],
    adaptiveContinuousLimit: true,
    baseContinuousMinutes: 90,
    subjectSwitchPenaltyMinutes: 30,
    defaultMinChunkMinutes: 30,
    defaultMaxChunkMinutes: 60,
    nonSplittableMinMinutes: 15,
    nonSplittableMaxMinutes: 180,
    restRule: { afterContinuousMinutes: 50, restMinutes: 10, extraOnSubjectSwitch: 0 },
    dayBoundaryHour: DEFAULT_DAY_BOUNDARY_HOUR,
    riskWindowDays: 30,
    weights: { ...DEFAULT_WEIGHTS },
    planHistoryLimit: PLAN_HISTORY_LIMIT,
    allowUndersizedFinalChunk: true,
    maxSessionsPerDay: 24,
    /**
     * 每日学习上限：null = 不作额外限制，只受"可用窗口 − 占用"约束。
     * （历史上曾有"每天 7 小时"的默认上限，已彻底移除，不得再引入。）
     */
    dailyStudyCapMinutes: null,
    /**
     * 最晚睡觉时间（分钟，0–1440）；null = 不限制。
     *
     * 这是**硬约束**：排程不会把学习安排在这个时刻之后。
     * 用它可以表达"今晚 10:30 必须睡觉"这类现实要求，
     * 而不必每天手动建一条"睡眠"固定日程。
     *
     * 注意它与 studyWindows 的关系：两者都会削减可用时间。
     * 如果 studyWindows 已经写到 23:00、而这里是 22:30，
     * 实际可学时间就是到 22:30 为止——取更早的那个。
     */
    latestSleepMinutes: null,
    /**
     * 是否自动生成计划预览。
     * true（默认，也是应用一直以来的行为）= 改动后立即生成候选预览，不再询问；
     * false = 先询问用户是否生成预览，拒绝则只保存数据、正式计划保持不变。
     */
    autoPreview: true,
  };
}

/** 创建一个全新的空状态（首次打开应用；不含任何虚构任务） */
export function createEmptyState({ nowIso, planId = null, windowStart, timeZone = null }) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: nowIso,
    updatedAt: nowIso,
    timeZone,
    settings: defaultSettings(),
    tasks: [],
    sessions: [],
    fixedActivities: [],
    /** 用户创建的休息安排（一条 = 一段完整时间，按日期拆分显示） */
    restPeriods: [],
    /** 统一的科目字典（任务只保存科目名，这里是可管理的数据源） */
    subjects: [],
    officialPlan: null,
    planHistory: [],
    pendingPreview: null,
    meta: {
      lastBackupAt: null,
      migrationLog: [],
      lastPlanMutation: null,
      initialWindowStart: windowStart ?? null,
      planId,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 校验：设置
 * ------------------------------------------------------------------ */

export function validateSettings(settings, path = 'settings') {
  const issues = [];
  if (!isPlainObject(settings)) {
    return result([error(C.TYPE, path, '设置必须是一个对象。', { actual: typeof settings })]);
  }

  // —— 学习窗口 ——
  if (!isPlainObject(settings.studyWindows)) {
    issues.push(error(C.TYPE, `${path}.studyWindows`, '可学习时间必须按星期配置。'));
  } else {
    let totalWindows = 0;
    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      const list = settings.studyWindows[day] ?? settings.studyWindows[String(day)];
      if (list === undefined) {
        issues.push(error(C.SETTINGS_NO_WINDOW, `${path}.studyWindows.${day}`, `缺少星期${day}的可学习时间配置。`));
        continue;
      }
      if (!Array.isArray(list)) {
        issues.push(error(C.TYPE, `${path}.studyWindows.${day}`, `星期${day}的可学习时间必须是区间数组（可为空数组表示当天不可学）。`));
        continue;
      }
      totalWindows += list.length;
      for (const [idx, span] of list.entries()) {
        const spanPath = `${path}.studyWindows.${day}[${idx}]`;
        const start = numOf(span, 'startMinutes', 'start');
        const end = numOf(span, 'endMinutes', 'end');
        if (start === null || end === null) {
          issues.push(error(C.TYPE, spanPath, '可学习时间必须是 { startMinutes, endMinutes } 或 { start: "HH:mm", end: "HH:mm" }。', { span }));
          continue;
        }
        if (start < 0 || start >= MINUTES_PER_DAY) {
          issues.push(error(C.RANGE, `${spanPath}.startMinutes`, `开始时间必须在 0 – ${MINUTES_PER_DAY - 1} 分钟之间。`, { start }));
        }
        if (end === start) {
          issues.push(error(C.SESSION_EMPTY_SPAN, spanPath, '可学习时间的开始与结束不能相同。', { span }));
        }
      }
    }
    if (totalWindows === 0) {
      issues.push(
        warning(
          C.SETTINGS_NO_WINDOW,
          `${path}.studyWindows`,
          '当前所有日期都没有可学习时间，任何任务都无法安排。请至少为一天设置学习时间。',
        ),
      );
    }
  }

  // 缓冲时间功能已移除：不再校验/读取 bufferRatio。
  // 若旧设置里仍有这个字段，忽略即可（不需要迁移，也不会影响排程）。

  // —— 权重 ——
  const weights = settings.weights;
  if (!isPlainObject(weights)) {
    issues.push(error(C.TYPE, `${path}.weights`, '优先级权重必须是一个对象。'));
  } else {
    let sum = 0;
    for (const [key, label] of [
      ['deadlineUrgency', '截止紧迫度'],
      ['difficulty', '难度'],
      ['importance', '重要程度'],
      ['procrastination', '拖延风险'],
    ]) {
      const value = weights[key];
      if (typeof value !== 'number' || value < 0 || !Number.isFinite(value)) {
        issues.push(error(C.SETTINGS_WEIGHTS, `${path}.weights.${key}`, `${label}权重必须是非负数字（当前 ${JSON.stringify(value)}）。`));
      } else {
        sum += value;
      }
    }
    if (sum <= 0) {
      issues.push(error(C.SETTINGS_WEIGHTS, `${path}.weights`, '四项权重不能全为 0，否则无法计算任务优先级。', { sum }));
    } else if (Math.abs(sum - 1) > 1e-9) {
      issues.push(
        warning(C.SETTINGS_WEIGHTS, `${path}.weights`, `四项权重之和为 ${round(sum)}，不等于 1；计算时会自动归一化，结果不受影响。`, {
          sum,
        }),
      );
    }
  }

  // —— 时长规则 ——
  const numericRules = [
    ['baseContinuousMinutes', '连续学习基础上限', 15, 480],
    ['subjectSwitchPenaltyMinutes', '科目切换惩罚', 0, 240],
    ['defaultMinChunkMinutes', '默认可拆分最短时段', 5, 480],
    ['defaultMaxChunkMinutes', '默认可拆分最长时段', 5, 480],
    ['nonSplittableMinMinutes', '不可拆分最短时段', 5, 480],
    ['nonSplittableMaxMinutes', '不可拆分最长时段', 5, 1440],
    ['riskWindowDays', '风险评估窗口天数', 1, 365],
    ['planHistoryLimit', '版本快照上限', 1, 200],
    ['maxSessionsPerDay', '每日片段数上限', 1, 96],
  ];
  for (const [key, label, min, max] of numericRules) {
    const value = settings[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(error(C.RANGE, `${path}.${key}`, `${label}必须是 ${min} – ${max} 的整数（当前 ${JSON.stringify(value)}）。`, { actual: value }));
    }
  }
  if (Number.isInteger(settings.defaultMinChunkMinutes) && Number.isInteger(settings.defaultMaxChunkMinutes)) {
    if (settings.defaultMinChunkMinutes > settings.defaultMaxChunkMinutes) {
      issues.push(error(C.TASK_MIN_MAX_CHUNK, `${path}.defaultMinChunkMinutes`, '默认可拆分最短时段不能大于最长时段。', {}));
    }
  }
  if (Number.isInteger(settings.nonSplittableMinMinutes) && Number.isInteger(settings.nonSplittableMaxMinutes)) {
    if (settings.nonSplittableMinMinutes > settings.nonSplittableMaxMinutes) {
      issues.push(error(C.TASK_MIN_MAX_CHUNK, `${path}.nonSplittableMinMinutes`, '不可拆分最短时段不能大于最长时段。', {}));
    }
  }

  // —— 休息规则 ——
  const restRule = settings.restRule;
  if (!isPlainObject(restRule)) {
    issues.push(error(C.TYPE, `${path}.restRule`, '休息规则必须是一个对象。'));
  } else {
    for (const [key, label, min, max] of [
      ['afterContinuousMinutes', '每连续学习时长', 10, 480],
      ['restMinutes', '休息时长', 0, 120],
      ['extraOnSubjectSwitch', '科目切换额外休息', 0, 120],
    ]) {
      const value = restRule[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        issues.push(error(C.RANGE, `${path}.restRule.${key}`, `${label}必须是 ${min} – ${max} 的整数（当前 ${JSON.stringify(value)}）。`, { actual: value }));
      }
    }
  }

  // —— 业务日边界 ——
  const boundary = settings.dayBoundaryHour;
  if (!Number.isInteger(boundary) || boundary < 0 || boundary > 12) {
    issues.push(error(C.RANGE, `${path}.dayBoundaryHour`, '业务日边界必须是 0 – 12 的整数小时。', { actual: boundary }));
  }

  // —— 每日学习上限（可空） ——
  if (settings.dailyStudyCapMinutes !== null && settings.dailyStudyCapMinutes !== undefined) {
    if (!Number.isInteger(settings.dailyStudyCapMinutes) || settings.dailyStudyCapMinutes < 15 || settings.dailyStudyCapMinutes > MINUTES_PER_DAY) {
      issues.push(error(C.RANGE, `${path}.dailyStudyCapMinutes`, `每日学习上限必须是 15 – ${MINUTES_PER_DAY} 的整数分钟，或留空表示不限。`, {}));
    }
  }

  /**
   * 最晚睡觉时间（可空）。
   *
   * 它是硬约束，填错会让整个排程算错，所以这里做强校验：
   * 只接受 null 或 1–1440 的整数分钟；0 与越界值一律报错，
   * 而不是"悄悄当成不限制"——那会让用户以为设了限制、实际没生效。
   */
  if (settings.latestSleepMinutes !== null && settings.latestSleepMinutes !== undefined) {
    const value = settings.latestSleepMinutes;
    if (!Number.isInteger(value) || value < 1 || value > MINUTES_PER_DAY) {
      issues.push(
        error(
          C.RANGE,
          `${path}.latestSleepMinutes`,
          `最晚睡觉时间必须是 1 – ${MINUTES_PER_DAY} 的整数分钟（例如 22:30 填 1350），或留空表示不限制。`,
          { actual: value },
        ),
      );
    }
  }

  // —— 偏好专注时段 ——
  if (!Array.isArray(settings.preferredFocusWindows)) {
    issues.push(error(C.TYPE, `${path}.preferredFocusWindows`, '偏好专注时段必须是数组。'));
  }

  return result(issues);
}

function numOf(span, numericKey, stringKey) {
  if (!isPlainObject(span)) return null;
  if (Number.isInteger(span[numericKey])) return span[numericKey];
  if (typeof span[stringKey] === 'string') {
    const m = /^(\d{2}):(\d{2})$/.exec(span[stringKey]);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  return null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * 校验：整体状态
 * ------------------------------------------------------------------ */

/**
 * 校验整个应用状态。所有入口（加载、导入、应用预览前）都应经过这里。
 * 返回的 result.ok 为 false 时，调用方**必须**保持现有数据不变。
 */
export function validateAppState(state, { requirePlanWindow = false } = {}) {
  const issues = [];
  if (!isPlainObject(state)) {
    return result([error(C.SCHEMA_SHAPE, 'state', '数据根必须是一个对象。', { actual: typeof state })]);
  }

  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
    issues.push(error(C.SCHEMA_VERSION_UNSUPPORTED, 'state.schemaVersion', '缺少合法的 schemaVersion。', { actual: state.schemaVersion }));
  } else if (state.schemaVersion > CURRENT_SCHEMA_VERSION) {
    issues.push(
      error(
        C.SCHEMA_VERSION_UNSUPPORTED,
        'state.schemaVersion',
        `数据来自更新的版本（v${state.schemaVersion}），当前程序只能读取到 v${CURRENT_SCHEMA_VERSION}。为避免损坏数据，已拒绝加载。`,
        { actual: state.schemaVersion, supported: CURRENT_SCHEMA_VERSION },
      ),
    );
  }

  for (const key of ['tasks', 'sessions', 'fixedActivities', 'planHistory']) {
    if (!Array.isArray(state[key])) {
      issues.push(error(C.TYPE, `state.${key}`, `${key} 必须是数组。`, { actual: typeof state[key] }));
    }
  }
  if (!isPlainObject(state.settings)) {
    issues.push(error(C.TYPE, 'state.settings', '缺少设置对象。'));
  } else {
    issues.push(...validateSettings(state.settings).issues);
  }

  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const fixedActivities = Array.isArray(state.fixedActivities) ? state.fixedActivities : [];

  // —— 实体结构 ——
  /**
   * 名称超长在**整体校验（加载/导入）**里只提示，不阻断。
   *
   * 保存时由 createTask / applyTaskPatch 等入口做强校验，
   * 因此不会写进超长名称；但历史数据里已有的超长名称不能导致应用打不开，
   * 也不能被静默截断——用户会看到提示并被引导去编辑修正。
   */
  for (const [idx, task] of tasks.entries()) {
    issues.push(...validateTask(task, `tasks[${idx}]`, { lenientName: true }).issues);
  }
  for (const [idx, activity] of fixedActivities.entries()) {
    issues.push(...validateFixedActivity(activity, `fixedActivities[${idx}]`, { lenientName: true }).issues);
  }

  const taskIds = new Set(tasks.map((t) => t.id));
  for (const [idx, session] of sessions.entries()) {
    issues.push(...validateSession(session, `sessions[${idx}]`, { taskExists: (id) => taskIds.has(id) }).issues);
  }

  // —— 重复 ID ——
  issues.push(...checkDuplicates(tasks, 'tasks', '任务'));
  issues.push(...checkDuplicates(sessions, 'sessions', '学习时段'));
  issues.push(...checkDuplicates(fixedActivities, 'fixedActivities', '固定活动'));

  // —— 依赖关系（悬空 / 自引用 / 环） ——
  issues.push(...checkTaskDependencies(tasks));

  // —— 任务时长一致性 ——
  for (const [idx, task] of tasks.entries()) {
    if (task.status === TASK_STATUS.DELETED) continue;
    const completed = sessions
      .filter((s) => s.taskId === task.id && s.state === SESSION_STATE.COMPLETED)
      .reduce((sum, s) => sum + (s.actualMinutes ?? s.plannedMinutes ?? sessionLength(s)), 0);
    if (Number.isInteger(task.plannedMinutes) && completed > task.plannedMinutes) {
      issues.push(
        error(
          C.TASK_OVER_COMPLETED,
          `tasks[${idx}].plannedMinutes`,
          `"${task.title}" 的已完成时长（${completed} 分钟）超过了预计总用时（${task.plannedMinutes} 分钟）。`,
          { taskId: task.id, completed, plannedMinutes: task.plannedMinutes },
        ),
      );
    }
    const remaining = remainingMinutesForTask(task, sessions);
    const pending = sessions
      .filter((s) => s.taskId === task.id && s.state !== SESSION_STATE.COMPLETED && s.state !== SESSION_STATE.CANCELLED)
      .reduce((sum, s) => sum + (s.plannedMinutes ?? 0), 0);
    if (pending > remaining) {
      issues.push(
        error(
          C.TASK_DURATION_INCONSISTENT,
          `tasks[${idx}].plannedMinutes`,
          `"${task.title}" 未完成时段合计 ${pending} 分钟，但剩余工作量只有 ${remaining} 分钟。`,
          { taskId: task.id, pending, remaining },
        ),
      );
    }
  }

  // —— 计划（若存在） ——
  if (state.officialPlan !== null && state.officialPlan !== undefined) {
    issues.push(...validatePlan(state.officialPlan, 'state.officialPlan').issues);
    if (requirePlanWindow && state.officialPlan.days?.length !== 7) {
      issues.push(warning(C.RANGE, 'state.officialPlan.days', '正式计划不是七天窗口，界面将按实际天数展示。', {}));
    }
  }

  /**
   * 这里刻意不再对"任务全部已完成/已取消"发出提示。
   *
   * 理由：这是用户正常作息的结果（今天的事做完了），不是数据问题。
   * 以前它会在每次打开应用时弹出一条警告横幅，让人以为出了问题。
   * 现在"没有可安排的任务"由首页与每日视图按需解释，不再作为数据警告。
   */

  return result(issues);
}

function checkDuplicates(list, path, label) {
  const issues = [];
  const seen = new Set();
  for (const [idx, item] of list.entries()) {
    const id = item?.id;
    if (!isNonEmptyString(id, 64)) continue;
    if (seen.has(id)) {
      issues.push(error(C.ENTITY_DUPLICATE_ID, `${path}[${idx}].id`, `${label} ID 重复：${id}。`, { id }));
    }
    seen.add(id);
  }
  return issues;
}

/** 汇总"当前状态概览"，供 UI 顶栏与调试使用（纯派生，不落库） */
export function summarizeState(state) {
  const tasks = state?.tasks ?? [];
  const sessions = state?.sessions ?? [];
  return {
    schemaVersion: state?.schemaVersion ?? null,
    taskCount: tasks.filter((t) => t.status !== TASK_STATUS.DELETED).length,
    activeTaskCount: tasks.filter((t) => SCHEDULABLE_TASK_STATUSES.includes(t.status)).length,
    completedTaskCount: tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length,
    sessionCount: sessions.length,
    completedSessionCount: sessions.filter((s) => s.state === SESSION_STATE.COMPLETED).length,
    lockedSessionCount: sessions.filter((s) => s.locked).length,
    fixedActivityCount: (state?.fixedActivities ?? []).length,
    planVersion: state?.officialPlan?.version ?? 0,
    planStatus: state?.officialPlan?.status ?? null,
    hasPreview: Boolean(state?.pendingPreview),
    historyCount: (state?.planHistory ?? []).length,
  };
}

/** 供 UI 显示当前星期几的中文名 */
export function weekdayLabel(date) {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return names[weekday(date) - 1];
}

export { PLAN_STATUS };
