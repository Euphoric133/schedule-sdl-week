/**
 * 界面偏好（外观、通知、奖励规则、专注设置）。
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

export const THEME = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
});

export const NOTIFICATION_TYPE = Object.freeze({
  SESSION_SOON: 'session_soon', // 下一项学习即将开始
  PLAN_START: 'plan_start', // 每天一次的学习简报（今天有哪些安排）
  FOCUS_END: 'focus_end', // 专注计时结束
  DAILY_SUMMARY: 'daily_summary', // 今日计划概览
});

export const REWARD_TRIGGER = Object.freeze({
  FOCUS_MINUTES: 'focus_minutes', // 每累计专注 N 分钟
  POMODORO_COUNT: 'pomodoro_count', // 每完成 N 个番茄钟
  SESSION_COMPLETED: 'session_completed', // 每完成 N 个学习时段
  TASK_COMPLETED: 'task_completed', // 每完成 N 个任务
});

/** 默认奖励奖项（用户可增删改，也可一键恢复这组示例） */
export const DEFAULT_REWARDS = Object.freeze([
  { id: 'rwd_rest5', label: '休息 5 分钟', emoji: '☕️', weight: 3, enabled: true },
  { id: 'rwd_song', label: '听一首歌', emoji: '🎧', weight: 3, enabled: true },
  { id: 'rwd_game10', label: '玩游戏 10 分钟', emoji: '🎮', weight: 2, enabled: true },
  { id: 'rwd_video', label: '看一段喜欢的视频', emoji: '📺', weight: 2, enabled: true },
  { id: 'rwd_snack', label: '吃点喜欢的零食', emoji: '🍪', weight: 2, enabled: true },
  { id: 'rwd_walk', label: '出去走走 15 分钟', emoji: '🚶', weight: 1, enabled: true },
]);

export function defaultPreferences() {
  return {
    version: 1,
    appearance: {
      theme: THEME.SYSTEM,
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
        [NOTIFICATION_TYPE.FOCUS_END]: true,
        [NOTIFICATION_TYPE.DAILY_SUMMARY]: false,
      },
      quietHours: { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60 },
    },
    focus: {
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      roundsBeforeLongBreak: 4,
      autoStartNext: false,
      soundEnabled: true,
      soundVolume: 0.5,
      soundKind: 'brown', // 'brown' | 'rain' | 'none'
    },
    rewards: {
      enabled: true,
      items: DEFAULT_REWARDS.map((item) => ({ ...item })),
      triggers: {
        [REWARD_TRIGGER.FOCUS_MINUTES]: { enabled: true, threshold: 25 },
        [REWARD_TRIGGER.POMODORO_COUNT]: { enabled: false, threshold: 1 },
        [REWARD_TRIGGER.SESSION_COMPLETED]: { enabled: false, threshold: 1 },
        [REWARD_TRIGGER.TASK_COMPLETED]: { enabled: false, threshold: 1 },
      },
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

export function loadPreferences() {
  const defaults = defaultPreferences();
  const store = storage();
  if (!store) return memoryFallback ? mergeDefaults(defaults, memoryFallback) : defaults;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return mergeDefaults(defaults, parsed);
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
