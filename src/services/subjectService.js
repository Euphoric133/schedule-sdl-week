/**
 * 科目服务：科目字典的读取与引用统计。
 *
 * 所有写操作仍然走 mutations 里的 `subject.*` 变更（与任务写入同一条事务路径），
 * 本层只负责"读"和"给界面用的整理结果"，不直接改状态。
 */

import { countSubjectUsage, normalizeSubjectName } from '../domain/subject.js';

export function createSubjectService({ app }) {
  if (!app || typeof app.commit !== 'function') throw new TypeError('createSubjectService 需要 app 状态容器');

  /** 字典里的科目，按名称排序（界面稳定） */
  function list() {
    return [...(app.getState()?.subjects ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /** 带引用数量的科目列表 */
  function listWithUsage() {
    const tasks = app.getState()?.tasks ?? [];
    return list().map((subject) => ({
      ...subject,
      usageCount: countSubjectUsage(tasks, subject.name),
    }));
  }

  /**
   * 历史任务里用到、但字典中不存在的科目名。
   *
   * 这类"孤儿科目"必须能显示出来（否则用户会看到选择栏里没有、任务上却有），
   * 并且可以一键加入字典完成收编。
   */
  function listOrphans() {
    const tasks = app.getState()?.tasks ?? [];
    const known = new Set(list().map((subject) => normalizeSubjectName(subject.name)));
    const orphans = new Map();
    for (const task of tasks) {
      const name = normalizeSubjectName(task.subject);
      if (!name || known.has(name)) continue;
      orphans.set(name, (orphans.get(name) ?? 0) + 1);
    }
    return [...orphans.entries()]
      .map(([name, usageCount]) => ({ name, usageCount }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /** 供任务表单使用的选项：字典项 + 孤儿科目（标记来源，避免用户困惑） */
  function optionsForForm() {
    return [
      ...list().map((subject) => ({ name: subject.name, orphan: false, usageCount: countSubjectUsage(app.getState()?.tasks ?? [], subject.name) })),
      ...listOrphans().map((item) => ({ name: item.name, orphan: true, usageCount: item.usageCount })),
    ];
  }

  /** 某科目被多少任务引用 */
  function usageOf(name) {
    return countSubjectUsage(app.getState()?.tasks ?? [], name);
  }

  return { list, listWithUsage, listOrphans, optionsForForm, usageOf };
}
