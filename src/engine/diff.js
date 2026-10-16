/**
 * 计划差异（Diff）：把"候选计划"与"正式计划"的差别整理成用户可以逐条检查的清单。
 *
 * 这是产品的核心交互的数据来源，因此要求：
 * - **完整**：新增、移动、缩短/延长、拆分、取消、保持不变、锁定时段影响、每日指标变化都要有。
 * - **可解释**：每一项都带原因（来自放位原因码或明确的系统说明），不能只给一个红绿标记。
 * - **稳定**：同一对计划输入必然得到同一份差异（排序键固定），便于测试断言与界面 diff。
 * - **不撒谎**：受保护的时段（已完成 / 锁定 / 进行中）绝不出现在"取消"或"移动"里，
 *   如果候选计划真的动了它们，会进入 violations 由硬约束校验器拦截。
 */

import { PLACEMENT_REASON_TEXT } from './placer.js';
import { BLOCK_KIND } from '../domain/calendarBlock.js';
import { addDays, formatMinutes } from '../domain/time.js';

/** 差异条目中给出的调整原因文案 */
export const DIFF_REASON_TEXT = Object.freeze({
  new_task: '你新增了任务，需要为它分配学习时段',
  deadline_changed: '截止时间发生变化，重新安排了优先级',
  rescheduled: '重新规划后位置发生调整',
  capacity_changed: '可用时间发生变化，重新计算了容量',
  split: '把一个较长时段拆成多段以便安排',
  shortened: '为其它任务腾出时间，缩短了本段',
  extended: '合并了相邻余量，延长了本段',
  cancelled: '本次安排中不再需要该时段',
  superseded: '被新的安排取代',
  unchanged_locked: '该时段已锁定，保持不变',
  unchanged_completed: '该时段已完成，保持不变',
  unchanged: '本次调整未影响该时段',
  moved_to_next_day: '本日容量不足，顺延到之后日期',
});

/**
 * 计算两份计划的差异。
 *
 * @param {object|null} basePlan 正式计划（可为 null，表示首次生成）
 * @param {object} candidatePlan 候选计划
 * @param {object} [options]
 * @param {Map<string, object>} [options.taskById]
 * @returns {object} 差异结构（结构见 PROJECT_SPEC 与 ARCHITECTURE）
 */
