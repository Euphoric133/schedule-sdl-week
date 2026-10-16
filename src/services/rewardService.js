/**
 * 奖励转盘服务：奖励项管理、触发规则、抽奖机会与历史记录。
 *
 * 三条必须守住的原则：
 *
 * 1. **不能重复发奖**。抽奖机会由"真实进度"推导（已完成的学习记录、番茄轮数、任务完成数），
 *    再用"已发放的票数"做减法。这样刷新页面、反复点击、重复提交完成记录都不会多发一张。
 *    推导是幂等的：同样的进度永远算出同样的可抽次数。
 *
 * 2. **动画位置必须与真实结果一致**。这里用可复现的加权随机选出中奖项并**先返回结果**，
 *    界面再据此计算旋转角度。绝不出现"动画停在 A、结果是 B"。
 *
 * 3. **不强制外部操作**。中奖只是记录一条历史并生成一张"凭据"；
 *    是否去休息、是否打开某个应用完全由用户决定，应用不会自动打开任何东西。
 */

import { REWARD_TRIGGER, DEFAULT_REWARDS } from './preferences.js';

export { REWARD_TRIGGER };

export const TRIGGER_LABELS_ZH = Object.freeze({
  [REWARD_TRIGGER.FOCUS_MINUTES]: '每累计专注一定分钟数',
  [REWARD_TRIGGER.POMODORO_COUNT]: '每完成若干个番茄钟',
  [REWARD_TRIGGER.SESSION_COMPLETED]: '每完成若干个学习时段',
  [REWARD_TRIGGER.TASK_COMPLETED]: '每完成若干个任务',
});

export const TRIGGER_UNIT_ZH = Object.freeze({
  [REWARD_TRIGGER.FOCUS_MINUTES]: '分钟',
  [REWARD_TRIGGER.POMODORO_COUNT]: '个番茄钟',
  [REWARD_TRIGGER.SESSION_COMPLETED]: '个学习时段',
  [REWARD_TRIGGER.TASK_COMPLETED]: '个任务',
});

/** 软上限：单次最多允许连续抽这么多次，避免误触发把机会一次耗尽 */
const MAX_BATCH_DRAW = 10;

/**
 * 用真实记录计算"累计进度"。
 * 只读取已完成的事实，不读计划、不读愿望。
 */
export function computeProgress(state) {
  const sessions = state.sessions ?? [];
  const records = state.focusRecords ?? [];
  const tasks = state.tasks ?? [];

  const completedSessions = sessions.filter((session) => session.state === 'completed');
  const sessionMinutes = completedSessions.reduce(
    (sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0),
    0,
  );
  const focusMinutesFromRecords = Math.round(
    records.reduce((sum, record) => sum + (record.focusedSeconds ?? 0), 0) / 60,
  );
  const completedRounds = records.filter((record) => record.completed).length;

  return {
    // 专注分钟数取"学习时段实际时长"与"番茄记录时长"的较大值：
    // 两条路径记录的是同一份投入，取较大值避免重复计算，同时不会低估。
    focusMinutes: Math.max(sessionMinutes, focusMinutesFromRecords),
    sessionMinutes,
    focusMinutesFromRecords,
    pomodoroCount: completedRounds,
    sessionCount: completedSessions.length,
    taskCount: tasks.filter((task) => task.status === 'completed').length,
  };
}

/**
 * 根据触发规则与历史发放记录，算出"每个规则各自贡献了多少次机会"。
 * 这是纯函数，因此可以直接测试"刷新后不会重复发奖"。
 */
