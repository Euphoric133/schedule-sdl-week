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
import { VALIDATION_CODES as C, error, mergeResults, result } from '../domain/validation.js';

/**
 * 迁移步骤表：key 为"源版本"，value 为把该版本升级到 key+1 的函数。
 * 示例（未来使用）：
 *   2: (state) => ({ ...state, schemaVersion: 3, settings: { ...state.settings, newField: 默认值 } }),
 */
export const MIGRATIONS = Object.freeze({
  // 1: (state) => ({ ...state, schemaVersion: 2, ... })   ← 当结构升级到 v2 时在此添加
});

/** 迁移过程中补全缺失的顶层容器（容错：旧数据可能缺少后来新增的数组字段） */
function fillMissingContainers(state) {
  const next = { ...state };
  let changed = false;
  const containers = ['tasks', 'sessions', 'fixedActivities', 'planHistory'];
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
export function migrateState(raw, { skipSemanticValidation = false } = {}) {
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
      return { ok: false, state, issues: mergeResults(result(issues), validation).issues, error: new Error('数据校验未通过') };
    }
    return { ok: true, state, issues: mergeResults(result(issues), validation).issues, migratedFrom: fromVersion };
  }

  return { ok: true, state, issues, migratedFrom: fromVersion };
}
