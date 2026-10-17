/**
 * 每日视图：**日期为列、任务为内容**的日程概览。
 *
 * 为什么改成这种布局：
 * 原来的"以时间为纵轴、日期为横轴"的课表网格，在任务不多时会产生大片空白，
 * 窄屏下还会挤压变形，不如直接回答"哪天有哪些事"。
 * 现在每一列就是一天，列里按时间顺序列出当天的学习任务与固定任务。
 *
 * 数据来源（全部来自现有业务数据，不伪造任何内容）：
 * - 学习任务：`officialPlan.blocks` 中 kind='study' 的块（携带真实起止时间与任务关联）；
 * - 固定任务：`fixedActivities` 按当天展开的结果（没有具体时间的也照常显示）。
 *
 * 排序规则（稳定、可解释，不随重新渲染变化）：
 *   1. 有具体时间的在前，按开始时间先后；
 *   2. 同一时刻学习任务在前、固定任务在后；
 *   3. 再按标题的本地化比较；
 *   4. 最后按 id 兜底，保证任何情况下顺序都确定。
 */

import { button, card, emptyState, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { SESSION_STATE } from '../../domain/session.js';
import { TASK_STATUS } from '../../domain/task.js';
import { formatDuration, formatMinutes, weekday, WEEKDAY_NAMES_ZH } from '../../domain/time.js';

/** 卡片状态标签 */
const CARD_STATE_LABELS = {
  completed: '已完成',
  in_progress: '进行中',
  flexible: '待进行',
  overdue: '已过期',
  locked: '已锁定',
  cancelled: '已取消',
};

export function renderDay({ app, services, now }) {
  const state = app.getState();
  const today = now().date;
  const nowMinutes = now().minutes;
  const plan = services.planService.getOfficialPlan();
  const pendingPreview = services.planService.getPendingPreview();

  const dates = resolveDates({ plan, today });
  const columns = dates.map((date) => buildDayColumn({ date, state, plan, services, today, nowMinutes }));

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '每日视图' }),
        el('p.page-head__sub', {
          text:
            plan && plan.version > 0
              ? `${plan.windowStart} → ${plan.windowEnd}　·　共 ${dates.length} 天　·　学习任务与固定任务按时间列出`
              : '还没有正式计划。下面是今天起七天的固定日程；生成计划后这里会出现学习任务。',
        }),
      ]),
      el('div.page-head__actions', {}, [
        plan && plan.version > 0
          ? button('查看时间轴', { size: 'sm', onClick: () => { globalThis.location.hash = '#/week'; } })
          : null,
        button('生成计划', {
          variant: plan && plan.version > 0 ? 'default' : 'primary',
          size: 'sm',
          onClick: () => {
            const result = services.ui.requestPreview({
              changeSummary: plan && plan.version > 0 ? '重新规划' : '生成第一份计划',
              trigger: 'day-page',
            });
            if (!result.ok) toast(result.message, 'error', 9000);
          },
        }),
      ]),
    ]),
  );

  if (pendingPreview) {
    nodes.push(
      notice({
        level: 'warning',
        title: '有一份候选计划等待确认',
        message: '下面的安排来自当前正式计划；候选计划确认后才会替换它。',
        actions: [button('查看调整预览', { size: 'sm', variant: 'primary', onClick: () => { globalThis.location.hash = '#/preview'; } })],
      }),
    );
  }

  if (!plan || plan.version === 0) {
    const hasTasks = (state.tasks ?? []).some(
      (task) => task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS,
    );
    nodes.push(
      notice({
        level: 'info',
        title: hasTasks ? '任务还没有排入计划' : '还没有学习任务',
        message: hasTasks
          ? '你的任务已经保存好了，但还没有生成计划，所以暂时不会出现在某一天里。点「生成计划」之后，它们会按截止时间被安排到具体时段。'
          : '先把要做的事建成学习任务（填好预计用时与截止日期），再生成计划，它们就会出现在这里。',
        actions: [
          button(hasTasks ? '立即生成计划' : '新建任务', {
            size: 'sm',
            variant: 'primary',
            onClick: () => {
              if (hasTasks) {
                const result = services.ui.requestPreview({ changeSummary: '生成计划', trigger: 'day-page' });
                if (!result.ok) toast(result.message, 'error', 9000);
              } else {
                services.ui.openTaskForm(null);
              }
            },
          }),
        ],
      }),
    );
  }

  // —— 主体：日期为列 ——
  nodes.push(
    card({
      title: '日程概览',
      hint: '每一列是一天；学习任务与固定任务用不同颜色的标签区分，点击学习任务可查看详情',
      flush: true,
      body: el('div.day-board', {}, columns.map((column) => renderColumn({ column, services, today }))),
    }),
  );

  // —— 没有安排进本周的任务：明确列出原因 ——
  const unplannedTasks = (state.tasks ?? []).filter(
    (task) =>
      (task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS) &&
      !(state.sessions ?? []).some(
        (session) =>
          session.taskId === task.id && session.state !== SESSION_STATE.CANCELLED && dates.includes(session.date),
      ),
  );

  if (unplannedTasks.length > 0) {
    nodes.push(
      card({
        title: `这七天没有安排到的任务（${unplannedTasks.length}）`,
        hint: '任务本身已经保存，只是没有被排进这几天',
        flush: true,
        body: el(
          'ul.task-list',
          {},
          unplannedTasks.map((task) => {
            const reason = (plan?.unscheduled ?? []).find((item) => item.taskId === task.id);
            return el('li.task-item', {}, [
              el('div.task-item__head', {}, [
                el('div', {}, [el('strong', { text: task.title }), el('span', { text: ` · ${task.subject}` })]),
                el('div.task-item__meta', {}, [
                  pill(`截止 ${task.deadlineDate}`, 'neutral'),
                  pill(reason ? reasonLabel(reason.reasonCode) : '不在计划范围内', 'warning'),
                ]),
              ]),
              el('div.card__hint', {
                text: reason
                  ? `${reason.reasonText ?? ''}（剩余 ${formatDuration(reason.remainingMinutes ?? 0)}）`
                  : '这个任务没有落在当前计划的时间窗口内，可以重新规划，或调整截止日期。',
              }),
            ]);
          }),
        ),
      }),
    );
  }

  const unscheduled = services.planService.unscheduledSummary(plan);
  if (unscheduled.count > 0) {
    nodes.push(
      el('div.card__hint', {
        text: `本计划还有 ${unscheduled.count} 个任务未能完全安排（合计 ${formatDuration(unscheduled.totalMinutes)}）。可以到「偏好设置」延长可学习时间后重新生成。`,
      }),
    );
  }

  return nodes;
}

