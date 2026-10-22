/**
 * 花园内的「学习任务计时」分区。
 *
 * 形态：**花园侧边栏里的一个入口**（与「专注」「任务」并列），点开是一整块计时页面，
 * 不再是右下角的小浮层。视觉上是花园的一个分区，但对花园的 React 树与路由**零改动**：
 * 只在它的 `<ul class="nav-list">` 里追加一个按钮，再叠一层自己的页面。
 *
 * 规则（按需求）：
 * - 时长 = 任务的剩余工作量（清单口径由 gardenSync 保证）；
 * - 到计划开始时间**自动开始**（页面前台时每 15 秒检查一次，同一任务同一分钟只触发一次）；
 * - 自然到点 → 进入「已到时间，待确认」，**不自动**改任何数据；
 * - 「提前结束」需要二次确认，确认后计为完成一个番茄；
 * - 计时状态持久化（绝对结束时刻），刷新/重进花园后恢复，不归零。
 */

import {
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  TIMER_MODE,
  TIMER_STATUS,
  advanceTimer,
  computeDisplaySeconds,
  computeElapsedSeconds,
  computeProgress,
  drawableProgress,
  formatStudyClock,
  loadTimer,
  loadPrefs,
  overrunSeconds,
  pauseTimer,
  resumeTimer,
  ringDashOffset,
  savePrefs,
  saveTimer,
  startTimer,
  switchMode,
} from '../services/studyTimer.js';

const PANEL_KEY = '__studyTimerPanel';
const AUTO_CHECK_MS = 15_000;

/** 秒 → mm:ss / h:mm:ss（与计时盘使用同一实现） */
export function formatRemaining(totalSeconds) {
  return formatStudyClock(totalSeconds);
}

