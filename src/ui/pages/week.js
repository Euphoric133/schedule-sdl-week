/**
 * 七天计划页：**日期为列、任务为内容**的看板。
 *
 * 本页刻意不再使用"最左侧时间列 + 每小时行刻度"的时间轴：
 * 时间是卡片自身的属性（例如 22:00–22:45），不需要全局坐标轴，
 * 也就不存在"第 7 列混进时间文字"这类栅格串列问题。
 *
 * 数据来源：
 * - 学习任务：正式计划里的 study 块（已完成/已取消的任务不显示）；
 * - 固定任务：由重复规则按日期实时展开——因此**翻到下一周依然存在**；
 * - 休息：由休息安排按午夜边界拆分出的当日片段。
 *
 * 本页不做任何独立的排程计算，所以不会与其它视图产生冲突。
 */

import { button, card, legend, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, dateRange, formatDateWithWeekday, formatDuration } from '../../domain/time.js';
import { buildBoardColumns, renderBoard } from '../board.js';

export function renderWeek({ app, services, route, now }) {
  const state = app.getState();
  const today = now().date;
  const offsetWeeks = Number.parseInt(route.params.get('offset') ?? '0', 10) || 0;
  const plan = services.planService.getOfficialPlan();

  /**
   * 日期范围：默认跟随正式计划窗口；一旦用户翻周，就以"今天 + N×7"为起点。
   *
   * 这样做的原因：固定任务是**重复规则**，任何日期都能算出来，
   * 所以即使翻到计划窗口之外，固定任务和休息依然会正常显示；
   * 而学习任务只来自计划，窗口之外自然没有——这一点会在页面上说明。
   */
  const baseStart = offsetWeeks === 0 && plan?.version > 0 ? plan.windowStart : addDays(today, offsetWeeks * 7);
  const dates = dateRange(baseStart, addDays(baseStart, 6));

  const columns = buildBoardColumns({ dates, state, plan, services, today, nowMinutes: now().minutes });
  const studyMinutes = columns.reduce(
    (sum, column) => sum + column.cards.filter((item) => item.kind === 'study').reduce((inner, item) => inner + (item.minutes ?? 0), 0),
    0,
  );
  const inPlanWindow = Boolean(plan && plan.version > 0 && baseStart >= plan.windowStart && baseStart <= plan.windowEnd);

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '七天计划' }),
        el('p.page-head__sub', {
          text: `${formatDateWithWeekday(dates[0])} → ${formatDateWithWeekday(dates[6])}　·　已排学习 ${formatDuration(studyMinutes)}`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('← 上一周', { size: 'sm', onClick: () => gotoWeek(offsetWeeks - 1) }),
        button('回到本周', { size: 'sm', disabled: offsetWeeks === 0, onClick: () => gotoWeek(0) }),
        button('下一周 →', { size: 'sm', onClick: () => gotoWeek(offsetWeeks + 1) }),
        button('添加休息', { size: 'sm', onClick: () => services.ui.openRestForm(null) }),
        button(plan && plan.version > 0 ? '重新规划' : '生成计划', {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            services.ui.openPlanForm({
              changeSummary: plan && plan.version > 0 ? '重新规划' : '生成第一份计划',
              trigger: 'week-page',
            });
          },
        }),
      ]),
    ]),
  );

  // —— 翻到计划窗口之外时如实说明 ——
  if (plan && plan.version > 0 && !inPlanWindow) {
    nodes.push(
      notice({
        level: 'info',
        title: '这一周不在当前计划范围内',
        message: `正式计划覆盖 ${plan.windowStart} → ${plan.windowEnd}。固定任务与休息会照常显示（它们按重复规则计算），但学习任务需要重新规划后才会出现在这里。`,
        actions: [
          button('把计划窗口移到这里', {
            size: 'sm',
            variant: 'primary',
            onClick: () => {
              const result = services.ui.previewWith([{ kind: 'window.shift', windowStart: baseStart, windowDays: 7 }], {
                changeSummary: `把计划窗口移动到 ${baseStart}`,
                trigger: 'week-page',
              });
              if (!result.ok) toast(result.message, 'error', 9000);
            },
          }),
          button('回到计划所在周', { size: 'sm', onClick: () => gotoWeek(0) }),
        ],
      }),
    );
  }

  if (!plan || plan.version === 0) {
    const hasTasks = (state.tasks ?? []).some((task) => task.status === 'not_started' || task.status === 'in_progress');
    nodes.push(
      notice({
        level: 'info',
        title: hasTasks ? '任务还没有排入计划' : '还没有学习任务',
        message: hasTasks
          ? '任务已经保存好了，但还没有生成计划，所以暂时不会出现在某一天里。生成计划后它们会按截止时间被安排到具体时段。'
          : '先创建学习任务（填好预计用时与截止日期），再生成计划，它们就会出现在这里。固定任务和休息不需要计划也会显示。',
        actions: [
          button(hasTasks ? '立即生成计划' : '新建任务', {
            size: 'sm',
            variant: 'primary',
            onClick: () => {
              if (hasTasks) {
                const result = services.ui.requestPreview({ changeSummary: '生成计划', trigger: 'week-page' });
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

  // —— 看板 ——
  nodes.push(
    card({
      title: '本周安排',
      hint: '每列一天；学习任务可以标记完成或删除，休息与固定任务是背景安排',
      actions: [legend()],
      flush: true,
      // 即使这一周没有安排，也要保留 7 个日期列（每列显示"这一天没有安排"），
      // 这样用户始终能看到"计划范围是哪七天"，而不会以为页面坏了。
      body: renderBoard({ columns, today, services }),
    }),
  );

  // —— 每日统计（保留原有信息，去掉缓冲列） ——
  const days = columns.map((column) => {
    const study = column.cards.filter((item) => item.kind === 'study');
    const planDay = plan?.days?.find((item) => item.date === column.date);
    return {
      date: column.date,
      studyMinutes: study.reduce((sum, item) => sum + (item.minutes ?? 0), 0),
      sessions: study.length,
      restMinutes: column.cards.filter((item) => item.kind === 'rest').reduce((sum, item) => sum + (item.minutes ?? 0), 0),
      fixedMinutes: column.cards.filter((item) => item.kind === 'fixed').reduce((sum, item) => sum + (item.minutes ?? 0), 0),
      netCapacityMinutes: planDay?.netCapacityMinutes ?? null,
    };
  });

  nodes.push(
    card({
      title: '每日统计',
      hint: '可用净容量 = 允许学习时间 − 固定任务 − 已锁定/已完成时段',
      flush: true,
      body: el('div.table-wrap', {}, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '日期' }),
              el('th', { text: '学习' }),
              el('th', { text: '固定任务' }),
              el('th', { text: '休息' }),
              el('th', { text: '可用净容量' }),
            ]),
          ]),
          el(
            'tbody',
            {},
            days.map((day) =>
              el('tr', {}, [
                el('td', { text: `${day.date}${day.date === today ? '（今天）' : ''}` }),
                el('td', { text: day.sessions === 0 ? '暂无安排' : `${formatDuration(day.studyMinutes)}（${day.sessions} 段）` }),
                el('td', { text: day.fixedMinutes > 0 ? formatDuration(day.fixedMinutes) : '—' }),
                el('td', { text: day.restMinutes > 0 ? formatDuration(day.restMinutes) : '—' }),
                el('td', { text: day.netCapacityMinutes === null ? '—' : formatDuration(day.netCapacityMinutes) }),
              ]),
            ),
          ),
        ]),
      ]),
    }),
  );

  // —— 未安排任务 ——
  const unscheduled = services.planService.unscheduledSummary(plan);
  if (unscheduled.count > 0) {
    nodes.push(
      card({
        title: `仍未能安排的任务（${unscheduled.count}）`,
        hint: '任务本身已保存，只是没有被排进这七天',
        flush: true,
        body: el(
          'ul.task-list',
          {},
          (plan?.unscheduled ?? []).map((item) =>
            el('li.task-item', {}, [
              el('div.task-item__head', {}, [
                el('div', {}, [el('strong', { text: item.taskTitle ?? '任务' })]),
                el('div.task-item__meta', {}, [pill(`剩余 ${formatDuration(item.remainingMinutes ?? 0)}`, 'warning')]),
              ]),
              el('div.card__hint', { text: item.reasonText ?? '' }),
            ]),
          ),
        ),
      }),
    );
  }

  return nodes;
}

function gotoWeek(offset) {
  globalThis.location.hash = offset === 0 ? '#/week' : `#/week?offset=${offset}`;
}
