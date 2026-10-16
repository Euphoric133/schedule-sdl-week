/**
 * 专注页：完整的番茄钟工作区。
 *
 * 计时可靠性的实现方式（这是硬性要求，不能只做"每秒减一"）：
 * - 剩余时间由**结束时刻的绝对时间戳**算出（见 services/pomodoroTimer.js），
 *   因此刷新页面、切换标签页、电脑休眠后都不会重新开始或漂移；
 * - 界面每秒重绘只是"显示刷新"，不是计时来源；
 * - 暂停会把剩余秒数冻结，恢复时重新锚定结束时间戳，暂停期间不计入。
 *
 * 与任务系统的关系：专注只是**记录投入**。一轮番茄结束不会自动把任务标记为完成，
 * 未完成的剩余工作量由用户决定是否重新规划。
 */

import { button, card, emptyState, notice, pill, progressBar, statTile } from '../components.js';
import { el, toast } from '../dom.js';
import { SESSION_STATE } from '../../domain/session.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';
import { FOCUS_PHASE, formatSeconds, progressOf, remainingSecondsOf } from '../../services/pomodoroTimer.js';
import { END_REASON, PHASE_LABELS_ZH } from '../../services/pomodoroService.js';
import { updateParams } from '../router.js';

export function renderFocus({ app, services, now, route, requestTick }) {
  const state = app.getState();
  const today = now().date;
  const nowMs = Date.now();
  const timer = services.pomodoroService.getTimer();
  const config = services.pomodoroService.readConfig();
  const todayStats = services.pomodoroService.todayStats();

  const todaySessions = (state.sessions ?? [])
    .filter((session) => session.date === today && session.state !== SESSION_STATE.CANCELLED)
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const activeTasks = (state.tasks ?? []).filter(
    (task) => task.status === 'not_started' || task.status === 'in_progress',
  );

  const running = timer.phase !== FOCUS_PHASE.IDLE;
  const ticking = running && !timer.paused;
  if (ticking && typeof requestTick === 'function') requestTick();

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '专注番茄钟' }),
        el('p.page-head__sub', {
          text: running
            ? `${PHASE_LABELS_ZH[timer.phase]}进行中${timer.paused ? '（已暂停）' : ''}　·　${timer.taskTitle ?? '未关联任务'}`
            : `当前设置：专注 ${config.focusMinutes} 分钟　·　短休息 ${config.shortBreakMinutes} 分钟　·　每 ${config.roundsBeforeLongBreak} 轮长休息 ${config.longBreakMinutes} 分钟`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('专注设置', { size: 'sm', onClick: () => updateParams({ tab: 'settings' }) }),
      ]),
    ]),
  );

  /* ---------- 主计时区 ---------- */
  nodes.push(renderTimerCard({ timer, nowMs, services, todaySessions, taskById, config }));

  /* ---------- 统计与选择任务 ---------- */
  const sideNodes = [];

  sideNodes.push(
    card({
      title: '今天的专注',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '完成番茄' }), el('div.metric__value', { text: `${todayStats.completedRounds} 个` })]),
          el('div.metric', {}, [el('div.metric__label', { text: '专注时长' }), el('div.metric__value', { text: formatDuration(todayStats.focusedMinutes) })]),
          el('div.metric', {}, [el('div.metric__label', { text: '提前结束' }), el('div.metric__value', { text: `${todayStats.earlyEndedRounds} 次` })]),
        ]),
        todayStats.earlyEndedRounds > 0
          ? el('div.card__hint', { text: '中途结束的专注会按实际时长记录，但不会算作完成一个番茄。' })
          : null,
      ]),
    }),
  );

  // 任务选择：可以从今天的时段里选，也可以直接从待办任务里选
  const selectable = todaySessions.filter((session) => session.state !== SESSION_STATE.COMPLETED);
  sideNodes.push(
    card({
      title: '这次专注做什么',
      hint: '选择后计时结束会把投入记到对应任务上',
      body: el('div', {}, [
        selectable.length === 0 && activeTasks.length === 0
          ? emptyState({
              title: '今天没有可专注的任务',
              message: '可以先生成一份七天计划，或直接新建一个任务。',
              actions: [
                button('新建任务', { variant: 'primary', onClick: () => services.ui.openTaskForm(null) }),
                button('生成计划', {
                  onClick: () => {
                    const result = services.ui.requestPreview({ changeSummary: '生成计划', trigger: 'focus-page' });
                    if (!result.ok) toast(result.message, 'error', 8000);
                  },
                }),
              ],
            })
          : el('div', {}, [
              ...(selectable.length > 0
                ? [
                    el('div.card__hint', { text: '今天计划中的时段' }),
                    el(
                      'ul.task-list',
                      {},
                      selectable.map((session) => {
                        const task = taskById.get(session.taskId);
                        const attached = timer.sessionId === session.id;
                        return el('li.task-item', {}, [
                          el('div.task-item__head', {}, [
                            el('div', {}, [
                              el('strong', { text: `${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}` }),
                              el('span', { text: `　${task?.title ?? '（任务已删除）'}` }),
                            ]),
                            el('div.task-item__meta', {}, [
                              attached ? pill('当前专注', 'success') : pill(formatDuration(session.plannedMinutes), 'neutral'),
                              session.locked ? pill('已锁定', 'locked') : null,
                            ]),
                          ]),
                          el('div.task-item__actions', {}, [
                            button(attached ? '已在专注' : '专注这个时段', {
                              size: 'sm',
                              disabled: attached && running,
                              onClick: () =>
                                startWith({
                                  services,
                                  sessionId: session.id,
                                  taskId: session.taskId,
                                  taskTitle: task?.title ?? null,
                                }),
                            }),
                          ]),
                        ]);
                      }),
                    ),
                  ]
                : []),
              ...(activeTasks.length > 0
                ? [
                    el('div.card__hint', { text: '不在计划内的任务（自由专注）', style: { marginTop: 'var(--space-3)' } }),
                    el(
                      'ul.task-list',
                      {},
                      activeTasks.slice(0, 8).map((task) =>
                        el('li.task-item', {}, [
                          el('div.task-item__head', {}, [
                            el('div', {}, [el('strong', { text: task.title }), el('span', { text: `　${task.subject}` })]),
                            el('div.task-item__meta', {}, [pill(`截止 ${task.deadlineDate}`, 'neutral')]),
                          ]),
                          el('div.task-item__actions', {}, [
                            button('专注这个任务', {
                              size: 'sm',
                              onClick: () => startWith({ services, sessionId: null, taskId: task.id, taskTitle: task.title }),
                            }),
                          ]),
                        ]),
                      ),
                    ),
                  ]
                : []),
            ]),
      ]),
    }),
  );

  sideNodes.push(renderSettingsCard({ services, config, timer }));
  sideNodes.push(renderTodayList({ todaySessions, taskById, services }));

  if (route?.params?.get('tab') === 'settings') {
    nodes.push(sideNodes.pop()); // 把设置提到前面，便于从首页深链直接看到
  }

  nodes.push(el('div.home-grid', {}, [el('div.home-grid__side', { style: { gridColumn: '1 / -1' } }, sideNodes)]));

  return nodes;
}

