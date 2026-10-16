/**
 * 偏好设置页。
 *
 * 设置总览、逐项的图形化编辑控件（可学习时间、排程参数、休息规则、权重）、
 * 设置 JSON 编辑与校验、外观与通知、数据备份与导入、历史清理。
 *
 * 所有修改都遵循"修改 → 生成候选计划 → 确认后生效"，不会直接改动正在使用的计划。
 */

import { button, card, notice } from '../components.js';
import { downloadText, el, isNodeLive, toast } from '../dom.js';
import { defaultSettings, validateSettings } from '../../domain/schemas.js';
import { formatIssue } from '../../domain/validation.js';
import { WEEKDAY_NAMES_ZH, formatDuration } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';
import { backupReminder } from '../../storage/backup.js';
import { renderNumericEditor, renderStudyWindowsEditor, renderWeightsEditor } from '../forms/settingsEditors.js';

export function renderSettings({ app, services }) {
  const state = app.getState();
  const settings = state.settings;
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '偏好设置' }),
        el('p.page-head__sub', { text: '这些参数决定系统如何计算可用时间、拆分任务与安排休息' }),
      ]),
      el('div.page-head__actions', {}, [
        button('导出备份', { onClick: () => exportBackup(app) }),
        button('导入备份', { onClick: () => importBackup({ app, services }) }),
      ]),
    ]),
  );

  // —— 图形化编辑区 ——
  nodes.push(renderStudyWindowsEditor({ services, settings }));
  nodes.push(renderNumericEditor({ services, settings }));
  nodes.push(renderWeightsEditor({ services, settings }));

  nodes.push(
    notice({
      level: 'info',
      title: '修改设置会先生成候选计划预览',
      message:
        '上方每个编辑区保存时都会生成"候选计划 + 差异预览"，你确认之后设置才会生效；放弃预览则设置保持不变。下方的 JSON 编辑区用于批量修改或导入参数，同样会先生成预览。',
    }),
  );

  // —— 可学习时间 ——
  nodes.push(
    card({
      title: '可学习时间（按星期）',
      hint: '支持跨午夜（如 22:00–02:00）。睡眠、上课等请通过"固定活动"表达，不在这里重复扣除',
      flush: true,
      body: el('div.table-wrap', {}, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '星期' }), el('th', { text: '可学习区间' }), el('th', { text: '每日可学时长' })])]),
          el(
            'tbody',
            {},
            [1, 2, 3, 4, 5, 6, 7].map((day) => {
              const windows = settings.studyWindows?.[day] ?? settings.studyWindows?.[String(day)] ?? [];
              const total = windows.reduce((sum, w) => {
                const start = w.startMinutes ?? toMinutes(w.start);
                let end = w.endMinutes ?? toMinutes(w.end);
                if (end <= start) end += 1440;
                return sum + (end - start);
              }, 0);
              return el('tr', {}, [
                el('td', { text: WEEKDAY_NAMES_ZH[day - 1] }),
                el('td', {
                  text:
                    windows.length === 0
                      ? '不可学习'
                      : windows
                          .map((w) => `${toHHmm(w.startMinutes ?? toMinutes(w.start))}–${toHHmm(w.endMinutes ?? toMinutes(w.end))}`)
                          .join('、'),
                }),
                el('td', { text: total > 0 ? formatDuration(total) : '—' }),
              ]);
            }),
          ),
        ]),
      ]),
    }),
  );

  // —— 排程参数总览 ——
  nodes.push(
    card({
      title: '排程参数',
      hint: '候选计划基于当前设置生成；改动设置后旧预览会失效，需要重新生成',
      body: el('div', {}, [
        el('div.grid-2', {}, [
          definitionList('任务拆分', [
            ['默认可拆分最短/最长时段', `${settings.defaultMinChunkMinutes} / ${settings.defaultMaxChunkMinutes} 分钟`],
            ['不可拆分最短/最长时段', `${settings.nonSplittableMinMinutes} / ${settings.nonSplittableMaxMinutes} 分钟`],
            ['每日片段数上限', `${settings.maxSessionsPerDay} 段`],
          ]),
          definitionList('休息与缓冲', [
            ['机动缓冲比例', `${Math.round(settings.bufferRatio * 100)}%（逐日计算，不跨日挪用）`],
            ['每连续学习', `${settings.restRule.afterContinuousMinutes} 分钟后休息 ${settings.restRule.restMinutes} 分钟`],
            ['科目切换额外休息', `${settings.restRule.extraOnSubjectSwitch} 分钟`],
          ]),
          definitionList('专注与切换', [
            ['连续学习基础上限', `${settings.baseContinuousMinutes} 分钟（按难度自适应）`],
            ['科目切换惩罚', `${settings.subjectSwitchPenaltyMinutes} 分钟`],
            ['偏好专注时段', (settings.preferredFocusWindows ?? []).map((w) => `${toHHmm(w.startMinutes)}–${toHHmm(w.endMinutes)}`).join('、') || '未设置'],
          ]),
          definitionList('其它', [
            ['风险评估窗口', `${settings.riskWindowDays} 天`],
            ['业务日边界', `${String(settings.dayBoundaryHour).padStart(2, '0')}:00（此前算前一天）`],
            ['保留版本数上限', `${settings.planHistoryLimit} 个`],
          ]),
        ]),
        el('div', { style: { marginTop: 'var(--space-4)' } }, [
          el('div.card__hint', { text: '优先级权重（P = 截止紧迫度 × w1 + 难度 × w2 + 重要程度 × w3 + 拖延风险 × w4）' }),
          el('div.metric-row', { style: { marginTop: 'var(--space-2)' } }, [
            metricPill('截止紧迫度', settings.weights.deadlineUrgency),
            metricPill('难度', settings.weights.difficulty),
            metricPill('重要程度', settings.weights.importance),
            metricPill('拖延风险', settings.weights.procrastination),
          ]),
        ]),
      ]),
    }),
  );

  // —— 设置 JSON 编辑 ——
  const textarea = el('textarea', {
    rows: '14',
    spellcheck: 'false',
    style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' },
  });
  textarea.value = JSON.stringify(settings, null, 2);
  const errorHost = el('div');

  nodes.push(
    card({
      title: '高级：设置 JSON 编辑',
      hint: '校验失败时不会写入任何数据；校验通过后先生成候选计划预览，确认后才生效',
      body: el('div', {}, [
        errorHost,
        textarea,
        el('div.form-actions', {}, [
          button('恢复为当前值', {
            variant: 'ghost',
            onClick: () => {
              textarea.value = JSON.stringify(app.getState().settings, null, 2);
              errorHost.replaceChildren();
            },
          }),
          button('校验并生成预览', {
            variant: 'primary',
            onClick: () => {
              let parsed;
              try {
                parsed = JSON.parse(textarea.value);
              } catch (err) {
                showSettingsErrors(errorHost, [
                  { severity: 'error', code: 'V061', path: 'JSON', message: `JSON 语法错误：${err.message}` },
                ]);
                return;
              }
              const validation = validateSettings(parsed);
              if (!validation.ok) {
                showSettingsErrors(errorHost, validation.issues);
                return;
              }
              // 设置改动会改变可用时间与拆分规则，因此同样先生成候选计划预览
              const previewed = services.ui.previewWith([{ kind: 'settings.update', settings: parsed }], {
                changeSummary: '修改偏好设置',
                trigger: 'settings-page',
              });
              if (!previewed.ok) {
                showSettingsErrors(
                  errorHost,
                  previewed.issues?.length
                    ? previewed.issues
                    : [{ severity: 'error', code: 'V062', path: 'settings', message: previewed.message ?? '无法生成预览。' }],
                );
                return;
              }
              errorHost.replaceChildren();
              if (validation.warnings.length > 0) {
                showSettingsErrors(errorHost, validation.warnings);
                toast('已生成预览；设置里有几条提示需要你注意。', 'warning', 7000);
              } else {
                toast('已生成候选计划预览：确认后设置才会生效。', 'success', 6000);
              }
            },
          }),
        ]),
      ]),
    }),
  );

  // —— 存储与备份 ——
  nodes.push(renderStorageCard({ app, services, state }));

  // —— 清理历史（用户显式触发，绝不自动删除）——
  nodes.push(renderCleanupCard({ services, state }));

  // —— 危险操作 ——
  nodes.push(
    card({
      title: '危险操作',
      hint: '这些操作会影响设置或历史版本，执行前都会二次确认',
      body: el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
        button('恢复默认设置', {
          variant: 'danger',
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: '恢复默认设置？',
              message: '只会重置偏好设置（可用时间、拆分规则、休息规则、权重等），不会删除任务、学习时段或计划历史。',
              bullets: ['任务与学习记录不受影响', '当前正式计划保留，但重新生成计划后结果会变化', '确认后会先生成候选计划预览，你仍可以放弃'],
              confirmLabel: '恢复默认设置并生成预览',
              confirmVariant: 'danger',
            });
            if (!confirmed) return;
            const previewed = services.ui.previewWith([{ kind: 'settings.update', settings: defaultSettings() }], {
              changeSummary: '恢复默认设置',
              trigger: 'settings-page',
            });
            if (!previewed.ok) toast(previewed.message, 'error', 8000);
          },
        }),
      ]),
    }),
  );

  return nodes;
}

