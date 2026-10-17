/**
 * 首页：应用的主入口。
 *
 * 这一页要回答用户最关心的五个问题，一条都不能缺：
 * 1. 今天我该做什么？（今日任务清单 + 下一项）
 * 2. 我做到哪了？（真实统计，不是计划数字）
 * 3. 计划在哪里？/怎么生成？（**主要的规划入口就在这一页**）
 * 4. 现在该做什么？（下一项 + 开始学习）
 * 5. 接下来几天怎样？（七天概览）
 *
 * 所有数字都来自真实记录（`statsService`），没有数据时显示引导而不是 0 值图表。
 */

import { button, card, emptyState, notice, pill, progressBar, statTile } from '../components.js';
import { buildDayCards, renderBoard } from '../board.js';
import { el, toast } from '../dom.js';
import { SESSION_STATE } from '../../domain/session.js';
import { TASK_STATUS } from '../../domain/task.js';
import { PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';
import { addDays, formatDateWithWeekday, formatDuration, formatMinutes, WEEKDAY_NAMES_ZH, weekday } from '../../domain/time.js';

export function renderHome({ app, services, now }) {
  const state = app.getState();
  const today = now().date;
  const nowMinutes = now().minutes;
  const plan = services.planService.getOfficialPlan();
  const preview = services.planService.getPendingPreview();
  const stats = services.statsService;
  const todayStats = stats.today();
  const streak = todayStats.streak;

  const todaySessions = (state.sessions ?? [])
    .filter((session) => session.date === today && session.state !== SESSION_STATE.CANCELLED)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const running = todaySessions.find((session) => session.state === SESSION_STATE.IN_PROGRESS) ?? null;
  const nextSession = todaySessions.find((session) => session.state === SESSION_STATE.FLEXIBLE && session.endMinutes > nowMinutes) ?? null;
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const activeTasks = (state.tasks ?? []).filter(
    (task) => task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS,
  );

  const nodes = [];

  /* ---------- 问候 + 关键操作 ---------- */
  nodes.push(
    el('header.home-hero', {}, [
      el('div.home-hero__text', {}, [
        el('p.home-hero__date', { text: `${formatDateWithWeekday(today)}　${greeting(nowMinutes)}` }),
        el('h1.home-hero__title', {
          text: running ? '正在进行这一段学习' : nextSession ? `下一项：${taskById.get(nextSession.taskId)?.title ?? '学习任务'}` : activeTasks.length > 0 ? '今天还没有安排' : '先创建你的第一个任务',
        }),
        el('p.home-hero__sub', { text: heroSubtitle({ running, nextSession, plan, preview, activeTasks, nowMinutes, taskById }) }),
      ]),
      el('div.home-hero__actions', {}, heroActions({ services, plan, activeTasks, running, nextSession, preview })),
    ]),
  );

  if (preview) {
    nodes.push(
      notice({
        level: 'warning',
        title: '有一份候选计划等待你确认',
        message: '生成计划只是第一步，还需要你在调整预览页确认之后才会生效。',
        actions: [button('查看调整预览', { size: 'sm', variant: 'primary', onClick: () => { globalThis.location.hash = '#/preview'; } })],
      }),
    );
  }

  /* ---------- 今日进度（真实数据） ---------- */
  const plannedMinutes = todaySessions.reduce((sum, session) => sum + session.plannedMinutes, 0);
  const completedSessions = todaySessions.filter((session) => session.state === SESSION_STATE.COMPLETED);
  const doneMinutes = completedSessions.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes), 0);
  const weekStats = services.statsService.weekly();
  const remainingToday = todaySessions
    .filter((session) => session.state === SESSION_STATE.FLEXIBLE || session.state === SESSION_STATE.IN_PROGRESS)
    .reduce((sum, session) => sum + session.plannedMinutes, 0);

  nodes.push(
    el('section.home-tiles', {}, [
      statTile({
        label: '今日已完成',
        value: formatDuration(doneMinutes),
        hint: `计划 ${formatDuration(plannedMinutes)}　·　${completedSessions.length}/${todaySessions.length} 段`,
        progress: plannedMinutes > 0 ? doneMinutes / plannedMinutes : 0,
        kind: 'primary',
      }),
      statTile({
        label: '今天还剩',
        value: formatDuration(remainingToday),
        hint: remainingToday > 0 ? `还有 ${todaySessions.filter((s) => s.state === SESSION_STATE.FLEXIBLE).length} 个时段要完成` : '今天的时段都已完成',
        kind: 'rest',
        onClick: () => { globalThis.location.hash = '#/day'; },
      }),
      statTile({
        label: '连续学习',
        value: streak.current > 0 ? `${streak.current} 天` : '—',
        hint: streak.activeDays > 0 ? `累计 ${streak.activeDays} 天有记录　·　最长 ${streak.longest} 天` : '完成第一段学习就开始记录',
        kind: 'accent',
        onClick: () => { globalThis.location.hash = '#/stats'; },
      }),
      statTile({
        label: '本周完成',
        value: formatDuration(weekStats.thisWeek.actualMinutes),
        hint: `共 ${weekStats.thisWeek.completedSessions} 段　·　上周 ${formatDuration(weekStats.lastWeek.actualMinutes)}`,
        kind: 'locked',
        onClick: () => { globalThis.location.hash = '#/stats'; },
      }),
    ]),
  );

  /* ---------- 规划入口 + 下一项 ---------- */
  const leftColumn = [];
  const rightColumn = [];

  leftColumn.push(renderPlanCard({ app, services, plan, todaySessions, taskById, activeTasks, nowMinutes, today }));

  /* ---------- 今天的安排（与七天计划同一套卡片，不再使用时间轴） ---------- */
  if (todaySessions.length > 0 || services.restService.list().length > 0) {
    const todayCards = buildDayCards({
      date: today,
      state,
      plan,
      services,
      today,
      nowMinutes,
    });
    leftColumn.push(
      card({
        title: '今天的安排',
        hint: '时间是卡片自身的属性；点击卡片上的按钮可以完成或删除',
        actions: [button('每日视图', { size: 'sm', onClick: () => { globalThis.location.hash = `#/day?date=${today}`; } })],
        flush: true,
        body: renderBoard({
          columns: [{ date: today, cards: todayCards }],
          today,
          services,
        }),
      }),
    );
  }

  /* ---------- 下一项 / 继续 ---------- */
  const focusTarget = running ?? nextSession;
  if (focusTarget) {
    const task = taskById.get(focusTarget.taskId);
    rightColumn.push(
      card({
        title: running ? '正在进行' : '下一项学习',
        hint: `${formatMinutes(focusTarget.startMinutes)}–${formatMinutes(focusTarget.endMinutes)}　${formatDuration(focusTarget.plannedMinutes)}`,
        body: el('div', {}, [
          el('div.home-next__task', {}, [
            el('div.home-next__title', { text: task?.title ?? '（任务已删除）' }),
            el('div.home-next__meta', { text: `${task?.subject ?? '未分类'}　·　${remainingText(task, state)}` }),
          ]),
          progressBar({
            value: task && task.plannedMinutes > 0 ? Math.min(1, taskCompletedMinutes(task, state) / task.plannedMinutes) : 0,
            label: '任务进度',
          }),
          el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
            button('查看 / 记录完成情况', {
              variant: 'primary',
              onClick: () => services.ui.openSessionDetail(focusTarget.id),
            }),
            button('查看任务', { onClick: () => { globalThis.location.hash = '#/tasks'; } }),
          ]),
        ]),
      }),
    );
  }

  /* ---------- 今日待办 ---------- */
  rightColumn.push(renderTodayList({ todaySessions, taskById, state, services }));

  /* ---------- 未来七天概览 ---------- */
  rightColumn.push(renderWeekOverview({ stats, today, plan }));

  nodes.push(el('div.home-grid', {}, [el('div.home-grid__main', {}, leftColumn), el('div.home-grid__side', {}, rightColumn)]));

  return nodes;
}

