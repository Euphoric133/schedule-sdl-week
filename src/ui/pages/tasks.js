/**
 * 任务列表页。
 *
 * 阶段 1 已可用：查看任务库、按状态/科目/截止筛选、切换排序、完成 / 取消 / 恢复 / 删除
 * （删除前必须展示真实影响面：会取消几段、共多少分钟、是否影响依赖它的任务）。
 *
 * 阶段 3 补充：新建与编辑表单（模态）、拖拽排序、以及"修改任务后先生成候选计划预览"。
 * 本页目前对任务的修改是立即生效的——这一点在 CHANGELOG 的"已知限制"中明确标注，
 * 避免用户误以为已经过预览确认。
 */

import { button, card, emptyState, notice, taskList } from '../components.js';
import { el, toast } from '../dom.js';
import { TASK_STATUS } from '../../domain/task.js';
import { formatDuration } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';

const STATUS_LABELS = {
  [TASK_STATUS.NOT_STARTED]: '未开始',
  [TASK_STATUS.IN_PROGRESS]: '进行中',
  [TASK_STATUS.COMPLETED]: '已完成',
  [TASK_STATUS.CANCELLED]: '已取消',
  [TASK_STATUS.DELETED]: '已删除',
};

export function renderTasks({ app, services, route }) {
  const statusFilter = route.params.get('status') ?? 'active';
  const subjectFilter = route.params.get('subject') ?? '';
  const includeDeleted = statusFilter === 'deleted' || statusFilter === 'all';
  const sort = route.params.get('sort') === 'created' ? 'created' : 'deadline';

  const allViews = services.taskService.listTaskViews({ includeDeleted: true, sort });
  const subjects = [...new Set(allViews.map((v) => v.task.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  let views = allViews;
  if (statusFilter === 'active') views = views.filter((v) => v.task.status === TASK_STATUS.NOT_STARTED || v.task.status === TASK_STATUS.IN_PROGRESS);
  else if (statusFilter === 'completed') views = views.filter((v) => v.task.status === TASK_STATUS.COMPLETED);
  else if (statusFilter === 'cancelled') views = views.filter((v) => v.task.status === TASK_STATUS.CANCELLED);
  else if (statusFilter === 'deleted') views = views.filter((v) => v.task.status === TASK_STATUS.DELETED);
  if (subjectFilter) views = views.filter((v) => v.task.subject === subjectFilter);

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '任务列表' }),
        el('p.page-head__sub', {
          text: `共 ${allViews.length} 个任务（待安排 ${allViews.filter((v) => v.task.status === TASK_STATUS.NOT_STARTED || v.task.status === TASK_STATUS.IN_PROGRESS).length} 个）· 剩余工作量 ${formatDuration(views.reduce((s, v) => s + v.remainingMinutes, 0))}`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('新建任务', {
          variant: 'primary',
          onClick: () =>
            services.ui.openTaskForm(null),
        }),
      ]),
    ]),
  );

  nodes.push(
    notice({
      level: 'info',
      title: '所有改动都会先生成预览',
      message:
        '新建、编辑、完成、取消、删除任务都会先生成"候选计划 + 差异预览"，只有你确认后才写入数据。放弃预览时任务与计划都保持不变。',
    }),
  );

  nodes.push(
    card({
      title: '筛选与排序',
      body: el('div.grid-3', {}, [
        field('状态', selectInput({
          value: statusFilter,
          options: [
            { value: 'active', label: '待安排（未开始 / 进行中）' },
            { value: 'completed', label: '已完成' },
            { value: 'cancelled', label: '已取消' },
            { value: 'deleted', label: '已删除' },
            { value: 'all', label: '全部' },
          ],
          onChange: (value) => updateQuery({ status: value }),
        })),
        field('科目', selectInput({
          value: subjectFilter,
          options: [{ value: '', label: '全部科目' }, ...subjects.map((s) => ({ value: s, label: s }))],
          onChange: (value) => updateQuery({ subject: value }),
        })),
        field('排序', selectInput({
          value: sort,
          options: [
            { value: 'deadline', label: '按截止时间（含 ID 兜底，结果稳定）' },
            { value: 'created', label: '按创建时间' },
          ],
          onChange: (value) => updateQuery({ sort: value }),
        })),
      ]),
    }),
  );

  nodes.push(
    card({
      title: '任务',
      hint: views.length === 0 ? '当前筛选条件下没有任务' : `显示 ${views.length} 个任务`,
      flush: views.length > 0,
      body:
        views.length === 0
          ? emptyState({
              title: '这里还没有任务',
              message:
                allViews.length === 0
                  ? '创建第一个学习任务：填写名称、科目、预计用时和截止时间，引擎接入后即可自动安排到七天计划中。'
                  : '试试把筛选条件改成"全部"，或清空科目筛选。',
              actions: [button('新建任务', { variant: 'primary', onClick: () => services.ui.openTaskForm(null) })],
            })
          : taskList(views, {
              renderActions: ({ task }) => actionButtons(task, { app, services }),
            }),
    }),
  );

  return nodes;
}

