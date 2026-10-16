/**
 * 每日视图页（单日时间轴）。
 *
 * 与七天视图**共用同一份计划数据**（`services.planService.getOfficialPlan()`），
 * 因此不会出现"每日视图与周视图互相矛盾"的情况。这里只是把窗口缩到一天，
 * 并额外展示当天的固定活动、容量构成与学习时段清单，便于逐段检查。
 */

import { button, card, emptyState, legend, metricRow, notice, pill, sumByKind, timeline } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, dateRange, formatDateWithWeekday, formatDuration, formatMinutes, weekday } from '../../domain/time.js';
import { PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';
import { updateParams } from '../router.js';

export function renderDay({ app, services, route, now }) {
  const state = app.getState();
  const today = now().date;
  const plan = services.planService.getOfficialPlan();
  const requested = route.params.get('date');
  const date = isValidDate(requested) ? requested : today;

  const blocks = (plan?.blocks ?? []).filter((block) => block.date === date).sort((a, b) => a.startMinutes - b.startMinutes);
  const blocksByDate = new Map([[date, blocks]]);
  const dayStats = plan?.days?.find((item) => item.date === date) ?? null;
  const activities = services.fixedActivityService.forDate(date);

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '每日视图' }),
        el('p.page-head__sub', {
          text: `${formatDateWithWeekday(date)}${date === today ? '（今天）' : ''} · 计划窗口 ${plan ? `${plan.windowStart} → ${plan.windowEnd}` : '尚未生成'}`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('← 前一天', { size: 'sm', onClick: () => updateParams({ date: addDays(date, -1) }) }),
        button('回到今天', { size: 'sm', disabled: date === today, onClick: () => updateParams({ date: null }) }),
        button('后一天 →', { size: 'sm', onClick: () => updateParams({ date: addDays(date, 1) }) }),
        button('查看整周', { size: 'sm', onClick: () => { globalThis.location.hash = '#/week'; } }),
      ]),
    ]),
  );

  if (!plan || plan.version === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有正式计划',
        message: '生成计划后，这里会显示当天的学习时段、固定活动、计划休息与机动缓冲。',
        actions: [
          button('生成计划', {
            variant: 'primary',
            onClick: () => {
              const result = services.ui.requestPreview({ changeSummary: '生成第一份计划', trigger: 'day-page' });
              if (!result.ok) toast(result.message, 'error', 8000);
            },
          }),
        ],
      }),
    );
  } else if (date < plan.windowStart || date > plan.windowEnd) {
    nodes.push(
      notice({
        level: 'warning',
        title: '这一天不在正式计划窗口内',
        message: `正式计划覆盖 ${plan.windowStart} → ${plan.windowEnd}。可以把窗口移动到这一天后重新规划。`,
        actions: [
          button('把窗口移到这一天', {
            size: 'sm',
            onClick: () => {
              const result = services.ui.previewWith([{ kind: 'window.shift', windowStart: date, windowDays: 7 }], {
                changeSummary: `把计划窗口移动到 ${date}`,
                trigger: 'day-page',
              });
              if (!result.ok) toast(result.message, 'error', 8000);
            },
          }),
        ],
      }),
    );
  }

  nodes.push(
    card({
      title: '当日容量与安排',
      hint: '数据来自当前正式计划；缓冲与计划休息分开统计，不重复计算',
      actions: [legend()],
      body: el('div', {}, [
        metricRow([
          { label: '已排学习', value: formatDuration(dayStats?.studyMinutes ?? 0) },
          { label: '固定活动', value: formatDuration(dayStats?.fixedMinutes ?? 0) },
          { label: '已锁定', value: formatDuration(dayStats?.reservedMinutes ?? 0) },
          { label: '计划休息', value: formatDuration(dayStats?.restMinutes ?? 0) },
          { label: '机动缓冲', value: formatDuration(dayStats?.bufferMinutes ?? 0) },
          { label: '净容量', value: formatDuration(dayStats?.netCapacityMinutes ?? 0) },
        ]),
        el('div', { style: { marginTop: 'var(--space-3)' } }, [
          timeline({
            dates: [date],
            blocksByDate,
            today,
            startHour: 6,
            endHour: 24,
            labelPrefix: `${formatDateWithWeekday(date)} 的时间轴`,
            onSelect: (block) => {
              if (block.kind === 'study' && block.refId) {
                services.ui.openSessionDetail(block.refId);
              } else {
                toast(`${block.label}：${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}`, 'info');
              }
            },
          }),
        ]),
      ]),
    }),
  );

  // —— 当天学习时段清单（可逐段操作）——
  const studyBlocks = blocks.filter((block) => block.kind === 'study');
  nodes.push(
    card({
      title: `当天的学习时段（${studyBlocks.length}）`,
      hint: '点击任一时段可查看详情、锁定或移动',
      flush: studyBlocks.length > 0,
      body:
        studyBlocks.length === 0
          ? emptyState({
              title: '这一天没有安排学习时段',
              message:
                activities.length > 0
                  ? `当天有 ${activities.length} 项固定活动占用了时间。可以到"偏好设置"调整可学习时间后重新规划。`
                  : '可以到"偏好设置"确认这一天的可学习时间是否为空，然后重新规划。',
            })
          : el(
              'ul.task-list',
              {},
              studyBlocks.map((block) => {
                const session = (state.sessions ?? []).find((item) => item.id === block.refId);
                const task = (state.tasks ?? []).find((item) => item.id === block.taskId);
                return el('li.task-item', {}, [
                  el('div.task-item__head', {}, [
                    el('div', {}, [
                      el('strong', { text: `${formatMinutes(block.startMinutes)}–${formatMinutes(block.endMinutes)}` }),
                      el('span', { text: ` · ${task?.title ?? block.label}` }),
                    ]),
                    el('div.task-item__meta', {}, [
                      pill(formatDuration(block.endMinutes - block.startMinutes), 'study'),
                      session?.locked ? pill('已锁定', 'locked') : null,
                      session?.state === 'completed' ? pill('已完成', 'success') : null,
                      session?.state === 'in_progress' ? pill('进行中', 'warning') : null,
                    ]),
                  ]),
                  el('div.task-item__actions', {}, [
                    button('查看 / 调整', { size: 'sm', onClick: () => services.ui.openSessionDetail(block.refId) }),
                    session && session.state !== 'completed'
                      ? button(session.locked ? '解除锁定' : '锁定', {
                          size: 'sm',
                          onClick: () => {
                            const result = services.ui.previewWith(
                              [{ kind: 'session.lock', sessionId: block.refId, locked: !session.locked }],
                              { changeSummary: session.locked ? '解除时段锁定' : '锁定时段', trigger: 'day-page' },
                            );
                            if (!result.ok) toast(result.message, 'error', 7000);
                          },
                        })
                      : null,
                  ]),
                ]);
              }),
            ),
    }),
  );

  // —— 当天固定活动 ——
  nodes.push(
    card({
      title: `当天的固定活动（${activities.length}）`,
      hint: '固定活动不可被自动排程移动；修改后需要重新规划',
      actions: [button('管理固定活动', { size: 'sm', onClick: () => { globalThis.location.hash = '#/activities'; } })],
      flush: activities.length > 0,
      body:
        activities.length === 0
          ? el('div', { style: { padding: 'var(--space-4)' } }, [el('div.card__hint', { text: '这一天没有固定活动。' })])
          : el(
              'ul.task-list',
              {},
              activities.map((activity) =>
                el('li.task-item', {}, [
                  el('div.task-item__head', {}, [
                    el('div', {}, [
                      el('strong', { text: `${formatMinutes(activity.startMinutes)}–${formatMinutes(activity.endMinutes)}` }),
                      el('span', { text: ` · ${activity.title}` }),
                    ]),
                    el('div.task-item__meta', {}, [
                      pill(services.fixedActivityService.describeRecurrence(activity), 'fixed'),
                      pill(formatDuration(activity.endMinutes - activity.startMinutes), 'neutral'),
                    ]),
                  ]),
                ]),
              ),
            ),
    }),
  );

  if (plan && plan.version > 0) {
    nodes.push(
      el('div.card__hint', {
        text: `正式计划版本 v${plan.version} · 状态：${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status} · 本周已排 ${formatDuration(
          plan.days.reduce((sum, day) => sum + day.studyMinutes, 0),
        )}`,
      }),
    );
  }

  return nodes;
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export { dateRange, sumByKind, weekday };
