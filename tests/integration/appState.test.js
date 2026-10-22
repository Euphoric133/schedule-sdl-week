/**
 * 应用状态容器集成测试（对应验收场景 13/14/15）。
 *
 * 这一层是"内存状态"与"磁盘数据"的唯一协调者，因此必须验证：
 * - 首次加载会自动创建并落盘空状态
 * - 保存失败时内存回滚，内存与磁盘不会不一致
 * - 导入合法备份会替换数据；导入非法备份时现有数据一个字节都不变
 * - 重新加载（模拟刷新页面）后任务与计划仍然存在
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schemas.js';
import { createAppState } from '../../src/services/appState.js';
import { createMemoryAdapter } from '../../src/storage/memoryAdapter.js';
import { STORAGE_ERROR_CODES } from '../../src/storage/storagePort.js';
import { BACKUP_FORMAT, buildBackup, serializeBackup } from '../../src/storage/backup.js';
import { FIXED_NOW_ISO, fixedClock, testIdFactory } from '../helpers/clock.js';
import { createTestApp, taskInput } from '../helpers/app.js';
import { makeTask } from '../helpers/fixtures.js';

test('首次加载：创建空状态并立即落盘（刷新后不会连空状态都没有）', () => {
  const adapter = createMemoryAdapter();
  const app = createAppState({ adapter, clock: () => FIXED_NOW_ISO, windowStart: '2025-10-16' });
  const report = app.load();

  assert.equal(report.loaded, false);
  assert.equal(report.fromStorage, false);
  assert.equal(app.getState().tasks.length, 0);

  const raw = adapter.readRaw();
  assert.ok(raw, '首次加载应把空状态写入存储');
  assert.equal(raw.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('保存成功后可以重新加载（模拟刷新页面，对应验收场景 14）', () => {
  const adapter = createMemoryAdapter();
  const clock = fixedClock();
  const first = createAppState({ adapter, clock: () => clock().toISOString(), windowStart: '2025-10-16' });
  first.load();
  const result = first.commit((state) => ({ ...state, tasks: [makeTask({ title: '重载测试任务' })] }), { reason: 'test' });
  assert.equal(result.ok, true);

  // 用同一份存储重新装配应用（等价于用户刷新页面）
  const second = createAppState({ adapter, clock: () => clock().toISOString(), windowStart: '2025-10-16' });
  const report = second.load();
  assert.equal(report.fromStorage, true);
  assert.equal(second.getState().tasks.length, 1);
  assert.equal(second.getState().tasks[0].title, '重载测试任务');
});

test('保存失败时回滚内存状态，保证内存与磁盘一致', () => {
  const adapter = createMemoryAdapter();
  const app = createAppState({ adapter, clock: () => FIXED_NOW_ISO, windowStart: '2025-10-16' });
  app.load();
  app.commit((state) => ({ ...state, tasks: [{ id: 'tsk_ok' }] }), { reason: 'seed' });

  // 让后续写入全部失败
  adapter.save = () => ({ ok: false, error: Object.assign(new Error('写不进去'), { code: STORAGE_ERROR_CODES.QUOTA_EXCEEDED }) });

  const failed = app.commit((state) => ({ ...state, tasks: [{ id: 'tsk_broken' }] }), { reason: 'fail' });
  assert.equal(failed.ok, false);
  assert.equal(app.getState().tasks[0].id, 'tsk_ok', '失败后内存状态必须回滚');

  const notifications = app.getNotifications();
  assert.ok(notifications.some((n) => n.level === 'error' && /写不进去/.test(n.message)), '失败必须产生用户可见的通知');
});

test('内存降级：适配器不可用时应用仍能运行，但明确告知不会保存', () => {
  const unavailable = createMemoryAdapter();
  unavailable.isAvailable = () => false;

  const app = createAppState({ adapter: unavailable, clock: () => FIXED_NOW_ISO, windowStart: '2025-10-16' });
  app.load();
  assert.equal(app.persistenceAvailable, false);
  assert.equal(app.getState().tasks.length, 0, '仍可正常使用空状态');
});

test('导出 → 导入：合法备份可以恢复任务数据', async () => {
  const { app, services } = createTestApp();
  const created = services.taskService.addTask(taskInput({ title: '导出测试' }));
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));

  const exported = app.exportBackup();
  assert.match(exported.filename, /\.json$/);

  const fresh = createTestApp();
  const imported = await fresh.app.importBackup(exported.text);
  assert.equal(imported.ok, true, imported.issues?.map((i) => i.message).join('; '));
  assert.equal(fresh.app.getState().tasks.length, 1);
  assert.equal(fresh.app.getState().tasks[0].title, '导出测试');
});

test('导入非法数据：现有数据完全不受影响（对应验收场景 15）', async () => {
  const { app, services } = createTestApp();
  const created = services.taskService.addTask(taskInput({ title: '必须保留' }));
  assert.equal(created.ok, true);
  const before = JSON.stringify(app.getState());

  // 构造一份"任务时长自相矛盾"的备份：预计 60 分钟，却有一个 90 分钟的已完成时段
  const inconsistent = {
    ...app.getState(),
    tasks: [{ ...makeTask({ plannedMinutes: 60 }), id: 'tsk_bad' }],
    sessions: [
      {
        id: 'ses_bad',
        taskId: 'tsk_bad',
        date: '2025-10-16',
        startMinutes: 960,
        endMinutes: 1050,
        plannedMinutes: 90,
        actualMinutes: 90,
        state: 'completed',
        locked: true,
        source: 'engine',
        reasonCodes: [],
        planVersion: null,
        createdAt: FIXED_NOW_ISO,
        updatedAt: FIXED_NOW_ISO,
        startedAt: null,
        completedAt: FIXED_NOW_ISO,
        history: [],
      },
    ],
  };

  const badCases = [
    ['非法 JSON', '不是 JSON'],
    ['错误的格式标识', JSON.stringify({ format: 'other', state: app.getState() })],
    ['缺少必需字段', JSON.stringify({ format: BACKUP_FORMAT, state: { tasks: [], sessions: [] } })],
    ['字段类型错误', JSON.stringify({ format: BACKUP_FORMAT, state: { ...app.getState(), tasks: 'nope' } })],
    ['任务时长不一致', JSON.stringify({ format: BACKUP_FORMAT, state: inconsistent })],
  ];

  for (const [name, text] of badCases) {
    const result = await app.importBackup(text);
    assert.equal(result.ok, false, `应拒绝导入（${name}）`);
    assert.ok(result.issues?.some((i) => i.severity === 'error'), `${name} 应给出至少一条错误说明`);
    assert.equal(JSON.stringify(app.getState()), before, `${name} 被拒绝后现有数据必须完全不变`);
  }
});

test('导入成功后状态被整体替换（旧数据不会与导入数据混合）', async () => {
  const { app, services } = createTestApp();
  services.taskService.addTask(taskInput({ title: '旧任务', subject: '旧科目' }));

  const incomingTask = makeTask({ title: '导入的任务', subject: '新科目' });
  const incoming = { ...app.getState(), tasks: [incomingTask], sessions: [] };
  const result = await app.importBackup(serializeBackup(buildBackup(incoming, { nowIso: FIXED_NOW_ISO })));

  assert.equal(result.ok, true, result.issues?.map((i) => i.message).join('; '));
  assert.deepEqual(app.getState().tasks.map((t) => t.title), ['导入的任务']);
});

test('markBackupExported 记录导出时间，供备份提醒使用', () => {
  const { app } = createTestApp();
  assert.equal(app.getState().meta.lastBackupAt, null);
  app.markBackupExported();
  assert.ok(app.getState().meta.lastBackupAt);
});

test('订阅机制：数据变化会通知订阅者，退订后不再收到通知', () => {
  const { app } = createTestApp();
  let count = 0;
  const unsubscribe = app.subscribe(() => {
    count += 1;
  });

  app.commit((state) => ({ ...state, meta: { ...state.meta, ping: 1 } }), { reason: 'a' });
  assert.equal(count, 1);

  unsubscribe();
  app.commit((state) => ({ ...state, meta: { ...state.meta, ping: 2 } }), { reason: 'b' });
  assert.equal(count, 1, '退订后不应再收到通知');
});

test('订阅者抛异常不会破坏数据一致性', () => {
  const { app } = createTestApp();
  app.subscribe(() => {
    throw new Error('界面渲染失败');
  });
  const result = app.commit((state) => ({ ...state, tasks: [{ id: 'tsk_x' }] }), { reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(app.getState().tasks.length, 1);
  assert.ok(app.getNotifications().some((n) => /界面更新失败/.test(n.message)));
});

test('完整链路：通过服务层创建任务 → 保存 → 重新加载 → 任务仍在', () => {
  const adapter = createMemoryAdapter();
  const first = createTestApp({ adapter });
  const created = first.services.taskService.addTask(taskInput({ title: '流程测试任务' }));
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));

  // 用同一份存储重新装配（等价于刷新页面）
  const second = createTestApp({ adapter });
  assert.equal(second.loadReport.fromStorage, true);
  assert.equal(second.app.getState().tasks.length, 1);
  assert.equal(second.app.getState().tasks[0].title, '流程测试任务');
});