/* ------------------------------------------------------------------ *
 * 计时卡片
 * ------------------------------------------------------------------ */

function renderTimerCard({ timer, nowMs, services, config }) {
  const running = timer.phase !== FOCUS_PHASE.IDLE;
  const remaining = remainingSecondsOf(timer, nowMs);
  const progress = progressOf(timer, nowMs);
  const isFocus = timer.phase === FOCUS_PHASE.FOCUS;
  const label = PHASE_LABELS_ZH[timer.phase] ?? '未开始';

  const actions = [];
  if (!running) {
    actions.push(
      button(`开始专注 ${config.focusMinutes} 分钟`, {
        variant: 'primary',
        onClick: () => {
          services.pomodoroService.startFocus({});
          toast('开始专注。计时按真实时间计算，刷新页面也不会丢。', 'success');
        },
      }),
    );
    actions.push(button(`短休息 ${config.shortBreakMinutes} 分钟`, { onClick: () => services.pomodoroService.startBreak({ long: false }) }));
    actions.push(button(`长休息 ${config.longBreakMinutes} 分钟`, { onClick: () => services.pomodoroService.startBreak({ long: true }) }));
  } else {
    actions.push(
      button(timer.paused ? '继续' : '暂停', {
        onClick: () => {
          if (timer.paused) {
            const result = services.pomodoroService.resume();
            if (!result.ok) return toast(result.message ?? '继续失败。', 'error');
          } else {
            services.pomodoroService.pause();
            // 记录暂停发生的时刻，用于统计累计暂停时长
            services.pomodoroService.resumeMarkPause();
          }
        },
      }),
    );
    actions.push(
      button('结束这一段…', {
        variant: 'primary',
        onClick: () => openEndDialog({ services, timer, nowMs }),
      }),
    );
    actions.push(
      button('放弃本次', {
        variant: 'ghost',
        onClick: () => {
          services.pomodoroService.discard();
          toast('已放弃本次计时（没有写入任何记录）。', 'success');
        },
      }),
    );
  }

  return card({
    title: running ? label : '准备开始',
    hint: running ? (timer.taskTitle ?? '未关联任务') : '选择一种计时开始；只有真实完成的专注才会计入统计',
    body: el('div.focus-timer', {}, [
      el('div.focus-timer__ring', { role: running ? 'timer' : null, 'aria-live': running ? 'polite' : null }, [
        el('div.focus-timer__value', { text: formatSeconds(remaining) }),
        el('div.focus-timer__phase', { text: running ? (timer.paused ? '已暂停' : label) : '未开始' }),
      ]),
      progressBar({
        value: progress,
        label: running ? `${label}进度` : '进度',
        hint:
          running && isFocus
            ? `本轮计划 ${config.focusMinutes} 分钟；结束时会按实际投入记录。`
            : running
              ? '休息阶段不计入学习时长。'
              : '计时采用真实时间戳，切换标签页或电脑休眠后不会漂移。',
        kind: isFocus ? 'primary' : 'rest',
      }),
      el('div.form-actions', { style: { justifyContent: 'center', flexWrap: 'wrap' } }, actions),
      timer.round > 0
        ? el('div.card__hint', { text: `已完成 ${timer.round} 轮专注${timer.round > 0 ? `　·　再完成 ${Math.max(0, config.roundsBeforeLongBreak - (timer.round % config.roundsBeforeLongBreak || config.roundsBeforeLongBreak))} 轮进入长休息` : ''}` })
        : null,
    ]),
  });
}