export function diffPlans(basePlan, candidatePlan, { taskById = new Map() } = {}) {
  const baseBlocks = sortBlocks((basePlan?.blocks ?? []).filter((block) => block.kind === BLOCK_KIND.STUDY));
  const candidateBlocks = sortBlocks((candidatePlan?.blocks ?? []).filter((block) => block.kind === BLOCK_KIND.STUDY));

  const baseById = new Map(baseBlocks.filter((block) => block.refId).map((block) => [block.refId, block]));
  const matchedBaseIds = new Set();

  const added = [];
  const moved = [];
  const resized = [];
  const split = [];
  const unchanged = [];
  const lockedImpact = [];
  const violations = [];

  const label = (taskId, fallback) => taskById.get(taskId)?.title ?? fallback ?? taskId ?? '学习时段';

  // 第一轮：按 sessionId 精确匹配
  const unmatchedCandidates = [];
  for (const block of candidateBlocks) {
    const base = block.refId ? baseById.get(block.refId) : null;
    if (!base) {
      unmatchedCandidates.push(block);
      continue;
    }
    matchedBaseIds.add(base.refId);
    const baseTask = taskById.get(base.taskId);
    const protectedBase = isProtected(base, baseTask);

    const sameTime = base.date === block.date && base.startMinutes === block.startMinutes && base.endMinutes === block.endMinutes;
    const sameLength = base.endMinutes - base.startMinutes === block.endMinutes - block.startMinutes;

    if (sameTime) {
      unchanged.push(describe('unchanged', block, base, taskById, protectedBase));
      continue;
    }
    if (sameLength) {
      moved.push({
        kind: 'moved',
        sessionId: block.refId,
        taskId: block.taskId,
        taskTitle: label(block.taskId),
        from: { date: base.date, startMinutes: base.startMinutes, endMinutes: base.endMinutes },
        to: { date: block.date, startMinutes: block.startMinutes, endMinutes: block.endMinutes },
        reasons: reasonsFor(block, base, 'rescheduled'),
      });
      if (protectedBase) {
        lockedImpact.push({
          kind: 'locked_impact',
          sessionId: block.refId,
          impact: 'moved',
          message: `锁定时段「${label(block.taskId)}」的位置发生了变化：${base.date} ${formatMinutes(base.startMinutes)} → ${block.date} ${formatMinutes(block.startMinutes)}。锁定是硬约束，正常情况下不应发生。`,
        });
        violations.push({ code: 'locked_moved', sessionId: block.refId });
      }
      continue;
    }
    resized.push({
      kind: 'resized',
      sessionId: block.refId,
      taskId: block.taskId,
      taskTitle: label(block.taskId),
      date: block.date,
      fromMinutes: base.endMinutes - base.startMinutes,
      toMinutes: block.endMinutes - block.startMinutes,
      from: { startMinutes: base.startMinutes, endMinutes: base.endMinutes },
      to: { startMinutes: block.startMinutes, endMinutes: block.endMinutes },
      reasons: [block.endMinutes - block.startMinutes < base.endMinutes - base.startMinutes ? DIFF_REASON_TEXT.shortened : DIFF_REASON_TEXT.extended],
    });
    if (protectedBase) {
      lockedImpact.push({
        kind: 'locked_impact',
        sessionId: block.refId,
        impact: 'resized',
        message: `锁定时段「${label(block.taskId)}」的时长发生了变化（${base.endMinutes - base.startMinutes} → ${block.endMinutes - block.startMinutes} 分钟）。`,
      });
      violations.push({ code: 'locked_resized', sessionId: block.refId });
    }
  }

  // 第二轮：识别"拆分"——同一任务、尚未匹配的基础时段，其总时长等于若干新片段的合计
  const remainingBase = baseBlocks.filter((block) => block.refId && !matchedBaseIds.has(block.refId));
  const stillUnmatched = [];
  for (const block of unmatchedCandidates) {
    if (block.refId) {
      stillUnmatched.push(block);
      continue;
    }
    const length = block.endMinutes - block.startMinutes;
    const source = remainingBase.find(
      (base) =>
        base.taskId === block.taskId &&
        !matchedBaseIds.has(base.refId) &&
        (base.endMinutes - base.startMinutes === length || canGroupInto(base, unmatchedCandidates, block)),
    );
    if (source && baseBlocksFor(unmatchedCandidates, source).length > 1) {
      const groups = baseBlocksFor(unmatchedCandidates, source);
      for (const item of groups) matchedBaseIds.add(source.refId);
      // 记录一次拆分（同一 source 只记一条）
      if (!split.some((entry) => entry.sourceSessionId === source.refId)) {
        split.push({
          kind: 'split',
          sourceSessionId: source.refId,
          taskId: source.taskId,
          taskTitle: label(source.taskId),
          fromMinutes: source.endMinutes - source.startMinutes,
          into: groups.map((item) => ({
            id: item.id,
            date: item.date,
            startMinutes: item.startMinutes,
            endMinutes: item.endMinutes,
            minutes: item.endMinutes - item.startMinutes,
          })),
          reasons: [DIFF_REASON_TEXT.split],
        });
      }
      continue;
    }
    stillUnmatched.push(block);
  }

  for (const block of stillUnmatched) {
    added.push({
      kind: 'added',
      id: block.id,
      sessionId: block.refId ?? null,
      taskId: block.taskId,
      taskTitle: label(block.taskId),
      date: block.date,
      startMinutes: block.startMinutes,
      endMinutes: block.endMinutes,
      minutes: block.endMinutes - block.startMinutes,
      reasons: reasonsFor(block, null, 'new_task'),
    });
  }

  // 第三轮：剩下的基础时段就是被取消的
  const cancelled = [];
  for (const base of remainingBase) {
    if (matchedBaseIds.has(base.refId)) continue;
    const task = taskById.get(base.taskId);
    const protectedBase = isProtected(base, task);
    if (protectedBase) {
      // 受保护时段不可能被取消：这属于硬约束违规，交给校验器处理并在此明确记录
      violations.push({ code: 'protected_cancelled', sessionId: base.refId });
      lockedImpact.push({
        kind: 'locked_impact',
        sessionId: base.refId,
        impact: 'cancelled',
        message: `${task?.status === 'completed' ? '已完成' : '已锁定'}的时段「${label(base.taskId)}」（${base.date} ${formatMinutes(base.startMinutes)}–${formatMinutes(base.endMinutes)}）在候选计划中消失了，这违反了硬约束。`,
      });
      continue;
    }
    cancelled.push({
      kind: 'cancelled',
      sessionId: base.refId,
      taskId: base.taskId,
      taskTitle: label(base.taskId),
      from: { date: base.date, startMinutes: base.startMinutes, endMinutes: base.endMinutes },
      minutes: base.endMinutes - base.startMinutes,
      reasons: [DIFF_REASON_TEXT.cancelled],
    });
  }

  // 受保护时段如果原样保留，也要明确列出来（用户需要知道"哪些没被动过"）
  for (const base of baseBlocks) {
    if (!base.refId) continue;
    const task = taskById.get(base.taskId);
    if (!isProtected(base, task)) continue;
    if (lockedImpact.some((entry) => entry.sessionId === base.refId)) continue;
    lockedImpact.push({
      kind: 'locked_impact',
      sessionId: base.refId,
      impact: 'untouched',
      message:
        task?.status === 'completed'
          ? `已完成时段「${label(base.taskId)}」（${base.date} ${formatMinutes(base.startMinutes)}–${formatMinutes(base.endMinutes)}）保持不变。`
          : `锁定时段「${label(base.taskId)}」（${base.date} ${formatMinutes(base.startMinutes)}–${formatMinutes(base.endMinutes)}）保持不变，自动规划没有移动它。`,
    });
  }

  return {
    added,
    moved,
    resized,
    split,
    cancelled,
    unchanged,
    lockedImpact,
    dailyDelta: computeDailyDelta(basePlan, candidatePlan),
    statusBefore: basePlan?.status ?? null,
    statusAfter: candidatePlan?.status ?? null,
    feasibleAfter: candidatePlan?.status === 'feasible',
    unscheduledAfter: candidatePlan?.unscheduled ?? [],
    counts: {
      added: added.length,
      moved: moved.length,
      resized: resized.length,
      split: split.length,
      cancelled: cancelled.length,
      unchanged: unchanged.length,
    },
    violations,
  };
}

