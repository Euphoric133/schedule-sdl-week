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
 * 允许的改动（产品决定）：
 *   1. defer_task    调整某个任务的**剩余工作量**（推迟到今天之后再做）
 *   2. lock_date     锁定某一天（当天不再排新学习）
 *   3. create_task   新建学习任务
 *   4. update_task   修改已有任务的白名单字段
 *   5. complete_task / cancel_task  完成或取消任务
 *   6. delete_task   软删除（可恢复）或彻底删除（含已完成记录）
 *
 * 边界原则（2026-11 调整）：
 * - **合法但越界**的操作（截止日期在过去、删除任务）不再直接拒绝，
 *   而是打上 `flags` 风险标记，交给预览页醒目提示，最终仍由用户确认；
 * - **非法**输入（不存在的日期、不存在的科目、越界数值）继续拒绝。
 *
 * 本模块是纯函数：不读时钟、不发请求、不访问存储。
 */

import {
  PLANNED_MINUTES_MAX,
  PLANNED_START_MAX,
  PLANNED_START_MIN,
  RATING_MAX,
  RATING_MIN,
  SUBJECT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from '../domain/task.js';
import { isValidDateString, isValidTimeString } from '../domain/time.js';

/** AI 提议里允许出现的调整类型 */
export const PROPOSAL_KINDS = Object.freeze([
  'defer_task',
  'lock_date',
  'create_task',
  'update_task',
  'complete_task',
  'cancel_task',
  'delete_task',
]);

/** 单个提议允许调整的最大幅度（分钟），超过视为不可信 */
export const MAX_DEFER_MINUTES = 8 * 60;

/** 一次最多接受的提议条数 */
export const MAX_PROPOSALS = 8;

/** 一次最多新建的任务数 */
export const MAX_CREATE_TASKS = 5;

/** 一次最多删除的任务数 */
export const MAX_DELETE_TASKS = 3;

/** 新建任务的预计用时下限（与排程最小粒度一致） */
export const MIN_CREATE_MINUTES = 5;

/**
 * `update_task` 允许 AI 修改的字段白名单。
 *
 * 刻意**不含** `status` / `dependsOn` / `note`：
 * - status 有 complete / cancel / delete 三个专门入口，
 *   让 AI 通过 patch 改状态会绕过这些入口的校验与确认文案；
 * - dependsOn 是任务之间的依赖图，AI 看不到全貌，改错会让排程一直等待；
 * - note 是用户自己的备注，不属于"排程决策"。
 */
export const UPDATABLE_FIELDS = Object.freeze([
  'title',
  'subject',
  'plannedMinutes',
  'deadlineDate',
  'deadlineTime',
  'importance',
  'difficulty',
  'procrastination',
  'splittable',
  'plannedStartMinutes',
]);

/** 风险标记 → 中文说明（前端与预览页共用同一套文案） */
export const FLAG_TEXT = Object.freeze({
  deadline_in_past: '截止日期在过去：这个任务会立即显示为已逾期，排程不会为它安排任何时间。',
  deletes_completed_sessions: '将删除该任务已完成的学习记录，统计里的时长也会一并消失。',
});

/* ================================================================== *
 * 小工具
 * ================================================================== */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 任务引用解析：优先 ref（数字或数字字符串），其次真实 id，最后唯一标题。
 *
 * 与既有 defer_task 保持同一套映射方式；标题兜底**只在唯一匹配时**成立，
 * 重名任务一律拒绝（猜错目标的代价比拒绝大）。
 */
function resolveTaskId(raw, ctx) {
  const taskById = ctx.taskById ?? new Map();
  const contextTasks = Array.isArray(ctx.contextTasks) ? ctx.contextTasks : [];
  const byRef = (ref) => contextTasks.find((item) => item.ref === ref)?.id ?? null;

  if (typeof raw === 'number' && Number.isInteger(raw)) return byRef(raw);

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (taskById.has(trimmed)) return trimmed;
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber)) {
      const id = byRef(asNumber);
      if (id) return id;
    }
    const matches = [...taskById.values()].filter((task) => task.title === trimmed);
    return matches.length === 1 ? matches[0].id : null;
  }
  return null;
}

/** 已完成学习记录条数（用于"删除会丢记录"的提示） */
function completedSessionCount(state, taskId) {
  return (state?.sessions ?? []).filter(
    (session) => session.taskId === taskId && session.state === 'completed',
  ).length;
}

