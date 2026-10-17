/**
 * 调整预览页：排程完成后的**确认步骤**。
 *
 * 用户在这里只做一件事：看清楚"如果应用这份候选计划会发生什么"，然后确认或放弃。
 * 它不是排程入口——排程入口是首页与七天计划页的「生成计划」按钮。
 *
 * 铁律：
 * - 任何操作都不得在用户未确认时修改正式计划；
 * - 「放弃修改」必须零副作用；
 * - 没有变化时明确说"本次无需调整"，而不是给用户一堆毫无意义的 0；
 * - 候选计划与正式计划必须一眼可区分。
 */

import { button, card, emptyState, notice, pill, versionTable } from '../components.js';
import { el, toast } from '../dom.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';
import { PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';
import { confirmDialog } from '../modal.js';
import { reasonLabel } from '../labels.js';

export function renderPreview({ app, services }) {
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();
  const preview = services.planService.getPendingPreview();
  const versions = services.planService.listVersions();
  const unscheduled = services.planService.unscheduledSummary(plan);

  const nodes = [];

  const diff = preview?.diff ?? null;
  const counts = diff?.counts ?? null;
  const changeCount = counts
    ? (counts.added ?? 0) + (counts.moved ?? 0) + (counts.resized ?? 0) + (counts.split ?? 0) + (counts.cancelled ?? 0)
    : 0;

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '调整预览' }),
        el('p.page-head__sub', {
          text: preview
            ? '确认步骤：下面是应用这份候选计划后会发生的变化。确认之前，正式计划不会有任何改动。'
            : '这里显示排程结果供你确认。先到首页或七天计划页点「生成计划」。',
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('重新生成', {
          size: 'sm',
          onClick: () => {
            const result = services.ui.requestPreview({ changeSummary: '重新生成计划', trigger: 'preview-page' });
            if (!result.ok) toast(result.message, 'error', 8000);
          },
        }),
        button('撤销上一步', {
          size: 'sm',
          disabled: versions.filter((version) => !version.current).length === 0,
          onClick: () => handleUndo({ services, versions }),
        }),
      ]),
    ]),
  );

  // 屏幕阅读器提示：候选计划未生效，必须由用户确认
  if (preview) {
    nodes.push(
      el('p.sr-only', { role: 'status', 'aria-live': 'polite' }, [
        `已生成候选计划，基于版本 v${preview.baseVersion}，等待你确认应用或放弃修改。`,
      ]),
    );
  }

  if (!preview) {
    const hasTasks = (state.tasks ?? []).some((task) => task.status === 'not_started' || task.status === 'in_progress');
    nodes.push(
      emptyState({
        title: '当前没有待确认的候选计划',
        message: !hasTasks
          ? '还没有可以安排的学习任务。先到「任务」页新建任务（填好预计用时与截止日期），再回到首页点「生成七天计划」。'
          : plan && plan.version > 0
            ? `正式计划当前为 v${plan.version}（${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status}）。当你新增任务、修改截止时间、移动时段或调整可用时间后，这里会出现候选计划与差异预览。`
            : '已经有任务了。回到首页点「生成七天计划」，这里会显示排程结果与本次的全部变化。',
        actions: !hasTasks
          ? [button('去新建任务', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/tasks'; } })]
          : [
              button('生成七天计划', {
                variant: 'primary',
                onClick: () => {
                  const result = services.ui.requestPreview({ changeSummary: '生成计划', trigger: 'preview-empty' });
                  if (!result.ok) toast(result.message, 'error', 8000);
                },
              }),
              button('查看七天计划', { onClick: () => { globalThis.location.hash = '#/week'; } }),
            ],
      }),
    );
  } else if (changeCount === 0) {
    // 没有变化时不能给用户一堆 0：明确告诉他"无需调整"，并说明这意味着什么
    nodes.push(
      card({
        title: '本次无需调整',
        hint: `候选计划与当前正式计划完全一致（保持不变的时段：${counts?.unchanged ?? 0} 个）`,
        body: el('div', {}, [
          el('p', {
            text: '重新计算之后，所有学习时段与固定活动都与当前正式计划相同，因此没有需要你确认的改动。',
          }),
          el('div.card__hint', {
            text: '如果你期待看到变化，通常是这几个原因：任务本身没有改动、可用时间没有改动、或者改动的部分已经被现有计划满足（例如把截止时间推迟，现有安排本来就更早）。',
          }),
          el('div.form-actions', {}, [
            button('放弃修改', { variant: 'primary', onClick: () => handleDiscard({ services }) }),
            button('仍然应用（生成一个新版本）', { onClick: () => handleApply({ services, preview, changeCount }) }),
          ]),
        ]),
      }),
    );
  } else {
    nodes.push(
      card({
        title: `将发生的调整（${changeCount} 项）`,
        hint: '预览过期后不会被应用，避免用旧数据覆盖新数据',
        body: el('div', {}, [
          el('div.metric-row', {}, [
            el('div.metric', {}, [el('div.metric__label', { text: '候选状态' }), el('div.metric__value', { text: PLAN_STATUS_LABELS_ZH[preview.candidate?.status] ?? '—' })]),
            el('div.metric', {}, [el('div.metric__label', { text: '新增时段' }), el('div.metric__value', { text: String(counts.added ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '移动时段' }), el('div.metric__value', { text: String(counts.moved ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '时长变化' }), el('div.metric__value', { text: String(counts.resized ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '拆分' }), el('div.metric__value', { text: String(counts.split ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '取消时段' }), el('div.metric__value', { text: String(counts.cancelled ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '保持不变' }), el('div.metric__value', { text: String(counts.unchanged ?? 0) })]),
          ]),
          el('div.form-actions', {}, [
            button('放弃修改', { variant: 'ghost', onClick: () => handleDiscard({ services }) }),
            button('确认应用', { variant: 'primary', onClick: () => handleApply({ services, preview, state, changeCount }) }),
          ]),
        ]),
      }),
    );

    // —— 新增时段 ——
    if (diff.added?.length > 0) {
      nodes.push(
        card({
          title: `新增时段（${diff.added.length}）`,
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.added.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: `+ ${item.taskTitle}` })]),
                  el('div.task-item__meta', {}, [
                    pill(`${item.date} ${formatMinutes(item.startMinutes)}–${formatMinutes(item.endMinutes)}`, 'study'),
                    pill(formatDuration(item.minutes), 'neutral'),
                  ]),
                ]),
                el('div.card__hint', { text: `原因：${(item.reasons ?? []).join('；')}` }),
              ]),
            ),
          ),
        }),
      );
    }

    // —— 移动 / 时长变化 / 拆分 / 取消 ——
    if (diff.moved?.length > 0) {
      nodes.push(
        card({
          title: `移动时段（${diff.moved.length}）`,
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.moved.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: `~ ${item.taskTitle}` })]),
                  el('div.task-item__meta', {}, [
                    pill(`${item.from.date} ${formatMinutes(item.from.startMinutes)} → ${item.to.date} ${formatMinutes(item.to.startMinutes)}`, 'warning'),
                  ]),
                ]),
                el('div.card__hint', { text: `原因：${(item.reasons ?? []).join('；')}` }),
              ]),
            ),
          ),
        }),
      );
    }

    if (diff.resized?.length > 0) {
      nodes.push(
        card({
          title: `时长调整（${diff.resized.length}）`,
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.resized.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: `± ${item.taskTitle}` })]),
                  el('div.task-item__meta', {}, [
                    pill(`${formatDuration(item.fromMinutes)} → ${formatDuration(item.toMinutes)}`, item.toMinutes < item.fromMinutes ? 'warning' : 'study'),
                  ]),
                ]),
                el('div.card__hint', { text: `原因：${(item.reasons ?? []).join('；')}` }),
              ]),
            ),
          ),
        }),
      );
    }

    if (diff.split?.length > 0) {
      nodes.push(
        card({
          title: `拆分（${diff.split.length}）`,
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.split.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: `⑂ ${item.taskTitle}` })]),
                  el('div.task-item__meta', {}, [pill(`${formatDuration(item.fromMinutes)} 拆成 ${item.into.length} 段`, 'study')]),
                ]),
                el('div.card__hint', {
                  text: item.into.map((part) => `${part.date} ${formatMinutes(part.startMinutes)}–${formatMinutes(part.endMinutes)}`).join('；'),
                }),
              ]),
            ),
          ),
        }),
      );
    }

    if (diff.cancelled?.length > 0) {
      nodes.push(
        card({
          title: `取消的旧时段（${diff.cancelled.length}）`,
          hint: '这些时段已被新的安排取代，记录会保留为历史',
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.cancelled.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: `− ${item.taskTitle}` })]),
                  el('div.task-item__meta', {}, [pill(`${item.from.date} ${formatMinutes(item.from.startMinutes)}–${formatMinutes(item.from.endMinutes)}`, 'neutral')]),
                ]),
              ]),
            ),
          ),
        }),
      );
    }

    // —— 锁定时段是否受影响 ——
    if (diff.lockedImpact?.length > 0) {
      nodes.push(
        card({
          title: `锁定 / 已完成时段（${diff.lockedImpact.length}）`,
          hint: '锁定是硬约束：自动规划不会移动、缩短或拆分它们',
          flush: true,
          body: el(
            'ul.task-list',
            {},
            diff.lockedImpact.map((item) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('span', { text: item.impact === 'untouched' ? '🔒 ' : '⚠ ' }), el('span', { text: item.message })]),
                  el('div.task-item__meta', {}, [pill(impactLabel(item.impact), item.impact === 'untouched' ? 'success' : 'danger')]),
                ]),
              ]),
            ),
          ),
        }),
      );
    }

    // —— 每日指标变化 ——
    if (diff.dailyDelta?.length > 0) {
      nodes.push(
        card({
          title: '每日学习量与休息变化',
          flush: true,
          body: el('div.table-wrap', {}, [
            el('table', {}, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: '日期' }),
                  el('th', { text: '学习量' }),
                  el('th', { text: '休息' }),
                  el('th', { text: '时段数' }),
                ]),
              ]),
              el(
                'tbody',
                {},
                diff.dailyDelta.map((entry) =>
                  el('tr', {}, [
                    el('td', { text: entry.date }),
                    el('td', { text: `${formatDuration(entry.studyBefore)} → ${formatDuration(entry.studyAfter)}（${signed(entry.studyDelta)}）` }),
                    el('td', { text: `${formatDuration(entry.restBefore)} → ${formatDuration(entry.restAfter)}（${signed(entry.restDelta)}）` }),
                    el('td', { text: `${formatDuration(entry.bufferBefore)} → ${formatDuration(entry.bufferAfter)}（${signed(entry.bufferDelta)}）` }),
                    el('td', { text: signed(entry.sessionDelta) }),
                  ]),
                ),
              ),
            ]),
          ]),
        }),
      );
    }

    // —— 未安排任务与风险 ——
    if (diff.unscheduledAfter?.length > 0) {
      nodes.push(
        card({
          title: `本次仍无法安排的任务（${diff.unscheduledAfter.length}）`,
          hint: '系统会如实说明原因，并给出可选的处理方式',
          body: el(
            'ul.diag-list',
            {},
            diff.unscheduledAfter.map((item) =>
              el('li.diag-item', {}, [
                el('span.diag-item__code', { text: reasonLabel(item.reasonCode) }),
                el('span', { text: `${item.taskTitle ?? '未命名任务'}：剩余 ${formatDuration(item.remainingMinutes ?? 0)}。${item.reasonText ?? ''}` }),
              ]),
            ),
          ),
        }),
      );
    }

    if (preview.risks?.length > 0) {
      nodes.push(
        card({
          title: '截止风险评估',
          hint: '按当前可用容量模拟的最早完成时间与截止时间的比较',
          flush: true,
          body: el(
            'ul.task-list',
            {},
            preview.risks.map((risk) =>
              el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [el('strong', { text: risk.taskTitle }), el('span', { text: ` · 截止 ${risk.deadline.date} ${formatMinutes(risk.deadline.minutes)}` })]),
                  el('div.task-item__meta', {}, [pill(riskLabel(risk.level), riskPillKind(risk.level))]),
                ]),
                el('div.card__hint', { text: risk.message }),
              ]),
            ),
          ),
        }),
      );
    }
  }

  // —— 未安排任务与风险 ——
  if (plan && plan.version > 0) {
    nodes.push(
      card({
        title: '当前正式计划的未安排任务',
        hint: unscheduled.count === 0 ? '没有未安排的任务' : `${unscheduled.count} 个任务未完全安排，共 ${formatDuration(unscheduled.totalMinutes)}`,
        body:
          unscheduled.count === 0
            ? el('div.card__hint', { text: '所有任务都已完整排入计划。' })
            : el(
                'ul.diag-list',
                {},
                (plan.unscheduled ?? []).map((item) =>
                  el('li.diag-item', {}, [
                    el('span.diag-item__code', { text: reasonLabel(item.reasonCode) }),
                    el('span', {
                      text: `${item.taskTitle ?? '未命名任务'}：剩余 ${formatDuration(item.remainingMinutes ?? 0)}。${item.reasonText ?? ''}${
                        item.gapMinutes ? `（缺口 ${formatDuration(item.gapMinutes)}）` : ''
                      }`,
                    }),
                  ]),
                ),
              ),
      }),
    );
  }

  if (versions.length > 0) {
    nodes.push(
      card({
        title: '版本历史',
        hint: `最多保留 ${state.settings.planHistoryLimit ?? 20} 个版本；撤销只回滚排程，不会回滚你已经完成的学习记录`,
        body: versionTable(versions),
      }),
    );
  }

  return nodes;
}

