/**
 * 科目（subject）：统一的、可管理的字典。
 *
 * 为什么需要它：
 * 科目以前是每个任务各自保存的**自由文本**。用户打错一个字、多一个空格，
 * 就会永久多出一个"新科目"，科目选择栏越来越乱，而且没有任何办法清理。
 *
 * 现在科目是一份独立的字典（`state.subjects`），任务仍然保存 `subject` 字符串
 * （保持与旧数据的兼容，也让统计、排程这些纯函数不需要额外查表），
 * 但**新增/重命名/删除都必须经过这份字典**：
 *   - 新增：`subject.ensure` 保证不会因为空格/大小写差异产生重复项；
 *   - 重命名：同一次提交里把所有引用该科目的任务一起改名；
 *   - 删除：仍被任务引用时**拒绝**，除非显式给出一个替换科目。
 *
 * 这样既不会因为是自由文本而失控，也不会因为改成"科目 ID 引用"而破坏旧数据。
 */

import { TASK_NAME_MAX_LENGTH, VALIDATION_CODES as C, error, isNonEmptyString, isPlainObject, result } from './validation.js';

/** 科目名的统一长度上限（与任务名一致，避免出现"超长科目把选择栏撑坏"） */
export const SUBJECT_NAME_MAX_LENGTH = TASK_NAME_MAX_LENGTH;

/**
 * 科目名的归一化：去掉首尾空白、把连续空白压成一个空格。
 * 只做这一层归一化——**不做大小写折叠**，因为"OS"与"os"可能是用户有意区分的两个科目。
 */
export function normalizeSubjectName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : name;
}

/** 两个科目名是否视为同一个（归一化后完全相同） */
export function isSameSubjectName(a, b) {
  return normalizeSubjectName(a) === normalizeSubjectName(b);
}

/** 校验一个科目名 */
export function validateSubjectName(name, path = 'subject') {
  const issues = [];
  const normalized = normalizeSubjectName(name);
  if (!isNonEmptyString(normalized, SUBJECT_NAME_MAX_LENGTH + 1)) {
    issues.push(error(C.REQUIRED, path, '请填写科目名称。'));
    return result(issues);
  }
  if ([...normalized].length > SUBJECT_NAME_MAX_LENGTH) {
    issues.push(
      error(C.STRING_TOO_LONG, path, `科目名称最多 ${SUBJECT_NAME_MAX_LENGTH} 个字符。`, {
        max: SUBJECT_NAME_MAX_LENGTH,
        actual: [...normalized].length,
      }),
    );
  }
  return result(issues);
}

/** 创建一个科目实体（不做业务校验） */
export function createSubject(name, { idFactory, nowIso }) {
  return {
    id: idFactory.next('subject'),
    name: normalizeSubjectName(name),
    createdAt: nowIso,
  };
}

export function validateSubject(subject, path = 'subject') {
  const issues = [];
  if (!isPlainObject(subject)) {
    issues.push(error(C.TYPE, path, '科目必须是一个对象。', { actual: typeof subject }));
    return result(issues);
  }
  if (!isNonEmptyString(subject.id, 64)) issues.push(error(C.REQUIRED, `${path}.id`, '科目缺少 ID。'));
  const nameResult = validateSubjectName(subject.name, `${path}.name`);
  issues.push(...nameResult.issues);
  return result(issues);
}

/**
 * 从任务里推导出"历史科目"（用于把老数据平滑接入字典）。
 *
 * 只新增、不修改任何任务，因此对旧数据是完全安全的。
 */
export function deriveSubjectsFromTasks(tasks, { idFactory, nowIso }) {
  const seen = new Set();
  const subjects = [];
  for (const task of tasks ?? []) {
    const name = normalizeSubjectName(task?.subject);
    if (!name || seen.has(name)) continue;
    // 超长/非法的历史科目不做处理，留给用户在科目管理里修正
    if ([...name].length > SUBJECT_NAME_MAX_LENGTH) continue;
    seen.add(name);
    subjects.push({ id: idFactory.next('subject'), name, createdAt: nowIso });
  }
  return subjects;
}

/** 统计每个科目被多少个任务引用 */
export function countSubjectUsage(tasks, name) {
  const target = normalizeSubjectName(name);
  return (tasks ?? []).filter((task) => normalizeSubjectName(task?.subject) === target).length;
}
