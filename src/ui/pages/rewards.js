/**
 * 奖励转盘页。
 *
 * 转盘的正确性由两个约束保证，缺一不可：
 * 1. **先定结果，再算角度**。中奖项由 `rewardService.draw()` 用加权随机选出并**先返回**，
 *    界面再据此计算旋转角度。因此动画停下的位置必然与结果一致。
 * 2. **中奖只在真实进度下发生**。抽奖机会由已完成的学习记录推导，扣除已发放次数，
 *    刷新页面、反复点击、重复提交都不会多发一次机会。
 *
 * 转盘用 CSS 的 `conic-gradient` 画扇形，用 `transform: rotate()` 做动画——
 * 不需要 canvas，也不需要任何动画库，性能开销可以忽略。
 */

import { button, card, emptyState, notice, pill, progressBar, statTile } from '../components.js';
import { el, toast } from '../dom.js';
import { TRIGGER_LABELS_ZH, TRIGGER_UNIT_ZH, REWARD_TRIGGER } from '../../services/rewardService.js';
import { confirmDialog } from '../modal.js';

/** 扇区配色（深色与浅色主题下都能看清文字） */
const SLICE_COLORS = ['#2f6fd0', '#3f9e7f', '#b8912f', '#6b4fd0', '#c0392b', '#2f7d55', '#4a7fb5', '#8a6fb5'];

