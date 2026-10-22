/**
 * AI 功能的服务层：把"AI 提议"与"程序校验"接起来。
 *
 * 两条完整链路：
 *
 *   计划急救：  学生描述情况 → AI 输出提议 → **程序校验** → 生成候选计划预览
 *                → 学生确认 → 才真正写入（复用现有的 requestPreview/applyPreview）
 *
 *   时间校准：  历史记录 → **程序统计** → AI 解释 → 学生选择是否采纳
 *                → 采纳时也只影响"新建任务"的建议，不自动改已有任务
 *
 * 铁律（与 planService 保持一致）：
 * - AI 的提议**永远不能直接写入**。所有改动都必须经过预览，由学生点确认。
 * - 提议必须先过 validateProposals 的独立校验，程序不替 AI"补全"意思。
 * - 校验失败时如实告诉学生哪一条不通过，而不是悄悄丢弃。
 */

import { validateProposals, proposalsToOps } from '../ai/proposals.js';
import { collectSamples, calibrateStats, suggestEstimate } from '../ai/calibration.js';
import { remainingMinutesForTask } from '../domain/task.js';
import { addDays, formatMinutes } from '../domain/time.js';

/**
 * @param {object} options
 * @param {object} options.app 应用状态容器
 * @param {object} options.planService 计划服务（用于生成预览）
 * @param {() => {date: string, minutes: number}} options.now
 */
