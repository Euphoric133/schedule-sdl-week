/**
 * 备份、导出与导入。
 *
 * 安全规则（对应验收用例 15）：
 * - 导入**必须**先完整校验，再允许写入；校验失败时原数据保持不变，一个字节都不动。
 * - 校验发现的 warning 不阻断导入，但必须显示给用户。
 * - 导入的每一层（JSON 语法 → 顶层结构 → 结构版本 → 语义）都独立报错，便于用户定位问题。
 * - 本地应用绝不把数据上传到任何服务器；导出只是一个浏览器下载文件。
 */

import { CURRENT_SCHEMA_VERSION, defaultSettings, summarizeState, validateAppState } from '../domain/schemas.js';
import { VALIDATION_CODES as C, error, mergeResults, result } from '../domain/validation.js';
import { migrateState } from './migrations.js';

/** 导出文件的格式标识（防止用户误把别的 JSON 导入本应用） */
export const BACKUP_FORMAT = 'seven-day-study-planner/backup';
export const BACKUP_FORMAT_VERSION = 1;

/**
 * 构造导出用的备份对象。
 * @param {object} state 当前应用状态
 * @param {{ nowIso: string, appVersion?: string }} ctx
 */
export function buildBackup(state, ctx) {
  if (!ctx || typeof ctx.nowIso !== 'string') throw new TypeError('buildBackup 需要 ctx.nowIso');
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: state.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    appVersion: ctx.appVersion ?? '0.1.0',
    exportedAt: ctx.nowIso,
    summary: summarizeState(state),
    state,
  };
}

/** 序列化为可下载的 JSON 文本（缩进 2 空格，便于用户用文本编辑器检查与手工修复） */
export function serializeBackup(backup) {
  return JSON.stringify(backup, null, 2);
}

/** 建议的文件名：带日期，便于用户区分多次导出 */
export function suggestBackupFilename(nowIso) {
  const date = String(nowIso).slice(0, 10);
  return `七天学习规划器-备份-${date}.json`;
}

/**
 * 导入文件的顶层字段检查。
 *
 * 为什么与"迁移"分开：
 * - 迁移（migrations.js）对**本应用自己的历史数据**保持宽容：缺字段用默认值补齐，便于升级。
 * - 导入是外部输入，必须严格：缺字段说明这多半不是本应用的备份，直接拒绝比"补齐后接受"安全得多。
 *   如果不检查，一个 `{"tasks": ..., "sessions": ...}` 的残缺对象会被补上默认设置后当成合法数据导入。
 */
const REQUIRED_STATE_KEYS = ['tasks', 'sessions', 'settings'];

export function checkImportShape(state) {
  const issues = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    issues.push(error(C.SCHEMA_SHAPE, 'state', '备份文件中的 state 必须是一个对象。'));
    return issues;
  }
  for (const key of REQUIRED_STATE_KEYS) {
    const value = state[key];
    if (value === undefined || value === null) {
      issues.push(error(C.SCHEMA_SHAPE, `state.${key}`, `备份文件缺少必需字段 ${key}，无法导入。`));
      continue;
    }
    if (key === 'settings') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push(error(C.SCHEMA_SHAPE, `state.${key}`, 'settings 必须是一个对象。'));
      }
    } else if (!Array.isArray(value)) {
      issues.push(error(C.SCHEMA_SHAPE, `state.${key}`, `${key} 必须是数组。`));
    }
  }
  return issues;
}

/**
 * 解析并校验导入文本。
 *
 * @param {string} text 用户提供的 JSON 文本
 * @param {object} [options]
 * @param {object|null} [options.currentState] 仅在需要对比时使用（当前不修改它）
 * @returns {{ok: boolean, state?: object, issues: object[], error?: Error, summary?: object, exportedAt?: string}}
 */