/* ------------------------------------------------------------------ *
 * 规划卡片：主要的排程入口
 * ------------------------------------------------------------------ */

function renderPlanCard({ app, services, plan, todaySessions, taskById, activeTasks, nowMinutes, today }) {
  if (activeTasks.length === 0) {
    return card({
      title: '开始规划',
      body: emptyState({
        title: '还没有需要安排的任务',
        message: '创建任务并填好预计用时与截止日期，系统就会自动把它安排进未来七天，并避开你的上课、睡眠与用餐时间。',
        actions: [
          button('新建任务', { variant: 'primary', onClick: () => services.ui.openTaskForm(null) }),
          button('管理固定日程', { onClick: () => { globalThis.location.hash = '#/activities'; } }),
        ],
      }),
    });
  }

  const hasPlan = Boolean(plan && plan.version > 0);
  const unscheduled = services.planService.unscheduledSummary(plan);

  return card({
    title: hasPlan ? '当前计划' : '生成七天计划',
    hint: hasPlan
      ? `覆盖 ${plan.windowStart} → ${plan.windowEnd}　·　${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status}`
      : '根据你的任务、固定日程与可学习时间自动排程',
    body: el('div', {}, [
      hasPlan
        ? el('div.metric-row', {}, [
            el('div.metric', {}, [el('div.metric__label', { text: '已安排' }), el('div.metric__value', { text: formatDuration(plan.metrics?.totalStudyMinutes ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '今日时段' }), el('div.metric__value', { text: `${todaySessions.length} 段` })]),
            el('div.metric', {}, [el('div.metric__label', { text: '待办任务' }), el('div.metric__value', { text: `${activeTasks.length} 个` })]),
            el('div.metric', {}, [
              el('div.metric__label', { text: '未完全安排' }),
              el('div.metric__value', { text: unscheduled.count === 0 ? '无' : `${unscheduled.count} 个` }),
            ]),
          ])
        : el('p', {
            text: `当前有 ${activeTasks.length} 个待办任务。点下面的按钮，系统会按截止时间紧迫度、难度与重要程度排出一份七天计划，然后请你确认。`,
          }),
      unscheduled.count > 0
        ? el('div.card__hint', {
            text: `有 ${unscheduled.count} 个任务没能完全排进去（共 ${formatDuration(unscheduled.totalMinutes)}）：${unscheduled.reasons.join('；')}。可以在"偏好设置"里延长可学习时间后重新生成。`,
          })
        : null,
      el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
        button(hasPlan ? '重新规划' : '生成七天计划', {
          variant: 'primary',
          onClick: () => {
            const result = services.ui.requestPreview({
              changeSummary: hasPlan ? '重新规划' : '生成第一份计划',
              trigger: 'home-page',
            });
            if (!result.ok) toast(result.message, 'error', 9000);
          },
        }),
        button('新建任务', { onClick: () => services.ui.openTaskForm(null) }),
        button('调整可用时间', { onClick: () => { globalThis.location.hash = '#/settings'; } }),
        hasPlan ? button('查看完整七天', { onClick: () => { globalThis.location.hash = '#/week'; } }) : null,
      ]),
      el('div.card__hint', {
        text: '生成计划只会创建一份"候选计划"给你检查，确认之前不会改动当前安排。',
      }),
      void nowMinutes,
      void today,
      void taskById,
      void app,
    ]),
  });
}

