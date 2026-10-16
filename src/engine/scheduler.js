/**
 * 排程引擎（Scheduler）：十步流程的编排者。
 *
 * 这是项目中唯一的"从任务到计划"入口，并且必须是**纯函数**：
 * - 不读系统时钟（`now` 由调用方传入）；
 * - 不读随机数（所有派生 ID 由输入指纹决定）；
 * - 不访问 DOM / localStorage / 网络；
 * - 同一 `input` + 同一 `engineVersion` ⇒ 逐字段相同的输出（验收场景 17）。
 *
 * 十步流程（对应 PROJECT_SPEC §2.5）：
 *   1. 校验输入（invalid_input 与"排不下"严格分开）
 *   2. 建立固定活动、完成记录与用户锁定时段
 *   3. 计算每个任务的剩余工作量
 *   4. 生成可用时间区间（含逐日 10% 机动缓冲预留）
 *   5. 任务拆分（可拆分 / 不可拆分 / 尾差处理）
 *   6. 按硬约束 + 截止风险 + 优先级分数生成初始计划
 *   7. 局部优化（确定性、有界迭代，不宣称全局最优）
 *   8. 组装时间轴块（学习 / 固定 / 休息 / 缓冲）
 *   9. 硬约束校验 H1–H10（失败则拒绝出计划，由调用方保留旧计划）
 *  10. 计算差异与风险评估，交给上层生成预览
 */

import { buildPolicy, DIAGNOSTIC_CODE, RISK_LEVEL, UNSCHEDULED_REASON } from './policy.js';
import { computeInputHash, computePolicyHash, deriveBlockId, deriveSessionId } from './versionHash.js';
import { computeWindowCapacity, longestFreeSlot, normalizeStudyWindows } from './capacity.js';
import { scoreTask, sortBySchedulePriority, ratingToScore } from './priority.js';
import { splitTask, SPLIT_STATUS, fragmentsConserveWorkload } from './splitter.js';
import { placeFragments } from './placer.js';
import { validatePlanConstraints, CONSTRAINT } from './constraints.js';
import { assessAllRisks } from './risk.js';
import { diffPlans } from './diff.js';

import { SCHEDULABLE_TASK_STATUSES, remainingMinutesForTask } from '../domain/task.js';
import { SESSION_STATE } from '../domain/session.js';
import { expandFixedActivities, mergeSpans } from '../domain/fixedActivity.js';
import { BLOCK_KIND } from '../domain/calendarBlock.js';
import { PLAN_STATUS } from '../domain/plan.js';
import { addDays, formatMinutes, MINUTES_PER_DAY, weekday } from '../domain/time.js';
import { validateAppState } from '../domain/schemas.js';
import { VALIDATION_CODES, error, warning as makeWarning } from '../domain/validation.js';

/**
 * 执行一次排程。
 *
 * @param {object} input
 * @param {object} input.state 完整应用状态（tasks / sessions / fixedActivities / settings）
 * @param {{date: string, minutes: number}} input.now 当前本地墙上时间（显式传入，保证确定性）
 * @param {string} [input.windowStart] 窗口起始日，默认 = now.date
 * @param {number} [input.windowDays] 窗口天数，默认 7
 * @param {object|null} [input.existingPlan] 当前正式计划（用于计算差异；不参与求解）
 * @param {number} [input.baseVersion] 候选计划的版本号（默认 existingPlan.version + 1）
 * @param {number} [input.optimizationPasses] 局部优化迭代上界（默认取策略值）
 * @returns {object} SchedulerResult
 */
