/**
 * 结构版本迁移链。
 *
 * 规则（务必遵守）：
 * 1. 任何破坏性结构变更都要递增 domain/schemas.js 的 CURRENT_SCHEMA_VERSION，
 *    并在这里添加 `[起版本, 迁移函数]`。
 * 2. 迁移函数必须是**纯函数**：输入旧结构，输出新结构，不访问存储、不依赖时钟。
 * 3. 迁移失败（返回 ok:false）时，调用方必须放弃加载并保留磁盘上的原始数据，绝不写入部分迁移结果。
 * 4. 迁移只负责结构搬运；结构搬运完之后统一交给 validateAppState 做语义校验。
 *
 * 当前版本为 1，尚无历史版本，因此迁移表为空——这是有意为之：
 * 只有真实需要时才写迁移代码，不预先虚构旧版本。
 */

import { CURRENT_SCHEMA_VERSION, defaultSettings, validateAppState } from '../domain/schemas.js';
import { describeRepairs, reconcileState } from '../domain/reconcile.js';
import { VALIDATION_CODES as C, error, mergeResults, result } from '../domain/validation.js';

/**
 * 迁移步骤表：key 为"源版本"，value 为把该版本升级到 key+1 的函数。
 * 示例（未来使用）：
 *   2: (state) => ({ ...state, schemaVersion: 3, settings: { ...state.settings, newField: 默认值 } }),
 */
export const MIGRATIONS = Object.freeze({
  // 1: (state) => ({ ...state, schemaVersion: 2, ... })   ← 当结构升级到 v2 时在此添加
});

/**
 * 可以安全自动修复的错误码。
 *
 * 故意只包含"任务与时段之间数量不一致"这一类——
 * 它们的修复方式是确定的、不会丢失已完成的学习记录，
 * 而结构损坏、字段缺失、类型错误等仍然必须如实报错，不能被"修复"掩盖。
 */
const REPAIRABLE_CODES = new Set([
  C.TASK_DURATION_INCONSISTENT,
  C.TASK_OVER_COMPLETED,
  C.ENTITY_DANGLING_REF,
]);

/** 计划里是否已经没有任何缓冲内容（用于避免无谓地重写数据） */
function hasLegacyBuffer(state) {
  const plans = [state.officialPlan, state.pendingPreview?.candidate].filter(Boolean);
  return plans.some(
    (plan) =>
      (plan.blocks ?? []).some((block) => block?.kind === 'buffer') ||
      (plan.days ?? []).some((day) => (day?.bufferMinutes ?? 0) > 0) ||
      (plan.metrics && plan.metrics.bufferReservedMinutes > 0),
  );
}

/** 移除旧计划中的缓冲时段与缓冲统计（纯派生数据，丢弃不影响任务与学习记录） */
function stripLegacyBuffer(state) {
  if (!hasLegacyBuffer(state)) return { state };

  const cleanPlan = (plan) => {
    if (!plan) return plan;
    const blocks = (plan.blocks ?? []).filter((block) => block?.kind !== 'buffer');
    const days = (plan.days ?? []).map((day) => ({ ...day, bufferMinutes: 0 }));
    const metrics = plan.metrics ? { ...plan.metrics, bufferReservedMinutes: 0 } : plan.metrics;
    return { ...plan, blocks, days, metrics };
  };

  return {
    state: {
      ...state,
      officialPlan: cleanPlan(state.officialPlan),
      pendingPreview: state.pendingPreview
        ? { ...state.pendingPreview, candidate: cleanPlan(state.pendingPreview.candidate) }
        : state.pendingPreview,
    },
  };
}

/** 迁移过程中补全缺失的顶层容器（容错：旧数据可能缺少后来新增的数组字段） */
function fillMissingContainers(state) {
  const next = { ...state };
  let changed = false;
  // 数组容器：旧版本数据缺少这些字段时补上空数组（新增功能不会让老数据读不出来）
  // 番茄钟与奖励转盘功能已移除：不再为它们补空容器。
  // 旧数据里如果还有这些字段，原样保留（不清空用户数据），只是应用不再读写它们。
  const containers = ['tasks', 'sessions', 'fixedActivities', 'planHistory', 'restPeriods'];
  for (const key of containers) {
    if (!Array.isArray(next[key])) {
      next[key] = [];
      changed = true;
    }
  }
  if (next.pendingPreview === undefined) {
    next.pendingPreview = null;
    changed = true;
  }
  if (next.officialPlan === undefined) {
    next.officialPlan = null;
    changed = true;
  }
  if (!next.settings || typeof next.settings !== 'object') {
    next.settings = defaultSettings();
    changed = true;
  } else {
    // 用默认值补齐新增的设置项（不覆盖用户已设置的值）
    const defaults = defaultSettings();
    const merged = { ...defaults, ...next.settings };
    if (JSON.stringify(merged) !== JSON.stringify(next.settings)) {
      next.settings = merged;
      changed = true;
    }
  }
  if (!next.meta || typeof next.meta !== 'object') {
    next.meta = { lastBackupAt: null, migrationLog: [] };
    changed = true;
  }
  return { state: next, changed };
}

/**
 * 把任意来源的状态迁移到当前版本并做语义校验。
 *
 * @param {object} raw 从存储或导入文件读到的原始对象
 * @param {object} [options]
 * @param {boolean} [options.skipSemanticValidation] 仅供迁移单元测试使用
 * @returns {{ok: boolean, state?: object, issues: object[], error?: Error, migratedFrom?: number}}
 */
