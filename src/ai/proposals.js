/**
 * AI 提议的结构定义与**程序侧严格校验**。
 *
 * 这是整个 AI 集成里最关键的一条边界：
 *
 *   AI 只能提出**结构化提议**，而且提议必须通过这里的校验才能变成改动；
 *   校验失败时，宁可整体拒绝并告诉用户"AI 的提议不被接受"，
 *   也绝不"尽量理解一下、猜一猜它的意思"。
 *
 * 为什么不猜：学生的日程改动是有代价的（一次误改可能让明天的考试没有复习时间）。
 * 如果程序替 AI 补全它没说清楚的部分，用户会在预览里看到一个自己从未同意过的方案，
 * 却以为那是 AI 的原意。明确拒绝更安全。
 *
 * 允许的改动只有两种（这是产品决定，不是技术限制）：
 *   1. 调整某个任务的**剩余工作量**（推迟到今天之后再做）
 *   2. **锁定某一天**（当天不再排新学习）
 * 不允许：改截止时间、删除任务、直接改已排时段。截止时间是硬约束，AI 不得触碰。
 *
 * 本模块是纯函数：不读时钟、不发请求、不访问存储。
 */

/** AI 提议里允许出现的调整类型 */
export const PROPOSAL_KINDS = Object.freeze(['defer_task', 'lock_date']);

/** 单个提议允许调整的最大幅度（分钟），超过视为不可信 */
export const MAX_DEFER_MINUTES = 8 * 60;

/** 一次最多接受的提议条数 */
export const MAX_PROPOSALS = 8;

/**
 * 把 AI 的输出转成"可校验的提议"，并逐条检查。
 *
 * @param {unknown} raw AI 返回的已解析对象
 * @param {object} ctx
 * @param {string} ctx.today 今天的日期（'YYYY-MM-DD'），用于拒绝"顺延到今天"这种无意义操作
 * @param {string} ctx.latestAllowedDate 允许涉及的最晚日期（通常是窗口末尾）
 * @param {Map<string, object>} ctx.taskById 当前任务表
 * @param {Record<string, number>} ctx.remainingByTask 每个任务的剩余分钟数
 * @returns {{ok: boolean, proposals: object[], issues: string[]}}
 */
