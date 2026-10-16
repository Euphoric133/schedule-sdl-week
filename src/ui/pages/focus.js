/**
 * 专注工作台。
 *
 * 设计原因（对应"基本专注计时功能，不得挤占核心排程开发时间"）：
 * - 计时器只做三件事：显示当前时段、记录实际学习时长、结束时询问剩余工作如何处理。
 * - 任何会改变未来安排的处理方式都**不直接写入**，而是提示需要生成候选计划预览（阶段 3 接入）。
 * - 阶段 1 没有学习时段数据，因此页面明确展示空状态与能力说明，而不是伪造一个计时任务。
 */

import { button, card, emptyState, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { SESSION_STATE } from '../../domain/session.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';

export function renderFocus({ app, services, now }) {
  const today = now().date;
  const nowMinutes = now().minutes;
  const state = app.getState();
  const plan = services.planService.getOfficialPlan();

  const todaySessions = (state.sessions ?? [])
    .filter((s) => s.date === today && s.state !== SESSION_STATE.CANCELLED)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const running = todaySessions.find((s) => s.state === SESSION_STATE.IN_PROGRESS) ?? null;
  const next = todaySessions.find((s) => s.state === SESSION_STATE.FLEXIBLE && s.endMinutes > nowMinutes) ?? null;
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '专注工作台' }),
        el('p.page-head__sub', { text: `当前本地时间 ${formatMinutes(nowMinutes)} · 业务日 ${today}` }),
      ]),
    ]),
  );

  nodes.push(
    notice({
      level: 'info',
      title: '阶段 1 说明',
      message:
        '计时与学习记录的写入接口已经就绪，但"当前时段"来自正式计划中的学习时段；请先完成任务录入，排程引擎完成后（阶段 2/3）本页会自动显示当前任务与剩余时间。',
    }),
  );

  if (!running && !next) {
    nodes.push(
      emptyState({
        title: '今天没有可执行的学习时段',
        message:
          plan && plan.version > 0
            ? '今天的时段可能已全部完成或已取消。可以查看七天计划，或调整可用时间后重新生成计划。'
            : '还没有正式计划。创建任务后，引擎会把任务安排到具体时段，届时这里会显示正在进行的任务。',
        actions: [button('前往任务列表', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/tasks'; } })],
      }),
    );
    return nodes;
  }

  const target = running ?? next;
  const task = (state.tasks ?? []).find((t) => t.id === target.taskId) ?? null;
  const remaining = target.endMinutes - Math.max(nowMinutes, target.startMinutes);

  nodes.push(
    card({
      title: running ? '正在进行' : '下一时段',
      hint: `${target.date} ${formatMinutes(target.startMinutes)} – ${formatMinutes(target.endMinutes)}（计划 ${formatDuration(target.plannedMinutes)}）`,
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '任务' }), el('div.metric__value', { text: task?.title ?? '（任务已不存在）' })]),
          el('div.metric', {}, [el('div.metric__label', { text: '科目' }), el('div.metric__value', { text: task?.subject ?? '—' })]),
          el('div.metric', {}, [el('div.metric__label', { text: '剩余' }), el('div.metric__value', { text: formatDuration(Math.max(0, remaining)) })]),
          el('div.metric', {}, [
            el('div.metric__label', { text: '状态' }),
            el('div.metric__value', {}, [target.locked ? pill('已锁定', 'locked') : pill('可调整', 'neutral')]),
          ]),
        ]),
        running
          ? el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
              button('结束本段并记录实际时长', {
                variant: 'primary',
                onClick: () => finishSession({ target, services, app }),
              }),
            ])
          : el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
              button('开始这一段', {
                variant: 'primary',
                onClick: () => {
                  const result = services.focusService.start(target.id);
                  if (!result.ok) return toast(result.issues?.[0]?.message ?? '无法开始。', 'error');
                  toast('已开始。正在进行中的时段会被自动锁定，避免计划把它移走。', 'success');
                },
              }),
            ]),
      ]),
    }),
  );

  nodes.push(
    card({
      title: '今日全部时段',
      hint: '完成的时段会保留为历史记录，重排时不会重复安排已经完成的工作',
      flush: true,
      body:
        todaySessions.length === 0
          ? el('div', { style: { padding: 'var(--space-4)' } }, [el('div.card__hint', { text: '今天还没有安排任何学习时段。' })])
          : el(
              'ul.task-list',
              {},
              todaySessions.map((session) =>
                el('li.task-item', {}, [
                  el('div.task-item__head', {}, [
                    el('div', {}, [
                      el('strong', { text: `${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}` }),
                      el('span', {
                        text: ` · ${(state.tasks ?? []).find((t) => t.id === session.taskId)?.title ?? '（任务已删除）'}`,
                      }),
                    ]),
                    el('div.task-item__meta', {}, [
                      pill(session.state === SESSION_STATE.COMPLETED ? '已完成' : session.state === SESSION_STATE.IN_PROGRESS ? '进行中' : '待进行', session.state === SESSION_STATE.COMPLETED ? 'success' : 'neutral'),
                      session.locked ? pill('已锁定', 'locked') : null,
                      session.actualMinutes !== null ? pill(`实际 ${formatDuration(session.actualMinutes)}`, 'study') : null,
                    ]),
                  ]),
                ]),
              ),
            ),
    }),
  );

  return nodes;
}

async function finishSession({ target, services, app }) {
  const task = (app.getState().tasks ?? []).find((t) => t.id === target.taskId) ?? null;
  const planned = target.plannedMinutes;
  const confirmed = await confirmDialog({
    title: '结束这一段学习？',
    message: `将记录实际学习时长，并按你的选择处理剩余工作。${task ? `任务「${task.title}」预计 ${formatDuration(task.plannedMinutes)}。` : ''}`,
    bullets: [
      `本段计划时长：${formatDuration(planned)}`,
      '选择"提前完成"表示剩余工作量需要重新安排，系统会生成候选计划等你确认',
      '不会在你确认之前自动覆盖后续安排',
    ],
    confirmLabel: '按计划时长结束',
    confirmVariant: 'primary',
    cancelLabel: '继续学习',
  });
  if (!confirmed) return;

  const result = services.focusService.finish(target.id, { actualMinutes: planned });
  if (!result.ok) return toast(result.issues?.[0]?.message ?? '结束失败。', 'error');
  toast('已记录本段学习。若还有剩余工作量，请前往"调整预览"生成重排候选计划。', 'success', 6000);
}
