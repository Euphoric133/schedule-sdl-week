/**
 * 统一的校验结果与校验工具。
 *
 * 设计原因：
 * - 项目要求明确区分「数据输入不合法（invalid_input）」与「时间不足（infeasible）」。
 *   本模块只负责前者：把问题结构化（severity + code + path + message），
 *   由调用方（services / engine）决定是阻断操作还是可继续但降级。
 * - 不使用异常做常规控制流：校验失败是**数据**而不是异常；只有编程错误（类型用错）才抛异常。
 * - code 使用稳定枚举（V0xx 输入 / H0xx 硬约束），便于测试断言与文档映射。
 */

/**
 * 所有"任务名称"类字段的统一长度上限。
 *
 * 为什么集中在这里：任务名、固定任务名、休息时间名都是"名称"，
 * 界面的 maxlength、输入提示与保存前的业务校验必须用同一个数字，
 * 否则会出现"界面显示能输 10 个字、保存却报错"或反过来的情况。
 */
export const TASK_NAME_MAX_LENGTH = 10;

/**
 * 校验一个"名称"类字段（按 Unicode 码点计数，中文与 emoji 都算 1 个字符）。
 *
 * 注意：这里只校验"是否合法"，不负责截断。
 * 已有数据里可能存在超长名称（历史版本没有限制），
 * 因此加载时只提示、不修改、不截断——由用户自己决定怎么改。
 *
 * @returns {{ok: boolean, length: number, issue?: object}}
 */
export function checkName(value, path, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    return { ok: false, length: 0, issue: error(VALIDATION_CODES.REQUIRED, path, `请填写${label}。`) };
  }
  const length = [...text].length;
  if (length > TASK_NAME_MAX_LENGTH) {
    return {
      ok: false,
      length,
      issue: error(
        VALIDATION_CODES.STRING_TOO_LONG,
        path,
        `${label}最多 ${TASK_NAME_MAX_LENGTH} 个字符（当前 ${length} 个），请精简一下。`,
        { max: TASK_NAME_MAX_LENGTH, actual: length },
      ),
    };
  }
  return { ok: true, length };
}

/** 校验问题码。新增码必须同时更新 PROJECT_SPEC.md 的映射表。 */
export const VALIDATION_CODES = Object.freeze({
  // —— 通用结构 ——
  REQUIRED: 'V001',
  TYPE: 'V002',
  RANGE: 'V003',
  ENUM: 'V004',
  /** 名称超出统一长度上限（任务 / 固定任务 / 休息时间共用） */
  STRING_TOO_LONG: 'V005',
  // —— 任务 ——
  TASK_MIN_MAX_CHUNK: 'V010',
  TASK_ATOMIC_MISMATCH: 'V011',
  TASK_DEPENDENCY_SELF: 'V012',
  TASK_DEPENDENCY_MISSING: 'V013',
  TASK_DEPENDENCY_CYCLE: 'V014',
  TASK_OVER_COMPLETED: 'V015',
  TASK_DURATION_INCONSISTENT: 'V016',
  // —— 时段 ——
  SESSION_EMPTY_SPAN: 'V020',
  SESSION_TASK_MISSING: 'V021',
  SESSION_LENGTH_INVALID: 'V022',
  // —— 设置 ——
  SETTINGS_NO_WINDOW: 'V030',
  SETTINGS_BUFFER_RATIO: 'V031',
  SETTINGS_WEIGHTS: 'V032',
  // —— 固定活动 ——
  FIXED_ACTIVITY_RECURRENCE: 'V040',
  FIXED_ACTIVITY_MOVABLE: 'V041',
  // —— 跨实体一致性 ——
  ENTITY_DUPLICATE_ID: 'V050',
  ENTITY_OVERLAP: 'V051',
  ENTITY_DANGLING_REF: 'V052',
  // —— 导入 / 迁移 ——
  SCHEMA_VERSION_UNSUPPORTED: 'V060',
  SCHEMA_SHAPE: 'V061',
  MIGRATION_FAILED: 'V062',
});

/** 问题严重级别 */
export const SEVERITY = Object.freeze({
  ERROR: 'error', // 阻断：不允许继续，操作会被拒绝
  WARNING: 'warning', // 不阻断：允许继续，但必须展示给用户
});

/**
 * @typedef {object} ValidationIssue
 * @property {'error'|'warning'} severity
 * @property {string} code   稳定问题码（如 'V010'）
 * @property {string} path   数据路径（如 'tasks[2].maxChunkMinutes'），便于就地显示错误
 * @property {string} message 面向用户的中文说明（可读、不指责、含修复方向）
 * @property {object} [details] 额外结构化信息（测试断言用）
 */

