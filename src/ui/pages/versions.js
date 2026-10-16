/**
 * 版本历史页。
 *
 * 计划版本链是"用户已确认的劳动成果"的记录：每次应用新计划都会把上一版完整快照放进历史。
 * 这里让用户能查看每一版的内容差异摘要，并撤销到上一版。
 *
 * 两条安全规则（与 PROJECT_SPEC 一致）：
 * 1. 撤销只回滚**排程**，不回滚"用户已经完成学习"这一事实；若撤销会让新的已完成记录消失，则拒绝。
 * 2. 版本号在撤销后继续递增，不复用旧号，避免版本号指向两份不同的计划。
 */

import { button, card, emptyState, notice, pill, versionTable } from '../components.js';
import { el, toast } from '../dom.js';
import { PLAN_STATUS_LABELS_ZH } from '../../domain/plan.js';
import { formatDuration } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';
import { triggerLabel } from '../labels.js';

export function renderVersions({ app, services }) {
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();
  const history = services.planService.getHistory();
  const preview = services.planService.getPendingPreview();

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '版本历史' }),
        el('p.page-head__sub', {
          text: plan
            ? `当前正式计划 v${plan.version}（${PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status}）· 历史保留 ${history.length} 个版本`
            : '还没有正式计划',
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('撤销上一步', {
          size: 'sm',
          disabled: history.length === 0,
          onClick: () => handleUndo({ services, history }),
        }),
        button('清空历史', {
          size: 'sm',
          variant: 'danger',
          disabled: history.length === 0,
          onClick: () => handleClear({ services, history }),
        }),
      ]),
    ]),
  );

  if (preview) {
    nodes.push(
      notice({
        level: 'warning',
        title: '有未确认的候选计划',
        message: '当前有一份等待确认的候选计划。它还没有生效；应用或放弃之后版本历史才会更新。',
        actions: [button('前往调整预览', { size: 'sm', onClick: () => { globalThis.location.hash = '#/preview'; } })],
      }),
    );
  }

  if (!plan) {
    nodes.push(
      emptyState({
        title: '还没有任何计划版本',
        message: '生成并确认第一份计划后，这里会记录每个版本与变更说明，可随时撤销。',
        actions: [
          button('前往任务列表', { onClick: () => { globalThis.location.hash = '#/tasks'; } }),
          button('生成计划', {
            variant: 'primary',
            onClick: () => {
              const result = services.ui.requestPreview({ changeSummary: '生成第一份计划', trigger: 'versions-page' });
              if (!result.ok) toast(result.message, 'error', 8000);
            },
          }),
        ],
      }),
    );
    return nodes;
  }

  nodes.push(
    card({
      title: '当前正式计划',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '版本' }), el('div.metric__value', { text: `v${plan.version}` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '状态' }), el('div.metric__value', { text: PLAN_STATUS_LABELS_ZH[plan.status] ?? plan.status })]),
          el('div.metric', {}, [el('div.metric__label', { text: '窗口' }), el('div.metric__value', { text: `${plan.windowStart} → ${plan.windowEnd}` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '已排学习' }), el('div.metric__value', { text: formatDuration(plan.metrics?.totalStudyMinutes ?? 0) })]),
          el('div.metric', {}, [el('div.metric__label', { text: '机动缓冲' }), el('div.metric__value', { text: formatDuration(plan.metrics?.bufferReservedMinutes ?? 0) })]),
          el('div.metric', {}, [el('div.metric__label', { text: '未安排' }), el('div.metric__value', { text: String(plan.unscheduled?.length ?? 0) })]),
        ]),
        el('div', { style: { marginTop: 'var(--space-3)' } }, [
          el('div.card__hint', {
            text: `生成时间：${plan.generatedAt ?? '—'}　·　窗口：${plan.windowStart} → ${plan.windowEnd}`,
          }),
        ]),
      ]),
    }),
  );

  if (history.length === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '没有可撤销的历史版本',
        message: '第一份计划之前没有可回退的版本。完成一次"重新规划并应用"之后，这里就会出现可撤销的历史。',
      }),
    );
  } else {
    nodes.push(
      card({
        title: '历史版本',
        hint: `最多保留 ${state.settings.planHistoryLimit ?? 20} 个版本；撤销不回滚已完成的学习记录`,
        body: versionTable(services.planService.listVersions()),
      }),
    );

    nodes.push(
      card({
        title: '每个版本的变更说明',
        flush: true,
        body: el(
          'ul.task-list',
          {},
          history.map((snapshot) =>
            el('li.task-item', {}, [
              el('div.task-item__head', {}, [
                el('div', {}, [
                  el('strong', { text: `v${snapshot.version}` }),
                  el('span', { text: ` · ${snapshot.changeSummary ?? '（未记录变更说明）'}` }),
                ]),
                el('div.task-item__meta', {}, [
                  pill(snapshot.createdAt ?? '—', 'neutral'),
                  pill(triggerLabel(snapshot.trigger), 'neutral'),
                ]),
              ]),
            ]),
          ),
        ),
      }),
    );
  }

  const learningFacts = summarizeLearningFacts(state);
  nodes.push(
    card({
      title: '受保护的学习记录',
      hint: '这些记录在任何撤销或重排中都不会被删除或改回未完成',
      body: el('div.metric-row', {}, [
        el('div.metric', {}, [el('div.metric__label', { text: '已完成时段' }), el('div.metric__value', { text: String(learningFacts.completedCount) })]),
        el('div.metric', {}, [el('div.metric__label', { text: '已记录时长' }), el('div.metric__value', { text: formatDuration(learningFacts.completedMinutes) })]),
        el('div.metric', {}, [el('div.metric__label', { text: '锁定时段' }), el('div.metric__value', { text: String(learningFacts.lockedCount) })]),
        el('div.metric', {}, [el('div.metric__label', { text: '进行中' }), el('div.metric__value', { text: String(learningFacts.runningCount) })]),
      ]),
    }),
  );

  return nodes;
}