function actionButtons(task, { services }) {
  const isActive = task.status === TASK_STATUS.NOT_STARTED || task.status === TASK_STATUS.IN_PROGRESS;
  const buttons = [];

  if (task.status === TASK_STATUS.DELETED) {
    buttons.push(
      button('恢复', {
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith([{ kind: 'task.status', taskId: task.id, to: TASK_STATUS.NOT_STARTED }], {
            changeSummary: `恢复任务「${task.title}」`,
            trigger: 'tasks-page',
          });
          if (!result.ok) toast(result.message, 'error', 8000);
        },
      }),
    );
    return buttons;
  }

  buttons.push(button('编辑', { size: 'sm', onClick: () => services.ui.openTaskForm(task.id) }));

  if (isActive) {
    buttons.push(
      button('标记完成', {
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith([{ kind: 'task.status', taskId: task.id, to: TASK_STATUS.COMPLETED }], {
            changeSummary: `完成任务「${task.title}」`,
            trigger: 'tasks-page',
          });
          if (!result.ok) toast(result.message, 'error', 8000);
        },
      }),
    );
    buttons.push(
      button('取消任务', {
        size: 'sm',
        onClick: async () => {
          const evaluated = services.taskService.evaluateTaskImpact(task.id);
          if (!evaluated.ok) return toast(evaluated.issues[0].message, 'error');
          const confirmed = await confirmDialog({
            title: `取消任务「${task.title}」？`,
            message: '取消后该任务不再参与排程；已完成的学习记录会保留。确认后会先生成候选计划预览。',
            bullets: [
              `将取消 ${evaluated.impact.activeSessions} 个待进行的学习时段（共 ${formatDuration(evaluated.impact.activeMinutes)}）`,
              `已完成的 ${evaluated.impact.completedSessions} 个时段会完整保留`,
              evaluated.impact.dependents.length > 0
                ? `有 ${evaluated.impact.dependents.length} 个任务依赖它：${evaluated.impact.dependents.map((item) => item.title).join('、')}`
                : '没有其它任务依赖它',
            ],
            confirmLabel: '取消任务并生成预览',
            confirmVariant: 'danger',
          });
          if (!confirmed) return;
          const result = services.ui.previewWith([{ kind: 'task.status', taskId: task.id, to: TASK_STATUS.CANCELLED }], {
            changeSummary: `取消任务「${task.title}」`,
            trigger: 'tasks-page',
          });
          if (!result.ok) toast(result.message, 'error', 8000);
        },
      }),
    );
  } else if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED) {
    buttons.push(
      button('恢复为未开始', {
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith([{ kind: 'task.status', taskId: task.id, to: TASK_STATUS.NOT_STARTED }], {
            changeSummary: `恢复任务「${task.title}」为未开始`,
            trigger: 'tasks-page',
          });
          if (!result.ok) toast(result.message, 'error', 8000);
        },
      }),
    );
  }

  buttons.push(
    button('删除', {
      size: 'sm',
      variant: 'danger',
      onClick: async () => {
        const evaluated = services.taskService.evaluateTaskImpact(task.id);
        if (!evaluated.ok) return toast(evaluated.issues[0].message, 'error');
        const impact = evaluated.impact;
        const confirmed = await confirmDialog({
          title: `删除任务「${task.title}」？`,
          message: impact.message,
          bullets: [
            impact.totalSessions === 0
              ? '该任务没有任何学习记录，确认后会彻底删除（可提前导出备份）'
              : `将取消 ${impact.activeSessions} 个待进行时段（${formatDuration(impact.activeMinutes)}）`,
            impact.completedSessions > 0 ? `${impact.completedSessions} 个已完成的学习记录会保留（作为历史）` : '没有已完成的学习记录',
            impact.lockedSessions > 0 ? `其中 ${impact.lockedSessions} 个时段处于锁定状态，锁定也会一并解除` : '没有锁定的时段',
            impact.dependents.length > 0
              ? `${impact.dependents.length} 个任务依赖它，删除后这些任务将无法安排`
              : '没有其它任务依赖它',
            '确认后会先生成候选计划预览，你可以看到具体影响再决定是否应用',
          ],
          confirmLabel: '删除并生成预览',
          confirmVariant: 'danger',
          requireAcknowledge: impact.canHardDelete,
        });
        if (!confirmed) return;
        const result = services.ui.previewWith(
          [{ kind: 'task.delete', taskId: task.id, hard: impact.canHardDelete }],
          { changeSummary: `删除任务「${task.title}」`, trigger: 'tasks-page' },
        );
        if (!result.ok) toast(result.message, 'error', 8000);
      },
    }),
  );

  return buttons;
}

function field(labelText, control, hint) {
  return el('div.form-field', {}, [el('label', { text: labelText }), control, hint ? el('div.form-field__hint', { text: hint }) : null]);
}

function selectInput({ value, options, onChange }) {
  const select = el('select', { on: { change: (event) => onChange(event.target.value) } });
  for (const option of options) {
    select.appendChild(el('option', { value: option.value, selected: option.value === value, text: option.label }));
  }
  return select;
}

function updateQuery(patch) {
  const params = new URLSearchParams(globalThis.location.hash.split('?')[1] ?? '');
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  globalThis.location.hash = `#/tasks${query ? `?${query}` : ''}`;
}

export { STATUS_LABELS };