export function run(input) {
  const { state, now } = input;
  if (!state || typeof state !== 'object') throw new TypeError('scheduler.run 需要 state');
  if (!now || typeof now.date !== 'string') throw new TypeError('scheduler.run 需要 now = { date, minutes }');

  const windowStart = input.windowStart ?? now.date;
  const windowDays = input.windowDays ?? 7;
  const windowEnd = addDays(windowStart, windowDays - 1);
  const policy = buildPolicy({
    ...state.settings,
    // 让风险评估复用同一套容量口径，避免"风险面板与计划自相矛盾"
    studyWindows: state.settings?.studyWindows ?? {},
  });

  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));

  /* ---------- 第 1 步：校验输入 ---------- */
  const inputValidation = validateAppState(state);
  const diagnostics = [];
  for (const issue of inputValidation.warnings ?? []) {
    diagnostics.push({ code: DIAGNOSTIC_CODE.INPUT_WARNING, severity: 'warning', message: issue.message, path: issue.path });
  }

  // 依赖环：整体校验已经能发现，这里单独提出来作为阻断性诊断（引擎无法为成环的任务排序）
  const cycleIssue = (inputValidation.errors ?? []).find((issue) => issue.code === VALIDATION_CODES.TASK_DEPENDENCY_CYCLE);
  if (cycleIssue) {
    return invalidResult({
      now,
      windowStart,
      windowEnd,
      windowDays,
      policy,
      issues: [cycleIssue],
      state,
      baseVersion: input.baseVersion,
      existingPlan: input.existingPlan,
      taskById,
    });
  }

  // 除依赖环之外的输入错误：交给调用方阻断（不生成"看似可行"的计划）
  const blocking = (inputValidation.errors ?? []).filter((issue) => issue.code !== VALIDATION_CODES.TASK_DEPENDENCY_CYCLE);
  if (blocking.length > 0) {
    return invalidResult({
      now,
      windowStart,
      windowEnd,
      windowDays,
      policy,
      issues: blocking,
      state,
      baseVersion: input.baseVersion,
      existingPlan: input.existingPlan,
      taskById,
    });
  }

  /* ---------- 第 2 步：固定活动与保留时段 ---------- */
  const fixedSpans = expandFixedActivities(state.fixedActivities ?? [], windowStart, windowEnd);

  const inWindow = (session) => session.date >= windowStart && session.date <= windowEnd;
  const hardReserved = (session) =>
    session.locked === true || session.state === SESSION_STATE.IN_PROGRESS || session.state === SESSION_STATE.COMPLETED;

  const windowSessions = (state.sessions ?? []).filter(inWindow);
  const reservedSessions = windowSessions.filter((session) => hardReserved(session) && session.state !== SESSION_STATE.CANCELLED);

  /**
   * 窗口**之外**的已完成/锁定时段。
   *
   * 它们不参与本次窗口的容量计算，但必须原样出现在候选计划里：
   * 否则"把窗口向后滚动"这一步会让已经完成的学习记录从计划中消失（H9 违规）。
   */
  const outOfWindowReserved = (state.sessions ?? []).filter(
    (session) => !inWindow(session) && hardReserved(session) && session.state !== SESSION_STATE.CANCELLED,
  );

  const reservedSpans = mergeSpans(
    reservedSessions
      .filter((session) => session.state !== SESSION_STATE.COMPLETED || session.date >= windowStart)
      .map((session) => ({ date: session.date, startMinutes: session.startMinutes, endMinutes: session.endMinutes })),
  );

  // 保留时段之间、或与固定活动之间的重叠属于数据冲突：如实报告，但不擅自移动用户锁定/已完成的内容
  const conflictDiagnostics = detectReservedConflicts(reservedSessions, fixedSpans);
  diagnostics.push(...conflictDiagnostics);

  /* ---------- 第 3 步：剩余工作量 ---------- */
  const schedulableTasks = (state.tasks ?? []).filter((task) => SCHEDULABLE_TASK_STATUSES.includes(task.status));

  // 已被保留的时段（锁定 / 进行中）会**原样进入候选计划**，它们已经占据了任务的一部分工作量。
  // 因此需要从"剩余工作量"里减去这部分，否则会把同一份工作排两遍（总量超出任务预计用时）。
  const carriedOverByTask = new Map();
  for (const session of reservedSessions) {
    if (session.state === SESSION_STATE.COMPLETED) continue; // 已完成的已经由 remainingMinutesForTask 扣除
    const minutes = session.endMinutes - session.startMinutes;
    carriedOverByTask.set(session.taskId, (carriedOverByTask.get(session.taskId) ?? 0) + minutes);
  }

  const remainingByTask = new Map();
  const completedByTask = {};
  for (const task of state.tasks ?? []) {
    const remaining = Math.max(0, remainingMinutesForTask(task, state.sessions ?? []) - (carriedOverByTask.get(task.id) ?? 0));
    remainingByTask.set(task.id, remaining);
    completedByTask[task.id] = (task.plannedMinutes ?? 0) - remaining;
  }

  /* ---------- 第 4 步：可用容量（含逐日缓冲） ---------- */
  const capacityDays = computeWindowCapacity({
    windowStart,
    windowEnd,
    studyWindows: state.settings?.studyWindows ?? {},
    fixedSpans,
    reservedSpans,
    bufferRatio: policy.bufferRatio,
  });

  const totalSchedulable = capacityDays.reduce((sum, day) => sum + day.schedulableMinutes, 0);
  if (totalSchedulable <= 0) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.NO_CAPACITY,
      severity: 'warning',
      message: `在 ${windowStart} – ${windowEnd} 之间没有可用的学习时间（可能被固定活动占满，或允许学习时间设置为空）。`,
    });
  }

  /* ---------- 第 5 步：任务拆分 ---------- */
  const scoredEntries = [];
  const unscheduled = [];
  const dependencyBlocked = collectDependencyBlocked(schedulableTasks, taskById, remainingByTask);

  for (const task of schedulableTasks) {
    const remaining = remainingByTask.get(task.id) ?? 0;
    if (remaining <= 0) continue;
    const score = scoreTask(task, { now, policy, remainingMinutes: remaining });
    scoredEntries.push({ task, score, remaining });
  }

  // 依赖门控：前置未完成或不可行 → 本任务不参与排程，并给出明确原因
  const schedulableEntries = [];
  for (const entry of scoredEntries) {
    const blocker = dependencyBlocked.get(entry.task.id);
    if (blocker) {
      unscheduled.push(
        buildUnscheduled({
          task: entry.task,
          remainingMinutes: entry.remaining,
          reasonCode: blocker.reasonCode,
          extra: blocker.extra,
          now,
          policy,
        }),
      );
      continue;
    }
    schedulableEntries.push(entry);
  }

  const orderedEntries = sortBySchedulePriority(schedulableEntries);

  const fragmentsByTask = new Map();
  const scoreByTask = new Map();
  for (const entry of orderedEntries) {
    scoreByTask.set(entry.task.id, entry.score);
    const split = splitTask(entry.task, { remainingMinutes: entry.remaining, policy });
    if (split.status === SPLIT_STATUS.OK) {
      fragmentsByTask.set(entry.task.id, [...split.fragments]);
    } else if (split.status === SPLIT_STATUS.EMPTY) {
      fragmentsByTask.set(entry.task.id, []);
    } else {
      fragmentsByTask.set(entry.task.id, [...split.fragments]);
      unscheduled.push(
        buildUnscheduled({
          task: entry.task,
          remainingMinutes: split.tailMinutes > 0 ? split.tailMinutes : entry.remaining,
          reasonCode: reasonCodeForSplitStatus(split.status),
          extra: { message: split.message },
          now,
          policy,
        }),
      );
    }
  }

  const inputHash = computeSchedulerInputHash({
    state,
    now,
    windowStart,
    windowEnd,
    engineVersion: policy.engineVersion,
    completedByTask,
  });
  const policyHash = computePolicyHash(state.settings ?? {}, policy.engineVersion);

  /* ---------- 第 6 步：放位 ---------- */
  const placementResult = placeFragments({
    days: capacityDays,
    fragmentsByTask,
    taskById,
    scoreByTask,
    policy,
    makeId: (kind, date, startMinutes, index) => deriveBlockId(kind, inputHash, date, startMinutes, index),
  });

  // 用真实的任务与片段信息重写学习块 ID，保证"同一任务同一片段 → 同一 ID"
  const placements = reassignSessionIds(placementResult.placements, fragmentsByTask, inputHash);

  /* ---------- 第 6b 步：无法放置的片段 ---------- */
  const placedByTask = countPlacedMinutes(placements);
  for (const entry of orderedEntries) {
    const planned = remainingByTask.get(entry.task.id) ?? 0;
    const placed = placedByTask.get(entry.task.id) ?? 0;
    if (placed >= planned) continue;
    const already = unscheduled.find((item) => item.taskId === entry.task.id);
    if (already) continue;
    const missing = planned - placed;
    // 不可拆分任务放不下的原因要准确：是"没有足够长的连续空档"，而不是"总容量不足"
    const longestSlot = capacityDays.reduce((max, day) => Math.max(max, longestFreeSlot(day.freeWindows)), 0);
    const isAtomic = entry.task.splittable === false;
    const atomicNoSlot = isAtomic && longestSlot < entry.task.plannedMinutes;
    unscheduled.push(
      buildUnscheduled({
        task: entry.task,
        remainingMinutes: missing,
        reasonCode: atomicNoSlot ? UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT : UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY,
        extra: { gapMinutes: missing, longestFreeSlot: longestSlot, totalSchedulable },
      }),
    );
  }

  /* ---------- 第 7 步：局部优化 ---------- */
  const optimized = optimizePlacements({
    placements,
    policy,
    // 占用集合 = 保留时段（锁定/进行中/已完成）+ 固定活动。
    // 只考虑保留时段会让"向前压缩"把片段挪进上课时间，从而产生 H1 违规。
    occupiedSpans: [...reservedSpans, ...fixedSpans],
    studyWindows: state.settings?.studyWindows ?? {},
    taskById,
    passes: input.optimizationPasses ?? policy.optimizationPasses,
  });

  /* ---------- 第 8 步：组装时间轴块 ---------- */
  // 只把 kind='study' 的放置结果转成学习块。
  // 早期版本直接 map 整个 optimized 数组，导致休息块被当成学习块统计（时长翻倍、并触发 H2 误报）。
  const studyBlocks = optimized
    .filter((placement) => placement.kind === 'study')
    .map((placement) => ({
    id: placement.id,
    kind: BLOCK_KIND.STUDY,
    date: placement.date,
    startMinutes: placement.startMinutes,
    endMinutes: placement.endMinutes,
    refId: placement.id,
    taskId: placement.taskId,
    subject: placement.subject,
    label: placement.label,
    locked: false,
    derived: false,
    meta: { undersized: placement.undersized, reasons: placement.reasons, plannedMinutes: placement.plannedMinutes },
  }));

  const reservedBlocks = [...reservedSessions, ...outOfWindowReserved].map((session) => ({
    id: `blk_reserved_${session.id}`,
    kind: BLOCK_KIND.STUDY,
    date: session.date,
    startMinutes: session.startMinutes,
    endMinutes: session.endMinutes,
    refId: session.id,
    taskId: session.taskId,
    subject: taskById.get(session.taskId)?.subject ?? null,
    label: taskById.get(session.taskId)?.title ?? '学习时段',
    locked: Boolean(session.locked),
    derived: false,
    meta: { state: session.state, plannedMinutes: session.plannedMinutes, reserved: true },
  }));

  const fixedBlocks = fixedSpans.map((span) => ({
    id: `blk_fixed_${span.activityId}_${span.date}_${span.startMinutes}`,
    kind: BLOCK_KIND.FIXED,
    date: span.date,
    startMinutes: span.startMinutes,
    endMinutes: span.endMinutes,
    refId: span.activityId,
    label: span.title ?? '固定活动',
    locked: false,
    derived: false,
    meta: { type: span.type },
  }));

  const restBlocks = optimized
    .filter((placement) => placement.kind === 'rest')
    .map((placement) => ({
      id: placement.id,
      kind: BLOCK_KIND.REST,
      date: placement.date,
      startMinutes: placement.startMinutes,
      endMinutes: placement.endMinutes,
      refId: null,
      label: '休息',
      locked: false,
      derived: true,
      meta: { plannedMinutes: placement.plannedMinutes },
    }));

  const bufferBlocks = buildBufferBlocks({
    days: capacityDays,
    studyBlocks: [...studyBlocks, ...reservedBlocks],
    restBlocks,
    inputHash,
  });

  const blocks = [...studyBlocks, ...reservedBlocks, ...fixedBlocks, ...restBlocks, ...bufferBlocks].sort(compareBlocks);

  /* ---------- 第 9 步：硬约束校验 ---------- */
  const validation = validatePlanConstraints({
    plan: { blocks, sessionIds: blocks.filter((b) => b.kind === BLOCK_KIND.STUDY && b.refId).map((b) => b.refId) },
    tasks: state.tasks ?? [],
    sessions: state.sessions ?? [],
    fixedActivities: state.fixedActivities ?? [],
    settings: state.settings ?? {},
    now,
    policy,
    plannedMinutesByTask: remainingByTask,
    placedMinutesByTask: countPlacedMinutes(optimized),
  });

  for (const violation of validation.violations) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.RESERVED_BLOCK_OVERLAP,
      severity: 'error',
      constraint: violation.constraint,
      message: violation.message,
      relatedIds: violation.relatedIds,
    });
  }
  for (const warn of validation.warnings) {
    diagnostics.push({
      code: warn.constraint === CONSTRAINT.H4 ? DIAGNOSTIC_CODE.DEADLINE_LATE : DIAGNOSTIC_CODE.INPUT_WARNING,
      severity: 'warning',
      constraint: warn.constraint,
      message: warn.message,
      relatedIds: warn.relatedIds,
    });
  }

  if (!validation.ok) {
    // 硬约束被违反：绝不把这份计划当成可用结果交付给用户确认。
    // 这里把 blocks 一并带出，纯粹是为了让测试与诊断能直接看到"到底排成了什么样"。
    return {
      ok: false,
      status: PLAN_STATUS.INVALID_INPUT,
      reason: 'constraint_violation',
      blocksForDiagnostics: blocks,
      violations: validation.violations,
      diagnostics,
      unscheduled,
      inputHash,
      policyHash,
      taskById,
      policy,
      now,
      windowStart,
      windowEnd,
      windowDays,
      capacityDays,
      issues: validation.violations.map((violation) =>
        error(VALIDATION_CODES.ENTITY_OVERLAP, `engine.${violation.constraint}`, violation.message, violation.details),
      ),
    };
  }

  /* ---------- 第 10 步：可行性状态、风险与差异 ---------- */
  const placedTotal = placements.reduce((sum, placement) => sum + (placement.endMinutes - placement.startMinutes), 0);

  // 未安排的工作量（去掉已经排入的部分之后重新核账，保证报告的数字与计划一致）
  const finalUnscheduled = reconcileUnscheduled({
    unscheduled,
    remainingByTask,
    placements,
    taskById,
    now,
    policy,
  });

  const remainingAfter = [...remainingByTask.values()].reduce((sum, value) => sum + value, 0);
  const placedForActiveTasks = placements.reduce((sum, placement) => sum + (placement.endMinutes - placement.startMinutes), 0);

  let status = PLAN_STATUS.FEASIBLE;
  if (finalUnscheduled.length > 0) {
    status = placedForActiveTasks > 0 ? PLAN_STATUS.PARTIALLY_FEASIBLE : PLAN_STATUS.INFEASIBLE;
  }

  const overloadMinutes = computeOverload({ remainingByTask, capacityDays, placements });
  if (overloadMinutes > 0) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.OVERLOAD,
      severity: 'warning',
      message: `任务总需求超出七天窗口内的可用容量约 ${overloadMinutes} 分钟。系统不会通过取消机动缓冲来掩盖这个问题，请考虑延长学习时间或调整截止时间。`,
      details: { overloadMinutes },
    });
  }

  const days = buildDayMetrics({ capacityDays, blocks, placements, windowStart, windowEnd });

  const bufferReservedMinutes = bufferBlocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
  const restMinutes = restBlocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
  const studyMinutes = studyBlocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
  const reservedMinutesTotal = reservedBlocks.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);

  const plan = {
    planId: input.planId ?? null,
    version: input.baseVersion ?? ((input.existingPlan?.version ?? 0) + 1),
    status,
    generatedAt: null, // 由调用方（服务层）填入真实时间：引擎保持纯函数，不读时钟
    windowStart,
    windowEnd,
    engineVersion: policy.engineVersion,
    policyHash,
    inputHash,
    blocks,
    sessionIds: blocks.filter((block) => block.kind === BLOCK_KIND.STUDY && block.refId).map((block) => block.refId),
    days,
    unscheduled: finalUnscheduled,
    diagnostics,
    metrics: {
      totalStudyMinutes: studyMinutes,
      totalReservedMinutes: reservedMinutesTotal,
      // 语义：**尚未安排**的剩余工作量合计（不是所有任务的剩余量，后者含已排入的部分）
      totalTaskRemainingMinutes: finalUnscheduled.reduce((sum, item) => sum + item.remainingMinutes, 0),
      totalRemainingWorkloadMinutes: remainingAfter,
      bufferReservedMinutes,
      restMinutes,
      subjectSwitches: countSubjectSwitches(studyBlocks),
      placedMinutes: placedTotal,
      overloadMinutes,
    },
  };

  const risks = assessAllRisks({
    tasks: state.tasks ?? [],
    remainingByTask,
    blocks,
    now,
    policy: { ...policy, studyWindows: state.settings?.studyWindows ?? {}, fixedSpans, reservedSpans },
    capacityDays,
  });

  if (plan.status !== PLAN_STATUS.FEASIBLE) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.OVERLOAD,
      severity: 'warning',
      message: `当前计划状态：${plan.status === PLAN_STATUS.INFEASIBLE ? '不可行' : '部分可行'}（${finalUnscheduled.length} 个任务未完全安排）。`,
    });
  }

  const diff = diffPlans(input.existingPlan ?? null, plan, { taskById });

  return {
    ok: true,
    status,
    plan,
    diagnostics,
    unscheduled: finalUnscheduled,
    risks,
    diff,
    taskById,
    policy,
    now,
    windowStart,
    windowEnd,
    windowDays,
    capacityDays,
    inputHash,
    policyHash,
    scoredEntries: orderedEntries.map((entry) => ({ taskId: entry.task.id, ...entry.score })),
    stats: {
      planned: remainingAfter,
      placed: placedForActiveTasks,
      schedulableMinutes: totalSchedulable,
      overloadMinutes,
    },
  };
}

