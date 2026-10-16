/**
 * 专注工作台：真实可用的学习计时循环。
 *
 * 设计边界（务必保持）：
 * - 计时只负责**记录事实**（我学了多久），不负责"重新安排未来"。
 *   结束时的任何"改变后续安排"选项都会先生成候选计划预览，确认后才生效。
 * - 计时状态（开始时间 / 是否暂停 / 已累计分钟）都属于数据，走 `focusService` 持久化，
 *   因此刷新页面后能继续，而不是回到零。
 * - 页面只负责显示与刷新（由外壳在数据变化时重绘），不把计时数据放在临时变量里当唯一来源。
 */

import { button, card, emptyState, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { SESSION_STATE } from '../../domain/session.js';
import { TASK_STATUS } from '../../domain/task.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';

export function renderFocus({ app, services, now }) {
  const state = app.getState();
  const today = now().date;
  const nowMinutes = now().minutes;
  const plan = services.planService.getOfficialPlan();

  const todaySessions = (state.sessions ?? [])
    .filter((session) => session.date === today && session.state !== SESSION_STATE.CANCELLED)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const running = todaySessions.find((session) => session.state === SESSION_STATE.IN_PROGRESS) ?? null;
  const next = todaySessions.find((session) => session.state === SESSION_STATE.FLEXIBLE && session.endMinutes > nowMinutes) ?? null;
  const target = running ?? next;

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '专注工作台' }),
        el('p.page-head__sub', {
          text: `当前本地时间 ${formatMinutes(nowMinutes)} · 业务日 ${today}${plan ? ` · 计划 v${plan.version}` : ' · 尚未生成计划'}`,
        }),
      ]),
    ]),
  );

  if (!target) {
    const finishedToday = todaySessions.filter((session) => session.state === SESSION_STATE.COMPLETED);
    nodes.push(
      emptyState({
        title: '今天没有可执行的学习时段',
        message:
          finishedToday.length > 0
            ? `今天的时段都已完成（${finishedToday.length} 段，共 ${formatDuration(
                finishedToday.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0),
              )}）。可以查看七天计划，或调整可用时间后重新规划。`
            : plan && plan.version > 0
              ? '今天没有安排学习时段。可以查看七天计划，或到偏好设置延长这一天的时间后重新规划。'
              : '还没有正式计划。先创建任务，然后点"生成七天计划"。',
        actions: [
          button('查看七天计划', { onClick: () => { globalThis.location.hash = '#/week'; } }),
          button('前往任务列表', { variant: 'primary', onClick: () => { globalThis.location.hash = '#/tasks'; } }),
        ],
      }),
    );
    return nodes;
  }

  const task = (state.tasks ?? []).find((item) => item.id === target.taskId) ?? null;
  const remainingTaskMinutes = task ? services.focusService.remainingMinutes(task.id) : 0;

  nodes.push(renderTimerCard({ app, target, task, now, services, remainingTaskMinutes }));
  nodes.push(renderTodayList({ todaySessions, services, now }));

  if (running) {
    nodes.push(
      notice({
        level: 'info',
        title: '计时进行中',
        message:
          '开始学习后该时段会被自动锁定（自动规划不会把它移走）。刷新页面后，计时会从已累计的分钟数继续。',
      }),
    );
  }

  return nodes;
}

/* ------------------------------------------------------------------ *
 * 计时卡片
 * ------------------------------------------------------------------ */

