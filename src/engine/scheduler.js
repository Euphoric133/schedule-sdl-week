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
 *   4. 生成可用时间区间
 *   5. 任务拆分（可拆分 / 不可拆分 / 尾差处理）
 *   6. 按硬约束 + 截止风险 + 优先级分数生成初始计划
 *   7. 局部优化（确定性、有界迭代，不宣称全局最优）
 *   8. 组装时间轴块（学习 / 固定 / 休息 / 缓冲）
 *   9. 硬约束校验 H1–H10（失败则拒绝出计划，由调用方保留旧计划）
 *  10. 计算差异与风险评估，交给上层生成预览
 */

import { buildPolicy, DIAGNOSTIC_CODE, REASON_TEXT, RISK_LEVEL, UNSCHEDULED_REASON } from './policy.js';
import { computeInputHash, computePolicyHash, deriveBlockId, deriveSessionId } from './versionHash.js';
import { computeWindowCapacity, longestFreeSlot, normalizeStudyWindows, resolveSearchStart } from './capacity.js';
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
import { absoluteMinutes, addDays, formatMinutes, MINUTES_PER_DAY, parseTimeString, weekday } from '../domain/time.js';
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
 * @param {{date: string, minutes: number}|null} [input.startAt] 用户指定的规划开始时间；不传则自动取"当前时刻之后的下一个整点"
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

  /**
   * 两层区分（这是本轮最关键的一条规则）：
   *
   * 1. **容量层**：已完成时段仍然占住它的墙钟时间。
   *    它是真实发生的学习，排程器不能把新的学习内容排到同一时刻（否则计划里
   *    会出现两个时间完全重叠的块）。所以它继续参与 capacity 的扣减。
   *
   * 2. **冲突层**：已完成时段**不再**被当成"有效占位"去拦用户。
   *    用户想在那个时段安排固定课程、休息或新任务时必须放行——
   *    那段时间已经过去了，任务也做完了，继续拦住就是在永久锁死时间。
   *    因此"保留时段 × 固定活动"的数据冲突检查只看锁定/进行中的时段。
   */
  const occupancySessions = reservedSessions.filter(
    (session) => session.locked === true || session.state === SESSION_STATE.IN_PROGRESS,
  );

  const reservedSpans = mergeSpans(
    reservedSessions.map((session) => ({ date: session.date, startMinutes: session.startMinutes, endMinutes: session.endMinutes })),
  );

  // 只检查真正占用中的时段与固定活动是否冲突；历史记录不参与
  const conflictDiagnostics = detectReservedConflicts(occupancySessions, fixedSpans);
  diagnostics.push(...conflictDiagnostics);

  /* ---------- 第 3 步：剩余工作量 ---------- */
  const schedulableTasks = (state.tasks ?? []).filter((task) => SCHEDULABLE_TASK_STATUSES.includes(task.status));

  // 已被保留的时段（锁定 / 进行中）会**原样进入候选计划**，它们已经占据了任务的一部分工作量。
  // 因此需要从"剩余工作量"里减去这部分，否则会把同一份工作排两遍（总量超出任务预计用时）。
  const carriedOverByTask = new Map();
  for (const session of occupancySessions) {
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

  /* ---------- 第 4 步：可用容量 ---------- */
  /**
   * 规划搜索起点。
   *
   * 规则（本轮明确要求）：
   * - 用户指定了开始时间 → 从该时间开始找可用时段；如果它已经过去，则**明确告知**并改用默认值，
   *   绝不悄悄把过去的时间当成未来；
   * - 未指定 → 默认取"当前时刻之后的下一个整点"（严格之后：20:00 也取 21:00）。
   */
  /**
   * 今天之内、用户给任务指定的最早开始时间（不早于现在）。
   * 它会把"下一个整点"的默认起点拉早——否则 22:05 时任务要求 22:23，
   * 默认整点 23:00 会把 22:23 直接跳过。
   */
  const todayTaskStarts = (state.tasks ?? [])
    .filter((task) => SCHEDULABLE_TASK_STATUSES.includes(task.status))
    .map((task) => task.plannedStartMinutes)
    .filter((minutes) => Number.isInteger(minutes) && minutes >= now.minutes);
  const earliestTaskStartToday = todayTaskStarts.length > 0 ? Math.min(...todayTaskStarts) : null;

  const searchStart = resolveSearchStart({
    now,
    requested: input.startAt ?? null,
    earliestTaskStart: earliestTaskStartToday,
  });
  diagnostics.push(...searchStart.diagnostics);

  const capacityDays = computeWindowCapacity({
    windowStart,
    windowEnd,
    studyWindows: state.settings?.studyWindows ?? {},
    fixedSpans,
    reservedSpans,
    bufferRatio: policy.bufferRatio,
    searchStart: searchStart.start,
    now,
    // 最晚睡觉时间：硬约束，容量只到该时刻为止
    latestSleepMinutes: policy.latestSleepMinutes,
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

  /* ---------- 第 5b 步：没有可排内容的明确判定 ----------
   * 不做这一步的后果很严重：用户在没有任务（或完全没有可用时间）时点"生成计划"，
   * 会看到"完整可行 + 全部 0"，误以为系统已经生成了有意义的计划。
   * 这里明确返回 invalid_input 并给出可执行的下一步建议。
   */
  /**
   * 一个任务都没有的情况：**不在这里拒绝**。
   *
   * 原因是"删除最后一个任务""完成所有任务"都是合法操作，它们同样需要走
   * 「生成候选计划 → 预览 → 确认」这条路径。真正需要"先新建任务"提示的，
   * 是"用户主动点生成计划但完全没有任务"这个场景，那属于界面层的入口判断
   * （见 planService.requestPreview），而不是引擎的职责。
   * 这里只记录一条诊断，让界面知道这份计划里没有任何可排内容。
   */
  const allTasks = state.tasks ?? [];
  if (allTasks.length === 0) {
    diagnostics.push({
      code: DIAGNOSTIC_CODE.NO_CAPACITY,
      severity: 'info',
      message: '当前没有任何学习任务，这份计划里不会包含学习时段。',
      path: 'tasks',
    });
  }

  // 说明：任务表非空但**没有可排任务**  // 说明：任务表非空但**没有可排任务**（例如全部已完成、已取消或已删除）是合法状态，
  // 此时应当照常生成一份"没有学习安排"的计划，让用户可以预览影响（例如取消任务会释放哪些时段），
  // 而不是报错拒绝。

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

  /**
   * 某个任务在**它的截止时间之前**还剩下多少可用容量。
   *
   * 用途：把"排不下"的原因说准。以前一律报"七天容量不足"，
   * 但真正的原因可能是"截止 13:00 之前只剩下 60 分钟，而这个任务要 120 分钟"。
   */
  function capacityBeforeDeadline(task) {
    const minutes = parseDeadlineMinutes(task?.deadlineTime);
    if (!task?.deadlineDate || minutes === null) return null;
    const deadlineAbsolute = absoluteMinutes({ date: task.deadlineDate, minutes });
    let total = 0;
    for (const day of capacityDays) {
      const dayStart = absoluteMinutes({ date: day.date, minutes: 0 });
      const latest = deadlineAbsolute - dayStart;
      if (latest <= 0) continue;
      for (const window of day.freeWindows) {
        const end = Math.min(window.endMinutes, latest);
        if (end > window.startMinutes) total += end - window.startMinutes;
      }
    }
    return total;
  }

  /** 某个任务在它的"计划开始时间"之后还剩多少可用容量 */
  function capacityAfterPlannedStart(task) {
    const plannedStart = Number.isInteger(task?.plannedStartMinutes) ? task.plannedStartMinutes : null;
    if (plannedStart === null) return null;
    let total = 0;
    for (const day of capacityDays) {
      for (const window of day.freeWindows) {
        const start = Math.max(window.startMinutes, plannedStart);
        if (window.endMinutes > start) total += window.endMinutes - start;
      }
    }
    return total;
  }

  /** 给"放不下"的任务挑一个最准确的原因 */
  function refineReason(task, remaining, fallback) {
    // 不可拆分任务连一个足够长的连续空档都没有时，这个原因最准确，
    // 不能因为"截止前容量也不够"就覆盖成 deadline_too_close（那是另一回事）。
    if (fallback === UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT) return fallback;
    const beforeDeadline = capacityBeforeDeadline(task);
    if (beforeDeadline !== null && beforeDeadline < remaining) {
      return UNSCHEDULED_REASON.DEADLINE_TOO_CLOSE;
    }
    const afterStart = capacityAfterPlannedStart(task);
    if (afterStart !== null && afterStart < remaining) {
      return UNSCHEDULED_REASON.PLANNED_START_UNREACHABLE;
    }
    return fallback;
  }

  /**
   * 用户填的"计划开始时间"如果早于本次规划的搜索起点，
   * 实际生效的是搜索起点（不可能排到过去）。这种情况必须**明说**，
   * 否则用户会以为自己的设置被完全忽略了。
   */
  for (const task of state.tasks ?? []) {
    if (!Number.isInteger(task.plannedStartMinutes)) continue;
    if (task.plannedStartMinutes >= searchStart.start.minutes) continue;
    if (task.deadlineDate && task.deadlineDate < searchStart.start.date) continue;
    diagnostics.push({
      code: 'planned_start_clamped',
      level: 'info',
      message: `任务「${task.title}」的计划开始时间（${formatMinutes(task.plannedStartMinutes)}）早于本次规划起点（${formatMinutes(searchStart.start.minutes)}），已按规划起点开始考虑。`,
    });
  }

  /* ---------- 第 6b 步：无法放置的片段 ---------- */
  const placedByTask = countPlacedMinutes(placements);
  for (const entry of orderedEntries) {
    const planned = remainingByTask.get(entry.task.id) ?? 0;
    const placed = placedByTask.get(entry.task.id) ?? 0;
    if (placed >= planned) continue;
    const already = unscheduled.find((item) => item.taskId === entry.task.id);
    if (already) {
      /**
       * 不可拆分任务只要"最长连续空档"都短于任务本身，原因就应该是
       * "没有足够长的连续空档"，而不是被覆盖成截止时间或总容量不足。
       * 这条对用户最有指导意义：要么调小任务，要么允许拆分。
       */
      const longestForTask = capacityDays.reduce((max, day) => Math.max(max, longestFreeSlot(day.freeWindows)), 0);
      if (entry.task.splittable === false && longestForTask < entry.task.plannedMinutes) {
        already.reasonCode = UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT;
        already.reasonText = REASON_TEXT[already.reasonCode] ?? already.reasonText;
        continue;
      }
      // 原因可能被更早的路径写成泛化描述，这里用截止时间口径纠正一次
      already.reasonCode = refineReason(entry.task, planned, already.reasonCode);
      already.reasonText = REASON_TEXT[already.reasonCode] ?? already.reasonText;
      continue;
    }
    const missing = planned - placed;
    // 不可拆分任务放不下的原因要准确：是"没有足够长的连续空档"，而不是"总容量不足"
    /**
     * 计算"这个任务实际能用到的"最长连续空档。
     * 关键：任务指定了开始时间时，空档必须从该时刻之后算起——
     * 否则会拿别的日期的整天空档来比较，得出"还放得下"的错误结论，
     * 从而把"没有足够长的连续空档"误报成截止时间太近。
     */
    const floor = Number.isInteger(entry.task.plannedStartMinutes) ? entry.task.plannedStartMinutes : 0;
    const longestSlot = capacityDays.reduce(
      (max, day) =>
        Math.max(
          max,
          longestFreeSlot(
            (day.freeWindows ?? []).map((window) => ({
              startMinutes: Math.max(window.startMinutes, floor),
              endMinutes: window.endMinutes,
            })).filter((window) => window.endMinutes > window.startMinutes),
          ),
        ),
      0,
    );
    const isAtomic = entry.task.splittable === false;
    const atomicNoSlot = isAtomic && longestSlot < entry.task.plannedMinutes;
    // 原因要准确：如果"截止前剩余时间"本身就不够，就不能笼统地说"七天容量不足"
    const baseReason = atomicNoSlot ? UNSCHEDULED_REASON.NON_SPLITTABLE_NO_SLOT : UNSCHEDULED_REASON.INSUFFICIENT_CAPACITY;
    const reasonCode = refineReason(entry.task, planned, baseReason);
    unscheduled.push(
      buildUnscheduled({
        task: entry.task,
        remainingMinutes: missing,
        reasonCode,
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
    /**
     * 局部优化必须使用**裁剪后的**每日可用窗口。
     *
     * capacityDays 里的 windows 已经扣掉了"规划起点之前"的时间；
     * 如果这里退回用原始的按星期窗口，优化器就会把片段"向前压缩"到规划起点之前
     * （例如现在 20:30、起点 21:00，却把学习排到 16:00）。
     * 这是"不生成过去时段"这条规则在优化阶段被绕过的真实原因。
     */
    windowsByDate: new Map(capacityDays.map((day) => [day.date, day.windows])),
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
    // 历史块：仍出现在计划里（统计/回顾需要），但不参与冲突与排程校验
    history: session.state === SESSION_STATE.COMPLETED || session.state === SESSION_STATE.CANCELLED,
    meta: { state: session.state, plannedMinutes: session.plannedMinutes, reserved: true, history: session.state === SESSION_STATE.COMPLETED || session.state === SESSION_STATE.CANCELLED },
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

  // 缓冲时间功能已移除：不再生成任何缓冲时段（也不会再因为缓冲改变任务时段）
  const bufferBlocks = [];

  const blocks = [...studyBlocks, ...reservedBlocks, ...fixedBlocks, ...restBlocks, ...bufferBlocks].sort(compareBlocks);

  /**
   * 严格开始时间的落点诊断。
   *
   * 用户填了"从这个时刻之后开始"，就应当**正好**从那一刻开始；如果没有做到，
   * 必须明确告诉他"计划 22:23，实际 22:53，原因是 X"，绝不静默改时间。
   * 这里放在优化（压缩）之后统计，因此也覆盖"被挪回更早/更晚"的情况。
   */
  diagnostics.push(...describePlannedStartOutcomes(optimized, taskById, { now, searchStart }));

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
    [UNSCHEDULED_REASON.DEADLINE_TOO_CLOSE]: '截止时间之前剩余的可用时间放不下这个任务（不会排到截止时间之后）。',
    [UNSCHEDULED_REASON.PLANNED_START_UNREACHABLE]: '你设置的计划开始时间之后没有足够的可用时间（不会排到你指定的时间之前）。',
    [UNSCHEDULED_REASON.WINDOW_TOO_NARROW]: '允许学习的时间窗口为空或过窄。',
    [UNSCHEDULED_REASON.DAILY_CAP_REACHED]: '已触达每日学习上限或每日片段数上限。',
    [UNSCHEDULED_REASON.OVERLOADED]: '所有任务的剩余工作量之和超过了窗口内的可用容量。',
  };
  return texts[reasonCode] ?? '在当前约束下无法安排。';
}

function suggestFor(reasonCode) {
  const map = {
    [UNSCHEDULED_REASON.DEADLINE_TOO_CLOSE]: ['move_deadline', 'reduce_workload', 'lower_min_chunk'],
    [UNSCHEDULED_REASON.PLANNED_START_UNREACHABLE]: ['clear_planned_start', 'extend_window', 'reduce_workload'],
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
function optimizePlacements({ placements, policy, occupiedSpans, studyWindows, windowsByDate = null, taskById, passes }) {
  let current = dedupePlacements(placements);
  const passesToRun = Math.max(0, Math.min(passes ?? policy.optimizationPasses, 5));

  for (let pass = 0; pass < passesToRun; pass += 1) {
    // 占用集合必须包含**同一天的休息块**：休息也是真实占用时间轴的时间，
    // 只考虑保留时段与固定活动会让"向前压缩"把学习片段挪到休息上（H2/H8 违规）。
    const restSpans = current.filter((item) => item.kind === 'rest');
    const improved = tryCompact(current, {
      occupiedSpans: [...occupiedSpans, ...restSpans],
      studyWindows,
      windowsByDate,
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
function tryCompact(placements, { occupiedSpans, studyWindows, windowsByDate = null, taskById }) {
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
      // 优先用"按日期裁剪后"的窗口（含规划起点限制），退回按星期配置
      const windows = (windowsByDate && windowsByDate.get(date)) ?? normalizeStudyWindows(date, studyWindows);
      /**
       * 任务的「计划开始时间」是软偏好，但**优化阶段也必须尊重它**：
       * 否则放位时正确落在 10:00 的片段，会被"向前压缩"立刻推回 09:00，
       * 用户看到的就是"我设了开始时间但完全没生效"。
       */
      const taskForItem = taskById?.get?.(item.taskId);
      const preferredFloor = Number.isInteger(taskForItem?.plannedStartMinutes) ? taskForItem.plannedStartMinutes : 0;
      let placedAt = item.startMinutes;
      for (const window of windows) {
        let cursor = Math.max(window.startMinutes, preferredFloor);
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

/** 解析截止时间的 HH:mm；非法返回 null（脏数据只降低约束，不抛异常） */
function parseDeadlineMinutes(value) {
  try {
    return parseTimeString(value);
  } catch {
    return null;
  }
}


/**
 * 计算并描述每个"指定了开始时间"的任务，实际第一个片段落在哪里。
 *
 * @param {Array<object>} placements 优化后的放置结果
 * @param {Map<string, object>} taskById
 * @param {{now: object, searchStart: {start: {date: string, minutes: number}, source?: string}}} ctx
 * @returns {Array<object>} 诊断数组
 */
function describePlannedStartOutcomes(placements, taskById, { now, searchStart }) {
  const diagnostics = [];
  const seen = new Set();

  const study = (placements ?? [])
    .filter((item) => item.kind === 'study' && item.taskId)
    .slice()
    .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1));

  for (const item of study) {
    const task = taskById?.get?.(item.taskId);
    const plannedStart = task?.plannedStartMinutes;
    if (!Number.isInteger(plannedStart) || seen.has(item.taskId)) continue;
    seen.add(item.taskId);

    // 今天且正好落在计划时刻 → 完全符合要求，无需提示
    if (item.date === now.date && item.startMinutes === plannedStart) continue;

    const actual = item.startMinutes;
    const sameDay = item.date === now.date;
    const reasonText = sameDay
      ? item.startMinutes === searchStart.start.minutes
        ? '该时刻已被固定日程、更高优先级的任务或已锁定的时段占用'
        : '该时刻已被占用'
      : '今天该时刻之后已排不下，顺延到了之后的日期';

    diagnostics.push({
      code: DIAGNOSTIC_CODE.PLANNED_START_DELAYED,
      severity: 'warning',
      date: item.date,
      relatedIds: [task.id, item.id],
      plannedStartMinutes: plannedStart,
      actualStartMinutes: actual,
      message: sameDay
        ? `任务「${task.title}」计划 ${formatMinutes(plannedStart)} 开始，实际 ${formatMinutes(actual)} 开始（${reasonText}）。`
        : `任务「${task.title}」计划 ${formatMinutes(plannedStart)} 开始，但今天已排不下，顺延到 ${item.date} ${formatMinutes(actual)}。`,
    });
  }

  return diagnostics;
}
