/**
 * 计划业务服务：正式计划 / 候选计划 / 预览 / 版本链 / 撤销 的**唯一**写入口。
 *
 * 完整的产品闭环（阶段 2 起可用）：
 *
 *   用户操作 → requestPreview()  → 引擎生成候选计划 + 差异（pendingPreview，只读草稿）
 *            → 用户确认 → applyPreview()   → 重新校验过期 → 事务式写入正式计划 + 版本快照
 *            → 用户放弃 → discardPreview() → 正式计划与所有时段零改动
 *
 * 铁律（任何改动都不得破坏）：
 * 1. 只有用户确认后，正式计划才会被替换。
 * 2. 放弃预览时，正式计划与所有时段**零改动**。
 * 3. 应用候选计划前必须重新校验：基础版本或输入指纹变化时**拒绝应用**，要求重新生成预览。
 * 4. 撤销只回滚排程，不回滚"用户已经完成学习"这一事实：
 *    已完成的时段永远保留，且不能被改回未完成。
 * 5. 受保护时段（已完成 / 锁定 / 进行中）在候选计划中必须原样保留，否则拒绝应用。
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
import { addDays, wallTimeFromDateObject, weekday } from '../domain/time.js';
import { computeSchedulerInputHash, run as runScheduler } from '../engine/scheduler.js';
import { applyDraftOps, describeDraftOps } from '../domain/mutations.js';

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

  /**
   * 生成候选计划与差异预览（**不修改任何已保存的数据**）。
   *
   * @param {object} input
   * @param {{date: string, minutes: number}} input.now 当前本地墙上时间（由调用方注入，保证可测）
   * @param {Map<string, object>} [input.draft] 由 services 层构造的"变更后的草稿状态"
   *   （阶段 3 的任务/设置编辑会传入；不传则使用当前状态）
   * @param {string} [input.changeSummary] 变更摘要（写入版本历史）
   * @param {string} [input.trigger] 触发来源
   * @returns {{ok: boolean, preview?: object, issues?: object[], code?: string, result?: object}}
   */
  function requestPreview(input = {}) {
    // "现在"必须显式传入（引擎是纯函数）。未传时从状态容器的时钟推导，便于界面直接调用。
    const now = input.now ?? wallTimeFromDateObject(new Date(app.clock()));
    const baseState = app.getState();

    /**
     * 变更来源有两种：
     * - `ops`：数据变更描述（阶段 3 起界面统一走这条路），在内存里应用成草稿状态；
     * - `draft`：调用方直接给出完整草稿状态（引擎测试与内部调用使用）。
     * 无论哪种，**都不会修改已保存的数据**。
     */
    const ops = input.ops ?? [];
    let state = input.draft ?? baseState;
    let windowStart = input.windowStart ?? now.date;
    if (ops.length > 0) {
      const applied = applyDraftOps(baseState, ops, { idFactory, nowIso: nowIso() });
      if (!applied.ok) {
        return { ok: false, code: 'invalid_draft', status: 'invalid_input', issues: applied.issues ?? [], diagnostics: [] };
      }
      state = applied.state;
      const shift = ops.find((op) => op.kind === 'window.shift');
      if (shift?.windowStart) windowStart = shift.windowStart;
    }

    const current = getOfficialPlan();
    const baseVersion = current?.version ?? 0;
    // 基准指纹取**当前状态**的指纹（而不是旧计划里存的指纹）：
    // 这样"预览生成后数据又被改动"就能被精确检测出来。
    const baseInputHash = computeLiveInputHash(app.getState(), now);

    const windowDays = input.windowDays ?? 7;
    const engineResult = runScheduler({
      state,
      now,
      windowStart,
      windowDays,
      existingPlan: current,
      baseVersion: baseVersion + 1,
      planId: idFactory.next('plan'),
    });

    if (!engineResult.ok) {
      return {
        ok: false,
        code: engineResult.reason ?? 'engine_failed',
        status: engineResult.status,
        issues: engineResult.issues ?? [],
        diagnostics: engineResult.diagnostics ?? [],
        unscheduled: engineResult.unscheduled ?? [],
        result: engineResult,
      };
    }

    const candidate = { ...engineResult.plan, generatedAt: nowIso() };
    const summary = input.changeSummary ?? describeDraftOps(ops);
    const preview = {
      previewId: idFactory.next('preview'),
      baseVersion,
      baseInputHash,
      candidate,
      diff: engineResult.diff,
      risks: engineResult.risks,
      diagnostics: engineResult.diagnostics,
      unscheduled: engineResult.unscheduled,
      createdAt: nowIso(),
      changeSummary: summary,
      trigger: input.trigger ?? 'preview',
      /** 应用时需要一并写入的数据变更（确认之前一直只是草稿） */
      ops,
      /** 引擎产出的会话快照：应用时会据此创建/更新 StudySession */
      sessionPlan: buildSessionPlan(candidate, state),
    };

    const commitResult = app.commit((currentState) => ({ ...currentState, pendingPreview: preview }), { reason: 'preview-create' });
    if (!commitResult.ok) return { ok: false, error: commitResult.error, issues: [] };

    return { ok: true, preview, result: engineResult };
  }

  /**
   * 应用待确认的候选计划。
   *
   * 事务顺序（任一步失败都会保持现有数据不变）：
   *   1. 过期检测（基础版本 + 输入指纹）
   *   2. 结构校验 + 硬约束复检（防止预览生成后数据又变了）
   *   3. 受保护时段必须原样保留（H9 / H10）
   *   4. 一次性写入：正式计划 + 版本快照 + 时段同步
   */
  function applyPreview(input = {}) {
    const preview = getPendingPreview();
    if (!preview) {
      return { ok: false, issues: [error(C.REQUIRED, 'preview', '当前没有待确认的候选计划，无法应用。', {})] };
    }

    const current = getOfficialPlan();
    const currentVersion = current?.version ?? 0;

    if (preview.baseVersion !== currentVersion) {
      return stalePreview('基础版本已变化', preview.baseVersion, currentVersion);
    }

    // 过期检测的第二道关：**重新计算当前状态的输入指纹**，与预览记录的指纹比对。
    // 只比较 officialPlan.inputHash 是不够的——用户在预览生成后修改了任务（例如改截止时间）
    // 但还没有重新生成计划时，officialPlan 上存着的仍是旧指纹，会让过期预览"看起来有效"。
    const liveInputHash = computeLiveInputHash(app.getState(), input.now ?? null);
    if (preview.baseInputHash !== liveInputHash) {
      return stalePreview('生成预览后任务或设置发生了变化', preview.baseInputHash, liveInputHash);
    }

    const validation = validatePlan(preview.candidate, 'candidate');
    if (!validation.ok) return { ok: false, issues: validation.issues };

    const state = app.getState();
    const protectedIssue = checkProtectedSessions(preview.sessionPlan, state.sessions ?? []);
    if (protectedIssue) return { ok: false, issues: [protectedIssue] };

    // 重放草稿变更：这是"确认后写入"的关键一步。失败即整体放弃，绝不留半应用状态。
    const replayed = applyDraftOps(state, preview.ops ?? [], { idFactory, nowIso: nowIso() });
    if (!replayed.ok) {
      return {
        ok: false,
        code: 'draft_replay_failed',
        issues: [
          error(C.MIGRATION_FAILED, 'preview.ops', `无法应用候选计划中的数据变更：${replayed.issues?.[0]?.message ?? '未知原因'}`, {}),
          ...(replayed.issues ?? []),
        ],
      };
    }
    const nextState = replayed.state;

    const snapshot = current ? createPlanSnapshot({ plan: current, nowIso: nowIso(), changeSummary: lastMutationSummary(current), trigger: preview.trigger }) : null;

    const commitResult = app.commit(
      () => {
        const history = snapshot ? [snapshot, ...nextState.planHistory] : [...nextState.planHistory];
        return {
          ...nextState,
          sessions: preview.sessionPlan,
          officialPlan: { ...preview.candidate, version: preview.candidate.version },
          planHistory: history.slice(0, historyLimit),
          pendingPreview: null,
          meta: {
            ...nextState.meta,
            lastPlanMutation: { at: nowIso(), summary: preview.changeSummary ?? '应用计划', trigger: preview.trigger ?? 'preview-confirm' },
            initialWindowStart: preview.candidate.windowStart,
          },
        };
      },
      { reason: 'plan-apply-preview' },
    );
    if (!commitResult.ok) return { ok: false, error: commitResult.error, issues: [] };

    return { ok: true, plan: getOfficialPlan(), applied: preview };
  }

  /** 放弃候选计划：只清理 pendingPreview，正式计划与所有时段零改动 */
  function discardPreview() {
    if (!getPendingPreview()) {
      return { ok: false, issues: [error(C.REQUIRED, 'preview', '当前没有待确认的候选计划。', {})] };
    }
    const commitResult = app.commit((state) => ({ ...state, pendingPreview: null }), { reason: 'preview-discard' });
    if (!commitResult.ok) return { ok: false, error: commitResult.error, issues: [] };
    return { ok: true };
  }

  /** 当前风险清单（优先取预览里的结果，否则不重算，避免界面误以为"风险已刷新"） */
  function currentRisks() {
    const preview = getPendingPreview();
    if (preview) return { source: 'preview', risks: preview.risks ?? [] };
    return { source: 'none', risks: [] };
  }


  /**
   * 重新计算"当前状态"的输入指纹，用于过期检测。
   *
   * 直接复用引擎导出的 `computeSchedulerInputHash`，保证服务层与引擎的指纹口径**完全一致**：
   * 任何会影响排程的数据变化都会在这里体现出来，过期预览因此无法被应用。
   */
  function computeLiveInputHash(state, now = null) {
    const nowWall = now ?? wallTimeFromDateObject(new Date(app.clock()));
    return computeSchedulerInputHash({
      state,
      now: nowWall,
      windowStart: state.officialPlan?.windowStart ?? nowWall.date,
      windowEnd: state.officialPlan?.windowEnd ?? addDays(nowWall.date, 6),
      engineVersion: state.officialPlan?.engineVersion ?? 'engine@1.0.0',
      completedByTask: {},
    });
  }

  /** 过期预览的错误结果（统一文案，便于界面直接展示） */
  function stalePreview(reason, expected, actual) {
    return {
      ok: false,
      code: 'stale_preview',
      issues: [
        error(
          C.ENTITY_OVERLAP,
          'plan.version',
          `预览已过期：${reason}（预览基于 v${expected}，当前为 v${actual}）。为保护你的数据，本次应用已取消，请重新生成预览。`,
          { expected, actual, reason },
        ),
      ],
    };
  }

  /** 受保护时段（已完成 / 锁定 / 进行中）必须逐字段保留 */
  function checkProtectedSessions(nextSessions, previousSessions) {
    const previousById = new Map(previousSessions.map((session) => [session.id, session]));
    const nextById = new Map((nextSessions ?? []).map((session) => [session.id, session]));

    for (const session of previousSessions) {
      const mustKeep = session.state === SESSION_STATE.COMPLETED || session.locked === true || session.state === SESSION_STATE.IN_PROGRESS;
      if (!mustKeep) continue;
      const next = nextById.get(session.id);
      if (!next) {
        return error(
          session.state === SESSION_STATE.COMPLETED ? C.ENTITY_DANGLING_REF : C.ENTITY_DANGLING_REF,
          'sessions',
          session.state === SESSION_STATE.COMPLETED
            ? `已完成的学习时段（${session.date}）在本次计划中消失了，已取消应用以保护你的学习记录。`
            : `锁定的学习时段（${session.date}）在本次计划中消失了，已取消应用。请先解除锁定再重新规划。`,
          { sessionId: session.id, state: session.state, locked: session.locked },
        );
      }
      if (next.date !== session.date || next.startMinutes !== session.startMinutes || next.endMinutes !== session.endMinutes) {
        return error(
          C.ENTITY_OVERLAP,
          'sessions',
          session.state === SESSION_STATE.COMPLETED
            ? '已完成的学习时段被移动了位置，已取消应用以保护历史记录。'
            : '锁定的学习时段被移动了位置，已取消应用。锁定是硬约束，不会自动改动。',
          { sessionId: session.id },
        );
      }
      void previousById;
    }
    return null;
  }

  /**
   * 根据候选计划构造新的时段集合。
   *
   * 规则：
   * - 受保护时段（已完成 / 锁定 / 进行中）原样保留，不重建。
   * - 窗口内其它旧时段（flexible）在本次排程中被替换 → 标记为 cancelled（保留记录，不物理删除）。
   * - 候选计划中的新学习块 → 创建 StudySession（state=flexible，source=engine，带 reasonCodes）。
   */
  function buildSessionPlan(candidate, draftState) {
    const existing = draftState.sessions ?? [];
    const protectedIds = new Set(
      existing
        .filter((session) => session.state === SESSION_STATE.COMPLETED || session.locked === true || session.state === SESSION_STATE.IN_PROGRESS)
        .map((session) => session.id),
    );
    // 只有"受保护"的既有会话才需要在候选计划的块里被跳过；
    // 候选计划里其它块都是本次新排出来的，必须创建对应的 StudySession。
    const reservedIds = protectedIds;

    // 保留三类记录：
    // 1) 受保护时段（已完成 / 锁定 / 进行中）——绝不改动；
    // 2) 窗口之外的时段——窗口滚动时它们不属于本次重排范围；
    // 3) 已经取消的时段——历史记录，不再参与排程。
    const kept = existing.filter(
      (session) => protectedIds.has(session.id) || !isInWindow(session, candidate) || session.state === SESSION_STATE.CANCELLED,
    );
    const superseded = existing
      .filter((session) => !protectedIds.has(session.id) && isInWindow(session, candidate) && session.state !== SESSION_STATE.CANCELLED)
      .map((session) => ({ ...session, state: SESSION_STATE.CANCELLED, locked: false, updatedAt: nowIso() }));

    const created = (candidate.blocks ?? [])
      .filter((block) => block.kind === BLOCK_KIND.STUDY && block.refId && !reservedIds.has(block.refId) && !protectedIds.has(block.refId))
      .map((block) => ({
        id: block.refId,
        taskId: block.taskId,
        date: block.date,
        startMinutes: block.startMinutes,
        endMinutes: block.endMinutes,
        plannedMinutes: block.endMinutes - block.startMinutes,
        actualMinutes: null,
        state: SESSION_STATE.FLEXIBLE,
        locked: false,
        source: 'engine',
        reasonCodes: [...(block.meta?.reasons ?? [])],
        planVersion: candidate.version,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        startedAt: null,
        completedAt: null,
        history: [],
      }));

    return [...kept, ...superseded, ...created];
  }

  function isInWindow(session, plan) {
    return session.date >= plan.windowStart && session.date <= plan.windowEnd;
  }

  return {
    requestPreview,
    applyPreview,
    discardPreview,
    currentRisks,
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
