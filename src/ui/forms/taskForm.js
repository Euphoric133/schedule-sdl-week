/**
 * 任务表单（新建 / 编辑）。
 *
 * 设计原因：
 * - 字段与 domain/task.js 的模型一一对应，校验也复用 domain 的 validateTask，
 *   因此界面里不存在"第二套规则"，不会出现"界面能提交但引擎读不懂"的数据。
 * - **提交只生成候选计划预览**：任务数据不会立即写入，
 *   而是先随候选计划一起展示影响，用户确认后才事务式落盘。放弃预览则什么都不变。
 * - 表单先做本地校验并就近显示错误，全部通过后才请求预览；失败时保留用户输入。
 */

import { append, clear, el, toast } from '../dom.js';
import { button } from '../components.js';
import { TASK_STATUS, TITLE_MAX_LENGTH, SUBJECT_MAX_LENGTH, createTaskDraft } from '../../domain/task.js';
import { formatIssue } from '../../domain/validation.js';
import { isValidDateString, isValidTimeString } from '../../domain/time.js';

/**
 * 打开任务表单对话框。
 * @param {object} options
 * @param {object|null} options.task 编辑时传入现有任务；新建时传 null
 * @param {object} options.services
 */
export function openTaskForm({ task = null, services }) {
  const isEdit = Boolean(task);
  const base = task
    ? {
        title: task.title,
        subject: task.subject,
        plannedMinutes: task.plannedMinutes,
        priorCompletedMinutes: task.priorCompletedMinutes ?? 0,
        deadlineDate: task.deadlineDate,
        deadlineTime: task.deadlineTime,
        importance: task.importance,
        difficulty: task.difficulty,
        procrastination: task.procrastination,
        splittable: task.splittable,
        minChunkMinutes: task.minChunkMinutes,
        maxChunkMinutes: task.maxChunkMinutes,
        dependsOn: [...(task.dependsOn ?? [])],
        note: task.note ?? '',
      }
    : { ...createTaskDraft(), deadlineDate: services.now().date };

  const inputs = {};
  const errorHost = el('div', { id: 'task-form-errors' });

  /** 实时显示"剩余时长"，让用户一眼看清这次填写会产生多少待安排工作量 */
  const remainingHint = el('div.form-field__hint', { 'aria-live': 'polite' });
  function updateRemainingHint() {
    const planned = Number.parseInt(inputs.plannedMinutes?.value ?? '', 10);
    const prior = Number.parseInt(inputs.priorCompletedMinutes?.value ?? '0', 10);
    if (!Number.isFinite(planned)) {
      remainingHint.textContent = '填写预计总用时后，这里会显示剩余时长。';
      return;
    }
    const done = Number.isFinite(prior) && prior > 0 ? prior : 0;
    const remaining = planned - done;
    if (remaining < 0) {
      remainingHint.textContent = `已完成（${done} 分钟）超过了预计总用时（${planned} 分钟），请调整。`;
      return;
    }
    remainingHint.textContent = `剩余时长：${remaining} 分钟（预计总用时 ${planned} − 已完成 ${done}）`;
  }

  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(760px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  function textField(key, labelText, { type = 'text', hint, min, max, step, maxlength, placeholder } = {}) {
    const input = el('input', {
      type,
      min,
      max,
      step,
      maxlength,
      placeholder,
      value: base[key] ?? '',
      id: `tf-${key}`,
    });
    inputs[key] = input;
    return el('div.form-field', {}, [
      el('label', { for: `tf-${key}`, text: labelText }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  }

  function ratingField(key, labelText) {
    const select = el('select', { id: `tf-${key}` });
    for (let value = 1; value <= 5; value += 1) {
      select.appendChild(el('option', { value: String(value), selected: Number(base[key]) === value, text: `${value}（${ratingHint(key, value)}）` }));
    }
    inputs[key] = select;
    return el('div.form-field', {}, [el('label', { for: `tf-${key}`, text: labelText }), select]);
  }

  const splittable = el('input', { type: 'checkbox', id: 'tf-splittable', checked: base.splittable });
  inputs.splittable = splittable;

  const dependsHost = el('div', { style: { maxHeight: '160px', overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-2)' } });
  const candidates = services.taskService
    .getTasks()
    .filter((t) => t.id !== task?.id && t.status !== TASK_STATUS.DELETED);
  if (candidates.length === 0) {
    append(dependsHost, [el('div.form-field__hint', { text: '当前没有其它可用于依赖的任务。' })]);
  } else {
    for (const candidate of candidates) {
      const checkbox = el('input', {
        type: 'checkbox',
        value: candidate.id,
        checked: base.dependsOn.includes(candidate.id),
        id: `dep-${candidate.id}`,
      });
      append(dependsHost, [
        el('label', { for: `dep-${candidate.id}`, style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontWeight: '400' } }, [
          checkbox,
          el('span', { text: `${candidate.subject} · ${candidate.title}（截止 ${candidate.deadlineDate}）` }),
        ]),
      ]);
    }
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
    el('h2', { text: isEdit ? `编辑任务：${task.title}` : '新建学习任务', style: { marginBottom: 'var(--space-4)' } }),
    errorHost,
    el('fieldset', {}, [
      el('legend', { text: '基本信息' }),
      el('div.form-grid', {}, [
        textField('title', `任务名称（必填，最多 ${TITLE_MAX_LENGTH} 个字符）`, {
          maxlength: String(TITLE_MAX_LENGTH),
          hint: `中文、emoji 都按 1 个字符计算，最多 ${TITLE_MAX_LENGTH} 个`,
        }),
        textField('subject', `所属科目（必填，最多 ${SUBJECT_MAX_LENGTH} 字）`, { hint: '例如：高等数学、英语、物理实验' }),
        textField('note', '备注（可选）'),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '工作量与拆分' }),
      el('div.form-grid', {}, [
        textField('plannedMinutes', '预计总用时（分钟，必填）', { type: 'number', min: 5, step: 5, hint: '必须是 5 的倍数，例如 45、90' }),
        el('div.form-field', {}, [
          el('label', { for: 'af-priorCompleted', text: '已经完成（分钟，可留 0）' }),
          (() => {
            const input = el('input', {
              type: 'number',
              id: 'af-priorCompleted',
              min: '0',
              step: '5',
              value: String(task?.priorCompletedMinutes ?? 0),
              on: { input: () => updateRemainingHint() },
            });
            inputs.priorCompletedMinutes = input;
            return input;
          })(),
          el('div.form-field__hint', {
            text: '在应用之外完成的部分（纸质作业、线下课等）。填写后剩余时长会相应减少，排程不会再安排这部分。',
          }),
          remainingHint,
        ]),
        el('div.form-field', {}, [
          el('label', { for: 'tf-splittable' }, [splittable, el('span', { text: ' 允许拆分到多天/多段' })]),
          el('div.form-field__hint', { text: '不勾选时，该任务必须一次安排完整个时长（不可拆分）。' }),
        ]),
        textField('minChunkMinutes', '最短学习时段（分钟）', { type: 'number', min: 5, step: 5 }),
        textField('maxChunkMinutes', '最长学习时段（分钟）', { type: 'number', min: 5, step: 5 }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '截止时间' }),
      el('div.form-grid', {}, [
        textField('deadlineDate', '截止日期（YYYY-MM-DD）', { type: 'date' }),
        textField('deadlineTime', '截止时间（HH:mm）', { type: 'time' }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '评估（1 = 最低，5 = 最高，用于计算优先级，不改变硬约束）' }),
      el('div.grid-3', {}, [ratingField('importance', '重要程度'), ratingField('difficulty', '难度'), ratingField('procrastination', '拖延风险')]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '前置任务（必须先完成它们，本任务才会被安排）' }),
      dependsHost,
    ]),
    el('div.form-actions', {}, [
      button('取消', { variant: 'ghost', onClick: () => close() }),
      el('button.btn.btn--primary', { type: 'submit', text: isEdit ? '保存并生成预览' : '创建并生成预览' }),
    ]),
  ]);

  append(dialog, [form]);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function collect() {
    const checkedDeps = Array.from(dependsHost.querySelectorAll('input[type=checkbox]:checked')).map((node) => node.value);
    return {
      title: inputs.title.value.trim(),
      subject: inputs.subject.value.trim(),
      plannedMinutes: Number.parseInt(inputs.plannedMinutes.value, 10),
      priorCompletedMinutes: Number.parseInt(inputs.priorCompletedMinutes.value, 10) || 0,
      deadlineDate: inputs.deadlineDate.value,
      deadlineTime: inputs.deadlineTime.value,
      importance: Number.parseInt(inputs.importance.value, 10),
      difficulty: Number.parseInt(inputs.difficulty.value, 10),
      procrastination: Number.parseInt(inputs.procrastination.value, 10),
      splittable: inputs.splittable.checked,
      minChunkMinutes: Number.parseInt(inputs.minChunkMinutes.value, 10),
      maxChunkMinutes: Number.parseInt(inputs.maxChunkMinutes.value, 10),
      dependsOn: checkedDeps,
      note: inputs.note.value,
    };
  }

  function showErrors(issues) {
    clear(errorHost);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length === 0) return;
    append(errorHost, [
      el('div.notice.notice--danger', { role: 'alert' }, [
        el('div', {}, [
          el('div.notice__title', { text: `有 ${errors.length} 处需要修正` }),
          el(
            'ul',
            { style: { margin: 0, paddingLeft: '1.2em' } },
            errors.map((issue) => el('li', { text: formatIssue(issue) })),
          ),
        ]),
      ]),
    ]);
    errorHost.scrollIntoView({ block: 'nearest' });
  }

  function submit() {
    const values = collect();

    // 本地格式校验（日历合法性与时刻格式），避免把明显错误的数据送到数据层
    const localIssues = [];
    if (!isValidDateString(values.deadlineDate)) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'deadlineDate', message: '请填写合法的截止日期（例如 2025-10-20）。' });
    }
    if (!isValidTimeString(values.deadlineTime)) {
      localIssues.push({ severity: 'error', code: 'V001', path: 'deadlineTime', message: '请填写合法的截止时间（例如 23:00）。' });
    }
    if ([...values.title].length > TITLE_MAX_LENGTH) {
      localIssues.push({
        severity: 'error',
        code: 'V005',
        path: 'title',
        message: `任务名称最多 ${TITLE_MAX_LENGTH} 个字符（当前 ${[...values.title].length} 个），请精简一下。`,
      });
    }
    if (values.priorCompletedMinutes > values.plannedMinutes) {
      localIssues.push({
        severity: 'error',
        code: 'V015',
        path: 'priorCompletedMinutes',
        message: '已完成时长不能超过预计总用时。',
      });
    }
    if (Number.isInteger(values.plannedMinutes) && values.plannedMinutes % 5 !== 0) {
      localIssues.push({ severity: 'error', code: 'V003', path: 'plannedMinutes', message: '预计总用时需要是 5 的倍数，便于整齐地拆分时段。' });
    }
    if (localIssues.length > 0) {
      showErrors(localIssues);
      return;
    }

    // 关键：只生成预览，不直接写入任务数据。
    // 用户在预览页可以看到"这个任务会被安排到哪些时段、对其它任务有什么影响"，确认后才落盘。
    const op = isEdit
      ? { kind: 'task.update', taskId: task.id, patch: values }
      : { kind: 'task.add', input: values };

    const result = services.ui.previewWith([op], {
      changeSummary: isEdit ? `修改任务「${values.title}」` : `新增任务「${values.title}」`,
      trigger: 'task-form',
    });

    if (!result.ok) {
      showErrors(
        result.issues?.length
          ? result.issues
          : [{ severity: 'error', code: 'V000', path: '', message: result.message ?? '无法生成预览。' }],
      );
      return;
    }

    toast(
      isEdit
        ? '已生成候选计划预览：确认后才会保存这次修改。'
        : '已生成候选计划预览：确认后才会创建这个任务。',
      'success',
      6000,
    );
    close();
  }

  function close() {
    dialog.close();
    dialog.remove();
  }

  updateRemainingHint();
  document.body.appendChild(dialog);
  dialog.showModal();
  inputs.title.focus();
}

function ratingHint(key, value) {
  const hints = {
    importance: ['可以往后放', '略重要', '一般', '比较重要', '非常重要'],
    difficulty: ['很轻松', '偏简单', '一般', '有挑战', '很困难'],
    procrastination: ['肯定不会拖', '较少拖延', '一般', '容易拖延', '几乎一定会拖'],
  };
  return hints[key]?.[value - 1] ?? '';
}