export function parseImport(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, issues: [error(C.SCHEMA_SHAPE, 'file', '导入内容为空，请选择有效的备份文件。')], error: new Error('空内容') };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      issues: [error(C.SCHEMA_SHAPE, 'file', `JSON 语法错误，无法解析：${err.message}`, { reason: err.message })],
      error: err,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [error(C.SCHEMA_SHAPE, 'file', '文件内容不是一个 JSON 对象。', { actual: Array.isArray(parsed) ? 'array' : typeof parsed })],
      error: new Error('顶层不是对象'),
    };
  }

  const issues = [];

  // 允许两种输入：完整备份对象（带 format）或裸状态对象（便于用户手工构造 / 旧版本导出）
  let candidate;
  const looksLikeBackup = typeof parsed.format === 'string' || parsed.state !== undefined;
  if (looksLikeBackup) {
    if (parsed.format !== BACKUP_FORMAT) {
      issues.push(
        error(
          C.SCHEMA_SHAPE,
          'format',
          `这不是本应用的备份文件（format = ${JSON.stringify(parsed.format ?? null)}，期望 "${BACKUP_FORMAT}"）。`,
          { format: parsed.format ?? null },
        ),
      );
    }
    if (!parsed.state || typeof parsed.state !== 'object') {
      issues.push(error(C.SCHEMA_SHAPE, 'state', '备份文件中缺少 state 数据。'));
      return { ok: false, issues, error: new Error('缺少 state') };
    }
    candidate = parsed.state;
  } else {
    candidate = parsed;
    issues.push({
      severity: 'warning',
      code: C.SCHEMA_SHAPE,
      path: 'file',
      message: '文件没有备份标识，已按"裸数据"尝试导入（如果这是别的软件的 JSON，导入会失败且不会修改现有数据）。',
    });
  }

  // 顶层字段严格检查（外部输入必须完整；缺失字段不会被静默补齐）
  const shapeIssues = checkImportShape(candidate);
  if (shapeIssues.length > 0) {
    return { ok: false, issues: [...issues, ...shapeIssues], error: new Error('导入数据的顶层结构不完整') };
  }

  // 结构迁移 + 语义校验（任何失败都不返回可写入的数据）
  const migrated = migrateState(candidate);
  if (!migrated.ok) {
    return {
      ok: false,
      issues: mergeResults(result(issues), { issues: migrated.issues }).issues,
      error: migrated.error,
    };
  }

  const validation = validateAppState(migrated.state);
  const merged = mergeResults(result(issues), { issues: migrated.issues }, validation);
  if (!merged.ok) {
    return { ok: false, issues: merged.issues, error: new Error('导入数据校验未通过') };
  }

  return {
    ok: true,
    state: migrated.state,
    issues: merged.issues,
    summary: summarizeState(migrated.state),
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
  };
}

/**
 * 把导入结果写入存储。只有 parseImport 返回 ok 的状态才能通过这里。
 * 写入失败时（例如配额不足），存储适配器负责保留旧数据；本函数只如实返回失败。
 *
 * @param {object} adapter StoragePort
 * @param {object} importResult parseImport 的返回值
 */
export function applyImport(adapter, importResult) {
  if (!importResult?.ok || !importResult.state) {
    return { ok: false, error: new Error('导入数据未通过校验，已取消导入以保护现有数据。') };
  }
  const written = adapter.save(importResult.state);
  if (!written.ok) return written;
  return { ok: true, warning: written.warning ?? null };
}

/** 备份提示：本地存储可能被浏览器清理，界面应定期提醒导出 */
export function backupReminder(state, nowIso, { daysThreshold = 7 } = {}) {
  const last = state?.meta?.lastBackupAt ?? null;
  if (!last) {
    return { shouldRemind: true, reason: '还没有导出过备份。建议定期导出，避免清理浏览器数据后丢失计划。' };
  }
  const lastMs = Date.parse(last);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return { shouldRemind: false, reason: null };
  }
  const days = Math.floor((nowMs - lastMs) / 86400000);
  if (days >= daysThreshold) {
    return { shouldRemind: true, reason: `距离上次导出备份已 ${days} 天，建议重新导出一份。` };
  }
  return { shouldRemind: false, reason: null };
}

/** 供"恢复默认设置"使用：返回新的设置对象（不动其它数据） */
export function resetSettings() {
  return defaultSettings();
}