/**
 * 计算一次排程的输入指纹（引擎内部与业务层共用同一个实现）。
 *
 * 抽出来的原因：服务层在"应用预览"时必须重新计算**当前状态**的指纹来检测预览过期。
 * 如果服务层自己再写一遍指纹逻辑，两边稍有差别（例如少算一个字段）就会出现
 * "数据明明变了、预览却还能应用"的漏洞。共用同一个函数可以彻底避免这种漂移。
 *
 * @param {object} params
 * @param {object} params.state 应用状态
 * @param {{date: string, minutes: number}} params.now
 * @param {string} params.windowStart
 * @param {string} params.windowEnd
 * @param {string} params.engineVersion
 * @param {Record<string, number>} [params.completedByTask] 每个任务的已完成分钟数
 */
export function computeSchedulerInputHash({ state, now, windowStart, windowEnd, engineVersion, completedByTask }) {
  return computeInputHash({
    engineVersion,
    policyHash: computePolicyHash(state.settings ?? {}, engineVersion),
    nowDate: now.date,
    windowStart,
    windowEnd,
    settings: state.settings ?? {},
    tasks: state.tasks ?? [],
    sessions: state.sessions ?? [],
    fixedActivities: state.fixedActivities ?? [],
    completedMinutesByTask: completedByTask ?? {},
  });
}