export function renderRewards({ app, services, now }) {
  const settings = services.appearanceService.getPreferences().rewards;
  const items = services.rewardService.listItems();
  const enabledItems = items.filter((item) => item.enabled !== false);
  const eligibility = services.rewardService.eligibility();
  const stats = services.rewardService.stats();
  const history = services.rewardService.history({ limit: 20 });

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '奖励转盘' }),
        el('p.page-head__sub', { text: '把专注变成可见的回报。奖项与触发规则完全由你设定，中奖结果由真实学习记录决定。' }),
      ]),
      el('div.page-head__actions', {}, [
        button('编辑奖项', { size: 'sm', onClick: () => { globalThis.location.hash = '#/rewards?tab=items'; } }),
      ]),
    ]),
  );

  if (!settings.enabled) {
    nodes.push(
      notice({
        level: 'warning',
        title: '奖励转盘已关闭',
        message: '关闭状态下不会累积抽奖机会，也无法抽奖。',
        actions: [
          button('重新开启', {
            variant: 'primary',
            size: 'sm',
            onClick: () => {
              services.rewardService.setEnabled(true);
              toast('已开启奖励转盘。', 'success');
            },
          }),
        ],
      }),
    );
  }

  /* ---------- 机会概览 ---------- */
  nodes.push(
    el('section.home-tiles', {}, [
      statTile({
        label: '可用抽奖机会',
        value: `${eligibility.totalRemaining} 次`,
        hint:
          eligibility.totalRemaining > 0
            ? '每次抽奖消耗一次机会；机会来自真实完成的专注与任务'
            : '继续专注或完成学习时段即可累积',
        kind: 'locked',
      }),
      statTile({ label: '累计中奖', value: `${stats.total} 次`, hint: stats.today > 0 ? `今天 ${stats.today} 次` : '还没有中奖记录', kind: 'primary' }),
      statTile({ label: '已确认领取', value: `${stats.claimed} 次`, hint: '中奖后由你自己确认是否兑现', kind: 'rest' }),
      statTile({
        label: '最常抽到',
        value: stats.mostFrequent ? stats.mostFrequent[0] : '—',
        hint: stats.mostFrequent ? `共 ${stats.mostFrequent[1]} 次` : '还没有记录',
        kind: 'buffer',
      }),
    ]),
  );

  /* ---------- 转盘 ---------- */
  const wheelHost = el('div.wheel-host', { id: 'wheel-host' });
  const resultHost = el('div.wheel-result', { role: 'status', 'aria-live': 'polite' }, [
    el('div.card__hint', { text: eligibility.totalRemaining > 0 ? '点击「开始转动」抽取一次奖励。' : '现在还没有抽奖机会。' }),
  ]);
  const drawButton = button('开始转动', {
    variant: 'primary',
    disabled: eligibility.totalRemaining <= 0 || enabledItems.length === 0,
    onClick: () => {
      const result = services.rewardService.draw();
      if (!result.ok) {
        toast(result.message, 'error', 8000);
        return;
      }
      spinWheel({ host: wheelHost, items: enabledItems, result, onDone: () => renderResult({ resultHost, result, services }) });
    },
  });

  nodes.push(
    card({
      title: '转盘',
      hint: enabledItems.length === 0 ? '还没有启用的奖项' : `共 ${enabledItems.length} 个奖项参与抽奖`,
      body: el('div.wheel-layout', {}, [
        el('div.wheel-layout__wheel', {}, [wheelHost]),
        el('div.wheel-layout__side', {}, [
          el('div.wheel-pointer', { text: '▼' }),
          resultHost,
          el('div.form-actions', { style: { justifyContent: 'center' } }, [drawButton]),
          el('div.card__hint', { text: '转盘结果在开始转动前就已确定，动画只会停在真实结果上——不会出现"看到的"和"抽到的"不一致。' }),
        ]),
      ]),
    }),
  );

  /* ---------- 触发规则 ---------- */
  const triggerRows = Object.values(REWARD_TRIGGER).map((trigger) => {
    const rule = settings.triggers?.[trigger] ?? { enabled: false, threshold: 1 };
    const entry = eligibility.perTrigger.find((item) => item.trigger === trigger);
    const checkbox = el('input', { type: 'checkbox', id: `trigger-${trigger}`, checked: Boolean(rule.enabled) });
    const numberInput = el('input', { type: 'number', min: '1', max: '600', step: '1', value: String(rule.threshold), id: `threshold-${trigger}` });

    checkbox.addEventListener('change', () => {
      services.rewardService.setTrigger(trigger, { enabled: checkbox.checked });
      toast(checkbox.checked ? `已启用「${TRIGGER_LABELS_ZH[trigger]}」。` : `已关闭「${TRIGGER_LABELS_ZH[trigger]}」。`, 'success', 4000);
    });
    numberInput.addEventListener('change', () => {
      services.rewardService.setTrigger(trigger, { threshold: Number(numberInput.value) });
    });

    return el('li.trigger-row', {}, [
      el('div.trigger-row__main', {}, [
        el('label.trigger-row__label', { for: `trigger-${trigger}` }, [checkbox, el('span', { text: TRIGGER_LABELS_ZH[trigger] })]),
        el('div.trigger-row__config', {}, [
          el('span', { text: '每 ' }),
          numberInput,
          el('span', { text: ` ${TRIGGER_UNIT_ZH[trigger]} 获得 1 次机会` }),
        ]),
        el('div.card__hint', {
          text: entry
            ? `当前累计 ${entry.value} ${TRIGGER_UNIT_ZH[trigger]}　·　已获得 ${entry.earned} 次　·　已使用 ${entry.spent} 次　·　剩余 ${entry.remaining} 次`
            : '',
        }),
      ]),
      el('div.trigger-row__state', {}, [pill(rule.enabled ? '已启用' : '已关闭', rule.enabled ? 'success' : 'neutral')]),
    ]);
  });

  nodes.push(
    card({
      title: '什么时候获得抽奖机会',
      hint: '机会由真实记录推导；重复提交同一份完成记录不会多给机会',
      body: el('ul.trigger-list', {}, triggerRows),
    }),
  );

  /* ---------- 奖项管理 ---------- */
  nodes.push(renderItemManager({ services, items }));

  /* ---------- 历史记录 ---------- */
  nodes.push(
    card({
      title: `中奖记录（${stats.total}）`,
      hint: '中奖只记录结果；是否兑现由你自己决定，应用不会替你打开任何东西',
      actions: [
        stats.total > 0
          ? button('清空记录', {
              size: 'sm',
              variant: 'danger',
              onClick: async () => {
                const confirmed = await confirmDialog({
                  title: '清空中奖记录？',
                  message: '只会删除历史记录，不会退回已经用掉的抽奖机会，也不影响学习统计。',
                  confirmLabel: '确认清空',
                  confirmVariant: 'danger',
                });
                if (!confirmed) return;
                const result = services.rewardService.clearHistory();
                if (!result.ok) return toast(result.message ?? '清空失败。', 'error');
                toast('已清空中奖记录。', 'success');
              },
            })
          : null,
      ],
      flush: history.length > 0,
      body:
        history.length === 0
          ? emptyState({
              title: '还没有中奖记录',
              message: '累积到一次抽奖机会后转动转盘，结果会记录在这里（含时间与触发来源）。',
            })
          : el(
              'ul.task-list',
              {},
              history.map((entry) =>
                el('li.task-item', {}, [
                  el('div.task-item__head', {}, [
                    el('div', {}, [
                      el('strong', { text: `${entry.emoji ?? '🎁'} ${entry.label}` }),
                      el('span', { text: `　${entry.at.slice(0, 16).replace('T', ' ')}` }),
                    ]),
                    el('div.task-item__meta', {}, [
                      entry.trigger ? pill(TRIGGER_LABELS_ZH[entry.trigger] ?? '手动抽取', 'neutral') : pill('手动抽取', 'neutral'),
                      entry.claimedAt ? pill(`已领取 ${entry.claimedAt.slice(11, 16)}`, 'success') : pill('未确认领取', 'warning'),
                    ]),
                  ]),
                  el('div.task-item__actions', {}, [
                    !entry.claimedAt
                      ? button('我已完成这个奖励', {
                          size: 'sm',
                          onClick: () => {
                            const result = services.rewardService.markClaimed(entry.id);
                            if (!result.ok) return toast(result.message ?? '记录失败。', 'error');
                            toast('已记录：这个奖励已完成。', 'success');
                          },
                        })
                      : null,
                  ]),
                ]),
              ),
            ),
    }),
  );

  void app;
  void now;
  return nodes;
}