/** 每日学习量 / 休息 / 缓冲的变化（候选 − 正式） */
export function computeDailyDelta(basePlan, candidatePlan) {
  const dates = new Set([
    ...(basePlan?.days ?? []).map((day) => day.date),
    ...(candidatePlan?.days ?? []).map((day) => day.date),
  ]);
  const baseByDate = new Map((basePlan?.days ?? []).map((day) => [day.date, day]));
  const candidateByDate = new Map((candidatePlan?.days ?? []).map((day) => [day.date, day]));

  return [...dates]
    .sort()
    .map((date) => {
      const before = baseByDate.get(date) ?? { studyMinutes: 0, restMinutes: 0, bufferMinutes: 0, sessionCount: 0 };
      const after = candidateByDate.get(date) ?? { studyMinutes: 0, restMinutes: 0, bufferMinutes: 0, sessionCount: 0 };
      return {
        date,
        studyBefore: before.studyMinutes,
        studyAfter: after.studyMinutes,
        studyDelta: after.studyMinutes - before.studyMinutes,
        restBefore: before.restMinutes,
        restAfter: after.restMinutes,
        restDelta: after.restMinutes - before.restMinutes,
        bufferBefore: before.bufferMinutes,
        bufferAfter: after.bufferMinutes,
        bufferDelta: after.bufferMinutes - before.bufferMinutes,
        sessionDelta: (after.sessionCount ?? 0) - (before.sessionCount ?? 0),
      };
    })
    .filter(
      (entry) =>
        entry.studyDelta !== 0 || entry.restDelta !== 0 || entry.bufferDelta !== 0 || entry.sessionDelta !== 0,
    );
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function isProtected(block, task) {
  return Boolean(block.locked) || task?.status === 'completed' || block.meta?.state === 'completed' || block.meta?.state === 'in_progress';
}

function sortBlocks(blocks) {
  return [...blocks].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
  });
}

/** 把放位原因码翻译成中文说明；没有原因码时使用兜底说明 */
function reasonsFor(block, base, fallbackKey) {
  const codes = block.reasonCodes ?? block.reasons ?? [];
  const texts = codes.map((code) => PLACEMENT_REASON_TEXT[code]).filter(Boolean);
  if (texts.length > 0) return texts;
  return [DIFF_REASON_TEXT[fallbackKey] ?? '重新安排'];
}

function describe(kind, block, base, taskById, protectedBase) {
  return {
    kind,
    sessionId: block.refId,
    taskId: block.taskId,
    taskTitle: taskById.get(block.taskId)?.title ?? block.label,
    date: block.date,
    startMinutes: block.startMinutes,
    endMinutes: block.endMinutes,
    reasons: [
      taskById.get(block.taskId)?.status === 'completed'
        ? DIFF_REASON_TEXT.unchanged_completed
        : protectedBase
          ? DIFF_REASON_TEXT.unchanged_locked
          : DIFF_REASON_TEXT.unchanged,
    ],
    base: base ? { date: base.date, startMinutes: base.startMinutes, endMinutes: base.endMinutes } : null,
  };
}

/** 判断一组候选片段是否能合并回同一个源时段（用于识别"拆分"） */
function canGroupInto(source, candidates, firstBlock) {
  const sourceLength = source.endMinutes - source.startMinutes;
  const group = candidates.filter((item) => item.taskId === source.taskId || item.id === firstBlock.id);
  const total = group.reduce((sum, item) => sum + (item.endMinutes - item.startMinutes), 0);
  return group.length > 1 && total >= sourceLength;
}

/** 取某个源时段对应的候选片段集合（按日期与开始时间排序） */
function baseBlocksFor(candidates, source) {
  return candidates
    .filter((item) => item.taskId === source.taskId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMinutes - b.startMinutes));
}

export { addDays };
