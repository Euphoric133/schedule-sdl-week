/**
 * 引擎测试辅助：构造输入并运行排程。
 *
 * 所有辅助函数都遵循同一条原则：**显式传入"现在"**。
 * 引擎是纯函数，测试里绝不依赖真实系统时间，否则跨天运行就会出现偶发失败。
 */

import { createEmptyState, defaultSettings } from '../../src/domain/schemas.js';
import { createTask } from '../../src/domain/task.js';
import { createSession } from '../../src/domain/session.js';
import { createFixedActivity } from '../../src/domain/fixedActivity.js';
import { run as runScheduler } from '../../src/engine/scheduler.js';
import { buildPolicy } from '../../src/engine/policy.js';
import { FIXED_NOW, FIXED_NOW_ISO, testIdFactory } from './clock.js';

export const NOW = Object.freeze({ date: FIXED_NOW.date, minutes: FIXED_NOW.minutes });
export const WINDOW_START = FIXED_NOW.date;

/**
 * 创建一个排程测试上下文。
 * @param {object} [options]
 * @param {object} [options.settings] 覆盖默认设置
 * @param {object} [options.now]
 */
/**
 * 共享的 ID 工厂。
 *
 * 引擎的确定性契约是"同一输入 → 同一计划"，而输入里包含任务/时段的 ID。
 * 因此需要比较确定性的测试必须复用同一个工厂（否则每次创建出来的任务 ID 都不同，
 * 得到的输入本来就不是"同一输入"，派生出的时段 ID 自然也不同）。
 */
const sharedIdFactory = testIdFactory();

export function engineContext(options = {}) {
  const idFactory = options.idFactory ?? sharedIdFactory;
  const ctx = { idFactory, nowIso: FIXED_NOW_ISO };
  const settings = { ...defaultSettings(), ...(options.settings ?? {}) };
  const now = options.now ?? NOW;

  const state = {
    ...createEmptyState({ nowIso: FIXED_NOW_ISO, windowStart: now.date }),
    settings,
    tasks: [],
    sessions: [],
    fixedActivities: [],
  };

  return {
    idFactory,
    ctx,
    now,
    settings,
    state,
    /** 添加一个任务（返回创建出的实体，便于后续引用其 id） */
    addTask(overrides = {}) {
      const base = {
        title: '线性代数作业',
        subject: '数学',
        plannedMinutes: 90,
        deadlineDate: '2025-10-20',
        deadlineTime: '23:00',
        importance: 4,
        difficulty: 4,
        procrastination: 3,
        splittable: true,
        minChunkMinutes: 30,
        maxChunkMinutes: 60,
        dependsOn: [],
      };
      const task = createTask({ ...base, ...overrides }, ctx);
      state.tasks.push(task);
      return task;
    },
    /** 添加一个固定活动（默认每周四 08:00–09:40 上课） */
    addFixedActivity(overrides = {}) {
      const base = {
        title: '高等数学课',
        type: 'class',
        recurrence: { kind: 'weekly', daysOfWeek: [4] },
        start: '08:00',
        end: '09:40',
      };
      const activity = createFixedActivity({ ...base, ...overrides }, ctx);
      state.fixedActivities.push(activity);
      return activity;
    },
    /** 直接写入一个时段（用于构造"已完成""已锁定"等前置状态） */
    addSession(overrides = {}) {
      const session = createSession(overrides, ctx);
      state.sessions.push(session);
      return session;
    },
    /** 运行排程 */
    run(input = {}) {
      return runScheduler({
        state,
        now,
        windowStart: input.windowStart ?? now.date,
        windowDays: input.windowDays ?? 7,
        existingPlan: input.existingPlan ?? null,
        baseVersion: input.baseVersion,
        optimizationPasses: input.optimizationPasses,
        planId: input.planId,
      });
    },
    /** 当前设置对应的策略对象 */
    policy(extra = {}) {
      return buildPolicy({ ...settings, ...extra });
    },
    /** 设置可学习窗口：默认 16:00–23:00 的每天，或按传入的窗口表 */
    setStudyWindows(map) {
      state.settings = { ...state.settings, studyWindows: map };
      return state.settings;
    },
    /** 每个星期几都使用同一个窗口 */
    setUniformWindow(startMinutes, endMinutes) {
      const map = {};
      for (const day of [1, 2, 3, 4, 5, 6, 7]) map[day] = [{ startMinutes, endMinutes }];
      return this.setStudyWindows(map);
    },
  };
}

/** 从计划中取出学习块，按日期与时间排序 */
export function studyBlocks(plan) {
  return (plan?.blocks ?? [])
    .filter((block) => block.kind === 'study')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMinutes - b.startMinutes));
}

/** 某任务在计划中的学习块 */
export function blocksOfTask(plan, taskId) {
  return studyBlocks(plan).filter((block) => block.taskId === taskId);
}

/** 某任务在计划中的总分钟数 */
export function plannedMinutesOf(plan, taskId) {
  return blocksOfTask(plan, taskId).reduce((sum, block) => sum + (block.endMinutes - block.startMinutes), 0);
}

/** 两个区间是否重叠（半开区间） */
export function overlaps(a, b) {
  return a.date === b.date && a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * 把计划序列化成"用于断言确定性"的形状。
 *
 * 归一化规则：
 * - **引擎派生 ID**（形如 `ses_1a2b3c4d`，8 位哈希）是引擎的输出，必须纳入比较 ——
 *   它们由输入指纹推导，若不比较就测不出"派生 ID 不稳定"这类缺陷。
 * - **保留块 ID / refId** 里含实体 ID（由 ID 工厂生成），与排程确定性无关，统一归一化。
 */
export function stablePlanShape(plan) {
  const isDerivedId = (id) => typeof id === 'string' && /^(ses|rst|buf)_[0-9a-f]{8}$/.test(id);

  return JSON.stringify({
    status: plan.status,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    days: plan.days.map((day) => ({
      date: day.date,
      study: day.studyMinutes,
      rest: day.restMinutes,
      buffer: day.bufferMinutes,
      sessions: day.sessionCount,
    })),
    blocks: plan.blocks.map((block) => ({
      id: isDerivedId(block.id) ? block.id : `reserved:${block.kind}:${block.date}:${block.startMinutes}`,
      kind: block.kind,
      date: block.date,
      start: block.startMinutes,
      end: block.endMinutes,
      subject: block.subject ?? null,
      locked: Boolean(block.locked),
    })),
    unscheduled: plan.unscheduled.map((item) => ({ taskId: item.taskId, minutes: item.remainingMinutes, reason: item.reasonCode })),
    metrics: plan.metrics,
  });
}
