/**
 * 通用界面组件。
 *
 * 约定：
 * - 组件只接受**数据**并返回 DOM 节点，内部不读取全局状态（便于单独测试与复用）。
 * - 所有面向用户的文案在这一层集中，避免同一句话在多个页面写得不一致。
 */

import { append, clear, el, num } from './dom.js';
import { BLOCK_KIND_LABELS_ZH } from '../domain/calendarBlock.js';
import { formatDuration, formatMinutes, formatDateWithWeekday, weekday as weekdayOf } from '../domain/time.js';

/** 页面标题区 */
export function pageHead({ title, sub, actions = [] }) {
  return el('header.page-head', {}, [
    el('div', {}, [el('h1', { text: title }), sub ? el('p.page-head__sub', { text: sub }) : null]),
    actions.length > 0 ? el('div.page-head__actions', {}, actions) : null,
  ]);
}

/** 卡片 */
export function card({ title, hint, actions = [], body, flush = false }) {
  return el(`section.card${flush ? '.card--flush' : ''}`, {}, [
    title || hint || actions.length > 0
      ? el('div.card__head', {}, [
          el('div', {}, [title ? el('h2.card__title', { text: title }) : null, hint ? el('div.card__hint', { text: hint }) : null]),
          actions.length > 0 ? el('div', { style: { display: 'flex', gap: 'var(--space-2)' } }, actions) : null,
        ])
      : null,
    body ?? null,
  ]);
}

/** 提示条 */
export function notice({ level = 'info', title, message, actions = [] }) {
  return el(`div.notice.notice--${level}`, { role: level === 'danger' ? 'alert' : 'status' }, [
    el('div', { style: { flex: '1 1 auto' } }, [
      title ? el('div.notice__title', { text: title }) : null,
      message ? el('div', { text: message }) : null,
      actions.length > 0 ? el('div', { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' } }, actions) : null,
    ]),
  ]);
}

/** 空状态 / 无可行计划状态 */
export function emptyState({ title, message, actions = [] }) {
  return el('div.state', {}, [
    el('div.state__title', { text: title }),
    message ? el('div', { text: message }) : null,
    actions.length > 0 ? el('div.state__actions', {}, actions) : null,
  ]);
}

/** 按钮 */
export function button(label, { onClick, variant = 'default', size = 'md', disabled = false, title, type = 'button' } = {}) {
  const cls = ['btn'];
  if (variant === 'primary') cls.push('btn--primary');
  if (variant === 'danger') cls.push('btn--danger');
  if (variant === 'ghost') cls.push('btn--ghost');
  if (size === 'sm') cls.push('btn--sm');
  return el('button', { class: cls.join(' '), type, disabled, title, on: onClick ? { click: onClick } : {} }, [label]);
}

/** 状态标签 */
export function pill(text, kind = 'neutral') {
  return el(`span.pill.pill--${kind}`, { text });
}

/** 指标（少量、必要） */
export function metricRow(items) {
  return el(
    'div.metric-row',
    {},
    items.map((item) => el('div.metric', {}, [el('div.metric__label', { text: item.label }), el('div.metric__value', { text: item.value })])),
  );
}

/** 图例 */
export function legend(items = null) {
  const entries =
    items ??
    [
      { kind: 'study', label: '学习任务' },
      { kind: 'fixed', label: '固定任务' },
      { kind: 'rest', label: '休息时间' },
      { kind: 'locked', label: '已锁定' },
    ];
  return el(
    'div.legend',
    {},
    entries.map((entry) =>
      el('span.legend__item', {}, [
        el('span.legend__swatch', {
          style: { background: `var(--color-${entry.kind}-soft)`, borderColor: `var(--color-${entry.kind})` },
        }),
        el('span', { text: entry.label ?? BLOCK_KIND_LABELS_ZH[entry.kind] }),
      ]),
    ),
  );
}

/** 诊断/原因列表 */
export function diagList(items) {
  if (!items || items.length === 0) return null;
  return el(
    'ul.diag-list',
    {},
    items.map((item) =>
      el('li.diag-item', {}, [
        item.code ? el('span.diag-item__code', { text: item.codeLabel ?? '' }) : null,
        el('span', { text: issueMessage(item) }),
      ]),
    ),
  );
}

/** 任务列表 */
export function taskList(items, { renderActions, pomodoros = null, onFocus = null } = {}) {
  if (items.length === 0) return null;
  return el(
    'ul.task-list',
    {},
    items.map(({ task, sessions, remainingMinutes, activeSessions, completedSessions, lockedSessions }) => {
      // 每个任务的具体安排时间：用户最关心的信息之一，直接列出来而不必翻到周视图
      const upcoming = [...(sessions ?? [])]
        .filter((session) => session.state === 'flexible' || session.state === 'in_progress')
        .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1));
      const scheduleText =
        upcoming.length === 0
          ? null
          : `已安排 ${upcoming.length} 段：${upcoming
              .slice(0, 4)
              .map((session) => `${session.date.slice(5)} ${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}`)
              .join('　')}${upcoming.length > 4 ? `　…还有 ${upcoming.length - 4} 段` : ''}`;

      return el('li.task-item', {}, [
        el('div.task-item__head', {}, [
          el('div', {}, [
            el('span.task-item__title', { text: task.title }),
            el('span', { text: ` · ${task.subject}` }),
          ]),
          el('div.task-item__meta', {}, [
            pill(`预计 ${formatDuration(task.plannedMinutes)}`, 'neutral'),
            pill(`剩余 ${formatDuration(remainingMinutes)}`, remainingMinutes > 0 ? 'warning' : 'success'),
            task.priorCompletedMinutes > 0 ? pill(`已完成 ${formatDuration(task.priorCompletedMinutes)}`, 'study') : null,
            pill(`截止 ${task.deadlineDate} ${task.deadlineTime}`, 'neutral'),
            activeSessions > 0 ? pill(`待进行 ${activeSessions} 段`, 'study') : null,
            completedSessions > 0 ? pill(`已完成 ${completedSessions} 段`, 'success') : null,
            // 花园里已经完成的番茄数（来自专注花园的真实记录，读不到时不显示）
            pomodoros && pomodoros[task.id] > 0 ? pill(`🍅 ${pomodoros[task.id]}`, 'success') : null,
            lockedSessions > 0 ? pill(`锁定 ${lockedSessions} 段`, 'locked') : null,
          ]),
        ]),
        scheduleText ? el('div.card__hint', { text: scheduleText }) : null,
        el('div.task-item__actions', {}, [
          // 「专注」：把这个任务同步进花园并自动开始计时
          onFocus ? button('专注', { size: 'sm', onClick: () => onFocus(task) }) : null,
          renderActions ? renderActions({ task }) : null,
        ]),
      ]);
    }),
  );
}

