/**
 * 存储端口（接口约定）与存储相关错误码。
 *
 * 设计原因：UI 与 services 只能依赖这个接口，不能直接使用 localStorage。
 * 这样测试可以注入内存实现，将来也可以换成 IndexedDB / 文件系统而不改业务代码。
 *
 * @typedef {object} LoadResult
 * @property {boolean} ok            是否成功读到可用数据
 * @property {object|null} state     应用状态（ok 为 false 时为 null）
 * @property {boolean} empty         true 表示存储中确实没有任何数据（首次使用，不是错误）
 * @property {boolean} recovered     true 表示主数据损坏，已从自动备份恢复
 * @property {object[]} issues 读取过程中发现的问题（结构见 domain/validation.js 的 ValidationIssue）
 *
 * @typedef {object} StoragePort
 * @property {() => boolean} isAvailable
 * @property {() => LoadResult} load
 * @property {(state: object) => {ok: boolean, error?: Error}} save
 * @property {() => void} clear
 * @property {() => object|null} readRaw          读取原始 JSON（调试 / 导出用）
 * @property {(raw: object) => {ok: boolean, error?: Error}} writeRaw  直接写入原始 JSON（导入已校验的数据）
 * @property {() => object|null} readBackup
 * @property {() => string|null} lastSavedAt
 */

/** 存储过程可能出现的错误码（用于界面提示，避免把技术细节直接抛给用户） */
export const STORAGE_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'STORAGE_UNAVAILABLE', // 浏览器禁用本地存储（如隐私模式）
  QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED', // 超出配额
  SERIALIZE_FAILED: 'STORAGE_SERIALIZE_FAILED', // 数据结构无法序列化
  CORRUPTED: 'STORAGE_CORRUPTED', // 存储中的数据不是合法 JSON
  WRITE_FAILED: 'STORAGE_WRITE_FAILED', // 其它写入失败
});

export const STORAGE_ERROR_MESSAGES_ZH = Object.freeze({
  [STORAGE_ERROR_CODES.UNAVAILABLE]: '当前浏览器环境不可用本地存储（可能处于隐私模式或已禁用），本次数据只保存在内存中，刷新后会丢失。',
  [STORAGE_ERROR_CODES.QUOTA_EXCEEDED]: '本地存储空间已满，本次修改没有保存。请导出备份后清理历史版本，或减少任务数量。',
  [STORAGE_ERROR_CODES.SERIALIZE_FAILED]: '数据无法被保存（包含无法序列化的内容），本次修改没有保存。',
  [STORAGE_ERROR_CODES.CORRUPTED]: '本地保存的数据已损坏，无法解析。',
  [STORAGE_ERROR_CODES.WRITE_FAILED]: '写入本地存储失败，本次修改没有保存。',
});

/** 存储键名：集中定义，避免各处拼写不一致 */
export const STORAGE_KEYS = Object.freeze({
  state: 'studyPlanner:v1:state',
  backup: 'studyPlanner:v1:backup',
  meta: 'studyPlanner:v1:meta',
});

/**
 * 把底层异常（如 QuotaExceededError）映射为稳定错误码。
 * 不同浏览器抛出的 name / code 不完全一致，因此做多重判断。
 */
export function classifyStorageError(err) {
  if (!err) return STORAGE_ERROR_CODES.WRITE_FAILED;
  const name = String(err.name ?? '');
  const code = String(err.code ?? '');
  const message = String(err.message ?? '');
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === '22' || code === '1014' || /quota/i.test(message)) {
    return STORAGE_ERROR_CODES.QUOTA_EXCEEDED;
  }
  if (name === 'SecurityError' || /disabled|denied|security/i.test(message)) {
    return STORAGE_ERROR_CODES.UNAVAILABLE;
  }
  return STORAGE_ERROR_CODES.WRITE_FAILED;
}

/** 生成对用户友好的错误对象（保留原始错误，便于诊断） */
export function makeStorageError(code, cause) {
  const err = new Error(STORAGE_ERROR_MESSAGES_ZH[code] ?? '存储操作失败。');
  err.code = code;
  err.cause = cause;
  return err;
}
