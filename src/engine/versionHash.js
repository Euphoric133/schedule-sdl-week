/**
 * 确定性哈希与派生 ID。
 *
 * 为什么需要它：
 * - 引擎必须是**纯函数**：同样的输入 + 同样的引擎版本，必须产出逐字段相同的计划。
 *   如果候选时段的 ID 用时间戳或随机数生成，两次运行的结果就不同，"确定性"无法验证，
 *   差异预览也会每次都把同一个时段报成"新增 + 取消"。
 * - 预览过期检测需要输入指纹：任务、时段、固定活动、设置、窗口或"现在"任何一个变了，
 *   指纹就要变，从而拒绝用旧预览覆盖新数据。
 *
 * 实现选择：FNV-1a 32 位哈希。它不用于安全用途，只需要稳定、快速、跨运行一致，
 * 因此不引入任何加密库（保持零依赖）。
 */

/** 32 位 FNV-1a 哈希（返回 8 位十六进制字符串） */
export function hash32(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 乘以 FNV 质数 16777619，用移位与加法避免 32 位溢出精度问题
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 稳定序列化：对 JSON 对象的键做递归排序后再序列化。
 *
 * 直接 `JSON.stringify` 的结果依赖键的插入顺序，而"同一份数据"在不同代码路径下可能顺序不同
 * （例如经过一次 round-trip 或从存储读回）。排序后可以保证同一逻辑内容得到同一指纹。
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue; // undefined 不参与序列化，与 JSON.stringify 保持一致
      out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

/** 组合多个片段为一个指纹（片段之间用不可见分隔符，避免拼接歧义） */
export function hashParts(...parts) {
  return hash32(parts.map((part) => (typeof part === 'string' ? part : stableStringify(part))).join('\u0000'));
}

/**
 * 计算排程输入的指纹。
 *
 * **任何会改变排程结果的内容都必须包含在内**，否则预览过期检测会出现漏网之鱼。
 * 因此这里显式挑选字段（而不是整体序列化），避免把 UI 临时状态、时间戳等无关内容算进去
 * ——那会让预览在用户什么都没改的情况下被判为过期。
 *
 * 有意排除的字段：`updatedAt` / `createdAt` / `actualMinutes` 之外的审计字段。
 * 有意包含的字段：剩余工作量的全部决定因素（plannedMinutes、status、已完成分钟数）。
 */
export function computeInputHash({
  engineVersion,
  policyHash,
  nowDate,
  windowStart,
  windowEnd,
  settings,
  tasks,
  sessions,
  fixedActivities,
  completedMinutesByTask = {},
}) {
  const taskPart = tasks.map((task) => ({
    id: task.id,
    status: task.status,
    plannedMinutes: task.plannedMinutes,
    deadlineDate: task.deadlineDate,
    deadlineTime: task.deadlineTime,
    importance: task.importance,
    difficulty: task.difficulty,
    procrastination: task.procrastination,
    splittable: task.splittable,
    minChunkMinutes: task.minChunkMinutes,
    maxChunkMinutes: task.maxChunkMinutes,
    dependsOn: [...(task.dependsOn ?? [])].sort(),
    completedMinutes: completedMinutesByTask[task.id] ?? 0,
  }));

  // 注意：这里**故意不包含 session.id**。
  // 被保留的时段（锁定/已完成）会进入候选计划并参与容量计算，而新派生的时段 ID 又是从
  // inputHash 推导出来的。如果指纹把 session.id 也算进去，就会形成循环依赖：
  // 新的锁定时段 → 指纹变化 → 所有派生 ID 变化 → 计划整体"看起来变了"。
  // 指纹只需要反映"哪些时间被占用了"，因此用位置与状态来标识即可。
  const sessionPart = sessions.map((session) => ({
    taskId: session.taskId,
    date: session.date,
    startMinutes: session.startMinutes,
    endMinutes: session.endMinutes,
    state: session.state,
    locked: Boolean(session.locked),
  }));

  const fixedPart = fixedActivities.map((activity) => ({
    id: activity.id,
    type: activity.type,
    recurrence: activity.recurrence,
    startMinutes: activity.startMinutes,
    endMinutes: activity.endMinutes,
    activeFrom: activity.activeFrom ?? null,
    activeTo: activity.activeTo ?? null,
  }));

  const settingsPart = {
    studyWindows: settings.studyWindows,
    preferredFocusWindows: settings.preferredFocusWindows,
    adaptiveContinuousLimit: settings.adaptiveContinuousLimit,
    baseContinuousMinutes: settings.baseContinuousMinutes,
    subjectSwitchPenaltyMinutes: settings.subjectSwitchPenaltyMinutes,
    defaultMinChunkMinutes: settings.defaultMinChunkMinutes,
    defaultMaxChunkMinutes: settings.defaultMaxChunkMinutes,
    restRule: settings.restRule,
    bufferRatio: settings.bufferRatio,
    dayBoundaryHour: settings.dayBoundaryHour,
    weights: settings.weights,
    maxSessionsPerDay: settings.maxSessionsPerDay,
    dailyStudyCapMinutes: settings.dailyStudyCapMinutes ?? null,
  };

  // 任务与时段排序：让指纹只取决于内容，不取决于数组顺序
  taskPart.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sessionPart.sort((a, b) => {
    const keyA = `${a.date}|${String(a.startMinutes).padStart(5, '0')}|${a.taskId}|${a.state}|${a.locked}`;
    const keyB = `${b.date}|${String(b.startMinutes).padStart(5, '0')}|${b.taskId}|${b.state}|${b.locked}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  fixedPart.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return hashParts(
    engineVersion,
    policyHash,
    nowDate,
    windowStart,
    windowEnd,
    taskPart,
    sessionPart,
    fixedPart,
    settingsPart,
  );
}

/** 策略指纹：设置变化会改变排程结果，因此单独算一个指纹放进计划里，便于排查"为什么结果变了" */
export function computePolicyHash(settings, engineVersion) {
  return hashParts('policy', engineVersion, {
    preferredFocusWindows: settings.preferredFocusWindows,
    adaptiveContinuousLimit: settings.adaptiveContinuousLimit,
    baseContinuousMinutes: settings.baseContinuousMinutes,
    subjectSwitchPenaltyMinutes: settings.subjectSwitchPenaltyMinutes,
    defaultMinChunkMinutes: settings.defaultMinChunkMinutes,
    defaultMaxChunkMinutes: settings.defaultMaxChunkMinutes,
    restRule: settings.restRule,
    bufferRatio: settings.bufferRatio,
    weights: settings.weights,
    maxSessionsPerDay: settings.maxSessionsPerDay,
    dailyStudyCapMinutes: settings.dailyStudyCapMinutes ?? null,
    studyWindows: settings.studyWindows,
  });
}

/** 引擎内部派生 ID 的前缀（与用户创建的实体 ID 区分开，便于识别来源） */
export const DERIVED_ID_PREFIX = Object.freeze({
  study: 'ses',
  rest: 'rst',
  buffer: 'buf',
  diagnostic: 'dg',
});

/**
 * 派生一个确定性的时段 ID。
 *
 * 形式：`ses_<8 位哈希>`，哈希由输入指纹 + 任务 + 片段序号决定。
 * 结果不随运行时间变化，因此同一输入连续运行会得到完全相同的计划（验收场景 17）。
 */
export function deriveSessionId(inputHash, taskId, index) {
  return `${DERIVED_ID_PREFIX.study}_${hashParts(inputHash, taskId, `fragment-${index}`)}`;
}

/** 派生休息块 / 缓冲块的 ID（它们没有对应实体，只需要在计划内唯一且稳定） */
export function deriveBlockId(kind, inputHash, date, startMinutes, index = 0) {
  const prefix = DERIVED_ID_PREFIX[kind] ?? 'blk';
  return `${prefix}_${hashParts(kind, inputHash, date, String(startMinutes), String(index))}`;
}

/** 派生诊断项 ID */
export function deriveDiagnosticId(inputHash, code, key) {
  return `${DERIVED_ID_PREFIX.diagnostic}_${hashParts(inputHash, code, key)}`;
}
