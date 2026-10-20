/**
 * 放位（Placement）：把学习片段放进具体的时间槽。
 *
 * 三条设计原则：
 * 1. **确定性**：没有随机数、没有时钟、没有对象迭代顺序依赖。所有候选槽的评分相同时，
 *    用 (日期 → 开始时间 → 任务 ID) 的字典序裁决，因此同一输入必然得到同一计划。
 * 2. **硬约束优先**：候选槽必须先通过"落在允许窗口内、不与已占用区间重叠、长度足够"这些检查，
 *    评分只在**合法槽之间**做取舍。评分永远不会让一个非法安排变成合法。
 * 3. **软偏好可解释**：每个被选中的槽都会记录原因码（偏好时段、同科目连续、槽位贴合…），
 *    差异预览直接把这些原因码翻译成中文给用户看。
 */

import { continuousLimitFor } from './policy.js';
import { preferredOverlapMinutes, slotsFitting, subtractSpans } from './capacity.js';
import { absoluteMinutes, parseTimeString } from '../domain/time.js';

/** 放位原因码（会写入 StudySession.reasonCodes，并翻译给用户） */
export const PLACEMENT_REASON = Object.freeze({
  PREFERRED_WINDOW: 'preferred_focus_window',
  SAME_SUBJECT_CONTINUITY: 'same_subject_continuity',
  SLOT_FIT: 'slot_fit',
  EARLIER_SLOT: 'earlier_slot',
  URGENT_DEADLINE: 'urgent_deadline',
  HIGH_PRIORITY: 'high_priority',
  SPILLOVER: 'spillover_to_next_day',
  UNDERSIZED_FINAL: 'undersized_final_chunk',
});

export const PLACEMENT_REASON_TEXT = Object.freeze({
  [PLACEMENT_REASON.PREFERRED_WINDOW]: '落在你设置的偏好专注时段',
  [PLACEMENT_REASON.SAME_SUBJECT_CONTINUITY]: '与同科目时段相邻，减少科目切换',
  [PLACEMENT_REASON.SLOT_FIT]: '与该空闲时段的长度贴合，避免产生无法利用的碎片',
  [PLACEMENT_REASON.EARLIER_SLOT]: '安排在当日较早的可用时间，使安排更紧凑',
  [PLACEMENT_REASON.URGENT_DEADLINE]: '截止时间临近',
  [PLACEMENT_REASON.HIGH_PRIORITY]: '优先级评分较高',
  [PLACEMENT_REASON.SPILLOVER]: '本日容量不足，顺延到后续日期',
  [PLACEMENT_REASON.UNDERSIZED_FINAL]: '这是该任务最后的收尾片段（短于最短时段）',
});

/**
 * 逐日放位。
 *
 * @param {object} params
 * @param {Array<object>} params.days 容量计算结果（engine/capacity.js 的 computeWindowCapacity 输出）
 * @param {Map<string, Array<object>>} params.fragmentsByTask 任务 ID → 待放置片段队列（会按顺序消耗）
 * @param {Map<string, object>} params.taskById
 * @param {Map<string, object>} params.scoreByTask 任务 ID → priority.js 的评分结果
 * @param {object} params.policy
 * @param {(kind: string, date: string, startMinutes: number, index: number) => string} params.makeId 确定性 ID 生成器
 * @returns {{placements: Array, skippedFragments: Array, dayUsage: Map<string, object>, diagnostics: Array}}
 */