/* ------------------------------------------------------------------ *
 * 结束对话
 * ------------------------------------------------------------------ */

function openEndDialog({ services, timer, nowMs }) {
  const remaining = remainingSecondsOf(timer, nowMs);
  const elapsed = Math.max(0, (timer.durationSeconds ?? 0) - remaining);
  const isFocus = timer.phase === FOCUS_PHASE.FOCUS;

  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(520px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  const finish = (reason) => {
    const result = services.pomodoroService.endPhase({ reason });
    close();
    if (!result.ok) return toast(result.message ?? '结束失败。', 'error');
    if (!isFocus) {
      toast('休息结束。', 'success');
      return;
    }
    const minutes = Math.round(result.focusedSeconds / 60);
    toast(
      result.completed
        ? `完成一个番茄：专注 ${minutes} 分钟，已计入统计。`
        : `已记录本次专注 ${minutes} 分钟（提前结束，不计入完成番茄）。`,
      result.completed ? 'success' : 'info',
      7000,
    );
  };

  dialog.appendChild(
    el('div', {}, [
      el('h2', { text: '结束这一段？', style: { marginBottom: 'var(--space-3)' } }),
      el('ul', { style: { margin: '0 0 var(--space-3)', paddingLeft: '1.2em', color: 'var(--color-text-muted)' } }, [
        el('li', { text: `阶段：${PHASE_LABELS_ZH[timer.phase]}` }),
        el('li', { text: `已进行 ${formatSeconds(elapsed)}　剩余 ${formatSeconds(remaining)}` }),
        el('li', { text: isFocus ? `关闭前已投入的 ${Math.max(1, Math.round(elapsed / 60))} 分钟会被记录为学习事实` : '休息阶段不会写入学习记录' }),
        el('li', { text: '一轮番茄结束不代表任务完成，未完成的部分需要你决定是否重新规划' }),
      ]),
      el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
        button('记录并结束', { variant: 'primary', onClick: () => finish(remaining <= 0 ? END_REASON.COMPLETED : END_REASON.STOPPED) }),
        remaining <= 0 ? button('跳过剩余时间直接完成', { onClick: () => finish(END_REASON.COMPLETED) }) : null,
        button('继续这段', { variant: 'ghost', onClick: () => close() }),
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

/* ------------------------------------------------------------------ *
 * 专注设置
 * ------------------------------------------------------------------ */

function renderSettingsCard({ services, config, timer }) {
  const numberField = (key, label, value, { min = 1, max = 180, hint } = {}) => {
    const input = el('input', { type: 'number', min: String(min), max: String(max), value: String(value), id: `focus-${key}` });
    input.addEventListener('change', () => {
      services.pomodoroService.setConfig({ [key]: Number(input.value) });
      toast('已更新专注设置。', 'success', 3000);
    });
    return el('div.form-field', {}, [
      el('label', { for: `focus-${key}`, text: label }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  };

  const prefs = services.appearanceService.getPreferences().focus;
  const autoToggle = el('input', { type: 'checkbox', id: 'focus-auto', checked: Boolean(config.autoStartNext) });
  autoToggle.addEventListener('change', () => {
    services.pomodoroService.setConfig({ autoStartNext: autoToggle.checked });
    toast(autoToggle.checked ? '已开启自动进入下一阶段。' : '已关闭自动进入下一阶段。', 'success', 3000);
  });

  const soundToggle = el('input', { type: 'checkbox', id: 'focus-sound', checked: prefs.soundEnabled !== false });
  const volume = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round((prefs.soundVolume ?? 0.5) * 100)), id: 'focus-volume' });
  const soundKind = el('select', { id: 'focus-sound-kind' });
  for (const [value, label] of [['brown', '棕噪音（推荐，稳定不刺耳）'], ['rain', '模拟雨声'], ['none', '不播放环境音']]) {
    soundKind.appendChild(el('option', { value, selected: prefs.soundKind === value, text: label }));
  }

  soundToggle.addEventListener('change', () => {
    services.appearanceService.updatePreferences((current) => ({
      ...current,
      focus: { ...current.focus, soundEnabled: soundToggle.checked },
    }));
    if (soundToggle.checked) ensureAmbient({ services, kind: soundKind.value, volume: Number(volume.value) / 100 });
    else stopAmbient();
  });
  volume.addEventListener('input', () => {
    services.appearanceService.updatePreferences((current) => ({
      ...current,
      focus: { ...current.focus, soundVolume: Number(volume.value) / 100 },
    }));
    setAmbientVolume(Number(volume.value) / 100);
  });
  soundKind.addEventListener('change', () => {
    services.appearanceService.updatePreferences((current) => ({
      ...current,
      focus: { ...current.focus, soundKind: soundKind.value },
    }));
    if (soundToggle.checked) ensureAmbient({ services, kind: soundKind.value, volume: Number(volume.value) / 100 });
  });

  return card({
    title: '专注设置',
    hint: '所有设置立即保存；刷新页面后仍然有效',
    body: el('div', {}, [
      el('div.grid-2', {}, [
        numberField('focusMinutes', '专注时长（分钟）', config.focusMinutes, { min: 1, max: 180, hint: '默认 25 分钟' }),
        numberField('shortBreakMinutes', '短休息（分钟）', config.shortBreakMinutes, { min: 1, max: 60 }),
        numberField('longBreakMinutes', '长休息（分钟）', config.longBreakMinutes, { min: 1, max: 120 }),
        numberField('roundsBeforeLongBreak', '每几轮进入长休息', config.roundsBeforeLongBreak, { min: 1, max: 12 }),
      ]),
      el('div.form-field', {}, [
        el('label', { for: 'focus-auto' }, [autoToggle, el('span', { text: ' 一个阶段结束后自动开始下一个阶段' })]),
        el('div.form-field__hint', { text: '关闭时（推荐）每个阶段结束后由你决定下一步，避免休息时间被自动跳过。' }),
      ]),
      el('fieldset', {}, [
        el('legend', { text: '环境音（可选）' }),
        el('div.form-field', {}, [
          el('label', { for: 'focus-sound' }, [soundToggle, el('span', { text: ' 专注时播放环境音' })]),
        ]),
        el('div.grid-2', {}, [
          el('div.form-field', {}, [el('label', { for: 'focus-sound-kind', text: '声音类型' }), soundKind]),
          el('div.form-field', {}, [
            el('label', { for: 'focus-volume', text: '音量' }),
            el('div.slider-row', {}, [volume]),
          ]),
        ]),
        el('div.form-field__hint', { text: '环境音使用浏览器本地合成的噪音，不需要联网，也不会下载任何音频文件。' }),
      ]),
      timer.phase !== FOCUS_PHASE.IDLE ? el('div.card__hint', { text: '正在计时中，修改设置会在下一轮生效。' }) : null,
    ]),
  });
}

/* ------------------------------------------------------------------ *
 * 今日清单
 * ------------------------------------------------------------------ */

function renderTodayList({ todaySessions, taskById, services }) {
  const completed = todaySessions.filter((session) => session.state === SESSION_STATE.COMPLETED);
  const totalActual = completed.reduce((sum, session) => sum + (session.actualMinutes ?? session.plannedMinutes), 0);

  return card({
    title: '今日全部时段',
    hint: `已完成 ${completed.length} 段　·　实际投入 ${formatDuration(totalActual)}`,
    flush: true,
    body:
      todaySessions.length === 0
        ? el('div', { style: { padding: 'var(--space-4)' } }, [el('div.card__hint', { text: '今天还没有安排任何学习时段。' })])
        : el(
            'ul.task-list',
            {},
            todaySessions.map((session) => {
              const task = taskById.get(session.taskId);
              return el('li.task-item', { class: session.state === SESSION_STATE.COMPLETED ? 'task-item--done' : null }, [
                el('div.task-item__head', {}, [
                  el('div', {}, [
                    el('strong', { text: `${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}` }),
                    el('span', { text: `　${task?.title ?? '（任务已删除）'}` }),
                  ]),
                  el('div.task-item__meta', {}, [
                    pill(stateText(session), stateKind(session)),
                    session.actualMinutes !== null ? pill(`实际 ${formatDuration(session.actualMinutes)}`, 'study') : null,
                  ]),
                ]),
                el('div.task-item__actions', {}, [
                  button('详情', { size: 'sm', onClick: () => services.ui.openSessionDetail(session.id) }),
                ]),
              ]);
            }),
          ),
  });
}

function startWith({ services, sessionId, taskId, taskTitle }) {
  const started = services.pomodoroService.startFocus({ sessionId, taskId, taskTitle });
  if (!started.ok) return toast(started.message ?? '无法开始专注。', 'error');
  toast(`已开始专注：${taskTitle ?? '自由专注'}。`, 'success');
}

function stateText(session) {
  if (session.state === SESSION_STATE.COMPLETED) return '已完成';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? '已暂停' : '进行中';
  return '待进行';
}

function stateKind(session) {
  if (session.state === SESSION_STATE.COMPLETED) return 'success';
  if (session.state === SESSION_STATE.IN_PROGRESS) return session.paused ? 'warning' : 'study';
  return 'neutral';
}

/* ------------------------------------------------------------------ *
 * 环境音：用 Web Audio 在本地合成噪音，不联网、不下载文件
 * ------------------------------------------------------------------ */

let audioContext = null;
let ambientNodes = null;

function ensureAmbient({ kind, volume }) {
  if (kind === 'none' || typeof globalThis.AudioContext !== 'function') {
    stopAmbient();
    return;
  }
  stopAmbient();
  try {
    audioContext = new globalThis.AudioContext();
    const bufferSize = 2 * audioContext.sampleRate;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let index = 0; index < bufferSize; index += 1) {
      const white = Math.random() * 2 - 1;
      // 棕噪音：对白噪音做积分，听感更柔和；雨声只是把棕噪音调亮一点
      last = (last + 0.02 * white) / 1.02;
      data[index] = kind === 'rain' ? (last * 3.5 + white * 0.12) : last * 3.5;
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = audioContext.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume));
    source.connect(gain).connect(audioContext.destination);
    source.start();
    ambientNodes = { source, gain };
  } catch {
    stopAmbient();
  }
}

function setAmbientVolume(volume) {
  if (ambientNodes?.gain) ambientNodes.gain.gain.value = Math.min(1, Math.max(0, volume));
}

function stopAmbient() {
  try {
    ambientNodes?.source?.stop();
  } catch {
    /* 已经停止 */
  }
  ambientNodes = null;
  try {
    audioContext?.close();
  } catch {
    /* 忽略 */
  }
  audioContext = null;
}

export { stopAmbient, ensureAmbient };
