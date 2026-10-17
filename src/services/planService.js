/**
 * 计划业务服务：正式计划 / 候选计划 / 预览 / 版本链 / 撤销 的**唯一**写入口。
 *
 * 完整的产品闭环：
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
import { applyDraftOps, describeDraftOps, evaluateCleanupImpact } from '../domain/mutations.js';
import { diffPlans } from '../engine/diff.js';

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
   * 引擎会调用本函数把结果包装成完整的 SchedulePlan。
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
   * 供界面显示锁定图标、以及引擎构建保留集合时使用。
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
   *   （任务/设置编辑会传入；不传则使用当前状态）
   * @param {string} [input.changeSummary] 变更摘要（写入版本历史）
   * @param {string} [input.trigger] 触发来源
   * @returns {{ok: boolean, preview?: object, issues?: object[], code?: string, result?: object}}
   */
  /**
   * 把界面传来的开始时间规整成引擎要的形状。
   *
   * 接受：`{ date, minutes }` 或 `'HH:mm'` 字符串（界面用的是 time 输入框）。
   * 不合法时返回 null，让引擎走默认规则——绝不把非法值塞进排程。
   */
  function normalizeStartAt(startAt) {
    if (!startAt) return null;
    if (typeof startAt === 'string') {
      const match = /^(\d{2}):(\d{2})$/.exec(startAt.trim());
      if (!match) return null;
      const minutes = Number(match[1]) * 60 + Number(match[2]);
      return minutes >= 0 && minutes <= 1440 ? { minutes } : null;
    }
    if (typeof startAt === 'object' && Number.isInteger(startAt.minutes)) return startAt;
    return null;
  }

  function requestPreview(input = {}) {
    // "现在"必须显式传入（引擎是纯函数）。未传时从状态容器的时钟推导，便于界面直接调用。
    const now = input.now ?? wallTimeFromDateObject(new Date(app.clock()));
    const baseState = app.getState();

    /**
     * 变更来源有两种：
     * - `ops`：数据变更描述（界面统一走这条路），在内存里应用成草稿状态；
     * - `draft`：调用方直接给出完整草稿状态（引擎测试与内部调用使用）。
     * 无论哪种，**都不会修改已保存的数据**。
     */
    const ops = input.ops ?? [];
    let state = input.draft ?? baseState;
    let windowStart = input.windowStart ?? now.date;
    let draftCreatedTaskIds = [];
    if (ops.length > 0) {
      const baseTaskIds = new Set((baseState.tasks ?? []).map((task) => task.id));
      const applied = applyDraftOps(baseState, ops, { idFactory, nowIso: nowIso() });
      if (!applied.ok) {
        return { ok: false, code: 'invalid_draft', status: 'invalid_input', issues: applied.issues ?? [], diagnostics: [] };
      }
      state = applied.state;
      // 记录草稿阶段"新建任务"的 ID：确认应用时会用同一顺序的新 ID 覆盖它们
      draftCreatedTaskIds = (state.tasks ?? []).filter((task) => !baseTaskIds.has(task.id)).map((task) => task.id);
      const shift = ops.find((op) => op.kind === 'window.shift');
      if (shift?.windowStart) windowStart = shift.windowStart;
    }

    /**
     * "先新建任务"的引导放在这里，而不是引擎里。
     *
     * 只有**用户主动生成计划**（没有携带任何数据变更）且一个任务都没有时才拦截；
     * 删除任务这类携带变更的操作必须照常生成候选计划，
     * 否则会出现"删不掉最后一个任务"的死角。
     */
    if (ops.length === 0 && (state.tasks ?? []).length === 0) {
      return {
        ok: false,
        code: 'no_tasks',
        status: 'invalid_input',
        issues: [
          error(
            C.REQUIRED,
            'tasks',
            '还没有可以安排的学习任务。请先到「学习任务」页新建任务（填好预计用时与截止日期），再来生成计划。',
            {},
          ),
        ],
        diagnostics: [],
      };
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
      /**
       * 本次规划的搜索起点（可选）。
       * 不传时引擎自己按"当前时刻之后的下一个整点"推导，
       * 因此界面只需要在用户**显式填写**时才传值。
       */
      startAt: normalizeStartAt(input.startAt),
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

    // 对齐会话身份后再计算差异与快照，保证"没变的安排"在各处都表现为没变
    const alignedPlan = alignCandidateSessionIds(engineResult.plan, state);
    const candidate = { ...alignedPlan, generatedAt: nowIso() };
    const summary = input.changeSummary ?? describeDraftOps(ops);
    const preview = {
      previewId: idFactory.next('preview'),
      baseVersion,
      baseInputHash,
      candidate,
      diff: diffPlans(current, candidate, { taskById: engineResult.taskById ?? buildTaskMap(state) }),
      risks: engineResult.risks,
      diagnostics: engineResult.diagnostics,
      unscheduled: engineResult.unscheduled,
      createdAt: nowIso(),
      changeSummary: summary,
      trigger: input.trigger ?? 'preview',
      /**
       * 应用时需要一并写入的数据变更（确认之前一直只是草稿）。
       *
       * 注意：这里**不预先构造** sessionPlan。
       * 原因：草稿里新任务使用的是"临时实体"（在内存里创建、ID 由同一批操作生成），
       * 与确认时真正写入的任务之间必须保持一致；因此会话快照必须在
       * **重放 ops 之后**、基于最终状态构造（见 applyPreview）。
       */
      ops,
      /** 草稿阶段新建任务的临时 ID（应用时按同一顺序映射为真实 ID） */
      draftCreatedTaskIds,
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

    // 草稿阶段新建的任务在"应用"时会再次创建（ID 与草稿不同）。
    // 候选计划里的 taskId 指向草稿 ID，必须按同一顺序改写为真实 ID，
    // 否则确认后会写出"引用不存在的任务"的时段（这是真实发生过的缺陷）。
    const remappedCandidate = remapDraftTaskIds(preview.candidate, state, nextState, preview.draftCreatedTaskIds);

    // 把候选计划的学习片段转换成 StudySession —— **必须基于重放后的状态**，
    // 否则新增任务时产生的时段会引用草稿里的临时任务 ID，导致"时段引用了不存在的任务"。
    const sessionPlan = buildSessionPlan(remappedCandidate, nextState);
    const protectedIssue = checkProtectedSessions(sessionPlan, state.sessions ?? []);
    if (protectedIssue) return { ok: false, issues: [protectedIssue] };

    const snapshot = current ? createPlanSnapshot({ plan: current, nowIso: nowIso(), changeSummary: lastMutationSummary(current), trigger: preview.trigger }) : null;

    const commitResult = app.commit(
      () => {
        const history = snapshot ? [snapshot, ...nextState.planHistory] : [...nextState.planHistory];
        return {
          ...nextState,
          sessions: sessionPlan,
          officialPlan: { ...remappedCandidate, version: remappedCandidate.version },
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

  /**
   * 执行清理操作（清理已取消的历史时段、裁剪版本快照）。
   *
   * 这是**用户显式触发**的破坏性操作，因此：
   * - 绝不自动执行，也绝不在没有确认弹窗的情况下调用；
   * - 只清理"已取消且从未开始过"的时段与超出保留上限的旧快照；
   * - 已完成的学习记录与当前正式计划永远不在清理范围内。
   */
  function applyCleanup(ops) {
    const state = app.getState();
    const applied = applyDraftOps(state, ops, { idFactory, nowIso: nowIso() });
    if (!applied.ok) return { ok: false, issues: applied.issues ?? [] };

    const commitResult = app.commit(() => applied.state, { reason: 'cleanup' });
    if (!commitResult.ok) return { ok: false, error: commitResult.error, issues: [] };

    return {
      ok: true,
      removedCount: applied.removedCount ?? 0,
      removedMinutes: applied.removedMinutes ?? 0,
      plan: getOfficialPlan(),
    };
  }

  /**
   * 清理影响面（只读，不修改任何数据）。
   * 界面用它先告诉用户"会删掉什么、能释放多少"，再让用户确认。
   */
  function cleanupImpact() {
    return evaluateCleanupImpact(app.getState());
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

  /**
   * 把候选计划里引用的"草稿任务 ID"改写为"应用后真实任务 ID"。
   *
   * 场景：用户新增任务 → 预览（草稿里创建了一个临时任务实体）→ 确认应用。
   * 应用时会重新执行一次同样的变更，因此会产生一个**新的**真实任务 ID。
   * 候选计划里记录的 taskId 还是草稿 ID，必须按"新建任务的先后顺序"一一替换，
   * 否则计划块与时段会指向一个不存在的任务（整体校验会直接拒绝加载）。
   */
  function remapDraftTaskIds(candidate, beforeState, afterState, draftCreatedTaskIds) {
    const ids = draftCreatedTaskIds ?? [];
    if (ids.length === 0 || !candidate) return candidate;

    const beforeIds = new Set((beforeState.tasks ?? []).map((task) => task.id));
    const realNewIds = (afterState.tasks ?? []).filter((task) => !beforeIds.has(task.id)).map((task) => task.id);

    const mapping = new Map();
    ids.forEach((draftId, index) => {
      const realId = realNewIds[index];
      if (draftId && realId) mapping.set(draftId, realId);
    });
    if (mapping.size === 0) return candidate;

    const mapId = (id) => mapping.get(id) ?? id;
    return {
      ...candidate,
      blocks: (candidate.blocks ?? []).map((block) => (block.taskId ? { ...block, taskId: mapId(block.taskId) } : block)),
      unscheduled: (candidate.unscheduled ?? []).map((item) => ({ ...item, taskId: mapId(item.taskId) })),
    };
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
  /**
   * 把候选计划里的学习片段转换成 StudySession。
   *
   * **身份稳定**是这里最重要的事：如果每次重新规划都换一批新 ID，
   * 差异引擎就会把"完全没变的时段"报成"全部取消 + 全部新增"，
   * 用户点一次"生成计划"就以为整个计划被推翻了，历史记录也会迅速膨胀。
   *
   * 因此这里做两件事：
   * 1. **身份匹配**：候选片段与既有片段（任务 + 日期 + 起止时间完全相同）视为同一段，
   *    直接复用既有 ID 与其历史（例如已经累计的专注分钟数）。
   * 2. **只取消真正被取代的**：身份没匹配上的既有片段才标记为已取消。
   *
   * 受保护时段（已完成 / 进行中 / 锁定）不参与匹配，永远原样保留。
   */
  /** 任务 id → 任务对象（差异文案需要任务标题） */
  function buildTaskMap(state) {
    return new Map((state.tasks ?? []).map((task) => [task.id, task]));
  }

  /** 会话身份键：任务 + 日期 + 起止时间 */
  function sessionIdentityKey(taskId, date, startMinutes, endMinutes) {
    return `${taskId}|${date}|${startMinutes}|${endMinutes}`;
  }

  /**
   * 把候选计划里学习块的 `refId` 对齐到既有会话的身份上。
   *
   * 为什么要做这一步：引擎为每个片段派生的是**确定性但位置相关**的 ID。
   * 只要重排后片段顺序变了，同一个安排也会拿到不同的 ID，
   * 差异引擎就会把它报成"新增 + 取消"。这里按"任务 + 日期 + 起止时间"重新对齐，
   * 让"没变的安排"在差异里真的显示为没变。
   */
  function alignCandidateSessionIds(candidate, draftState) {
    const existing = draftState.sessions ?? [];
    const index = new Map();
    for (const session of existing) {
      if (session.state === SESSION_STATE.CANCELLED) continue;
      if (!isInWindow(session, candidate)) continue;
      const key = sessionIdentityKey(session.taskId, session.date, session.startMinutes, session.endMinutes);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(session.id);
    }

    const used = new Set();
    const blocks = (candidate.blocks ?? []).map((block) => {
      if (block.kind !== BLOCK_KIND.STUDY) return block;
      const key = sessionIdentityKey(block.taskId, block.date, block.startMinutes, block.endMinutes);
      const pool = index.get(key);
      const candidateId = pool && pool.length > 0 ? pool.shift() : null;
      if (!candidateId || used.has(candidateId)) return block;
      used.add(candidateId);
      return { ...block, refId: candidateId };
    });

    return { ...candidate, blocks };
  }

  function buildSessionPlan(candidate, draftState) {
    const existing = draftState.sessions ?? [];
    const isProtected = (session) =>
      session.state === SESSION_STATE.COMPLETED || session.locked === true || session.state === SESSION_STATE.IN_PROGRESS;
    const protectedIds = new Set(existing.filter(isProtected).map((session) => session.id));

    // 保留三类记录：
    // 1) 受保护时段（已完成 / 锁定 / 进行中）——绝不改动；
    // 2) 窗口之外的时段——窗口滚动时它们不属于本次重排范围；
    // 3) 已经取消的时段——历史记录，不再参与排程。
    const kept = existing.filter(
      (session) => protectedIds.has(session.id) || !isInWindow(session, candidate) || session.state === SESSION_STATE.CANCELLED,
    );

    // —— 身份索引：任务 + 日期 + 起止时间 → 可复用的既有片段 ——
    // 已取消的记录不参与复用（否则新片段的 ID 会与历史记录重复），
    // 改为让新片段拿一个新 ID，旧记录继续作为历史存在。
    const identityKey = (taskId, date, startMinutes, endMinutes) => `${taskId}|${date}|${startMinutes}|${endMinutes}`;
    const reusableByKey = new Map();
    for (const session of existing) {
      if (isProtected(session)) continue;
      if (session.state === SESSION_STATE.CANCELLED) continue;
      if (!isInWindow(session, candidate)) continue;
      const key = identityKey(session.taskId, session.date, session.startMinutes, session.endMinutes);
      if (!reusableByKey.has(key)) reusableByKey.set(key, []);
      reusableByKey.get(key).push(session);
    }

    const studyBlocks = (candidate.blocks ?? []).filter(
      (block) => block.kind === BLOCK_KIND.STUDY && block.refId && !protectedIds.has(block.refId),
    );

    const reusedSessionIds = new Set();
    const carriedOver = [];
    const created = [];

    for (const block of studyBlocks) {
      const key = identityKey(block.taskId, block.date, block.startMinutes, block.endMinutes);
      const pool = reusableByKey.get(key);
      const match = pool && pool.length > 0 ? pool.shift() : null;

      if (match) {
        // 同一段安排：沿用原 ID、原创建时间与已累计的专注数据，只刷新与本次计划相关的字段
        reusedSessionIds.add(match.id);
        carriedOver.push({
          ...match,
          plannedMinutes: block.endMinutes - block.startMinutes,
          state: SESSION_STATE.FLEXIBLE,
          reasonCodes: [...(block.meta?.reasons ?? [])],
          planVersion: candidate.version,
          updatedAt: nowIso(),
        });
        continue;
      }

      created.push({
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
        elapsedMinutes: 0,
        paused: false,
        history: [],
      });
    }

    // 只有"被真正取代"的既有片段才标记为已取消
    const superseded = existing
      .filter(
        (session) =>
          !protectedIds.has(session.id) &&
          !reusedSessionIds.has(session.id) &&
          isInWindow(session, candidate) &&
          session.state !== SESSION_STATE.CANCELLED,
      )
      .map((session) => ({ ...session, state: SESSION_STATE.CANCELLED, locked: false, paused: false, updatedAt: nowIso() }));

    return [...kept, ...superseded, ...carriedOver, ...created];
  }

  function isInWindow(session, plan) {
    return session.date >= plan.windowStart && session.date <= plan.windowEnd;
  }

  return {
    requestPreview,
    applyPreview,
    discardPreview,
    applyCleanup,
    cleanupImpact,
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