export function placeFragments({ days, fragmentsByTask, taskById, scoreByTask, policy, makeId }) {
  const placements = [];
  const skippedFragments = [];
  const diagnostics = [];
  const dayUsage = new Map();
  let idCounter = 0;
  const nextId = (kind, date, startMinutes) => makeId(kind, date, startMinutes, (idCounter += 1));

  // 片段队列在工作副本上消耗：放完一段就出队，因此任务完成后不会再产生新的片段。
  // （早期版本忘了出队，导致同一个片段在七天里被反复排入——这类缺陷由引擎测试锁定。）
  const queues = new Map([...fragmentsByTask].map(([taskId, list]) => [taskId, [...list]]));

  /**
   * 任务截止时间的绝对分钟数（date*1440 + 当日分钟）。
   *
   * 为什么必须在这里算：放置阶段以前**完全不看截止时间**，
   * 于是截止 13:00 的任务可能被排到 16:00，而计划仍然被当成"成功"。
   * 这是"截断时间只显示在界面上、没有参与计算"的直接后果。
   */
  const deadlineByTask = new Map();
  for (const [taskId, task] of taskById) {
    const minutes = parseTimeOrNull(task?.deadlineTime);
    if (task?.deadlineDate && minutes !== null) {
      deadlineByTask.set(taskId, absoluteMinutes({ date: task.deadlineDate, minutes }));
    }
  }

  for (const day of days) {
    const usage = createDayUsage(day);
    dayUsage.set(day.date, usage);

    /** 当日已经放下的块（学习 + 休息）。每次放置后重新计算空闲区间，
     *  保证"后放的块一定避开先放的块"——只维护一个 freeWindows 变量迟早会漏掉某条路径。 */
    const busy = [];
    let remainingSchedulable = day.schedulableMinutes;
    let lastSubject = null;
    let lastEndMinutes = null;
    const subjectLastEnd = new Map();
    /** 距上一次休息的连续学习分钟数（用于按"每连续学习 N 分钟"插入休息） */
    let continuousStudyMinutes = 0;

    const freeWindowsNow = () => subtractFromDay(day, busy);

    // 依赖门控：只有当前置任务的所有片段都放完，后继任务的片段才进入候选。
    // 重新计算时机放在"每次成功放置之后"，因此同一天内也能保持"前置先做、后继后做"的顺序。
    let fragments = collectDayFragments(queues, taskById, scoreByTask, placements);

    for (const fragment of fragments) {
      if (fragment.minutes <= 0) continue;
      if (remainingSchedulable < fragment.minutes) continue; // 当日可排额度用尽，留给后续日期
      if (usage.sessionCount >= policy.maxSessionsPerDay) {
        diagnostics.push({
          code: 'daily_cap_reached',
          date: day.date,
          message: `${day.date} 已达到每日片段数上限（${policy.maxSessionsPerDay} 段），剩余任务顺延到之后日期。`,
        });
        break;
      }

      const taskForSlot = taskById.get(fragment.taskId);
      const freeWindows = constrainByDeadline(
        freeWindowsNow(),
        day.date,
        deadlineByTask.get(fragment.taskId),
        taskForSlot,
      );
      if (freeWindows.length === 0) continue; // 这一天已经没有早于截止时间的空档

      const slot = chooseSlot({
        freeWindows,
        fragment,
        task: taskForSlot,
        policy,
        lastSubject,
        lastEndMinutes,
        subjectLastEnd,
      });

      if (!slot) continue; // 当日暂时放不下，留给后续日期（不删除队列）

      const endMinutes = slot.startMinutes + fragment.minutes;
      const task = taskById.get(fragment.taskId);
      const reasons = buildReasons({
        slot,
        fragment,
        task,
        score: scoreByTask.get(fragment.taskId),
        lastSubject,
        lastEndMinutes,
        policy,
      });

      // —— 消耗这一片段与当日额度 ——
      placements.push({
        id: nextId('study', day.date, slot.startMinutes),
        kind: 'study',
        taskId: fragment.taskId,
        subject: task?.subject ?? null,
        label: task?.title ?? '学习时段',
        date: day.date,
        startMinutes: slot.startMinutes,
        endMinutes,
        plannedMinutes: fragment.minutes,
        fragmentIndex: fragment.index,
        undersized: fragment.undersized,
        reasons,
      });
      queues.set(fragment.taskId, (queues.get(fragment.taskId) ?? []).slice(1));
      busy.push({ startMinutes: slot.startMinutes, endMinutes });
      remainingSchedulable -= fragment.minutes;
      usage.studyMinutes += fragment.minutes;
      usage.sessionCount += 1;
      usage.taskMinutes.set(fragment.taskId, (usage.taskMinutes.get(fragment.taskId) ?? 0) + fragment.minutes);

      lastSubject = task?.subject ?? null;
      lastEndMinutes = endMinutes;
      if (task?.subject) subjectLastEnd.set(task.subject, endMinutes);
      continuousStudyMinutes += fragment.minutes;

      // 放置成功后重新计算候选集合：本任务的后继可能因此获得资格，其它任务的顺序也可能变化
      fragments = collectDayFragments(queues, taskById, scoreByTask, placements);

      // —— 按"每连续学习 N 分钟"插入计划休息（实际占用时间轴，与缓冲无关）——
      if (continuousStudyMinutes >= policy.restAfterContinuousMinutes && policy.restMinutes > 0) {
        if (remainingSchedulable - policy.restMinutes >= 0) {
          const restSlot = findRestSlot(freeWindowsNow(), endMinutes, policy.restMinutes);
          if (restSlot) {
            placements.push({
              id: nextId('rest', day.date, restSlot.startMinutes),
              kind: 'rest',
              date: day.date,
              startMinutes: restSlot.startMinutes,
              endMinutes: restSlot.endMinutes,
              plannedMinutes: restSlot.endMinutes - restSlot.startMinutes,
              reasons: ['rest_after_continuous_study'],
            });
            busy.push({ startMinutes: restSlot.startMinutes, endMinutes: restSlot.endMinutes });
            remainingSchedulable -= restSlot.endMinutes - restSlot.startMinutes;
            usage.restMinutes += restSlot.endMinutes - restSlot.startMinutes;
            lastEndMinutes = restSlot.endMinutes;
          }
        }
        continuousStudyMinutes = 0; // 无论休息是否真的插入，连续学习计数都重新开始
      }
    }

    usage.remainingSchedulable = remainingSchedulable;
  }

  return { placements, skippedFragments, dayUsage, diagnostics };
}

