/**
 * 测试辅助：构造合法的领域实体与完整应用状态（**不含任何虚构业务数据**）。
 *
 * 这里的"任务"是测试用的最小合法样本，只在测试进程内存在，不会被写进应用默认数据，
 * 因此不会出现"用假数据冒充真实用户数据"的问题。
 */

import { createEmptyState, defaultSettings } from '../../src/domain/schemas.js';
import { createTask } from '../../src/domain/task.js';
import { createSession } from '../../src/domain/session.js';
import { createFixedActivity } from '../../src/domain/fixedActivity.js';
import { FIXED_NOW_ISO, testIdFactory } from './clock.js';

/** 常用测试上下文：固定 ID 工厂 + 固定时钟 */
export function testContext() {
  return { idFactory: testIdFactory(), nowIso: FIXED_NOW_ISO };
}

/**
 * 构造一个任务。默认值都是合法的最小值，参数覆盖用于构造具体场景。
 * @param {object} [overrides]
 */
export function makeTask(overrides = {}, ctx = testContext()) {
  const base = {
    title: '线性代数作业',
    subject: '数学',
    plannedMinutes: 90,
    deadlineDate: '2025-10-18',
    deadlineTime: '23:00',
    importance: 4,
    difficulty: 4,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
    note: '',
  };
  return createTask({ ...base, ...overrides }, ctx);
}

/** 构造一个学习时段（overrides 可覆盖 id，便于测试引用具体时段） */
export function makeSession(overrides, ctx = testContext()) {
  const base = {
    id: undefined,
    taskId: 'tsk_placeholder',
    date: '2025-10-16',
    startMinutes: 16 * 60,
    endMinutes: 17 * 60,
    state: 'flexible',
    locked: false,
    source: 'engine',
  };
  const merged = { ...base, ...overrides };
  const session = createSession(merged, ctx);
  // createSession 总是生成新 ID；测试若显式指定 id，则保留测试提供的值以便断言
  return merged.id ? { ...session, id: merged.id } : session;
}

/** 构造一个固定活动 */
export function makeFixedActivity(overrides, ctx = testContext()) {
  const base = {
    title: '高等数学课',
    type: 'class',
    recurrence: { kind: 'weekly', daysOfWeek: [4] },
    start: '08:00',
    end: '09:40',
  };
  return createFixedActivity({ ...base, ...overrides }, ctx);
}

/** 构造一个完全合法的空状态（用于校验器与存储测试） */
export function makeState(overrides = {}) {
  return {
    ...createEmptyState({ nowIso: FIXED_NOW_ISO, windowStart: '2025-10-16', timeZone: 'Asia/Shanghai' }),
    ...overrides,
  };
}

/** 便于测试修改设置：返回默认设置的深拷贝（避免测试之间互相污染） */
export function makeSettings(patch = {}) {
  return { ...structuredClone(defaultSettings()), ...patch };
}