function readRating(value, where, issues, label) {
  if (value === undefined || value === null) return 3;
  if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
    issues.push(`${where}的${label}无效（需要 ${RATING_MIN}–${RATING_MAX} 的整数，实际「${value}」）。`);
    return null;
  }
  return value;
}

/* ================================================================== *
 * 校验
 * ================================================================== */

/**
 * 把 AI 的输出转成"可校验的提议"，并逐条检查。
 *
 * @param {unknown} raw AI 返回的已解析对象
 * @param {object} ctx
 * @param {string} ctx.today 今天的日期（'YYYY-MM-DD'）
 * @param {string} ctx.latestAllowedDate 允许涉及的最晚日期（通常是窗口末尾）
 * @param {Map<string, object>} ctx.taskById 当前任务表（含已完成/已取消，未删除）
 * @param {Record<string, number>} ctx.remainingByTask 每个任务的剩余分钟数
 * @param {string[]} [ctx.subjects] 已存在的科目
 * @param {object} [ctx.state] 应用状态（用于统计已完成记录条数）
 * @param {Array<{ref: number, id: string}>} [ctx.contextTasks] ref → id 对照表
 * @returns {{ok: boolean, proposals: object[], issues: string[], flags: string[]}}
 */
export function validateProposals(raw, ctx) {
  const issues = [];
  const flags = [];
  const addFlag = (name) => {
    if (!flags.includes(name)) flags.push(name);
  };

  if (!raw || typeof raw !== 'object') {
    return { ok: false, proposals: [], issues: ['AI 没有返回可识别的结构。'], flags };
  }
  const list = Array.isArray(raw.proposals) ? raw.proposals : [];
  if (list.length === 0) {
    return { ok: false, proposals: [], issues: ['AI 没有给出任何调整建议。'], flags };
  }
  if (list.length > MAX_PROPOSALS) {
    return {
      ok: false,
      proposals: [],
      issues: [`一次最多接受 ${MAX_PROPOSALS} 条调整，AI 给出了 ${list.length} 条。`],
      flags,
    };
  }

  const taskById = ctx.taskById ?? new Map();
  const subjects = Array.isArray(ctx.subjects) ? ctx.subjects : [];
  const proposals = [];
  const seenTaskIds = new Set();
  const seenDates = new Set();
  const touchedByUpdate = new Set();
  let createCount = 0;
  let deleteCount = 0;

  for (const [index, item] of list.entries()) {
    const where = `第 ${index + 1} 条建议`;
    if (!isPlainObject(item)) {
      issues.push(`${where}不是一个对象。`);
      continue;
    }
    if (!PROPOSAL_KINDS.includes(item.kind)) {
      issues.push(`${where}的调整类型「${String(item.kind)}」不被允许。`);
      continue;
    }

    /* ---------------- defer_task ---------------- */
    if (item.kind === 'defer_task') {
      const taskId = resolveTaskId(item.taskId, ctx);
      const task = taskId ? taskById.get(taskId) : null;
      if (!task) {
        issues.push(`${where}引用了不存在的任务 ${String(item.taskId ?? '（空）')}。`);
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
      const remaining = ctx.remainingByTask?.[taskId] ?? 0;
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
        flags: [],
      });
      continue;
    }

    /* ---------------- lock_date ---------------- */
    if (item.kind === 'lock_date') {
      const date = typeof item.date === 'string' ? item.date : '';
      if (!isValidDateString(date)) {
        issues.push(`${where}的日期格式无效（需要 YYYY-MM-DD，实际「${date}」）。`);
        continue;
      }
      if (date < ctx.today) {
        issues.push(`${where}试图锁定已经过去的日期 ${date}。`);
        continue;
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
        flags: [],
      });
      continue;
    }

    /* ---------------- create_task ---------------- */
    if (item.kind === 'create_task') {
      createCount += 1;
      if (createCount > MAX_CREATE_TASKS) {
        issues.push(`一次最多新建 ${MAX_CREATE_TASKS} 个任务（第 ${index + 1} 条超限）。`);
        continue;
      }

      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) {
        issues.push(`${where}缺少任务名称。`);
        continue;
      }
      if ([...title].length > TITLE_MAX_LENGTH) {
        issues.push(`${where}的任务名称超过 ${TITLE_MAX_LENGTH} 个字符。`);
        continue;
      }

      const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
      if (!subject) {
        issues.push(`${where}缺少所属科目。`);
        continue;
      }
      if (subjects.length > 0 && !subjects.includes(subject)) {
        issues.push(`${where}的科目「${subject}」不存在，请先选择已有科目（${subjects.slice(0, 6).join('、')}）。`);
        continue;
      }
      if ([...subject].length > SUBJECT_MAX_LENGTH) {
        issues.push(`${where}的科目名称过长。`);
        continue;
      }

      const planned = item.plannedMinutes;
      if (!Number.isInteger(planned) || planned < MIN_CREATE_MINUTES || planned > PLANNED_MINUTES_MAX) {
        issues.push(
          `${where}的预计用时无效（需要 ${MIN_CREATE_MINUTES}–${PLANNED_MINUTES_MAX} 的整数分钟，实际「${planned}」）。`,
        );
        continue;
      }

      const deadlineDate = typeof item.deadlineDate === 'string' ? item.deadlineDate : '';
      if (!isValidDateString(deadlineDate)) {
        issues.push(`${where}的截止日期不是真实存在的日期（「${deadlineDate}」），格式需要 YYYY-MM-DD。`);
        continue;
      }
      const deadlineTime = typeof item.deadlineTime === 'string' && item.deadlineTime ? item.deadlineTime : '23:00';
      if (!isValidTimeString(deadlineTime)) {
        issues.push(`${where}的截止时刻无效（需要 HH:mm，实际「${deadlineTime}」）。`);
        continue;
      }

      const importance = readRating(item.importance, where, issues, '重要度');
      const difficulty = readRating(item.difficulty, where, issues, '难度');
      const procrastination = readRating(item.procrastination, where, issues, '拖延倾向');
      if (importance === null || difficulty === null || procrastination === null) continue;

      let plannedStartMinutes = null;
      if (typeof item.plannedStart === 'string' && item.plannedStart) {
        if (!isValidTimeString(item.plannedStart)) {
          issues.push(`${where}的计划开始时间无效（需要 HH:mm，实际「${item.plannedStart}」）。`);
          continue;
        }
        const [hours, minutes] = item.plannedStart.split(':').map(Number);
        plannedStartMinutes = hours * 60 + minutes;
        if (plannedStartMinutes < PLANNED_START_MIN || plannedStartMinutes > PLANNED_START_MAX) {
          issues.push(`${where}的计划开始时间超出一天范围。`);
          continue;
        }
      }

      // 越界但合法：过去 / 当年更早的日期 → 打风险标记，不拒绝
      const isPast = deadlineDate < ctx.today;
      if (isPast) addFlag('deadline_in_past');

      proposals.push({
        kind: 'create_task',
        title,
        subject,
        plannedMinutes: planned,
        deadlineDate,
        deadlineTime,
        importance,
        difficulty,
        procrastination,
        splittable: item.splittable === undefined ? true : item.splittable === true,
        plannedStartMinutes,
        note: '',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
        flags: isPast ? ['deadline_in_past'] : [],
      });
      continue;
    }

    /* ---------------- update_task ---------------- */
    if (item.kind === 'update_task') {
      const taskId = resolveTaskId(item.taskId, ctx);
      const task = taskId ? taskById.get(taskId) : null;
      if (!task) {
        issues.push(`${where}引用了不存在的任务 ${String(item.taskId ?? '（空）')}。`);
        continue;
      }
      if (touchedByUpdate.has(taskId)) {
        issues.push(`${where}重复修改了同一个任务「${task.title}」（同一任务一次只能一条修改）。`);
        continue;
      }
      if (!isPlainObject(item.patch) || Object.keys(item.patch).length === 0) {
        issues.push(`${where}没有给出要修改的字段。`);
        continue;
      }

      const unknownFields = Object.keys(item.patch).filter((key) => !UPDATABLE_FIELDS.includes(key));
      if (unknownFields.length > 0) {
        issues.push(`${where}试图修改不允许 AI 改动的字段：${unknownFields.join('、')}。`);
        continue;
      }

      const patch = {};
      let patchOk = true;

      if (item.patch.title !== undefined) {
        const title = typeof item.patch.title === 'string' ? item.patch.title.trim() : '';
        if (!title || [...title].length > TITLE_MAX_LENGTH) {
          issues.push(`${where}的新任务名称无效（不能为空，且不超过 ${TITLE_MAX_LENGTH} 个字符）。`);
          patchOk = false;
        } else {
          patch.title = title;
        }
      }

      if (item.patch.subject !== undefined) {
        const subject = typeof item.patch.subject === 'string' ? item.patch.subject.trim() : '';
        if (!subject) {
          issues.push(`${where}的新科目为空。`);
          patchOk = false;
        } else if (subjects.length > 0 && !subjects.includes(subject)) {
          issues.push(`${where}的科目「${subject}」不存在，请先选择已有科目。`);
          patchOk = false;
        } else {
          patch.subject = subject;
        }
      }

      if (item.patch.plannedMinutes !== undefined) {
        const planned = item.patch.plannedMinutes;
        if (!Number.isInteger(planned) || planned < 1 || planned > PLANNED_MINUTES_MAX) {
          issues.push(`${where}的预计用时无效（需要 1–${PLANNED_MINUTES_MAX} 的整数分钟）。`);
          patchOk = false;
        } else {
          patch.plannedMinutes = planned;
        }
      }

      if (item.patch.deadlineDate !== undefined) {
        const date = item.patch.deadlineDate;
        if (!isValidDateString(date)) {
          issues.push(`${where}的截止日期不是真实存在的日期（「${String(date)}」）。`);
          patchOk = false;
        } else {
          patch.deadlineDate = date;
          if (date < ctx.today) addFlag('deadline_in_past');
        }
      }

      if (item.patch.deadlineTime !== undefined) {
        if (!isValidTimeString(item.patch.deadlineTime)) {
          issues.push(`${where}的截止时刻无效（需要 HH:mm）。`);
          patchOk = false;
        } else {
          patch.deadlineTime = item.patch.deadlineTime;
        }
      }

      for (const field of ['importance', 'difficulty', 'procrastination']) {
        if (item.patch[field] !== undefined) {
          const value = item.patch[field];
          if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
            issues.push(`${where}的 ${field} 无效（需要 ${RATING_MIN}–${RATING_MAX} 的整数）。`);
            patchOk = false;
          } else {
            patch[field] = value;
          }
        }
      }

      if (item.patch.splittable !== undefined) {
        if (typeof item.patch.splittable !== 'boolean') {
          issues.push(`${where}的 splittable 必须是布尔值。`);
          patchOk = false;
        } else {
          patch.splittable = item.patch.splittable;
        }
      }

      if (item.patch.plannedStartMinutes !== undefined) {
        const value = item.patch.plannedStartMinutes;
        if (value !== null && (!Number.isInteger(value) || value < PLANNED_START_MIN || value > PLANNED_START_MAX)) {
          issues.push(`${where}的计划开始时间无效（需要 0–${PLANNED_START_MAX} 的整数分钟，或 null）。`);
          patchOk = false;
        } else {
          patch.plannedStartMinutes = value;
        }
      }

      if (!patchOk) continue;

      touchedByUpdate.add(taskId);
      const isPast = Boolean(patch.deadlineDate && patch.deadlineDate < ctx.today);
      proposals.push({
        kind: 'update_task',
        taskId,
        taskTitle: task.title,
        patch,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
        flags: isPast ? ['deadline_in_past'] : [],
      });
      continue;
    }

    /* ---------------- complete_task / cancel_task ---------------- */
    if (item.kind === 'complete_task' || item.kind === 'cancel_task') {
      const taskId = resolveTaskId(item.taskId, ctx);
      const task = taskId ? taskById.get(taskId) : null;
      if (!task) {
        issues.push(`${where}引用了不存在的任务 ${String(item.taskId ?? '（空）')}。`);
        continue;
      }
      if (seenTaskIds.has(taskId)) {
        issues.push(`${where}重复处理了同一个任务「${task.title}」。`);
        continue;
      }
      if (item.kind === 'complete_task' && task.status === 'completed') {
        issues.push(`「${task.title}」已经是完成状态，不需要再完成一次。`);
        continue;
      }
      if (task.status !== 'not_started' && task.status !== 'in_progress') {
        const action = item.kind === 'complete_task' ? '标记完成' : '取消';
        issues.push(`「${task.title}」当前状态是「${task.status}」，只有未开始或进行中的任务可以${action}。`);
        continue;
      }
      seenTaskIds.add(taskId);
      proposals.push({
        kind: item.kind,
        taskId,
        taskTitle: task.title,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
        flags: [],
      });
      continue;
    }

    /* ---------------- delete_task ---------------- */
    if (item.kind === 'delete_task') {
      deleteCount += 1;
      if (deleteCount > MAX_DELETE_TASKS) {
        issues.push(`一次最多删除 ${MAX_DELETE_TASKS} 个任务（第 ${index + 1} 条超限）。`);
        continue;
      }
      const taskId = resolveTaskId(item.taskId, ctx);
      const task = taskId ? taskById.get(taskId) : null;
      if (!task) {
        issues.push(`${where}引用了不存在的任务 ${String(item.taskId ?? '（空）')}。`);
        continue;
      }
      if (touchedByUpdate.has(taskId)) {
        issues.push(`第 ${index + 1} 条同时修改并删除了「${task.title}」，这是不允许的。`);
        continue;
      }
      const hard = item.hard === true;
      const completedCount = completedSessionCount(ctx.state, taskId);
      if (completedCount > 0) addFlag('deletes_completed_sessions');
      proposals.push({
        kind: 'delete_task',
        taskId,
        taskTitle: task.title,
        hard,
        completedSessionCount: completedCount,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
        flags: completedCount > 0 ? ['deletes_completed_sessions'] : [],
      });
      continue;
    }
  }

  if (proposals.length === 0 && issues.length > 0) {
    return { ok: false, proposals: [], issues, flags };
  }
  return { ok: issues.length === 0, proposals, issues, flags };
}