/**
 * 在"当日空闲区间"上挖掉已经放下的块。
 *
 * 每次放置后都重新计算，而不是维护一个可变的 freeWindows：
 * 后者在"放置 → 插入休息 → 继续放置"这类多路径流程里极易漏掉更新，从而产生重叠。
 */
function subtractFromDay(day, busy) {
  return subtractSpans(
    day.freeWindows.map((window) => ({ ...window })),
    busy.map((block) => ({ startMinutes: block.startMinutes, endMinutes: block.endMinutes })).sort((a, b) => a.startMinutes - b.startMinutes),
  );
}

/**
 * 收集当日待放置的片段。
 *
 * 排序键：**依赖链深度 → 截止时间 → 优先级 → 任务 ID**。
 * 依赖链深度放在最前面是硬性要求：前置任务必须先被安排，后继任务才可能满足 H7。
 * 在深度相同的情况下才按截止时间与评分排序，保证"紧急任务先占位"。
 */
function collectDayFragments(fragmentsByTask, taskById, scoreByTask, alreadyPlaced = []) {
  const entries = [];
  for (const [taskId, queue] of fragmentsByTask) {
    const fragment = queue[0];
    if (!fragment || fragment.minutes <= 0) continue;
    const task = taskById.get(taskId);
    if (!task) continue;
    if (!dependenciesSatisfied(task, fragmentsByTask, alreadyPlaced)) continue;
    entries.push({ ...fragment, task, depth: dependencyDepth(task, taskById, new Set()) });
  }

  entries.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const deadlineA = `${a.task.deadlineDate}T${a.task.deadlineTime}`;
    const deadlineB = `${b.task.deadlineDate}T${b.task.deadlineTime}`;
    if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
    const scoreA = scoreByTask.get(a.task.id)?.priority ?? 0;
    const scoreB = scoreByTask.get(b.task.id)?.priority ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
  });

  return entries;
}

/** 依赖链深度（无依赖为 0）。深度越小越先安排，保证前后顺序 */
function dependencyDepth(task, taskById, seen) {
  if (seen.has(task.id)) return 0; // 防御：环已在输入校验阶段被拒绝
  seen.add(task.id);
  let depth = 0;
  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = taskById.get(dependencyId);
    if (!dependency || dependency.status === 'completed') continue;
    depth = Math.max(depth, 1 + dependencyDepth(dependency, taskById, seen));
  }
  return depth;
}

/**
 * 前置条件是否已满足：所有未完成的前置任务都已经**全部**放完。
 * 已完成的前置任务不构成时间上的先后要求。
 */