export function computeEntitlement({ progress, triggers, ledger = {} }) {
  const perTrigger = [];
  let totalEarned = 0;

  for (const trigger of Object.values(REWARD_TRIGGER)) {
    const rule = triggers?.[trigger];
    const threshold = Math.max(1, Math.round(Number(rule?.threshold) || 1));
    const enabled = Boolean(rule?.enabled);
    const value = progressValueFor(trigger, progress);
    const earned = enabled ? Math.floor(value / threshold) : 0;
    const spent = Math.max(0, Math.round(Number(ledger?.[trigger]) || 0));
    const remaining = Math.max(0, earned - spent);
    totalEarned += earned;
    perTrigger.push({ trigger, enabled, threshold, value, earned, spent, remaining });
  }

  const spentTotal = perTrigger.reduce((sum, item) => sum + item.spent, 0);
  return {
    perTrigger,
    totalEarned,
    spentTotal,
    totalRemaining: perTrigger.reduce((sum, item) => sum + item.remaining, 0),
  };
}

function progressValueFor(trigger, progress) {
  switch (trigger) {
    case REWARD_TRIGGER.FOCUS_MINUTES:
      return progress.focusMinutes;
    case REWARD_TRIGGER.POMODORO_COUNT:
      return progress.pomodoroCount;
    case REWARD_TRIGGER.SESSION_COMPLETED:
      return progress.sessionCount;
    case REWARD_TRIGGER.TASK_COMPLETED:
      return progress.taskCount;
    default:
      return 0;
  }
}

/**
 * @param {object} options
 * @param {object} options.appearanceService 读写奖励设置
 * @param {object} options.app 业务状态容器（读写奖励历史）
 * @param {Function} options.now 返回 { date, minutes }
 * @param {Function} [options.random] 随机源（测试注入固定序列；默认使用真实随机）
 */
