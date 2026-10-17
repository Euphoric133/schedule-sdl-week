/**
 * 生成计划前的"开始时间"输入（可选）。
 *
 * 为什么单独做成一个小弹窗：
 * - 开始时间只是"这次从几点开始找空档"，不是长期设置，因此不该塞进偏好设置；
 * - 它在所有"生成 / 重新规划"入口行为一致，集中在一处实现可以避免每个页面各写一套；
 * - 留空即使用默认规则（当前时刻之后的下一个整点），所以不填也能一键生成。
 */

import { append, clear, el } from '../dom.js';
import { button } from '../components.js';
import { formatMinutes } from '../../domain/time.js';

/**
 * @param {object} options
 * @param {object} options.services
 * @param {string} options.changeSummary 这次生成本身的说明（例如"重新规划"）
 * @param {string} [options.trigger] 变更来源（用于审计）
 */
export function openPlanStartForm({ services, changeSummary, trigger = 'plan-form' }) {
  const now = services.now();
  const defaultStart = nextHourLabel(now.minutes);

  const timeInput = el('input', { type: 'time', id: 'plan-start', value: '' });
  const errorHost = el('div');
  const dialog = el('dialog', {
    style: {
      border: '1px solid var(--color-border-strong)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      width: 'min(460px, calc(100vw - 32px))',
      boxShadow: 'var(--shadow-md)',
    },
  });

  function submit() {
    clear(errorHost);
    try {
      submitInner();
    } catch (error) {
      append(errorHost, [
        el('div.notice.notice--danger', { role: 'alert' }, [
          el('div', {}, [el('div.notice__title', { text: '生成失败' }), el('div', { text: error?.message ?? String(error) })]),
        ]),
      ]);
    }
  }

  function submitInner() {
    const value = timeInput.value.trim();
    const result = services.ui.requestPreview({
      changeSummary,
      trigger,
      startAt: value || null,
    });
    if (!result.ok) {
      append(errorHost, [
        el('div.notice.notice--danger', { role: 'alert' }, [
          el('div', {}, [el('div.notice__title', { text: '还没能生成计划' }), el('div', { text: result.message })]),
        ]),
      ]);
      return;
    }
    close();
  }

  append(dialog, [
    el('form', {
      on: {
        submit: (event) => {
          event.preventDefault();
          submit();
        },
      },
    }, [
      el('h2', { text: '生成学习计划', style: { marginBottom: 'var(--space-3)' } }),
      el('p.card__hint', {
        text: `不填开始时间时，从当前时刻之后的下一个整点开始找空档（现在是 ${formatMinutes(now.minutes)} → ${defaultStart}）。`,
      }),
      el('div.form-field', {}, [
        el('label', { for: 'plan-start', text: '开始时间（可选）' }),
        timeInput,
        el('div.form-field__hint', {
          text: '只影响这次从哪里开始找空档，不会修改固定任务、休息或系统时钟。开始之前的时间不会被安排学习。',
        }),
      ]),
      errorHost,
      el('div.form-actions', {}, [
        button('取消', { variant: 'ghost', onClick: () => close() }),
        el('button.btn.btn--primary', { type: 'submit', text: '生成计划' }),
      ]),
    ]),
  ]);

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  function close() {
    dialog.close();
    dialog.remove();
  }

  document.body.appendChild(dialog);
  dialog.showModal();
  timeInput.focus();
}

/** "当前时刻之后的下一个整点"的 HH:mm 文案（与引擎规则一致） */
export function nextHourLabel(minutes) {
  const next = Math.floor(minutes / 60) * 60 + 60;
  return formatMinutes(next % 1440);
}
