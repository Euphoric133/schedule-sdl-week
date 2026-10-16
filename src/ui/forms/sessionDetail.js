/**
 * 学习时段详情抽屉（对话框形式）。
 *
 * 提供四种操作，全部走"生成候选计划预览 → 用户确认"的流程，绝不直接改数据：
 * - 锁定 / 解除锁定（锁定是硬约束：自动规划不会移动、缩短或拆分它）
 * - 移动（改日期与时间；移动已锁定的时段需要先解锁，或显式勾选"移动并保持锁定"）
 * - 取消本次时段（放回待排，记录保留为历史）
 * - 标记完成（只在用户明确操作时；引擎永远不会自动这样做）
 */

import { append, clear, el, toast } from '../dom.js';
import { button, pill } from '../components.js';
import { SESSION_STATE } from '../../domain/session.js';
import { formatDateWithWeekday, formatDuration, formatMinutes, isValidDateString, isValidTimeString } from '../../domain/time.js';
import { placementReasonLabel } from '../labels.js';

const STATE_LABELS = {
  [SESSION_STATE.FLEXIBLE]: '待进行（可调整）',
  [SESSION_STATE.IN_PROGRESS]: '进行中',
  [SESSION_STATE.COMPLETED]: '已完成',
  [SESSION_STATE.CANCELLED]: '已取消',
};

/**
 * @param {object} options
 * @param {string} options.sessionId
 * @param {object} options.services
 */
