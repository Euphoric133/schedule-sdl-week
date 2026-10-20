/**
 * 应用状态容器（唯一数据根）+ 持久化协调。
 *
 * 设计原因：
 * - 整个应用只有一个状态对象；UI 只订阅它并渲染，绝不自己持有业务数据副本。
 *   这样"七天视图与每日视图基于同一份计划数据"就成为结构性保证，而不是靠自觉。
 * - 所有写操作都返回结构化结果（ok / error / warning / issues），不抛异常给 UI，
 *   以便界面能显示"保存失败但内存未变"这种真实状态，而不是假装成功。
 * - 写操作成功后统一触发持久化；持久化失败时**回滚内存状态**，保证内存与磁盘一致。
 */

import { createLocalStorageAdapter } from '../storage/localStorageAdapter.js';
import { createMemoryAdapter } from '../storage/memoryAdapter.js';
import { migrateState } from '../storage/migrations.js';
import { createEmptyState, summarizeState } from '../domain/schemas.js';
import { buildBackup, applyImport, parseImport, serializeBackup, suggestBackupFilename } from '../storage/backup.js';

/**
 * @param {object} options
 * @param {object} [options.adapter] 存储适配器；缺省时自动选择 localStorage，不可用则退回内存
 * @param {() => string} [options.clock] 返回 ISO 时间字符串（测试可注入固定时钟）
 * @param {string} [options.windowStart] 首次创建状态时的计划窗口起始日
 * @param {number} [options.planHistoryLimit]
 */