/** 格式化带符号的分钟差，便于在表格里一眼看出增减 */
function signed(minutes) {
  if (!minutes) return '0 分钟';
  return `${minutes > 0 ? '+' : '−'}${formatDuration(Math.abs(minutes))}`;
}

const IMPACT_LABELS = { untouched: '未受影响', moved: '被移动', resized: '被改时长', cancelled: '被移除' };
function impactLabel(impact) {
  return IMPACT_LABELS[impact] ?? impact;
}

const RISK_LABELS = { on_time: '可按期完成', tight: '时间较紧', at_risk: '有逾期风险', impossible: '无法完成' };
function riskLabel(level) {
  return RISK_LABELS[level] ?? level;
}
function riskPillKind(level) {
  if (level === 'on_time') return 'success';
  if (level === 'tight') return 'study';
  return 'danger';
}

async function handleUndo({ services, versions }) {
  const target = versions.find((v) => !v.current);
  const confirmed = await confirmDialog({
    title: '撤销上一次计划变更？',
    message: '将把正式计划恢复到上一个版本。已完成的学习记录、锁定时段都会被保留。',
    bullets: [
      target ? `将恢复到 v${target.version}（${target.summary}）` : '没有可恢复的历史版本',
      '版本号会继续递增，不会重复使用旧的版本号',
      '若撤销会导致已完成的学习记录从计划中消失，操作会被拒绝',
    ],
    confirmLabel: '确认撤销',
    confirmVariant: 'danger',
  });
  if (!confirmed) return;

  const result = services.planService.undoLastApply();
  if (!result.ok) {
    toast(result.issues?.[0]?.message ?? '撤销失败。', 'error', 7000);
    return;
  }
  toast(`已撤销：从 v${result.undoneFrom} 恢复到 v${result.restoredFrom} 的内容（新版本号 v${result.plan.version}）。`, 'success');
}