/**
 * 把通过校验的提议转成引擎能执行的变更描述（ops）。
 *
 * 注意"推迟 N 分钟"的真正含义：
 * 任务的总时长不变，只是**今天要做的部分变少**。引擎没有"推迟"这个操作，
 * 所以在当前数据模型里，等价于把该任务的预计用时**减去 N 分钟**，
 * 并把已经完成的部分保持不变——剩余工作量因此减少 N。
 * 这里刻意**不动**已完成记录：学生已经学掉的分钟不能因为调整计划而消失。
 *
 * `complete_task` 必须复用产品统一的完成链路（记录实际时段 + 标记完成 +
 * 取消剩余时段 + 清理依赖），因此由调用方通过 `ctx.completionOpsFor` 注入，
 * 本模块不重复实现一遍；拿不到注入函数时**不降级**为"只改状态"，
 * 因为那会丢掉实际学习记录、让统计少一段时长。
 *
 * @param {object[]} proposals 已通过校验的提议
 * @param {object} ctx { taskById, today, lockDateTitlePrefix, completionOpsFor }
 * @returns {object[]} ops 列表（可直接交给 planService.requestPreview）
 */
export function proposalsToOps(proposals, ctx) {
  const ops = [];
  for (const proposal of proposals) {
    if (proposal.kind === 'defer_task') {
      const task = ctx.taskById.get(proposal.taskId);
      if (!task) continue;
      const nextPlanned = Math.max(1, (task.plannedMinutes ?? 0) - proposal.minutes);
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
      continue;
    }

    if (proposal.kind === 'create_task') {
      ops.push({
        kind: 'task.add',
        input: {
          title: proposal.title,
          subject: proposal.subject,
          plannedMinutes: proposal.plannedMinutes,
          deadlineDate: proposal.deadlineDate,
          deadlineTime: proposal.deadlineTime,
          importance: proposal.importance,
          difficulty: proposal.difficulty,
          procrastination: proposal.procrastination,
          splittable: proposal.splittable,
          plannedStartMinutes: proposal.plannedStartMinutes,
          priorCompletedMinutes: null,
          note: '',
        },
      });
      continue;
    }

    if (proposal.kind === 'update_task') {
      ops.push({ kind: 'task.update', taskId: proposal.taskId, patch: { ...proposal.patch } });
      continue;
    }

    if (proposal.kind === 'complete_task') {
      const completionOps = ctx.completionOpsFor?.(proposal.taskId) ?? [];
      ops.push(...completionOps);
      continue;
    }

    if (proposal.kind === 'cancel_task') {
      ops.push({ kind: 'task.status', taskId: proposal.taskId, to: 'cancelled' });
      continue;
    }

    if (proposal.kind === 'delete_task') {
      /**
       * hard=false → `task.delete`（软删除，可恢复）
       * hard=true  → `task.purge`（彻底移除，含已完成记录）
       * 两者都走 mutations 里已有的实现，不在这里另写一套。
       */
      ops.push(
        proposal.hard
          ? { kind: 'task.purge', taskId: proposal.taskId }
          : { kind: 'task.delete', taskId: proposal.taskId },
      );
    }
  }
  return ops;
}