/** 分钟数 → HH:mm */
export function formatClock(minutes) {
  if (!Number.isInteger(minutes)) return '未排时间';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * 判断任务相对"现在"的阶段。
 *
 * @param {{startMinutes: number|null, minutes: number}} task
 * @param {{minutes: number}} now
 * @returns {'upcoming'|'due'|'overdue'|'unscheduled'}
 */
export function schedulePhaseOf(task, now) {
  if (!Number.isInteger(task?.startMinutes)) return 'unscheduled';
  if (now.minutes < task.startMinutes) return 'upcoming';
  if (now.minutes < task.startMinutes + Math.max(1, task.minutes ?? 0)) return 'due';
  return 'overdue';
}

const STYLE_ID = '__study-timer-style';
const CSS = `
.st-ring{position:relative;width:min(280px,70vw);aspect-ratio:1;margin:0 auto;display:grid;place-items:center}
.st-ring__svg{position:absolute;inset:0;width:100%;height:100%}
.st-ring__track{opacity:.9}
.st-ring__progress{transition:stroke-dashoffset 220ms linear;filter:drop-shadow(0 0 10px var(--ring-progress, var(--accent, #4a7c59)))}
.st-ring__center{position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;gap:4px}
.st-ring__phase{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#6b7a72}
.st-ring__time{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric:tabular-nums;font-size:clamp(30px,5vw,40px);font-weight:650;letter-spacing:.5px}
.st-ring__hint{font-size:11.5px;color:#6b7a72;max-width:180px}
.st-ring__chip{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11.5px;color:#4a7c59;background:#eef5f0;border-radius:999px;padding:2px 10px}
.st-ring__percent{text-align:center;color:#5c6b63;font-size:12.5px;margin:8px 0 2px}
.st-modes{display:flex;gap:8px;justify-content:center;margin:10px 0 2px}
.st-mode{padding:6px 14px;border-radius:999px;border:1px solid #d7ded9;background:#f6f8f6;
  color:#4a5a51;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.st-mode--active{background:#4a7c59;border-color:#4a7c59;color:#fff}
@media (prefers-reduced-motion: reduce){.st-ring__progress{transition:none;filter:none}}

.st-host{position:fixed;inset:0;z-index:9000;display:none;flex-direction:column;
  background:#f7f5f0;color:#22302a;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.st-host[data-open="true"]{display:flex}
.st-head{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid #e3e0d8;background:#fff}
.st-head h2{margin:0;font-size:17px}
.st-back{margin-left:auto;padding:7px 14px;border-radius:999px;border:1px solid #d7d3c8;
  background:#fff;color:#22302a;font:inherit;font-weight:600;cursor:pointer}
.st-body{flex:1;overflow:auto;padding:24px;display:grid;gap:20px;
  grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);align-items:start}
@media (max-width:820px){.st-body{grid-template-columns:1fr;padding:16px}}
.st-card{background:#fff;border:1px solid #e3e0d8;border-radius:16px;padding:16px}
.st-card h3{margin:0 0 10px;font-size:14px;color:#5c6b63}
.st-row{display:flex;align-items:center;gap:10px;padding:9px 4px;border-top:1px solid #f0eee8}
.st-row:first-of-type{border-top:0}
.st-row__main{flex:1;min-width:0}
.st-row__name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-row__meta{color:#6b7a72;font-size:12px}
.st-btn{padding:7px 14px;border-radius:10px;border:1px solid #4a7c59;background:#4a7c59;
  color:#fff;font:inherit;font-weight:600;cursor:pointer}
.st-btn--ghost{background:#f6f8f6;color:#4a5a51;border-color:#d7ded9}
.st-btn--warn{background:#fdf1ed;color:#a4442a;border-color:#e2b7a8}
.st-btn:disabled{opacity:.45;cursor:not-allowed}
.st-clock{font-size:clamp(44px,7vw,64px);font-weight:700;font-variant-numeric:tabular-nums;text-align:center;letter-spacing:1px}
.st-sub{text-align:center;color:#5c6b63;margin-top:4px;min-height:20px}
.st-actions{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap}
.st-badge{margin-left:auto;font-size:11.5px;color:#4a7c59;font-weight:700}
.st-flag{margin-top:10px;padding:8px 10px;border-radius:10px;background:#fdf6ec;color:#8a5a1f;font-size:12.5px;text-align:center}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  // 某些环境（以及测试用的最小 DOM）没有 head，退回到 body
  (doc.head ?? doc.body)?.appendChild?.(style);
}

/**
 * 在花园的侧边栏里挂一个入口，并注入整页计时界面。
 *
 * @param {HTMLIFrameElement|null} frame
 * @returns {boolean} 注入成功与否
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

  const navList = doc.querySelector('.nav-list');
  if (!navList) return false; // 花园还没渲染出侧边栏

  ensureStyle(doc);

  const state = {
    timer: loadTimer(),
    prefs: loadPrefs(),
    pendingTask: null,
    tick: null,
    auto: null,
    confirmArmed: false,
    lastAutoKey: null,
  };

  /* ---------- 侧边栏入口 ---------- */
  const navItem = doc.createElement('li');
  const navButton = doc.createElement('button');
  navButton.type = 'button';
  navButton.className = 'nav-item';
  navButton.setAttribute('data-study-timer', 'nav');
  const navLabel = doc.createElement('span');
  navLabel.textContent = '学习任务计时';
  const navBadge = doc.createElement('span');
  navBadge.className = 'st-badge';
  navButton.append(navLabel, navBadge);
  navItem.append(navButton);
  navList.append(navItem);

  /* ---------- 整页 ---------- */
  const host = doc.createElement('section');
  host.className = 'st-host';
  host.setAttribute('data-study-timer', 'page');
  host.setAttribute('data-open', 'false');

  const head = doc.createElement('div');
  head.className = 'st-head';
  const h2 = doc.createElement('h2');
  h2.textContent = '学习任务计时';
  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'st-back';
  back.textContent = '← 返回花园';
  head.append(h2, back);

  const body = doc.createElement('div');
  body.className = 'st-body';

  const listCard = doc.createElement('div');
  listCard.className = 'st-card';
  const listTitle = doc.createElement('h3');
  listTitle.textContent = '学习任务';
  const list = doc.createElement('div');
  listCard.append(listTitle, list);

  const timerCard = doc.createElement('div');
  timerCard.className = 'st-card';

  /* ---------- 圆形计时盘（对齐花园番茄钟几何） ---------- */
  const stage = doc.createElement('div');
  stage.className = 'st-ring';
  const svgNS = 'http://www.w3.org/2000/svg';

  const svg = doc.createElementNS ? doc.createElementNS(svgNS, 'svg') : doc.createElement('svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  svg.setAttribute('role', 'timer');
  svg.setAttribute('aria-label', '学习任务计时');
  svg.setAttribute('class', 'st-ring__svg');
  svg.style.transform = 'rotate(-90deg)';

  const track = doc.createElementNS ? doc.createElementNS(svgNS, 'circle') : doc.createElement('circle');
  track.setAttribute('cx', '150');
  track.setAttribute('cy', '150');
  track.setAttribute('r', String(RING_RADIUS));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--ring-track, rgba(0,0,0,.08))');
  track.setAttribute('stroke-width', '12');
  track.setAttribute('class', 'st-ring__track');

  const progressCircle = doc.createElementNS ? doc.createElementNS(svgNS, 'circle') : doc.createElement('circle');
  progressCircle.setAttribute('cx', '150');
  progressCircle.setAttribute('cy', '150');
  progressCircle.setAttribute('r', String(RING_RADIUS));
  progressCircle.setAttribute('fill', 'none');
  progressCircle.setAttribute('stroke', 'var(--ring-progress, var(--accent, #4a7c59))');
  progressCircle.setAttribute('stroke-width', '12');
  progressCircle.setAttribute('stroke-linecap', 'round');
  progressCircle.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  progressCircle.setAttribute('stroke-dashoffset', String(ringDashOffset(drawableProgress(0))));
  progressCircle.setAttribute('class', 'st-ring__progress');

  svg.append(track, progressCircle);

  const center = doc.createElement('div');
  center.className = 'st-ring__center';
  const phase = doc.createElement('div');
  phase.className = 'st-ring__phase';
  phase.textContent = '学习任务';
  const clock = doc.createElement('div');
  clock.className = 'st-ring__time';
  clock.textContent = '00:00';
  const hint = doc.createElement('div');
  hint.className = 'st-ring__hint';
  hint.textContent = '准备好后点击开始';
  const chip = doc.createElement('div');
  chip.className = 'st-ring__chip';
  chip.style.display = 'none';
  center.append(phase, clock, hint, chip);
  stage.append(svg, center);

  const percentLine = doc.createElement('div');
  percentLine.className = 'st-ring__percent';
  percentLine.textContent = '';

  /* ---------- 模式切换 ---------- */
  const modeRow = doc.createElement('div');
  modeRow.className = 'st-modes';
  const countdownBtn = doc.createElement('button');
  countdownBtn.type = 'button';
  countdownBtn.className = 'st-mode';
  countdownBtn.textContent = '倒计时';
  countdownBtn.setAttribute('aria-label', '切换到倒计时模式');
  const countupBtn = doc.createElement('button');
  countupBtn.type = 'button';
  countupBtn.className = 'st-mode';
  countupBtn.textContent = '正计时';
  countupBtn.setAttribute('aria-label', '切换到正计时模式');
  modeRow.append(countdownBtn, countupBtn);

  const flag = doc.createElement('div');
  flag.className = 'st-flag';
  flag.style.display = 'none';

  const actions = doc.createElement('div');
  actions.className = 'st-actions';

  const startBtn = doc.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'st-btn';
  startBtn.textContent = '开始专注';
  startBtn.disabled = true;

  const pauseBtn = doc.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'st-btn st-btn--ghost';
  pauseBtn.textContent = '暂停';

  const finishBtn = doc.createElement('button');
  finishBtn.type = 'button';
  finishBtn.className = 'st-btn st-btn--warn';
  finishBtn.textContent = '提前结束';

  const abandonBtn = doc.createElement('button');
  abandonBtn.type = 'button';
  abandonBtn.className = 'st-btn st-btn--ghost';
  abandonBtn.textContent = '放弃本次';

  actions.append(startBtn, pauseBtn, finishBtn, abandonBtn);
  timerCard.append(stage, percentLine, modeRow, flag, actions);
  body.append(listCard, timerCard);
  host.append(head, body);
  doc.body.append(host);

  /* ---------- 行为 ---------- */
  const api = () => globalThis.parent?.__plannerGardenApi ?? null;
  const nowMs = () => Date.now();
  const nowMinutes = () => {
    const date = new Date();
    return date.getHours() * 60 + date.getMinutes();
  };

  const persist = () => saveTimer(state.timer);

  function stopTicking() {
    if (state.tick !== null) {
      globalThis.clearInterval(state.tick);
      state.tick = null;
    }
  }

  function paintModeButtons() {
    const mode = state.timer?.mode ?? state.prefs.mode;
    countdownBtn.setAttribute('aria-pressed', mode === TIMER_MODE.COUNTDOWN ? 'true' : 'false');
    countupBtn.setAttribute('aria-pressed', mode === TIMER_MODE.COUNTUP ? 'true' : 'false');
    countdownBtn.className = mode === TIMER_MODE.COUNTDOWN ? 'st-mode st-mode--active' : 'st-mode';
    countupBtn.className = mode === TIMER_MODE.COUNTUP ? 'st-mode st-mode--active' : 'st-mode';
  }

  function renderTimer() {
    const current = state.timer;
    paintModeButtons();

    if (!current) {
      const planned = state.pendingTask?.minutes ?? 0;
      clock.textContent = planned > 0 ? formatStudyClock(planned * 60, { withHours: planned * 60 >= 3600 }) : '00:00';
      phase.textContent = '学习任务';
      hint.textContent = state.pendingTask ? '准备好后点击开始' : '从左侧选一个任务开始';
      chip.style.display = 'none';
      percentLine.textContent = planned > 0 ? `计划 ${planned} 分钟` : '';
      progressCircle.setAttribute('stroke-dashoffset', String(ringDashOffset(drawableProgress(0))));
      flag.style.display = 'none';
      startBtn.disabled = !state.pendingTask;
      pauseBtn.disabled = true;
      finishBtn.disabled = true;
      abandonBtn.disabled = true;
      navBadge.textContent = '';
      return;
    }

    const advanced = advanceTimer(current, nowMs());
    if (advanced !== current) {
      state.timer = advanced;
      persist();
    }

    const timer = state.timer;
    const elapsed = computeElapsedSeconds(timer, nowMs());
    const display = computeDisplaySeconds(timer, nowMs());
    const progress = computeProgress(elapsed, timer.plannedSeconds);
    const expired = timer.status === TIMER_STATUS.EXPIRED;
    const paused = timer.status === TIMER_STATUS.PAUSED;

    clock.textContent = formatStudyClock(display, { withHours: timer.plannedSeconds >= 3600 });
    phase.textContent = '学习任务';
    chip.style.display = 'inline-block';
    chip.textContent = timer.title;
    chip.setAttribute('title', timer.title);
    progressCircle.setAttribute('stroke-dashoffset', String(ringDashOffset(drawableProgress(progress))));
    progressCircle.classList.toggle('st-ring__progress--low', progress < 0.0001);

    const percent = Math.round(progress * 100);
    const doneMinutes = Math.round(elapsed / 60);
    const plannedMinutes = Math.round(timer.plannedSeconds / 60);
    if (timer.mode === TIMER_MODE.COUNTUP && overrunSeconds(timer, nowMs()) > 0) {
      percentLine.textContent = `已完成 100% · 已超过计划 ${Math.floor(overrunSeconds(timer, nowMs()) / 60)} 分钟`;
    } else {
      percentLine.textContent = `已完成 ${percent}% · ${doneMinutes} / ${plannedMinutes} 分钟`;
    }

    pauseBtn.disabled = expired;
    startBtn.disabled = true;
    finishBtn.disabled = false;
    abandonBtn.disabled = false;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    navBadge.textContent = paused || expired ? '' : formatStudyClock(display, { withHours: timer.plannedSeconds >= 3600 });

    if (expired) {
      hint.textContent = '已到时间，请确认完成';
      flag.style.display = 'block';
      flag.textContent = '系统不会自动修改数据，确认后才会标记完成';
      finishBtn.textContent = '确认完成';
      finishBtn.className = 'st-btn';
      return;
    }

    flag.style.display = 'none';
    finishBtn.className = state.confirmArmed ? 'st-btn' : 'st-btn st-btn--warn';
    finishBtn.textContent =
      state.confirmArmed
        ? '再点一次确认结束'
        : timer.mode === TIMER_MODE.COUNTUP
          ? '完成专注'
          : '提前结束';
    hint.textContent = paused
      ? '已暂停 · 剩余时间已保留'
      : timer.mode === TIMER_MODE.COUNTUP
        ? '正计时进行中'
        : '保持专注，剩下的交给计时器';
  }

  function startTicking() {
    stopTicking();
    state.tick = globalThis.setInterval(renderTimer, 1000);
  }

  function startFor(task) {
    state.pendingTask = task;
    state.timer = startTimer(
      { ...task, mode: state.prefs.mode ?? TIMER_MODE.COUNTDOWN },
      nowMs(),
    );
    state.confirmArmed = false;
    persist();
    renderTimer();
    startTicking();
    renderList();
  }

  function finishTimer() {
    const timer = state.timer;
    if (!timer) return;

    const expired = timer.status === TIMER_STATUS.EXPIRED;
    if (!expired && !state.confirmArmed) {
      state.confirmArmed = true;
      renderTimer();
      globalThis.setTimeout(() => {
        state.confirmArmed = false;
        if (state.timer) renderTimer();
      }, 4000);
      return;
    }

    const elapsed = computeElapsedSeconds(timer, nowMs());
    const used = expired ? Math.round(timer.plannedSeconds / 60) : Math.max(1, Math.round(elapsed / 60));

    state.timer = null;
    state.pendingTask = null;
    state.confirmArmed = false;
    persist();
    stopTicking();
    renderTimer();

    api()?.completeStudyTask?.({
      plannerId: timer.plannerId,
      gardenId: timer.gardenId,
      actualMinutes: used,
    });
    renderList();
  }

  function abandonTimer() {
    state.timer = null;
    state.pendingTask = null;
    state.confirmArmed = false;
    persist();
    stopTicking();
    renderTimer();
    renderList();
  }

  function makeRow(task) {
    const row = doc.createElement('div');
    row.className = 'st-row';

    const main = doc.createElement('div');
    main.className = 'st-row__main';
    const name = doc.createElement('div');
    name.className = 'st-row__name';
    name.textContent = task.title;
    const meta = doc.createElement('div');
    meta.className = 'st-row__meta';
    meta.textContent = `${formatClock(task.startMinutes)} · ${task.minutes} 分钟`;
    main.append(name, meta);

    const focus = doc.createElement('button');
    focus.type = 'button';
    focus.className = 'st-btn';
    focus.textContent = '专注';
    focus.addEventListener('click', () => startFor(task));

    row.append(main, focus);
    return row;
  }

  function renderList() {
    const tasks = api()?.listStudyTasks?.() ?? [];
    list.textContent = '';
    if (tasks.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'st-row__meta';
      empty.textContent = '还没有学习任务。先在规划器里创建任务，再回到这里。';
      list.append(empty);
      return;
    }
    for (const task of tasks) list.append(makeRow(task));
  }

  /** 到点自动开始：只在前台、且当前没有计时时触发；同一任务同一分钟只触发一次 */
  function autoCheck() {
    if (state.timer) return;
    const tasks = api()?.listStudyTasks?.() ?? [];
    const minute = nowMinutes();
    const due = tasks.find((task) => task.startMinutes === minute);
    if (!due) return;
    const key = `${due.plannerId}@${minute}`;
    if (state.lastAutoKey === key) return;
    state.lastAutoKey = key;
    startFor(due);
  }

  navButton.addEventListener('click', () => {
    const open = host.getAttribute('data-open') === 'true';
    host.setAttribute('data-open', open ? 'false' : 'true');
    if (!open) {
      renderList();
      renderTimer();
    }
  });
  back.addEventListener('click', () => host.setAttribute('data-open', 'false'));

  startBtn.addEventListener('click', () => {
    if (state.pendingTask && !state.timer) startFor(state.pendingTask);
  });

  pauseBtn.addEventListener('click', () => {
    if (!state.timer) return;
    state.timer =
      state.timer.status === TIMER_STATUS.PAUSED
        ? resumeTimer(state.timer, nowMs())
        : pauseTimer(state.timer, nowMs());
    persist();
    renderTimer();
  });

  /** 切换模式：运行中也允许，已专注时间不丢 */
  function applyMode(mode) {
    state.prefs = { ...state.prefs, mode };
    savePrefs(state.prefs);
    if (state.timer) {
      state.timer = switchMode(state.timer, mode, nowMs());
      persist();
    }
    renderTimer();
    renderList();
  }
  countdownBtn.addEventListener('click', () => applyMode(TIMER_MODE.COUNTDOWN));
  countupBtn.addEventListener('click', () => applyMode(TIMER_MODE.COUNTUP));

  finishBtn.addEventListener('click', finishTimer);
  abandonBtn.addEventListener('click', abandonTimer);

  renderList();
  renderTimer();
  if (state.timer && state.timer.status === TIMER_STATUS.RUNNING) startTicking();
  state.auto = globalThis.setInterval(autoCheck, AUTO_CHECK_MS);
  autoCheck();

  doc.body[PANEL_KEY] = {
    host,
    state,
    renderList,
    renderTimer,
    open: () => {
      host.setAttribute('data-open', 'true');
      renderList();
      renderTimer();
    },
  };
  return true;
}

/** 数据变化后刷新清单与计时显示 */
export function refreshStudyTimerPanel(frame) {
  try {
    const panel = frame?.contentDocument?.body?.[PANEL_KEY];
    panel?.renderList?.();
    panel?.renderTimer?.();
  } catch {
    // 文档已卸载或跨域：忽略
  }
}

/** 打开花园里的计时分区（供外部调用/测试） */
export function openStudyTimerPanel(frame) {
  try {
    const panel = frame?.contentDocument?.body?.[PANEL_KEY];
    panel?.open?.();
    return Boolean(panel);
  } catch {
    return false;
  }
}
