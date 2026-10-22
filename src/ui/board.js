/**
 * 七天计划看板：**日期为列、任务为内容**的统一渲染层。
 *
 * 一条重要约束（本轮明确要求）：
 * 不再有任何"最左侧时间列"或"按小时的行刻度"。时间是**卡片内部的属性**，
 * 不是全局坐标轴。因此这里没有任何时间网格结构。
 *
 * 但仍然需要"格子对齐"：卡片高度必须与时长成固定比例。
 * 做法是定义一个时长基准 —— 5 分钟 = 一个标准格（--day-grid-step），
 * 卡片高度 = 整数个标准格。这样：
 *   - 5 分钟占 1 格，10 分钟占 2 格……
 *   - 同一列里两张 30 分钟的卡片高度完全一致；
 *   - 60 分钟的卡片恰好是 30 分钟的两倍高。
 * 这个基准只用于**尺寸**，不用于绘制刻度文字。
 */

import { button, card } from './components.js';
import { el } from './dom.js';
import { SESSION_STATE } from '../domain/session.js';
import { TASK_STATUS } from '../domain/task.js';
import { formatDuration, formatMinutes, weekday, WEEKDAY_NAMES_ZH } from '../domain/time.js';

/** 一个标准格代表的时长（分钟）—— 本轮要求的最小支持时长 */
export const GRID_QUANTUM_MINUTES = 5;

/**
 * 卡片可用高度不足时允许的最小格数。
 * 3 格 = 24px：低于这个高度按钮无法点击、也放不下名称，属于可访问性底线。
 * 只有 5/10 分钟这类极短时段会用到它，其它时长严格按比例。
 */
export const MIN_CARD_STEPS = 3;

/** 把时长换算成"标准格数"（非 5 分钟倍数向上取整，避免显示时丢失时长） */
export function gridStepsFor(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return MIN_CARD_STEPS;
  return Math.max(MIN_CARD_STEPS, Math.ceil(minutes / GRID_QUANTUM_MINUTES));
}

/** 卡片高度（单位：标准格），供样式用 calc() 计算 */
export function cardHeightExpression(minutes) {
  return `calc(var(--day-grid-step) * ${gridStepsFor(minutes)})`;
}

/** 卡片很短时（≤30 分钟）隐藏次要信息，避免文字溢出 */
export function isCompactCard(minutes) {
  return gridStepsFor(minutes) < 6;
}

/* ------------------------------------------------------------------ *
 * 数据组织
 * ------------------------------------------------------------------ */

/**
 * 组装若干天的列数据。
 *
 * 数据来源与"是否显示"规则：
 * - 学习任务：正式计划里的 study 块；
 *   **任务已完成/已取消/已删除时不再显示**（历史记录仍在数据里，只是不占日程格子）；
 * - 固定任务：由重复规则按日期实时展开（因此跨周不会消失）；
 * - 休息：由休息安排按午夜边界拆分出的当日片段。
 *
 * @returns {Array<{date: string, cards: object[]}>}
 */
export function buildBoardColumns({ dates, state, plan, services, today, nowMinutes }) {
  return dates.map((date) => ({
    date,
    cards: buildDayCards({ date, state, plan, services, today, nowMinutes }),
  }));
}

