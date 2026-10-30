/**
 * 界面偏好（外观、通知）。
 *
 * 为什么与业务数据分开存：
 * 这些设置是**设备级**的（换台电脑想要不同的主题、不同的通知权限），
 * 而且体积小、读写频繁（主题要在首屏渲染前就生效，否则会闪一下白底）。
 * 因此单独放在一个轻量的键里，走同步的 localStorage，
 * 业务数据仍然由 appState 统一管理。
 *
 * 安全原则：任何读取失败都回退到默认值，绝不让"坏掉的偏好"导致应用打不开。
 */

const STORAGE_KEY = 'studyPlanner:v1:preferences';

/**
 * 可选主题。
 *
 * `system`（跟随系统）已移除：它依赖 `prefers-color-scheme`，在不同浏览器/系统上
 * 表现不一致（例如系统切换后页面不刷新、截图/打印时对不上），
 * 因此只保留两个**显式**主题。
 */
export const THEME = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
});

/**
 * 旧数据里可能存着已经废弃的主题值（主要是 `'system'`）。
 *
 * 处理原则：**读取时映射，不静默丢弃**。
 * - `system` → 按当前系统的深浅色偏好落成一个显式主题（保持用户看到的观感不变）；
 * - 其它未知值 → 回落到默认主题。
 * 这样既不会因为旧值让页面崩溃，也不会在用户没察觉的情况下突然换一个反差很大的主题。
 */
export function normalizeTheme(theme, { prefersDark = false } = {}) {
  if (theme === THEME.LIGHT || theme === THEME.DARK) return theme;
  // 已废弃的 'system'：按当前系统偏好落成一个显式主题，避免用户观感突变
  if (theme === 'system') return prefersDark ? THEME.DARK : THEME.LIGHT;
  /**
   * 未知值 / 缺失值 → **深色**。
   *
   * 默认主题从浅色改为深色是产品决定：深空视觉是这一版的主基调。
   * 注意这里只影响"没有有效值"的情况；用户显式保存过 light 的不会被改写
   * （见 normalizeAppearance 里的 themeExplicit 逻辑）。
   */
  return THEME.DARK;
}

export const NOTIFICATION_TYPE = Object.freeze({
  SESSION_SOON: 'session_soon', // 下一项学习即将开始
  PLAN_START: 'plan_start', // 每天一次的学习简报（今天有哪些安排）
  DAILY_SUMMARY: 'daily_summary', // 今日计划概览
});

export function defaultPreferences() {
  return {
    version: 1,
    appearance: {
      /**
       * 默认主题：深色。
       *
       * 深空是当前视觉的主基调，浅色仍可在设置页切换。
       * `themeExplicit` 用来区分"用户主动选过"与"只是旧默认值"，
       * 这样默认值变更不会静默覆盖用户明确的选择。
       */
      theme: THEME.DARK,
      themeExplicit: false,
      wallpaper: {
        enabled: false,
        fileName: null,
        savedAt: null,
      },
    },
    notifications: {
      enabled: false, // 用户是否开启提醒（与浏览器权限分开记录）
      permission: 'default', // 'default' | 'granted' | 'denied' | 'unsupported'
      advanceMinutes: 10, // 提前多少分钟提醒
      types: {
        [NOTIFICATION_TYPE.SESSION_SOON]: true,
        [NOTIFICATION_TYPE.PLAN_START]: true,
        [NOTIFICATION_TYPE.DAILY_SUMMARY]: false,
      },
      quietHours: { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60 },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

let memoryFallback = null;

function storage() {
  try {
    const candidate = globalThis.localStorage;
    if (!candidate) return null;
    // 隐私模式下 localStorage 存在但写入会抛错，这里探测一次
    const probe = '__pref_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

/** 深合并默认值：老版本数据缺少新字段时自动补齐，不会因为新增字段而崩 */
function mergeDefaults(defaults, stored) {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
  const output = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (value === null || value === undefined) continue;
    const base = output[key];
    if (base !== null && typeof base === 'object' && !Array.isArray(base) && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeDefaults(base, value);
    } else if (base !== undefined) {
      output[key] = value;
    } else {
      output[key] = value; // 允许未来版本新增的字段被保留
    }
  }
  return output;
}

/**
 * 读取后统一整理外观字段。
 *
 * 这里做的是"兼容旧数据"，而不是"改写用户设置"：
 * 已废弃的主题值（如 `system`）会被映射成等价的显式主题，
 * 因此界面不会出现一个不存在的选项，也不会因为它是旧的而崩掉。
 */
function normalizeAppearance(preferences) {
  const prefersDark = Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
  const appearance = preferences.appearance ?? {};
  const explicit = appearance.themeExplicit === true;

  /**
   * 迁移策略（默认主题由浅改深之后必须处理，否则老用户会被"卡"在浅色）：
   *
   * - `themeExplicit === true`：用户主动选过，**原样保留**，不做任何改写；
   * - 没有该标记（旧版本数据）：说明这个值可能是"旧默认浅色"而不是用户的主动选择，
   *   统一迁移为深色，并把标记设为 false（下次用户主动切换时才置 true）；
   * - 已废弃的 `system`：仍然按系统偏好落成显式主题，再走上面的规则。
   *
   * 代价说明：确实有意选择浅色、但从未在设置页点过切换的老用户会被迁到深色。
   * 这是"无法区分意图"时选择默认值的必然代价；用户可以一键切回，且之后会被记住。
   */
  let theme;
  if (explicit) {
    theme = normalizeTheme(appearance.theme, { prefersDark });
  } else if (appearance.theme === 'system') {
    // 已废弃的"跟随系统"：按当前系统偏好落成显式主题，观感不变
    theme = prefersDark ? THEME.DARK : THEME.LIGHT;
  } else {
    // 旧默认值或缺失 → 新的默认深色
    theme = THEME.DARK;
  }

  return {
    ...preferences,
    appearance: { ...appearance, theme, themeExplicit: explicit },
  };
}

export function loadPreferences() {
  const defaults = defaultPreferences();
  const store = storage();
  if (!store) return memoryFallback ? normalizeAppearance(mergeDefaults(defaults, memoryFallback)) : defaults;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return normalizeAppearance(mergeDefaults(defaults, parsed));
  } catch {
    // 数据损坏：回退默认值，但保留原始内容便于用户导出排查
    return defaults;
  }
}

export function savePreferences(preferences) {
  const store = storage();
  if (!store) {
    memoryFallback = preferences;
    return { ok: true, persisted: false };
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(preferences));
    memoryFallback = preferences;
    return { ok: true, persisted: true };
  } catch (error) {
    memoryFallback = preferences;
    return {
      ok: false,
      persisted: false,
      message: '偏好设置无法写入浏览器存储（可能是空间不足或隐私模式），本次修改只在当前页面有效。',
      error,
    };
  }
}

/** 偏好的内部键名（导出与排查用） */
export const PREFERENCES_STORAGE_KEY = STORAGE_KEY;