/**
 * 生成"应用后会发生什么"的人类可读清单。
 *
 * 这里刻意不展示版本号、状态码、指纹等内部信息——用户关心的是
 * "我接下来几天的安排会变成什么样"。
 */
function describeChanges({ preview, state }) {
  const counts = preview.diff?.counts ?? {};
  const bullets = [];

  const sumMinutes = (list) => list.reduce((total, item) => total + ((item.endMinutes ?? 0) - (item.startMinutes ?? 0) || item.minutes || 0), 0);

  if (counts.added) {
    bullets.push(`新增 ${counts.added} 个学习时段${sumMinutes(preview.diff.added ?? []) > 0 ? `，共 ${formatDuration(sumMinutes(preview.diff.added))}` : ''}`);
  }
  if (counts.moved) bullets.push(`移动 ${counts.moved} 个学习时段到新的时间`);
  if (counts.resized) bullets.push(`调整 ${counts.resized} 个学习时段的时长`);
  if (counts.split) bullets.push(`把 ${counts.split} 个较长时段拆成多段`);
  if (counts.cancelled) bullets.push(`取消 ${counts.cancelled} 个不再需要的时段（记录会保留为历史）`);
  if (counts.unchanged) bullets.push(`${counts.unchanged} 个时段保持原样不变`);

  const protectedCount = (state.sessions ?? []).filter(
    (session) => session.state === 'completed' || session.locked === true || session.state === 'in_progress',
  ).length;
  if (protectedCount > 0) {
    bullets.push(`已完成的 ${(state.sessions ?? []).filter((s) => s.state === 'completed').length} 条学习记录、已锁定的 ${(state.sessions ?? []).filter((s) => s.locked && s.state !== 'completed').length} 个时段都会被完整保留`);
  }

  const unscheduled = preview.diff?.unscheduledAfter ?? [];
  if (unscheduled.length > 0) {
    bullets.push(`有 ${unscheduled.length} 个任务这次仍然无法完全安排，预览里会说明原因`);
  }
  const risks = (preview.risks ?? []).filter((risk) => risk.level === 'at_risk' || risk.level === 'impossible');
  if (risks.length > 0) {
    bullets.push(`有 ${risks.length} 个任务存在逾期风险`);
  }
  if (bullets.length === 0) bullets.push('本次没有时段变化，应用后只会生成一个新版本');
  return bullets;
}

