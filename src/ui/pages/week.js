/**
 * 七天计划页：七天总览时间轴 + 每日统计。
 *
 * 数据来源只有一个：正式计划（services.planService.getOfficialPlan()）。
 * 时间轴上的四类块（学习 / 固定活动 / 休息 / 缓冲）都直接来自计划数据，
 * 本页不做任何独立的排程计算，因此不可能与"今日总览"或"每日视图"产生冲突。
 */

import { button, card, legend, notice, pill, sumByKind, timeline, versionTable } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, dateRange, formatDateWithWeekday, formatDuration } from '../../domain/time.js';
import { PLAN_STATUS, PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';

export function renderWeek({ app, services, route, now }) {
  const state = app.getState();
  const today = now().date;  // 由 shell 注入，保证跨天后日期正确且测试可固定
  const offsetWeeks = Number.parseInt(route.params.get('offset') ?? '0', 10) || 0;
  const windowStart = addDays(today, offsetWeeks * 7);
  const dates = dateRange(windowStart, addDays(windowStart, 6));

  const plan = services.planService.getOfficialPlan();
  const blocksByDate = new Map();
  for (const date of dates) blocksByDate.set(date, []);
  for (const block of plan?.blocks ?? []) {
    if (blocksByDate.has(block.date)) blocksByDate.get(block.date).push(block);
  }
  for (const list of blocksByDate.values()) list.sort((a, b) => a.startMinutes - b.startMinutes);

  const weekMinutes = [...blocksByDate.values()].reduce((sum, list) => sum + sumByKind(list, 'study'), 0);
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '七天计划' }),
        el('p.page-head__sub', {
          text: `${formatDateWithWeekday(dates[0])} → ${formatDateWithWeekday(dates[6])} · 本周已排 ${formatDuration(weekMinutes)}`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button(plan && plan.version > 0 ? '重新规划' : '生成计划', {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            const result = services.ui.requestPreview({
              changeSummary: plan && plan.version > 0 ? '重新规划' : '生成第一份计划',
              trigger: 'week-page',
            });
            if (!result.ok) toast(result.message, 'error', 8000);
          },
        }),
        button('← 上一周', { size: 'sm', onClick: () => gotoWeek(offsetWeeks - 1) }),
        button('回到本周', { size: 'sm', disabled: offsetWeeks === 0, onClick: () => gotoWeek(0) }),
        button('下一周 →', { size: 'sm', onClick: () => gotoWeek(offsetWeeks + 1) }),
      ]),
    ]),
  );

  if (!plan || plan.version === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有正式计划',
        message:
          '下方的时间轴框架已经可用（含小时刻度与四类块的图例）。排程引擎将在阶段 2 完成后把任务、固定活动、计划休息与机动缓冲填入时间轴，并给出可对比的调整预览。',
      }),
    );
  } else if (offsetWeeks !== 0 && plan.windowStart !== windowStart) {
    nodes.push(
      notice({
        level: 'info',
        title: '正式计划没有覆盖这一周',
        message: `正式计划的时间窗口是 ${plan.windowStart} → ${plan.windowEnd}。滚动到新的一周需要重新规划（阶段 3 提供），当前窗口外没有安排。`,
      }),
    );
  }

  nodes.push(
    card({
      title: '七天时间轴',
      hint: `正式计划版本：${plan ? `v${plan.version}` : '无'} · 状态：${plan ? PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status : '—'}`,
      actions: [legend()],
      // 无论有没有计划都渲染时间轴框架：用户需要先看到"时间轴长什么样、有哪些刻度与图例"，
      // 而不是被一个空状态挡住；没有安排时列上会显示"暂无安排"。
      body: timeline({ dates, blocksByDate, today, startHour: 6, endHour: 24, onSelect: (block) => showBlockDetail(block) }),
    }),
  );

  nodes.push(
    card({
      title: '每日统计',
      hint: '缓冲与休息分开统计；可用净容量 = 允许学习时间 − 固定活动 − 已锁定/已完成时段',
      flush: true,
      body: el('div.table-wrap', {}, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '日期' }),
              el('th', { text: '已排学习' }),
              el('th', { text: '计划休息' }),
              el('th', { text: '机动缓冲' }),
              el('th', { text: '固定活动' }),
              el('th', { text: '可用净容量' }),
              el('th', { text: '状态' }),
            ]),
          ]),
          el(
            'tbody',
            {},
            dates.map((date) => {
              const day = plan?.days?.find((d) => d.date === date) ?? null;
              const isToday = date === today;
              return el('tr', {}, [
                el('td', {}, [el('span', { text: formatDateWithWeekday(date) }), isToday ? pill('今天', 'study') : null]),
                el('td', { text: formatDuration(day?.studyMinutes ?? 0) }),
                el('td', { text: formatDuration(day?.restMinutes ?? 0) }),
                el('td', { text: formatDuration(day?.bufferMinutes ?? 0) }),
                el('td', { text: formatDuration(day?.fixedMinutes ?? 0) }),
                el('td', { text: formatDuration(day?.netCapacityMinutes ?? 0) }),
                el('td', {}, [
                  (day?.overloadMinutes ?? 0) > 0
                    ? pill(`超载 ${formatDuration(day.overloadMinutes)}`, 'danger')
                    : pill('正常', 'success'),
                ]),
              ]);
            }),
          ),
        ]),
      ]),
    }),
  );

  const versions = services.planService.listVersions();
  if (versions.length > 0) {
    nodes.push(card({ title: '版本历史', hint: `保留最近 ${state.settings.planHistoryLimit ?? 20} 个版本，可用于撤销`, body: versionTable(versions) }));
  }

  if (plan && plan.unscheduled?.length > 0) {
    nodes.push(
      card({
        title: `未安排的任务（${plan.unscheduled.length} 个）`,
        hint: '无法安排时会如实说明原因，不会生成虚假的可行结果',
        body: el(
          'ul.diag-list',
          {},
          plan.unscheduled.map((item) =>
            el('li.diag-item', {}, [
              el('span.diag-item__code', { text: item.reasonCode ?? 'unknown' }),
              el('span', { text: `${item.taskTitle ?? item.taskId}：剩余 ${formatDuration(item.remainingMinutes ?? 0)}。${item.reasonText ?? ''}` }),
            ]),
          ),
        ),
      }),
    );
  }

  if (plan && plan.status !== PLAN_STATUS.FEASIBLE && plan.version > 0) {
    nodes.push(
      notice({
        level: 'warning',
        title: `计划状态：${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status}`,
        message: '存在无法完全满足的约束。请查看"调整预览"中的具体差异与可选处理方式。',
      }),
    );
  }

  return nodes;
}

function gotoWeek(offset) {
  globalThis.location.hash = offset === 0 ? '#/week' : `#/week?offset=${offset}`;
}

/** 时段详情：阶段 3 会替换为可操作的右侧抽屉（锁定 / 移动 / 缩短） */
function showBlockDetail(block) {
  const host = document.getElementById('toast-host') ?? document.body;
  const node = el('div.notice.notice--info', { role: 'status' }, [
    el('div', {}, [
      el('div.notice__title', { text: `${block.label} · ${block.kind === 'study' ? '学习时段' : '非学习块'}` }),
      el('div', { text: `${block.date} ${String(Math.floor(block.startMinutes / 60)).padStart(2, '0')}:${String(block.startMinutes % 60).padStart(2, '0')} – ${String(Math.floor(block.endMinutes / 60)).padStart(2, '0')}:${String(block.endMinutes % 60).padStart(2, '0')}（${formatDuration(block.endMinutes - block.startMinutes)}）` }),
      el('div', { text: block.locked ? '该时段已锁定：自动重排不会移动、缩短或拆分它。' : '该时段可由系统自动调整。' }),
    ]),
  ]);
  host.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}
