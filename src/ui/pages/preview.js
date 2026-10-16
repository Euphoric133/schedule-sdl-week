/**
 * 调整预览页（产品核心页）。
 *
 * 阶段 1 状态：页面骨架、版本历史与"撤销上一次应用"已可用；
 * 候选计划的**差异明细**（新增/移动/缩短/拆分/取消/不变/锁定影响/每日指标变化）
 * 需要排程引擎（阶段 2）产出 diff 数据后填充，本页已按最终结构预留位置。
 *
 * 铁律：本页任何操作都不得在用户未确认时修改正式计划；
 * "放弃修改"必须是零副作用的操作。
 */

import { button, card, emptyState, notice, versionTable } from '../components.js';
import { el, toast } from '../dom.js';
import { formatDuration } from '../../domain/time.js';
import { PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';
import { confirmDialog } from '../modal.js';

export function renderPreview({ app, services }) {
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();
  const preview = services.planService.getPendingPreview();
  const versions = services.planService.listVersions();
  const unscheduled = services.planService.unscheduledSummary(plan);

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '调整预览' }),
        el('p.page-head__sub', { text: '任何改动都会先生成候选计划，只有你确认后才替换正式计划' }),
      ]),
      el('div.page-head__actions', {}, [
        button('撤销上一步', {
          size: 'sm',
          disabled: versions.filter((v) => !v.current).length === 0,
          onClick: () => handleUndo({ services, versions }),
        }),
      ]),
    ]),
  );

  nodes.push(
    notice({
      level: 'info',
      title: '阶段 1：预览框架已就绪，差异明细待引擎接入',
      message:
        '排程引擎完成后，本页会逐项列出：新增了哪些时段、哪些被移动/缩短/拆分/取消、每项调整的原时间与新时间、调整原因、未受影响的安排、锁定时段是否被影响、每日学习量与休息/缓冲变化、以及无法安排的任务与原因。',
    }),
  );

  if (!preview) {
    nodes.push(
      emptyState({
        title: '当前没有待确认的候选计划',
        message: plan && plan.version > 0
          ? `正式计划为 v${plan.version}（${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status}）。当你新增任务、修改截止时间、移动时段或修改可用时间时，这里会出现候选计划与差异预览。`
          : '还没有正式计划。先创建任务，然后在阶段 2 完成后生成第一份计划。',
        actions: [
          plan && plan.version > 0
            ? button('查看七天计划', { onClick: () => { globalThis.location.hash = '#/week'; } })
            : button('前往任务列表', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/tasks'; } }),
        ],
      }),
    );
  } else {
    nodes.push(
      card({
        title: `候选计划（基于 v${preview.baseVersion}）`,
        hint: '预览过期后不会被应用，避免用旧数据覆盖新数据',
        body: el('div', {}, [
          el('div.metric-row', {}, [
            el('div.metric', {}, [el('div.metric__label', { text: '候选状态' }), el('div.metric__value', { text: PLAN_STATUS_LABELS_ZH[preview.candidate?.status] ?? '—' })]),
            el('div.metric', {}, [el('div.metric__label', { text: '新增时段' }), el('div.metric__value', { text: String(preview.diff?.added?.length ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '移动时段' }), el('div.metric__value', { text: String(preview.diff?.moved?.length ?? 0) })]),
            el('div.metric', {}, [el('div.metric__label', { text: '取消时段' }), el('div.metric__value', { text: String(preview.diff?.cancelled?.length ?? 0) })]),
          ]),
          el('div.form-actions', {}, [
            button('放弃修改', { variant: 'ghost', onClick: () => handleDiscard({ services }) }),
            button('确认应用', { variant: 'primary', onClick: () => handleApply({ services, preview }) }),
          ]),
        ]),
      }),
    );
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
                    el('span.diag-item__code', { text: item.reasonCode ?? 'unknown' }),
                    el('span', {
                      text: `${item.taskTitle ?? item.taskId}：剩余 ${formatDuration(item.remainingMinutes ?? 0)}。${item.reasonText ?? ''}${
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

async function handleDiscard({ services }) {
  const result = services.discardPreview();
  if (!result.ok) {
    toast(result.issues?.[0]?.message ?? '放弃失败。', 'error');
    return;
  }
  toast('已放弃候选计划，正式计划没有任何变化。', 'success');
}

async function handleApply({ services, preview }) {
  const confirmed = await confirmDialog({
    title: '确认应用这份候选计划？',
    message: '应用后正式计划会被替换为候选计划，并保留一个可撤销的历史版本。',
    bullets: [
      `基础版本：v${preview.baseVersion}`,
      `候选状态：${PLAN_STATUS_LABELS_ZH[preview.candidate?.status] ?? '—'}`,
      '已完成的时段会被完整保留，锁定不会被自动更改',
    ],
    confirmLabel: '确认应用',
    confirmVariant: 'primary',
  });
  if (!confirmed) return;
  const result = services.applyPreview();
  if (!result.ok) {
    toast(result.issues?.[0]?.message ?? '应用失败，正式计划未做修改。', 'error', 8000);
    return;
  }
  toast(`已应用计划 v${result.plan.version}。`, 'success');
}