export function buildDayCards({ date, state, plan, services, today, nowMinutes }) {
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const sessionById = new Map((state.sessions ?? []).map((session) => [session.id, session]));
  // 已完成任务只保留最早的一块
  const completedVisibleBlocks = selectCompletedDisplayBlockIds({ plan, state });

  /* ---- 学习任务 ---- */
  const studyCards = (plan?.blocks ?? [])
    .filter((block) => block.date === date && block.kind === 'study')
    .map((block) => {
      const task = taskById.get(block.taskId);
      const session = block.refId ? sessionById.get(block.refId) : null;
      return {
        kind: 'study',
        id: block.id,
        title: task?.title ?? block.label ?? '学习任务',
        subject: task?.subject ?? '',
        startMinutes: block.startMinutes,
        endMinutes: block.endMinutes,
        minutes: block.endMinutes - block.startMinutes,
        status: deriveStatus({
          taskStatus: task?.status ?? null,
          session,
          block,
          date,
          today,
          nowMinutes,
        }),
        sessionId: block.refId ?? null,
        taskId: block.taskId ?? null,
        taskStatus: task?.status ?? null,
        locked: Boolean(block.locked),
      };
    })
    .filter((item) => shouldShowStudyCard(item, taskById, completedVisibleBlocks));

  /* ---- 固定任务（按重复规则实时展开，跨周依然存在） ---- */
  const fixedCards = services.fixedActivityService.forDate(date).map((activity) => ({
    kind: 'fixed',
    id: activity.id,
    title: activity.title,
    recurrence: services.fixedActivityService.describeRecurrence(activity),
    startMinutes: Number.isInteger(activity.startMinutes) ? activity.startMinutes : null,
    endMinutes: Number.isInteger(activity.endMinutes) ? activity.endMinutes : null,
    minutes:
      Number.isInteger(activity.startMinutes) && Number.isInteger(activity.endMinutes)
        ? activity.endMinutes - activity.startMinutes
        : null,
    status: 'fixed',
  }));

  /* ---- 休息时间（跨午夜按日期拆分的片段） ---- */
  const restCards = services.restService.forDate(date).map((fragment) => ({
    kind: 'rest',
    id: `${fragment.restId}__${fragment.date}`,
    restId: fragment.restId,
    title: fragment.title,
    startMinutes: fragment.startMinutes,
    endMinutes: fragment.endMinutes,
    minutes: fragment.minutes,
    isStart: fragment.isStart,
    isEnd: fragment.isEnd,
    segmentCount: fragment.segmentCount,
    status: 'rest',
  }));

  return [...studyCards, ...fixedCards, ...restCards].sort(compareCards);
}

/**
 * 学习卡片是否应该出现在日程里。
 *
 * 关键需求：任务标记完成后，应从 7 日计划的格子里消失。
 * 判断依据是**任务状态**（单一事实来源），而不是"剩余工作量"之类的派生值，
 * 因此跨多天的同一个任务会一次性从所有日期的格子里消失。
 */
/**
 * 是否在时间表里显示这张学习卡片。
 *
 * 规则（本轮变更）：
 * - 已取消 / 已删除的任务：不显示；
 * - **已完成的任务：继续显示**（卡片状态为"已完成"），但同一任务只保留一张，
 *   由 `selectCompletedDisplayBlockIds()` 选出"最早的那一块"；
 * - 其它情况：保持原有"已取消时段不显示"的规则。
 *
 * @param {object} card
 * @param {Map<string, object>} taskById
 * @param {Set<string>|null} [completedVisibleBlocks] 已完成任务允许显示的块 id
 */
export function shouldShowStudyCard(card, taskById, completedVisibleBlocks = null) {
  const task = card.taskId ? taskById.get(card.taskId) : null;
  const status = task?.status ?? null;

  if (status === TASK_STATUS.CANCELLED || status === TASK_STATUS.DELETED) return false;

  if (status === TASK_STATUS.COMPLETED) {
    // 只显示"被选中的那一块"（最早），避免一个任务在多天各显示一张已完成
    return completedVisibleBlocks ? completedVisibleBlocks.has(card.id) : true;
  }

  if (card.sessionId) {
    // 已取消的时段不再占用日程（任务本身没完成时）
    if (card.status === 'cancelled') return false;
  }
  return true;
}

/**
 * 选出一个已完成任务在时间表里代表它的那个块。
 *
 * 规则：按（日期、开始时间）取**最早的一块**；同一任务只保留一张"已完成"卡片，
 * 避免一个 2 小时任务被拆成多段后，时间表看起来像完成了 8 小时。
 *
 * @param {{plan: object, state: object}} input
 * @returns {Set<string>} 允许显示的块 id
 */
