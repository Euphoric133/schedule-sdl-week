/**
 * localStorage 适配器（浏览器中的默认持久化实现）。
 *
 * 设计要点：
 * 1. 保存时先把当前数据整体复制到备份键，再写主键。写入失败（例如超配额）时，
 *    旧数据仍然完整保留在备份键里，不会出现"新旧都丢"的情况。
 * 2. 加载失败（损坏 / 迁移失败）时回退备份，并在结果中标记 recovered，由界面提示用户。
 * 3. 不在模块加载时访问 localStorage（某些环境会在导入阶段抛异常），
 *    而是在 isAvailable()/load()/save() 内做惰性探测。
 */

import {
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  classifyStorageError,
  makeStorageError,
} from './storagePort.js';
import { loadFromReader } from './memoryAdapter.js';

/** 安全地取得 localStorage 对象；不可用时返回 null */
export function getLocalStorage() {
  try {
    if (typeof globalThis === 'undefined' || !globalThis.localStorage) return null;
    // 真正写一次以探测可用性（隐私模式下对象存在但写入会抛异常）
    const probeKey = 'studyPlanner:probe';
    globalThis.localStorage.setItem(probeKey, '1');
    globalThis.localStorage.removeItem(probeKey);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function createLocalStorageAdapter({ storage = null } = {}) {
  const resolve = () => storage ?? getLocalStorage();

  const readJson = (key) => {
    const ls = resolve();
    if (!ls) return { present: false, value: null, corrupted: false, unavailable: true };
    let raw = null;
    try {
      raw = ls.getItem(key);
    } catch {
      return { present: false, value: null, corrupted: false, unavailable: true };
    }
    if (raw === null || raw === undefined) return { present: false, value: null, corrupted: false };
    try {
      return { present: true, value: JSON.parse(raw), corrupted: false };
    } catch {
      return { present: true, value: null, corrupted: true };
    }
  };

  return {
    kind: 'localStorage',
    isAvailable: () => resolve() !== null,

    load({ migrate = (s) => ({ ok: true, state: s }) } = {}) {
      const ls = resolve();
      if (!ls) {
        return {
          ok: false,
          state: null,
          empty: false,
          recovered: false,
          issues: [],
          error: makeStorageError(STORAGE_ERROR_CODES.UNAVAILABLE),
        };
      }
      return loadFromReader(readJson, migrate);
    },

    save(state) {
      const ls = resolve();
      if (!ls) return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.UNAVAILABLE) };

      let serialized;
      try {
        serialized = JSON.stringify(state);
      } catch (err) {
        return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.SERIALIZE_FAILED, err) };
      }

      try {
        // 1) 备份当前数据（尽力而为：备份失败不阻断主写入，但要如实返回警告）
        const previous = ls.getItem(STORAGE_KEYS.state);
        let backupWarning = null;
        if (previous !== null) {
          try {
            ls.setItem(STORAGE_KEYS.backup, previous);
          } catch (err) {
            backupWarning = makeStorageError(classifyStorageError(err), err);
          }
        }
        // 2) 写入新数据
        ls.setItem(STORAGE_KEYS.state, serialized);
        ls.setItem(STORAGE_KEYS.meta, JSON.stringify({ lastSavedAt: new Date().toISOString(), bytes: serialized.length }));
        return { ok: true, warning: backupWarning };
      } catch (err) {
        return { ok: false, error: makeStorageError(classifyStorageError(err), err) };
      }
    },

    /**
     * 只覆盖"自动恢复备份"槽，不写主数据。
     * 供"重置系统"使用：让恢复目标与已重置的状态保持一致。
     */
    saveBackupOnly(state) {
      const ls = resolve();
      if (!ls) return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.UNAVAILABLE, new Error('本地存储不可用')) };
      try {
        ls.setItem(STORAGE_KEYS.backup, JSON.stringify(state));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: makeStorageError(classifyStorageError(err), err) };
      }
    },

    clear() {
      const ls = resolve();
      if (!ls) return;
      for (const key of Object.values(STORAGE_KEYS)) {
        try {
          ls.removeItem(key);
        } catch {
          // 清理失败不致命：下次写入会覆盖
        }
      }
    },

    readRaw() {
      return readJson(STORAGE_KEYS.state).value;
    },

    writeRaw(raw) {
      const ls = resolve();
      if (!ls) return { ok: false, error: makeStorageError(STORAGE_ERROR_CODES.UNAVAILABLE) };
      try {
        const serialized = JSON.stringify(raw);
        const previous = ls.getItem(STORAGE_KEYS.state);
        if (previous !== null) ls.setItem(STORAGE_KEYS.backup, previous);
        ls.setItem(STORAGE_KEYS.state, serialized);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: makeStorageError(classifyStorageError(err), err) };
      }
    },

    readBackup() {
      return readJson(STORAGE_KEYS.backup).value;
    },

    lastSavedAt() {
      const meta = readJson(STORAGE_KEYS.meta).value;
      return meta?.lastSavedAt ?? null;
    },

    /** 估算已用空间（字节），用于提示用户清理历史 */
    usedBytes() {
      const ls = resolve();
      if (!ls) return 0;
      let total = 0;
      for (const key of Object.values(STORAGE_KEYS)) {
        const raw = ls.getItem(key);
        if (raw) total += raw.length;
      }
      return total;
    },
  };
}