/* ------------------------------------------------------------------ *
 * 辅助：输入非法
 * ------------------------------------------------------------------ */

function invalidResult({ now, windowStart, windowEnd, windowDays, policy, issues, state, baseVersion, existingPlan, taskById }) {
  return {
    ok: false,
    status: PLAN_STATUS.INVALID_INPUT,
    reason: 'invalid_input',
    issues,
    violations: [],
    diagnostics: issues.map((issue) => ({
      code: issue.code,
      severity: 'error',
      message: issue.message,
      path: issue.path,
    })),
    unscheduled: [],
    risks: [],
    diff: diffPlans(existingPlan ?? null, null, { taskById: taskById ?? new Map() }),
    policy,
    now,
    windowStart,
    windowEnd,
    windowDays,
    capacityDays: [],
    inputHash: null,
    policyHash: null,
    state,
    baseVersion,
  };
}

/* ------------------------------------------------------------------ *
 * 辅助：依赖门控
 * ------------------------------------------------------------------ */

/**
 * 找出被依赖阻断的任务。
 *
 * 规则（对应 H7 与需求"前置未完成不得提前执行"）：
 * - 前置任务被取消/删除 → 永远无法满足（DEPENDENCY_UNREACHABLE）
 * - 前置任务仍有剩余工作量、但本次窗口内排不下 → 本任务也无法可靠地"接在它之后"（BLOCKED_BY_DEPENDENCY）
 * - 前置任务可安排 → 不阻断（先后顺序由放位阶段的依赖检查保证）
 */