export function validateProposals(raw, ctx) {
  const issues = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, proposals: [], issues: ['AI 没有返回可识别的结构。'] };
  }
  const list = Array.isArray(raw.proposals) ? raw.proposals : [];
  if (list.length === 0) {
    return { ok: false, proposals: [], issues: ['AI 没有给出任何调整建议。'] };
  }
  if (list.length > MAX_PROPOSALS) {
    return { ok: false, proposals: [], issues: [`一次最多接受 ${MAX_PROPOSALS} 条调整，AI 给出了 ${list.length} 条。`] };
  }

  const proposals = [];
  const seenTaskIds = new Set();
  const seenDates = new Set();

  for (const [index, item] of list.entries()) {
    const where = `第 ${index + 1} 条建议`;
    if (!item || typeof item !== 'object') {
      issues.push(`${where}不是一个对象。`);
      continue;
    }
    if (!PROPOSAL_KINDS.includes(item.kind)) {
      issues.push(`${where}的调整类型「${String(item.kind)}」不被允许（只支持 defer_task 与 lock_date）。`);
      continue;
    }

    if (item.kind === 'defer_task') {
      const taskId = typeof item.taskId === 'string' ? item.taskId : '';
      const task = ctx.taskById.get(taskId);
      if (!task) {
        // 关键防线：AI 不得引用不存在的任务（否则预览里会凭空多出改动）
        issues.push(`${where}引用了不存在的任务 ${taskId || '（空）'}。`);
        continue;
      }
      if (seenTaskIds.has(taskId)) {
        issues.push(`${where}重复调整了同一个任务「${task.title}」。`);
        continue;
      }
      const minutes = item.minutes;
      if (!Number.isInteger(minutes) || minutes <= 0) {
        issues.push(`${where}对「${task.title}」的分钟数无效（必须是正整数）。`);
        continue;
      }
      if (minutes > MAX_DEFER_MINUTES) {
        issues.push(`${where}对「${task.title}」的调整幅度过大（${minutes} 分钟超过上限 ${MAX_DEFER_MINUTES}）。`);
        continue;
      }
      const remaining = ctx.remainingByTask[taskId] ?? 0;
      if (minutes > remaining) {
        issues.push(`${where}把「${task.title}」推迟了 ${minutes} 分钟，但它只剩下 ${remaining} 分钟。`);
        continue;
      }
      seenTaskIds.add(taskId);
      proposals.push({
        kind: 'defer_task',
        taskId,
        taskTitle: task.title,
        minutes,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
      });
      continue;
    }

    // lock_date
    const date = typeof item.date === 'string' ? item.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      issues.push(`${where}的日期格式无效（需要 YYYY-MM-DD，实际「${date}」）。`);
      continue;
    }
    if (date <= ctx.today) {
      // 锁"今天"是合理的（今天不排了），但锁过去的日期毫无意义
      if (date < ctx.today) {
        issues.push(`${where}试图锁定已经过去的日期 ${date}。`);
        continue;
      }
    }
    if (date > ctx.latestAllowedDate) {
      issues.push(`${where}试图锁定超出规划窗口的日期 ${date}。`);
      continue;
    }
    if (seenDates.has(date)) {
      issues.push(`${where}重复锁定了同一天 ${date}。`);
      continue;
    }
    seenDates.add(date);
    proposals.push({
      kind: 'lock_date',
      date,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
    });
  }

  if (proposals.length === 0 && issues.length > 0) {
    return { ok: false, proposals: [], issues };
  }
  return { ok: issues.length === 0, proposals, issues };
}

/**
 * 把通过校验的提议转成引擎能执行的变更描述（ops）。
 *
 * 注意"推迟 N 分钟"的真正含义：
 * 任务的总时长不变，只是**今天要做的部分变少**。引擎没有"推迟"这个操作，
 * 所以在当前数据模型里，等价于把该任务的预计用时**减去 N 分钟**，
 * 并把已经完成的部分保持不变——剩余工作量因此减少 N。
 *
 * 这里刻意**不动**已完成记录：学生已经学掉的分钟不能因为调整计划而消失。
 *
 * @param {object[]} proposals 已通过校验的提议
 * @param {object} ctx { taskById, today, lockDateTitlePrefix }
 * @returns {object[]} ops 列表（可直接交给 planService.requestPreview）
 */
export function proposalsToOps(proposals, ctx) {
  const ops = [];
  for (const proposal of proposals) {
    if (proposal.kind === 'defer_task') {
      const task = ctx.taskById.get(proposal.taskId);
      if (!task) continue;
      const nextPlanned = Math.max(1, (task.plannedMinutes ?? 0) - proposal.minutes);
      // 如果减到比已完成还少，任务校验会拒绝；这里提前夹住，避免把非法值送进引擎
      const floor = task.priorCompletedMinutes ?? 0;
      ops.push({
        kind: 'task.update',
        taskId: proposal.taskId,
        patch: { plannedMinutes: Math.max(nextPlanned, Math.max(floor, 1)) },
      });
      continue;
    }
    if (proposal.kind === 'lock_date') {
      ops.push({
        kind: 'fixedActivity.add',
        input: {
          title: `已锁定（${proposal.date}）`,
          type: 'other',
          recurrence: { kind: 'once', date: proposal.date },
          start: '00:00',
          end: '23:59',
          movable: false,
          note: `${ctx.lockDateTitlePrefix ?? ''}${proposal.reason || 'AI 建议当天不再安排学习'}`,
        },
      });
    }
  }
  return ops;
}
