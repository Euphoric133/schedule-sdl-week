/**
 * 今日总览页。
 *
 * 职责：只读地展示"今天"的关键信息——今日已排学习量、今日待办、超期提示。
 * 具体的时段明细在七天计划页与每日视图；这里不重复实现时间轴，避免两套口径。
 */

import { button, card, emptyState, metricRow, notice, pill, taskList } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, formatDateWithWeekday, formatDuration, weekday as weekdayOf } from '../../domain/time.js';
import { TASK_STATUS } from '../../domain/task.js';
import { PLAN_STATUS } from '../../domain/plan.js';

export function renderToday({ app, services, now }) {
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();
  // "今天"必须来自当前时钟（由 shell 注入），否则跨天后页面会停在旧日期
  const today = now().date;

  const dayStats = plan?.days?.find((d) => d.date === today) ?? null;
  const studyMinutes = dayStats?.studyMinutes ?? 0;
  const restMinutes = dayStats?.restMinutes ?? 0;
  const fixedMinutes = dayStats?.fixedMinutes ?? 0;

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '今日总览' }),
        el('p.page-head__sub', { text: `${formatDateWithWeekday(today)} · 计划窗口 ${plan?.windowStart ?? today} → ${plan?.windowEnd ?? addDays(today, 6)}` }),
      ]),
      el('div.page-head__actions', {}, [
        button('前往七天计划', { onClick: () => { globalThis.location.hash = '#/week'; } }),
        button(plan && plan.version > 0 ? '重新规划' : '生成七天计划', {
          variant: 'primary',
          onClick: () => {
            const result = services.ui.requestPreview({
              changeSummary: plan && plan.version > 0 ? '重新规划' : '生成第一份计划',
              trigger: 'today-page',
            });
            if (!result.ok) toast(result.message, 'error', 8000);
          },
        }),
      ]),
    ]),
  );

  if (!plan || plan.version === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有正式计划',
        message:
          activeTaskCount(services) > 0
            ? '点击右上角"生成七天计划"，系统会按你的任务、固定活动与可用时间算出候选计划，并在确认前给出完整的调整预览。'
            : '还没有可安排的学习任务。先到"任务列表"创建任务，然后点击右上角生成计划。',
      }),
    );
  } else if (plan.status === PLAN_STATUS.PARTIALLY_FEASIBLE || plan.status === PLAN_STATUS.INFEASIBLE) {
    nodes.push(
      notice({
        level: 'warning',
        title: `当前计划状态：${plan.status === PLAN_STATUS.INFEASIBLE ? '不可行' : '部分可行'}`,
        message: `有 ${plan.unscheduled?.length ?? 0} 个任务未能完全安排。具体原因与可选处理方式见"调整预览"页。`,
        actions: [button('查看调整预览', { size: 'sm', onClick: () => { globalThis.location.hash = '#/preview'; } })],
      }),
    );
  }

  nodes.push(
    card({
      title: '今日容量与安排',
      hint: '数据来自当前正式计划',
      body: el('div', {}, [
        metricRow([
          { label: '预计学习', value: formatDuration(studyMinutes) },
          { label: '固定活动', value: formatDuration(fixedMinutes) },
          { label: '计划休息', value: formatDuration(restMinutes) },
          { label: '可用净容量', value: formatDuration(dayStats?.netCapacityMinutes ?? 0) },
        ]),
      ]),
    }),
  );

  const tasks = services.taskService.listTaskViews({ sort: 'deadline' });
  const active = tasks.filter((v) => v.task.status === TASK_STATUS.NOT_STARTED || v.task.status === TASK_STATUS.IN_PROGRESS);
  const horizon = addDays(today, state.settings.riskWindowDays ?? 30);
  const near = active.filter((v) => v.task.deadlineDate <= horizon);

  nodes.push(
    card({
      title: '今日待办与临近截止',
      hint: `按截止时间排序，共 ${near.length} 个任务在 ${state.settings.riskWindowDays ?? 30} 天内到期`,
      body:
        near.length === 0
          ? emptyState({
              title: '暂无临近截止的任务',
              message: active.length === 0 ? '还没有学习任务。先在"任务列表"中创建第一个任务。' : '当前所有未完成任务的截止日期都在 30 天之外。',
              actions: [button('前往任务列表', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/tasks'; } })],
            })
          : taskList(near.slice(0, 8), {
              renderActions: ({ task }) => [
                pill(
                  task.deadlineDate < today ? '已超期' : task.deadlineDate === today ? '今天截止' : `还有 ${daysUntil(today, task.deadlineDate)} 天`,
                  task.deadlineDate <= today ? 'danger' : 'neutral',
                ),
              ],
            }),
    }),
  );

  return nodes;
}

/** 当前待安排任务数量（用于空状态文案区分"没任务"与"没生成计划"） */
function activeTaskCount(services) {
  return services.taskService
    .getTasks()
    .filter((task) => task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS).length;
}

function daysUntil(from, to) {
  const a = Date.UTC(...from.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...to.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / 86400000);
}
