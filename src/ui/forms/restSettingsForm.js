/**
 * 「设置休息」：一个入口，两种明确不同的含义。
 *
 * 模式 A —— 仅设置今晚休息（一次性）
 *   今天 22:00 → 明天 08:00。保存为一条**普通休息安排**（restPeriods），
 *   只影响这一次，不产生任何每周重复。
 *   如果今晚已经有一条休息安排，界面会显示出来并提供"替换"，避免重复创建。
 *
 * 模式 B —— 固定睡觉时间（长期重复规则）
 *   保存为一条 `type='sleep'` 的**固定任务**，带星期重复规则。
 *   因此它在之后的每一周都继续生效，并且天然支持跨午夜拆分显示。
 *
 * 两者必须用不同实体保存：
 *   - 一次性休息塞进重复规则 → 用户之后每周都被"多出来的一次休息"影响；
 *   - 重复规则只存成某一天的休息 → 下周就消失。
 * 这正是需求里强调不能混的两件事。
 */

import { append, clear, el } from '../dom.js';
import { button } from '../components.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';
import { toast } from '../dom.js';
import { FIXED_ACTIVITY_TYPE } from '../../domain/fixedActivity.js';
import { TASK_NAME_MAX_LENGTH } from '../../domain/validation.js';
import { confirmDialog } from '../modal.js';

const WEEKDAY_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
];

/** 默认：22:00 睡觉、08:00 起床 */
const DEFAULT_SLEEP_START = 22 * 60;
const DEFAULT_WAKE_END = 8 * 60;

/**
 * @param {object} options
 * @param {object} options.services
 */