export function createRewardService({ appearanceService, app, now, random }) {
  const randomFn = random ?? Math.random;

  function readSettings() {
    return appearanceService.getPreferences().rewards;
  }

  /* ---------------- 奖励项管理 ---------------- */

  function listItems({ includeDisabled = true } = {}) {
    const items = readSettings().items ?? [];
    return includeDisabled ? items : items.filter((item) => item.enabled !== false);
  }

  function addItem({ label, emoji = '🎁', weight = 1 }) {
    const trimmed = String(label ?? '').trim();
    if (!trimmed) return { ok: false, message: '请填写奖励名称。' };
    if (trimmed.length > 30) return { ok: false, message: '奖励名称请控制在 30 个字以内。' };

    const item = {
      id: `rwd_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`,
      label: trimmed,
      emoji: normalizeEmoji(emoji),
      weight: clampWeight(weight),
      enabled: true,
    };
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      rewards: { ...prefs.rewards, items: [...prefs.rewards.items, item] },
    }));
    return { ok: true, item };
  }

  function updateItem(id, patch = {}) {
    const items = listItems();
    if (!items.some((item) => item.id === id)) return { ok: false, message: '这个奖励已经不存在了。' };
    const next = items.map((item) => {
      if (item.id !== id) return item;
      const updated = { ...item };
      if (patch.label !== undefined) {
        const trimmed = String(patch.label).trim();
        if (!trimmed) return item;
        // 与 addItem 保持一致：超长直接不生效，而不是悄悄截断
        if (trimmed.length > 30) return item;
        updated.label = trimmed;
      }
      if (patch.emoji !== undefined) updated.emoji = normalizeEmoji(patch.emoji);
      if (patch.weight !== undefined) updated.weight = clampWeight(patch.weight);
      if (patch.enabled !== undefined) updated.enabled = Boolean(patch.enabled);
      return updated;
    });
    appearanceService.updatePreferences((prefs) => ({ ...prefs, rewards: { ...prefs.rewards, items: next } }));
    return { ok: true };
  }

  function removeItem(id) {
    const items = listItems();
    if (items.length <= 1) return { ok: false, message: '至少要保留一个奖励项，否则转盘无法转动。' };
    const next = items.filter((item) => item.id !== id);
    if (next.every((item) => item.enabled === false)) {
      return { ok: false, message: '至少要让一个奖励项处于启用状态。' };
    }
    appearanceService.updatePreferences((prefs) => ({ ...prefs, rewards: { ...prefs.rewards, items: next } }));
    return { ok: true };
  }

  function toggleItem(id, enabled) {
    return updateItem(id, { enabled });
  }

  function restoreDefaults() {
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      rewards: { ...prefs.rewards, items: DEFAULT_REWARDS.map((item) => ({ ...item })) },
    }));
    return { ok: true, count: DEFAULT_REWARDS.length };
  }

  function setEnabled(enabled) {
    appearanceService.updatePreferences((prefs) => ({ ...prefs, rewards: { ...prefs.rewards, enabled: Boolean(enabled) } }));
    return { ok: true };
  }

  function setTrigger(trigger, patch = {}) {
    if (!Object.values(REWARD_TRIGGER).includes(trigger)) return { ok: false, message: '未知的触发方式。' };
    appearanceService.updatePreferences((prefs) => ({
      ...prefs,
      rewards: {
        ...prefs.rewards,
        triggers: {
          ...prefs.rewards.triggers,
          [trigger]: { ...prefs.rewards.triggers[trigger], ...patch },
        },
      },
    }));
    return { ok: true };
  }

  /* ---------------- 抽奖机会 ---------------- */

  function readLedger() {
    const state = app.getState();
    return state.rewardLedger ?? {};
  }

  /** 当前的抽奖机会状态（纯推导，不写任何数据） */
  function eligibility() {
    const state = app.getState();
    const progress = computeProgress(state);
    const entitlement = computeEntitlement({
      progress,
      triggers: readSettings().triggers,
      ledger: readLedger(),
    });
    return { ...entitlement, progress };
  }

  /** 写入"已发放"计数（幂等键：每次发放前都重新推导，因此不会发重） */
  function consumeOpportunity() {
    const { perTrigger } = eligibility();
    // 按"剩余次数最多"的规则优先扣减，保证用户不会因为顺序问题少拿机会
    const source = [...perTrigger]
      .filter((item) => item.remaining > 0)
      .sort((a, b) => b.remaining - a.remaining || (a.trigger < b.trigger ? -1 : 1))[0];
    if (!source) return null;

    const ledger = { ...readLedger(), [source.trigger]: source.spent + 1 };
    const commit = app.commit((state) => ({ ...state, rewardLedger: ledger }), { reason: 'reward-consume' });
    if (!commit.ok) return null;
    return source.trigger;
  }

  /* ---------------- 抽奖 ---------------- */

  /**
   * 按权重选出中奖项。
   * 返回 `{ item, index }`，其中 `index` 是**在传入列表中的下标**，
   * 界面用它计算转盘应该停在哪一格。
   */
  function pickWeighted(items) {
    const total = items.reduce((sum, item) => sum + clampWeight(item.weight), 0);
    if (total <= 0) return { item: items[0], index: 0 };
    let ticket = randomFn() * total;
    for (let index = 0; index < items.length; index += 1) {
      ticket -= clampWeight(items[index].weight);
      if (ticket < 0) return { item: items[index], index };
    }
    return { item: items[items.length - 1], index: items.length - 1 };
  }

  /**
   * 抽一次奖。
   *
   * 顺序很重要：**先扣机会，再记录结果**。如果先记录再扣，一旦扣减失败就会出现
   * "记录里有奖、但机会没扣"的重复发奖漏洞。
   */
  function draw() {
    const settings = readSettings();
    if (!settings.enabled) return { ok: false, message: '奖励转盘当前已关闭，请先在设置里开启。' };

    const items = listItems({ includeDisabled: false });
    if (items.length === 0) return { ok: false, message: '没有启用的奖励项，请先启用至少一个。' };
    if (items.length === 1) {
      // 只有一个奖项时仍然真实返回它，但要如实告诉用户"结果被固定了"
      const trigger = consumeOpportunity();
      const entry = recordResult({ item: items[0], index: 0, trigger, forced: true });
      return { ok: true, item: items[0], index: 0, forced: true, entry, message: '当前只启用了一个奖励项，所以结果一定是它。' };
    }

    const before = eligibility();
    if (before.totalRemaining <= 0) {
      return {
        ok: false,
        message: '现在还没有抽奖机会。先去完成一段专注或一个学习时段，机会会自动累积。',
        eligibility: before,
      };
    }

    const picked = pickWeighted(items);
    const trigger = consumeOpportunity();
    const entry = recordResult({ item: picked.item, index: picked.index, trigger });

    return {
      ok: true,
      item: picked.item,
      index: picked.index,
      forced: false,
      entry,
      eligibility: eligibility(),
    };
  }

  /**
   * 连续抽奖（一次把积攒的机会用完）。
   * 单次最多 10 次，避免误操作把机会一次耗尽。
   */
  function drawMany(count) {
    const target = Math.min(MAX_BATCH_DRAW, Math.max(1, Math.round(Number(count) || 1)));
    const drawn = [];
    for (let index = 0; index < target; index += 1) {
      const result = draw();
      if (!result.ok) return { ok: drawn.length > 0, drawn, message: result.message };
      drawn.push(result);
    }
    return { ok: true, drawn };
  }

  function recordResult({ item, index, trigger, forced = false }) {
    const entry = {
      id: `rwl_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`,
      at: new Date(app.clock()).toISOString(),
      date: now().date,
      label: item.label,
      emoji: item.emoji ?? '🎁',
      itemId: item.id,
      trigger: trigger ?? null,
      forced,
      /** 用户是否确认"已领取/已完成"这次奖励（由用户自己点，应用不代劳） */
      claimedAt: null,
    };
    app.commit((state) => ({ ...state, rewardHistory: [...(state.rewardHistory ?? []), entry] }), {
      reason: 'reward-result',
    });
    return entry;
  }

  /** 用户确认领取（只更新这一条记录的时间，不做任何外部操作） */
  function markClaimed(entryId) {
    const state = app.getState();
    if (!(state.rewardHistory ?? []).some((entry) => entry.id === entryId)) {
      return { ok: false, message: '找不到这条中奖记录。' };
    }
    const commit = app.commit(
      (current) => ({
        ...current,
        rewardHistory: (current.rewardHistory ?? []).map((entry) =>
          entry.id === entryId ? { ...entry, claimedAt: new Date(app.clock()).toISOString() } : entry,
        ),
      }),
      { reason: 'reward-claim' },
    );
    return commit.ok ? { ok: true } : { ok: false, message: '记录领取状态失败。' };
  }

  /** 奖励历史（倒序） */
  function history({ limit = 50 } = {}) {
    return [...(app.getState().rewardHistory ?? [])]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);
  }

  /** 统计：真实数据，没有记录时如实为 0 */
  function stats() {
    const entries = app.getState().rewardHistory ?? [];
    const today = now().date;
    const byLabel = new Map();
    for (const entry of entries) {
      byLabel.set(entry.label, (byLabel.get(entry.label) ?? 0) + 1);
    }
    return {
      total: entries.length,
      today: entries.filter((entry) => entry.date === today).length,
      claimed: entries.filter((entry) => entry.claimedAt).length,
      mostFrequent: [...byLabel.entries()].sort((a, b) => b[1] - a[1])[0] ?? null,
    };
  }

  function clearHistory() {
    const commit = app.commit((state) => ({ ...state, rewardHistory: [] }), { reason: 'reward-history-clear' });
    return commit.ok ? { ok: true } : { ok: false, message: '清空失败。' };
  }

  return {
    listItems,
    addItem,
    updateItem,
    removeItem,
    toggleItem,
    restoreDefaults,
    setEnabled,
    setTrigger,
    eligibility,
    draw,
    drawMany,
    markClaimed,
    history,
    stats,
    clearHistory,
    /** 供测试注入随机源 */
    pickWeighted,
  };
}

function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(10, Math.max(1, Math.round(number)));
}

function normalizeEmoji(value) {
  const text = String(value ?? '').trim();
  if (!text) return '🎁';
  // 只保留前几个字符，避免用户粘贴超长内容把界面撑坏
  return [...text].slice(0, 4).join('');
}
