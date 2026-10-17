/**
 * 固定活动表单（新建 / 编辑）。
 *
 * 与任务表单一致：字段与 `domain/fixedActivity.js` 的模型一一对应，
 * 提交时**只生成候选计划预览**，由用户在预览页确认后才写入数据。
 */

import { append, clear, el, toast } from '../dom.js';
import { button } from '../components.js';
import { FIXED_ACTIVITY_TYPE, FIXED_ACTIVITY_TYPE_LABELS_ZH } from '../../domain/fixedActivity.js';
import { formatIssue, TASK_NAME_MAX_LENGTH } from '../../domain/validation.js';
import { isValidDateString, isValidTimeString, WEEKDAY_NAMES_ZH } from '../../domain/time.js';

/**
 * @param {object} options
 * @param {object|null} options.activity 编辑时传入现有固定活动；新建时传 null
 * @param {object} options.services
 */
export function openFixedActivityForm({ activity = null, services }) {
  const isEdit = Boolean(activity);
  const base = activity
    ? {
        title: activity.title,
        type: activity.type,
        recurrence: cloneRecurrence(activity.recurrence),
        start: minutesToHHmm(activity.startMinutes),
        end: minutesToHHmm(activity.endMinutes),
        activeFrom: activity.activeFrom ?? '',
        activeTo: activity.activeTo ?? '',
        note: activity.note ?? '',
      }
    : {
        title: '',
        type: FIXED_ACTIVITY_TYPE.CLASS,
        recurrence: { kind: 'weekly', daysOfWeek: [] },
        start: '08:00',
        end: '09:40',
        activeFrom: '',
        activeTo: '',
        note: '',
      };

  const inputs = {};
  const errorHost = el('div', { id: 'activity-form-errors' });
  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(640px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  function textField(key, labelText, { type = 'text', hint, value, maxlength } = {}) {
    const input = el('input', { type, id: `af-${key}`, maxlength, value: value ?? base[key] ?? '' });
    inputs[key] = input;
    return el('div.form-field', {}, [
      el('label', { for: `af-${key}`, text: labelText }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  }

  // 类型
  const typeSelect = el('select', { id: 'af-type' });
  for (const type of Object.values(FIXED_ACTIVITY_TYPE)) {
    typeSelect.appendChild(
      el('option', { value: type, selected: base.type === type, text: FIXED_ACTIVITY_TYPE_LABELS_ZH[type] ?? type }),
    );
  }
  inputs.type = typeSelect;

  // 重复规则
  const weeklyRadio = el('input', { type: 'radio', name: 'af-recurrence', value: 'weekly', id: 'af-weekly', checked: base.recurrence.kind === 'weekly' });
  const onceRadio = el('input', { type: 'radio', name: 'af-recurrence', value: 'once', id: 'af-once', checked: base.recurrence.kind === 'once' });
  const dayCheckboxes = new Map();
  const dayRow = el(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' } },
    [1, 2, 3, 4, 5, 6, 7].map((day) => {
      const checkbox = el('input', {
        type: 'checkbox',
        id: `af-day-${day}`,
        value: String(day),
        checked: base.recurrence.kind === 'weekly' && (base.recurrence.daysOfWeek ?? []).includes(day),
      });
      dayCheckboxes.set(day, checkbox);
      return el('label', { for: `af-day-${day}`, style: { display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontWeight: '400' } }, [
        checkbox,
        el('span', { text: WEEKDAY_NAMES_ZH[day - 1] }),
      ]);
    }),
  );
  const onceDateInput = el('input', { type: 'date', id: 'af-once-date', value: base.recurrence.kind === 'once' ? base.recurrence.date : services.ui.today() });
  inputs.onceDate = onceDateInput;

  const weeklyBlock = el('div', {}, [dayRow]);
  const onceBlock = el('div', {}, [el('label', { for: 'af-once-date', text: '日期' }), onceDateInput]);
  const syncRecurrenceVisibility = () => {
    const weekly = weeklyRadio.checked;
    weeklyBlock.style.display = weekly ? '' : 'none';
    onceBlock.style.display = weekly ? 'none' : '';
  };
  weeklyRadio.addEventListener('change', syncRecurrenceVisibility);
  onceRadio.addEventListener('change', syncRecurrenceVisibility);

  const form = el('form', {
    on: {
      submit: (event) => {
        event.preventDefault();
        submit();
      },
    },
  });

  append(form, [
    el('h2', { text: isEdit ? `编辑固定活动：${activity.title}` : '新建固定活动', style: { marginBottom: 'var(--space-4)' } }),
    errorHost,
    el('fieldset', {}, [
      el('legend', { text: '基本信息' }),
      el('div.form-grid', {}, [
        textField('title', `名称（必填，最多 ${TASK_NAME_MAX_LENGTH} 个字符）`, {
          maxlength: String(TASK_NAME_MAX_LENGTH),
          hint: '例如：高数课、午睡、午餐、社团',
        }),
        el('div.form-field', {}, [el('label', { for: 'af-type', text: '类型' }), typeSelect]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '时间' }),
      el('div.form-grid', {}, [
        textField('start', '开始时间（HH:mm）', { type: 'time' }),
        textField('end', '结束时间（HH:mm）', { type: 'time', hint: '结束时间早于开始时间表示跨午夜（例如睡眠 23:30 → 07:00）' }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '重复方式' }),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' } }, [
        el('label', { for: 'af-weekly', style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: '400' } }, [
          weeklyRadio,
          el('span', { text: '每周重复（选择星期几）' }),
        ]),
        weeklyBlock,
        el('label', { for: 'af-once', style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: '400', marginTop: 'var(--space-2)' } }, [
          onceRadio,
          el('span', { text: '仅一次（指定日期）' }),
        ]),
        onceBlock,
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '生效区间（可选，例如只在学期内生效）' }),
      el('div.form-grid', {}, [
        textField('activeFrom', '开始生效日期', { type: 'date' }),
        textField('activeTo', '结束生效日期', { type: 'date' }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '备注（可选）' }),
      el('div.form-grid', {}, [textField('note', '备注')]),
    ]),
    el('div.form-actions', {}, [
      button('取消', { variant: 'ghost', onClick: () => close() }),
      el('button.btn.btn--primary', { type: 'submit', text: isEdit ? '保存并生成预览' : '新增并生成预览' }),
    ]),
  ]);

  append(dialog, [form]);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function collect() {
    const weekly = weeklyRadio.checked;
    const days = [...dayCheckboxes.entries()].filter(([, checkbox]) => checkbox.checked).map(([day]) => day);
    return {
      title: inputs.title.value.trim(),
      type: inputs.type.value,
      recurrence: weekly ? { kind: 'weekly', daysOfWeek: days } : { kind: 'once', date: inputs.onceDate.value },
      start: inputs.start.value,
      end: inputs.end.value,
      activeFrom: inputs.activeFrom.value || null,
      activeTo: inputs.activeTo.value || null,
      note: inputs.note.value,
    };
  }

  function showErrors(issues) {
    clear(errorHost);
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length === 0) return;
    append(errorHost, [
      el('div.notice.notice--danger', { role: 'alert' }, [
        el('div', {}, [
          el('div.notice__title', { text: `有 ${errors.length} 处需要修正` }),
          el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, errors.map((issue) => el('li', { text: formatIssue(issue) }))),
        ]),
      ]),
    ]);
    errorHost.scrollIntoView({ block: 'nearest' });
  }

  function submit() {
    const values = collect();
    const localIssues = [];
    if (!values.title) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'title', message: '请填写固定任务名称。' });
    } else if ([...values.title].length > TASK_NAME_MAX_LENGTH) {
      localIssues.push({
        severity: 'error',
        code: 'V005',
        path: 'title',
        message: `固定任务名称最多 ${TASK_NAME_MAX_LENGTH} 个字符（当前 ${[...values.title].length} 个）。`,
      });
    }
    if (!isValidTimeString(values.start)) localIssues.push({ severity: 'error', code: 'V001', path: 'start', message: '开始时间格式应为 HH:mm。' });
    if (!isValidTimeString(values.end)) localIssues.push({ severity: 'error', code: 'V001', path: 'end', message: '结束时间格式应为 HH:mm。' });
    if (values.recurrence.kind === 'weekly' && values.recurrence.daysOfWeek.length === 0) {
      localIssues.push({ severity: 'error', code: 'V040', path: 'recurrence', message: '每周重复至少要选择一天。' });
    }
    if (values.recurrence.kind === 'once' && !isValidDateString(values.recurrence.date)) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'recurrence.date', message: '请选择这一天的日期。' });
    }
    if (values.activeFrom && !isValidDateString(values.activeFrom)) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'activeFrom', message: '生效开始日期格式应为 YYYY-MM-DD。' });
    }
    if (values.activeTo && !isValidDateString(values.activeTo)) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'activeTo', message: '生效结束日期格式应为 YYYY-MM-DD。' });
    }
    if (localIssues.length > 0) {
      showErrors(localIssues);
      return;
    }

    const op = isEdit
      ? { kind: 'fixedActivity.update', activityId: activity.id, patch: values }
      : { kind: 'fixedActivity.add', input: values };

    const result = services.ui.previewWith([op], {
      changeSummary: isEdit ? `修改固定活动「${values.title}」` : `新增固定活动「${values.title}」`,
      trigger: 'activity-form',
    });
    if (!result.ok) {
      showErrors(result.issues?.length ? result.issues : [{ severity: 'error', code: 'V000', path: '', message: result.message ?? '无法生成预览。' }]);
      return;
    }
    toast('已生成候选计划预览，请检查影响后确认应用。', 'success', 6000);
    close();
  }

  function close() {
    dialog.close();
    dialog.remove();
  }

  syncRecurrenceVisibility();
  document.body.appendChild(dialog);
  dialog.showModal();
  inputs.title.focus();
}

function cloneRecurrence(recurrence) {
  if (!recurrence) return { kind: 'weekly', daysOfWeek: [] };
  if (recurrence.kind === 'weekly') return { kind: 'weekly', daysOfWeek: [...(recurrence.daysOfWeek ?? [])] };
  return { kind: 'once', date: recurrence.date };
}

function minutesToHHmm(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
