/**
 * 偏好设置页。
 *
 * 阶段 1 提供：设置总览（可读地展示所有会影响排程的参数）、设置 JSON 编辑与校验、
 * 恢复默认设置、导出/导入备份、清空版本历史。
 *
 * 阶段 3 提供：逐项的图形化编辑控件（时间窗口选择器、滑块等），
 * 并保证"修改设置 → 生成候选计划 → 确认后生效"的完整流程。
 */

import { button, card, notice } from '../components.js';
import { downloadText, el, toast } from '../dom.js';
import { defaultSettings, validateSettings } from '../../domain/schemas.js';
import { formatIssue } from '../../domain/validation.js';
import { WEEKDAY_NAMES_ZH, formatDuration } from '../../domain/time.js';
import { confirmDialog } from '../modal.js';
import { renderNumericEditor, renderStudyWindowsEditor, renderWeightsEditor } from '../forms/settingsEditors.js';

export function renderSettings({ app, services }) {
  const state = app.getState();
  const settings = state.settings;
  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '偏好设置' }),
        el('p.page-head__sub', { text: '这些参数决定排程引擎如何计算可用时间、拆分任务与安排休息' }),
      ]),
      el('div.page-head__actions', {}, [
        button('导出备份', { onClick: () => exportBackup(app) }),
        button('导入备份', { onClick: () => importBackup(app) }),
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
      hint: `设置版本指纹基于当前值计算；任何改动都会使旧预览失效（这是有意设计）`,
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
            ['版本快照上限', `${settings.planHistoryLimit} 个`],
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

  // —— 危险操作 ——
  nodes.push(
    card({
      title: '数据与危险操作',
      hint: '本地数据只存在于这个浏览器中；清理浏览器数据会丢失，请定期导出备份',
      body: el('div', {}, [
        el('div.metric-row', {}, [
          el('div.metric', {}, [el('div.metric__label', { text: '存储方式' }), el('div.metric__value', { text: app.persistenceAvailable ? '浏览器本地存储' : '仅内存（不会保存）' })]),
          el('div.metric', {}, [el('div.metric__label', { text: '上次保存' }), el('div.metric__value', { text: app.adapter.lastSavedAt?.() ?? '—' })]),
          el('div.metric', {}, [el('div.metric__label', { text: '上次导出备份' }), el('div.metric__value', { text: state.meta?.lastBackupAt ?? '从未导出' })]),
        ]),
        el('div.form-actions', { style: { justifyContent: 'flex-start' } }, [
          button('恢复默认设置', {
            variant: 'danger',
            onClick: async () => {
              const confirmed = await confirmDialog({
                title: '恢复默认设置？',
                message: '只会重置偏好设置（可用时间、拆分规则、休息规则、权重等），不会删除任务、学习时段或计划历史。',
                bullets: ['任务与学习记录不受影响', '当前正式计划保留，但重新生成计划后结果会变化', '此操作可通过再次手动修改恢复'],
                confirmLabel: '恢复默认设置',
                confirmVariant: 'danger',
              });
              if (!confirmed) return;
              const result = app.commit((current) => ({ ...current, settings: defaultSettings() }), { reason: 'settings-reset' });
              if (!result.ok) return toast(result.error?.message ?? '重置失败。', 'error');
              toast('已恢复默认设置。', 'success');
            },
          }),
          button('清空版本历史', {
            variant: 'danger',
            onClick: async () => {
              const count = (app.getState().planHistory ?? []).length;
              const confirmed = await confirmDialog({
                title: '清空版本历史？',
                message: '清空后无法再撤销到更早的计划版本。当前正式计划与所有学习时段不受影响。',
                bullets: [`将删除 ${count} 个历史版本快照`, '当前正式计划保持为当前版本', '任务与已完成的学习记录不受影响'],
                confirmLabel: '清空历史',
                confirmVariant: 'danger',
                requireAcknowledge: true,
              });
              if (!confirmed) return;
              const result = services.planService.clearHistory();
              if (!result.ok) return toast(result.error?.message ?? '清空失败。', 'error');
              toast('已清空版本历史。', 'success');
            },
          }),
        ]),
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

function importBackup(app) {
  const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden' });
  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    input.remove();
    if (!file) return;
    const result = await app.importFile(file);
    if (!result.ok) {
      const first = result.issues?.find((i) => i.severity === 'error');
      toast(`导入失败，现有数据未做任何修改。${first ? ` 原因：${first.message}` : ''}`, 'error', 9000);
      return;
    }
    toast(`导入成功：${result.summary?.taskCount ?? 0} 个任务、${result.summary?.sessionCount ?? 0} 个学习时段。`, 'success');
  });
  document.body.appendChild(input);
  input.click();
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
