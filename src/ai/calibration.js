/**
 * 「AI 个人时间校准」的**统计层**（纯函数，不含 AI）。
 *
 * 这个文件的存在本身就是需求的一部分：
 *
 *   统计实际用时、计算历史平均、判断"是否经常被低估"——全部由**程序**完成；
 *   AI 只负责"把这些数字翻译成学生能理解的话"。
 *
 * 为什么必须这样分：
 * - 统计是可验证的现在式（样本数、均值、偏差），错一个数字就会误导学生；
 *   让模型去"看一眼原始记录然后心算平均"是典型的会成为黑箱的做法。
 * - 反过来，"为什么数学总是超时"这种解释需要理解任务语义，那是 AI 的强项。
 *
 * 分层边界：
 *   calibrateStats()  → 程序产出的数字（本文件）
 *   explainCalibration()（services 层）→ 交给 AI 解释
 */

import { SESSION_STATE } from '../domain/session.js';
import { TASK_STATUS, claimedPriorMinutes } from '../domain/task.js';

/** 样本最少条数：1–2 条不构成"规律"，不做任何结论 */
export const MIN_SAMPLES = 3;

/** 参与统计的最近任务数量上限（越久远的数据越不能代表现在的状态） */
export const MAX_SAMPLE_TASKS = 20;

/** 偏差超过该比例才算"被低估/高估"，否则视为正常波动 */
export const NOISE_THRESHOLD = 0.15;

/**
 * 从状态里提取"实际用时 vs 预计用时"的样本。
 *
 * 一个任务算一条样本，规则：
 * - 只看**已完成**的任务（未完成的没有真实总用时，拿剩余时间去比毫无意义）；
 * - 实际用时 = 所有已完成时段实际时长之和 + 用户在任务里手工填的"已完成"分钟；
 * - 预计用时 = task.plannedMinutes；
 * - 缺失实际记录的（actualMinutes 为空）用计划时长兜底——这与
 *   domain/task.js 的 completedMinutesForTask 口径完全一致，不另立一套。
 *
 * @param {object} state 应用状态
 * @returns {Array<{subject, title, plannedMinutes, actualMinutes, ratio}>}
 */
export function collectSamples(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];

  const completedByTask = new Map();
  for (const session of sessions) {
    if (!session || session.state !== SESSION_STATE.COMPLETED) continue;
    const minutes = session.actualMinutes ?? session.plannedMinutes ?? 0;
    completedByTask.set(session.taskId, (completedByTask.get(session.taskId) ?? 0) + minutes);
  }

  const samples = [];
  for (const task of tasks) {
    if (task.status !== TASK_STATUS.COMPLETED) continue;
    const planned = Number(task.plannedMinutes);
    if (!Number.isFinite(planned) || planned <= 0) continue;

    const actual = (completedByTask.get(task.id) ?? 0) + claimedPriorMinutes(task);
    if (actual <= 0) continue; // 有任务但没有任何用时记录：不猜，直接跳过

    samples.push({
      subject: String(task.subject ?? '').trim(),
      title: task.title,
      plannedMinutes: planned,
      actualMinutes: actual,
      ratio: actual / planned,
    });
  }
  return samples;
}

/**
 * 按科目聚合，算出"这一类功课是否经常被低估"。**全部由程序计算。**
 *
 * @param {Array<object>} samples collectSamples 的输出
 * @returns {{subjects: object[], summary: object}}
 */
export function calibrateStats(samples) {
  const bySubject = new Map();
  for (const sample of samples.slice(-MAX_SAMPLE_TASKS)) {
    if (!sample.subject) continue;
    if (!bySubject.has(sample.subject)) bySubject.set(sample.subject, []);
    bySubject.get(sample.subject).push(sample);
  }

  const subjects = [];
  for (const [subject, list] of bySubject) {
    const sumPlanned = list.reduce((sum, item) => sum + item.plannedMinutes, 0);
    const sumActual = list.reduce((sum, item) => sum + item.actualMinutes, 0);
    const meanRatio = sumActual / sumPlanned;

    let tendency = 'stable';
    if (meanRatio > 1 + NOISE_THRESHOLD) tendency = 'underestimated';
    else if (meanRatio < 1 - NOISE_THRESHOLD) tendency = 'overestimated';

    subjects.push({
      subject,
      sampleCount: list.length,
      meanPlannedMinutes: Math.round(sumPlanned / list.length),
      meanActualMinutes: Math.round(sumActual / list.length),
      meanRatio: Number(meanRatio.toFixed(3)),
      /** 正的分钟数 = 平均超出预计多少分钟 */
      meanDiffMinutes: Math.round(sumActual / list.length - sumPlanned / list.length),
      tendency,
      /** 样本不足时不建议任何调整（由调用方展示为"记录还不够"） */
      reliable: list.length >= MIN_SAMPLES,
      samples: list.map((item) => ({
        title: item.title,
        plannedMinutes: item.plannedMinutes,
        actualMinutes: item.actualMinutes,
      })),
    });
  }

  // 规律明显的排前面：先看最偏离的
  subjects.sort((a, b) => Math.abs(b.meanRatio - 1) - Math.abs(a.meanRatio - 1) || b.sampleCount - a.sampleCount);

  const reliable = subjects.filter((item) => item.reliable);
  return {
    subjects,
    summary: {
      totalSamples: samples.length,
      subjectsWithEnoughData: reliable.length,
      mostUnderestimated: reliable.find((item) => item.tendency === 'underestimated')?.subject ?? null,
    },
  };
}

/**
 * 为"新建任务"给出建议的预计用时（纯程序，不经过 AI）。
 *
 * 为什么需要纯程序版本：AI 可能不可用（没配置 key、网络问题、额度用完）。
 * 校准的核心价值是"数字更准"，这部分不能因为 AI 挂掉就完全失效。
 * AI 的解释是锦上添花，不是前提。
 *
 * @param {string} subject 科目
 * @param {number} plannedMinutes 学生填的预计用时
 * @param {object[]} subjectsStats calibrateStats().subjects
 * @returns {{adjusted: number, reason: string|null, ratio: number}|null} null = 不该调整
 */
export function suggestEstimate(subject, plannedMinutes, subjectsStats) {
  const stats = subjectsStats.find((item) => item.subject === subject);
  if (!stats || !stats.reliable) return null;
  if (stats.tendency === 'stable') return null;

  const adjusted = Math.max(5, Math.round((plannedMinutes * stats.meanRatio) / 5) * 5);
  if (adjusted === plannedMinutes) return null;

  return {
    adjusted,
    ratio: stats.meanRatio,
    reason:
      stats.tendency === 'underestimated'
        ? `「${subject}」最近 ${stats.sampleCount} 次实际用时平均比预计多 ${stats.meanDiffMinutes} 分钟`
        : `「${subject}」最近 ${stats.sampleCount} 次实际用时平均比预计少 ${Math.abs(stats.meanDiffMinutes)} 分钟`,
  };
}
