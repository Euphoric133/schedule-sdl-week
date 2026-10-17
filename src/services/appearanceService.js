/**
 * 外观服务：主题与自定义壁纸的统一入口。
 *
 * 职责：
 * - 把偏好应用到文档（`data-theme`、CSS 变量、壁纸背景层）；
 * - 管理壁纸的加载 / 应用 / 更换 / 移除（真正的二进制在 IndexedDB，见 storage/wallpaperStore.js）；
 * - 发布订阅，让设置页能在状态变化后刷新自己。
 *
 * 关键设计：**主题必须在首屏渲染前应用**，否则浅色主题下会先闪一下白底。
 * 因此 `applyThemeOnly()` 可以在 `boot()` 之前调用，而它只依赖同步的 localStorage。
 */

import { loadPreferences, savePreferences, THEME } from './preferences.js';
import {
  deleteWallpaper,
  isWallpaperStorageAvailable,
  loadWallpaper,
  prepareWallpaper,
  saveWallpaper,
  validateWallpaperFile,
} from '../storage/wallpaperStore.js';

export { THEME };

/** 壁纸显示方式的中文说明（界面下拉用） */
export const THEME_LABELS_ZH = Object.freeze({
  [THEME.LIGHT]: '浅色',
  [THEME.DARK]: '深色',
  [THEME.SYSTEM]: '跟随系统',
});

/**
 * @param {object} options
 * @param {object} [options.preferences] 传入已有偏好（否则自行读取）
 * @param {Function} [options.onChange] 状态变化回调
 */
