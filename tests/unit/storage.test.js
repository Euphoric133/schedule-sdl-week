/**
 * 存储层测试（对应验收场景 13–15）。
 *
 * 覆盖：
 * - 保存 / 加载 / 备份轮转
 * - 主数据损坏时从备份恢复
 * - 迁移：缺少版本号、版本高于程序、缺字段补默认值
 * - localStorage 适配器：写入失败（配额）时旧数据必须完好
 * - 导入导出：错误数据不覆盖现有数据
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter, loadFromReader } from '../../src/storage/memoryAdapter.js';
import { createLocalStorageAdapter, getLocalStorage } from '../../src/storage/localStorageAdapter.js';
import { migrateState, MIGRATIONS } from '../../src/storage/migrations.js';
import {
  STORAGE_ERROR_CODES,
  STORAGE_KEYS,
  classifyStorageError,
  makeStorageError,
} from '../../src/storage/storagePort.js';
import {
  BACKUP_FORMAT,
  applyImport,
  backupReminder,
  buildBackup,
  parseImport,
  serializeBackup,
  suggestBackupFilename,
} from '../../src/storage/backup.js';
import { CURRENT_SCHEMA_VERSION, defaultSettings } from '../../src/domain/schemas.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';
import { FIXED_NOW_ISO } from '../helpers/clock.js';
import { makeState, makeTask, testContext } from '../helpers/fixtures.js';

/** 可注入失败的假 localStorage，用于测配额与安全策略等真实但难复现的场景 */
function fakeStorage({ failOnWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failOnWrite) {
        const err = new Error('quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

test('内存适配器：首次加载报告 empty，不抛异常', () => {
  const adapter = createMemoryAdapter();
  assert.equal(adapter.isAvailable(), true);
  const result = adapter.load();
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.equal(result.state, null);
});

test('内存适配器：保存后可以读回完全一致的数据', () => {
  const adapter = createMemoryAdapter();
  const state = makeState();
  assert.equal(adapter.save(state).ok, true);
  const result = adapter.load();
  assert.equal(result.ok, true);
  assert.equal(result.empty, false);
  assert.deepEqual(result.state, state);
  assert.ok(adapter.lastSavedAt(), '应记录最后保存时间');
});

test('内存适配器：第二次保存会把旧数据轮转为备份（供损坏恢复）', () => {
  const adapter = createMemoryAdapter();
  const first = makeState();
  const second = { ...makeState(), meta: { ...makeState().meta, marker: 'second' } };
  adapter.save(first);
  adapter.save(second);
  assert.equal(adapter.readBackup().meta.marker, undefined, '备份应是第一次保存的数据');
  assert.equal(adapter.readRaw().meta.marker, 'second');
});

test('加载：主数据不是合法 JSON 时从备份恢复，并标记 recovered', () => {
  const first = makeState();
  const polluted = createMemoryAdapter();
  polluted.save(first); // 主数据 = first
  polluted.save({ ...makeState(), meta: { ...first.meta, marker: 'second' } }); // 主数据 = second，备份 = first
  assert.deepEqual(polluted.readBackup(), first, '备份轮转应保存上一份主数据');

  // 模拟磁盘上的主数据被写坏（不再是合法 JSON），但备份仍然完好
  const corruptValue = '{ 这不是合法 JSON';
  const store = new Map([
    [STORAGE_KEYS.state, corruptValue],
    [STORAGE_KEYS.backup, JSON.stringify(first)],
  ]);
  const readJson = (key) => {
    if (!store.has(key)) return { present: false, value: null, corrupted: false };
    try {
      return { present: true, value: JSON.parse(store.get(key)), corrupted: false };
    } catch {
      return { present: true, value: null, corrupted: true };
    }
  };
  const result = loadFromReader(readJson, (state) => ({ ok: true, state }));
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true, '损坏时应从备份恢复');
  assert.deepEqual(result.state, first);
});

test('loadFromReader 行为：损坏主数据 → 回退备份', () => {
  const store = new Map([
    [STORAGE_KEYS.state, '{ 这不是合法 JSON'],
    [STORAGE_KEYS.backup, JSON.stringify(makeState())],
  ]);
  const readJson = (key) => {
    if (!store.has(key)) return { present: false, value: null, corrupted: false };
    try {
      return { present: true, value: JSON.parse(store.get(key)), corrupted: false };
    } catch {
      return { present: true, value: null, corrupted: true };
    }
  };
  const result = loadFromReader(readJson, (state) => ({ ok: true, state }));
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.ok(result.state.tasks);
});

test('loadFromReader 行为：迁移失败且备份也不可用时如实报错，绝不返回半可用数据', () => {
  const store = new Map([[STORAGE_KEYS.state, JSON.stringify({ schemaVersion: 999 })]]);
  const readJson = (key) => {
    if (!store.has(key)) return { present: false, value: null, corrupted: false };
    return { present: true, value: JSON.parse(store.get(key)), corrupted: false };
  };
  const result = loadFromReader(readJson, (state) => migrateState(state));
  assert.equal(result.ok, false);
  assert.equal(result.state, null);
  assert.ok(result.error);
});

test('迁移：缺少版本号的数据按 v1 补齐容器并给出提示', () => {
  const bare = { settings: undefined, tasks: undefined };
  const result = migrateState(bare);
  assert.equal(result.ok, true);
  assert.equal(result.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(result.state.tasks, []);
  assert.deepEqual(result.state.sessions, []);
  assert.ok(result.issues.some((i) => i.code === VALIDATION_CODES.SCHEMA_VERSION_UNSUPPORTED));
  assert.equal(result.state.settings.dayBoundaryHour, 4, '缺失设置会用默认值补齐');
  assert.equal('bufferRatio' in result.state.settings, false, '缓冲功能已移除，不再补这个字段');
});

test('迁移：版本高于程序支持版本时拒绝加载（保护数据不被旧程序写坏）', () => {
  const result = migrateState({ ...makeState(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === VALIDATION_CODES.SCHEMA_VERSION_UNSUPPORTED));
});

test('迁移：语义校验失败时返回 ok=false 并带上具体问题（调用方据此拒绝写入）', () => {
  const ctx = testContext();
  const task = makeTask({ title: '原始任务' }, ctx);
  // 第二个任务与第一个 ID 相同：这是真实的"ID 重复"损坏场景
  const duplicated = { ...makeTask({ title: '重复 ID 的任务' }, ctx), id: task.id };
  const result = migrateState({ ...makeState(), tasks: [task, duplicated] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === VALIDATION_CODES.ENTITY_DUPLICATE_ID));
});

test('迁移步骤表：从 v1 到当前版本的每一步都必须有可执行的迁移函数', () => {
  // 这条测试的用意没变：不允许出现"版本号跳了、迁移却没写"的漏洞——
  // 那会让旧数据在新代码上直接读不出来。
  for (let version = 1; version < CURRENT_SCHEMA_VERSION; version += 1) {
    assert.equal(typeof MIGRATIONS[version], 'function', `缺少 v${version} → v${version + 1} 的迁移步骤`);
  }
});

test('localStorage 适配器：不可用时 isAvailable 为 false 且给出明确错误码', () => {
  const adapter = createLocalStorageAdapter({ storage: null });
  // 无 storage 且运行环境没有 localStorage（Node 环境）→ 不可用
  const available = getLocalStorage() !== null;
  if (!available) {
    assert.equal(adapter.isAvailable(), false);
    const result = adapter.load();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, STORAGE_ERROR_CODES.UNAVAILABLE);
    const saveResult = adapter.save(makeState());
    assert.equal(saveResult.ok, false);
    assert.equal(saveResult.error.code, STORAGE_ERROR_CODES.UNAVAILABLE);
  }
});

test('localStorage 适配器：正常保存与读取（注入假实现，不依赖真实浏览器）', () => {
  const storage = fakeStorage();
  const adapter = createLocalStorageAdapter({ storage });
  const state = makeState();
  assert.equal(adapter.save(state).ok, true);
  assert.equal(adapter.isAvailable(), true);
  assert.deepEqual(adapter.load().state, state);
  assert.ok(adapter.usedBytes() > 0);
  assert.ok(adapter.lastSavedAt());
});

test('localStorage 适配器：配额写满时旧数据完好，且返回可读错误', () => {
  const storage = fakeStorage();
  const adapter = createLocalStorageAdapter({ storage });
  const first = makeState();
  adapter.save(first);

  // 让后续写入失败（模拟配额耗尽）
  storage.setItem = () => {
    const err = new Error('quota');
    err.name = 'QuotaExceededError';
    throw err;
  };
  const result = adapter.save({ ...makeState(), marker: 'new' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, STORAGE_ERROR_CODES.QUOTA_EXCEEDED);
  assert.match(result.error.message, /存储空间已满/);

  // 旧数据仍然可以读回（备份轮转发生在主写入之前）
  const recovered = adapter.load();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.state, first);
});

test('classifyStorageError 把浏览器差异映射为稳定错误码', () => {
  assert.equal(classifyStorageError({ name: 'QuotaExceededError' }), STORAGE_ERROR_CODES.QUOTA_EXCEEDED);
  assert.equal(classifyStorageError({ code: 22 }), STORAGE_ERROR_CODES.QUOTA_EXCEEDED);
  assert.equal(classifyStorageError({ name: 'SecurityError' }), STORAGE_ERROR_CODES.UNAVAILABLE);
  assert.equal(classifyStorageError(new Error('something else')), STORAGE_ERROR_CODES.WRITE_FAILED);
  assert.equal(classifyStorageError(null), STORAGE_ERROR_CODES.WRITE_FAILED);
  assert.match(makeStorageError(STORAGE_ERROR_CODES.CORRUPTED).message, /损坏/);
});

test('导出：备份对象包含格式标识、版本、摘要与完整状态', () => {
  const state = makeState();
  const backup = buildBackup(state, { nowIso: FIXED_NOW_ISO });
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.schemaVersion, state.schemaVersion);
  assert.equal(backup.summary.taskCount, 0);
  assert.equal(backup.state, state);

  const text = serializeBackup(backup);
  assert.ok(text.includes(BACKUP_FORMAT));
  assert.match(suggestBackupFilename(FIXED_NOW_ISO), /^七天学习规划器-备份-2025-10-16\.json$/);
});

test('导入：合法备份可以解析，并带上摘要', () => {
  const ctx = testContext();
  const state = { ...makeState(), tasks: [makeTask({}, ctx)] };
  const text = serializeBackup(buildBackup(state, { nowIso: FIXED_NOW_ISO }));
  const result = parseImport(text);
  assert.equal(result.ok, true);
  assert.equal(result.summary.taskCount, 1);
  assert.equal(result.exportedAt, FIXED_NOW_ISO);
});

test('导入：错误数据全部被拒绝，并给出可定位的问题（不写入任何数据）', () => {
  const invalidCases = [
    ['空内容', '', /空/],
    ['非法 JSON', '{ 不是 json', /语法错误/],
    ['顶层是数组', '[1,2,3]', /不是一个 JSON 对象/],
    ['缺少 state', JSON.stringify({ format: BACKUP_FORMAT }), /缺少 state/],
    ['格式不对', JSON.stringify({ format: 'other-app', state: makeState() }), /不是本应用的备份文件/],
  ];
  for (const [name, text, pattern] of invalidCases) {
    const result = parseImport(text);
    assert.equal(result.ok, false, `${name} 应当被拒绝`);
    assert.ok(
      result.issues.some((i) => i.severity === 'error' && pattern.test(i.message)),
      `${name} 的错误信息应说明原因，实际：${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.state, undefined);
  }
});

test('导入：裸状态对象会被接受但给出提示（便于手工构造数据）', () => {
  const result = parseImport(JSON.stringify(makeState()));
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((i) => i.severity === 'warning' && /没有备份标识/.test(i.message)));
});

test('applyImport：未通过校验的结果一律不写入（保护现有数据，对应验收场景 15）', () => {
  const adapter = createMemoryAdapter();
  const existing = makeState();
  adapter.save(existing);

  const rejected = applyImport(adapter, { ok: false, error: new Error('bad') });
  assert.equal(rejected.ok, false);

  const stillThere = adapter.load();
  assert.deepEqual(stillThere.state, existing, '现有数据必须一个字节都没变');
});

test('applyImport：通过校验的结果会写入并可读回', () => {
  const adapter = createMemoryAdapter();
  const ctx = testContext();
  const imported = parseImport(serializeBackup(buildBackup({ ...makeState(), tasks: [makeTask({}, ctx)] }, { nowIso: FIXED_NOW_ISO })));
  const applied = applyImport(adapter, imported);
  assert.equal(applied.ok, true);
  assert.equal(adapter.load().state.tasks.length, 1);
});

test('备份提醒：从未导出与超期两种情况都要提醒', () => {
  const never = backupReminder(makeState(), FIXED_NOW_ISO);
  assert.equal(never.shouldRemind, true);
  assert.match(never.reason, /还没有导出/);

  const recent = backupReminder({ ...makeState(), meta: { lastBackupAt: '2025-10-14T10:00:00+08:00' } }, FIXED_NOW_ISO);
  assert.equal(recent.shouldRemind, false);

  const stale = backupReminder({ ...makeState(), meta: { lastBackupAt: '2025-09-01T10:00:00+08:00' } }, FIXED_NOW_ISO);
  assert.equal(stale.shouldRemind, true);
  assert.match(stale.reason, /距离上次导出备份已/);
});

test('v1 → v2 迁移：补上 latestSleepMinutes，且不改变任何已有设置', () => {
  const v1 = {
    schemaVersion: 1,
    createdAt: '2025-10-16T00:00:00.000Z',
    updatedAt: '2025-10-16T00:00:00.000Z',
    timeZone: null,
    settings: {
      ...defaultSettings(),
      latestSleepMinutes: undefined,
      // 用户特意调过的值，迁移后必须原样保留
      baseContinuousMinutes: 45,
      dailyStudyCapMinutes: 180,
    },
    tasks: [],
    sessions: [],
    fixedActivities: [],
    restPeriods: [],
    subjects: [],
    officialPlan: null,
    planHistory: [],
    pendingPreview: null,
    meta: { lastBackupAt: null, migrationLog: [], lastPlanMutation: null, initialWindowStart: '2025-10-16', planId: null },
  };
  delete v1.settings.latestSleepMinutes;

  const result = migrateState(v1);
  assert.equal(result.ok, true, JSON.stringify(result.issues?.map((i) => i.message)));
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.settings.latestSleepMinutes, null, '默认必须是 null：凭空给个时刻会改变老用户现有计划');
  assert.equal(result.state.settings.baseContinuousMinutes, 45, '用户自定义设置不能被迁移覆盖');
  assert.equal(result.state.settings.dailyStudyCapMinutes, 180);
});

test('最新版本的数据再次迁移是幂等的（不重复改字段）', () => {
  const state = { ...makeState(), schemaVersion: CURRENT_SCHEMA_VERSION, settings: { ...defaultSettings(), latestSleepMinutes: 22 * 60 } };
  const result = migrateState(state);
  assert.equal(result.ok, true);
  assert.equal(result.state.settings.latestSleepMinutes, 22 * 60, '已有值不应被重置');
});
