/**
 * 休息时间表单（新建 / 编辑）。
 *
 * 与固定任务表单的区别（有意为之）：
 * - 不复用固定任务的重复规则：本轮只要求"一次具体时段"，不做复杂的重复休息；
 * - 保存为独立的 `restPeriods` 实体，不混进固定任务或学习任务；
 * - 保存前会检查与固定任务/学习时段/其它休息的重叠，并**如实提示**，不静默覆盖。
 *
 * 跨午夜由底层一条记录承载，界面只需要如实显示"这次休息会被拆到哪几天"。
 */

import { append, clear, el, toast } from '../dom.js';
import { button } from '../components.js';
import { formatIssue, TASK_NAME_MAX_LENGTH } from '../../domain/validation.js';
import { formatDuration, formatMinutes, isValidDateString, isValidTimeString } from '../../domain/time.js';
import { validateRestPeriod, splitRestAcrossDates } from '../../domain/restPeriod.js';
import { confirmDialog } from '../modal.js';

/**
 * @param {object} options
 * @param {object|null} options.rest 编辑时传入现有休息安排
 * @param {object} options.services
 */
export function openRestForm({ rest = null, services }) {
  const isEdit = Boolean(rest);
  const today = services.now().date;
  const base = rest
    ? {
        title: rest.title,
        startDate: rest.startDate,
        start: minutesToHHmm(rest.startMinutes),
        endDate: rest.endDate,
        end: minutesToHHmm(rest.endMinutes),
        note: rest.note ?? '',
      }
    : {
        title: '',
        startDate: today,
        start: '12:00',
        endDate: today,
        end: '12:30',
        note: '',
      };

  const inputs = {};
  const errorHost = el('div', { id: 'rest-form-errors' });
  const previewHost = el('div.card__hint', { 'aria-live': 'polite' });

  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(560px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  function field(key, labelText, { type = 'text', hint, maxlength, value } = {}) {
    const input = el('input', { type, id: `rf-${key}`, maxlength, value: value ?? base[key] ?? '' });
    inputs[key] = input;
    return el('div.form-field', {}, [
      el('label', { for: `rf-${key}`, text: labelText }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  }

  const form = el('form', {
    on: {
      submit: (event) => {
        event.preventDefault();
        submit();
      },
    },
  });

  append(form, [
    el('h2', { text: isEdit ? `编辑休息时间：${rest.title}` : '添加休息时间', style: { marginBottom: 'var(--space-4)' } }),
    errorHost,
    el('fieldset', {}, [
      el('legend', { text: '基本信息' }),
      el('div.form-grid', {}, [
        field('title', `名称（必填，最多 ${TASK_NAME_MAX_LENGTH} 个字符）`, {
          maxlength: String(TASK_NAME_MAX_LENGTH),
          hint: '例如：午休、散步、放空',
        }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '开始' }),
      el('div.form-grid', {}, [
        field('startDate', '开始日期', { type: 'date' }),
        field('start', '开始时间', { type: 'time' }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '结束' }),
      el('div.form-grid', {}, [
        field('endDate', '结束日期', { type: 'date', hint: '结束日期晚于开始日期即跨夜/多天休息' }),
        field('end', '结束时间', { type: 'time', hint: '结束时间早于开始时间时，请把结束日期设成次日' }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '备注（可选）' }),
      el('div.form-grid', {}, [field('note', '备注')]),
    ]),
    previewHost,
    el('div.form-actions', {}, [
      button('取消', { variant: 'ghost', onClick: () => close() }),
      el('button.btn.btn--primary', { type: 'submit', text: isEdit ? '保存休息时间' : '添加休息时间' }),
    ]),
  ]);

  append(dialog, [form]);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function collect() {
    return {
      title: inputs.title.value.trim(),
      startDate: inputs.startDate.value,
      startMinutes: toMinutes(inputs.start.value),
      endDate: inputs.endDate.value,
      endMinutes: toMinutes(inputs.end.value),
      note: inputs.note.value,
    };
  }

  /** 实时预览：这次休息会被拆到哪几天 */
  function refreshPreview() {
    clear(previewHost);
    const values = collect();
    const probe = { id: 'preview', ...values };
    const fragments = splitRestAcrossDates(probe);
    if (fragments.length === 0) {
      previewHost.textContent = '填写完整后，这里会显示这次休息会出现在哪几天。';
      return;
    }
    previewHost.textContent = `将显示为：${fragments
      .map((fragment) => `${fragment.date} ${formatMinutes(fragment.startMinutes)}–${formatMinutes(fragment.endMinutes)}（${formatDuration(fragment.minutes)}）`)
      .join('；')}`;
  }

  for (const key of ['startDate', 'start', 'endDate', 'end']) {
    inputs[key].addEventListener('change', refreshPreview);
    inputs[key].addEventListener('input', refreshPreview);
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

  async function submit() {
    const values = collect();

    // 本地先做格式校验，避免把明显错误的数据送到数据层
    const localIssues = [];
    if (!values.title) {
      localIssues.push({ severity: 'error', code: 'V001', message: '请填写休息时间名称。' });
    } else if ([...values.title].length > TASK_NAME_MAX_LENGTH) {
      localIssues.push({
        severity: 'error',
        code: 'V005',
        message: `休息时间名称最多 ${TASK_NAME_MAX_LENGTH} 个字符（当前 ${[...values.title].length} 个）。`,
      });
    }
    if (!isValidDateString(values.startDate) || !isValidDateString(values.endDate)) {
      localIssues.push({ severity: 'error', code: 'V001', message: '请选择合法的开始与结束日期。' });
    }
    if (!isValidTimeString(inputs.start.value) || !isValidTimeString(inputs.end.value)) {
      localIssues.push({ severity: 'error', code: 'V001', message: '请选择合法的开始与结束时间。' });
    }
    if (localIssues.length > 0) {
      showErrors(localIssues);
      return;
    }

    // 业务校验：与保存时使用的是同一套规则（domain/restPeriod.js）
    const validation = validateRestPeriod({ id: rest?.id ?? 'new', ...values }, 'rest');
    if (!validation.ok) {
      showErrors(validation.errors);
      return;
    }

    // 冲突检查：如实提示，由用户确认
    const conflicts = services.restService.findConflicts({ id: rest?.id ?? 'new', ...values }, { ignoreRestId: rest?.id ?? null });
    if (conflicts.conflicts.length > 0) {
      const preview = conflicts.conflicts
        .slice(0, 6)
        .map(
          (item) =>
            `${item.date} ${formatMinutes(item.startMinutes)}–${formatMinutes(item.endMinutes)} 的「${item.title}」（${kindLabel(item.kind)}，重叠 ${item.overlapMinutes} 分钟）`,
        );
      const confirmed = await confirmDialog({
        title: '这段时间与已有安排重叠',
        message: '休息时间可以覆盖在其它安排之上，但需要你确认——应用不会自动移动或删除那边的安排。',
        bullets: [...preview, conflicts.conflicts.length > 6 ? `…还有 ${conflicts.conflicts.length - 6} 处重叠` : null].filter(Boolean),
        confirmLabel: '仍然保存',
        confirmVariant: 'primary',
      });
      if (!confirmed) return;
    }

    const op = isEdit
      ? { kind: 'rest.update', restId: rest.id, patch: values }
      : { kind: 'rest.add', input: values };

    const result = services.ui.saveRest(op);
    if (!result.ok) {
      showErrors(result.issues?.length ? result.issues : [{ severity: 'error', message: '保存失败。' }]);
      return;
    }
    toast(isEdit ? '休息时间已更新。' : '休息时间已添加。', 'success');
    close();
  }

  function close() {
    dialog.close();
    dialog.remove();
  }

  refreshPreview();
  document.body.appendChild(dialog);
  dialog.showModal();
  inputs.title.focus();
}

function kindLabel(kind) {
  if (kind === 'fixed') return '固定任务';
  if (kind === 'study') return '学习任务';
  if (kind === 'rest') return '休息时间';
  return '安排';
}

function toMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

function minutesToHHmm(minutes) {
  const wrapped = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
