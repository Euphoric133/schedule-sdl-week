/**
 * 任务拆分：把剩余工作量切成可以放进时间槽的学习片段。
 *
 * 硬性规则（对应 H5 / H6）：
 * - **不可拆分任务**只能产生一个片段，且分钟数必须等于剩余工作量；放不下就报告放不下，
 *   绝不为了"排进去"而把它切开。
 * - **可拆分任务**的每个正常片段都必须满足 `[minChunkMinutes, maxChunkMinutes]`。
 * - 尾差（剩余不足最小时段）优先通过"均匀切分"消除；确实无法合法切分时，保留合法头部，
 *   把不合法尾部按原因码交回调度器报告（绝不静默丢弃工作量，也绝不生成非法片段）。
 * - 唯一允许的"偏短片段"例外：整个计划的收尾片段，且必须由设置
 *   `allowUndersizedFinalChunk` 明确开启（默认开启）。该例外会写入诊断，用户可见。
 *
 * 片段数量有安全上界（默认 24），避免异常输入产生成千上万个片段拖垮界面与存储。
 */

/** 拆分结果状态 */
export const SPLIT_STATUS = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty', // 没有剩余工作量
  ATOMIC_TOO_LONG: 'atomic_too_long', // 不可拆分任务超过允许的最大时长
  UNSPLITTABLE_TAIL: 'unsplittable_tail', // 尾部余量无法合法放置
  TOO_MANY_FRAGMENTS: 'too_many_fragments', // 片段数超过安全上界
});

export const DEFAULT_MAX_FRAGMENTS_PER_TASK = 24;

/**
 * 拆分一个任务。
 *
 * @param {object} task
 * @param {object} params
 * @param {number} params.remainingMinutes 剩余工作量（由 domain/task.js 的推导函数算出）
 * @param {object} params.policy 由 engine/policy.js 的 buildPolicy 生成
 * @param {number} [params.maxFragmentsPerTask]
 * @returns {{status: string, fragments: Array<object>, tailMinutes: number, message: string|null, undersizedFinalAllowed: boolean}}
 */
export function splitTask(task, { remainingMinutes, policy, maxFragmentsPerTask = DEFAULT_MAX_FRAGMENTS_PER_TASK }) {
  const remaining = Math.max(0, Math.round(remainingMinutes ?? 0));
  if (remaining === 0) {
    return { status: SPLIT_STATUS.EMPTY, fragments: [], tailMinutes: 0, message: null, undersizedFinalAllowed: false };
  }

  if (task.splittable === false) {
    return splitAtomicTask(task, remaining, policy);
  }
  return splitSplittableTask(task, remaining, policy, maxFragmentsPerTask);
}

/** 不可拆分任务：一个片段，分钟数等于剩余工作量 */
function splitAtomicTask(task, remaining, policy) {
  if (remaining > policy.nonSplittableMaxMinutes) {
    return {
      status: SPLIT_STATUS.ATOMIC_TOO_LONG,
      fragments: [],
      tailMinutes: remaining,
      message: `不可拆分任务的剩余工作量（${remaining} 分钟）超过了允许的最长时长（${policy.nonSplittableMaxMinutes} 分钟）。请改小任务，或允许它拆分。`,
      undersizedFinalAllowed: false,
    };
  }
  return {
    status: SPLIT_STATUS.OK,
    fragments: [makeFragment(task.id, remaining, 0, true, remaining < policy.nonSplittableMinMinutes)],
    tailMinutes: 0,
    message: null,
    undersizedFinalAllowed: remaining < policy.nonSplittableMinMinutes,
  };
}

/**
 * 可拆分任务的切分策略。
 *
 * 核心问题是**尾差**：`剩余量 % 最长时长` 常常小于最短时长（例如 130 分钟、最短 30 / 最长 60，
 * 贪心切出 [60, 60, 10]，最后一段 10 分钟不合法）。处理顺序：
 *
 *   1. 整块能作为一段放下（长度在 [min, max] 内）→ 一段。
 *   2. 整块短于最短时长 → 按 `allowUndersizedFinalChunk` 决定是"作为收尾片段"还是报错。
 *   3. 能切成全合法的 N 段 → 均匀切分（段数最少，减少碎片与科目切换）。
 *   4. 只能切成"合法头部 + 偏短收尾" → 允许时采用并标记；不允许时报告 tailMinutes。
 */