export function createAppState(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
  const planHistoryLimit = options.planHistoryLimit ?? 20;

  const requestedAdapter = options.adapter ?? createLocalStorageAdapter();
  const persistenceAvailable = typeof requestedAdapter.isAvailable === 'function' ? requestedAdapter.isAvailable() : true;
  const adapter = persistenceAvailable ? requestedAdapter : createMemoryAdapter();

  const listeners = new Set();
  const notifications = [];

  let state = null;
  let loadReport = {
    loaded: false,
    fromStorage: false,
    recovered: false,
    usedMemoryFallback: !persistenceAvailable,
    issues: [],
    error: null,
  };

  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(state, event);
      } catch (err) {
        // 单个订阅者出错不应影响其它订阅者与数据一致性
        notifications.push({ level: 'error', message: `界面更新失败：${err.message}`, at: clock() });
      }
    }
  }

  function pushNotification(level, message, details) {
    notifications.push({ level, message, at: clock(), ...(details ? { details } : {}) });
  }

  /** 加载（或初始化）状态 */
  function load() {
    const result = adapter.load({ migrate: (raw) => migrateState(raw) });

    if (!result.ok) {
      // 读取失败：不覆盖磁盘数据，以空状态启动并保留错误信息供界面展示
      state = createEmptyState({ nowIso: clock(), windowStart: options.windowStart });
      loadReport = {
        loaded: false,
        fromStorage: false,
        recovered: false,
        usedMemoryFallback: !persistenceAvailable,
        issues: result.issues ?? [],
        error: result.error ?? null,
      };
      pushNotification('error', '本地数据无法读取，已用空白数据启动。现有磁盘数据未被修改，请导出备份后再处理。');
      return { ...loadReport, state };
    }

    if (result.empty || !result.state) {
      state = createEmptyState({ nowIso: clock(), windowStart: options.windowStart });
      loadReport = {
        loaded: false,
        fromStorage: false,
        recovered: false,
        usedMemoryFallback: !persistenceAvailable,
        issues: result.issues ?? [],
        error: null,
      };
      // 首次使用：立即落盘，避免用户关闭页面后连空状态都没有
      persist(state);
      return { ...loadReport, state };
    }

    state = result.state;
    loadReport = {
      loaded: true,
      fromStorage: true,
      recovered: Boolean(result.recovered),
      usedMemoryFallback: !persistenceAvailable,
      issues: result.issues ?? [],
      error: null,
    };
    if (result.recovered) {
      pushNotification('warning', '主数据读取失败，已从自动备份恢复。请检查最近的计划是否符合预期。');
    }
    for (const issue of loadReport.issues ?? []) {
      if (issue.severity === 'warning') pushNotification('warning', issue.message, issue);
    }
    return { ...loadReport, state };
  }

  /** 写入存储；失败时返回错误，不修改内存状态 */
  function persist(nextState) {
    const written = adapter.save(nextState);
    if (!written.ok) {
      pushNotification('error', written.error?.message ?? '保存失败。', { code: written.error?.code });
      return written;
    }
    if (written.warning) {
      pushNotification('warning', `自动备份写入失败：${written.warning.message}`, { code: written.warning.code });
    }
    return written;
  }

  /**
   * 原子更新：mutator 返回新状态对象（必须是新对象，不做就地修改）。
   * 保存成功后通知订阅者；保存失败则回滚并返回失败结果。
   */
  function commit(mutator, { reason = 'update' } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('commit 需要一个返回新状态的函数');
    const previous = state;
    const draft = mutator(previous);
    if (!draft || typeof draft !== 'object') {
      return { ok: false, error: new Error('更新函数没有返回有效状态。') };
    }
    const next = { ...draft, updatedAt: clock() };
    const written = persist(next);
    if (!written.ok) {
      state = previous; // 回滚：内存与磁盘保持一致
      notify({ type: 'save-failed', reason, error: written.error });
      return { ok: false, error: written.error };
    }
    state = next;
    notify({ type: 'change', reason });
    return { ok: true, warning: written.warning ?? null };
  }

  /** 变更内存状态但不写盘（用于临时 UI 状态；谨慎使用） */
  function notifyOnly(reason = 'noop') {
    notify({ type: 'change', reason });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 更新 meta.lastBackupAt 并落盘 */
  function markBackupExported() {
    return commit(
      (current) => ({ ...current, meta: { ...current.meta, lastBackupAt: clock() } }),
      { reason: 'backup-exported' },
    );
  }

  /**
   * 导入预览：解析并完整校验，但**不写入任何数据**。
   *
   * 界面用它先展示"这份备份包含什么、有没有问题"，用户确认后再调用 `importBackup`。
   * 这样"看一眼再决定"与"真的导入"是两步，避免误操作覆盖现有数据。
   */
  function previewImport(text) {
    const parsed = parseImport(text);
    if (!parsed.ok) {
      return {
        ok: false,
        issues: parsed.issues,
        errors: (parsed.issues ?? []).filter((issue) => issue.severity === 'error'),
        error: parsed.error,
      };
    }
    return {
      ok: true,
      summary: parsed.summary,
      exportedAt: parsed.exportedAt,
      warnings: (parsed.issues ?? []).filter((issue) => issue.severity === 'warning'),
      issues: parsed.issues ?? [],
    };
  }

  /** 存储占用（字节）与浏览器配额估算（可用时） */
  async function storageUsage() {
    const usedBytes = typeof adapter.usedBytes === 'function' ? adapter.usedBytes() : null;
    let quotaBytes = null;
    try {
      if (typeof globalThis.navigator?.storage?.estimate === 'function') {
        const estimate = await globalThis.navigator.storage.estimate();
        quotaBytes = estimate?.quota ?? null;
      }
    } catch {
      quotaBytes = null;
    }
    return { usedBytes, quotaBytes, persistenceAvailable };
  }

  /** 导出当前数据为 JSON 文本（纯函数，不改状态） */
  function exportBackup() {
    const backup = buildBackup(state, { nowIso: clock() });
    return { text: serializeBackup(backup), filename: suggestBackupFilename(clock()), summary: backup.summary };
  }

  /**
   * 导入 JSON 文本。校验通过才写入；校验失败时**完全不改动**现有数据。
   * @returns {{ok: boolean, summary?: object, issues?: object[], warnings?: object[], error?: Error}}
   */
  function importBackup(text) {
    const parsed = parseImport(text);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues, error: parsed.error };
    }
    const applied = applyImport(adapter, parsed);
    if (!applied.ok) {
      return { ok: false, issues: parsed.issues, error: applied.error };
    }
    state = parsed.state;
    notify({ type: 'change', reason: 'import' });
    return {
      ok: true,
      summary: parsed.summary,
      warnings: (parsed.issues ?? []).filter((i) => i.severity === 'warning'),
      issues: parsed.issues ?? [],
    };
  }

  function importFile(file) {
    if (!file || typeof file.text !== 'function') {
      return Promise.resolve({ ok: false, error: new Error('没有选择文件。') });
    }
    return file.text().then((text) => importBackup(text));
  }

  function drainNotifications() {
    const copy = [...notifications];
    notifications.length = 0;
    return copy;
  }

  function getState() {
    return state;
  }

  function getSummary() {
    return summarizeState(state);
  }

  /**
   * 让"自动恢复备份"与当前状态保持一致。
   *
   * 为什么需要：每次保存都会把**上一份**状态轮转进 backup 槽。
   * 于是"重置系统"刚执行完时，backup 里恰好是**重置前**的业务数据；
   * 一旦之后主数据读取失败，自动恢复会把用户以为已经清空的数据重新装回来。
   *
   * 这里把当前（已重置的）状态写进 backup 槽，保证恢复目标与用户看到的界面一致。
   * 只影响这一个键，不动 preferences / notified 等其它存储。
   */
  function syncRecoveryBackup() {
    if (typeof adapter?.saveBackupOnly !== 'function') return { ok: false, skipped: true };
    try {
      return adapter.saveBackupOnly(state) ?? { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  return {
    adapter,
    persistenceAvailable,
    planHistoryLimit,
    clock,
    load,
    commit,
    notify,
    notifyOnly,
    subscribe,
    getState,
    getSummary,
    getLoadReport: () => ({ ...loadReport }),
    getNotifications: drainNotifications,
    pushNotification,
    persist,
    syncRecoveryBackup,
    markBackupExported,
    exportBackup,
    previewImport,
    importBackup,
    importFile,
    storageUsage,
  };
}
