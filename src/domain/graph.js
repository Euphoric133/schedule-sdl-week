import { VALIDATION_CODES as C, error } from './validation.js';

/**
 * 有向图工具：用于任务依赖（前置任务）关系。
 *
 * 放在独立模块的原因：
 * - 依赖检查同时被"任务校验（V013/V014）"和"排程引擎的依赖门控（H7）"使用，
 *   集中一处可避免两处实现不一致。
 * - 这里只做纯图运算，不涉及 DOM / 存储 / 引擎。
 */

/**
 * 检测有向图中的环。
 * @param {string[]} nodes 全部节点 ID
 * @param {Map<string, string[]>} edges 邻接表：node → 它依赖的节点（即边的指向目标）
 * @returns {{hasCycle: boolean, cycle: string[]|null}} cycle 为一组构成环的节点（首尾相邻）
 */
export function detectCycle(nodes, edges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(nodes.map((n) => [n, WHITE]));
  const stack = [];
  let found = null;

  function visit(node) {
    if (found) return;
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!color.has(next)) continue; // 指向图外的节点由 V013 负责报错
      if (color.get(next) === GRAY) {
        const startIdx = stack.indexOf(next);
        found = stack.slice(startIdx).concat(next);
        return;
      }
      if (color.get(next) === WHITE) {
        visit(next);
        if (found) return;
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node) === WHITE) visit(node);
    if (found) break;
  }
  return { hasCycle: Boolean(found), cycle: found };
}

/**
 * 拓扑序（Kahn 算法）。边方向为「依赖 → 被依赖者」，即先安排前置任务。
 * 为了结果确定性，同层节点按提供的 tieBreak 排序键（默认 id 字典序）排序。
 *
 * @param {Array<{id: string, dependsOn?: string[]}>} tasks
 * @returns {{order: string[], cyclic: string[]}} cyclic 为无法排序（处于环中）的节点
 */
export function topologicalOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map(tasks.map((t) => [t.id, 0]));
  const dependents = new Map(tasks.map((t) => [t.id, []]));

  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // 悬空引用由校验器报错，这里忽略以免崩溃
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.get(dep).push(task.id);
    }
  }

  const ready = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  ready.sort();
  const order = [];
  while (ready.length > 0) {
    const current = ready.shift();
    order.push(current);
    for (const next of (dependents.get(current) ?? []).slice().sort()) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  const cyclic = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
  return { order, cyclic };
}

/** 由任务列表构建邻接表（node → 它依赖的节点） */
export function buildEdgeMap(tasks) {
  return new Map(tasks.map((t) => [t.id, (t.dependsOn ?? []).filter((d) => typeof d === 'string')]));
}

/**
 * 校验任务依赖关系：悬空引用 + 自引用 + 环。
 * @returns {object[]} 校验问题列表（结构见 validation.js 的 ValidationIssue）
 */
export function checkTaskDependencies(tasks) {
  const issues = [];
  const ids = new Set(tasks.map((t) => t.id));

  for (const [idx, task] of tasks.entries()) {
    for (const [depIdx, dep] of (task.dependsOn ?? []).entries()) {
      if (dep === task.id) {
        issues.push(error(C.TASK_DEPENDENCY_SELF, `tasks[${idx}].dependsOn[${depIdx}]`, `"${task.title}" 不能依赖自己。`, { taskId: task.id }));
      } else if (!ids.has(dep)) {
        issues.push(
          error(
            C.TASK_DEPENDENCY_MISSING,
            `tasks[${idx}].dependsOn[${depIdx}]`,
            `"${task.title}" 依赖的前置任务不存在（${dep}）。请重新选择前置任务。`,
            { taskId: task.id, missing: dep },
          ),
        );
      }
    }
  }

  const { hasCycle, cycle } = detectCycle([...ids], buildEdgeMap(tasks));
  if (hasCycle) {
    const names = (cycle ?? []).map((id) => tasks.find((t) => t.id === id)?.title ?? id);
    issues.push(
      error(C.TASK_DEPENDENCY_CYCLE, 'tasks[].dependsOn', `前置任务之间存在循环依赖：${names.join(' → ')}。请移除其中一条依赖。`, {
        cycle,
      }),
    );
  }
  return issues;
}