export function openSessionDetail({ sessionId, services }) {
  const session = (services.app.getState().sessions ?? []).find((item) => item.id === sessionId);
  if (!session) {
    toast('找不到该学习时段（可能已被替换为新的安排）。', 'error');
    return;
  }
  const task = (services.app.getState().tasks ?? []).find((item) => item.id === session.taskId) ?? null;
  const isCompleted = session.state === SESSION_STATE.COMPLETED;
  const isCancelled = session.state === SESSION_STATE.CANCELLED;

  const errorHost = el('div');
  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(600px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  const dateInput = el('input', { type: 'date', id: 'sd-date', value: session.date });
  const startInput = el('input', { type: 'time', id: 'sd-start', value: formatMinutes(session.startMinutes) });
  const endInput = el('input', { type: 'time', id: 'sd-end', value: formatMinutes(session.endMinutes) });
  const keepLocked = el('input', { type: 'checkbox', id: 'sd-keep-locked', checked: session.locked });
  const moveBlock = el('div', { style: { display: 'none', marginTop: 'var(--space-3)' } }, [
    el('div.form-grid', {}, [
      field('新日期', dateInput),
      field('新开始时间', startInput),
      field('新结束时间', endInput, '结束时间早于开始时间表示跨午夜'),
      el('div.form-field', {}, [
        el('label', { for: 'sd-keep-locked' }, [keepLocked, el('span', { text: ' 移动后保持锁定' })]),
        el('div.form-field__hint', { text: '锁定的时段不会被自动重排移动；移动后保持锁定可防止下次规划把它移回去。' }),
      ]),
    ]),
    el('div.form-actions', {}, [
      button('取消', { variant: 'ghost', size: 'sm', onClick: () => { moveBlock.style.display = 'none'; } }),
      button('生成移动预览', { variant: 'primary', size: 'sm', onClick: () => submitMove() }),
    ]),
  ]);

  const actions = [];
  if (!isCompleted && !isCancelled) {
    actions.push(
      button(session.locked ? '解除锁定' : '锁定该时段', {
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith([{ kind: 'session.lock', sessionId, locked: !session.locked }], {
            changeSummary: session.locked ? '解除时段锁定' : '锁定时段',
            trigger: 'session-detail',
          });
          finish(result, session.locked ? '已生成解除锁定的预览。' : '已生成锁定的预览。');
        },
      }),
    );
    actions.push(
      button('移动时段', {
        size: 'sm',
        onClick: () => {
          if (session.locked) {
            showErrors([
              {
                severity: 'error',
                code: 'H10',
                path: 'session.locked',
                message: '该时段已锁定。请先解除锁定再移动（锁定是硬约束，自动规划不会移动它）。',
              },
            ]);
            return;
          }
          moveBlock.style.display = '';
        },
      }),
    );
    actions.push(
      button('取消该时段', {
        variant: 'danger',
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith([{ kind: 'session.cancel', sessionId }], {
            changeSummary: '取消一个学习时段',
            trigger: 'session-detail',
          });
          finish(result, '已生成取消该时段的预览。');
        },
      }),
    );
    actions.push(
      button('标记为已完成', {
        size: 'sm',
        onClick: () => {
          const result = services.ui.previewWith(
            [{ kind: 'session.complete', sessionId, actualMinutes: session.plannedMinutes }],
            { changeSummary: '记录一段已完成的学习', trigger: 'session-detail' },
          );
          finish(result, '已生成"记录为已完成"的预览。');
        },
      }),
    );
  }

  append(dialog, [
    el('h2', { text: task ? task.title : '（任务已不存在）', style: { marginBottom: 'var(--space-1)' } }),
    el('div.card__hint', { text: `${task?.subject ?? '未知科目'} · ${formatDateWithWeekday(session.date)} ${formatMinutes(session.startMinutes)}–${formatMinutes(session.endMinutes)}（${formatDuration(session.plannedMinutes)}）` }),
    el('div.metric-row', { style: { margin: 'var(--space-3) 0' } }, [
      el('div.metric', {}, [el('div.metric__label', { text: '状态' }), el('div.metric__value', {}, [pill(STATE_LABELS[session.state] ?? session.state, stateKind(session))])]),
      el('div.metric', {}, [el('div.metric__label', { text: '锁定' }), el('div.metric__value', { text: session.locked ? '是' : '否' })]),
      el('div.metric', {}, [el('div.metric__label', { text: '实际时长' }), el('div.metric__value', { text: session.actualMinutes === null ? '—' : formatDuration(session.actualMinutes) })]),
      el('div.metric', {}, [el('div.metric__label', { text: '计划版本' }), el('div.metric__value', { text: session.planVersion ? `v${session.planVersion}` : '—' })]),
    ]),
    session.reasonCodes?.length > 0
      ? el('div.card__hint', { text: `安排原因：${session.reasonCodes.map(placementReasonLabel).join('；')}` })
      : null,
    isCompleted
      ? el('div.notice.notice--success', {}, [el('div', { text: '这是已完成的学习记录。它不会在任何重排或撤销中被删除或改回未完成。' })])
      : null,
    errorHost,
    moveBlock,
    actions.length > 0
      ? el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, actions)
      : el('div.card__hint', { text: '该时段当前没有可执行的操作。' }),
    el('div.form-actions', {}, [button('关闭', { variant: 'ghost', onClick: () => close() })]),
  ]);

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function field(labelText, control, hint) {
    return el('div.form-field', {}, [el('label', { text: labelText }), control, hint ? el('div.form-field__hint', { text: hint }) : null]);
  }

  function showErrors(issues) {
    clear(errorHost);
    const errors = (issues ?? []).filter((issue) => issue.severity === 'error' || !issue.severity);
    if (errors.length === 0) return;
    append(errorHost, [
      el('div.notice.notice--danger', { role: 'alert' }, [
        el('div', {}, [
          el('div.notice__title', { text: '无法执行该操作' }),
          el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, errors.map((issue) => el('li', { text: issue.message }))),
        ]),
      ]),
    ]);
  }

  function submitMove() {
    const issues = [];
    if (!isValidDateString(dateInput.value)) {
      issues.push({ severity: 'error', message: '请选择合法的日期。' });
    }
    if (!isValidTimeString(startInput.value) || !isValidTimeString(endInput.value)) {
      issues.push({ severity: 'error', message: '时间格式应为 HH:mm。' });
    }
    if (issues.length > 0) {
      showErrors(issues);
      return;
    }

    const startMinutes = toMinutes(startInput.value);
    let endMinutes = toMinutes(endInput.value);
    if (endMinutes <= startMinutes) endMinutes += 1440; // 跨夜
    if (endMinutes - startMinutes > 8 * 60) {
      showErrors([{ severity: 'error', message: '单个学习时段不能超过 8 小时。' }]);
      return;
    }

    const result = services.ui.previewWith(
      [
        {
          kind: 'session.move',
          sessionId,
          date: dateInput.value,
          startMinutes,
          endMinutes,
          lock: keepLocked.checked ? true : null,
          force: session.locked,
        },
      ],
      { changeSummary: `移动时段到 ${dateInput.value} ${formatMinutes(startMinutes)}`, trigger: 'session-detail' },
    );
    finish(result, '已生成移动预览，请检查新时间是否合适。');
  }

  function finish(result, successMessage) {
    if (!result.ok) {
      showErrors(result.issues?.length ? result.issues : [{ severity: 'error', message: result.message ?? '操作失败。' }]);
      return;
    }
    toast(successMessage, 'success', 5000);
    close();
  }

  function close() {
    dialog.close();
    dialog.remove();
  }

  document.body.appendChild(dialog);
  dialog.showModal();
}

function toMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function stateKind(session) {
  if (session.state === SESSION_STATE.COMPLETED) return 'success';
  if (session.state === SESSION_STATE.IN_PROGRESS) return 'warning';
  if (session.state === SESSION_STATE.CANCELLED) return 'neutral';
  return session.locked ? 'locked' : 'study';
}