export function migrateState(raw, { skipSemanticValidation = false, allowRepair = true } = {}) {
  const issues = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [error(C.SCHEMA_SHAPE, 'state', '数据根必须是一个对象。', { actual: Array.isArray(raw) ? 'array' : typeof raw })],
      error: new Error('数据根不是对象'),
    };
  }

  let state = { ...raw };
  const fromVersion = Number.isInteger(state.schemaVersion) ? state.schemaVersion : 0;

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    const issue = error(
      C.SCHEMA_VERSION_UNSUPPORTED,
      'schemaVersion',
      `数据来自更新的版本（v${fromVersion}），当前程序只能读取到 v${CURRENT_SCHEMA_VERSION}。为避免损坏数据，已拒绝加载。`,
      { fromVersion, supported: CURRENT_SCHEMA_VERSION },
    );
    return { ok: false, issues: [issue], error: new Error('数据版本高于当前程序支持的版本') };
  }

  let version = fromVersion;
  if (version === 0) {
    // 没有版本号的历史数据：按 v1 结构尝试补齐，并记录迁移日志
    state.schemaVersion = 1;
    version = 1;
    issues.push(
      {
        severity: 'warning',
        code: C.SCHEMA_VERSION_UNSUPPORTED,
        path: 'schemaVersion',
        message: '数据没有版本号，已按 v1 结构尝试读取（缺失字段将使用默认值补齐）。',
      },
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (typeof step !== 'function') {
      const issue = error(
        C.MIGRATION_FAILED,
        'schemaVersion',
        `缺少从 v${version} 到 v${version + 1} 的迁移步骤，无法安全读取该数据。`,
        { from: version, to: version + 1 },
      );
      return { ok: false, issues: [...issues, issue], error: new Error('缺少迁移步骤') };
    }
    try {
      state = step(state);
      state.schemaVersion = version + 1;
      version += 1;
    } catch (err) {
      const issue = error(C.MIGRATION_FAILED, 'schemaVersion', `从 v${version} 迁移到 v${version + 1} 时失败：${err.message}`, {
        from: version,
      });
      return { ok: false, issues: [...issues, issue], error: err };
    }
  }

  /**
   * 兼容旧计划里的缓冲时段。
   *
   * 缓冲时间功能已经移除，但用户浏览器里可能还存着**之前生成的**计划，
   * 那些计划的 blocks 里会带 kind='buffer' 的块。
   * 这里在读取时把它们从计划中移除（缓冲块是纯派生数据，不是用户录入的内容，
   * 丢弃它不会丢失任何任务或学习记录），同时把每日缓冲统计归零，
   * 保证界面不会再出现"缓冲"相关的区块，也不会因为旧的块类型而报错。
   */
  const stripped = stripLegacyBuffer(state);
  state = stripped.state;

  const filled = fillMissingContainers(state);
  state = filled.state;
  if (filled.changed) {
    issues.push({
      severity: 'warning',
      code: C.SCHEMA_SHAPE,
      path: 'state',
      message: '数据中缺少部分字段，已用默认值补齐（未覆盖你已有的设置）。',
    });
  }

  if (!skipSemanticValidation) {
    const validation = validateAppState(state);
    if (!validation.ok) {
      /**
       * 语义校验失败时的**安全修复**路径。
       *
       * 背景：历史版本存在一个缺陷——把任务标记为完成后，没有同步取消它已排的时段，
       * 于是数据里出现"任务已完成，但还有未完成时段"的状态。
       * 这种数据以前会被判定为"无法读取"，界面显示为空白，
       * 用户会以为"任务丢了"（实际上磁盘数据还在）。
       *
       * 现在的处理：
       * 1. 只有当**全部**错误都属于"可自动修复的不一致"时才尝试修复；
       *    其它任何错误（结构损坏、字段缺失等）仍然按原来的方式拒绝读取，
       *    避免用修复掩盖真正的数据损坏。
       * 2. 修复只取消**未完成**的时段、只调整任务的预计总用时；
       *    已完成的学习记录一律保留。
       * 3. 修复结果必须重新通过完整校验才会被采用。
       * 4. 修复内容会作为 warning 返回，界面会明确告知用户改了什么。
       *    同时也保留了原始数据：写入修复后的状态时，存储层会把旧数据轮转到备份槽。
       */
      // 是否允许自动修复由上层的场景决定：
      // - 读取自己已有的数据：允许（否则用户会看到空白应用）
      // - 导入外部文件：不允许（导入会整体替换数据，宁可拒绝并列出问题，让用户确认）
      const repairable = allowRepair && validation.errors.every((issue) => REPAIRABLE_CODES.has(issue.code));
      if (repairable) {
        const repair = reconcileState(state, { nowIso: new Date().toISOString() });
        const revalidation = validateAppState(repair.state);
        if (repair.changed && revalidation.ok) {
          issues.push({
            severity: 'warning',
            code: C.SCHEMA_SHAPE,
            path: 'state',
            message: describeRepairs(repair.repairs),
            repairs: repair.repairs,
          });
          return { ok: true, state: repair.state, issues, migratedFrom: fromVersion, repaired: true, repairs: repair.repairs };
        }
      }
      return { ok: false, state, issues: mergeResults(result(issues), validation).issues, error: new Error('数据校验未通过') };
    }
    return { ok: true, state, issues: mergeResults(result(issues), validation).issues, migratedFrom: fromVersion };
  }

  return { ok: true, state, issues, migratedFrom: fromVersion };
}
