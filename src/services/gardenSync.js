/**
 * 主应用 ↔「专注花园」的数据联动。
 *
 * 方向一：主应用 → 花园（需要写）
 *   把主应用的学习任务同步成花园任务，并**自动开始计时**——用户不需要在花园里再点一次"开始"。
 *   写入必须走花园自己的 dispatch，所以用到了补丁暴露的 `window.__focusGardenBridge`。
 *
 * 方向二：花园 → 主应用（只读）
 *   花园在**专注完成时自己就会**给任务的 `completedPomodoros +1` 并写一条 session，
 *   因此这里只需要读取（同源 localStorage 或桥的 getState），不需要任何写操作，
 *   也就不会触碰主应用的校验与排程逻辑。
 *
 * 设计约束：
 * - 桥不存在（花园还没加载完 / 被删补丁）时，所有函数都返回"不可用"，绝不抛错打断主应用；
 * - 任务映射（主应用 id → 花园 id）持久化在独立的 localStorage 键里，避免重复创建；
 * - 只在**进入花园**或**用户主动点"专注"**时写入，不做轮询式写操作。
 */

/** 花园自己的存储键（它自己定义的前缀，本应用只读） */
const GARDEN_KEYS = {
  tasks: 'focus-garden/tasks',
  sessions: 'focus-garden/sessions',
};

/** 主应用侧记录"任务映射"的键（独立命名空间，不混进业务状态） */
const MAP_KEY = 'studyPlanner:v1:gardenMap';

/* ================================================================== *
 * 读取花园数据（不依赖桥，直接读同源 localStorage）
 * ================================================================== */

