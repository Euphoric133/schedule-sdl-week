/**
 * 任务优先级评分。
 *
 * 公式（需求指定，权重可从设置调整）：
 *   P = w1 × 截止紧迫度 + w2 × 难度 + w3 × 重要程度 + w4 × 拖延风险
 *
 * 三条重要约定：
 * 1. 所有输入都是显式参数（含 `now`），因此每一个分值都可以被单元测试精确断言，
 *    引擎内部绝不读取系统时钟。
 * 2. 评分**只用于排序与放位偏好**，绝不参与硬约束判定。
 *    一个评分再高的任务，只要违反 H1–H10 就不能排。
 * 3. 评分相同的情况必须由任务 ID 兜底，保证"同一输入 → 同一计划"（确定性）。
 */

import { RATING_MAX, RATING_MIN } from '../domain/task.js';
import { absoluteMinutes } from '../domain/time.js';
import { POLICY_VERSION } from './policy.js';

/**
 * 截止紧迫度（0–100）。
 *
 * 定义：`clamp(0, 100, round(100 × (1 − hoursLeft / horizonHours)))`
 * - 已超期（hoursLeft ≤ 0）→ 100（最紧迫）
 * - 距截止还有整个评分窗口（默认 168 小时 = 7 天）以上 → 0
 *
 * @param {{deadlineDate: string, deadlineTime: string}} task
 * @param {{date: string, minutes: number}} now 墙上时间
 * @param {number} horizonHours 评分窗口（小时）
 */
export function deadlineUrgencyScore(task, now, horizonHours = 7 * 24) {
  const deadlineMinutes = absoluteMinutes({
    date: task.deadlineDate,
    minutes: toMinutesOfDay(task.deadlineTime),
  });
  const nowMinutes = absoluteMinutes({ date: now.date, minutes: now.minutes ?? 0 });
  const hoursLeft = (deadlineMinutes - nowMinutes) / 60;
  if (hoursLeft <= 0) return 100;
  if (hoursLeft >= horizonHours) return 0;
  const raw = 100 * (1 - hoursLeft / horizonHours);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** 1–5 级主观评分 → 0–100（1→0，3→50，5→100） */
export function ratingToScore(rating) {
  const value = Number(rating);
  const clamped = Number.isFinite(value) ? Math.min(RATING_MAX, Math.max(RATING_MIN, value)) : RATING_MIN;
  return ((clamped - RATING_MIN) / (RATING_MAX - RATING_MIN)) * 100;
}

/**
 * 计算任务的优先级分（连同中间分项，便于界面解释"为什么它排前面"）。
 *
 * @param {object} task
 * @param {object} params
 * @param {{date: string, minutes: number}} params.now
 * @param {object} params.policy 由 buildPolicy 生成
 * @param {number} [params.remainingMinutes] 剩余工作量（用于风险提示，不参与评分公式）
 * @returns {{priority: number, parts: object, formula: string}}
 */
export function scoreTask(task, { now, policy, remainingMinutes = null }) {
  const deadlineUrgency = deadlineUrgencyScore(task, now, policy.deadlineHorizonHours);
  const difficulty = ratingToScore(task.difficulty);
  const importance = ratingToScore(task.importance);
  const procrastination = ratingToScore(task.procrastination);
  const { weights } = policy;

  const priority =
    weights.deadlineUrgency * deadlineUrgency +
    weights.difficulty * difficulty +
    weights.importance * importance +
    weights.procrastination * procrastination;

  return {
    // 保留 4 位小数，避免浮点噪声导致"同分"判断不稳定
    priority: Math.round(priority * 10000) / 10000,
    parts: { deadlineUrgency, difficulty, importance, procrastination, remainingMinutes },
    formula: `P = ${weights.deadlineUrgency.toFixed(4)}×紧迫(${deadlineUrgency}) + ${weights.difficulty.toFixed(4)}×难度(${difficulty}) + ${weights.importance.toFixed(4)}×重要(${importance}) + ${weights.procrastination.toFixed(4)}×拖延(${procrastination})`,
    policyVersion: POLICY_VERSION,
  };
}

/**
 * 排程排序键（**复合、确定性**）。
 *
 * 顺序（越靠前越先被安排）：
 *   1. 截止日期早的优先（EDD，硬性保护：紧急且可完成的任务不能被高难度长任务挤掉）
 *   2. 截止时刻早的优先
 *   3. 优先级分高的优先
 *   4. 任务 ID 字典序（兜底，保证全序）
 *
 * 注意：这里**故意**让截止时间排在评分之前。需求要求"困难任务优先，但不得因此忽略更紧急
 * 且可完成的任务"，而评分里的紧迫度是按 7 天窗口线性折算的，单靠它无法保证 D-1 的任务
 * 一定压过 D-6 的高难度任务。用截止时间做第一主键是最直接、可测试、可解释的做法。
 *
 * @param {Array<{task: object, score: {priority: number}}>} entries
 * @returns {Array} 排好序的新数组
 */
export function sortBySchedulePriority(entries) {
  return [...entries].sort((a, b) => {
    const deadlineA = `${a.task.deadlineDate}T${a.task.deadlineTime}`;
    const deadlineB = `${b.task.deadlineDate}T${b.task.deadlineTime}`;
    if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
    if (a.score.priority !== b.score.priority) return b.score.priority - a.score.priority;
    return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
  });
}

/** 'HH:mm' → 当日分钟数（避免为了一个小转换引入时区逻辑） */
function toMinutesOfDay(time) {
  if (typeof time !== 'string') return 0;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}