function definitionList(title, rows) {
  return el('div', {}, [
    el('h3', { text: title, style: { marginBottom: 'var(--space-2)' } }),
    el(
      'dl',
      { style: { margin: 0 } },
      rows.flatMap(([label, value]) => [
        el('dt', { text: label, style: { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-faint)' } }),
        el('dd', { text: value, style: { margin: '0 0 var(--space-2)', fontVariantNumeric: 'tabular-nums' } }),
      ]),
    ),
  ]);
}

function metricPill(label, value) {
  return el('div.metric', {}, [el('div.metric__label', { text: label }), el('div.metric__value', { text: String(value) })]);
}

function showSettingsErrors(host, issues) {
  host.replaceChildren(
    el('div.notice.notice--danger', { role: 'alert' }, [
      el('div', {}, [
        el('div.notice__title', { text: `发现 ${issues.length} 处问题，设置未保存` }),
        el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, issues.map((issue) => el('li', { text: formatIssue(issue) }))),
      ]),
    ]),
  );
  host.scrollIntoView({ block: 'nearest' });
}

function exportBackup(app) {
  const { text, filename } = app.exportBackup();
  downloadText(filename, text);
  app.markBackupExported();
  toast(`已导出备份：${filename}`, 'success');
}

/**
 * 导入备份：**先展示摘要与问题、由用户确认后**才写入。
 *
 * 这是数据安全的关键一步：导入会整体替换现有数据，因此必须让用户先看到
 * "这份备份里有什么""有没有警告"，并且明确知道"导入会覆盖当前数据"。
 */
function importBackup({ app, services }) {
  void services;
  const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden' });
  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    input.remove();
    if (!file) return;

    const text = await file.text();
    const preview = app.previewImport(text);
    if (!preview.ok) {
      const errors = preview.errors ?? [];
      await confirmDialog({
        title: '导入被拒绝',
        message: '这份文件没有通过校验，现有数据没有被修改。',
        bullets: errors.slice(0, 8).map((issue) => issue.message),
        confirmLabel: '知道了',
        confirmVariant: 'primary',
        cancelLabel: '关闭',
      });
      return;
    }

    const summary = preview.summary ?? {};
    const confirmed = await confirmDialog({
      title: '确认导入这份备份？',
      message: '导入会整体替换当前的任务、学习时段与计划。建议先导出当前数据作为备份。',
      bullets: [
        `包含 ${summary.taskCount ?? 0} 个任务、${summary.sessionCount ?? 0} 个学习时段、${summary.fixedActivityCount ?? 0} 项固定活动`,
        `正式计划版本：${summary.planVersion ? `v${summary.planVersion}` : '无'} · 历史版本 ${summary.historyCount ?? 0} 个`,
        preview.exportedAt ? `备份导出时间：${preview.exportedAt}` : '备份未记录导出时间',
        ...(preview.warnings ?? []).map((warning) => `提示：${warning.message}`),
      ],
      confirmLabel: '确认导入',
      confirmVariant: 'danger',
      requireAcknowledge: true,
      acknowledgeLabel: '我了解导入会覆盖当前数据',
    });
    if (!confirmed) return;

    const result = await app.importBackup(text);
    if (!result.ok) {
      toast(`导入失败，现有数据未做任何修改。${result.issues?.[0]?.message ?? ''}`, 'error', 9000);
      return;
    }
    toast(`导入成功：${result.summary?.taskCount ?? 0} 个任务、${result.summary?.sessionCount ?? 0} 个学习时段。`, 'success');
  });
  document.body.appendChild(input);
  input.click();
}

