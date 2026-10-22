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
  TIMER_STATUS,
  advanceTimer,
  elapsedSeconds,
  loadTimer,
  pauseTimer,
  remainingSeconds,
  resumeTimer,
  saveTimer,
  startTimer,
} from '../services/studyTimer.js';

const PANEL_KEY = '__studyTimerPanel';
const AUTO_CHECK_MS = 15_000;

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
  const clock = doc.createElement('div');
  clock.className = 'st-clock';
  clock.textContent = '--:--';
  const sub = doc.createElement('div');
  sub.className = 'st-sub';
  sub.textContent = '从左侧选一个任务开始';
  const flag = doc.createElement('div');
  flag.className = 'st-flag';
  flag.style.display = 'none';
  const actions = doc.createElement('div');
  actions.className = 'st-actions';

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

  actions.append(pauseBtn, finishBtn, abandonBtn);
  timerCard.append(clock, sub, flag, actions);
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

  function renderTimer() {
    const current = state.timer;
    if (!current) {
      clock.textContent = '--:--';
      sub.textContent = '从左侧选一个任务开始';
      flag.style.display = 'none';
      pauseBtn.disabled = true;
      finishBtn.disabled = true;
      abandonBtn.disabled = true;
      finishBtn.textContent = '提前结束';
      navBadge.textContent = '';
      return;
    }

    const advanced = advanceTimer(current, nowMs());
    if (advanced !== current) {
      state.timer = advanced;
      persist();
    }

    const left = remainingSeconds(state.timer, nowMs());
    clock.textContent = formatRemaining(left);
    const expired = state.timer.status === TIMER_STATUS.EXPIRED;
    const paused = state.timer.status === TIMER_STATUS.PAUSED;

    pauseBtn.disabled = expired;
    finishBtn.disabled = false;
    abandonBtn.disabled = false;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    navBadge.textContent = paused || expired ? '' : formatRemaining(left);

    if (expired) {
      sub.textContent = `${state.timer.title} · ${state.timer.minutes} 分钟已走完`;
      flag.style.display = 'block';
      flag.textContent = '已到时间，请确认完成（系统不会自动修改数据）';
      finishBtn.textContent = '确认完成';
      finishBtn.className = 'st-btn';
      return;
    }

    flag.style.display = 'none';
    finishBtn.className =
      state.confirmArmed ? 'st-btn' : 'st-btn st-btn--warn';
    finishBtn.textContent = state.confirmArmed ? '再点一次确认结束' : '提前结束';
    sub.textContent = paused
      ? `已暂停 · ${state.timer.title}（剩余 ${formatRemaining(left)}）`
      : `正在专注 · ${state.timer.title}（共 ${state.timer.minutes} 分钟）`;
  }

  function startTicking() {
    stopTicking();
    state.tick = globalThis.setInterval(renderTimer, 1000);
  }

  function startFor(task) {
    state.timer = startTimer(task, nowMs());
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
      // 二次确认：第一次点击只是"上膛"，4 秒内再点才真正结束
      state.confirmArmed = true;
      renderTimer();
      globalThis.setTimeout(() => {
        state.confirmArmed = false;
        if (state.timer) renderTimer();
      }, 4000);
      return;
    }

    const used = expired
      ? timer.minutes
      : Math.max(1, Math.round(elapsedSeconds(timer, nowMs()) / 60));

    state.timer = null;
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

  pauseBtn.addEventListener('click', () => {
    if (!state.timer) return;
    state.timer =
      state.timer.status === TIMER_STATUS.PAUSED
        ? resumeTimer(state.timer, nowMs())
        : pauseTimer(state.timer, nowMs());
    persist();
    renderTimer();
  });

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
