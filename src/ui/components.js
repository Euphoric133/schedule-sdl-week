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
import { issueMessage } from './labels.js';

/** 页面标题区 */
export function pageHead({ title, sub, actions = [] }) {
  return el('header.page-head', {}, [
    el('div', {}, [el('h1', { text: title }), sub ? el('p.page-head__sub', { text: sub }) : null]),
    actions.length > 0 ? el('div.page-head__actions', {}, actions) : null,
  ]);
}

/** 卡片 */
export function card({ title, hint, actions = [], body, flush = false }) {
  return el(`section.card${flush ? '.card--flush' : ''}`, { 'data-glass': '' }, [
    title || hint || actions.length > 0
      ? el('div.card__head', {}, [
          el('div', { style: { minWidth: 0 } }, [
            title ? el('h2.card__title', { text: title, title }) : null,
            hint ? el('div.card__hint', { text: hint }) : null,
          ]),
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
    items.map((item) => el('div.metric', { 'data-glass': '' }, [el('div.metric__label', { text: item.label }), el('div.metric__value', { text: item.value })])),
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
            // 标题会被单行省略，必须给 title 才能看到完整内容
            el('span.task-item__title', { text: task.title, title: task.title }),
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

/* ------------------------------------------------------------------ *
 * 品牌图标（Logo）
 * ------------------------------------------------------------------ */

/**
 * 品牌图标：「七日轨道」。
 *
 * 构成（三个图元，刻意保持极简，20px 下仍可辨）：
 * 1. 一条折线 —— 顶部横笔 + 斜向下的长笔，构成「7」；
 * 2. 一条弧线 —— 从「7」的腰部下方掠过，表示轨道；
 * 3. 一个圆点 —— 轨道上的一颗行星。
 *
 * 为什么用内联 SVG 而不是图片：
 * - 必须跟随主题 Token（深色/浅色/壁纸）变色，图片做不到；
 * - 16–64px 任意缩放都清晰，不引入额外请求；
 * - 单文件构建时无需处理资源内联。
 *
 * 颜色全部用 CSS 变量：主笔画 `currentColor`（由容器设置为主色），
 * 轨道与星点用 `--color-accent`。绝不写死颜色值。
 */
export function brandMark({ size = 24 } = {}) {
  /**
   * 「七日钟」——产品定位是"把七天时间排明白"，所以用**钟表**作主体，
   * 而不是数字 7：数字 7 只说明"七天"，钟表还说明了"时间"。
   *
   * 几何（viewBox 24×24，全部对齐到 0.5 或整数，避免半像素毛边）：
   * - 表盘：圆心 (12,12)、半径 8.6、描边 1.6（= --color-primary）；
   * - 7 个刻度：每 51.43° 一个，从 r5.8 到 r7.4（= --color-accent）。
   *   七个刻度才是"七日"，但只有 ≥24px 才画——16px 下会糊成毛边；
   * - 指针：时针指向 10°（约 12 点过一点）、分针指向 120°（4 点方向），
   *   即 12:20 姿态。这个角度在小尺寸下最容易读成"钟"，不会像对勾；
   * - 中心点：r1.25（= --color-accent），压住两根指针的交点。
   *
   * 颜色全部来自令牌：表盘 --color-primary、指针 currentColor、
   * 刻度与中心点 --color-accent、徽标底 --brand-badge-fill。
   */
  const CENTER = 12;
  const DIAL_R = 8.6;
  /**
   * 刻度半径区间。
   *
   * 早期用 5.8–7.4：贴着表盘内沿，结果**被指针盖住**——
   * 7 等分刻度与 12 点制指针共用同一个圆心，方位必然有重叠
   * （实测 154° 与 309° 两个刻度被时针/分针压掉）。
   *
   * 现在把刻度往外推到 6.9–7.9（表盘半径 8.6），
   * 与指针最外端（6.2）之间留出 0.7 的净空，互不遮挡。
   */
  /**
   * 刻度带 5.6–7.0。
   *
   * 为什么是这个区间：表盘半径 8.6、描边 1.6，线内沿在 7.8；
   * 刻度外端 7.0 加半线宽 0.65 后为 7.65，与表盘还留 0.15 的缝，不压线。
   * 刻度内端 5.6 减半线宽为 4.95，而指针最长 4.2——留出 0.75 净空，
   * 7 个刻度不会被指针挡住。
   */
  const TICK_INNER = 5.6;
  const TICK_OUTER = 7.0;

  /** 钟面角度（0 = 12 点，顺时针）→ 坐标 */
  const pointOnDial = (deg, radius) => {
    const rad = (deg * Math.PI) / 180;
    return [CENTER + Math.sin(rad) * radius, CENTER - Math.cos(rad) * radius];
  };

  const ticks = Array.from({ length: 7 }, (_, index) => {
    const deg = (index * 360) / 7;
    const [x1, y1] = pointOnDial(deg, TICK_INNER);
    const [x2, y2] = pointOnDial(deg, TICK_OUTER);
    return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)}"
      stroke="var(--color-accent)" stroke-width="1.3" stroke-linecap="round" />`;
  }).join('\n  ');

  const hand = (deg, length) => {
    const [x, y] = pointOnDial(deg, length);
    return `<path d="M${CENTER} ${CENTER} L${x.toFixed(2)} ${y.toFixed(2)}"
      stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />`;
  };

  // 徽标底与刻度只在 ≥24px 时绘制，16px 保留最核心的"表盘 + 指针 + 中心点"
  const detailed = size >= 24;

  return el('span.app-brand__mark', {
    html: `
<svg viewBox="0 0 24 24" width="${size}" height="${size}" role="presentation"
     aria-hidden="true" focusable="false" fill="none">
  ${detailed ? '<rect class="brand-badge" x="2" y="2" width="20" height="20" rx="6.5" fill="var(--brand-badge-fill)" />' : ''}
  <circle class="brand-dial" cx="12" cy="12" r="${DIAL_R}"
          stroke="var(--color-primary)" stroke-width="1.6" />
  ${detailed ? ticks : ''}
  <g class="brand-hands">
    ${hand(10, 3.0)}
    ${hand(120, 4.2)}
  </g>
  <circle cx="12" cy="12" r="1.25" fill="var(--color-accent)" />
</svg>`.trim(),
  });
}

/* ------------------------------------------------------------------ *
 * 首页：七天太阳系
 * ------------------------------------------------------------------ */

/**
 * 星点位置（确定性）。
 *
 * 为什么不用 Math.random：首页每次渲染都必须一致，否则切换页面后星图会跳变，
 * 测试也无法稳定断言。这里用固定种子的线性同余生成，输出完全可复现。
 *
 * 三层结构（远景 / 中景 / 近景）是"纵深"的来源：
 * - 远景数量最多、最小、最暗，几乎不闪；
 * - 中景正常闪烁、颜色略有差异；
 * - 近景只有十来颗，最大最亮，带柔和光晕，闪烁更慢。
 *
 * 总量控制在 150 颗左右（规格要求 130–170，不超过 200 个 DOM 节点）。
 */
const STAR_LAYERS = Object.freeze({
  far: { count: 90, min: 0.6, max: 1.2, duration: [9, 12] },
  mid: { count: 50, min: 1.2, max: 2, duration: [7, 10] },
  near: { count: 10, min: 2, max: 3, duration: [6, 8] },
});

/** 三色分布：冷白为主，淡蓝与淡金点缀 */
const STAR_TONES = ['cool', 'cool', 'cool', 'blue', 'blue', 'gold'];

function createSeededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

export function buildStars(seed = 20261030) {
  const next = createSeededRandom(seed);
  const pick = (min, max) => min + next() * (max - min);
  const stars = [];

  for (const [layer, spec] of Object.entries(STAR_LAYERS)) {
    for (let i = 0; i < spec.count; i += 1) {
      stars.push({
        layer,
        tone: STAR_TONES[Math.floor(next() * STAR_TONES.length)],
        x: Number(pick(0, 100).toFixed(2)),
        y: Number(pick(0, 100).toFixed(2)),
        size: Number(pick(spec.min, spec.max).toFixed(2)),
        duration: Number(pick(spec.duration[0], spec.duration[1]).toFixed(1)),
        delay: Number(pick(0, 10).toFixed(2)),
        key: `${layer}-${i}`,
      });
    }
  }
  return stars;
}

/**
 * 星云层（纯装饰）。
 *
 * 用极低透明度的径向渐变做两三个大光斑 + 一条斜向银河带。
 * 全部 CSS 渐变，不引入图片；透明度控制在 4%–10%，保证不压过行星与文字。
 */
function buildNebula() {
  return el('div.solar__nebula', { 'aria-hidden': 'true' }, [
    el('span.solar__nebula-blob.solar__nebula-blob--1'),
    el('span.solar__nebula-blob.solar__nebula-blob--2'),
    el('span.solar__nebula-blob.solar__nebula-blob--3'),
    el('span.solar__galaxy'),
  ]);
}

/**
 * 「七天太阳系」仪表盘。
 *
 * 语义定位：**导航 + 状态总览**，不是装饰动画。
 * 因此每个天体都是真实的 <a>，带可访问名称，键盘可 Tab、可 Enter。
 *
 * 结构（同一份 DOM，靠 CSS 在窄屏切成列表）：
 *   section.solar
 *     ├─ .solar__sky      星点（纯装饰，aria-hidden）
 *     ├─ .solar__orbits   三条椭圆轨道（纯装饰，aria-hidden）
 *     ├─ a.solar__sun     太阳 = 今日总览 → #/home
 *     └─ a.solar__planet × 7
 *
 * @param {{sun: object, planets: object[]}} model buildSolarSystemModel 的产物
 */
export function solarSystem(model) {
  const { sun, planets, orbits = [] } = model;
  const stars = buildStars();

  const sky = el('div.solar__sky', { 'aria-hidden': 'true' }, [
    buildNebula(),
    /* 星点按层分组：CSS 用组选择器控制不同层的亮度与闪烁 */
    ...['far', 'mid', 'near'].map((layer) =>
      el(`div.solar__stars.solar__stars--${layer}`, {}, stars
        .filter((star) => star.layer === layer)
        .map((star) =>
          el(`span.solar__star.solar__star--${star.layer}.solar__star--${star.tone}`, {
            style: {
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              animationDelay: `${star.delay}s`,
              animationDuration: `${star.duration}s`,
            },
          }),
        )),
    ),
  ]);

  /**
   * 轨道尺寸由 SOLAR_ORBITS 驱动（宽度 2rx%、高度 2ry%）。
   *
   * 这是"行星脱离轨道"的根治方式：绘制轨道与计算行星坐标共用同一份数据。
   * 以前样式表里另写了一套百分比，两边一旦不同步，行星就会偏出轨道。
   */
  const orbitLayer = el(
    'div.solar__orbits',
    { 'aria-hidden': 'true' },
    orbits.map((ring, index) =>
      el(`span.solar__orbit.solar__orbit--${index + 1}`, {
        style: { '--orbit-w': `${ring.rx * 2}%`, '--orbit-h': `${ring.ry * 2}%` },
      }),
    ),
  );

  const sunNode = el(
    'a.solar__sun',
    {
      href: sun.route === 'home' ? '#/home' : `#/${sun.route}`,
      'aria-label': sun.ariaLabel,
      title: sun.ariaLabel,
      style: { '--solar-percent': String(sun.percent ?? 0) },
    },
    [
      el('span.solar__sun-halo', { 'aria-hidden': 'true' }),
      el('span.solar__sun-core', {}, [
        el('span.solar__sun-value', { text: sun.value }),
        el('span.solar__sun-caption', { text: '今日' }),
      ]),
      el('span.solar__sun-meta', {}, [
        el('strong', { text: sun.name }),
        el('span', { text: sun.detail }),
      ]),
    ],
  );

  const planetNodes = planets.map((planet) => {
    const children = [el('span.solar__glow', { 'aria-hidden': 'true' })];

    // 土星环 / 天王星环 / 地球月球：必须放在球体**外部**的兄弟元素里，
    // 球体本身 overflow:hidden 会把它们裁掉
    /**
     * 土星环分前后两半：
     * - 后半圈先插入（在球体之前，被球体遮住上半部分）；
     * - 球体；
     * - 前半圈最后插入（盖在球体上，但只保留下半部分，见 CSS 的 clip-path）。
     * 这样环才会"绕到球体背后再绕回前面"，而不是像贴纸一样整圈压在球上。
     */
    if (planet.planet === 'saturn') {
      children.push(el('span.solar__ring.solar__ring--back', { 'aria-hidden': 'true' }));
    }
    if (planet.planet === 'uranus') {
      children.push(el('span.solar__ring.solar__ring--vertical', { 'aria-hidden': 'true' }));
    }

    children.push(el('span.solar__body', { 'aria-hidden': 'true' }));

    if (planet.planet === 'saturn') {
      children.push(el('span.solar__ring.solar__ring--front', { 'aria-hidden': 'true' }));
      // 球体投在环上的阴影
      children.push(el('span.solar__ring-shadow', { 'aria-hidden': 'true' }));
    }

    if (planet.planet === 'earth') {
      children.push(el('span.solar__moon', { 'aria-hidden': 'true' }));
      // 月球轨道弧：很淡的一小段，暗示它在绕地球
      children.push(el('span.solar__moon-orbit', { 'aria-hidden': 'true' }));
    }

    children.push(
      el('span.solar__chip', {}, [
        el('strong.solar__chip-name', { text: planet.name }),
        el('span.solar__chip-value', { text: planet.value }),
        el('span.solar__chip-detail', { text: planet.detail }),
      ]),
    );

    return el(
      `a.solar__planet.solar__planet--${planet.planet}.solar__planet--${planet.size}`,
      {
        href: planet.href,
        'aria-label': planet.ariaLabel,
        title: planet.ariaLabel,
        style: { '--solar-x': `${planet.x}%`, '--solar-y': `${planet.y}%` },
        // 底部行星的 chip 翻到上方，避免超出面板
        ...(planet.flip ? { 'data-flip': 'up' } : {}),
      },
      children,
    );
  });

  return el('section.solar', { 'data-glass': '', 'aria-label': '七天太阳系：今日总览与七个核心模块' }, [
    sky,
    orbitLayer,
    el('div.solar__stage', {}, [sunNode, ...planetNodes]),
  ]);
}
