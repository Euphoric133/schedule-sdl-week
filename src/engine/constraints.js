/**
 * 硬约束校验器（H1–H10）。
 *
 * 这是整个项目最重要的一道防线：**算法可以优化，但不能违反约束**。
 * 因此校验器与算法刻意分离——它只做验证，不参与求解；任何排程结果在交给用户确认之前
 * 都必须先通过这里。每个约束都有对应的负向测试（构造违规计划 → 断言必须报错），
 * 防止校验器本身失效却无人察觉。
 *
 * 校验结果分两类：
 * - `ok: false`：存在**硬约束违反**，绝不允许把这样的计划当成可用结果交付。
 * - `ok: true` 但带 warnings：例如"某个任务的安排超出了截止时间"——这不是算法错误，
 *   而是容量限制导致的客观事实（H4 要求的是"不得标记为按时完成"，因此转化为风险诊断）。
 */

import { UNSCHEDULED_REASON } from './policy.js';
import { computeDayCapacity, normalizeStudyWindows, sumLength } from './capacity.js';
import { addDays, formatMinutes, isValidDateString, MINUTES_PER_DAY } from '../domain/time.js';

/** 违反的约束编号（与 PROJECT_SPEC.md 的 H1–H10 一一对应） */
export const CONSTRAINT = Object.freeze({
  H1: 'H1', // 学习时段不与固定活动重叠
  H2: 'H2', // 普通学习时段之间不冲突
  H3: 'H3', // 只安排在用户允许的时间内
  H4: 'H4', // 计划完成时间超过截止时间 → 不得标记按时
  H5: 'H5', // 不可拆分任务不得被拆开
  H6: 'H6', // 学习时长有效
  H7: 'H7', // 前置任务必须满足依赖条件
  H8: 'H8', // 缓冲与休息不重复计算
  H9: 'H9', // 已完成的学习时段不得被删除或改回未完成
  H10: 'H10', // 锁定时段不得被移动/缩短/拆分/覆盖
});

export const CONSTRAINT_TEXT = Object.freeze({
  H1: '学习时段不能与固定活动重叠',
  H2: '普通学习时段之间不能冲突',
  H3: '任务只能安排在用户允许的时间内',
  H4: '计划完成时间超过截止时间时不得标记为按时完成',
  H5: '不可拆分任务不得被拆开',
  H6: '学习时长必须有效（满足最短/最长限制与起止顺序）',
  H7: '前置任务必须满足依赖条件',
  H8: '机动缓冲与计划休息不得重复计算',
  H9: '已完成的学习时段不得被自动删除或改回未完成',
  H10: '用户锁定的时段不得被自动移动、缩短、拆分或覆盖',
});

/**
 * @typedef {object} ConstraintViolation
 * @property {string} constraint H1–H10
 * @property {string} message 面向用户的中文说明
 * @property {string} [date]
 * @property {string[]} [relatedIds]
 * @property {object} [details]
 */

/**
 * 校验一份候选计划。
 *
 * @param {object} params
 * @param {object} params.plan 候选计划（含 blocks；引擎阶段可直接传 placements 列表）
 * @param {object[]} params.tasks 全部任务
 * @param {object[]} params.sessions 变更前的全部时段（用于 H9/H10 比对）
 * @param {object[]} params.fixedActivities
 * @param {object} params.settings
 * @param {object} params.now { date, minutes }
 * @param {object[]} [params.placements] 引擎产出的学习片段（未套上完整块结构时使用）
 * @param {object} [params.policy]
 * @returns {{ok: boolean, violations: ConstraintViolation[], warnings: ConstraintViolation[], protectedSessions: object}}
 */
