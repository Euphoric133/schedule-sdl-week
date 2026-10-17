/**
 * 外观主题页：主题切换 + 自定义壁纸。
 *
 * 设计要点：
 * - 主题切换是**即时生效**的（改完立刻能看到，不需要确认对话框）；
 * - 壁纸的所有处理都在本地完成（缩放、重新编码、写入 IndexedDB），不会上传任何图片；
 * - 每个设置项旁边都显示真实状态（存储是否可用、图片实际占用空间），不猜测、不假装成功。
 */

import { button, card, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { THEME, THEME_LABELS_ZH } from '../../services/appearanceService.js';
import { WALLPAPER_LIMITS } from '../../storage/wallpaperStore.js';
import { confirmDialog } from '../modal.js';

const THEME_DESCRIPTIONS = {
  [THEME.LIGHT]: '始终使用浅色界面，适合光线充足的环境。',
  [THEME.DARK]: '始终使用深色界面，夜间使用更省眼。',
  [THEME.SYSTEM]: '跟随操作系统的外观设置自动切换。',
};

export function renderAppearance({ app, services }) {
  const prefs = services.appearanceService.getPreferences();
  const appearance = prefs.appearance;
  const wallpaper = appearance.wallpaper;
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '外观主题' }),
        el('p.page-head__sub', { text: '主题与壁纸只保存在这台设备上；图片不会上传到任何服务器。' }),
      ]),
    ]),
  );

  /* ---------- 主题 ---------- */
  nodes.push(
    card({
      title: '主题',
      hint: '切换后立即生效，所有页面、弹窗、表单与图表会一起适配',
      body: el(
        'div.theme-options',
        {},
        Object.values(THEME).map((theme) => {
          const active = appearance.theme === theme;
          return el(
            'button.theme-option',
            {
              type: 'button',
              class: active ? 'is-active' : null,
              'aria-pressed': active ? 'true' : 'false',
              on: {
                click: () => {
                  const result = services.appearanceService.setTheme(theme);
                  if (!result.ok) return toast(result.message ?? '切换主题失败。', 'error');
                  toast(`已切换到「${THEME_LABELS_ZH[theme]}」主题。`, 'success', 3000);
                },
              },
            },
            [
              el('div.theme-option__preview', { class: `theme-option__preview--${theme}` }, [
                el('div.theme-option__swatch', {}),
                el('div.theme-option__swatch', {}),
                el('div.theme-option__swatch', {}),
              ]),
              el('div.theme-option__name', { text: THEME_LABELS_ZH[theme] }),
              el('div.theme-option__desc', { text: THEME_DESCRIPTIONS[theme] }),
              active ? el('div.theme-option__badge', {}, [pill('当前使用', 'success')]) : null,
            ],
          );
        }),
      ),
    }),
  );

  /* ---------- 壁纸 ---------- */
  const fileInput = el('input', {
    type: 'file',
    accept: WALLPAPER_LIMITS.types.join(','),
    class: 'visually-hidden',
    id: 'wallpaper-input',
  });
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await applyFile({ file, services });
    event.target.value = ''; // 允许重复选择同一个文件
  });

  const storageText =
    services.appearanceService.storageAvailable === null
      ? '检测中…'
      : services.appearanceService.storageAvailable
        ? '可用（IndexedDB）'
        : '不可用（浏览器不支持或被禁用）';

  const body = el('div', {}, [
    el('div.metric-row', {}, [
      el('div.metric', {}, [
        el('div.metric__label', { text: '当前状态' }),
        el('div.metric__value', {}, [wallpaper.enabled ? pill('已启用壁纸', 'success') : pill('未设置壁纸', 'neutral')]),
      ]),
      el('div.metric', {}, [el('div.metric__label', { text: '图片文件' }), el('div.metric__value', { text: wallpaper.fileName ?? '—' })]),
      el('div.metric', {}, [el('div.metric__label', { text: '本地存储' }), el('div.metric__value', { text: storageText })]),
      el('div.metric', {}, [
        el('div.metric__label', { text: '设置时间' }),
        el('div.metric__value', { text: wallpaper.savedAt ? wallpaper.savedAt.slice(0, 16).replace('T', ' ') : '—' }),
      ]),
    ]),
    el('div.form-actions', { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
      button(wallpaper.enabled ? '更换壁纸…' : '选择壁纸…', {
        variant: 'primary',
        onClick: () => fileInput.click(),
      }),
      wallpaper.enabled
        ? button('暂时关闭壁纸', {
            onClick: async () => {
              await services.appearanceService.setWallpaperEnabled(false);
              toast('已暂时关闭壁纸（图片仍然保留）。', 'success');
            },
          })
        : wallpaper.fileName
          ? button('重新启用', {
              onClick: async () => {
                await services.appearanceService.setWallpaperEnabled(true);
                toast('已启用壁纸。', 'success');
              },
            })
          : null,
      wallpaper.fileName
        ? button('移除壁纸', {
            variant: 'danger',
            onClick: async () => {
              const confirmed = await confirmDialog({
                title: '移除壁纸？',
                message: '会同时删除保存在这台设备上的图片文件。主题与其它设置不受影响。',
                confirmLabel: '确认移除',
                confirmVariant: 'danger',
              });
              if (!confirmed) return;
              const result = await services.appearanceService.clearWallpaper();
              toast(result.deleted ? '壁纸已移除。' : '壁纸设置已关闭（图片可能已被浏览器清除）。', 'success');
            },
          })
        : null,
      fileInput,
    ]),
    el('div.card__hint', {
      text: `支持 ${WALLPAPER_LIMITS.types.map((type) => type.replace('image/', '').toUpperCase()).join(' / ')}，单张不超过 8 MB。较大的图片会自动等比压缩到最长边 2560 像素，再保存到本地，避免拖慢页面。`,
    }),
    !services.appearanceService.storageAvailable && services.appearanceService.storageAvailable !== null
      ? notice({
          level: 'warning',
          title: '这台设备无法保存壁纸',
          message:
            '浏览器没有提供本地图片存储（IndexedDB），常见于隐私浏览模式或严格的安全设置。你仍然可以查看设置，但壁纸无法在刷新后保留。',
        })
      : null,
  ]);

  nodes.push(card({ title: '自定义壁纸', hint: '图片仅在本机处理与保存', body }));

  nodes.push(
    notice({
      level: 'info',
      title: '关于隐私',
      message:
        '壁纸、任务、日程与统计全部保存在你自己的浏览器里。应用不会把任何内容上传到外部服务器，也没有任何网络请求（本地开发服务器除外）。',
    }),
  );

  return nodes;
}

async function applyFile({ file, services }) {
  const validation = services.appearanceService.validateFile(file);
  if (!validation.ok) {
    toast(validation.message, 'error', 9000);
    return;
  }
  toast('正在处理图片…', 'info', 2000);
  const result = await services.appearanceService.setWallpaperFromFile(file);
  if (!result.ok) {
    toast(result.message ?? '设置壁纸失败。', 'error', 9000);
    return;
  }
  toast(result.message, 'success', 6000);
}

