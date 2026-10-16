/**
 * 计划业务服务：正式计划 / 候选计划 / 版本链 / 撤销 的**唯一**写入口。
 *
 * 当前阶段（阶段 1）说明：
 * - 排程引擎尚未实现（阶段 2），因此这里只提供"已经算好的计划"的写入、校验、统计与撤销能力。
 * - 预览（候选计划 + 差异）的数据结构见 domain/plan.js 与本文件的 note 说明；
 *   完整的 requestPreview / applyPreview / discardPreview 会在阶段 2 接入引擎后实现，
 *   届时本文件是唯一改动点，UI 不受影响。
 *
 * 铁律（在阶段 2/3 接入引擎时必须继续成立）：
 * 1. 只有用户确认后，正式计划才会被替换。
 * 2. 放弃预览时，正式计划与所有时段**零改动**。
 * 3. 应用候选计划前必须重新校验（防止预览生成后数据又变化）。
 * 4. 撤销只回滚排程，不回滚"用户已经完成学习"这一事实：
 *    已完成的时段永远保留，且不能被改回未完成。
 */

import {
  PLAN_STATUS,
  computePlanMetrics,
  createPlanSnapshot,
  createEmptyPlan,
  emptyDayMetrics,
  planWindow,
  validatePlan,
} from '../domain/plan.js';
import { BLOCK_KIND, groupBlocksByDate } from '../domain/calendarBlock.js';
import { SESSION_STATE, isLockedForScheduling } from '../domain/session.js';
import { PLAN_HISTORY_LIMIT } from '../domain/schemas.js';
import { VALIDATION_CODES as C, error, result } from '../domain/validation.js';
import { addDays, weekday } from '../domain/time.js';

/**
 * @param {object} options
 * @param {object} options.app 应用状态容器（见 appState.js 的 createAppState）
 * @param {{ next: (kind: string) => string }} options.idFactory
 */