function renderTimerCard({ app, target, task, now, services, remainingTaskMinutes }) {
  const running = target.state === SESSION_STATE.IN_PROGRESS;
  const paused = Boolean(target.paused);
  const elapsed = computeElapsedMinutes(target, now);
  const planned = target.plannedMinutes;
  const left = Math.max(0, planned - elapsed);

  const timerText = el('div.metric__value', {
    text: formatDuration(left),
    style: { fontSize: 'var(--font-size-xl)', fontVariantNumeric: 'tabular-nums' },
  });
  const elapsedText = el('div.card__hint', {
    text: running
      ? `已专注 ${formatDuration(elapsed)}${paused ? '（已暂停）' : ''} · 计划 ${formatDuration(planned)}`
      : `尚未开始 · 计划 ${formatDuration(planned)}（${formatMinutes(target.startMinutes)}–${formatMinutes(target.endMinutes)}）`,
  });

  const actions = [];
  if (!running) {
    actions.push(
      button('开始这一段', {
        variant: 'primary',
        onClick: () => {
          const result = services.focusService.start(target.id);
          if (!result.ok) return toast(result.issues?.[0]?.message ?? '无法开始。', 'error');
          toast('已开始计时。进行中的时段会被自动锁定，避免计划把它移走。', 'success');
        },
      }),
    );
  } else {
    actions.push(
      button(paused ? '继续计时' : '暂停', {
        onClick: () => {
          const result = paused
            ? services.focusService.resume(target.id, { elapsedMinutes: elapsed })
            : services.focusService.pause(target.id, { elapsedMinutes: elapsed });
          if (!result.ok) return toast(result.issues?.[0]?.message ?? '操作失败。', 'error');
        },
      }),
    );
    actions.push(
      button('结束本段…', {
        variant: 'primary',
        onClick: () => openFinishDialog({ target, elapsed, services }),
      }),
    );
  }

  return card({
    title: running ? (paused ? '已暂停' : '正在专注') : '下一时段',
    hint: `${task?.title ?? '（任务已不存在）'} · ${task?.subject ?? '—'}`,
    body: el('div', {}, [
      el('div.metric-row', {}, [
        el('div.metric', {}, [
          el('div.metric__label', { text: running ? '剩余时间' : '计划时长' }),
          timerText,
          elapsedText,
        ]),
        el('div.metric', {}, [
          el('div.metric__label', { text: '计划时段' }),
          el('div.metric__value', { text: `${formatMinutes(target.startMinutes)}–${formatMinutes(target.endMinutes)}` }),
        ]),
        el('div.metric', {}, [
          el('div.metric__label', { text: '任务剩余' }),
          el('div.metric__value', { text: formatDuration(remainingTaskMinutes) }),
        ]),
        el('div.metric', {}, [
          el('div.metric__label', { text: '状态' }),
          el('div.metric__value', {}, [pill(target.locked ? '已锁定' : '可调整', target.locked ? 'locked' : 'neutral')]),
        ]),
      ]),
      el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, actions),
      el('div.card__hint', {
        text: planHint(app, running),
      }),
    ]),
  });
}

function planHint(app, running) {
  const plan = app.getState().officialPlan;
  if (!plan) return '当前没有正式计划；本段一旦开始仍会被记录为学习事实。';
  return running
    ? '本段已锁定，重新规划不会移动它。结束后的分支处理会先生成预览。'
    : '开始后本段会被自动锁定；结束时可选择记录实际时长或（先生成预览）重新规划剩余工作。';
}

/* ------------------------------------------------------------------ *
 * 结束对话（提前完成 / 超时 / 剩余工作）
 * ------------------------------------------------------------------ */

function openFinishDialog({ target, elapsed, services }) {
  const evaluated = services.focusService.evaluateFinish(target.id, { actualMinutes: elapsed });
  if (!evaluated.ok) {
    toast(evaluated.issues?.[0]?.message ?? '无法结束该时段。', 'error');
    return;
  }

  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(560px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  const bullets = [
    `计划时长 ${formatDuration(evaluated.planMinutes)} · 实际 ${formatDuration(evaluated.actualMinutes)}`,
    evaluated.isEarly ? `比计划少 ${formatDuration(-evaluated.differenceMinutes)}` : null,
    evaluated.isOverrun ? `比计划多 ${formatDuration(evaluated.differenceMinutes)}` : null,
    `本段结束后该任务还剩 ${formatDuration(evaluated.remainingAfterThis)}`,
  ].filter(Boolean);

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  const optionButtons = evaluated.options.map((option) =>
    button(option.label, {
      variant: option.code === 'complete' ? 'primary' : 'default',
      title: option.description,
      onClick: () => {
        close();
        handleFinishChoice({ code: option.code, target, evaluated, services });
      },
    }),
  );

  dialog.appendChild(
    el('div', {}, [
      el('h2', { text: '结束这一段学习', style: { marginBottom: 'var(--space-3)' } }),
      el(
        'ul',
        { style: { margin: '0 0 var(--space-3)', paddingLeft: '1.2em', color: 'var(--color-text-muted)' } },
        bullets.map((text) => el('li', { text })),
      ),
      el('div.card__hint', {
        text: '除"只记录实际时长"以外的选项都会先生成候选计划预览，确认后才会改动后续安排。',
      }),
      el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
        ...optionButtons,
        button('继续学习', { variant: 'ghost', onClick: () => close() }),
      ]),
    ]),
  );

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}