export function validatePlanConstraints({
  plan = null,
  tasks = [],
  sessions = [],
  fixedActivities = [],
  settings,
  now,
  placements = null,
  policy = null,
  plannedMinutesByTask = new Map(),
  placedMinutesByTask = new Map(),
}) {
  const violations = [];
  const warnings = [];
  const blocks = normalizeBlocks({ plan, placements, tasks });

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const studyBlocks = blocks.filter((block) => block.kind === 'study');
  const restBlocks = blocks.filter((block) => block.kind === 'rest');
  const bufferBlocks = blocks.filter((block) => block.kind === 'buffer');
  const fixedSpans = expandFixedSpans(fixedActivities, blocks);

  checkH1(studyBlocks, fixedSpans, violations);
  checkH2(studyBlocks, violations);
  checkH3(studyBlocks, settings, violations);
  checkH4(studyBlocks, taskById, now, warnings, { plannedMinutesByTask, placedMinutesByTask });
  checkH5(studyBlocks, taskById, violations);
  checkH6(studyBlocks, taskById, policy, violations);
  checkH7(studyBlocks, taskById, violations);
  checkH8(restBlocks, bufferBlocks, violations);
  const protectedSessions = checkH9H10(plan, sessions, violations);

  return { ok: violations.length === 0, violations, warnings, protectedSessions };
}

/** 把计划块或引擎片段统一成校验用的块结构 */
function normalizeBlocks({ plan, placements, tasks }) {
  if (placements) {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return placements.map((placement) => ({
      id: placement.id,
      kind: placement.kind ?? 'study',
      date: placement.date,
      startMinutes: placement.startMinutes,
      endMinutes: placement.endMinutes,
      refId: placement.kind === 'study' || placement.kind === undefined ? placement.id : null,
      taskId: placement.taskId ?? null,
      subject: placement.subject ?? taskById.get(placement.taskId)?.subject ?? null,
      locked: false,
      derived: placement.kind === 'rest' || placement.kind === 'buffer',
    }));
  }
  if (plan) {
    return plan.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      date: block.date,
      startMinutes: block.startMinutes,
      endMinutes: block.endMinutes,
      refId: block.refId ?? null,
      taskId: block.taskId ?? null,
      subject: block.subject ?? null,
      locked: Boolean(block.locked),
      derived: Boolean(block.derived),
    }));
  }
  return [];
}

/** 固定活动展开为具体时间块（用于 H1 比对）；如果计划里已经带了 fixed 块则直接复用 */
function expandFixedSpans(fixedActivities, blocks) {
  const fromBlocks = blocks.filter((block) => block.kind === 'fixed');
  if (fromBlocks.length > 0) return fromBlocks;
  // 计划块里没有 fixed 时，至少把固定活动按"每天一段"展开（跨夜已由 domain 层切分）
  const spans = [];
  for (const activity of fixedActivities ?? []) {
    spans.push({ activityId: activity.id, startMinutes: activity.startMinutes, endMinutes: activity.endMinutes });
  }
  return spans;
}

/* ------------------------------------------------------------------ *
 * H1 / H2 / H3
 * ------------------------------------------------------------------ */

function checkH1(studyBlocks, fixedSpans, violations) {
  for (const block of studyBlocks) {
    for (const fixed of fixedSpans) {
      if (fixed.date && fixed.date !== block.date) continue;
      const overlap = overlapLength(block.startMinutes, block.endMinutes, fixed.startMinutes, fixed.endMinutes);
      if (overlap > 0) {
        violations.push({
          constraint: CONSTRAINT.H1,
          date: block.date,
          relatedIds: [block.id, fixed.refId ?? fixed.activityId].filter(Boolean),
          message: `${block.date} 的学习时段（${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}）与固定活动重叠了 ${overlap} 分钟。`,
          details: { overlap },
        });
      }
    }
  }
}

function checkH2(studyBlocks, violations) {
  const byDate = groupBy(studyBlocks, (block) => block.date);
  for (const [date, list] of byDate) {
    const sorted = [...list].sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      const overlap = overlapLength(previous.startMinutes, previous.endMinutes, current.startMinutes, current.endMinutes);
      if (overlap > 0) {
        violations.push({
          constraint: CONSTRAINT.H2,
          date,
          relatedIds: [previous.id, current.id],
          message: `${date} 有两个学习时段相互重叠了 ${overlap} 分钟（${formatMinutes(previous.startMinutes)}–${formatMinutes(previous.endMinutes)} 与 ${formatMinutes(current.startMinutes)}–${formatMinutes(current.endMinutes)}）。`,
          details: { overlap },
        });
      }
    }
  }
}

