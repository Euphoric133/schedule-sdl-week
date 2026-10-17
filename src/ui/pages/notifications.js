/**
 * 通知提醒设置页。
 *
 * 这一页最重要的工作是**如实反映状态**：
 * 浏览器权限（允许 / 拒绝 / 不支持）与应用内的开关是两件事，
 * 必须分别显示、分别解释，并且在无法工作时给出可执行的解决步骤，
 * 而不是显示一个永远打不开的开关。
 *
 * 同时明确说明能力边界：页面关闭后不会提醒。这是浏览器限制，不是缺陷。
 */

import { button, card, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { NOTIFICATION_TYPE } from '../../services/preferences.js';
import { NOTIFICATION_TYPE_LABELS_ZH } from '../../services/notificationService.js';

const TYPE_DESCRIPTIONS = {
  [NOTIFICATION_TYPE.SESSION_SOON]: '下一项学习开始前提醒你，避免错过计划时段。',
  [NOTIFICATION_TYPE.PLAN_START]: '当天第一次打开应用时，简报今天的时段数量与总时长（每天一条）。',
  [NOTIFICATION_TYPE.DAILY_SUMMARY]: '每天早上汇总今天的计划时长与时段数（每天一条）。',
};

export function renderNotifications({ app, services, now }) {
  const status = services.notificationService.status();
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '通知提醒' }),
        el('p.page-head__sub', { text: '用浏览器通知提醒下一项学习与专注结束；提醒由你完全控制，可以随时关闭。' }),
      ]),
      el('div.page-head__actions', {}, [
        button('发送一条测试通知', {
          size: 'sm',
          disabled: !status.active,
          onClick: () => {
            const result = services.notificationService.sendTest();
            if (!result.ok) {
              toast(
                result.reason === 'no-permission'
                  ? '还没有获得浏览器通知权限，请先点「启用通知」。'
                  : result.reason === 'type-disabled'
                    ? '对应的提醒类型被关闭了，请先在下面开启。'
                    : '测试通知发送失败。',
                'error',
                8000,
              );
              return;
            }
            toast('已发送测试通知。如果没有看到，请检查操作系统的通知设置或"勿扰模式"。', 'success', 8000);
          },
        }),
      ]),
    ]),
  );

  /* ---------- 当前状态 ---------- */
  const statusKind = status.level === 'granted' ? 'success' : status.level === 'denied' || status.level === 'unsupported' ? 'danger' : 'warning';
  nodes.push(
    card({
      title: '当前状态',
      hint: '浏览器权限与应用开关是两件不同的事，需要分别满足',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '浏览器权限' }), el('div.metric__value', {}, [pill(status.label, statusKind)])]),
          el('div.metric', {}, [
            el('div.metric__label', { text: '应用内提醒' }),
            el('div.metric__value', {}, [pill(status.enabled ? '已开启' : '已关闭', status.enabled ? 'success' : 'neutral')]),
          ]),
          el('div.metric', {}, [
            el('div.metric__label', { text: '能否收到通知' }),
            el('div.metric__value', {}, [pill(status.active ? '可以' : '暂时不能', status.active ? 'success' : 'warning')]),
          ]),
          el('div.metric', {}, [
            el('div.metric__label', { text: '提前提醒' }),
            el('div.metric__value', { text: `${status.advanceMinutes} 分钟` }),
          ]),
        ]),
        el('div.card__hint', { text: status.detail }),
        status.lastCheck
          ? el('div.card__hint', { text: `上次检查时间：${status.lastCheck.slice(11, 19)}（页面打开时每 30 秒检查一次）` })
          : null,
        el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
          status.canRequest
            ? button('启用通知', {
                variant: 'primary',
                onClick: async () => {
                  const result = await services.notificationService.requestPermission();
                  if (result.ok) {
                    toast(result.message, 'success', 6000);
                    // 授权成功后顺手打开开关，减少一步操作
                    services.notificationService.setEnabled(true);
                    services.notificationService.schedule(() => buildContext({ app, services }));
                  } else {
                    toast(result.message, 'error', 10000);
                  }
                },
              })
            : null,
          status.level === 'granted'
            ? button(status.enabled ? '关闭提醒' : '开启提醒', {
                variant: status.enabled ? 'default' : 'primary',
                onClick: () => {
                  const result = services.notificationService.setEnabled(!status.enabled);
                  if (!result.ok) return toast(result.message, 'error', 9000);
                  if (!status.enabled) services.notificationService.schedule(() => buildContext({ app, services }));
                  toast(result.message, 'success');
                },
              })
            : null,
        ]),
      ]),
    }),
  );

  /* ---------- 无法使用时的解决指引 ---------- */
  if (status.level === 'unsupported') {
    nodes.push(
      notice({
        level: 'warning',
        title: '这个浏览器不支持通知',
        message:
          '常见原因：使用了隐私浏览模式、浏览器版本过旧，或在移动端浏览器里（部分移动浏览器不提供网页通知）。页面内的提示条不受影响，仍然会正常显示。',
      }),
    );
  } else if (status.level === 'denied') {
    nodes.push(
      notice({
        level: 'danger',
        title: '通知权限被拒绝了',
        message:
          '浏览器不允许网页再次弹出授权询问，所以这里无法直接改回来。请按下面的步骤手动允许：',
        bullets: [
          '点击地址栏左侧的图标（锁形或感叹号），找到"通知"',
          '把它改成"允许"',
          '刷新本页，然后重新点"开启提醒"',
          '如果找不到，可以在浏览器设置里搜索"网站设置 → 通知"',
        ],
      }),
    );
  } else if (status.level === 'default') {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有获得授权',
        message: '点上面的「启用通知」后，浏览器会弹出询问。只有你点了"允许"，应用才有能力发送通知。',
      }),
    );
  }

  /* ---------- 提醒类型 ---------- */
  const typeRows = Object.values(NOTIFICATION_TYPE).map((type) => {
    const enabled = status.types?.[type] !== false;
    const checkbox = el('input', {
      type: 'checkbox',
      id: `notify-${type}`,
      checked: enabled,
      disabled: status.level === 'unsupported',
    });
    checkbox.addEventListener('change', () => {
      services.notificationService.setType(type, checkbox.checked);
      toast(checkbox.checked ? `已开启「${NOTIFICATION_TYPE_LABELS_ZH[type]}」。` : `已关闭「${NOTIFICATION_TYPE_LABELS_ZH[type]}」。`, 'success', 4000);
    });
    return el('li.notify-row', {}, [
      el('div.notify-row__main', {}, [
        el('label.notify-row__label', { for: `notify-${type}` }, [
          checkbox,
          el('span', { text: NOTIFICATION_TYPE_LABELS_ZH[type] }),
        ]),
        el('div.card__hint', { text: TYPE_DESCRIPTIONS[type] }),
      ]),
      el('div.notify-row__state', {}, [pill(enabled ? '已开启' : '已关闭', enabled ? 'success' : 'neutral')]),
    ]);
  });

  nodes.push(
    card({
      title: '提醒类型',
      hint: '每一项都可以单独开关；关闭的提醒绝不会发送',
      body: el('ul.notify-list', {}, typeRows),
    }),
  );

  /* ---------- 提前时间与静音时段 ---------- */
  const advanceSelect = el('select', { id: 'notify-advance' });
  for (const minutes of [0, 5, 10, 15, 30, 60]) {
    advanceSelect.appendChild(
      el('option', {
        value: String(minutes),
        selected: status.advanceMinutes === minutes,
        text: minutes === 0 ? '准时提醒（开始时）' : `提前 ${minutes} 分钟`,
      }),
    );
  }
  advanceSelect.addEventListener('change', () => {
    services.notificationService.setAdvanceMinutes(Number(advanceSelect.value));
    toast('已更新提前提醒时间。', 'success', 3000);
  });

  const quiet = status.quietHours ?? { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60 };
  const quietToggle = el('input', { type: 'checkbox', id: 'quiet-enabled', checked: quiet.enabled });
  const quietStart = el('input', { type: 'time', id: 'quiet-start', value: toHHmm(quiet.startMinutes) });
  const quietEnd = el('input', { type: 'time', id: 'quiet-end', value: toHHmm(quiet.endMinutes) });
  const quietFields = el('div.form-grid', { style: { display: quiet.enabled ? '' : 'none' } }, [
    el('div.form-field', {}, [el('label', { for: 'quiet-start', text: '静音开始' }), quietStart]),
    el('div.form-field', {}, [el('label', { for: 'quiet-end', text: '静音结束' }), quietEnd]),
  ]);
  quietToggle.addEventListener('change', () => {
    quietFields.style.display = quietToggle.checked ? '' : 'none';
    services.notificationService.setQuietHours({ enabled: quietToggle.checked });
  });
  quietStart.addEventListener('change', () => services.notificationService.setQuietHours({ startMinutes: toMinutes(quietStart.value) }));
  quietEnd.addEventListener('change', () => services.notificationService.setQuietHours({ endMinutes: toMinutes(quietEnd.value) }));

  nodes.push(
    card({
      title: '提醒时机',
      hint: '支持跨午夜的静音区间（例如 22:00 → 07:00）',
      body: el('div', {}, [
        el('div.form-field', {}, [el('label', { for: 'notify-advance', text: '提前多久提醒下一项学习' }), advanceSelect]),
        el('div.form-field', {}, [
          el('label', { for: 'quiet-enabled' }, [quietToggle, el('span', { text: ' 启用静音时段（这段时间内不发送任何通知）' })]),
          quietFields,
        ]),
      ]),
    }),
  );

  /* ---------- 最近发送过的通知 ---------- */
  if (status.recent.length > 0) {
    nodes.push(
      card({
        title: '本次打开页面后发送过的通知',
        hint: '同一个提醒不会重复发送；刷新页面也不会重发',
        flush: true,
        body: el(
          'ul.task-list',
          {},
          status.recent.map((item) =>
            el('li.task-item', {}, [
              el('div.task-item__head', {}, [
                el('div', {}, [el('strong', { text: item.title }), el('span', { text: `　${item.body}` })]),
                el('div.task-item__meta', {}, [pill(item.at.slice(11, 19), 'neutral')]),
              ]),
            ]),
          ),
        ),
      }),
    );
  }

  /* ---------- 能力边界说明 ---------- */
  nodes.push(
    notice({
      level: 'info',
      title: '提醒的能力边界（如实说明）',
      message:
        '页面保持打开时，提醒按真实时间计算，切换标签页或电脑短暂休眠后也能补上。但如果完全关闭了这个网页，浏览器不会执行本应用的代码，因此不会再发送提醒——要做到那一点需要 Service Worker、HTTPS 与推送服务器，本项目不假装支持。',
    }),
  );

  void now;
  return nodes;
}

function buildContext({ app, services }) {
  return {
    sessions: app.getState().sessions ?? [],
    tasks: app.getState().tasks ?? [],
    plan: app.getState().officialPlan,
  };
}

function toHHmm(minutes) {
  const wrapped = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function toMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}