/* ------------------------------------------------------------------ *
 * 数据组织
 * ------------------------------------------------------------------ */

/**
 * 决定展示哪些日期。
 * 优先使用正式计划的窗口（保持现有 7 天范围，不擅自扩大）；没有计划时用今天起七天。
 */
export function resolveDates({ plan, today }) {
  const start = plan && plan.version > 0 && plan.windowStart ? plan.windowStart : today;
  return Array.from({ length: 7 }, (_, offset) => addDaysLocal(start, offset));
}

function addDaysLocal(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * 构造某一天的列数据。
 * @returns {{date: string, cards: object[]}}
 */
export function buildDayColumn({ date, state, plan, services, today, nowMinutes }) {
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const sessionById = new Map((state.sessions ?? []).map((session) => [session.id, session]));

  const blocks = (plan?.blocks ?? []).filter((block) => block.date === date && block.kind === 'study');

  const studyCards = blocks.map((block) => {
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
      status: deriveStatus({ session, block, date, today, nowMinutes }),
      sessionId: block.refId ?? null,
      locked: Boolean(block.locked),
      taskId: block.taskId ?? null,
    };
  });

  const activities = services.fixedActivityService.forDate(date);
  const fixedCards = activities.map((activity) => ({
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

  return { date, cards: [...studyCards, ...fixedCards].sort(compareCards) };
}

/**
 * 排序：稳定且可解释。
 * 1) 有时间在前，按开始时间；
 * 2) 同时间学习任务优先（学习是要执行的事，固定日程是背景）；
 * 3) 再按标题；4) 最后按 id。
 */
export function compareCards(a, b) {
  const aHasTime = Number.isInteger(a.startMinutes);
  const bHasTime = Number.isInteger(b.startMinutes);
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
  if (aHasTime && bHasTime && a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;

  if (a.kind !== b.kind) return a.kind === 'study' ? -1 : 1;

  const titleCompare = String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
  if (titleCompare !== 0) return titleCompare;

  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/** 卡片状态：优先级从"已完成"到"已过期" */
export function deriveStatus({ session, block, date, today, nowMinutes }) {
  if (session?.state === SESSION_STATE.COMPLETED) return 'completed';
  if (session?.state === SESSION_STATE.IN_PROGRESS) return 'in_progress';
  if (session?.state === SESSION_STATE.CANCELLED) return 'cancelled';
  if (block?.locked || session?.locked) return 'locked';
  if (date < today) return 'overdue';
  if (date === today && Number.isInteger(block?.endMinutes) && block.endMinutes <= nowMinutes) return 'overdue';
  return 'flexible';
}

const REASON_LABELS = {
  insufficient_capacity: '可用时间不足',
  tail_too_small: '剩余时长过短',
  blocked_by_dependency: '等待前置任务',
  dependency_unreachable: '前置任务已失效',
  non_splittable_no_slot: '没有足够长的连续空档',
  deadline_passed: '截止时间已过',
  window_too_narrow: '可学习时间过窄',
  daily_cap_reached: '已达每日上限',
  overloaded: '总工作量超过可用时间',
};

function reasonLabel(code) {
  return REASON_LABELS[code] ?? '无法安排';
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderColumn({ column, services, today }) {
  const { date, cards } = column;
  const isToday = date === today;
  const dayLabel = WEEKDAY_NAMES_ZH[weekday(date) - 1];

  return el('div.day-board__col', { class: isToday ? 'is-today' : null }, [
    el('div.day-board__head', {}, [
      el('div.day-board__date', { text: dayLabel }),
      el('div.day-board__num', { text: date.slice(5) }),
      isToday ? el('span.day-board__badge', { text: '今天' }) : null,
    ]),
    el(
      'div.day-board__body',
      {},
      cards.length === 0
        ? [el('div.day-board__empty', { text: '这一天没有安排' })]
        : cards.map((item) => renderCard({ card: item, services })),
    ),
  ]);
}

function renderCard({ card, services }) {
  const isStudy = card.kind === 'study';
  const timeText =
    Number.isInteger(card.startMinutes) && Number.isInteger(card.endMinutes)
      ? `${formatMinutes(card.startMinutes)}–${formatMinutes(card.endMinutes)}`
      : Number.isInteger(card.startMinutes)
        ? formatMinutes(card.startMinutes)
        : '全天';

  const content = [
    el('div.day-card__top', {}, [
      el('span.day-card__time', { text: timeText }),
      Number.isInteger(card.minutes) && card.minutes > 0
        ? el('span.day-card__minutes', { text: formatDuration(card.minutes) })
        : null,
    ]),
    el('div.day-card__title', { text: card.title }),
    el('div.day-card__meta', {}, [
      el(`span.day-tag.day-tag--${isStudy ? 'study' : 'fixed'}`, { text: isStudy ? card.subject || '学习' : '固定' }),
      isStudy ? el(`span.day-tag.day-tag--${card.status}`, { text: CARD_STATE_LABELS[card.status] ?? '待进行' }) : null,
    ]),
  ];

  if (isStudy && card.sessionId) {
    return el(
      'button.day-card.day-card--study',
      {
        type: 'button',
        title: `${card.title}　${timeText}　${CARD_STATE_LABELS[card.status] ?? ''}`,
        on: { click: () => services.ui.openSessionDetail(card.sessionId) },
      },
      content,
    );
  }

  return el('div', { class: isStudy ? 'day-card day-card--study' : 'day-card day-card--fixed' }, content);
}