function checkH3(studyBlocks, settings, violations) {
  const cache = new Map();
  for (const block of studyBlocks) {
    if (!isValidDateString(block.date)) {
      violations.push({
        constraint: CONSTRAINT.H3,
        date: block.date,
        relatedIds: [block.id],
        message: `学习时段的日期不合法：${block.date}。`,
      });
      continue;
    }
    if (!cache.has(block.date)) cache.set(block.date, normalizeStudyWindows(block.date, settings.studyWindows));
    const windows = cache.get(block.date);
    const within = windows.some((window) => block.startMinutes >= window.startMinutes && block.endMinutes <= window.endMinutes);
    if (!within) {
      violations.push({
        constraint: CONSTRAINT.H3,
        date: block.date,
        relatedIds: [block.id],
        message: `${block.date} 的学习时段（${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}）超出了你允许的学习时间。`,
        details: { windows },
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * H4（转化为风险告警）/ H5 / H6
 * ------------------------------------------------------------------ */

/**
 * H4：计划完成时间超过截止时间的任务不得被标记为按时完成。
 *
 * 处理方式：转化为**风险告警**而不是硬约束违反。原因是"排到截止之后"本身不是算法错误
 * （容量确实不够），需求要求的是不得谎称按时完成。这里只在两种情况下提示：
 * 1. 任务还有工作量没能排进窗口（真正存在逾期风险）；
 * 2. 排定的完成时刻已经晚于截止时间。
 */
function checkH4(studyBlocks, taskById, now, warnings, { plannedMinutesByTask, placedMinutesByTask }) {
  const byTask = groupBy(studyBlocks, (block) => block.taskId);
  for (const [taskId, list] of byTask) {
    const task = taskById.get(taskId);
    if (!task) continue;
    const planned = plannedMinutesByTask.get(taskId) ?? 0;
    const placed = placedMinutesByTask.get(taskId) ?? list.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
    if (planned > 0 && placed >= planned) continue; // 该任务已全部排入，不构成逾期风险
    const last = list.reduce((latest, block) => {
      const stamp = `${block.date}T${String(Math.floor(block.endMinutes / 60)).padStart(2, '0')}:${String(block.endMinutes % 60).padStart(2, '0')}`;
      return latest === null || stamp > latest.stamp ? { stamp, block } : latest;
    }, null);
    if (!last) continue;
    const deadlineStamp = `${task.deadlineDate}T${task.deadlineTime}`;
    if (last.stamp > deadlineStamp) {
      warnings.push({
        constraint: CONSTRAINT.H4,
        date: last.block.date,
        relatedIds: [task.id, last.block.id],
        message: `「${task.title}」按当前计划最早也要到 ${last.block.date} ${formatMinutes(last.block.endMinutes)} 才能完成，已晚于截止时间（${task.deadlineDate} ${task.deadlineTime}），因此它不会被标记为按时完成。`,
        details: { deadline: deadlineStamp, plannedFinish: last.stamp },
      });
    }
  }
  // 截止时间已过且仍有剩余工作量的任务，也要如实提示
  for (const task of taskById.values()) {
    if (!task.deadlineDate) continue;
    const deadlineStamp = `${task.deadlineDate}T${task.deadlineTime}`;
    const nowStamp = `${now.date}T${String(Math.floor((now.minutes ?? 0) / 60)).padStart(2, '0')}:${String((now.minutes ?? 0) % 60).padStart(2, '0')}`;
    if (deadlineStamp < nowStamp && (byTask.get(task.id) ?? []).length > 0) {
      warnings.push({
        constraint: CONSTRAINT.H4,
        relatedIds: [task.id],
        message: `「${task.title}」的截止时间（${task.deadlineDate} ${task.deadlineTime}）已经过去，本次安排无法让它按时完成。`,
        details: { reasonCode: UNSCHEDULED_REASON.DEADLINE_PASSED },
      });
    }
  }
}

function checkH5(studyBlocks, taskById, violations) {
  const byTask = groupBy(studyBlocks, (block) => block.taskId);
  for (const [taskId, list] of byTask) {
    const task = taskById.get(taskId);
    if (!task || task.splittable !== false) continue;
    const total = list.reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
    if (list.length > 1 || total !== task.plannedMinutes) {
      violations.push({
        constraint: CONSTRAINT.H5,
        relatedIds: [task.id, ...list.map((block) => block.id)],
        message: `不可拆分任务「${task.title}」被拆成了 ${list.length} 段（合计 ${total} 分钟），而它要求一次安排 ${task.plannedMinutes} 分钟。`,
        details: { fragmentCount: list.length, total, plannedMinutes: task.plannedMinutes },
      });
    }
  }
}

function checkH6(studyBlocks, taskById, policy, violations) {
  for (const block of studyBlocks) {
    const length = block.endMinutes - block.startMinutes;
    if (!Number.isInteger(block.startMinutes) || !Number.isInteger(block.endMinutes) || length <= 0) {
      violations.push({
        constraint: CONSTRAINT.H6,
        date: block.date,
        relatedIds: [block.id],
        message: `学习时段的起止时间不合法（${block.startMinutes} → ${block.endMinutes}）。`,
      });
      continue;
    }
    if (block.endMinutes > MINUTES_PER_DAY) {
      violations.push({
        constraint: CONSTRAINT.H6,
        date: block.date,
        relatedIds: [block.id],
        message: `学习时段跨越了午夜结束（${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}），跨夜安排必须拆成两天分别记录。`,
      });
      continue;
    }
    const task = taskById.get(block.taskId);
    if (!task) continue;

    if (task.splittable === false) {
      if (length !== task.plannedMinutes) {
        violations.push({
          constraint: CONSTRAINT.H6,
          date: block.date,
          relatedIds: [task.id, block.id],
          message: `不可拆分任务「${task.title}」的时段长度为 ${length} 分钟，应当等于 ${task.plannedMinutes} 分钟。`,
        });
      }
      continue;
    }

    const min = Number.isInteger(task.minChunkMinutes) ? task.minChunkMinutes : policy?.defaultMinChunkMinutes ?? 30;
    const max = Number.isInteger(task.maxChunkMinutes) ? task.maxChunkMinutes : policy?.defaultMaxChunkMinutes ?? 60;
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    if (length > upper) {
      violations.push({
        constraint: CONSTRAINT.H6,
        date: block.date,
        relatedIds: [task.id, block.id],
        message: `「${task.title}」的时段长度为 ${length} 分钟，超过了最长时段 ${upper} 分钟。`,
        details: { length, upper },
      });
    } else if (length < lower) {
      const allowUndersized = policy?.allowUndersizedFinalChunk !== false && (block.undersized || block.plannedMinutes < lower);
      if (!allowUndersized) {
        violations.push({
          constraint: CONSTRAINT.H6,
          date: block.date,
          relatedIds: [task.id, block.id],
          message: `「${task.title}」的时段长度为 ${length} 分钟，短于最短时段 ${lower} 分钟。`,
          details: { length, lower },
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * H7 / H8 / H9 / H10
 * ------------------------------------------------------------------ */

function checkH7(studyBlocks, taskById, violations) {
  const byTask = groupBy(studyBlocks, (block) => block.taskId);
  const span = new Map();
  for (const [taskId, list] of byTask) {
    const starts = list.map((block) => block.startMinutes + ordinal(block.date) * MINUTES_PER_DAY);
    const ends = list.map((block) => block.endMinutes + ordinal(block.date) * MINUTES_PER_DAY);
    span.set(taskId, { first: Math.min(...starts), last: Math.max(...ends) });
  }

  for (const task of taskById.values()) {
    const own = span.get(task.id);
    if (!own) continue;
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = taskById.get(dependencyId);
      if (!dependency) continue;
      if (dependency.status === 'completed') continue; // 前置已完成，不构成时间上的先后要求

      const dependencySpan = span.get(dependencyId);
      if (!dependencySpan) {
        violations.push({
          constraint: CONSTRAINT.H7,
          relatedIds: [task.id, dependencyId],
          message: `「${task.title}」依赖「${dependency.title}」，但后者没有安排任何时段，因此前者不能被执行。`,
          details: { dependencyId },
        });
        continue;
      }
      if (own.first < dependencySpan.last) {
        violations.push({
          constraint: CONSTRAINT.H7,
          relatedIds: [task.id, dependencyId],
          message: `「${task.title}」的开始时间早于它的前置任务「${dependency.title}」的结束时间，违反了依赖关系。`,
          details: { dependentFirst: own.first, dependencyLast: dependencySpan.last },
        });
      }
    }
  }
}

function checkH8(restBlocks, bufferBlocks, violations) {
  const byDate = groupBy(restBlocks, (block) => block.date);
  for (const [date, rests] of byDate) {
    for (const rest of rests) {
      for (const buffer of bufferBlocks.filter((block) => block.date === date)) {
        const overlap = overlapLength(rest.startMinutes, rest.endMinutes, buffer.startMinutes, buffer.endMinutes);
        if (overlap > 0) {
          violations.push({
            constraint: CONSTRAINT.H8,
            date,
            relatedIds: [rest.id, buffer.id],
            message: `${date} 的计划休息与机动缓冲重叠了 ${overlap} 分钟，休息与缓冲必须分开统计。`,
            details: { overlap },
          });
        }
      }
    }
  }
  // 休息块之间也不应重叠（否则统计会重复计算）
  for (const [date, rests] of byDate) {
    const sorted = [...rests].sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 1; i < sorted.length; i += 1) {
      const overlap = overlapLength(sorted[i - 1].startMinutes, sorted[i - 1].endMinutes, sorted[i].startMinutes, sorted[i].endMinutes);
      if (overlap > 0) {
        violations.push({
          constraint: CONSTRAINT.H8,
          date,
          relatedIds: [sorted[i - 1].id, sorted[i].id],
          message: `${date} 的计划休息之间存在 ${overlap} 分钟重叠，统计会重复计算。`,
        });
      }
    }
  }
}

/**
 * H9 / H10：受保护的时段（已完成、锁定、进行中）必须原样保留。
 *
 * 这是"用户已经完成的学习事实"和"用户明确钉住的时间"的最后保障：
 * 任何候选计划如果丢掉了它们、改了它们的时间、或不必要地改动了它们的锁定状态，都判为违规。
 */
function checkH9H10(plan, sessions, violations) {
  const protectedSessions = (sessions ?? []).filter(
    (session) => session.state === 'completed' || session.locked === true || session.state === 'in_progress',
  );
  const byId = new Map(protectedSessions.map((session) => [session.id, session]));

  const inPlan = new Set();
  if (plan?.blocks) {
    for (const block of plan.blocks) {
      if (block.kind === 'study' && block.refId) inPlan.add(block.refId);
    }
  } else if (plan?.sessionIds) {
    for (const id of plan.sessionIds) inPlan.add(id);
  }

  for (const session of protectedSessions) {
    if (inPlan.size === 0) break; // 没有提供计划内容时不做这项检查（例如仅校验片段排布）
    if (!inPlan.has(session.id)) {
      violations.push({
        constraint: session.state === 'completed' ? CONSTRAINT.H9 : CONSTRAINT.H10,
        date: session.date,
        relatedIds: [session.id],
        message:
          session.state === 'completed'
            ? `已完成的学习时段（${session.date} ${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}）在候选计划中消失了。已完成记录必须始终保留。`
            : `已锁定/进行中的学习时段（${session.date} ${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}）在候选计划中消失了。锁定时段必须保留。`,
        details: { state: session.state, locked: session.locked },
      });
    }
  }

  return { protectedCount: byId.size, protectedIds: [...byId.keys()] };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 两个区间（同日坐标系）的重叠长度 */
function overlapLength(startA, endA, startB, endB) {
  const lo = Math.max(startA, startB);
  const hi = Math.min(endA, endB);
  return hi > lo ? hi - lo : 0;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function ordinal(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/** 供测试与诊断使用：把违规列表汇总成一行可读文本 */
export function describeViolations(violations) {
  return violations.map((violation) => `[${violation.constraint}] ${violation.message}`).join('\n');
}

export { sumLength, computeDayCapacity, addDays };