/** 存储与备份卡片：占用空间、上次导出、备份提醒、导出/导入入口 */
function renderStorageCard({ app, services, state }) {
  const usedText = el('div.metric__value', { text: '计算中…', role: 'status', 'aria-live': 'polite' });
  const quotaText = el('div.metric__value', { text: '—' });
  const reminderHost = el('div');
  const pressureHost = el('div');

  app.storageUsage().then((usage) => {
    // 用户可能已经离开设置页（节点被移除），此时写入会报错，因此先判断节点是否还活着
    if (!isNodeLive(usedText) || !isNodeLive(quotaText) || !isNodeLive(pressureHost)) return;
    usedText.textContent = usage.usedBytes === null ? '不可用' : formatBytes(usage.usedBytes);
    quotaText.textContent = usage.quotaBytes ? formatBytes(usage.quotaBytes) : '浏览器未提供';

    // 本地存储通常只有约 5 MB。接近上限时必须主动提醒，否则下一次保存会静默失败。
    const SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
    if (usage.usedBytes !== null && usage.usedBytes > SOFT_LIMIT_BYTES) {
      pressureHost.appendChild(
        notice({
          level: 'warning',
          title: '本地数据接近浏览器容量上限',
          message: `当前已使用 ${formatBytes(usage.usedBytes)}（浏览器通常只给约 5 MB）。建议先导出备份，然后在下面清理已取消的时段与旧版本记录；否则新的保存可能失败。`,
          actions: [button('立即导出备份', { size: 'sm', onClick: () => exportBackup(app) })],
        }),
      );
    }
  });

  const lastBackup = state.meta?.lastBackupAt ?? null;
  const remind = backupReminder(state, app.clock());
  if (remind.shouldRemind) {
    reminderHost.appendChild(
      notice({
        level: 'warning',
        title: '建议导出备份',
        message: remind.reason,
        actions: [button('立即导出', { size: 'sm', onClick: () => exportBackup(app) })],
      }),
    );
  }

  return card({
    title: '数据与备份',
    hint: '数据只保存在这个浏览器里；清理浏览器数据会丢失，请定期导出备份',
    body: el('div', {}, [
      el('div.metric-row', {}, [
        el('div.metric', {}, [el('div.metric__label', { text: '存储占用' }), usedText]),
        el('div.metric', {}, [el('div.metric__label', { text: '浏览器配额' }), quotaText]),
        el('div.metric', {}, [
          el('div.metric__label', { text: '存储方式' }),
          el('div.metric__value', { text: app.persistenceAvailable ? '浏览器本地存储' : '仅内存' }),
        ]),
        el('div.metric', {}, [el('div.metric__label', { text: '上次导出备份' }), el('div.metric__value', { text: lastBackup ?? '从未导出' })]),
      ]),
      reminderHost,
      pressureHost,
      el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
        button('导出备份', { variant: 'primary', onClick: () => exportBackup(app) }),
        button('导入备份…', { onClick: () => importBackup({ app, services }) }),
      ]),
    ]),
  });
}

