/**
 * 内存存储实现。
 *
 * 用途：
 * - 单元测试 / 集成测试（不触碰真实 localStorage，保证测试可重复且互不干扰）
 * - 浏览器禁用本地存储时的降级方案（页面会显示"本次数据不会保存"的横幅）
 */

import {
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  makeStorageError,
} from './storagePort.js';

/** 创建一个内存存储实现；行为与 localStorage 适配器完全一致，便于替换 */
export function createMemoryAdapter({ seed = null } = {}) {
  const store = new Map();
  if (seed && typeof seed === 'object') {
    for (const [key, value] of Object.entries(seed)) store.set(key, JSON.stringify(value));
  }

  const readJson = (key) => {
    const raw = store.get(key);
    if (raw === undefined || raw === null) return { present: false, value: null, corrupted: false };
    try {
      return { present: true, value: JSON.parse(raw), corrupted: false };
    } catch {
      return { present: true, value: null, corrupted: true };
    }
  };

  return {
    kind: 'memory',
    isAvailable: () => true,

    load({ migrate = (s) => ({ ok: true, state: s }) } = {}) {
      return loadFromReader(readJson, migrate);
    },

    save(state) {
      // 先备份当前状态，再写入新状态：任何一步失败都不会让用户同时丢掉新旧数据
      const current = store.get(STORAGE_KEYS.state);
      try {
        if (current !== undefined) store.set(STORAGE_KEYS.backup, current);
        store.set(STORAGE_KEYS.state, JSON.stringify(state));
        store.set(STORAGE_KEYS.meta, JSON.stringify({ lastSavedAt: new Date().toISOString() }));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.SERIALIZE_FAILED, err) };
      }
    },

    /** 只覆盖备份槽（与 localStorageAdapter 行为一致，供"重置系统"使用） */
    saveBackupOnly(state) {
      try {
        store.set(STORAGE_KEYS.backup, JSON.stringify(state));
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },

    clear() {
      store.clear();
    },

    readRaw() {
      return readJson(STORAGE_KEYS.state).value;
    },

    writeRaw(raw) {
      try {
        store.set(STORAGE_KEYS.state, JSON.stringify(raw));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.SERIALIZE_FAILED, err) };
      }
    },

    readBackup() {
      return readJson(STORAGE_KEYS.backup).value;
    },

    lastSavedAt() {
      const meta = readJson(STORAGE_KEYS.meta).value;
      return meta?.lastSavedAt ?? null;
    },
  };
}

/**
 * 共享的加载逻辑：读取主数据 → 迁移 → 失败则回退备份。
 * 抽出来是为了让 localStorage 与 memory 两个实现行为一致（测试才能真正代表生产行为）。
 *
 * @param {(key: string) => {present: boolean, value: any, corrupted: boolean}} readJson
 * @param {(state: object) => {ok: boolean, state?: object, issues?: object[], error?: Error}} migrate
 */
export function loadFromReader(readJson, migrate) {
  const main = readJson(STORAGE_KEYS.state);
  if (!main.present) {
    return { ok: true, state: null, empty: true, recovered: false, issues: [] };
  }
  if (main.corrupted) {
    const backup = readJson(STORAGE_KEYS.backup);
    if (backup.present && !backup.corrupted) {
      return { ok: true, state: backup.value, empty: false, recovered: true, issues: [] };
    }
    return { ok: false, state: null, empty: false, recovered: false, issues: [], error: makeStorageError(STORAGE_ERROR_CODES.CORRUPTED) };
  }

  const migrated = migrate(main.value);
  if (migrated.ok) {
    return { ok: true, state: migrated.state, empty: false, recovered: false, issues: migrated.issues ?? [] };
  }

  // 迁移失败（例如数据来自更高版本）：尝试备份，仍失败则如实报告，绝不返回半可用数据
  const backup = readJson(STORAGE_KEYS.backup);
  if (backup.present && !backup.corrupted) {
    const backupMigrated = migrate(backup.value);
    if (backupMigrated.ok) {
      return { ok: true, state: backupMigrated.state, empty: false, recovered: true, issues: backupMigrated.issues ?? [] };
    }
  }
  return { ok: false, state: null, empty: false, recovered: false, issues: migrated.issues ?? [], error: migrated.error ?? null };
}
