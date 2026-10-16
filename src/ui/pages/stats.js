/**
 * 学习统计页。
 *
 * 原则：**只展示真实记录**。没有数据时显示引导说明，而不是画一堆 0 的图表
 * 让人误以为"系统在统计"。每个数字都能追溯到具体的学习时段或番茄记录。
 */

import { barChart, button, card, emptyState, notice, pill, progressBar, shareBars, statTile } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, formatDuration, formatMinutes, weekday } from '../../domain/time.js';

export function renderStats({ app, services, now }) {
  const stats = services.statsService;
  const today = now().date;
  const todayStats = stats.today();
  const weekly = stats.weekly();
  const last14 = stats.daily({ days: 14 });
  const subjects = stats.bySubject();
  const taskStats = stats.tasks();
  const focus = stats.focus({ days: 30 });
  const rewardStats = stats.rewards();
  const hasData = stats.hasAnyData();

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '学习统计' }),
        el('p.page-head__sub', { text: '全部数字来自真实完成的记录；没有记录时不会显示任何估算值。' }),
      ]),
    ]),
  );

  /* ---------- 今日 ---------- */
  nodes.push(
    el('section.home-tiles', {}, [
      statTile({
        label: '今日实际学习',
        value: formatDuration(todayStats.actualMinutes),
        hint: `计划 ${formatDuration(todayStats.plannedMinutes)}　·　完成 ${todayStats.completedSessions}/${todayStats.totalSessions} 段`,
        progress: todayStats.plannedMinutes > 0 ? todayStats.actualMinutes / todayStats.plannedMinutes : 0,
        kind: 'primary',
      }),
      statTile({
        label: '本周实际学习',
        value: formatDuration(weekly.thisWeek.actualMinutes),
        hint:
          weekly.lastWeek.actualMinutes > 0
            ? `上周 ${formatDuration(weekly.lastWeek.actualMinutes)}　·　${deltaText(weekly.thisWeek.actualMinutes - weekly.lastWeek.actualMinutes)}`
            : '上周没有记录，无法比较',
        kind: 'rest',
      }),
      statTile({
        label: '连续学习',
        value: todayStats.streak.current > 0 ? `${todayStats.streak.current} 天` : '—',
        hint: todayStats.streak.activeDays > 0 ? `累计 ${todayStats.streak.activeDays} 天有记录　·　最长 ${todayStats.streak.longest} 天` : '完成第一段学习后开始记录',
        kind: 'buffer',
      }),
      statTile({
        label: '任务完成率',
        value: taskStats.completionRate === null ? '—' : `${Math.round(taskStats.completionRate * 100)}%`,
        hint: `共 ${taskStats.total} 个任务　·　已完成 ${taskStats.completed}　·　进行中 ${taskStats.active}`,
        progress: taskStats.completionRate ?? 0,
        kind: 'locked',
      }),
    ]),
  );

  if (!hasData) {
    nodes.push(
      emptyState({
        title: '还没有可以统计的学习记录',
        message:
          '统计只计算真实完成的时段与番茄钟。你可以先生成一份七天计划，然后在首页或专注页开始第一段学习——完成之后这里就会有数据。',
        actions: [
          button('去生成计划', {
            variant: 'primary',
            onClick: () => {
              const result = services.ui.requestPreview({ changeSummary: '生成计划', trigger: 'stats-page' });
              if (!result.ok) toast(result.message, 'error', 8000);
            },
          }),
          button('开始一段专注', { onClick: () => { globalThis.location.hash = '#/focus'; } }),
        ],
      }),
    );
    return nodes;
  }

  /* ---------- 逐日趋势 ---------- */
  nodes.push(
    card({
      title: '最近 14 天',
      hint: '浅色柱为计划时长，深色柱为实际完成时长',
      body: barChart({
        data: last14.flatMap((day) => [
          { label: day.date, short: `${Number(day.date.slice(8))}`, value: day.plannedMinutes, display: `计划 ${formatDuration(day.plannedMinutes)}`, kind: 'primary' },
          { label: day.date, short: '', value: day.actualMinutes, display: `实际 ${formatDuration(day.actualMinutes)}`, kind: 'rest' },
        ]),
        height: 140,
      }),
    }),
  );

  /* ---------- 本周与上周 ---------- */
  nodes.push(
    card({
      title: '本周对比',
      hint: `${weekly.weekStart} → ${today}`,
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '本周实际' }), el('div.metric__value', { text: formatDuration(weekly.thisWeek.actualMinutes) })]),
          el('div.metric', {}, [el('div.metric__label', { text: '上周实际' }), el('div.metric__value', { text: formatDuration(weekly.lastWeek.actualMinutes) })]),
          el('div.metric', {}, [el('div.metric__label', { text: '本周完成时段' }), el('div.metric__value', { text: `${weekly.thisWeek.completedSessions} 段` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '本周完成番茄' }), el('div.metric__value', { text: `${weekly.thisWeek.pomodoroCompleted} 个` })]),
        ]),
        el('div.card__hint', {
          text:
            weekly.lastWeek.actualMinutes === 0
              ? '上周没有学习记录，因此本周没有可对比的基线。'
              : `相比上周${weekly.thisWeek.actualMinutes >= weekly.lastWeek.actualMinutes ? '增加' : '减少'} ${formatDuration(Math.abs(weekly.thisWeek.actualMinutes - weekly.lastWeek.actualMinutes))}。`,
        }),
      ]),
    }),
  );

  /* ---------- 科目分布 ---------- */
  nodes.push(
    card({
      title: '各科目学习时长（全部历史）',
      hint: subjects.length === 0 ? '还没有完成的学习时段' : `共 ${subjects.length} 个科目`,
      body: shareBars(
        subjects.map((item) => ({ label: item.subject, value: item.minutes, display: formatDuration(item.minutes) })),
        { emptyText: '完成第一段学习后，这里会按科目显示投入时长。' },
      ),
    }),
  );

  /* ---------- 任务情况 ---------- */
  nodes.push(
    card({
      title: '任务情况',
      hint: `共 ${taskStats.total} 个任务，其中 ${taskStats.cancelled} 个已取消`,
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '进行中' }), el('div.metric__value', { text: `${taskStats.active} 个` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '今天到期' }), el('div.metric__value', { text: `${taskStats.dueToday.length} 个` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '已逾期' }), el('div.metric__value', { text: `${taskStats.overdue.length} 个` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '已完成' }), el('div.metric__value', { text: `${taskStats.completed} 个` })]),
        ]),
        taskStats.overdue.length > 0
          ? el('div', { style: { marginTop: 'var(--space-3)' } }, [
              el('div.card__hint', { text: '已逾期任务（需要你重新安排或调整截止时间）：' }),
              el(
                'ul.diag-list',
                {},
                taskStats.overdue.map((item) =>
                  el('li.diag-item', {}, [
                    el('span.diag-item__code', { text: `逾期 ${item.daysLate} 天` }),
                    el('span', { text: `${item.title}：截止 ${item.deadlineDate}，还剩 ${formatDuration(item.remainingMinutes)} 未完成` }),
                  ]),
                ),
              ),
            ])
          : null,
        taskStats.progress.length > 0
          ? el('div', { style: { marginTop: 'var(--space-4)' } }, [
              el('div.card__hint', { text: '各任务进度（按已完成的学习记录统计）：' }),
              ...taskStats.progress
                .sort((a, b) => b.ratio - a.ratio)
                .slice(0, 8)
                .map((item) =>
                  progressBar({
                    value: item.ratio,
                    label: `${item.title}（${item.subject}）`,
                    hint: `已完成 ${formatDuration(item.completedMinutes)} / 计划 ${formatDuration(item.plannedMinutes)}${item.remainingMinutes > 0 ? `　还剩 ${formatDuration(item.remainingMinutes)}` : '　已达标'}`,
                    kind: item.ratio >= 1 ? 'rest' : 'primary',
                  }),
                ),
            ])
          : null,
      ]),
    }),
  );

  /* ---------- 专注情况 ---------- */
  nodes.push(
    card({
      title: '专注与番茄钟（最近 30 天）',
      hint: '区分"完整完成的番茄"与"中途结束"，统计不会把中途结束算成完成',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '完成番茄' }), el('div.metric__value', { text: `${focus.completedRounds} 个` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '提前结束' }), el('div.metric__value', { text: `${focus.earlyEndedRounds} 次` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '专注总时长' }), el('div.metric__value', { text: formatDuration(focus.totalMinutes) })]),
          el('div.metric', {}, [
            el('div.metric__label', { text: '完成率' }),
            el('div.metric__value', { text: focus.completionRate === null ? '—' : `${Math.round(focus.completionRate * 100)}%` }),
          ]),
        ]),
        focus.days.length === 0
          ? el('div.card__hint', { text: '最近 30 天还没有专注记录。到「专注番茄钟」开始一轮试试。' })
          : barChart({
              data: focus.days.map((day) => ({
                label: day.date,
                short: String(Number(day.date.slice(8))),
                value: day.minutes,
                display: `${day.date}：${formatDuration(day.minutes)}（完成 ${day.completed} / 提前结束 ${day.early}）`,
                kind: 'locked',
              })),
              height: 120,
            }),
        focus.byTask.length > 0
          ? el('div', { style: { marginTop: 'var(--space-4)' } }, [
              el('div.card__hint', { text: '专注时间用在了哪些任务上：' }),
              shareBars(
                focus.byTask.slice(0, 6).map((item) => ({ label: item.taskTitle, value: item.minutes, display: formatDuration(item.minutes) })),
                { kind: 'locked' },
              ),
            ])
          : null,
      ]),
    }),
  );

  /* ---------- 奖励 ---------- */
  nodes.push(
    card({
      title: '奖励记录',
      hint: '中奖次数来自真实的抽奖历史',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '累计中奖' }), el('div.metric__value', { text: `${rewardStats.total} 次` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '最近 7 天' }), el('div.metric__value', { text: `${rewardStats.last7Days} 次` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '已确认领取' }), el('div.metric__value', { text: `${rewardStats.claimed} 次` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '不同奖项' }), el('div.metric__value', { text: `${rewardStats.byLabel.length} 种` })]),
        ]),
        rewardStats.byLabel.length === 0
          ? el('div.card__hint', { text: '还没有中奖记录。累积抽奖机会后到「奖励转盘」转转看。' })
          : shareBars(
              rewardStats.byLabel.map((item) => ({ label: item.label, value: item.count, display: `${item.count} 次` })),
              { kind: 'buffer' },
            ),
        el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
          button('去奖励转盘', { size: 'sm', onClick: () => { globalThis.location.hash = '#/rewards'; } }),
        ]),
      ]),
    }),
  );

  /* ---------- 数据说明 ---------- */
  nodes.push(
    notice({
      level: 'info',
      title: '统计口径说明',
      message:
        '「实际学习」= 已标记完成的时段所记录的实际时长（如果你在专注页记录了实际时长，就以它为准）。「完成番茄」= 自然走完整个专注阶段的轮数；中途停止会记为「提前结束」，不计入完成数。逾期任务按截止日期与今天比较得出。',
    }),
  );

  void app;
  void addDays;
  void weekday;
  void formatMinutes;
  void pill;
  return nodes;
}

function deltaText(delta) {
  if (delta === 0) return '与上周持平';
  return delta > 0 ? `比上周多 ${formatDuration(delta)}` : `比上周少 ${formatDuration(-delta)}`;
}