export function openRestSettingsForm({ services }) {
  const now = services.now();
  const today = now.date;
  const tomorrow = addDaysLocal(today, 1);

  const state = { mode: 'tonight' };
  const errorHost = el('div');
  const previewHost = el('div.card__hint', { 'aria-live': 'polite' });

  /* ---------------- 模式 A 的输入 ---------------- */
  const tonight = {
    title: el('input', { type: 'text', id: 'rs-tonight-title', maxlength: String(TASK_NAME_MAX_LENGTH), value: '睡觉' }),
    start: el('input', { type: 'time', id: 'rs-tonight-start', value: minutesToHHmm(DEFAULT_SLEEP_START) }),
    end: el('input', { type: 'time', id: 'rs-tonight-end', value: minutesToHHmm(DEFAULT_WAKE_END) }),
  };

  /* ---------------- 模式 B 的输入 ---------------- */
  const weekly = {
    title: el('input', { type: 'text', id: 'rs-weekly-title', maxlength: String(TASK_NAME_MAX_LENGTH), value: '睡觉' }),
    start: el('input', { type: 'time', id: 'rs-weekly-start', value: minutesToHHmm(DEFAULT_SLEEP_START) }),
    end: el('input', { type: 'time', id: 'rs-weekly-end', value: minutesToHHmm(DEFAULT_WAKE_END) }),
    days: new Set([1, 2, 3, 4, 5, 6, 7]),
  };

  /** 今晚已有的休息安排（用于"替换"而不是重复创建） */
  function existingTonight() {
    return services.restService
      .list()
      .filter((rest) => services.restService.datesOf(rest.id).includes(today))
      .filter((rest) => {
        const fragments = services.restService.forDate(today).filter((fragment) => fragment.restId === rest.id);
        // "今晚"= 当天 18:00 之后开始，或一直延续到第二天
        return fragments.some((fragment) => fragment.endMinutes >= 18 * 60 && fragment.endMinutes > fragment.startMinutes);
      });
  }

  const tonightListHost = el('div');

  function refreshTonightList() {
    clear(tonightListHost);
    const list = existingTonight();
    if (state.mode !== 'tonight' || list.length === 0) return;
    append(tonightListHost, [
      el('div.notice.notice--info', {}, [
        el('div', {}, [
          el('div.notice__title', { text: `今晚已经有 ${list.length} 条休息安排` }),
          el(
            'ul',
            { style: { margin: '4px 0 0', paddingLeft: '1.2em' } },
            list.map((rest) => {
              const fragment = services.restService.forDate(today).find((item) => item.restId === rest.id);
              return el('li', {
                text: `${rest.title}　${formatMinutes(fragment.startMinutes)}–${formatMinutes(fragment.endMinutes)}`,
              });
            }),
          ),
          el('div.card__hint', { text: '保存时会**替换**掉今晚这几条，不会重复创建。' }),
        ]),
      ]),
    ]);
  }

  /* ---------------- 界面骨架 ---------------- */
  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(560px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  const modeSwitch = el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
    button('仅设置今晚休息', { variant: 'primary', size: 'sm', onClick: () => setMode('tonight') }),
    button('固定睡觉时间', { variant: 'default', size: 'sm', onClick: () => setMode('weekly') }),
  ]);

  const tonightPanel = el('div', {}, [
    el('p.card__hint', {
      text: '一次性的安排：只影响今晚，不会变成每周重复规则。跨过午夜的部分会自动显示在明天。',
    }),
    el('div.form-grid', {}, [
      fieldWrap('名称', tonight.title, `最多 ${TASK_NAME_MAX_LENGTH} 个字符`),
    ]),
    el('div.form-grid', {}, [
      fieldWrap('今晚开始', tonight.start),
      fieldWrap('明天结束', tonight.end, '结束时间早于开始时间时，按"次日"理解'),
    ]),
    tonightListHost,
  ]);

  const weeklyPanel = el('div', {}, [
    el('p.card__hint', {
      text: '长期重复规则：勾选的每一天都会生效，之后每一周都继续出现（不是一个 7 天的临时安排）。',
    }),
    el('div.form-grid', {}, [
      fieldWrap('名称', weekly.title, `最多 ${TASK_NAME_MAX_LENGTH} 个字符`),
    ]),
    el('div.form-grid', {}, [
      fieldWrap('睡觉时间', weekly.start),
      fieldWrap('起床时间', weekly.end, '跨午夜时自动拆到次日显示'),
    ]),
    el('div.form-field', {}, [
      el('label', { text: '重复的星期' }),
      el(
        'div.form-actions',
        { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } },
        WEEKDAY_OPTIONS.map((option) =>
          el('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } }, [
            el('input', {
              type: 'checkbox',
              checked: weekly.days.has(option.value),
              on: {
                change: (event) => {
                  if (event.target.checked) weekly.days.add(option.value);
                  else weekly.days.delete(option.value);
                  refreshPreview();
                },
              },
            }),
            el('span', { text: `周${option.label}` }),
          ]),
        ),
      ),
    ]),
  ]);

  append(dialog, [
    el('form', {
      on: {
        submit: (event) => {
          event.preventDefault();
          submit();
        },
      },
    }, [
      el('h2', { text: '设置休息', style: { marginBottom: 'var(--space-2)' } }),
      modeSwitch,
      el('div', { id: 'rs-panels' }, [tonightPanel, weeklyPanel]),
      previewHost,
      errorHost,
      el('div.form-actions', {}, [
        button('取消', { variant: 'ghost', onClick: () => close() }),
        el('button.btn.btn--primary', { type: 'submit', text: '保存' }),
      ]),
    ]),
  ]);

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function fieldWrap(labelText, input, hint) {
    return el('div.form-field', {}, [
      el('label', { for: input.id, text: labelText }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  }

  function setMode(mode) {
    state.mode = mode;
    tonightPanel.hidden = mode !== 'tonight';
    weeklyPanel.hidden = mode !== 'weekly';
    refreshTonightList();
    refreshPreview();
  }

  /* ---------------- 预览与校验 ---------------- */
  function collectTonight() {
    const startMinutes = toMinutes(tonight.start.value);
    const endMinutes = toMinutes(tonight.end.value);
    const crossesMidnight = endMinutes <= startMinutes;
    return {
      title: tonight.title.value.trim(),
      startDate: today,
      startMinutes,
      endDate: crossesMidnight ? tomorrow : today,
      endMinutes,
      note: '',
    };
  }

  function collectWeekly() {
    return {
      title: weekly.title.value.trim(),
      type: FIXED_ACTIVITY_TYPE.SLEEP,
      recurrence: { kind: 'weekly', daysOfWeek: [...weekly.days].sort((a, b) => a - b) },
      start: weekly.start.value,
      end: weekly.end.value,
      movable: false,
      note: '',
    };
  }

  function refreshPreview() {
    clear(previewHost);
    if (state.mode === 'tonight') {
      const values = collectTonight();
      if (!Number.isInteger(values.startMinutes) || !Number.isInteger(values.endMinutes)) {
        previewHost.textContent = '填写开始与结束时间后，这里会显示这次休息会出现在哪几天。';
        return;
      }
      const fragments = splitForPreview(values);
      const total = fragments.reduce((sum, item) => sum + item.minutes, 0);
      previewHost.textContent = `将显示为：${fragments
        .map((item) => `${item.date} ${formatMinutes(item.startMinutes)}–${formatMinutes(item.endMinutes)}`)
        .join('；')}（合计 ${formatDuration(total)}）`;
      return;
    }
    const startMinutes = toMinutes(weekly.start.value);
    const endMinutes = toMinutes(weekly.end.value);
    const days = [...weekly.days].sort((a, b) => a - b);
    if (startMinutes === null || endMinutes === null || days.length === 0 || startMinutes === endMinutes) {
      previewHost.textContent = '至少选择一天，并填写不相同的睡觉与起床时间。';
      return;
    }
    const span = endMinutes <= startMinutes ? endMinutes + 1440 - startMinutes : endMinutes - startMinutes;
    previewHost.textContent = `每周 ${days.map((day) => `周${WEEKDAY_OPTIONS.find((o) => o.value === day).label}`).join('、')}　${formatMinutes(startMinutes)}–${formatMinutes(endMinutes % 1440 === 0 ? 1440 : endMinutes)}（每天 ${formatDuration(span)}，跨夜自动拆到次日）`;
  }

  for (const input of [tonight.title, tonight.start, tonight.end]) {
    input.addEventListener('input', refreshPreview);
    input.addEventListener('change', refreshPreview);
  }
  for (const input of [weekly.title, weekly.start, weekly.end]) {
    input.addEventListener('input', refreshPreview);
    input.addEventListener('change', refreshPreview);
  }

  function showErrors(issues) {
    clear(errorHost);
    const errors = (issues ?? []).filter((issue) => issue.severity !== 'info');
    if (errors.length === 0) return;
    append(errorHost, [
      el('div.notice.notice--danger', { role: 'alert' }, [
        el('div', {}, [
          el('div.notice__title', { text: '还不能保存' }),
          el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, errors.map((issue) => el('li', { text: issue.message }))),
        ]),
      ]),
    ]);
  }

  async function submit() {
    try {
      await submitInner();
    } catch (error) {
      showErrors([{ severity: 'error', message: `保存时出错：${error?.message ?? error}` }]);
    }
  }

  async function submitInner() {
    clear(errorHost);
    return state.mode === 'tonight' ? await saveTonight() : await saveWeekly();
  }

  /** 模式 A：一次性休息（若今晚已有则替换） */
  async function saveTonight() {
    const values = collectTonight();
    const localIssues = [];
    if (!values.title) localIssues.push({ severity: 'error', message: '请填写名称。' });
    else if ([...values.title].length > TASK_NAME_MAX_LENGTH) {
      localIssues.push({ severity: 'error', message: `名称最多 ${TASK_NAME_MAX_LENGTH} 个字符。` });
    }
    if (!Number.isInteger(values.startMinutes) || !Number.isInteger(values.endMinutes)) {
      localIssues.push({ severity: 'error', message: '请填写合法的开始与结束时间。' });
    } else if (values.startMinutes === values.endMinutes && values.endDate === values.startDate) {
      localIssues.push({ severity: 'error', message: '开始和结束时间相同，无法确定休息时长。' });
    } else if (values.endDate === today && values.endMinutes <= values.startMinutes) {
      localIssues.push({ severity: 'error', message: '结束时间必须晚于开始时间。' });
    }
    if (localIssues.length > 0) {
      showErrors(localIssues);
      return;
    }

    // 今天已经过去的晚上时段：明确提示，不静默保存"已经过去"的休息
    if (values.startMinutes < services.now().minutes && values.endDate === today) {
      showErrors([
        {
          severity: 'error',
          message: `今晚的开始时间（${formatMinutes(values.startMinutes)}）已经过去了。请把结束时间设到明天，或改一个还没到的时间。`,
        },
      ]);
      return;
    }

    const conflicts = services.restService.findConflicts({ id: 'new', ...values });
    if (conflicts.conflicts.length > 0) {
      const confirmed = await confirmDialog({
        title: '这段时间与已有安排重叠',
        message: '休息可以覆盖在其它安排之上，但需要你确认——应用不会自动移动或删除那边的安排。',
        bullets: conflicts.conflicts.slice(0, 5).map(
          (item) => `${item.date} ${formatMinutes(item.startMinutes)}–${formatMinutes(item.endMinutes)} 的「${item.title}」（重叠 ${item.overlapMinutes} 分钟）`,
        ),
        confirmLabel: '仍然保存',
        confirmVariant: 'primary',
      });
      if (!confirmed) return;
    }

    // 替换今晚已有的休息：删除旧的 + 新增，全部在一次提交里完成
    const replaced = existingTonight();
    const first = services.ui.saveRest({ kind: 'rest.add', input: values });
    if (!first.ok) {
      showErrors(first.issues ?? [{ severity: 'error', message: '保存失败。' }]);
      return;
    }
    for (const rest of replaced) {
      services.ui.deleteRest(rest.id, { silent: true });
    }
    close();
  }

  /** 模式 B：每周重复的固定睡觉时间 */
  function saveWeekly() {
    const values = collectWeekly();
    const localIssues = [];
    if (!values.title) localIssues.push({ severity: 'error', message: '请填写名称。' });
    else if ([...values.title].length > TASK_NAME_MAX_LENGTH) {
      localIssues.push({ severity: 'error', message: `名称最多 ${TASK_NAME_MAX_LENGTH} 个字符。` });
    }
    if (values.recurrence.daysOfWeek.length === 0) localIssues.push({ severity: 'error', message: '请至少选择一天。' });
    if (values.start === values.end) localIssues.push({ severity: 'error', message: '睡觉与起床时间不能相同。' });
    if (localIssues.length > 0) {
      showErrors(localIssues);
      return;
    }

    // 注意：带数据变更必须走 previewWith（requestPreview 是"只重新规划"，
    // 不会带上 ops——用错入口的表现就是"看起来什么都没发生"）。
    const result = services.ui.previewWith([{ kind: 'fixedActivity.add', input: values }], {
      changeSummary: `设置固定睡觉时间（每周 ${values.recurrence.daysOfWeek.length} 天）`,
      trigger: 'rest-settings',
    });
    if (!result.ok) {
      showErrors(result.issues ?? [{ severity: 'error', message: result.message ?? '保存失败。' }]);
      return;
    }
    // 固定睡觉时间是**固定任务**，因此走和其它固定任务一致的"候选计划预览 → 确认"流程。
    // 这样重复规则会真正写进固定任务表，之后每一周都继续生效。
    toast('已生成候选计划预览，确认应用后固定睡觉时间才会生效。', 'success', 6000);
    close();
  }

  function close() {
    dialog.close();
    dialog.remove();
  }

  setMode('tonight');
  document.body.appendChild(dialog);
  dialog.showModal();
  tonight.title.focus();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function splitForPreview(values) {
  // 只做展示用的最小拆分：首日到 24:00，其余到结束时间
  const fragments = [];
  if (values.endDate === values.startDate) {
    return [{ date: values.startDate, startMinutes: values.startMinutes, endMinutes: values.endMinutes, minutes: values.endMinutes - values.startMinutes }];
  }
  fragments.push({ date: values.startDate, startMinutes: values.startMinutes, endMinutes: 1440, minutes: 1440 - values.startMinutes });
  fragments.push({ date: values.endDate, startMinutes: 0, endMinutes: values.endMinutes, minutes: values.endMinutes });
  return fragments;
}

function toMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

function minutesToHHmm(minutes) {
  const wrapped = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function addDaysLocal(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