/** 版本历史表 */

export function versionTable(rows) {
  return el('div.table-wrap', {}, [
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [el('th', { text: '版本' }), el('th', { text: '生成时间' }), el('th', { text: '说明' }), el('th', { text: '状态' })]),
      ]),
      el(
        'tbody',
        {},
        rows.map((row) =>
          el('tr', {}, [
            el('td', { text: `v${row.version}` }),
            el('td', { text: row.createdAt ?? '—' }),
            el('td', { text: row.summary }),
            el('td', {}, [row.current ? pill('当前', 'success') : pill('历史', 'neutral')]),
          ]),
        ),
      ),
    ]),
  ]);
}

/** 统计某天块时长的小工具（UI 内部使用，与 domain 层统计口径一致） */
export function sumByKind(blocks, kind) {
  return blocks.filter((b) => b.kind === kind).reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
}

export { clear, num, formatDuration, formatMinutes, weekdayOf };

/* ------------------------------------------------------------------ *
 * 统计与进度组件（首页、统计页共用）
 * ------------------------------------------------------------------ */

/**
 * 进度条。
 *
 * 无障碍：使用 role="progressbar" 并给出 aria-valuenow/min/max，
 * 屏幕阅读器能读到真实进度，而不是只看到一个彩色方块。
 */
export function progressBar({ value = 0, label = null, hint = null, kind = 'primary', showValue = false } = {}) {
  const clamped = Math.min(1, Math.max(0, Number(value) || 0));
  const percent = Math.round(clamped * 100);
  return el('div.progress', {}, [
    label || showValue
      ? el('div.progress__head', {}, [
          label ? el('span.progress__label', { text: label }) : el('span'),
          showValue ? el('span.progress__value', { text: `${percent}%` }) : null,
        ])
      : null,
    el(
      'div.progress__track',
      {
        role: 'progressbar',
        'aria-valuenow': String(percent),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': label ?? '进度',
      },
      [el(`div.progress__fill.progress__fill--${kind}`, { style: { width: `${percent}%` } })],
    ),
    hint ? el('div.progress__hint', { text: hint }) : null,
  ]);
}

/**
 * 统计磁贴：一个主数字 + 一句解释 + 可选进度条。
 * 允许作为按钮使用（onClick 存在时）以便跳转到详情页。
 */
export function statTile({ label, value, hint, progress = null, kind = 'primary', onClick = null } = {}) {
  const content = [
    el('div.stat-tile__label', { text: label }),
    el('div.stat-tile__value', { text: value }),
    hint ? el('div.stat-tile__hint', { text: hint }) : null,
    progress !== null && progress !== undefined ? progressBar({ value: progress, kind }) : null,
  ];
  if (onClick) {
    return el('button.stat-tile.stat-tile--button', { type: 'button', on: { click: onClick } }, content);
  }
  return el('div.stat-tile', {}, content);
}

