/**
 * 校验工具测试。
 *
 * 重点：校验结果必须结构化（severity / code / path / message），
 * 因为界面要按字段就近显示错误，测试也要能断言"具体是哪一条规则被触发"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITY,
  VALIDATION_CODES,
  checkEnum,
  checkNonNegativeInt,
  checkOptionalEnum,
  checkPositiveInt,
  checkRequiredString,
  error,
  checkName,
  formatIssue,
  formatIssueDebug,
  formatIssues,
  isNonEmptyString,
  isPlainObject,
  isPositiveInt,
  mergeResults,
  pass,
  result,
  warning,
} from '../../src/domain/validation.js';

test('isPlainObject / isNonEmptyString / isPositiveInt 边界', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);

  assert.equal(isNonEmptyString('abc'), true);
  assert.equal(isNonEmptyString('   '), false);
  assert.equal(isNonEmptyString(''), false);
  assert.equal(isNonEmptyString('a'.repeat(201)), false);

  assert.equal(isPositiveInt(1), true);
  assert.equal(isPositiveInt(0), false);
  assert.equal(isPositiveInt(1.5), false);
  assert.equal(isPositiveInt(-3), false);
});

test('result() 区分 error 与 warning，ok 只由 error 决定', () => {
  const onlyWarnings = result([warning('V000', 'a', '提示')]);
  assert.equal(onlyWarnings.ok, true);
  assert.equal(onlyWarnings.warnings.length, 1);
  assert.equal(onlyWarnings.errors.length, 0);

  const withError = result([warning('V000', 'a', '提示'), error('V001', 'b', '错误')]);
  assert.equal(withError.ok, false);
  assert.equal(withError.errors.length, 1);
  assert.equal(withError.issues.length, 2);

  assert.equal(pass().ok, true);
  assert.equal(result(null).ok, true, '空输入视为通过');
});

test('mergeResults 合并多个结果并保持顺序', () => {
  const merged = mergeResults(
    result([error('V001', 'a', '一')]),
    result([error('V002', 'b', '二'), warning('V003', 'c', '三')]),
    null,
    {},
  );
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.issues.map((i) => i.code), ['V001', 'V002', 'V003']);
});

test('checkRequiredString 的各类失败分支', () => {
  assert.equal(checkRequiredString('名称', 'p', '任务名称'), null);
  assert.equal(checkRequiredString(undefined, 'p', '任务名称').code, VALIDATION_CODES.REQUIRED);
  assert.equal(checkRequiredString('', 'p', '任务名称').code, VALIDATION_CODES.REQUIRED);
  assert.equal(checkRequiredString('   ', 'p', '任务名称').code, VALIDATION_CODES.REQUIRED);
  assert.equal(checkRequiredString(123, 'p', '任务名称').code, VALIDATION_CODES.TYPE);
  const tooLong = checkRequiredString('a'.repeat(11), 'p', '任务名称', { maxLength: 10 });
  // 名称类字段使用统一的"过长"错误码，便于界面统一提示
  assert.equal(tooLong.code, VALIDATION_CODES.STRING_TOO_LONG);
  assert.equal(tooLong.details.actual, 11);
});

test('checkRequiredString：名称按 Unicode 码点计数（中文与 emoji 各算 1 个）', () => {
  // 10 个中文刚好通过
  assert.equal(checkRequiredString('一二三四五六七八九十', 'p', '任务名称', { maxLength: 10, countCodePoints: true }), null);
  // 11 个中文超限
  assert.equal(
    checkRequiredString('一二三四五六七八九十一', 'p', '任务名称', { maxLength: 10, countCodePoints: true }).code,
    VALIDATION_CODES.STRING_TOO_LONG,
  );
  // emoji 与中文混排也按"字符个数"算
  assert.equal(checkRequiredString('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉', 'p', '名称', { maxLength: 10, countCodePoints: true }), null);
  assert.equal(
    checkRequiredString('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉', 'p', '名称', { maxLength: 10, countCodePoints: true }).code,
    VALIDATION_CODES.STRING_TOO_LONG,
  );
  // 英文名称同样按字符数
  assert.equal(checkRequiredString('abcdefghij', 'p', 'name', { maxLength: 10, countCodePoints: true }), null);
});

test('checkName：空名称与超长名称给出可读提示', () => {
  assert.equal(checkName('复习', 'p', '任务名称').ok, true);
  assert.match(checkName('', 'p', '任务名称').issue.message, /请填写/);
  const long = checkName('一二三四五六七八九十一', 'p', '任务名称');
  assert.equal(long.ok, false);
  assert.equal(long.length, 11);
  assert.match(long.issue.message, /最多 10 个字符/);
});

test('checkPositiveInt / checkNonNegativeInt 的范围与类型分支', () => {
  assert.equal(checkPositiveInt(30, 'p', '时长'), null);
  assert.equal(checkPositiveInt(0, 'p', '时长').code, VALIDATION_CODES.RANGE);
  assert.equal(checkPositiveInt(1.5, 'p', '时长').code, VALIDATION_CODES.TYPE);
  assert.equal(checkPositiveInt(null, 'p', '时长').code, VALIDATION_CODES.REQUIRED);
  const outOfRange = checkPositiveInt(700, 'p', '时长', { min: 5, max: 600 });
  assert.equal(outOfRange.code, VALIDATION_CODES.RANGE);
  assert.deepEqual(outOfRange.details, { actual: 700, min: 5, max: 600 });

  assert.equal(checkNonNegativeInt(0, 'p', '实际时长'), null);
  assert.equal(checkNonNegativeInt(-1, 'p', '实际时长').code, VALIDATION_CODES.RANGE);
});

test('checkEnum / checkOptionalEnum', () => {
  assert.equal(checkEnum('a', ['a', 'b'], 'p', '状态'), null);
  const bad = checkEnum('c', ['a', 'b'], 'p', '状态');
  assert.equal(bad.code, VALIDATION_CODES.ENUM);
  assert.deepEqual(bad.details.allowed, ['a', 'b']);

  assert.equal(checkOptionalEnum(undefined, ['a'], 'p', '字段'), null);
  assert.equal(checkOptionalEnum(null, ['a'], 'p', '字段'), null);
  assert.equal(checkOptionalEnum('z', ['a'], 'p', '字段').code, VALIDATION_CODES.ENUM);
});

test('面向用户的问题文案只给中文消息，不带内部错误码与字段名', () => {
  // 之前的实现会显示成 "[V010]（tasks[0].maxChunkMinutes） 最长时段不合法。"，
  // 把内部代码与字段路径暴露给用户。现在界面上只显示中文消息。
  const issue = error('V010', 'tasks[0].maxChunkMinutes', '最长时段不合法。');
  assert.equal(formatIssue(issue), '最长时段不合法。');
  assert.equal(formatIssue(warning('V000', '', '仅提示')), '仅提示');
  assert.equal(formatIssue(null), '出现了未知问题。');

  // 需要内部信息时（日志、诊断、测试）用 formatIssueDebug
  assert.equal(formatIssueDebug(issue), '[V010]（tasks[0].maxChunkMinutes） 最长时段不合法。');
  assert.equal(formatIssueDebug(warning('V000', '', '仅提示')), '[V000] 仅提示');
});

test('formatIssues 限制条数并给出剩余数量', () => {
  const issues = Array.from({ length: 12 }, (_, i) => error(`V${String(i).padStart(3, '0')}`, `p${i}`, `问题 ${i}`));
  const text = formatIssues(issues, 5);
  const lines = text.split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[5], /另有 7 条问题/);
  assert.equal(formatIssues([]), '');
});