function collectDependencyBlocked(tasks, taskById, remainingByTask) {
  const blocked = new Map();
  const taskSet = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = taskById.get(dependencyId);
      if (!dependency) continue;
      if (dependency.status === 'completed') continue; // 前置任务已完成，不构阻断

      if (dependency.status === 'cancelled' || dependency.status === 'deleted') {
        blocked.set(task.id, {
          reasonCode: UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE,
          extra: { dependencyId, dependencyTitle: dependency.title },
        });
        break;
      }
      if (!taskSet.has(dependencyId)) {
        // 前置任务本身不在可排程集合里（例如已取消）→ 同样无法满足
        blocked.set(task.id, {
          reasonCode: UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE,
          extra: { dependencyId, dependencyTitle: dependency.title },
        });
        break;
      }
      if ((remainingByTask.get(dependencyId) ?? 0) <= 0) continue; // 已完成，不阻断
    }
  }
  return blocked;
}

/* ------------------------------------------------------------------ *
 * 辅助：未安排原因
 * ------------------------------------------------------------------ */

function reasonCodeForSplitStatus(status) {
  switch (status) {
    case SPLIT_STATUS.ATOMIC_TOO_LONG:
      return UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT;
    case SPLIT_STATUS.UNSPLITTABLE_TAIL:
      return UNSCHEDULED_REASON.TAIL_TOO_SMALL;
    case SPLIT_STATUS.TOO_MANY_FRAGMENTS:
      return UNSCHEDULED_REASON.TAIL_TOO_SMALL;
    default:
      return UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY;
  }
}

function buildUnscheduled({ task, remainingMinutes, reasonCode, extra = {} }) {
  return {
    taskId: task.id,
    taskTitle: task.title,
    subject: task.subject,
    remainingMinutes,
    gapMinutes: remainingMinutes,
    reasonCode,
    reasonText: extra.message ?? describeReason(reasonCode),
    details: { ...extra, deadlineDate: task.deadlineDate, deadlineTime: task.deadlineTime },
    suggestions: suggestFor(reasonCode),
  };
}

