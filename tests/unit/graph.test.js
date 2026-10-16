/**
 * 依赖图测试（对应硬约束 H7/H9 的前置部分）。
 *
 * 依赖关系同时被三处使用：任务校验、排程引擎的依赖门控、界面上的前置任务选择器。
 * 因此必须只有一个实现，并且要做负向测试（能识别环、能识别悬空引用）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEdgeMap, checkTaskDependencies, detectCycle, topologicalOrder } from '../../src/domain/graph.js';
import { VALIDATION_CODES } from '../../src/domain/validation.js';

test('detectCycle：无环图返回 false', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const edges = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', []],
    ['d', ['a']],
  ]);
  const { hasCycle, cycle } = detectCycle(nodes, edges);
  assert.equal(hasCycle, false);
  assert.equal(cycle, null);
});

test('detectCycle：自环与多节点环都能识别，并给出构成环的节点序列', () => {
  const selfLoop = detectCycle(['a'], new Map([['a', ['a']]]));
  assert.equal(selfLoop.hasCycle, true);
  assert.deepEqual(selfLoop.cycle, ['a', 'a']);

  const triangle = detectCycle(
    ['a', 'b', 'c'],
    new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]),
  );
  assert.equal(triangle.hasCycle, true);
  assert.equal(triangle.cycle[0], triangle.cycle[triangle.cycle.length - 1], '环的首尾节点相同');
  assert.equal(triangle.cycle.length, 4);
});

test('detectCycle：忽略指向图外节点的边（悬空引用由 checkTaskDependencies 单独报错）', () => {
  const { hasCycle } = detectCycle(['a'], new Map([['a', ['missing']]]));
  assert.equal(hasCycle, false);
});

test('topologicalOrder：前置任务排在依赖它的任务之前，且结果确定', () => {
  const tasks = [
    { id: 'c', dependsOn: ['b'] },
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
  ];
  const { order, cyclic } = topologicalOrder(tasks);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(cyclic, []);

  // 同层节点的顺序必须稳定（按 id 字典序），否则"相同输入相同输出"会被破坏
  const siblings = [
    { id: 'z', dependsOn: [] },
    { id: 'y', dependsOn: [] },
    { id: 'x', dependsOn: [] },
  ];
  assert.deepEqual(topologicalOrder(siblings).order, ['x', 'y', 'z']);
  assert.deepEqual(topologicalOrder([...siblings].reverse()).order, ['x', 'y', 'z']);
});

test('topologicalOrder：处于环中的任务会被单独列出，而不是静默丢弃', () => {
  const tasks = [
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: [] },
  ];
  const { order, cyclic } = topologicalOrder(tasks);
  assert.deepEqual(order, ['c']);
  assert.deepEqual(cyclic.sort(), ['a', 'b']);
});

test('topologicalOrder：忽略指向不存在任务的依赖，不崩溃', () => {
  const tasks = [{ id: 'a', dependsOn: ['ghost'] }];
  const { order, cyclic } = topologicalOrder(tasks);
  assert.deepEqual(order, ['a']);
  assert.deepEqual(cyclic, []);
});

test('checkTaskDependencies：悬空引用、自引用、环分别报出正确的错误码', () => {
  const dangling = checkTaskDependencies([{ id: 'a', title: '任务 A', dependsOn: ['ghost'] }]);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].code, VALIDATION_CODES.TASK_DEPENDENCY_MISSING);
  assert.equal(dangling[0].details.missing, 'ghost');

  const selfRef = checkTaskDependencies([{ id: 'a', title: '任务 A', dependsOn: ['a'] }]);
  assert.equal(selfRef[0].code, VALIDATION_CODES.TASK_DEPENDENCY_SELF);

  const cycle = checkTaskDependencies([
    { id: 'a', title: '任务 A', dependsOn: ['b'] },
    { id: 'b', title: '任务 B', dependsOn: ['a'] },
  ]);
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].code, VALIDATION_CODES.TASK_DEPENDENCY_CYCLE);
  assert.match(cycle[0].message, /任务 A → 任务 B → 任务 A/);
});

test('checkTaskDependencies：合法依赖图不产生任何问题', () => {
  assert.deepEqual(
    checkTaskDependencies([
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
      { id: 'c', title: 'C', dependsOn: ['a', 'b'] },
    ]),
    [],
  );
});

test('buildEdgeMap 过滤非字符串依赖项（防止脏数据导致图运算崩溃）', () => {
  const edges = buildEdgeMap([{ id: 'a', dependsOn: ['b', null, 42, undefined] }]);
  assert.deepEqual(edges.get('a'), ['b']);
});