export function createAiFeatureService({ app, planService, now }) {
  if (!app || typeof app.getState !== 'function') throw new TypeError('createAiFeatureService 需要 app');
  if (!planService || typeof planService.requestPreview !== 'function') {
    throw new TypeError('createAiFeatureService 需要 planService.requestPreview');
  }

  /**
   * 为"计划急救"准备 AI 需要的上下文，并同时保存校验所需的任务表。
   *
   * 返回的 taskById / remainingByTask 必须与送给 AI 的完全一致：
   * 否则会出现"AI 看到的是旧数据、程序校验用的是新数据"，建议莫名被拒。
   */
  function buildRescueInput() {
    const state = app.getState();
    const current = now();
    const tasks = (state.tasks ?? []).filter((task) => task.status === 'not_started' || task.status === 'in_progress');

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const remainingByTask = {};
    for (const task of tasks) {
      remainingByTask[task.id] = remainingMinutesForTask(task, state.sessions ?? []);
    }

    const latestSleepMinutes = state.settings?.latestSleepMinutes ?? null;
    return {
      today: current.date,
      /** 允许锁定的最晚日期 = 规划窗口末尾（7 天） */
      latestAllowedDate: addDays(current.date, 6),
      taskById,
      remainingByTask,
      context: {
        date: current.date,
        now: formatMinutes(current.minutes),
        latestSleepMinutes,
        latestSleepTime: Number.isInteger(latestSleepMinutes) ? formatMinutes(latestSleepMinutes) : null,
        /**
         * 每个任务带一个短编号 ref（1、2、3…）。
         *
         * 为什么需要它：实测 gemini-3.5-flash-lite 会把 task_math 抄成 t_math_01——
         * 模型不擅长逐字复制任意字符串 id，但引用小整数几乎不会错。
         * 因此让 AI 用 ref，程序再映射回真实 id（一一对应，不是猜测）。
         */
        tasks: tasks.slice(0, 8).map((task, index) => ({
          ref: index + 1,
          id: task.id,
          title: task.title,
          subject: task.subject,
          remainingMinutes: remainingByTask[task.id],
          deadline: `${task.deadlineDate} ${task.deadlineTime}`,
          importance: task.importance,
        })),
      },
    };
  }

  /**
   * 把 AI 返回的内容变成"待确认的调整"。
   *
   * 关键行为：
   * - 校验失败 → 返回失败与**具体哪一条不通过**，不生成任何预览；
   * - 校验通过 → 立刻生成候选计划预览（学生此时还没确认，正式计划零改动）。
   *
   * @param {object} aiResult { ok, reply, proposals? } 已解析的 AI 结果
   * @returns {{ok: boolean, stage: string, issues?: string[], previewResult?: object, proposals?: object[]}}
   */
  function prepareRescuePreview(aiResult) {
    if (!aiResult || aiResult.ok !== true) {
      return { ok: false, stage: 'ai_failed', issues: [aiResult?.message ?? 'AI 没有返回结果。'] };
    }

    const input = buildRescueInput();

    /**
     * 把 AI 给出的 ref 翻译成真实任务 id。
     *
     * 映射是**一对一**的（ref 就是列表序号），因此这不是"猜意图"：
     * ref 3 只能对应第 3 个任务。找不到对应 ref 的提议原样保留，
     * 交给 validateProposals 判定为"引用了不存在的任务"并拒绝。
     */
    const refToId = new Map();
    for (const item of input.context.tasks) refToId.set(String(item.ref), item.id);
    const normalized = (aiResult.proposals ?? []).map((proposal) => {
      if (!proposal || proposal.kind !== 'defer_task') return proposal;
      const key = String(proposal.taskId ?? '').trim();
      const asRef = refToId.get(key);
      if (asRef) return { ...proposal, taskId: asRef };
      // 也接受模型直接写真实 id（兼容两种写法）
      if (input.taskById.has(key)) return { ...proposal, taskId: key };
      return proposal;
    });

    // 注意接口形状：validateProposals 期望 { proposals: [...] }，不是裸数组。
    // 直接传数组会让它读不到提议、全部误判为"没有建议"——功能会静默失效。
    const validated = validateProposals({ proposals: normalized }, input);

    if (!validated.ok) {
      // 全部拒绝：不生成预览。宁可让用户重试，也不展示一个半懂不懂的方案。
      return { ok: false, stage: 'proposal_rejected', issues: validated.issues, reply: aiResult.reply };
    }
    if (validated.proposals.length === 0) {
      return { ok: false, stage: 'no_proposal', issues: ['AI 认为当前不需要调整日程。'], reply: aiResult.reply };
    }

    const ops = proposalsToOps(validated.proposals, { taskById: input.taskById, today: input.today });
    const previewResult = planService.requestPreview({
      ops,
      now: input.today ? { date: input.today, minutes: now().minutes } : undefined,
      changeSummary: `AI 建议的调整：${validated.proposals.length} 项`,
      trigger: 'ai_rescue',
    });

    if (!previewResult.ok) {
      /**
       * 程序校验通过、但**排程排不出来**——这必须如实告诉用户。
       *
       * 典型情况：把任务推迟后，剩下的工作量在截止前放不下了。
       * 这不是 AI 的错，也不是代码的错，而是现实约束——用户需要知道这个取舍不成立。
       */
      return {
        ok: false,
        stage: 'infeasible',
        issues: (previewResult.issues ?? []).map((issue) => issue.message),
        preview: previewResult,
        reply: aiResult.reply,
      };
    }

    return {
      ok: true,
      stage: 'preview_ready',
      proposals: validated.proposals,
      preview: previewResult.preview,
      reply: aiResult.reply,
    };
  }

  /**
   * 时间校准：**纯程序统计**，不调用 AI。
   *
   * 单独暴露的必要性：AI 可能不可用（没 key、超时、额度用完），
   * 但"历史用时统计"本身不依赖网络，任何时候都该能用。
   */
  function getCalibration() {
    const state = app.getState();
    const samples = collectSamples(state);
    const stats = calibrateStats(samples);
    return { samples, ...stats };
  }

  /**
   * 为"新建任务"给出纯程序版的用时建议（不经过 AI）。
   *
   * @param {string} subject
   * @param {number} plannedMinutes
   */
  function estimateForNewTask(subject, plannedMinutes) {
    const { subjects } = getCalibration();
    return suggestEstimate(subject, plannedMinutes, subjects);
  }

  /**
   * 给 AI 的校准上下文：只包含**程序算好的数字**。
   *
   * 不把原始记录交给 AI 自己算——那样 AI 一旦算错，学生看到的数字就是错的，
   * 而且无法验证。数字由程序给，解释由 AI 给。
   */
  function buildCalibrationContext() {
    const { subjects, summary } = getCalibration();
    const current = now();
    return {
      date: current.date,
      summary,
      subjects: subjects.map((item) => ({
        subject: item.subject,
        sampleCount: item.sampleCount,
        meanPlannedMinutes: item.meanPlannedMinutes,
        meanActualMinutes: item.meanActualMinutes,
        meanRatio: item.meanRatio,
        meanDiffMinutes: item.meanDiffMinutes,
        tendency: item.tendency,
        reliable: item.reliable,
        // 只给标题与时长，不给完整记录——AI 解释规律不需要更多
        examples: item.samples.slice(0, 4),
      })),
    };
  }

  /**
   * 上一次急救的结果，**存在服务层而不是 DOM 里**。
   *
   * 为什么必须有这一层：prepareRescuePreview 会调用 requestPreview，
   * 后者 commit 状态 → app.subscribe → 整页重渲染。
   * 如果结果只渲染在 DOM 里，重渲染会立刻把它抹掉——
   * 用户会看到分析结果闪一下就消失（这是实测发现的真实缺陷）。
   *
   * 放在这里还有一个附带好处：切到别的页面再回来，结果仍然在。
   */
  let rescueState = null;

  function getRescueState() {
    return rescueState;
  }

  function setRescueState(next) {
    rescueState = next;
  }

  function clearRescueState() {
    rescueState = null;
  }

  return {
    buildRescueInput,
    prepareRescuePreview,
    getRescueState,
    setRescueState,
    clearRescueState,
    getCalibration,
    estimateForNewTask,
    buildCalibrationContext,
  };
}