/**
 * 清理历史卡片。
 *
 * 清理是**破坏性**操作，因此：先算清楚"会删掉什么"，再让用户确认；
 * 已完成的学习记录与当前正式计划永远不在清理范围内。
 */
function renderCleanupCard({ services, state }) {
  const impact = services.planService.cleanupImpact();
  const historyCount = (state.planHistory ?? []).length;

  return card({
    title: '清理历史记录',
    hint: '只清理已取消且从未开始过的时段记录，以及超出版本上限的旧版本；不会动已完成的学习记录',
    flush: true,
    body: el('div', {}, [
      el('div.table-wrap', {}, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '可清理的内容' }), el('th', { text: '数量' }), el('th', { text: '说明' })])]),
          el('tbody', {}, [
            el('tr', {}, [
              el('td', { text: '已取消的时段记录' }),
              el('td', { text: `${impact.removable.length} 条` }),
              el('td', { text: `共 ${formatDuration(impact.removableMinutes)}（从未开始过，删除后不影响任何计划与统计）` }),
            ]),
            el('tr', {}, [
              el('td', { text: '旧版本记录' }),
              el('td', { text: `${historyCount} 个` }),
              el('td', { text: '可只保留最近 5 个；当前正式计划不受影响' }),
            ]),
            el('tr', {}, [
              el('td', { text: '受保护的记录' }),
              el('td', { text: `${impact.keepCompleted} 条已完成` }),
              el('td', { text: `已完成的 ${impact.keepCompleted} 条与进行中的 ${impact.keepActive} 条永远不参与清理` }),
            ]),
          ]),
        ]),
      ]),
      el('div.form-actions', { style: { justifyContent: 'flex-start', padding: 'var(--space-4)' } }, [
        button('清理已取消的时段', {
          variant: 'danger',
          disabled: impact.removable.length === 0,
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: '清理已取消的时段记录？',
              message: '这些记录都是被新安排取代、且从未开始过的时段。删除它们只会释放存储空间。',
              bullets: [
                `将删除 ${impact.removable.length} 条记录（共 ${formatDuration(impact.removableMinutes)}）`,
                `${impact.keepCompleted} 条已完成的学习记录会被保留`,
                `${impact.keepActive} 条待进行/进行中的时段会被保留`,
                '此操作不可撤销（可先导出备份）',
              ],
              confirmLabel: '确认清理',
              confirmVariant: 'danger',
              requireAcknowledge: true,
            });
            if (!confirmed) return;
            const result = services.ui.cleanup([{ kind: 'cleanup.cancelledSessions' }]);
            if (!result.ok) return toast(result.issues?.[0]?.message ?? '清理失败。', 'error');
            toast(`已清理 ${result.removedCount} 条记录。`, 'success');
          },
        }),
        button('只保留最近 5 个版本', {
          variant: 'danger',
          disabled: historyCount <= 5,
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: '清理旧版本记录？',
              message: '只保留最近 5 个版本，更早的记录将被删除；当前正式计划不受影响。',
              bullets: [
                `将删除 ${Math.max(0, historyCount - 5)} 个旧版本（现有 ${historyCount} 个）`,
                '当前正式计划保持为当前版本',
                '删除后无法再撤销到更早的版本',
              ],
              confirmLabel: '确认清理',
              confirmVariant: 'danger',
              requireAcknowledge: true,
            });
            if (!confirmed) return;
            const result = services.ui.cleanup([{ kind: 'cleanup.planHistory', keep: 5 }]);
            if (!result.ok) return toast(result.issues?.[0]?.message ?? '清理失败。', 'error');
            toast(`已删除 ${result.removedCount} 个旧版本记录。`, 'success');
          },
        }),
      ]),
    ]),
  });
}

/** 字节数的人类可读格式 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toMinutes(value) {
  if (typeof value === 'number') return value;
  const m = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function toHHmm(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