function handleFinishChoice({ code, target, evaluated, services }) {
  switch (code) {
    case 'complete':
    case 'keep_plan': {
      const result = services.focusService.finish(target.id, { actualMinutes: evaluated.actualMinutes });
      if (!result.ok) return toast(result.issues?.[0]?.message ?? '记录失败。', 'error');
      toast('已记录本段学习。', 'success');
      return;
    }
    case 'complete_task': {
      const result = services.focusService.finish(target.id, { actualMinutes: evaluated.actualMinutes });
      if (!result.ok) return toast(result.issues?.[0]?.message ?? '记录失败。', 'error');
      // 剩余工作量为 0：一并标记任务完成（同样先生成预览，保证任务与计划一起生效）
      const previewed = services.ui.previewWith([{ kind: 'task.status', taskId: target.taskId, to: TASK_STATUS.COMPLETED }], {
        changeSummary: '完成最后一段学习并标记任务完成',
        trigger: 'focus-workbench',
      });
      if (!previewed.ok) return toast(previewed.message, 'error', 8000);
      return;
    }
    case 'replan': {
      const result = services.focusService.finish(target.id, { actualMinutes: evaluated.actualMinutes });
      if (!result.ok) return toast(result.issues?.[0]?.message ?? '记录失败。', 'error');
      const previewed = services.ui.requestPreview({ changeSummary: '结束学习后重新规划剩余工作', trigger: 'focus-workbench' });
      if (!previewed.ok) return toast(previewed.message, 'error', 8000);
      return;
    }
    case 'extend': {
      const endMinutes = target.startMinutes + evaluated.actualMinutes;
      const previewed = services.ui.previewWith([{ kind: 'session.extend', sessionId: target.id, endMinutes }], {
        changeSummary: `把当前时段延长到 ${formatMinutes(endMinutes)}`,
        trigger: 'focus-workbench',
      });
      if (!previewed.ok) return toast(previewed.message, 'error', 8000);
      return;
    }
    default:
      toast('未知的处理方式。', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 今日时段清单
 * ------------------------------------------------------------------ */

function renderTodayList({ todaySessions, services, now }) {
  const appState = services.app.getState();
  const completed = todaySessions.filter((session) => session.state === SESSION_STATE.COMPLETED);
  const totalActual = completed.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);

  return card({
    title: '今日全部时段',
    hint: `已完成 ${completed.length} 段 · 实际投入 ${formatDuration(totalActual)}`,
    flush: true,
    body:
      todaySessions.length === 0
        ? el('div', { style: { padding: 'var(--space-4)' } }, [el('div.card__hint', { text: '今天还没有安排任何学习时段。' })])
        : el(
            'ul.task-list',
            {},
            todaySessions.map((session) => {
              const task = (appState.tasks ?? []).find((item) => item.id === session.taskId) ?? null;
              const elapsed = computeElapsedMinutes(session, now);
              return el('li.task-item', {}, [
                el('div.task-item__head', {}, [
                  el('div', {}, [
                    el('strong', { text: `${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}` }),
                    el('span', { text: ` · ${task?.title ?? '（任务已删除）'}` }),
                  ]),
                  el('div.task-item__meta', {}, [
                    pill(stateLabel(session), stateKind(session)),
                    session.locked ? pill('已锁定', 'locked') : null,
                    session.state === SESSION_STATE.IN_PROGRESS ? pill(`已专注 ${formatDuration(elapsed)}`, 'study') : null,
                    session.actualMinutes !== null ? pill(`实际 ${formatDuration(session.actualMinutes)}`, 'study') : null,
                  ]),
                ]),
                el('div.task-item__actions', {}, [
                  button('查看 / 调整', { size: 'sm', onClick: () => services.ui.openSessionDetail(session.id) }),
                ]),
              ]);
            }),
          ),
  });
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 计算某段已投入的分钟数。
 *
 * 优先使用持久化的 `elapsedMinutes`（暂停时写入），否则按"计划开始时间 → 现在"推算。
 * 这样刷新页面后计时不会归零，也不会因为忘记暂停而少算。
 */
function computeElapsedMinutes(session, now) {
  const stored = Number.isInteger(session.elapsedMinutes) ? session.elapsedMinutes : 0;
  if (session.state !== SESSION_STATE.IN_PROGRESS || session.paused) return stored;
  const current = now();
  const sameDay = current.date === session.date;
  const minutesSinceStart = sameDay ? Math.max(0, current.minutes - session.startMinutes) : 0;
  return Math.max(stored, minutesSinceStart);
}

function stateLabel(session) {
  if (session.state === SESSION_STATE.COMPLETED) return '已完成';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? '已暂停' : '进行中';
  return '待进行';
}

function stateKind(session) {
  if (session.state === SESSION_STATE.COMPLETED) return 'success';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? 'warning' : 'study';
  return 'neutral';
}
