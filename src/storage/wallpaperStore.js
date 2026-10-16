/**
 * 壁纸存储（IndexedDB）。
 *
 * 为什么不能只用 localStorage：
 * 一张手机照片的 base64 通常在 1–5 MB，而 localStorage 一般只有 5 MB 总额，
 * 并且它会把整个字符串同步复制进内存。把壁纸放进去会直接导致"保存失败"或整站变慢。
 * 因此壁纸走 IndexedDB（浏览器给的是几百 MB 级别的配额，且是异步的，不阻塞界面）。
 *
 * 设计要点：
 * - 存储原始 Blob（不是 base64），省掉 33% 的体积膨胀；
 * - 只保存**一张**当前壁纸（覆盖式写入），避免无上限增长；
 * - 读取失败（隐私模式、配额不足、用户清空数据）一律安全降级为"没有壁纸"，
 *   绝不抛异常打断应用启动；
 * - 任何情况下都不上传图片：这里只有浏览器本地 API。
 */

const DB_NAME = 'seven-day-study-planner';
const DB_VERSION = 1;
const STORE = 'wallpaper';
const WALLPAPER_KEY = 'current';

/** 允许的图片类型与体积上限 */
export const WALLPAPER_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024, // 8 MB：比常见手机照片略大，同时避免写入超时
  types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
});

let dbPromise = null;

function hasIndexedDb() {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

/** 打开数据库；失败时返回 null（调用方据此降级） */
function openDb() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

/** 在一个事务里执行操作，失败时静默返回 fallback */
async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return { ok: false, reason: 'unsupported' };

  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch {
      resolve({ ok: false, reason: 'unavailable' });
      return;
    }

    const store = transaction.objectStore(STORE);
    let outcome;
    try {
      outcome = run(store);
    } catch {
      resolve({ ok: false, reason: 'failed' });
      return;
    }

    transaction.oncomplete = () => resolve({ ok: true, value: outcome?.result ?? outcome });
    transaction.onerror = () => resolve({ ok: false, reason: 'failed', error: transaction.error });
    transaction.onabort = () => resolve({ ok: false, reason: 'aborted' });
  });
}

/**
 * 校验用户选择的文件是否可以作为壁纸。
 * @returns {{ok: boolean, message?: string}}
 */
export function validateWallpaperFile(file) {
  if (!file) return { ok: false, message: '没有选择文件。' };
  if (!WALLPAPER_LIMITS.types.includes(file.type)) {
    return {
      ok: false,
      message: `不支持这种图片格式（${file.type || '未知'}）。请选择 JPG、PNG、WebP、GIF 或 AVIF 图片。`,
    };
  }
  if (file.size > WALLPAPER_LIMITS.maxBytes) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `图片太大（${mb} MB）。请选择小于 8 MB 的图片，或先用图片工具压缩。` };
  }
  if (file.size === 0) return { ok: false, message: '这个文件是空的。' };
  return { ok: true };
}

/**
 * 读取并压缩壁纸。
 *
 * 直接把 8 MB 的原图存进去会让每次页面加载都解析一张大图。
 * 这里统一缩放到最长边不超过 2560px 并重新编码为 WebP/JPEG，
 * 既保留足够的显示质量，又把体积降到几百 KB。
 */
export async function prepareWallpaper(file) {
  const validation = validateWallpaperFile(file);
  if (!validation.ok) return { ok: false, message: validation.message };

  // 环境不支持 canvas（例如测试环境）时直接使用原始文件
  if (typeof globalThis.createImageBitmap !== 'function' || typeof document?.createElement !== 'function') {
    const buffer = await file.arrayBuffer().catch(() => null);
    if (!buffer) return { ok: false, message: '读取图片失败，请重试或换一张图片。' };
    return { ok: true, blob: new Blob([buffer], { type: file.type }), type: file.type, bytes: file.size, resized: false };
  }

  try {
    const bitmap = await globalThis.createImageBitmap(file);
    const maxEdge = 2560;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no-2d-context');
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!blob) throw new Error('encode-failed');

    return { ok: true, blob, type: blob.type, bytes: blob.size, width, height, resized: scale < 1 };
  } catch {
    return { ok: false, message: '这张图片无法读取或处理，请换一张（建议 JPG 或 PNG）。' };
  }
}

/** 保存壁纸 Blob（会覆盖上一张） */
export async function saveWallpaper(blob, meta = {}) {
  const record = { blob, meta: { ...meta, savedAt: new Date().toISOString() } };
  const result = await withStore('readwrite', (store) => store.put(record, WALLPAPER_KEY));
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'unsupported'
          ? '这个浏览器不支持本地图片存储，壁纸无法保存。'
          : '保存壁纸失败，可能是浏览器存储空间不足。可以换一张更小的图片，或先清理浏览器数据。',
    };
  }
  return { ok: true, meta: record.meta };
}

/** 读取壁纸（返回 object URL，调用方负责在替换时 revoke） */
export async function loadWallpaper() {
  const result = await withStore('readonly', (store) => store.get(WALLPAPER_KEY));
  if (!result.ok || !result.value?.blob) return { ok: false };
  return {
    ok: true,
    objectUrl: URL.createObjectURL(result.value.blob),
    meta: result.value.meta ?? {},
  };
}

/** 删除壁纸 */
export async function deleteWallpaper() {
  const result = await withStore('readwrite', (store) => store.delete(WALLPAPER_KEY));
  return { ok: result.ok, reason: result.reason };
}

/** 壁纸存储是否可用（用于界面显示真实状态，而不是假设可用） */
export async function isWallpaperStorageAvailable() {
  const db = await openDb();
  return Boolean(db);
}