/* ------------------------------------------------------------------ *
 * 今日清单
 * ------------------------------------------------------------------ */

function renderTodayList({ todaySessions, taskById, state, services }) {
  if (todaySessions.length === 0) {
    return card({
      title: '今天的任务',
      body: emptyState({
        title: '今天还没有安排',
        message: '如果已经生成过计划，可以到"七天计划"看看未来几天的安排；如果还没有任务，先创建一个。',
        actions: [
          button('查看七天计划', { onClick: () => { globalThis.location.hash = '#/week'; } }),
          button('新建任务', { variant: 'primary', onClick: () => services.ui.openTaskForm(null) }),
        ],
      }),
    });
  }

  return card({
    title: `今天的任务（${todaySessions.length}）`,
    hint: '只显示真实安排；完成情况按实际记录统计',
    flush: true,
    body: el(
      'ul.task-list',
      {},
      todaySessions.map((session) => {
        const task = taskById.get(session.taskId);
        const isDone = session.state === SESSION_STATE.COMPLETED;
        return el('li.task-item', { class: isDone ? 'task-item--done' : null }, [
          el('div.task-item__head', {}, [
            el('div', {}, [
              el('strong', { text: `${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}` }),
              el('span', { text: `　${task?.title ?? '（任务已删除）'}` }),
            ]),
            el('div.task-item__meta', {}, [
              pill(stateText(session), stateKind(session)),
              session.locked ? pill('已锁定', 'locked') : null,
              session.actualMinutes !== null ? pill(`实际 ${formatDuration(session.actualMinutes)}`, 'study') : null,
            ]),
          ]),
          el('div.task-item__actions', {}, [
            button('详情', { size: 'sm', onClick: () => services.ui.openSessionDetail(session.id) }),
            !isDone && session.state !== SESSION_STATE.CANCELLED
              ? button('标记完成', {
                  size: 'sm',
                  variant: 'primary',
                  onClick: async () => {
                    const result = services.ui.previewWith(
                      [{ kind: 'session.complete', sessionId: session.id, actualMinutes: session.plannedMinutes }],
                      { changeSummary: '记录一段已完成的学习', trigger: 'home-page' },
                    );
                    if (!result.ok) toast(result.message, 'error', 8000);
                  },
                })
              : null,
          ]),
          void state,
        ]);
      }),
    ),
  });
}