async function handleApply({ services, preview, state, changeCount = 0 }) {
  const bullets = describeChanges({ preview, state: state ?? { sessions: [] } });

  const confirmed = await confirmDialog({
    title: changeCount > 0 ? '确认应用这份计划？' : '确认生成一个新版本？',
    message:
      changeCount > 0
        ? '应用后，未来七天的学习安排会按上面的清单更新；当前正式计划会存为一个可以撤销的历史版本。'
        : '本次没有实际变化。应用只会记录一个新版本，计划内容与现在完全相同。',
    bullets,
    confirmLabel: changeCount > 0 ? '确认应用' : '仍然应用',
    confirmVariant: 'primary',
  });
  if (!confirmed) return;

  const result = services.ui.applyPreview();
  if (!result.ok) {
    // 失败原因要说清楚，并且明确告诉用户"数据没有被改动"
    const first = result.issues?.[0];
    const isStale = result.code === 'stale_preview' || /过期|发生变化/.test(first?.message ?? '');
    toast(
      isStale
        ? '这份预览已经过期：等待确认期间数据又变了，因此没有应用。请重新点「生成计划」再确认。'
        : `${first?.message ?? '应用失败'}——正式计划与所有学习记录都没有被改动。`,
      'error',
      9000,
    );
    return;
  }

  toast(
    changeCount > 0
      ? `已应用计划：${changeCount} 项调整生效，可随时在「版本历史」撤销。`
      : '已生成新版本（内容与之前相同）。',
    'success',
    6000,
  );
  globalThis.location.hash = '#/week';
}

async function handleDiscard({ services }) {
  const result = services.ui.discardPreview();
  if (!result.ok) {
    toast(result.issues?.[0]?.message ?? '放弃失败。', 'error');
    return;
  }
  toast('已放弃候选计划，正式计划与所有学习记录没有任何变化。', 'success');
}
