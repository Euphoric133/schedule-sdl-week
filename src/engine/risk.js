/**
 * 截止风险评估。
 *
 * 回答两个用户最关心的问题：
 * 1. 「按现在这份计划，这个任务能在截止前做完吗？」
 * 2. 「如果现在重新排，最早什么时候能做完？」（用于 30 天风险评估窗口）
 *
 * 实现方式：只读模拟——把任务的剩余工作量按"未来的可用容量"顺序填满，
 * 得到最早完成时刻（earliestCompletion）。**不修改任何数据**，也不做任何猜测式估算：
 * 其中用到的容量口径与主排程完全一致（都来自 engine/capacity.js），避免出现
 * "风险面板说来得及、计划却说排不下"这种自相矛盾的结论。
 */

import { RISK_LEVEL } from './policy.js';
import { computeWindowCapacity } from './capacity.js';
import { addDays, absoluteMinutes, formatMinutes, parseTimeString } from '../domain/time.js';

/**
 * 按剩余工作量模拟最早完成时刻。
 *
 * @param {object} params
 * @param {number} params.remainingMinutes 该任务的剩余工作量
 * @param {string} params.startDate 从哪一天开始找容量（含）
 * @param {number} params.horizonDays 最多往后看多少天
 * @param {Record<number, Array>} params.studyWindows
 * @param {Array} params.fixedSpans 已展开的固定活动片段（按天）
 * @param {Array} params.reservedSpans 保留时段（锁定/进行中/已完成，按天）
 * @param {number} [params.bufferRatio]
 * @returns {{date: string, minutes: number} | null} 最早完成时刻；horizon 内放不下时返回 null
 */
export function simulateEarliestCompletion({
  remainingMinutes,
  startDate,
  horizonDays,
  studyWindows,
  fixedSpans = [],
  reservedSpans = [],
  bufferRatio = 0.1,
}) {
  if (remainingMinutes <= 0) return null;

  const days = computeWindowCapacity({
    windowStart: startDate,
    windowEnd: addDays(startDate, Math.max(0, horizonDays - 1)),
    studyWindows,
    fixedSpans,
    reservedSpans,
    bufferRatio,
  });

  let left = remainingMinutes;
  for (const day of days) {
    // 只使用"扣除机动缓冲后"的可排额度（与主排程口径完全一致）。
    // 若这里直接用 freeWindows 的原始长度，风险面板会比实际计划更乐观，
    // 出现"面板说来得及、计划却排不下"的自相矛盾。
    let dayBudget = day.schedulableMinutes;
    for (const window of day.freeWindows) {
      if (dayBudget <= 0) break;
      const available = Math.min(window.endMinutes - window.startMinutes, dayBudget);
      if (available <= 0) continue;
      if (available >= left) {
        return { date: day.date, minutes: window.startMinutes + left };
      }
      left -= available;
      dayBudget -= available;
    }
  }
  return null;
}

/**
 * 评估单个任务的截止风险。
 *
 * @param {object} params
 * @param {object} params.task
 * @param {number} params.remainingMinutes
 * @param {object[]} params.taskBlocks 该任务在当前计划中的学习块（可为空）
 * @param {{date: string, minutes: number}} params.now
 * @param {object} params.policy
 * @param {object[]} params.capacityDays 未来容量（engine/capacity.js 输出）
 * @param {object} [params.dependencyRisk] 前置任务的风险（用于解释"为什么这个任务排不了"）
 * @returns {{level: string, plannedFinish: object|null, deadline: object, earliestCompletion: object|null, message: string, slackMinutes: number|null}}
 */