function describeReason(reasonCode) {
  const texts = {
    [UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY]: '七天窗口内的可用学习容量不足，放不下剩余的全部工作量。',
    [UNSCHEDULED_REASON.TAIL_TOO_SMALL]: '剩余的尾部时长小于该任务的最短学习时段，无法作为一个合法时段安排。',
    [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY]: '前置任务尚未完成，因此不能提前安排。',
    [UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE]: '前置任务已被取消或删除，该任务永远无法满足依赖条件。',
    [UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT]: '该任务不可拆分，但窗口内没有足够长的连续空闲时段一次放下。',
    [UNSCHEDULED_REASON.DEADLINE_PASSED]: '截止时间已经过去，安排也无法按时完成。',
    [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: '允许学习的时间窗口为空或过窄。',
    [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: '已触达每日学习上限或每日片段数上限。',
    [UNSCHEDULED_REASON.OVERLOADED]: '所有任务的剩余工作量之和超过了窗口内的可用容量。',
  };
  return texts[reasonCode] ?? '在当前约束下无法安排。';
}

function suggestFor(reasonCode) {
  const map = {
    [UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY]: ['extend_window', 'accept_partial', 'lower_buffer', 'move_deadline'],
    [UNSCHEDULED_REASON.TAIL_TOO_SMALL]: ['lower_min_chunk', 'merge_chunks', 'move_deadline'],
    [UNSCHEDULED_REASON.BLOCKED_BY_DEPENDENCY]: ['finish_dependency', 'remove_dependency'],
    [UNSCHEDULED_REASON.DEPENDENCY_UNREACHABLE]: ['remove_dependency', 'restore_dependency', 'cancel_task'],
    [UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT]: ['allow_split', 'extend_window', 'move_deadline'],
    [UNSCHEDULED_REASON.DEADLINE_PASSED]: ['move_deadline', 'cancel_task'],
    [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: ['extend_window'],
    [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: ['raise_daily_cap', 'extend_window'],
    [UNSCHEDULED_REASON.OVERLOADED]: ['accept_partial', 'extend_window', 'move_deadline', 'cancel_task'],
  };
  return map[reasonCode] ?? ['accept_partial'];
}

/* ------------------------------------------------------------------ *
 * 辅助：片段 ID 与用量
 * ------------------------------------------------------------------ */

/**
 * 把学习片段的 ID 改写为"(任务, 片段序号)"派生的确定性 ID。
 *
 * 注意两个坑：
 * 1. 休息块没有 taskId，必须原样保留（kind='rest'），否则会被下游当成学习块统计。
 * 2. 早期版本用 `placements.length` 当作片段序号，会导致同一任务的多个片段拿到**相同的 ID**，
 *    进而在硬约束校验里被当成"两个重叠的学习时段"。序号必须按任务单独计数。
 */
function reassignSessionIds(placements, fragmentsByTask, inputHash) {
  const counterByTask = new Map();
  return placements.map((placement) => {
    if (placement.kind === 'rest') return { ...placement, kind: 'rest' };
    if (placement.kind === 'study') {
      const index = counterByTask.get(placement.taskId) ?? 0;
      counterByTask.set(placement.taskId, index + 1);
      return { ...placement, kind: 'study', taskId: placement.taskId, id: deriveSessionId(inputHash, placement.taskId, index) };
    }
    return { ...placement, kind: placement.kind ?? 'study' };
  });
}

function countPlacedMinutes(placements) {
  const map = new Map();
  for (const placement of placements) {
    if (placement.kind !== 'study') continue;
    map.set(placement.taskId, (map.get(placement.taskId) ?? 0) + (placement.endMinutes - placement.startMinutes));
  }
  return map;
}

/** 核账：只保留真正没有被排入的分钟数，避免报告与计划不一致 */
function reconcileUnscheduled({ unscheduled, remainingByTask, placements, taskById, now, policy }) {
  const placed = countPlacedMinutes(placements);
  const byTask = new Map();
  for (const item of unscheduled) {
    if (!byTask.has(item.taskId)) byTask.set(item.taskId, item);
  }

  const out = [];
  for (const [taskId, remaining] of remainingByTask) {
    if (remaining <= 0) continue;
    const placedMinutes = placed.get(taskId) ?? 0;
    const missing = remaining - placedMinutes;
    if (missing <= 0) continue;
    const task = taskById.get(taskId);
    if (!task) continue;
    const existing = byTask.get(taskId);
    if (existing) {
      out.push({ ...existing, remainingMinutes: missing, gapMinutes: missing });
    } else {
      const reasonCode = pickReasonCode({ task, missing, policy });
      out.push({
        taskId,
        taskTitle: task.title,
        subject: task.subject,
        remainingMinutes: missing,
        gapMinutes: missing,
        reasonCode,
        reasonText: describeReason(reasonCode),
        details: { deadlineDate: task.deadlineDate, deadlineTime: task.deadlineTime },
        suggestions: suggestFor(reasonCode),
      });
    }
  }

  return out.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
}

function pickReasonCode({ task, missing, policy }) {
  if (task.splittable === false) return UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT;
  const minChunk = task.minChunkMinutes ?? policy.defaultMinChunkMinutes;
  if (missing < minChunk) return UNSCHEDULED_REASON.TAIL_TOO_SMALL;
  return UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY;
}

/* ------------------------------------------------------------------ *
 * 辅助：局部优化
 * ------------------------------------------------------------------ */

/**
 * 局部优化：只做两类**可验证、可回退**的移动。
 *
 * 1. 把片段向前挪到当日更早的空位（减少白天碎片、让安排紧凑）。
 * 2. 把同一天里"同科目"的片段往相邻位置合并（减少科目切换）。
 *
 * 每次移动后都会重新检查硬约束（H1/H2/H3/H7），只要违反就立刻回退。
 * 迭代次数有上界（策略里的 optimizationPasses），因此结果是确定的、有界的。
 * **不宣称全局最优**：这里只是一个局部改进，UI 与文档的说法必须与此一致。
 */
function optimizePlacements({ placements, policy, occupiedSpans, studyWindows, taskById, passes }) {
  let current = dedupePlacements(placements);
  const passesToRun = Math.max(0, Math.min(passes ?? policy.optimizationPasses, 5));

  for (let pass = 0; pass < passesToRun; pass += 1) {
    // 占用集合必须包含**同一天的休息块**：休息也是真实占用时间轴的时间，
    // 只考虑保留时段与固定活动会让"向前压缩"把学习片段挪到休息上（H2/H8 违规）。
    const restSpans = current.filter((item) => item.kind === 'rest');
    const improved = tryCompact(current, {
      occupiedSpans: [...occupiedSpans, ...restSpans],
      studyWindows,
      taskById,
    });
    if (!improved.changed) break;
    current = improved.placements;
  }

  const sorted = current.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      a.startMinutes - b.startMinutes ||
      (a.id < b.id ? -1 : 1),
  );

  // 最后一道保险：消解同一天内的区间重叠（按时间顺序把后面的块顺延，必要时放弃休息块）。
  // 局部优化只保证"学习片段互不重叠"，但压缩后的学习片段仍可能与休息块相交，
  // 因此在交付给硬约束校验器之前，这里必须把时间轴整理成互不重叠的序列。
  return resolveOverlaps(sorted);
}

/**
 * 消解计划内的区间重叠。
 *
 * 规则（确定性）：
 * - 按 (日期, 开始时间, 类型, ID) 顺序处理；
 * - 若某块与"已经确定下来的块"重叠：
 *   - 休息块 → 顺延到间隙之后；若当天已无空间则放弃该休息块（休息不是硬性任务）；
 *   - 学习块 → 顺延到空闲处；若顺延后超出当日最后一个可用窗口，则**保留原位置**，
 *     交由硬约束校验器报告（绝不静默丢弃学习内容）。
 */
function resolveOverlaps(placements) {
  const result = [];
  const lastEndByDate = new Map();

  for (const item of placements) {
    const length = item.endMinutes - item.startMinutes;
    const lastEnd = lastEndByDate.get(item.date);

    if (lastEnd === undefined || item.startMinutes >= lastEnd) {
      result.push(item);
      lastEndByDate.set(item.date, item.endMinutes);
      continue;
    }

    if (item.kind === 'rest') {
      const shiftedStart = lastEnd;
      if (shiftedStart + length <= 1440) {
        result.push({ ...item, startMinutes: shiftedStart, endMinutes: shiftedStart + length });
        lastEndByDate.set(item.date, shiftedStart + length);
      }
      // 放不下的休息直接省略（学习优先，休息不是硬性任务）
      continue;
    }

    const shiftedStart = lastEnd;
    if (shiftedStart + length <= 1440) {
      result.push({ ...item, startMinutes: shiftedStart, endMinutes: shiftedStart + length });
      lastEndByDate.set(item.date, shiftedStart + length);
      continue;
    }

    // 无法顺延：保留原位置，交给校验器如实报告冲突
    result.push(item);
  }

  return result;
}

function dedupePlacements(placements) {
  const seen = new Set();
  const out = [];
  for (const placement of placements) {
    if (seen.has(placement.id)) continue;
    seen.add(placement.id);
    out.push(placement);
  }
  return out;
}

/** 把同一天的学习片段依次向前压缩：只要前方有空位且不违反依赖关系就前移 */
function tryCompact(placements, { occupiedSpans, studyWindows, taskById }) {
  const studies = placements.filter((item) => item.kind === 'study');
  const others = placements.filter((item) => item.kind !== 'study');
  const byDate = new Map();
  for (const item of studies) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
  }

  let changed = false;
  const nextStudies = [];
  for (const [date, list] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const occupied = [...(occupiedSpans ?? []).filter((span) => span.date === date)];
    const sorted = [...list].sort((a, b) => a.startMinutes - b.startMinutes);
    for (const item of sorted) {
      const length = item.endMinutes - item.startMinutes;
      const windows = normalizeStudyWindows(date, studyWindows);
      let placedAt = item.startMinutes;
      for (const window of windows) {
        let cursor = window.startMinutes;
        for (const block of [...occupied].sort((a, b) => a.startMinutes - b.startMinutes)) {
          if (block.endMinutes <= cursor) continue;
          if (cursor + length <= block.startMinutes) break;
          cursor = Math.max(cursor, block.endMinutes);
        }
        if (cursor + length <= window.endMinutes) {
          placedAt = Math.min(placedAt, cursor);
          break;
        }
      }
      // 依赖检查必须针对"全部片段"而不是"已完成遍历的片段"：
      // 前置任务的片段可能排在本次遍历的后面，只看 nextStudies 会漏检，从而把依赖任务挪到前置任务之前。
      if (placedAt < item.startMinutes && respectsDependency(date, placedAt, length, item, placements.filter((entry) => entry.kind === 'study'), taskById)) {
        nextStudies.push({ ...item, startMinutes: placedAt, endMinutes: placedAt + length });
        occupied.push({ date, startMinutes: placedAt, endMinutes: placedAt + length });
        changed = true;
      } else {
        nextStudies.push(item);
        occupied.push({ date, startMinutes: item.startMinutes, endMinutes: item.endMinutes });
      }
    }
  }

  return { placements: [...nextStudies, ...others], changed };
}

/** 前移后仍然满足依赖：本任务的开始时间不得早于前置任务的最晚结束时间 */
function respectsDependency(date, startMinutes, length, item, placed, taskById) {
  const task = taskById.get(item.taskId);
  if (!task) return true;
  const taskById2 = taskById;
  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = taskById2.get(dependencyId);
    if (!dependency || dependency.status === 'completed') continue;
    const dependencyBlocks = placed.filter((entry) => entry.taskId === dependencyId);
    if (dependencyBlocks.length === 0) continue;
    const last = dependencyBlocks.reduce((latest, entry) => {
      const stamp = `${entry.date}T${String(entry.endMinutes).padStart(5, '0')}`;
      return latest === null || stamp > latest ? stamp : latest;
    }, null);
    const ownStamp = `${date}T${String(startMinutes).padStart(5, '0')}`;
    if (last !== null && ownStamp < last) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 辅助：缓冲块与每日统计
 * ------------------------------------------------------------------ */

/**
 * 生成机动缓冲块。
 *
 * 语义说明（重要，不要误解）：
 * - 缓冲是**预留额度**：容量计算时已经从每日可排分钟里扣掉了 `floor(netCapacity × 10%)`。
 * - 这里只把当天**尚未被安排任务占用**的时间中，取不超过该额度的部分标记出来，
 *   这样时间轴上就能看到"还有多少余量没有用掉"。
 * - 缓冲块与学习块、休息块保证不重叠（H8），并且永远不会占用已被排入任务的时间。
 */
function buildBufferBlocks({ days, studyBlocks, restBlocks, inputHash }) {
  const blocks = [];
  for (const day of days) {
    if (day.bufferMinutes <= 0) continue;
    const busy = [
      ...studyBlocks.filter((block) => block.date === day.date),
      ...restBlocks.filter((block) => block.date === day.date),
    ].sort((a, b) => a.startMinutes - b.startMinutes);

    const free = [];
    for (const window of day.freeWindows) {
      let cursor = window.startMinutes;
      for (const block of busy) {
        if (block.endMinutes <= cursor) continue;
        if (block.startMinutes >= window.endMinutes) break;
        if (block.startMinutes > cursor) free.push({ startMinutes: cursor, endMinutes: Math.min(block.startMinutes, window.endMinutes) });
        cursor = Math.max(cursor, block.endMinutes);
        if (cursor >= window.endMinutes) break;
      }
      if (cursor < window.endMinutes) free.push({ startMinutes: cursor, endMinutes: window.endMinutes });
    }

    let remaining = day.bufferMinutes;
    let index = 0;
    for (const slot of free) {
      if (remaining <= 0) break;
      const length = Math.min(remaining, slot.endMinutes - slot.startMinutes);
      if (length <= 0) continue;
      blocks.push({
        id: deriveBlockId('buffer', inputHash, day.date, slot.startMinutes, index),
        kind: BLOCK_KIND.BUFFER,
        date: day.date,
        startMinutes: slot.startMinutes,
        endMinutes: slot.startMinutes + length,
        refId: null,
        label: '机动缓冲',
        locked: false,
        derived: true,
        meta: { reservedMinutes: length },
      });
      remaining -= length;
      index += 1;
    }
  }
  return blocks;
}

function buildDayMetrics({ capacityDays, blocks, placements, windowStart, windowEnd }) {
  return capacityDays.map((day) => {
    const dayBlocks = blocks.filter((block) => block.date === day.date);
    const studyMinutes = dayBlocks.filter((b) => b.kind === BLOCK_KIND.STUDY).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    const restMinutes = dayBlocks.filter((b) => b.kind === BLOCK_KIND.REST).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    const bufferMinutes = dayBlocks.filter((b) => b.kind === BLOCK_KIND.BUFFER).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    const sessionCount = dayBlocks.filter((b) => b.kind === BLOCK_KIND.STUDY).length;
    // 当日实际用于任务的分钟数（不含缓冲与休息）
    const schedulableUsed = dayBlocks
      .filter((b) => b.kind === BLOCK_KIND.STUDY)
      .reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);

    return {
      date: day.date,
      weekday: weekday(day.date),
      windowMinutes: day.windowMinutes,
      fixedMinutes: day.fixedMinutes,
      reservedMinutes: day.reservedMinutes,
      netCapacityMinutes: day.netCapacityMinutes,
      bufferMinutes,
      // 已实际占用掉的缓冲：当日学习量超过"扣除缓冲后的可排额度"的部分
      bufferUsedMinutes: Math.max(0, schedulableUsed - day.schedulableMinutes),
      schedulableMinutes: day.schedulableMinutes,
      studyMinutes,
      restMinutes,
      sessionCount,
      overloadMinutes: Math.max(0, schedulableUsed - day.schedulableMinutes),
      freeWindows: day.freeWindows,
    };
  });
}

/** 科目切换次数：同一天内相邻学习片段科目不同的次数 */
function countSubjectSwitches(studyBlocks) {
  const byDate = new Map();
  for (const block of studyBlocks) {
    if (!byDate.has(block.date)) byDate.set(block.date, []);
    byDate.get(block.date).push(block);
  }
  let switches = 0;
  for (const list of byDate.values()) {
    const sorted = [...list].sort((a, b) => a.startMinutes - b.startMinutes);
    let previousSubject = null;
    for (const block of sorted) {
      if (previousSubject !== null && block.subject && block.subject !== previousSubject) switches += 1;
      if (block.subject) previousSubject = block.subject;
    }
  }
  return switches;
}

/** 整体超载分钟数：未被安排的剩余工作量 */
function computeOverload({ remainingByTask, capacityDays, placements }) {
  const totalRemaining = [...remainingByTask.values()].reduce((sum, value) => sum + value, 0);
  const totalPlaced = placements
    .filter((placement) => placement.kind === 'study')
    .reduce((sum, placement) => sum + (placement.endMinutes - placement.startMinutes), 0);
  return Math.max(0, totalRemaining - totalPlaced);
}

/* ------------------------------------------------------------------ *
 * 辅助：保留时段的冲突检测
 * ------------------------------------------------------------------ */

/** 检测锁定/已完成时段之间的冲突（与固定活动重叠、或彼此重叠），如实报告不擅自修改 */
function detectReservedConflicts(reservedSessions, fixedSpans) {
  const diagnostics = [];
  for (const session of reservedSessions) {
    for (const span of fixedSpans) {
      if (span.date !== session.date) continue;
      const overlap = Math.max(0, Math.min(session.endMinutes, span.endMinutes) - Math.max(session.startMinutes, span.startMinutes));
      if (overlap > 0) {
        diagnostics.push({
          code: DIAGNOSTIC_CODE.RESERVED_BLOCK_OVERLAP,
          severity: 'warning',
          message: `${session.date} 有一段受保护的学习时段（${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}）与固定活动「${span.title ?? ''}」重叠了 ${overlap} 分钟。系统保留了你的锁定/已完成记录，请检查其中一项是否需要调整。`,
          relatedIds: [session.id, span.activityId],
        });
      }
    }
  }
  return diagnostics;
}

/** 块的稳定排序：日期 → 开始时间 → 类型 → ID */
function compareBlocks(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
}

export { PLAN_STATUS, RISK_LEVEL, DIAGNOSTIC_CODE, UNSCHEDULED_REASON, MINUTES_PER_DAY };