export function createPlanService({ app, idFactory }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createPlanService 需要 app 状态容器');
  if (!idFactory || typeof idFactory.next !== 'function') throw new TypeError('createPlanService 需要 idFactory');

  const nowIso = () => app.clock();
  const historyLimit = app.planHistoryLimit ?? PLAN_HISTORY_LIMIT;

  /** 读取"产生当前正式计划的那次变更"的摘要，用于版本历史条目 */
  function lastMutationSummary(fallbackPlan) {
    const fromMeta = app.getState()?.meta?.lastPlanMutation?.summary;
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
    return fallbackPlan?.generatedAt ? '（更早的变更）' : null;
  }

  function getOfficialPlan() {
    return app.getState()?.officialPlan ?? null;
  }

  function getHistory() {
    return app.getState()?.planHistory ?? [];
  }

  function getPendingPreview() {
    return app.getState()?.pendingPreview ?? null;
  }

  /**
   * 生成候选计划对象（由块集合与每日容量明细构造）。
   * 引擎（阶段 2）会调用本函数把结果包装成完整的 SchedulePlan。
   */
  function buildCandidatePlan({
    blocks,
    windowStart,
    days = 7,
    status = PLAN_STATUS.FEASIBLE,
    unscheduled = [],
    diagnostics = [],
    dayCapacities = [],
    inputHash = null,
    policyHash = null,
    engineVersion,
    version,
  }) {
    const window = planWindow(windowStart, days);
    const capacityByDate = new Map(dayCapacities.map((c) => [c.date, c]));
    const blockStats = aggregateBlocksByDate(blocks);

    const dayList = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDays(window.startDate, i);
      const capacity = capacityByDate.get(date);
      const stats = blockStats.get(date) ?? { studyMinutes: 0, restMinutes: 0, bufferMinutes: 0, sessionCount: 0 };
      const base = capacity ? { ...emptyDayMetrics(date), ...capacity } : emptyDayMetrics(date);
      dayList.push({
        ...base,
        date,
        weekday: weekday(date),
        studyMinutes: stats.studyMinutes,
        restMinutes: stats.restMinutes,
        bufferMinutes: stats.bufferMinutes,
        sessionCount: stats.sessionCount,
        overloadMinutes: Math.max(0, (capacity?.overloadMinutes ?? 0)),
      });
    }

    const metrics = computePlanMetrics(blocks);
    metrics.totalTaskRemainingMinutes = unscheduled.reduce((sum, u) => sum + (u.remainingMinutes ?? 0), 0);

    return {
      planId: idFactory.next('plan'),
      version: Number.isInteger(version) ? version : (getOfficialPlan()?.version ?? 0) + 1,
      status,
      generatedAt: nowIso(),
      windowStart: window.startDate,
      windowEnd: window.endDate,
      engineVersion: engineVersion ?? 'engine@0.1.0',
      policyHash,
      inputHash,
      blocks,
      sessionIds: blocks.filter((b) => b.kind === BLOCK_KIND.STUDY && b.refId).map((b) => b.refId),
      days: dayList,
      unscheduled,
      diagnostics,
      metrics,
    };
  }

  /** 把块按日期聚合为统计（供 buildCandidatePlan 与 UI 预览使用） */
  function aggregateBlocksByDate(blocks) {
    const byDate = groupBlocksByDate(blocks);
    const out = new Map();
    for (const [date, list] of byDate) {
      const stats = { studyMinutes: 0, restMinutes: 0, bufferMinutes: 0, sessionCount: 0 };
      for (const block of list) {
        const length = block.endMinutes - block.startMinutes;
        if (block.kind === BLOCK_KIND.STUDY) {
          stats.studyMinutes += length;
          stats.sessionCount += 1;
        } else if (block.kind === BLOCK_KIND.REST) {
          stats.restMinutes += length;
        } else if (block.kind === BLOCK_KIND.BUFFER) {
          stats.bufferMinutes += length;
        }
      }
      out.set(date, stats);
    }
    return out;
  }

  /**
   * 应用一份计划为正式计划（候选计划 → 正式计划）。
   *
   * @param {object} candidate 已构造好的 SchedulePlan
   * @param {object} [options]
   * @param {string} options.changeSummary 变更摘要（会显示在版本历史中）
   * @param {string} [options.trigger] 触发来源（manual / preview-confirm / window-roll ...）
   * @param {number|null} [options.expectedBaseVersion] 若提供，则校验正式计划版本未被改动
   * @param {string|null} [options.expectedInputHash] 若提供，则校验输入指纹未变化（预览过期检测）
   */
  function applyPlan(candidate, options = {}) {
    const { changeSummary = '应用计划', trigger = 'manual', expectedBaseVersion = null, expectedInputHash = null } = options;
    const current = getOfficialPlan();

    // 1) 预览过期检测：基础版本或输入指纹变化时，拒绝应用，绝不覆盖新数据
    if (expectedBaseVersion !== null && current && current.version !== expectedBaseVersion) {
      return {
        ok: false,
        code: 'stale_preview',
        issues: [
          error(
            C.ENTITY_OVERLAP,
            'plan.version',
            `预览已过期：它基于版本 v${expectedBaseVersion}，而当前正式计划是 v${current.version}。请重新生成预览后再确认。`,
            { expectedBaseVersion, actualVersion: current.version },
          ),
        ],
      };
    }
    if (expectedInputHash !== null && current && current.inputHash !== null && current.inputHash !== expectedInputHash) {
      return {
        ok: false,
        code: 'stale_preview',
        issues: [
          error(C.ENTITY_OVERLAP, 'plan.inputHash', '预览已过期：生成预览后任务或设置发生了变化。请重新生成预览。', {
            expectedInputHash,
            actualInputHash: current.inputHash,
          }),
        ],
      };
    }
    if (expectedBaseVersion !== null && !current && expectedBaseVersion !== 0) {
      return {
        ok: false,
        code: 'stale_preview',
        issues: [error(C.REQUIRED, 'plan', '当前没有正式计划，但预览声称基于某个版本。请重新生成预览。', { expectedBaseVersion })],
      };
    }

    // 2) 结构校验（应用前的最后一道防线）
    const validation = validatePlan(candidate, 'candidate');
    if (!validation.ok) return { ok: false, issues: validation.issues };

    // 3) 硬约束保护：已完成的时段必须原样保留（H9）
    const sessions = app.getState().sessions ?? [];
    const completed = sessions.filter((s) => s.state === SESSION_STATE.COMPLETED);
    const planSessionIds = new Set(candidate.sessionIds ?? []);
    const missingCompleted = completed.filter((s) => !planSessionIds.has(s.id));
    if (missingCompleted.length > 0) {
      return {
        ok: false,
        issues: [
          error(
            C.ENTITY_DANGLING_REF,
            'plan.sessionIds',
            `候选计划缺少 ${missingCompleted.length} 个已完成的学习时段。已完成记录必须始终保留在计划中。`,
            { sessionIds: missingCompleted.map((s) => s.id) },
          ),
        ],
      };
    }

    // 4) 写入：先追加历史快照，再替换正式计划（同一事务内完成）
    //
    // 快照记录的是"被替换掉的那份计划"，因此它的事件摘要应当来自**产生该计划的**那次变更
    // （meta.lastPlanMutation），而不是本次变更——否则版本历史里每个条目的说明都会错位成后一次操作。
    const snapshot = current
      ? createPlanSnapshot({
          plan: current,
          nowIso: nowIso(),
          changeSummary: lastMutationSummary(current) ?? '（未记录变更说明）',
          trigger,
        })
      : null;

    const commitResult = app.commit(
      (state) => {
        const history = snapshot ? [snapshot, ...state.planHistory] : [...state.planHistory];
        return {
          ...state,
          officialPlan: { ...candidate, version: candidate.version },
          planHistory: history.slice(0, historyLimit),
          pendingPreview: null,
          meta: { ...state.meta, lastPlanMutation: { at: nowIso(), summary: changeSummary, trigger } },
        };
      },
      { reason: 'plan-apply' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };

    return { ok: true, plan: getOfficialPlan(), snapshotCreated: Boolean(snapshot) };
  }

  /**
   * 撤销上一次应用：恢复上一个历史快照。
   *
   * 注意两点有意为之的行为：
   * 1. 版本号**继续递增**，不重用回退的数字。否则"v7 撤回到 v6，然后又改了数据变成 v7"
   *    会让版本号指向两份不同的计划，破坏"预览过期检测"与用户对版本号的信赖。
   * 2. 撤销被拒绝的情形：本次撤销会覆盖用户新完成的学习记录时（即快照之后又有新的已完成时段）。
   */
  function undoLastApply() {
    const current = getOfficialPlan();
    const [latest, ...rest] = getHistory();
    if (!current || !latest) {
      return { ok: false, issues: [error(C.REQUIRED, 'planHistory', '没有可以撤销的计划版本。', {})] };
    }

    const sessions = app.getState().sessions ?? [];
    const restoredIds = new Set(latest.plan?.sessionIds ?? []);
    const newlyCompleted = sessions.filter((s) => s.state === SESSION_STATE.COMPLETED && !restoredIds.has(s.id));
    if (newlyCompleted.length > 0) {
      return {
        ok: false,
        issues: [
          error(
            C.ENTITY_DANGLING_REF,
            'planHistory',
            `无法撤销：撤销后会让 ${newlyCompleted.length} 个已完成的学习记录从计划中消失。请先处理这些记录（或不要撤销）。`,
            { sessionIds: newlyCompleted.map((s) => s.id) },
          ),
        ],
      };
    }

    const restored = { ...latest.plan, version: current.version + 1, generatedAt: nowIso() };
    const commitResult = app.commit(
      (state) => ({
        ...state,
        officialPlan: restored,
        planHistory: rest,
        pendingPreview: null,
        meta: { ...state.meta, lastPlanMutation: { at: nowIso(), summary: `撤销到 v${latest.version}`, trigger: 'undo' } },
      }),
      { reason: 'plan-undo' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error };

    return { ok: true, plan: restored, undoneFrom: current.version, restoredFrom: latest.version };
  }

  /** 版本历史视图（不含完整快照，减小内存与渲染开销） */
  function listVersions() {
    const current = getOfficialPlan();
    return [
      ...(current ? [{ version: current.version, createdAt: current.generatedAt, summary: '当前正式计划', trigger: 'current', current: true }] : []),
      ...getHistory().map((h) => ({
        version: h.version,
        createdAt: h.createdAt,
        summary: h.changeSummary,
        trigger: h.trigger,
        current: false,
      })),
    ];
  }

  /** 计划尚未建立时，给出一个空的展示占位（不是"假计划"，所有统计为 0） */
  function ensureDisplayPlan(windowStart) {
    const current = getOfficialPlan();
    if (current) return current;
    return createEmptyPlan({
      planId: idFactory.next('plan'),
      version: 0,
      windowStart,
      nowIso: nowIso(),
    });
  }

  /** 删除本地历史版本（用于释放存储空间；不影响当前正式计划与任何时段） */
  function clearHistory() {
    const commitResult = app.commit((state) => ({ ...state, planHistory: [] }), { reason: 'plan-history-clear' });
    if (!commitResult.ok) return { ok: false, error: commitResult.error };
    return { ok: true };
  }

  /**
   * 判断某个时段是否受保护（不可被自动排程改动）。
   * 供 UI 显示锁定图标、以及阶段 2 引擎的保留集合构建使用。
   */
  function isSessionProtected(session) {
    return isLockedForScheduling(session);
  }

  /** 计划是否包含未安排任务（界面用于提示"部分可行"的原因） */
  function unscheduledSummary(plan) {
    const list = plan?.unscheduled ?? [];
    return {
      count: list.length,
      totalMinutes: list.reduce((sum, u) => sum + (u.remainingMinutes ?? 0), 0),
      reasons: [...new Set(list.map((u) => u.reasonCode))],
    };
  }

  return {
    getOfficialPlan,
    getHistory,
    getPendingPreview,
    buildCandidatePlan,
    applyPlan,
    undoLastApply,
    listVersions,
    ensureDisplayPlan,
    clearHistory,
    isSessionProtected,
    unscheduledSummary,
    /** 供测试与 UI 复用的空校验结果 */
    emptyResult: () => result([]),
  };
}
