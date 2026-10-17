/**
 * 固定活动管理页。
 *
 * 固定活动是"不可移动的时间占用"（课程、睡眠、用餐、社团），它们直接决定可用时间，
 * 因此这里的所有修改都**先生成候选计划预览**：用户能立刻看到"删除这个活动会多出多少时间、
 * 学习安排会怎么变"，确认后才真正写入。
 */

import { button, card, emptyState, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { FIXED_ACTIVITY_TYPE, FIXED_ACTIVITY_TYPE_LABELS_ZH } from '../../domain/fixedActivity.js';
import { addDays, formatDuration, formatMinutes, WEEKDAY_NAMES_ZH, weekday } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';
import { updateParams } from '../router.js';

/** 界面上的展示顺序：先课程与睡眠，再用餐与社团，最后其它 */
const TYPE_ORDER = [
  FIXED_ACTIVITY_TYPE.CLASS,
  FIXED_ACTIVITY_TYPE.SLEEP,
  FIXED_ACTIVITY_TYPE.MEAL,
  FIXED_ACTIVITY_TYPE.CLUB,
  FIXED_ACTIVITY_TYPE.COMMUTE,
  FIXED_ACTIVITY_TYPE.OTHER,
];

export function renderActivities({ app, services, route, now }) {
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();
  const activities = services.fixedActivityService.list();
  const typeFilter = route.params.get('type') ?? '';
  const shown = typeFilter ? activities.filter((activity) => activity.type === typeFilter) : activities;

  // 用于"影响面"计算的七天窗口（优先跟随正式计划，未生成计划时用今天起七天）
  const windowStart = plan?.windowStart ?? now().date;
  const windowDates = [];
  for (let i = 0; i < 7; i += 1) windowDates.push(addDays(windowStart, i));

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '固定日程与休息' }),
        el('p.page-head__sub', {
          text: `${activities.length} 项固定安排 · 统计窗口 ${windowStart} → ${addDays(windowStart, 6)}`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('添加休息', { size: 'sm', onClick: () => services.ui.openRestForm(null) }),
        button('新建固定任务', { variant: 'primary', onClick: () => services.ui.openFixedActivityForm(null) }),
      ]),
    ]),
  );

  nodes.push(
    notice({
      level: 'info',
      title: '修改固定活动会改变可用时间',
      message:
        '任何新增、修改或删除都会先生成候选计划预览（显示可用时间与学习安排的变化），你确认之后才会生效。放弃预览不会改变任何数据。',
    }),
  );

  // —— 类型筛选 ——
  const typeButtons = [
    button(`全部（${activities.length}）`, {
      size: 'sm',
      variant: typeFilter === '' ? 'primary' : 'default',
      onClick: () => updateParams({ type: null }),
    }),
    ...TYPE_ORDER.filter((type) => activities.some((activity) => activity.type === type)).map((type) =>
      button(`${FIXED_ACTIVITY_TYPE_LABELS_ZH[type]}（${activities.filter((activity) => activity.type === type).length}）`, {
        size: 'sm',
        variant: typeFilter === type ? 'primary' : 'default',
        onClick: () => updateParams({ type }),
      }),
    ),
  ];
  /* ---------- 休息时间 ---------- */
  const rests = services.restService.list();
  nodes.push(
    card({
      title: `休息时间（${rests.length}）`,
      hint: '一条休息可以跨午夜；每日视图会按日期自动拆成两个区块显示',
      actions: [button('添加休息', { size: 'sm', variant: 'primary', onClick: () => services.ui.openRestForm(null) })],
      flush: rests.length > 0,
      body:
        rests.length === 0
          ? el('div', { style: { padding: 'var(--space-4)' } }, [
              el('div.card__hint', {
                text: '还没有休息时间。休息与学习任务、固定任务都不同：它不参与排程，只标记"这段时间在休息"。',
              }),
            ])
          : el(
              'ul.task-list',
              {},
              rests.map((rest) => {
                const dates = services.restService.datesOf(rest.id);
                const fragments = dates.flatMap((date) => services.restService.forDate(date)).filter((f) => f.restId === rest.id);
                return el('li.task-item', {}, [
                  el('div.task-item__head', {}, [
                    el('div', {}, [
                      el('strong', { text: rest.title }),
                      el('span', { text: `　${rest.startDate} ${toHHmm(rest.startMinutes)} → ${rest.endDate} ${toHHmm(rest.endMinutes === 1440 ? 0 : rest.endMinutes)}` }),
                    ]),
                    el('div.task-item__meta', {}, [
                      pill(dates.length > 1 ? `跨 ${dates.length} 天` : '单日', dates.length > 1 ? 'rest' : 'neutral'),
                      pill(formatDuration(restDuration(rest)), 'rest'),
                    ]),
                  ]),
                  el('div.card__hint', {
                    text:
                      fragments.length > 1
                        ? `显示为：${fragments.map((f) => `${f.date} ${toHHmm(f.startMinutes)}–${toHHmm(f.endMinutes)}`).join('；')}`
                        : `显示为：${fragments.map((f) => `${f.date} ${toHHmm(f.startMinutes)}–${toHHmm(f.endMinutes)}`).join('')}`,
                  }),
                  el('div.task-item__actions', {}, [
                    button('编辑', { size: 'sm', onClick: () => services.ui.openRestForm(rest.id) }),
                    button('删除', {
                      size: 'sm',
                      variant: 'danger',
                      onClick: () => services.ui.deleteRest(rest.id),
                    }),
                  ]),
                ]);
              }),
            ),
    }),
  );

  nodes.push(
    card({
      title: '按类型筛选',
      body: el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' } }, typeButtons),
    }),
  );

  // —— 列表 ——
  nodes.push(
    card({
      title: '固定活动清单',
      hint: shown.length === 0 ? '没有符合条件的固定活动' : `显示 ${shown.length} 项`,
      flush: shown.length > 0,
      body:
        shown.length === 0
          ? emptyState({
              title: '还没有固定活动',
              message:
                activities.length === 0
                  ? '把课程、睡眠、用餐、社团等固定安排录进来，排程时它们会被自动避开，可用时间也会相应减少。'
                  : '试试把筛选条件改成"全部"。',
              actions: [button('新建固定活动', { variant: 'primary', onClick: () => services.ui.openFixedActivityForm(null) })],
            })
          : el(
              'ul.task-list',
              {},
              shown.map((activity) => activityRow(activity, { services, windowDates, windowStart })),
            ),
    }),
  );

  // —— 全周占用概览 ——
  nodes.push(
    card({
      title: '本周固定活动占用概览',
      hint: '按业务日统计（跨午夜的睡眠会拆分到两天）',
      flush: true,
      body: el('div.table-wrap', {}, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '日期' }),
              el('th', { text: '固定活动' }),
              el('th', { text: '占用时长' }),
              el('th', { text: '计划内可用净容量' }),
            ]),
          ]),
          el(
            'tbody',
            {},
            windowDates.map((date) => {
              const list = services.fixedActivityService.forDate(date);
              const total = list.reduce((sum, activity) => sum + (activity.endMinutes - activity.startMinutes), 0);
              const day = plan?.days?.find((item) => item.date === date);
              return el('tr', {}, [
                el('td', { text: `${date} ${WEEKDAY_NAMES_ZH[weekday(date) - 1]}` }),
                el('td', { text: list.length === 0 ? '—' : list.map((activity) => activity.title).join('、') }),
                el('td', { text: total > 0 ? formatDuration(total) : '—' }),
                el('td', { text: day ? formatDuration(day.netCapacityMinutes) : '—' }),
              ]);
            }),
          ),
        ]),
      ]),
    }),
  );

  if (!plan || plan.version === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有正式计划',
        message: '修改固定活动后生成的候选计划里会显示新的可用时间与学习安排，便于你确认影响。',
      }),
    );
  }

  return nodes;
}