export function selectCompletedDisplayBlockIds({ plan, state }) {
  const taskById = new Map((state?.tasks ?? []).map((task) => [task.id, task]));
  const firstByTask = new Map();

  for (const block of plan?.blocks ?? []) {
    if (block.kind !== 'study' || !block.taskId) continue;
    const task = taskById.get(block.taskId);
    if (!task || task.status !== TASK_STATUS.COMPLETED) continue;

    const current = firstByTask.get(block.taskId);
    const isEarlier =
      !current ||
      block.date < current.date ||
      (block.date === current.date && block.startMinutes < current.startMinutes);
    if (isEarlier) firstByTask.set(block.taskId, block);
  }

  return new Set([...firstByTask.values()].map((block) => block.id));
}

/**
 * 排序：稳定且可解释。
 * 1) 有时间的在前，按开始时间；
 * 2) 同一时刻学习 → 固定 → 休息（学习是要执行的事，其余是背景）；
 * 3) 再按标题；4) 最后按 id 兜底。
 */
export function compareCards(a, b) {
  const aHasTime = Number.isInteger(a.startMinutes);
  const bHasTime = Number.isInteger(b.startMinutes);
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
  if (aHasTime && bHasTime && a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;

  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

  const titleCompare = String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
  if (titleCompare !== 0) return titleCompare;

  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

const KIND_ORDER = { study: 0, fixed: 1, rest: 2 };

/**
 * 卡片状态：已完成 / 进行中 / 已锁定 / 已过期 / 待进行
 *
 * **任务状态优先于时段状态**：任务本身已完成时，即使它的时段被 reconcile 取消了，
 * 卡片也必须显示"已完成"，而不是"已取消"（否则看起来像任务没了）。
 */
export function deriveStatus({ taskStatus = null, session, block, date, today, nowMinutes }) {
  if (taskStatus === TASK_STATUS.COMPLETED) return 'completed';
  if (taskStatus === TASK_STATUS.CANCELLED || taskStatus === TASK_STATUS.DELETED) return 'cancelled';
  if (session?.state === SESSION_STATE.COMPLETED) return 'completed';
  if (session?.state === SESSION_STATE.IN_PROGRESS) return 'in_progress';
  if (session?.state === SESSION_STATE.CANCELLED) return 'cancelled';
  if (block?.locked || session?.locked) return 'locked';
  if (date < today) return 'overdue';
  if (date === today && Number.isInteger(block?.endMinutes) && block.endMinutes <= nowMinutes) return 'overdue';
  return 'flexible';
}

const STATE_LABELS = {
  completed: '已完成',
  in_progress: '进行中',
  flexible: '待进行',
  overdue: '已过期',
  locked: '已锁定',
  cancelled: '已取消',
  fixed: '固定',
  rest: '休息',
};

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 渲染看板。
 * @param {object} options
 * @param {Array} options.columns buildBoardColumns 的结果
 * @param {string} options.today
 * @param {object} options.services
 * @param {(card: object) => void} [options.onOpenStudy] 点击学习卡片
 * @param {(card: object) => void} [options.onCompleteStudy] 标记完成
 * @param {(card: object) => void} [options.onDeleteTask] 删除任务
 * @param {(card: object) => void} [options.onDeleteRest] 删除休息
 */
export function renderBoard({ columns, today, services, onOpenStudy, onCompleteStudy, onDeleteTask, onDeleteRest }) {
  return el(
    'div.day-board',
    {},
    columns.map((column) => renderColumn({ column, today, services, onOpenStudy, onCompleteStudy, onDeleteTask, onDeleteRest })),
  );
}

/**
 * 时刻文案：1440 分钟（当天结束）显示为 24:00，而不是 00:00。
 *
 * 这直接影响"跨夜休息"的可读性：用户设置 22:00 → 次日 08:00 时，
 * 今天的片段必须显示成 22:00–24:00，才不会被误读成"到 00:00 就结束了"。
 */
function clockLabel(minutes) {
  return minutes === 1440 ? '24:00' : formatMinutes(minutes);
}

function renderColumn({ column, today, services, onOpenStudy, onCompleteStudy, onDeleteTask, onDeleteRest }) {
  const { date, cards } = column;
  const isToday = date === today;

  return el('div.day-board__col', { class: isToday ? 'is-today' : null }, [
    el('div.day-board__head', {}, [
      el('div.day-board__date', { text: WEEKDAY_NAMES_ZH[weekday(date) - 1] }),
      el('div.day-board__num', { text: date.slice(5) }),
      isToday ? el('span.day-board__badge', { text: '今天' }) : null,
    ]),
    el(
      'div.day-board__body',
      {},
      cards.length === 0
        ? [el('div.day-board__empty', { text: '这一天没有安排' })]
        : cards.map((item) => renderCard({ card: item, services, onOpenStudy, onCompleteStudy, onDeleteTask, onDeleteRest })),
    ),
  ]);
}

function renderCard({ card, services, onOpenStudy, onCompleteStudy, onDeleteTask, onDeleteRest }) {
  const isStudy = card.kind === 'study';
  const isRest = card.kind === 'rest';
  const minutes = Number.isInteger(card.minutes) ? card.minutes : null;
  const compact = minutes === null ? false : isCompactCard(minutes);

  const timeText =
    Number.isInteger(card.startMinutes) && Number.isInteger(card.endMinutes)
      ? `${clockLabel(card.startMinutes)}–${clockLabel(card.endMinutes)}`
      : Number.isInteger(card.startMinutes)
        ? clockLabel(card.startMinutes)
        : '全天';

  const tags = [
    el(`span.day-tag.day-tag--${isStudy ? 'study' : isRest ? 'rest' : 'fixed'}`, {
      text: isStudy ? card.subject || '学习' : isRest ? '休息' : '固定',
    }),
    isStudy ? el(`span.day-tag.day-tag--${card.status}`, { text: STATE_LABELS[card.status] ?? '待进行' }) : null,
    isRest && card.segmentCount > 1
      ? el('span.day-tag.day-tag--rest', { text: card.isStart ? '跨夜（前半）' : card.isEnd ? '跨夜（后半）' : '跨夜' })
      : null,
  ].filter(Boolean);

  const actions = [];
  if (isStudy) {
    actions.push(
      button('详情', { size: 'sm', variant: 'ghost', onClick: () => (onOpenStudy ?? ((item) => services.ui.openSessionDetail(item.sessionId)))(card) }),
    );
    if (card.status !== 'completed' && card.sessionId) {
      actions.push(
        button('完成', {
          size: 'sm',
          onClick: () => (onCompleteStudy ? onCompleteStudy(card) : services.ui.completeSession(card)),
        }),
      );
    }
    if (card.taskId) {
      actions.push(
        button('删除任务', {
          size: 'sm',
          variant: 'danger',
          onClick: () => (onDeleteTask ? onDeleteTask(card) : services.ui.deleteTask(card.taskId)),
        }),
      );
    }
  } else if (isRest && card.restId) {
    actions.push(
      button('删除休息', {
        size: 'sm',
        variant: 'danger',
        onClick: () => (onDeleteRest ? onDeleteRest(card) : services.ui.deleteRest(card.restId)),
      }),
    );
  }

  const body = [
    el('div.day-card__top', {}, [
      el('span.day-card__time', { text: timeText }),
      minutes !== null && !compact ? el('span.day-card__minutes', { text: formatDuration(minutes) }) : null,
    ]),
    el('div.day-card__title', { title: card.title, text: card.title }),
    // 紧凑卡片（≤30 分钟）也要能看到完成标记，不能把标签一起藏掉
    isStudy && card.status === 'completed' && compact
      ? el('div.day-card__meta', {}, [el('span.day-tag.day-tag--completed', { text: '已完成' })])
      : compact
        ? null
        : el('div.day-card__meta', {}, tags),
    compact ? null : el('div.day-card__actions', {}, actions),
  ].filter(Boolean);

  return el(
    'div',
    {
      class: [
        'day-card',
        `day-card--${isStudy ? 'study' : isRest ? 'rest' : 'fixed'}`,
        isStudy && card.status === 'completed' ? 'day-card--completed' : null,
        compact ? 'is-compact' : null,
      ]
        .filter(Boolean)
        .join(' '),
      style: { minHeight: cardHeightExpression(minutes ?? GRID_QUANTUM_MINUTES) },
      title: `${card.title}　${timeText}${minutes !== null ? `　${formatDuration(minutes)}` : ''}`,
    },
    body,
  );
}