export function createAppearanceService({ preferences: provided, onChange } = {}) {
  let preferences = provided ?? loadPreferences();
  let currentObjectUrl = null;
  let storageAvailable = null;
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(preferences);
      } catch {
        /* 单个订阅者出错不影响其它订阅者 */
      }
    }
    onChange?.(preferences);
  };

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /* ---------------- 主题 ---------------- */

  /** 把主题应用到 <html data-theme>；可在应用启动前调用 */
  function applyThemeOnly(theme = preferences.appearance.theme) {
    const root = documentElement();
    if (!root) return;
    root.setAttribute('data-theme', theme);
    // 让浏览器地址栏 / 表单控件也跟随（例如深色下的滚动条与输入框）
    const resolved =
      theme === THEME.SYSTEM
        ? globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches
          ? 'dark'
          : 'light'
        : theme;
    root.style.colorScheme = resolved;
  }

  function setTheme(theme) {
    if (!Object.values(THEME).includes(theme)) {
      return { ok: false, message: `未知的主题：${theme}` };
    }
    preferences = { ...preferences, appearance: { ...preferences.appearance, theme } };
    applyThemeOnly(theme);
    const saved = savePreferences(preferences);
    notify();
    return { ok: true, persisted: saved.persisted, message: saved.message };
  }

  /* ---------------- 壁纸 ---------------- */

  /**
   * 取得（必要时创建）壁纸背景层。
   *
   * 这是壁纸"上传成功但看不到"的直接原因：样式里定义了 `#app-wallpaper`，
   * 但页面里从来没有这个节点（index.html 没有，代码也没创建）。
   * `applyWallpaperToDocument` 查不到节点就直接返回，于是图片被保存了却永远不显示。
   *
   * 现在改为：需要时在 <body> 上补建这一层。
   * 放在 JS 里而不是 index.html，是为了让单文件版本（dist/standalone.html）同样可用。
   */
  function ensureWallpaperLayer() {
    const doc = safeDocument();
    if (!doc?.body) return null;

    let layer = doc.getElementById?.('app-wallpaper') ?? null;
    if (layer) return layer;

    layer = doc.createElement('div');
    layer.id = 'app-wallpaper';
    // 明确标记为装饰元素：不参与无障碍树、不接收鼠标事件
    layer.setAttribute('aria-hidden', 'true');
    // 放在 body 的最前面，保证所有内容都叠在它上面
    if (typeof doc.body.insertBefore === 'function' && doc.body.firstChild) {
      doc.body.insertBefore(layer, doc.body.firstChild);
    } else {
      doc.body.appendChild(layer);
    }
    return layer;
  }

  /** 把壁纸应用到背景层；没有壁纸时移除该层 */
  function applyWallpaperToDocument({ objectUrl } = {}) {
    const root = documentElement();
    if (!root) return;

    const layer = ensureWallpaperLayer();
    const wallpaper = preferences.appearance.wallpaper;
    const active = Boolean(wallpaper.enabled && objectUrl);

    root.setAttribute('data-wallpaper', active ? 'on' : 'off');

    if (!layer) return;
    if (!active) {
      layer.style.backgroundImage = 'none';
      return;
    }
    layer.style.backgroundImage = `url("${objectUrl}")`;
  }

  /**
   * 暂时启用 / 关闭壁纸（不清除图片）。
   *
   * 注意：这里**只保留开关**。"显示方式 / 模糊 / 遮罩"三个设置已按要求移除，
   * 壁纸固定为"填充窗口 + 固定遮罩保证文字可读"，参数写死在样式里，
   * 因此不再需要任何调整逻辑。
   */
  async function setWallpaperEnabled(enabled) {
    const current = preferences.appearance.wallpaper;
    preferences = {
      ...preferences,
      appearance: { ...preferences.appearance, wallpaper: { ...current, enabled: Boolean(enabled) } },
    };

    // 启用时如果内存里还没有图片 URL（例如刚刷新页面后先关了再打开），
    // 必须先从 IndexedDB 读回来，否则会出现"开关是开的，但背景还是空的"。
    if (enabled && !currentObjectUrl) {
      const loaded = await loadWallpaper();
      if (loaded.ok) currentObjectUrl = loaded.objectUrl;
    }

    applyWallpaperToDocument({ objectUrl: currentObjectUrl });
    const saved = savePreferences(preferences);
    notify();
    return { ok: true, enabled: Boolean(enabled), persisted: saved.persisted, message: saved.message };
  }

  /** 校验用户选择的文件（不写入） */
  function validateFile(file) {
    return validateWallpaperFile(file);
  }

  /**
   * 处理并应用新壁纸。
   * @param {File} file
   */
  async function setWallpaperFromFile(file) {
    const prepared = await prepareWallpaper(file);
    if (!prepared.ok) return { ok: false, message: prepared.message };

    const saved = await saveWallpaper(prepared.blob, {
      fileName: file.name,
      originalBytes: file.size,
      storedBytes: prepared.bytes,
      type: prepared.type,
    });
    if (!saved.ok) return { ok: false, message: saved.message };

    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(prepared.blob);

    preferences = {
      ...preferences,
      appearance: {
        ...preferences.appearance,
        wallpaper: {
          ...preferences.appearance.wallpaper,
          enabled: true,
          fileName: file.name,
          savedAt: saved.meta.savedAt,
        },
      },
    };
    applyWallpaperToDocument({ objectUrl: currentObjectUrl });
    savePreferences(preferences);
    notify();

    return {
      ok: true,
      bytes: prepared.bytes,
      resized: prepared.resized,
      message: prepared.resized
        ? '壁纸已应用（图片较大，已自动压缩以节省空间）。'
        : '壁纸已应用。',
    };
  }

  /** 移除壁纸（同时清掉 IndexedDB 里的图片） */
  async function clearWallpaper() {
    const result = await deleteWallpaper();
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    preferences = {
      ...preferences,
      appearance: {
        ...preferences.appearance,
        wallpaper: { ...preferences.appearance.wallpaper, enabled: false, fileName: null, savedAt: null },
      },
    };
    applyWallpaperToDocument({});
    savePreferences(preferences);
    notify();
    return { ok: true, deleted: result.ok };
  }

  /** 启动时恢复上次保存的壁纸 */
  async function restoreWallpaper() {
    storageAvailable = await isWallpaperStorageAvailable();
    if (!preferences.appearance.wallpaper.enabled) {
      applyWallpaperToDocument({});
      notify();
      return { ok: true, restored: false, storageAvailable };
    }
    const loaded = await loadWallpaper();
    if (!loaded.ok) {
      // 记录里说启用了，但图片读不到（被清空 / 隐私模式）：如实降级为无壁纸
      preferences = {
        ...preferences,
        appearance: { ...preferences.appearance, wallpaper: { ...preferences.appearance.wallpaper, enabled: false } },
      };
      applyWallpaperToDocument({});
      savePreferences(preferences);
      notify();
      return { ok: true, restored: false, reason: 'missing', storageAvailable };
    }
    currentObjectUrl = loaded.objectUrl;
    applyWallpaperToDocument({ objectUrl: currentObjectUrl });
    notify();
    return { ok: true, restored: true, storageAvailable };
  }

  /** 把外观相关的设置一次性应用到文档（主题 + 壁纸参数） */
  function applyAll() {
    applyThemeOnly();
    applyWallpaperToDocument({ objectUrl: currentObjectUrl });
  }

  /* ---------------- 偏好整体读写（通知 / 专注 / 奖励共用） ---------------- */

  /** 读取偏好（只读副本语义：返回当前对象） */
  function getPreferences() {
    return preferences;
  }

  /**
   * 更新偏好中的任意分区。
   * @param {(current: object) => object} updater 返回新的偏好对象
   */
  function updatePreferences(updater) {
    const next = updater(preferences);
    if (!next || typeof next !== 'object') return { ok: false, message: '更新偏好失败。' };
    preferences = next;
    applyAll();
    const saved = savePreferences(preferences);
    notify();
    return { ok: true, persisted: saved.persisted, message: saved.message };
  }

  /** 重新从存储读取（导入备份或外部修改后使用） */
  function reload() {
    preferences = loadPreferences();
    applyAll();
    notify();
    return preferences;
  }

  /** 释放资源（主要给测试用） */
  function dispose() {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    listeners.clear();
  }

  return {
    subscribe,
    getPreferences,
    updatePreferences,
    reload,
    dispose,
    // 主题
    applyThemeOnly,
    setTheme,
    // 壁纸
    applyAll,
    applyWallpaperToDocument,
    restoreWallpaper,
    setWallpaperFromFile,
    setWallpaperEnabled,
    clearWallpaper,
    validateFile,
    get storageAvailable() {
      return storageAvailable;
    },
    get wallpaperObjectUrl() {
      return currentObjectUrl;
    },
  };
}

/**
 * 安全地取当前 document。
 *
 * 不能在模块顶层缓存 document：测试环境会逐条安装/卸载打桩 DOM，
 * 而且启动时的异步操作（例如恢复壁纸）可能在测试已经结束、document 被清掉之后才回来。
 * 因此每次调用都重新判断，缺失时静默跳过视觉应用（数据层不受影响）。
 */
function safeDocument() {
  try {
    return typeof document === 'undefined' ? null : document;
  } catch {
    return null;
  }
}

function documentElement() {
  return safeDocument()?.documentElement ?? null;
}