export function assessDeadlineRisk({ task, remainingMinutes, taskBlocks = [], now, policy, capacityDays = [], dependencyRisk = null }) {
  const deadline = { date: task.deadlineDate, minutes: toMinutesOfDay(task.deadlineTime) };

  if (remainingMinutes <= 0) {
    return {
      level: RISK_LEVEL.ON_TIME,
      plannedFinish: null,
      deadline,
      earliestCompletion: null,
      slackMinutes: null,
      message: '剩余工作量为 0，无需安排。',
    };
  }

  // 1) 当前计划里的实际完成时刻
  let plannedFinish = null;
  for (const block of taskBlocks) {
    const candidate = { date: block.date, minutes: block.endMinutes };
    if (!plannedFinish || absoluteMinutes(candidate) > absoluteMinutes(plannedFinish)) plannedFinish = candidate;
  }

  const deadlineAbs = absoluteMinutes(deadline);
  const nowAbs = absoluteMinutes({ date: now.date, minutes: now.minutes ?? 0 });

  // 2) 只读模拟：最早能在什么时候做完
  const earliestCompletion = simulateEarliestCompletion({
    remainingMinutes,
    startDate: now.date,
    horizonDays: policy.riskWindowDays,
    studyWindows: policy.studyWindows ?? {},
    fixedSpans: policy.fixedSpans ?? [],
    reservedSpans: policy.reservedSpans ?? [],
    bufferRatio: policy.bufferRatio,
  });

  const reference = plannedFinish ?? earliestCompletion;
  if (!reference) {
    return {
      level: RISK_LEVEL.IMPOSSIBLE,
      plannedFinish,
      deadline,
      earliestCompletion: null,
      slackMinutes: null,
      message:
        dependencyRisk && dependencyRisk.level !== RISK_LEVEL.ON_TIME
          ? `前置任务「${dependencyRisk.taskTitle}」本身存在风险，本任务暂时无法安排。`
          : `在接下来 ${policy.riskWindowDays} 天内找不到足够的可用时间，按当前可用时间无法完成。`,
    };
  }

  const referenceAbs = absoluteMinutes(reference);
  const slackMinutes = deadlineAbs - referenceAbs;

  if (deadlineAbs < nowAbs) {
    return {
      level: RISK_LEVEL.IMPOSSIBLE,
      plannedFinish,
      deadline,
      earliestCompletion,
      slackMinutes,
      message: `截止时间（${deadline.date} ${formatMinutes(deadline.minutes)}）已经过去，本次安排无法让它按时完成。`,
    };
  }

  if (slackMinutes < 0) {
    return {
      level: RISK_LEVEL.AT_RISK,
      plannedFinish,
      deadline,
      earliestCompletion,
      slackMinutes,
      message: `按当前容量最早也要到 ${reference.date} ${formatMinutes(reference.minutes)} 才能完成，比截止时间晚 ${formatSlack(-slackMinutes)}。`,
    };
  }

  // 富余时间不足总可用时间的 20% 视为"时间较紧"
  const totalAvailable = Math.max(1, deadlineAbs - nowAbs);
  const tight = slackMinutes < totalAvailable * 0.2;

  return {
    level: tight ? RISK_LEVEL.TIGHT : RISK_LEVEL.ON_TIME,
    plannedFinish,
    deadline,
    earliestCompletion,
    slackMinutes,
    message: tight
      ? `可以在截止前完成，但只剩 ${formatSlack(slackMinutes)} 的富余时间。`
      : `可以在截止前完成，预计还有 ${formatSlack(slackMinutes)} 富余。`,
  };
}

/**
 * 批量评估：为每一个未完成任务给出风险等级。
 *
 * @param {object} params
 * @param {object[]} params.tasks
 * @param {Map<string, number>} params.remainingByTask
 * @param {object[]} params.blocks 计划中的学习块
 * @param {{date: string, minutes: number}} params.now
 * @param {object} params.policy
 * @param {object[]} params.capacityDays
 * @returns {Array<object>} 按风险严重程度与截止时间排序
 */
export function assessAllRisks({ tasks, remainingByTask, blocks = [], now, policy, capacityDays = [] }) {
  const blocksByTask = new Map();
  for (const block of blocks) {
    if (block.kind !== 'study' || !block.taskId) continue;
    if (!blocksByTask.has(block.taskId)) blocksByTask.set(block.taskId, []);
    blocksByTask.get(block.taskId).push(block);
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const results = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'deleted') continue;
    const remainingMinutes = remainingByTask.get(task.id) ?? 0;

    // 前置任务的风险（用于解释被阻塞的任务）
    let dependencyRisk = null;
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = taskById.get(dependencyId);
      if (!dependency || dependency.status === 'completed') continue;
      dependencyRisk = { taskTitle: dependency.title, level: RISK_LEVEL.AT_RISK };
      break;
    }

    const risk = assessDeadlineRisk({
      task,
      remainingMinutes,
      taskBlocks: blocksByTask.get(task.id) ?? [],
      now,
      policy,
      capacityDays,
      dependencyRisk,
    });

    results.push({
      taskId: task.id,
      taskTitle: task.title,
      subject: task.subject,
      deadline: risk.deadline,
      remainingMinutes,
      level: risk.level,
      plannedFinish: risk.plannedFinish,
      earliestCompletion: risk.earliestCompletion,
      slackMinutes: risk.slackMinutes,
      message: risk.message,
      dependencyRisk,
    });
  }

  const order = { [RISK_LEVEL.IMPOSSIBLE]: 0, [RISK_LEVEL.AT_RISK]: 1, [RISK_LEVEL.TIGHT]: 2, [RISK_LEVEL.ON_TIME]: 3 };
  return results.sort((a, b) => {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    const deadlineA = `${a.deadline.date}T${String(a.deadline.minutes).padStart(4, '0')}`;
    const deadlineB = `${b.deadline.date}T${String(b.deadline.minutes).padStart(4, '0')}`;
    if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
    return a.taskId < b.taskId ? -1 : 1;
  });
}

function toMinutesOfDay(time) {
  if (typeof time !== 'string') return 0;
  try {
    return parseTimeString(time);
  } catch {
    return 0;
  }
}

/** 把分钟差转成人类可读的"富余时间" */
function formatSlack(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }
  if (hours === 0) return `${rest} 分钟`;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