/* ------------------------------------------------------------------ *
 * 转盘绘制与动画
 * ------------------------------------------------------------------ */

/**
 * 绘制转盘。
 * `conic-gradient` 的每一段对应一个奖项，段的角度按奖项数量均分；
 * 权重只影响**被抽中的概率**，不影响扇区大小——这是常见做法，
 * 并且界面上会如实显示每个奖项的权重数值，不制造"扇区越大越容易"的误导。
 */
function buildWheel(items, { rotationDeg = 0 } = {}) {
  const slice = 360 / items.length;
  const stops = items
    .map((item, index) => {
      const from = index * slice;
      const to = (index + 1) * slice;
      return `${SLICE_COLORS[index % SLICE_COLORS.length]} ${from}deg ${to}deg`;
    })
    .join(', ');

  const labels = items.map((item, index) => {
    const angle = index * slice + slice / 2;
    return el(
      'div.wheel__label',
      {
        style: {
          transform: `rotate(${angle}deg) translateY(-38%) rotate(${-angle}deg)`,
        },
        title: `${item.label}（权重 ${item.weight}）`,
      },
      [el('span', { text: item.emoji ?? '🎁' }), el('span.wheel__label-text', { text: item.label })],
    );
  });

  return el('div.wheel', {}, [
    el('div.wheel__disc', {
      style: {
        background: `conic-gradient(${stops})`,
        transform: `rotate(${rotationDeg}deg)`,
        transition: 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 1)',
      },
    }),
    el('div.wheel__labels', { style: { transform: `rotate(${rotationDeg}deg)`, transition: 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 1)' } }, labels),
    el('div.wheel__hub', {}),
  ]);
}

/**
 * 转动：先由服务确定结果，再把转盘转到该扇区。
 *
 * 角度计算：指针固定在正上方（0°）。要让第 i 个扇区停在指针下，
 * 需要让转盘旋转 `360 * 圈数 - (i * slice + slice / 2)`，
 * 再加一点点随机偏移让每次停的位置不完全一样（但仍在同一扇区内）。
 */
function spinWheel({ host, items, result, onDone }) {
  const slice = 360 / items.length;
  const index = result.index;
  const fullTurns = 5;
  // 偏移限制在扇区内部 20%–80%，保证指针明确落在中奖扇区内
  const jitter = slice * (0.2 + 0.6 * Math.random());
  const targetDeg = fullTurns * 360 - (index * slice + jitter);

  host.replaceChildren(buildWheel(items, { rotationDeg: 0 }));
  const disc = host.querySelector?.('.wheel__disc');
  const labels = host.querySelector?.('.wheel__labels');
  // 强制一次样式计算，确保从 0° 开始过渡（否则部分浏览器会跳过动画）
  void host.offsetWidth;

  const apply = (deg) => {
    if (disc) disc.style.transform = `rotate(${deg}deg)`;
    if (labels) labels.style.transform = `rotate(${deg}deg)`;
  };
  // 用 requestAnimationFrame 保证初始 0° 已经生效
  const raf = globalThis.requestAnimationFrame ?? ((callback) => setTimeout(callback, 16));
  raf(() => apply(targetDeg));

  const settle = () => {
    apply(targetDeg % 360);
    onDone?.();
  };
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(settle, 4200);
  else settle();
}

function renderResult({ resultHost, result, services }) {
  resultHost.replaceChildren(
    el('div.wheel-result__card', {}, [
      el('div.wheel-result__emoji', { text: result.item.emoji ?? '🎁' }),
      el('div.wheel-result__label', { text: result.item.label }),
      el('div.card__hint', {
        text: result.forced
          ? '当前只启用了一个奖项，所以结果必然是它。'
          : '结果已记录到下方历史中；是否现在就去兑现完全由你决定。',
      }),
      el('div.form-actions', { style: { justifyContent: 'center' } }, [
        button('我已完成这个奖励', {
          size: 'sm',
          onClick: () => {
            const marked = services.rewardService.markClaimed(result.entry?.id);
            if (!marked.ok) return toast(marked.message ?? '记录失败。', 'error');
            toast('已记录：这个奖励已完成。', 'success');
          },
        }),
      ]),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * 奖项管理
 * ------------------------------------------------------------------ */

function renderItemManager({ services, items }) {
  const rows = items.map((item) => {
    const labelInput = el('input', { type: 'text', value: item.label, maxlength: '30', 'aria-label': '奖励名称' });
    const emojiInput = el('input', { type: 'text', value: item.emoji ?? '🎁', maxlength: '4', 'aria-label': '图标' });
    const weightInput = el('input', { type: 'number', min: '1', max: '10', step: '1', value: String(item.weight), 'aria-label': '权重' });
    const enabledInput = el('input', { type: 'checkbox', checked: item.enabled !== false, 'aria-label': '启用' });

    const save = () =>
      services.rewardService.updateItem(item.id, {
        label: labelInput.value,
        emoji: emojiInput.value,
        weight: Number(weightInput.value),
      });
    labelInput.addEventListener('change', save);
    emojiInput.addEventListener('change', save);
    weightInput.addEventListener('change', save);
    enabledInput.addEventListener('change', () => services.rewardService.toggleItem(item.id, enabledInput.checked));

    return el('li.item-row', {}, [
      enabledInput,
      el('div.item-row__emoji', {}, [emojiInput]),
      el('div.item-row__label', {}, [labelInput]),
      el('div.item-row__weight', {}, [
        el('span.card__hint', { text: '权重' }),
        weightInput,
      ]),
      button('删除', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          const result = services.rewardService.removeItem(item.id);
          if (!result.ok) return toast(result.message ?? '删除失败。', 'error');
          toast('已删除该奖项。', 'success');
        },
      }),
    ]);
  });

  const newLabel = el('input', { type: 'text', placeholder: '例如：看一集动画', maxlength: '30', id: 'new-reward-label' });
  const newEmoji = el('input', { type: 'text', value: '🎁', maxlength: '4', id: 'new-reward-emoji', style: { width: '56px' } });
  const newWeight = el('input', { type: 'number', min: '1', max: '10', value: '1', id: 'new-reward-weight', style: { width: '72px' } });

  return card({
    title: '我的奖项',
    hint: '权重越高越容易被抽到（权重 1–10）；关闭的奖项不参与抽奖，但仍保留在列表里',
    body: el('div', {}, [
      el('ul.item-list', {}, rows),
      el('div.item-add', {}, [
        newEmoji,
        newLabel,
        el('span.card__hint', { text: '权重' }),
        newWeight,
        button('新增奖项', {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            const result = services.rewardService.addItem({
              label: newLabel.value,
              emoji: newEmoji.value,
              weight: Number(newWeight.value),
            });
            if (!result.ok) return toast(result.message ?? '新增失败。', 'error');
            toast('已新增奖项。', 'success');
          },
        }),
        button('恢复默认奖项', {
          size: 'sm',
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: '恢复默认奖项？',
              message: '会把你当前的奖项列表替换为默认示例（休息 5 分钟、听一首歌等）。已中奖的历史记录不受影响。',
              confirmLabel: '确认恢复',
              confirmVariant: 'danger',
            });
            if (!confirmed) return;
            const result = services.rewardService.restoreDefaults();
            toast(`已恢复 ${result.count} 个默认奖项。`, 'success');
          },
        }),
      ]),
    ]),
  });
}
