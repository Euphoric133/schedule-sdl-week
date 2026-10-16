/**
 * ID 工厂测试：唯一性、可预测性、前缀正确性。
 *
 * 为什么重要：ID 是任务与时段之间唯一的关联方式。ID 重复会让计划数据互相覆盖，
 * 而不可预测的 ID 会让测试无法断言（也就无法回归）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ID_PREFIXES, createIdFactory, createSeededRandom, idKindOf } from '../../src/domain/ids.js';

test('同一工厂实例内 ID 永不重复，且带正确前缀', () => {
  const factory = createIdFactory({ clock: () => 1760627400000, seed: 7 });
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = factory.next('task');
    assert.match(id, /^tsk_/);
    assert.equal(ids.has(id), false, `出现重复 ID：${id}`);
    ids.add(id);
  }
  assert.equal(factory.size(), 500);
});

test('相同种子 + 相同时钟 → 完全相同的 ID 序列（测试可复现）', () => {
  const a = createIdFactory({ clock: () => 1000, seed: 99 });
  const b = createIdFactory({ clock: () => 1000, seed: 99 });
  const seqA = [a.next('session'), a.next('session'), a.next('task')];
  const seqB = [b.next('session'), b.next('session'), b.next('task')];
  assert.deepEqual(seqA, seqB);
});

test('不同种子会产生不同的 ID（避免碰撞）', () => {
  const a = createIdFactory({ clock: () => 1000, seed: 1 });
  const b = createIdFactory({ clock: () => 1000, seed: 2 });
  assert.notEqual(a.next('task'), b.next('task'));
});

test('未知类型会抛错，而不是生成错误前缀的 ID', () => {
  const factory = createIdFactory();
  assert.throws(() => factory.next('unknownKind'), RangeError);
});

test('idKindOf 能识别各类前缀', () => {
  assert.equal(idKindOf(`${ID_PREFIXES.task}_x_0001`), 'task');
  assert.equal(idKindOf(`${ID_PREFIXES.session}_x_0001`), 'session');
  assert.equal(idKindOf(`${ID_PREFIXES.fixedActivity}_x_0001`), 'fixedActivity');
  assert.equal(idKindOf('nope_1'), null);
  assert.equal(idKindOf(123), null);
});

test('种子随机数发生器取值范围与确定性', () => {
  const random = createSeededRandom(123);
  const values = [random(), random(), random()];
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, `随机值应在 [0,1)：${value}`);
  }
  const again = createSeededRandom(123);
  assert.deepEqual([again(), again(), again()], values);
});
