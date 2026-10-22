/**
 * 花园内的「学习任务计时」分区。
 *
 * 这是**我们**加在花园里的新区域，不改花园原有一行代码：
 * 花园的 React 挂在它自己的 `#root` 上，我们在这之外插入一块独立的浮层，
 * 通过同源 `window.parent` 拿主应用的数据、回写完成状态。
 *
 * 为什么不做成花园里的一个导航页：
 * 那需要改它的 React 树与路由（属于改它的功能）。做成同一文档里的独立分区，
 * 视觉上仍然是"花园里的一个区域"，但对花园是零侵入。
 *
 * 计时器规则（按需求）：
 * - 时长 = 该学习任务的计划时长（不是固定 25 分钟）；
 * - 到任务计划开始时间自动开始；
 * - 有「提前结束」，提前结束同样算完成一个番茄；
 * - 结束时 → 花园任务 +1 番茄（主应用里显示 🍅 N）→ 主应用任务标记完成。
 */

/** 面板只创建一次 */
const PANEL_KEY = '__studyTimerPanel';

/** 秒 → mm:ss / h:mm:ss */
export function formatRemaining(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 根据"计划开始时间 + 时长"判断当前该做什么。
 *
 * @param {{startMinutes: number, minutes: number}} task
 * @param {{minutes: number}} now 当天的"从零点起的分钟数"
 * @returns {'upcoming'|'due'|'overdue'}
 */
export function schedulePhaseOf(task, now) {
  if (!Number.isInteger(task?.startMinutes)) return 'upcoming';
  if (now.minutes < task.startMinutes) return 'upcoming';
  if (now.minutes < task.startMinutes + Math.max(1, task.minutes ?? 0)) return 'due';
  return 'overdue';
}

/**
 * 把面板注入到花园的文档里（同源 iframe）。
 *
 * @param {HTMLIFrameElement|null} frame
 * @returns {boolean} 是否注入成功
 */
export function mountStudyTimerPanel(frame) {
  let doc = null;
  try {
    doc = frame?.contentDocument ?? null;
  } catch {
    return false;
  }
  if (!doc?.body) return false;
  if (doc.body[PANEL_KEY]) return true;

  const state = { timer: null, tick: null };

  /* ---------------- 启动按钮 ---------------- */
  const launcher = doc.createElement('button');
  launcher.type = 'button';
  launcher.textContent = '⏱ 学习任务计时';
  launcher.setAttribute('data-study-timer', 'launcher');
  Object.assign(launcher.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: '9999',
    padding: '10px 16px',
    borderRadius: '999px',
    border: '1px solid rgba(0,0,0,.12)',
    background: '#4a7c59',
    color: '#fff',
    font: '600 13px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    boxShadow: '0 6px 18px rgba(0,0,0,.18)',
    cursor: 'pointer',
  });

  /* ---------------- 面板 ---------------- */
  const panel = doc.createElement('section');
  panel.setAttribute('data-study-timer', 'panel');
  Object.assign(panel.style, {
    position: 'fixed',
    right: '18px',
    bottom: '70px',
    width: 'min(360px, calc(100vw - 36px))',
    maxHeight: 'min(70vh, 560px)',
    overflow: 'auto',
    zIndex: '9999',
    background: '#fff',
    color: '#22302a',
    border: '1px solid rgba(0,0,0,.12)',
    borderRadius: '16px',
    boxShadow: '0 18px 42px rgba(0,0,0,.22)',
    padding: '14px',
    font: '13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    display: 'none',
  });

  const title = doc.createElement('div');
  title.textContent = '学习任务计时';
  Object.assign(title.style, { fontWeight: '700', fontSize: '14px', marginBottom: '8px' });

  const list = doc.createElement('div');
  const timerBox = doc.createElement('div');
  Object.assign(timerBox.style, { marginTop: '10px', display: 'none', textAlign: 'center' });

  const clock = doc.createElement('div');
  Object.assign(clock.style, { fontSize: '34px', fontWeight: '700', fontVariantNumeric: 'tabular-nums', letterSpacing: '1px' });

  const timerLabel = doc.createElement('div');
  Object.assign(timerLabel.style, { color: '#5c6b63', marginBottom: '8px' });

  const actionRow = doc.createElement('div');
  Object.assign(actionRow.style, { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '6px' });

  const finishBtn = doc.createElement('button');
  finishBtn.type = 'button';
  finishBtn.textContent = '提前结束';
  Object.assign(finishBtn.style, {
    padding: '8px 14px', borderRadius: '10px', border: '1px solid #d16b4f',
    background: '#fdf1ed', color: '#a4442a', fontWeight: '600', cursor: 'pointer',
  });

  const stopBtn = doc.createElement('button');
  stopBtn.type = 'button';
  stopBtn.textContent = '放弃本次';
  Object.assign(stopBtn.style, {
    padding: '8px 14px', borderRadius: '10px', border: '1px solid #d7ded9',
    background: '#f6f8f6', color: '#4a5a51', fontWeight: '600', cursor: 'pointer',
  });

  actionRow.append(finishBtn, stopBtn);
  timerBox.append(clock, timerLabel, actionRow);
  panel.append(title, list, timerBox);

  /* ---------------- 行为 ---------------- */
  const api = () => globalThis.parent?.__plannerGardenApi ?? null;

  function stopTimer() {
    if (state.tick !== null) {
      globalThis.clearInterval(state.tick);
      state.tick = null;
    }
    state.timer = null;
    timerBox.style.display = 'none';
  }

  function renderRemaining() {
    if (!state.timer) return;
    const left = Math.max(0, Math.round((state.timer.targetAt - Date.now()) / 1000));
    clock.textContent = formatRemaining(left);
    timerLabel.textContent = `${state.timer.title} · 计划 ${state.timer.minutes} 分钟`;
    if (left <= 0) finish(true);
  }

  function start(task) {
    stopTimer();
    const minutes = Math.max(1, Math.round(task.minutes ?? 25));
    state.timer = {
      ...task,
      minutes,
      startedAt: Date.now(),
      targetAt: Date.now() + minutes * 60_000,
    };
    timerBox.style.display = 'block';
    renderRemaining();
    state.tick = globalThis.setInterval(renderRemaining, 1000);
  }

  /**
   * 结束一次专注。
   *
   * @param {boolean} automatic true = 时间到；false = 用户点了「提前结束」或「放弃」
   */
  function finish(completed) {
    const timer = state.timer;
    stopTimer();
    if (!timer) return;
    if (!completed) {
      renderList();
      return;
    }
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - timer.startedAt) / 1000));
    api()?.completeStudyTask?.({
      plannerId: timer.plannerId,
      gardenId: timer.gardenId,
      actualMinutes: Math.round(elapsedSeconds / 60) || timer.minutes,
    });
    renderList();
  }

  function makeRow(task) {
    const row = doc.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 6px', borderTop: '1px solid #eef1ee',
    });

    const info = doc.createElement('div');
    Object.assign(info.style, { flex: '1 1 auto', minWidth: '0' });

    const name = doc.createElement('div');
    name.textContent = task.title;
    Object.assign(name.style, { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    const meta = doc.createElement('div');
    const startLabel = Number.isInteger(task.startMinutes)
      ? `${String(Math.floor(task.startMinutes / 60)).padStart(2, '0')}:${String(task.startMinutes % 60).padStart(2, '0')}`
      : '未排时间';
    meta.textContent = `${startLabel} · ${task.minutes} 分钟`;
    Object.assign(meta.style, { color: '#6b7a72', fontSize: '12px' });

    info.append(name, meta);

    const focusBtn = doc.createElement('button');
    focusBtn.type = 'button';
    focusBtn.textContent = '专注';
    Object.assign(focusBtn.style, {
      padding: '6px 12px', borderRadius: '9px', border: '1px solid #4a7c59',
      background: '#4a7c59', color: '#fff', fontWeight: '600', cursor: 'pointer', flex: '0 0 auto',
    });
    focusBtn.addEventListener('click', () => start(task));

    row.append(info, focusBtn);
    return row;
  }

  function renderList() {
    const tasks = api()?.listStudyTasks?.() ?? [];
    list.textContent = '';
    if (tasks.length === 0) {
      const empty = doc.createElement('div');
      empty.textContent = '还没有学习任务。先在主应用里创建任务，再回到这里。';
      Object.assign(empty.style, { color: '#6b7a72', padding: '10px 4px' });
      list.append(empty);
      return;
    }
    for (const task of tasks) list.append(makeRow(task));
  }

  finishBtn.addEventListener('click', () => finish(true));
  stopBtn.addEventListener('click', () => finish(false));

  launcher.addEventListener('click', () => {
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? 'block' : 'none';
    if (hidden) renderList();
  });

  doc.body.append(panel, launcher);
  doc.body[PANEL_KEY] = { panel, launcher, state, renderList };
  return true;
}

/** 面板打开时刷新列表（主应用数据可能变了） */
export function refreshStudyTimerPanel(frame) {
  try {
    const panel = frame?.contentDocument?.body?.[PANEL_KEY];
    panel?.renderList?.();
  } catch {
    // 文档已卸载或跨域：忽略
  }
}
