/**
 * 集成测试辅助：装配完整应用（存储 → 服务 → 领域），但不涉及 DOM。
 *
 * 这样可以端到端地验证"用户操作 → 数据落盘 → 重新加载"的真实链路，
 * 而不是只测单个函数。DOM 渲染由阶段 5 的人工验收清单覆盖。
 */

import { createAppState } from '../../src/services/appState.js';
import { createTaskService } from '../../src/services/taskService.js';
import { createPlanService } from '../../src/services/planService.js';
import { createFocusService } from '../../src/services/focusService.js';
import { createFixedActivityService } from '../../src/services/fixedActivityService.js';
import { createRestService } from '../../src/services/restService.js';
import { createStatsService } from '../../src/services/statsService.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { FIXED_NOW, fixedClock, testIdFactory } from './clock.js';

/**
 * 创建一个完整的、可持久化到内存的应用实例。
 * @param {object} [options]
 * @param {object} [options.adapter] 自定义存储适配器（默认内存）
 * @param {object} [options.wall] 固定墙钟时间
 */
export function createTestApp(options = {}) {
  const wall = options.wall ?? FIXED_NOW;
  const clock = fixedClock(wall);
  const adapter = options.adapter ?? createMemoryAdapter();
  const idFactory = options.idFactory ?? testIdFactory();

  const app = createAppState({
    adapter,
    clock: () => clock().toISOString(),
    windowStart: wall.date,
  });
  const loadReport = app.load();

  const services = {
    app,
    idFactory,
    now: () => ({ date: wall.date, minutes: wall.minutes, weekday: wall.weekday }),
  };
  services.taskService = createTaskService({ app, idFactory });
  services.fixedActivityService = createFixedActivityService({ app, idFactory });
  services.restService = createRestService({ app });
  services.statsService = createStatsService({ app, now: () => services.now() });
  services.planService = createPlanService({ app, idFactory });
  services.focusService = createFocusService({ app, idFactory, now: services.now });

  return { app, services, adapter, idFactory, wall, loadReport };
}

/** 一次合法的任务输入（测试样本，不会被写入产品默认数据） */
export function taskInput(overrides = {}) {
  return {
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
    note: '',
    ...overrides,
  };
}