function toHHmm(minutes) {
  const wrapped = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** 休息总时长（用于展示，独立计算以免依赖具体日期拆分实现） */
function restDuration(rest) {
  const [sy, sm, sd] = String(rest.startDate).split('-').map(Number);
  const [ey, em, ed] = String(rest.endDate).split('-').map(Number);
  const days = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
  return days * 1440 + (rest.endMinutes - rest.startMinutes);
}

function activityRow(activity, { services, windowDates, windowStart }) {
  const label = FIXED_ACTIVITY_TYPE_LABELS_ZH[activity.type] ?? activity.type;
  return el('li.task-item', {}, [
    el('div.task-item__head', {}, [
      el('div', {}, [el('strong', { text: activity.title }), el('span', { text: ` · ${label}` })]),
      el('div.task-item__meta', {}, [
        pill(`${formatMinutes(activity.startMinutes)}–${formatMinutes(activity.endMinutes)}`, 'fixed'),
        pill(services.fixedActivityService.describeRecurrence(activity), 'neutral'),
        pill(formatDuration(activity.endMinutes - activity.startMinutes), 'neutral'),
        activity.activeFrom || activity.activeTo
          ? pill(`生效 ${activity.activeFrom ?? '—'} → ${activity.activeTo ?? '—'}`, 'neutral')
          : null,
      ]),
    ]),
    activity.note ? el('div.card__hint', { text: activity.note }) : null,
    el('div.task-item__actions', {}, [
      button('编辑', { size: 'sm', onClick: () => services.ui.openFixedActivityForm(activity.id) }),
      button('删除', {
        size: 'sm',
        variant: 'danger',
        onClick: async () => {
          const evaluated = services.fixedActivityService.evaluateImpact(activity.id, windowDates);
          if (!evaluated.ok) return toast(evaluated.issues[0].message, 'error');
          const impact = evaluated.impact;
          const confirmed = await confirmDialog({
            title: `删除固定活动「${activity.title}」？`,
            message: impact.message,
            bullets: [
              `重复规则：${impact.recurrenceText}`,
              impact.occurrencesInWindow > 0
                ? `本次窗口内生效 ${impact.occurrencesInWindow} 次，共占用 ${formatDuration(impact.totalMinutesInWindow)}`
                : '本次窗口内不生效，删除后本周安排不会变化',
              '确认后会先生成候选计划预览，你可以看到具体影响再决定是否应用',
            ],
            confirmLabel: '删除并生成预览',
            confirmVariant: 'danger',
          });
          if (!confirmed) return;
          const result = services.ui.previewWith(
            [{ kind: 'fixedActivity.remove', activityId: activity.id }],
            { changeSummary: `删除固定活动「${activity.title}」`, trigger: 'activities-page' },
          );
          if (!result.ok) toast(result.message, 'error', 8000);
        },
      }),
    ]),
    el('div.card__hint', { text: `影响面按从 ${windowStart} 起的七天窗口统计` }),
  ]);
}