function readJson(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 读花园的当前快照：任务列表与专注记录。
 * 数据来自花园自己的存储，主应用只读不改。
 *
 * @returns {{tasks: Array<object>, sessions: Array<object>, available: boolean}}
 */
export function readGardenSnapshot() {
  const rawTasks = readJson(GARDEN_KEYS.tasks);
  const rawSessions = readJson(GARDEN_KEYS.sessions);
  const tasks = Array.isArray(rawTasks) ? rawTasks.filter((t) => t && typeof t === 'object') : [];
  const sessions = Array.isArray(rawSessions) ? rawSessions.filter((s) => s && typeof s === 'object') : [];
  return { tasks, sessions, available: tasks.length > 0 || sessions.length > 0 };
}

/**
 * 每个主应用任务已完成多少个番茄。
 *
 * 判定方式：花园任务里 `completedPomodoros` 是权威值；
 * 找不到对应任务时返回 0（不猜、不估算）。
 *
 * @param {Record<string, string>} map 主应用任务 id → 花园任务 id
 * @returns {Record<string, number>}
 */
export function pomodorosByPlannerTask(map = loadTaskMap()) {
  const { tasks } = readGardenSnapshot();
  const byGardenId = new Map(tasks.map((task) => [task.id, task]));
  const result = {};
  for (const [plannerId, gardenId] of Object.entries(map)) {
    const gardenTask = byGardenId.get(gardenId);
    const count = Number.isFinite(gardenTask?.completedPomodoros) ? gardenTask.completedPomodoros : 0;
    result[plannerId] = Math.max(0, Math.round(count));
  }
  return result;
}

/* ================================================================== *
 * 任务映射（持久化，避免重复创建花园任务）
 * ================================================================== */

/** @returns {Record<string, string>} */
export function loadTaskMap() {
  const stored = readJson(MAP_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const clean = {};
  for (const [plannerId, gardenId] of Object.entries(stored)) {
    if (typeof plannerId === 'string' && typeof gardenId === 'string' && gardenId) clean[plannerId] = gardenId;
  }
  return clean;
}

export function saveTaskMap(map) {
  try {
    globalThis.localStorage?.setItem(MAP_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== *
 * 桥：花园自己的 dispatch
 * ================================================================== */

/**
 * 从 iframe 里取联动桥。花园脚本执行后才会挂上，所以这里可能返回 null。
 *
 * @param {HTMLIFrameElement|null} frame
 * @returns {{getState: () => object, dispatch: (action: object) => void}|null}
 */
export function getGardenBridge(frame) {
  try {
    const win = frame?.contentWindow;
    if (!win) return null;
    const bridge = win.__focusGardenBridge;
    if (!bridge || typeof bridge.dispatch !== 'function' || typeof bridge.getState !== 'function') return null;
    return bridge;
  } catch {
    // 跨域或文档已卸载
    return null;
  }
}

/**
 * 等桥就绪。iframe 里的 React 需要一点时间挂载，这里用轮询 + 超时兜底。
 *
 * @param {HTMLIFrameElement|null} frame
 * @param {{timeoutMs?: number, intervalMs?: number, sleep?: (ms:number)=>Promise<void>}} [options]
 */
export async function waitForBridge(frame, { timeoutMs = 8000, intervalMs = 120, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bridge = getGardenBridge(frame);
    if (bridge) return bridge;
    if (Date.now() >= deadline) return null;
    await wait(intervalMs);
  }
}

/* ================================================================== *
 * 主应用 → 花园：同步任务
 * ================================================================== */

/** 主应用任务 → 花园任务的字段映射（只带花园认识的字段） */
export function toGardenDraft(task) {
  return {
    name: String(task.title ?? '').slice(0, 40) || '未命名任务',
    description: task.subject ? `科目：${task.subject}` : '',
    category: task.subject || '默认',
    priority: task.importance >= 4 ? 'high' : task.importance <= 2 ? 'low' : 'normal',
    // 花园按"番茄个数"估时；主应用按分钟，按 25 分钟一个番茄折算，至少 1 个
    estimatePomodoros: Math.max(1, Math.round((task.plannedMinutes ?? 25) / 25)),
    dueDate: task.deadlineDate || null,
    plannedDate: task.deadlineDate || null,
  };
}

/**
 * 把主应用的任务同步进花园。
 *
 * - 已映射且花园里还在 → `task/update`（只更新名称/科目/估时/截止）
 * - 未映射或花园里已不存在 → `task/create`，随后从桥里读回新 id 建立映射
 * - 主应用里已完成/取消/删除的任务 → 花园任务标记为 done（不删除，保留其专注记录）
 *
 * @returns {Promise<{ok: boolean, created: number, updated: number, done: number, reason?: string}>}
 */
export async function syncTasksToGarden({ bridge, tasks, map, sleep } = {}) {
  if (!bridge) return { ok: false, created: 0, updated: 0, done: 0, reason: 'no-bridge' };

  const wait = sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
  const nextMap = { ...(map ?? loadTaskMap()) };
  const state = bridge.getState();
  const gardenById = new Map((state?.tasks ?? []).map((task) => [task.id, task]));

  let created = 0;
  let updated = 0;
  let done = 0;

  for (const task of tasks ?? []) {
    const gardenId = nextMap[task.id];
    const existing = gardenId ? gardenById.get(gardenId) : null;
    const isClosed = task.status === 'completed' || task.status === 'cancelled' || task.status === 'deleted';

    if (existing) {
      if (isClosed) {
        if (existing.status !== 'done') {
          bridge.dispatch({ type: 'task/update', id: existing.id, patch: { status: 'done' } });
          done += 1;
        }
        continue;
      }
      bridge.dispatch({
        type: 'task/update',
        id: existing.id,
        patch: {
          name: toGardenDraft(task).name,
          category: toGardenDraft(task).category,
          estimatePomodoros: toGardenDraft(task).estimatePomodoros,
          dueDate: toGardenDraft(task).dueDate,
          plannedDate: toGardenDraft(task).plannedDate,
          status: 'active',
        },
      });
      updated += 1;
      continue;
    }

    if (isClosed) continue;

    // 新建：先记录创建前的任务 id 集合，再从桥里读回新增的那个
    const before = new Set((bridge.getState()?.tasks ?? []).map((t) => t.id));
    bridge.dispatch({ type: 'task/create', draft: toGardenDraft(task) });
    await wait(30);
    const after = bridge.getState()?.tasks ?? [];
    const fresh = after.find((t) => !before.has(t.id));
    if (fresh) {
      nextMap[task.id] = fresh.id;
      created += 1;
    }
  }

  saveTaskMap(nextMap);
  return { ok: true, created, updated, done };
}

/* ================================================================== *
 * 主应用 → 花园：自动开始计时
 * ================================================================== */

/**
 * 让花园**自动开始**专注指定任务。
 *
 * 顺序很重要：花园的 `timer/start` 只在 `idle` 时生效，
 * 因此先 `timer/reset` 回到 idle，再 `timer/select-task`，最后 `timer/start`。
 *
 * 若花园里已经有一个正在跑的计时（用户自己开的），默认**不打断**。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function autoStartFocus({ bridge, gardenTaskId, force = false, now = Date.now() } = {}) {
  if (!bridge) return { ok: false, reason: 'no-bridge' };
  if (!gardenTaskId) return { ok: false, reason: 'no-task' };

  const timer = bridge.getState()?.timer ?? {};
  const running = timer.status === 'running' || timer.status === 'paused';

  // 已经在专注同一个任务：什么都不用做
  if (timer.activeTaskId === gardenTaskId && timer.status === 'running') {
    return { ok: true, reason: 'already-running' };
  }
  // 正在专注别的任务：用户自己开的，不抢
  if (running && !force) return { ok: false, reason: 'busy' };

  bridge.dispatch({ type: 'timer/reset' });
  bridge.dispatch({ type: 'timer/select-task', taskId: gardenTaskId });
  bridge.dispatch({ type: 'timer/start', now });
  return { ok: true, reason: 'started' };
}

/** 从桥里读当前计时状态（用于刚进入花园时判断要不要自动开始） */
export function readGardenTimer(bridge) {
  const timer = bridge?.getState()?.timer;
  if (!timer || typeof timer !== 'object') return null;
  return {
    status: timer.status ?? 'idle',
    phase: timer.phase ?? 'focus',
    activeTaskId: timer.activeTaskId ?? null,
    targetAt: timer.targetAt ?? null,
    plannedSeconds: timer.plannedSeconds ?? 0,
  };
}