async function handleUndo({ services, history }) {
  const target = history[0];
  const confirmed = await confirmDialog({
    title: '撤销上一次计划变更？',
    message: '将把正式计划恢复到上一个版本。已完成的学习记录与锁定时段都会被保留。',
    bullets: [
      `将恢复到 v${target.version}（${target.changeSummary ?? '未记录变更说明'}）`,
      '版本号会继续递增，不会重复使用旧的版本号',
      '若撤销会导致已完成的学习记录从计划中消失，操作会被拒绝',
    ],
    confirmLabel: '确认撤销',
    confirmVariant: 'danger',
  });
  if (!confirmed) return;

  const result = services.ui.undoLastPlan();
  if (!result.ok) {
    toast(result.issues?.[0]?.message ?? '撤销失败。', 'error', 8000);
    return;
  }
  toast(`已撤销：内容恢复为 v${result.restoredFrom}，新版本号 v${result.plan.version}。`, 'success');
}

async function handleClear({ services, history }) {
  const confirmed = await confirmDialog({
    title: '清空版本历史？',
    message: '清空后无法再撤销到更早的计划版本。当前正式计划与所有学习时段不受影响。',
    bullets: [`将删除 ${history.length} 个历史版本快照`, '当前正式计划保持为当前版本', '任务与已完成的学习记录不受影响'],
    confirmLabel: '清空历史',
    confirmVariant: 'danger',
    requireAcknowledge: true,
  });
  if (!confirmed) return;
  const result = services.planService.clearHistory();
  if (!result.ok) return toast(result.error?.message ?? '清空失败。', 'error');
  toast('已清空版本历史。', 'success');
}

/** 统计受保护的学习记录（只读派生） */
function summarizeLearningFacts(state) {
  const sessions = state.sessions ?? [];
  const completed = sessions.filter((session) => session.state === 'completed');
  return {
    completedCount: completed.length,
    completedMinutes: completed.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0),
    lockedCount: sessions.filter((session) => session.locked && session.state !== 'completed').length,
    runningCount: sessions.filter((session) => session.state === 'in_progress').length,
  };
}