function dependenciesSatisfied(task, queues, alreadyPlaced) {
  for (const dependencyId of task.dependsOn ?? []) {
    const dependencyQueue = queues.get(dependencyId);
    if (dependencyQueue && dependencyQueue.length > 0) return false; // 前置还有片段没放
    if (!alreadyPlaced.some((entry) => entry.taskId === dependencyId)) {
      // 前置任务不在本次排程集合里（已完成 / 被取消 / 排不下），由调度器的依赖门控单独处理
      continue;
    }
  }
  return true;
}

/** 在候选槽里挑选一个：先过滤合法，再按评分与字典序裁决 */
function chooseSlot({ freeWindows, fragment, task, policy, lastSubject, lastEndMinutes, subjectLastEnd }) {
  let candidates = slotsFitting(freeWindows, fragment.minutes);
  if (candidates.length === 0) return null;

  /**
   * 任务的「计划开始时间」（可选）。
   *
   * 语义（本轮修正）：它是**该任务的时间下界**——不允许排在这个时间之前。
   *
   * 以前这里写的是"如果过滤后没有候选，就退回未过滤的候选"，
   * 结果是：用户填了 15:30，系统照样把它排到 14:00，而且不告诉用户——
   * 这正是"填了计划开始时间却仍然按默认整点安排"的真实原因。
   *
   * 现在：
   * - 它只是**这个任务**的下界，不改变任务之间的优先级顺序（scoreTask 完全不看它）；
   * - 如果这个下界之后确实没有可用时段，就不安排（交给上层给出明确原因），
   *   绝不静默忽略用户设置、也绝不排到用户指定的时间之前。
   */
  const preferredStart = Number.isInteger(task?.plannedStartMinutes) ? task.plannedStartMinutes : null;
  if (preferredStart !== null) {
    // slotsFitting 返回的是"整段空闲区间"，因此要把区间**从下界开始裁剪**，
    // 而不是按区间起点过滤（那样会把 09:00–23:00 这样的整段直接丢掉）。
    candidates = candidates
      .map((slot) => ({
        ...slot,
        startMinutes: Math.max(slot.startMinutes, preferredStart),
        length: slot.endMinutes - Math.max(slot.startMinutes, preferredStart),
      }))
      .filter((slot) => slot.length >= fragment.minutes);

    if (candidates.length === 0) return null;
  }

  const scored = candidates.map((slot) => {
    // 片段从空闲区间的**最早时刻**开始：让安排尽量紧凑，避免留下无法利用的碎片
    const startMinutes = slot.startMinutes;
    const endMinutes = startMinutes + fragment.minutes;
    return {
      startMinutes,
      endMinutes,
      score: scoreSlot({
        startMinutes,
        endMinutes,
        slot,
        fragment,
        task,
        policy,
        lastSubject,
        lastEndMinutes,
        subjectLastEnd,
      }),
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return 0;
  });

  return scored[0];
}

/**
 * 槽位评分（分值越大越优先）。
 *
 * 这是一个**软偏好**函数，只在合法槽之间做取舍：
 * - 偏好专注时段重叠越多越好（+1000 封顶的权重，确保它优先于其它因素）
 * - 与同科目上一段相邻（间隔 ≤ 科目切换惩罚）加分，鼓励连续学习同一科目
 * - 槽位长度越贴合片段长度越好（减少无法利用的碎片）
 * - 当日越早越好（让安排紧凑）
 * - 切换科目扣分
 * - 距截止越远越不优先（让临近截止的任务更早完成）
 */
function scoreSlot({ startMinutes, endMinutes, slot, fragment, task, policy, lastSubject, lastEndMinutes, subjectLastEnd }) {
  const weights = policy.placementScore;
  let score = 0;

  const preferred = preferredOverlapMinutes(startMinutes, endMinutes, policy.preferredFocusWindows);
  if (preferred > 0) score += weights.preferredWindow * Math.min(1, preferred / fragment.minutes);

  const slack = slot.length - fragment.minutes;

  if (task?.subject && lastSubject === task.subject && lastEndMinutes !== null) {
    const gap = startMinutes - lastEndMinutes;
    if (gap <= policy.subjectSwitchPenaltyMinutes) score += weights.sameSubjectContinuity;
  } else {
    const subjectEnd = subjectLastEnd?.get?.(task?.subject);
    if (subjectEnd !== undefined && startMinutes - subjectEnd <= policy.subjectSwitchPenaltyMinutes) {
      score += weights.sameSubjectContinuity * 0.5;
    }
    if (lastSubject && task?.subject && lastSubject !== task.subject) {
      score += weights.subjectSwitchPenalty; // 负分
    }
  }

  score += weights.slotFit * (1 / (1 + slack));
  score += weights.earlierSlot * (1 / (1 + startMinutes / 60));

  return Math.round(score * 1000) / 1000;
}

/**
 * 按截止时间裁剪当天的空闲区间。
 *
 * 规则：**任何学习片段都不得晚于截止时间结束**。
 * 一旦当天剩下的空档都在截止时间之后，这里直接返回空数组，
 * 该片段就会去找更早的日期/时段；如果整个窗口都放不下，
 * 上层会把它列入"未能安排"并给出原因——而不是排到截止之后还声称成功。
 *
 * 截止时间在同一天时按当日分钟裁剪；在之后的日期则整天空档都有效。
 */
function constrainByDeadline(freeWindows, date, deadlineAbsolute, task) {
  if (!Number.isInteger(deadlineAbsolute)) return freeWindows;
  const dayStartAbsolute = absoluteMinutes({ date, minutes: 0 });
  const dayEndAbsolute = dayStartAbsolute + 1440;
  if (deadlineAbsolute >= dayEndAbsolute) return freeWindows; // 截止在更晚的日期，当天不限制

  const latestMinute = deadlineAbsolute - dayStartAbsolute; // 当天最晚可结束时刻
  if (latestMinute <= 0) return []; // 截止时间早于这一天，整天不可用

  const clipped = [];
  for (const window of freeWindows) {
    const end = Math.min(window.endMinutes, latestMinute);
    if (end <= window.startMinutes) continue;
    clipped.push({ ...window, endMinutes: end });
  }
  return clipped;
}

/** 解析 HH:mm，非法时返回 null（不抛异常：脏数据只应降低约束，不应炸掉排程） */
function parseTimeOrNull(value) {
  try {
    return parseTimeString(value);
  } catch {
    return null;
  }
}

/** 生成放位原因码（用于差异预览的中文说明） */
function buildReasons({ slot, fragment, task, score, lastSubject, lastEndMinutes, policy }) {
  const reasons = [];
  if (preferredOverlapMinutes(slot.startMinutes, slot.startMinutes + fragment.minutes, policy.preferredFocusWindows) > 0) {
    reasons.push(PLACEMENT_REASON.PREFERRED_WINDOW);
  }
  if (task?.subject && lastSubject === task.subject && lastEndMinutes !== null && slot.startMinutes - lastEndMinutes <= policy.subjectSwitchPenaltyMinutes) {
    reasons.push(PLACEMENT_REASON.SAME_SUBJECT_CONTINUITY);
  }
  if (slot.length - fragment.minutes <= 10) reasons.push(PLACEMENT_REASON.SLOT_FIT);
  if (slot.startMinutes < 12 * 60) reasons.push(PLACEMENT_REASON.EARLIER_SLOT);
  if (fragment.undersized) reasons.push(PLACEMENT_REASON.UNDERSIZED_FINAL);
  if (score && score.parts?.deadlineUrgency >= 70) reasons.push(PLACEMENT_REASON.URGENT_DEADLINE);
  if (score && score.priority >= 60) reasons.push(PLACEMENT_REASON.HIGH_PRIORITY);
  return reasons;
}

/** 在已放置片段的结束时刻之后寻找休息区间（允许稍微推迟以避开占用） */
function findRestSlot(freeWindows, fromMinutes, restMinutes) {
  for (const window of freeWindows) {
    if (window.endMinutes - window.startMinutes < restMinutes) continue;
    const start = Math.max(fromMinutes, window.startMinutes);
    if (start + restMinutes <= window.endMinutes) {
      return { startMinutes: start, endMinutes: start + restMinutes };
    }
  }
  return null;
}

function createDayUsage(day) {
  return {
    date: day.date,
    studyMinutes: 0,
    restMinutes: 0,
    sessionCount: 0,
    taskMinutes: new Map(),
    remainingSchedulable: day.schedulableMinutes,
  };
}