/** @returns {ValidationIssue} */
export function makeIssue(severity, code, path, message, details) {
  const issue = { severity, code, path, message };
  if (details !== undefined) issue.details = details;
  return issue;
}

export const error = (code, path, message, details) => makeIssue(SEVERITY.ERROR, code, path, message, details);
export const warning = (code, path, message, details) => makeIssue(SEVERITY.WARNING, code, path, message, details);

/** 构造一个校验结果 */
export function result(issues = []) {
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  const errors = list.filter((i) => i.severity === SEVERITY.ERROR);
  const warnings = list.filter((i) => i.severity === SEVERITY.WARNING);
  return { ok: errors.length === 0, errors, warnings, issues: list };
}

export const pass = () => result([]);

/** 合并多个校验结果（保持出现顺序，便于稳定输出） */
export function mergeResults(...results) {
  return result(results.flatMap((r) => (r && Array.isArray(r.issues) ? r.issues : [])));
}

/**
 * 面向用户的单行文案。
 *
 * 只返回中文消息：错误码（V001）与字段路径（deadlineDate）是给程序与日志看的，
 * 直接显示在界面上只会让用户困惑。需要代码信息的场景请用 `formatIssueDebug`。
 */
export function formatIssue(issue) {
  if (!issue) return '出现了未知问题。';
  return issue.message ?? String(issue);
}

/** 带内部代码与字段路径的完整文案（日志、诊断、测试断言使用，不面向用户） */
export function formatIssueDebug(issue) {
  const where = issue?.path ? `（${issue.path}）` : '';
  return `[${issue?.code}]${where} ${issue?.message}`;
}

/** 汇总为多行可读文本（用于导入失败提示与诊断面板） */
export function formatIssues(issues, limit = 8) {
  const list = Array.isArray(issues) ? issues : [];
  const shown = list.slice(0, limit).map((i, idx) => `${idx + 1}. ${formatIssue(i)}`);
  if (list.length > limit) shown.push(`… 另有 ${list.length - limit} 条问题`);
  return shown.join('\n');
}

/* ------------------------------------------------------------------ *
 * 基础类型断言（返回 ValidationIssue | null）
 * ------------------------------------------------------------------ */

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

export function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function checkRequiredString(value, path, label, { maxLength = 200, countCodePoints = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return error(VALIDATION_CODES.REQUIRED, path, `${label}不能为空。`);
  }
  if (typeof value !== 'string') {
    return error(VALIDATION_CODES.TYPE, path, `${label}必须是文本。`, { actual: typeof value });
  }
  if (value.trim().length === 0) {
    return error(VALIDATION_CODES.REQUIRED, path, `${label}不能只有空格。`);
  }
  // 名称类字段按 Unicode 码点计数：中文、emoji 都算 1 个字符，
  // 与界面上的 maxlength 提示保持一致（否则输入框能输 10 个、校验却按 20 个算）。
  const length = countCodePoints ? [...value.trim()].length : value.length;
  if (length > maxLength) {
    return error(VALIDATION_CODES.STRING_TOO_LONG, path, `${label}不能超过 ${maxLength} 个字符（当前 ${length} 个）。`, {
      actual: length,
      max: maxLength,
    });
  }
  return null;
}

export function checkPositiveInt(value, path, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    return error(VALIDATION_CODES.REQUIRED, path, `${label}不能为空。`);
  }
  if (!Number.isInteger(value)) {
    return error(VALIDATION_CODES.TYPE, path, `${label}必须是整数分钟数。`, { actual: value });
  }
  if (value < min || value > max) {
    return error(VALIDATION_CODES.RANGE, path, `${label}必须在 ${min} – ${max} 之间（当前 ${value}）。`, {
      actual: value,
      min,
      max,
    });
  }
  return null;
}

export function checkNonNegativeInt(value, path, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    return error(VALIDATION_CODES.REQUIRED, path, `${label}不能为空。`);
  }
  if (!Number.isInteger(value)) {
    return error(VALIDATION_CODES.TYPE, path, `${label}必须是整数分钟数。`, { actual: value });
  }
  if (value < min || value > max) {
    return error(VALIDATION_CODES.RANGE, path, `${label}必须在 ${min} – ${max} 之间（当前 ${value}）。`, {
      actual: value,
      min,
      max,
    });
  }
  return null;
}

export function checkEnum(value, allowed, path, label) {
  if (!allowed.includes(value)) {
    return error(VALIDATION_CODES.ENUM, path, `${label}只能是以下之一：${allowed.join(' / ')}（当前 ${JSON.stringify(value)}）。`, {
      actual: value,
      allowed,
    });
  }
  return null;
}

/** 允许 undefined/null 的枚举校验：用于可选字段 */
export function checkOptionalEnum(value, allowed, path, label) {
  if (value === undefined || value === null) return null;
  return checkEnum(value, allowed, path, label);
}
