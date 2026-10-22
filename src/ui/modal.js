/**
 * 通用确认对话框（原生 <dialog>，零依赖，具备焦点管理与 Esc 关闭）。
 *
 * 用途：所有"危险操作"（删除任务、清空版本历史、重置设置）都必须先经过它，
 * 并且必须把影响面数字明确列出——不允许用"确定要删除吗？"这种无信息量的提示。
 */

import { append, el } from './dom.js';
import { button } from './components.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string[]} [options.bullets] 影响面清单（逐条列出真实数字）
 * @param {string} options.confirmLabel
 * @param {'primary'|'danger'} [options.confirmVariant]
 * @param {string} [options.cancelLabel]
 * @param {boolean} [options.requireAcknowledge] 要求勾选"我已了解影响"
 * @returns {Promise<boolean>} 用户是否确认
 */
export function confirmDialog({
  title,
  message,
  bullets = [],
  confirmLabel = '确认',
  confirmVariant = 'danger',
  cancelLabel = '取消',
  requireAcknowledge = false,
  acknowledgeLabel = '我已了解上述影响',
}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', {
      style: {
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        maxWidth: '520px',
        width: 'calc(100vw - 32px)',
        boxShadow: 'var(--shadow-md)',
      },
    });

    const acknowledgeBox = el('input', { type: 'checkbox', id: 'confirm-ack' });
    const confirmBtn = button(confirmLabel, {
      variant: confirmVariant,
      disabled: requireAcknowledge,
      onClick: () => close(true),
    });
    const cancelBtn = button(cancelLabel, { variant: 'ghost', onClick: () => close(false) });

    if (requireAcknowledge) {
      acknowledgeBox.addEventListener('change', () => {
        confirmBtn.disabled = !acknowledgeBox.checked;
      });
    }

    append(dialog, [
      el('h2', { text: title, style: { marginBottom: 'var(--space-3)' } }),
      message ? el('p', { text: message }) : null,
      bullets.length > 0
        ? el(
            'ul',
            { style: { margin: '0 0 var(--space-3)', paddingLeft: '1.2em', color: 'var(--color-text-muted)' } },
            bullets.map((text) => el('li', { text })),
          )
        : null,
      requireAcknowledge
        ? el('label', { for: 'confirm-ack', style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' } }, [
            acknowledgeBox,
            el('span', { text: acknowledgeLabel }),
          ])
        : null,
      el('div.form-actions', {}, [cancelBtn, confirmBtn]),
    ]);

    function close(result) {
      dialog.close();
      dialog.remove();
      resolve(result);
    }

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(false);
    });

    dialog.setAttribute('data-glass', '');
    document.body.appendChild(dialog);
    dialog.showModal();
    // 焦点落在取消按钮上，避免用户连续回车误触危险操作
    cancelBtn.focus();
  });
}

/** 简单的信息对话框（无确认语义，只有一个"知道了"） */
export async function infoDialog({ title, message, bullets = [] }) {
  await confirmDialog({
    title,
    message,
    bullets,
    confirmLabel: '知道了',
    confirmVariant: 'primary',
    cancelLabel: '关闭',
  });
}