/** 横向占比条（科目分布等），带真实数值 */
export function shareBars(items, { total = null, emptyText = '还没有数据', kind = 'primary' } = {}) {
  if (!items || items.length === 0) {
    return el('div.card__hint', { text: emptyText });
  }
  const sum = total ?? items.reduce((accumulator, item) => accumulator + item.value, 0);
  const max = Math.max(...items.map((item) => item.value), 1);
  return el(
    'ul.share-bars',
    {},
    items.map((item) =>
      el('li.share-bars__row', {}, [
        el('div.share-bars__head', {}, [
          el('span.share-bars__label', { text: item.label }),
          el('span.share-bars__value', {
            text: sum > 0 ? `${item.display ?? item.value}（${Math.round((item.value / sum) * 100)}%）` : String(item.display ?? item.value),
          }),
        ]),
        el('div.share-bars__track', {}, [
          el(`div.share-bars__fill.share-bars__fill--${kind}`, { style: { width: `${Math.round((item.value / max) * 100)}%` } }),
        ]),
      ]),
    ),
  );
}

/**
 * 逐日柱状图。
 *
 * 这里修过一个视觉问题：以前每天画**两根并排的柱子**（计划 / 实际），
 * 14 天就是 28 根，宽度只有一点、标签还只标一半，于是看起来"一高一低、参差不齐"，
 * 既读不出趋势，也分不清每根柱子代表什么。
 *
 * 现在的规则（每一点都能解释清楚）：
 * - **一天一根柱子**，柱子高度 = 当天**实际**学习时长（唯一的统计口径）；
 * - 当天**计划**时长用同一列背后的浅色轨道表示（同一单位、同一坐标，不并列、不误导）；
 * - 纵轴按真实数据的"整数刻度"缩放（15/30/60 分钟一档），并在左上角标出上限；
 * - 0 分钟与"没有数据"区分：0 显示一条基线短划，无数据的那天没有任何柱子；
 * - 每根柱子都有完整标签与 title，窄屏下只显示少量日期标签，避免文字重叠。
 */

/** 把最大值向上取整到一个"好看的刻度"，避免纵轴出现 47 分钟这种数字 */
function niceCeil(value, step) {
  if (!Number.isFinite(value) || value <= 0) return step;
  return Math.ceil(value / step) * step;
}

function pickAxisStep(peakMinutes) {
  if (peakMinutes <= 60) return 15;
  if (peakMinutes <= 180) return 30;
  if (peakMinutes <= 360) return 60;
  return 120;
}

/**
 * @param {object} options
 * @param {Array<{date: string, label?: string, short?: string, actualMinutes: number, plannedMinutes: number, hasData?: boolean}>} options.days
 * @param {number} [options.height] 绘图区高度（px）
 */
export function barChart({ days, height = 150, emptyText = '还没有可以统计的数据' } = {}) {
  if (!Array.isArray(days) || days.length === 0) return el('div.card__hint', { text: emptyText });

  const hasAny = days.some((day) => (day.actualMinutes ?? 0) > 0 || (day.plannedMinutes ?? 0) > 0);
  if (!hasAny) return el('div.card__hint', { text: emptyText });

  const peak = Math.max(...days.map((day) => Math.max(day.actualMinutes ?? 0, day.plannedMinutes ?? 0)));
  const axisMax = niceCeil(peak, pickAxisStep(peak));
  const heightPercent = (value) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(2, Math.round((value / axisMax) * 100));
  };

  // 标签太密时（>10 天）只保留每隔一天的日期，避免文字重叠
  const labelStride = days.length > 10 ? 2 : 1;

  return el('div.chart-figure', {}, [
    el('div.chart-figure__axis', { text: `纵轴：分钟（上限 ${axisMax}）` }),
    el(
      'div.chart',
      { style: { height: `${height}px` } },
      days.map((day, index) => {
        const actual = Math.max(0, day.actualMinutes ?? 0);
        const planned = Math.max(0, day.plannedMinutes ?? 0);
        const showLabel = index % labelStride === 0 || index === days.length - 1;
        const tip = `${day.date}：实际 ${formatDuration(actual)}${planned > 0 ? `　·　计划 ${formatDuration(planned)}` : ''}`;
        return el(
          'div.chart__col',
          { title: tip, 'aria-label': tip },
          [
            // 计划时长：同一列背后的浅色轨道（同一坐标，不与实际并列）
            planned > 0
              ? el('div.chart__track', { style: { height: `${heightPercent(planned)}%` } })
              : null,
            actual > 0
              ? el('div.chart__bar', { style: { height: `${heightPercent(actual)}%` } })
              : el('div.chart__zero', { title: `${day.date}：没有已完成的学习` }),
            el('div.chart__label', { text: showLabel ? (day.short ?? day.label ?? '') : '' }),
          ].filter(Boolean),
        );
      }),
    ),
    el('div.chart-legend', {}, [
      el('span.chart-legend__item', {}, [el('span.chart-legend__swatch.chart-legend__swatch--bar'), el('span', { text: '实际学习时长' })]),
      el('span.chart-legend__item', {}, [el('span.chart-legend__swatch.chart-legend__swatch--track'), el('span', { text: '当天计划时长' })]),
      el('span.chart-legend__item', {}, [el('span.chart-legend__swatch.chart-legend__swatch--zero'), el('span', { text: '当天没有完成的学习' })]),
    ]),
  ]);
}