/* ------------------------------------------------------------------ *
 * 七天概览
 * ------------------------------------------------------------------ */

function renderWeekOverview({ stats, today, plan }) {
  const days = stats.daily({ days: 7 });
  const maxMinutes = Math.max(60, ...days.map((day) => Math.max(day.plannedMinutes, day.actualMinutes)));

  return card({
    title: '最近七天',
    hint: plan ? `正式计划覆盖到 ${plan.windowEnd}` : '还没有正式计划',
    actions: [button('学习统计', { size: 'sm', onClick: () => { globalThis.location.hash = '#/stats'; } })],
    body: el(
      'div.week-bars',
      {},
      days.map((day) => {
        const date = day.date;
        const height = (value) => `${Math.round((value / maxMinutes) * 100)}%`;
        return el('div.week-bars__col', { title: `${date}：计划 ${day.plannedMinutes} 分钟 / 实际 ${day.actualMinutes} 分钟` }, [
          el('div.week-bars__bars', {}, [
            el('div.week-bars__bar.week-bars__bar--planned', { style: { height: height(day.plannedMinutes) } }),
            el('div.week-bars__bar.week-bars__bar--actual', { style: { height: height(day.actualMinutes) } }),
          ]),
          el('div.week-bars__label', { text: date === today ? '今天' : WEEKDAY_NAMES_ZH[weekday(date) - 1] }),
        ]);
      }),
    ),
  });
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function heroActions({ services, plan, activeTasks, running, nextSession, preview }) {
  const actions = [];
  if (preview) {
    actions.push(button('确认该计划', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/preview'; } }));
  }
  if (!plan || plan.version === 0) {
    actions.push(
      button('生成七天计划', {
        variant: 'primary',
        onClick: () => {
          const result = services.ui.requestPreview({ changeSummary: '生成第一份计划', trigger: 'home-hero' });
          if (!result.ok) toast(result.message, 'error', 9000);
        },
      }),
    );
  }
  actions.push(button('新建任务', { onClick: () => services.ui.openTaskForm(null) }));
  void nextSession;
  return actions;
}

function heroSubtitle({ running, nextSession, plan, preview, activeTasks, nowMinutes, taskById }) {
  if (preview) return '候选计划已就绪，确认后才会替换当前安排。';
  if (running) {
    const task = taskById.get(running.taskId);
    const left = Math.max(0, running.endMinutes - nowMinutes);
    return `${task?.title ?? '学习任务'}　还剩约 ${formatDuration(left)}（到 ${formatMinutes(running.endMinutes)}）。`;
  }
  if (nextSession) {
    const minutesUntil = nextSession.startMinutes - nowMinutes;
    return minutesUntil > 0
      ? `${formatMinutes(nextSession.startMinutes)} 开始，还有 ${formatDuration(minutesUntil)}。`
      : `原定 ${formatMinutes(nextSession.startMinutes)} 开始，已经可以开始了。`;
  }
  if (activeTasks.length > 0) {
    return plan && plan.version > 0
      ? `当前计划覆盖 ${plan.windowStart} → ${plan.windowEnd}，今天没有剩下的时段。`
      : `有 ${activeTasks.length} 个待办任务，点右侧「生成七天计划」开始排程。`;
  }
  return '创建任务后，系统会自动排出一份七天学习计划（不使用任何 AI，规则完全可解释）。';
}

function remainingText(task, state) {
  if (!task) return '任务已删除';
  const done = taskCompletedMinutes(task, state);
  const left = Math.max(0, task.plannedMinutes - done);
  return left > 0 ? `还剩 ${formatDuration(left)}` : '已完成全部计划时长';
}

function taskCompletedMinutes(task, state) {
  const sessions = (state.sessions ?? []).filter((session) => session.taskId === task.id && session.state === SESSION_STATE.COMPLETED);
  return sessions.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
}

function stateText(session) {
  if (session.state === SESSION_STATE.COMPLETED) return '已完成';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? '已暂停' : '进行中';
  return '待进行';
}

function stateKind(session) {
  if (session.state === SESSION_STATE.COMPLETED) return 'success';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? 'warning' : 'study';
  return 'neutral';
}

function greeting(minutes) {
  if (minutes < 6 * 60) return '夜深了，注意休息';
  if (minutes < 11 * 60) return '早上好';
  if (minutes < 14 * 60) return '中午好';
  if (minutes < 18 * 60) return '下午好';
  return '晚上好';
}

export { addDays };