function splitSplittableTask(task, remaining, policy, maxFragmentsPerTask) {
  // 片段长度限制：优先用任务自身设置，缺失时退回默认值。
  // min > max 属于非法数据（由 domain/task.js 的 V010 拦截），这里兜底避免死循环。
  const rawMin = Number.isInteger(task.minChunkMinutes) && task.minChunkMinutes > 0 ? task.minChunkMinutes : policy.defaultMinChunkMinutes;
  const rawMax = Number.isInteger(task.maxChunkMinutes) && task.maxChunkMinutes > 0 ? task.maxChunkMinutes : policy.defaultMaxChunkMinutes;
  const minChunk = Math.max(5, Math.min(rawMin, rawMax));
  const maxChunk = Math.max(minChunk, rawMax);

  // 情况 1：整块放在一段里
  if (remaining <= maxChunk && remaining >= minChunk) {
    return {
      status: SPLIT_STATUS.OK,
      fragments: [makeFragment(task.id, remaining, 0, true, false)],
      tailMinutes: 0,
      message: null,
      undersizedFinalAllowed: false,
    };
  }

  // 情况 2：整块短于最短时长
  if (remaining < minChunk) {
    if (policy.allowUndersizedFinalChunk) {
      return {
        status: SPLIT_STATUS.OK,
        fragments: [makeFragment(task.id, remaining, 0, true, true)],
        tailMinutes: 0,
        message: null,
        undersizedFinalAllowed: true,
      };
    }
    return {
      status: SPLIT_STATUS.UNSPLITTABLE_TAIL,
      fragments: [],
      tailMinutes: remaining,
      message: `该任务总时长 ${remaining} 分钟，短于最短学习时段（${minChunk} 分钟）。请调小最短时段，或把它并入其它任务。`,
      undersizedFinalAllowed: false,
    };
  }

  // 情况 3：能切成全合法的 N 段 → 均匀切分
  const segments = findSegmentCount(remaining, minChunk, maxChunk);
  if (segments > 0) {
    if (segments > maxFragmentsPerTask) {
      return {
        status: SPLIT_STATUS.TOO_MANY_FRAGMENTS,
        fragments: [],
        tailMinutes: remaining,
        message: `该任务需要拆成 ${segments} 段，超过安全上界 ${maxFragmentsPerTask}。请调整最短/最长学习时段。`,
        undersizedFinalAllowed: false,
      };
    }
    return {
      status: SPLIT_STATUS.OK,
      fragments: distributeEvenly(task.id, remaining, segments, minChunk, maxChunk),
      tailMinutes: 0,
      message: null,
      undersizedFinalAllowed: false,
    };
  }

  // 情况 4：合法头部 + 偏短收尾
  const headCount = Math.floor(remaining / maxChunk);
  const tail = remaining - headCount * maxChunk;
  const fragments = [];
  for (let i = 0; i < headCount; i += 1) fragments.push(makeFragment(task.id, maxChunk, i, false, false));

  if (policy.allowUndersizedFinalChunk && headCount + 1 <= maxFragmentsPerTask) {
    fragments.push(makeFragment(task.id, tail, headCount, true, true));
    return {
      status: SPLIT_STATUS.OK,
      fragments,
      tailMinutes: 0,
      message: null,
      undersizedFinalAllowed: true,
    };
  }

  // 不允许偏短收尾：头部标为最终片段，尾部如实交回调度器报告
  return {
    status: SPLIT_STATUS.UNSPLITTABLE_TAIL,
    fragments: fragments.map((fragment, index) => ({ ...fragment, isFinal: index === headCount - 1 })),
    tailMinutes: tail,
    message: `有 ${tail} 分钟的余量小于最短学习时段（${minChunk} 分钟），在当前设置下无法合法安排。可以调小最短时段，或把这部分时间调整到其它任务上。`,
    undersizedFinalAllowed: false,
  };
}

/**
 * 找出能把 `total` 分钟切成每段都在 [min, max] 的**最少段数**；找不到返回 0。
 * 段数越少，碎片与科目切换越少，因此优先最少段。
 */
function findSegmentCount(total, min, max) {
  const lower = Math.max(1, Math.ceil(total / max));
  const upper = Math.floor(total / min);
  for (let count = lower; count <= upper; count += 1) {
    const base = Math.floor(total / count);
    const remainder = total - base * count;
    const largest = remainder > 0 ? base + 1 : base;
    if (base >= min && largest <= max) return count;
  }
  return 0;
}

/** 把 total 均分为 count 段：前 remainder 段各多 1 分钟，保证总和精确等于 total */
function distributeEvenly(taskId, total, count, min, max) {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  const fragments = [];
  for (let i = 0; i < count; i += 1) {
    const minutes = i < remainder ? base + 1 : base;
    // findSegmentCount 已保证合法；这里只做防御性断言，避免静默产出非法片段
    if (minutes < min || minutes > max) return [makeFragment(taskId, total, 0, true, false)];
    fragments.push(makeFragment(taskId, minutes, i, i === count - 1, false));
  }
  return fragments;
}

function makeFragment(taskId, minutes, index, isFinal, undersized) {
  return { taskId, minutes, index, isFinal: Boolean(isFinal), undersized: Boolean(undersized) };
}

/**
 * 批量拆分多个任务。
 *
 * @param {Array<{task: object, remainingMinutes: number}>} entries
 * @param {object} options { policy, maxFragmentsPerTask }
 * @returns {{fragments: Array, failures: Array<{taskId: string, status: string, tailMinutes: number, message: string}>}}
 */
export function splitAll(entries, options) {
  const fragments = [];
  const failures = [];
  for (const entry of entries) {
    const result = splitTask(entry.task, { remainingMinutes: entry.remainingMinutes, ...options });
    if (result.status === SPLIT_STATUS.OK) {
      fragments.push(...result.fragments);
    } else if (result.status !== SPLIT_STATUS.EMPTY) {
      failures.push({ taskId: entry.task.id, status: result.status, tailMinutes: result.tailMinutes, message: result.message });
    }
  }
  return { fragments, failures };
}

/** 校验拆分结果是否守恒（Σ 片段 = 剩余工作量），供测试与硬约束校验器使用 */
export function fragmentsConserveWorkload(fragments, remainingMinutes) {
  const total = fragments.reduce((sum, fragment) => sum + fragment.minutes, 0);
  return total === Math.max(0, Math.round(remainingMinutes ?? 0));
}
