/**
 * 偏好设置的图形化编辑区。
 *
 * 设计原则：
 * - **每一处修改都先生成候选计划预览**（可用时间、拆分规则、休息、权重都会改变排程结果）；
 * - 校验先于预览：本地能判断的问题（时间格式、区间为空、min > max）就地提示，不打扰引擎；
 * - 编辑器不直接改状态，只调用 `services.ui.previewWith([{ kind: 'settings.update', … }])`。
 */

import { button, notice } from '../components.js';
import { el, toast } from '../dom.js';
import { formatIssue } from '../../domain/validation.js';


/** 排程参数字段的中文名（错误提示里不能出现内部字段名） */
const FIELD_LABELS_ZH = Object.freeze({
  defaultMinChunkMinutes: '可拆分任务的最短时段',
  defaultMaxChunkMinutes: '可拆分任务的最长时段',
  nonSplittableMinMinutes: '不可拆分任务的最短时长',
  nonSplittableMaxMinutes: '不可拆分任务的最长时长',
  baseContinuousMinutes: '连续学习基础上限',
  subjectSwitchPenaltyMinutes: '科目切换惩罚',
  maxSessionsPerDay: '每日片段数上限',
  riskWindowDays: '风险评估窗口',
  planHistoryLimit: '保留版本数上限',
});
/** 数值参数编辑区（时长限制、休息规则、上限） */
export function renderNumericEditor({ services, settings }) {
  const inputs = {};
  const errorHost = el('div');

  /** "自动生成预览"是一个开关，不参与下面的数字收集逻辑 */
  const autoPreviewInput = el('input', {
    type: 'checkbox',
    id: 'set-auto-preview',
    checked: settings.autoPreview !== false,
  });

  const numberField = (key, label, { min, max, step = 5, hint, value } = {}) => {
    const input = el('input', { type: 'number', min, max, step, value: value ?? settings[key], id: `set-${key}` });
    inputs[key] = input;
    return el('div.form-field', {}, [
      el('label', { for: `set-${key}`, text: label }),
      input,
      hint ? el('div.form-field__hint', { text: hint }) : null,
    ]);
  };

  const restAfter = el('input', { type: 'number', min: 10, max: 480, step: 5, value: settings.restRule.afterContinuousMinutes, id: 'set-rest-after' });
  const restMinutes = el('input', { type: 'number', min: 0, max: 120, step: 5, value: settings.restRule.restMinutes, id: 'set-rest-minutes' });
  const switchRest = el('input', { type: 'number', min: 0, max: 120, step: 5, value: settings.restRule.extraOnSubjectSwitch, id: 'set-rest-switch' });
  inputs.restAfter = restAfter;
  inputs.restMinutes = restMinutes;
  inputs.switchRest = switchRest;

  const host = el('div', {}, [
    el('div.grid-2', {}, [
      numberField('defaultMinChunkMinutes', '可拆分任务：最短时段（分钟）', { min: 5, max: 480, hint: '拆分时每段不得短于这个值（收尾片段例外）' }),
      numberField('defaultMaxChunkMinutes', '可拆分任务：最长时段（分钟）', { min: 5, max: 480 }),
      numberField('nonSplittableMinMinutes', '不可拆分任务：最短（分钟）', { min: 5, max: 480 }),
      numberField('nonSplittableMaxMinutes', '不可拆分任务：最长（分钟）', { min: 5, max: 1440 }),
      numberField('baseContinuousMinutes', '连续学习基础上限（分钟）', { min: 15, max: 480, hint: '按难度自适应：简单任务缩短、困难任务延长' }),
      numberField('subjectSwitchPenaltyMinutes', '科目切换惩罚（分钟）', { min: 0, max: 240, hint: '用于"同科目连续优先"的软偏好，不是硬约束' }),
      numberField('maxSessionsPerDay', '每日片段数上限', { min: 1, max: 96, step: 1 }),
      numberField('riskWindowDays', '风险评估窗口（天）', { min: 1, max: 365, step: 1 }),
      numberField('planHistoryLimit', '保留版本数上限', { min: 1, max: 200, step: 1 }),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '预览与确认' }),
      el('div.form-field', {}, [
        el('label', { for: 'set-auto-preview' }, [
          autoPreviewInput,
          el('span', { text: ' 自动生成计划预览' }),
        ]),
        el('div.form-field__hint', {
          text: '开启后，添加或修改学习任务、固定日程时会直接生成候选计划预览，减少重复确认；仍然需要你确认才会应用正式计划。关闭后，每次改动会先询问是否生成预览。',
        }),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: '休息规则' }),
      el('div.grid-3', {}, [
        el('div.form-field', {}, [el('label', { for: 'set-rest-after', text: '每连续学习（分钟）' }), restAfter]),
        el('div.form-field', {}, [el('label', { for: 'set-rest-minutes', text: '休息时长（分钟）' }), restMinutes]),
        el('div.form-field', {}, [el('label', { for: 'set-rest-switch', text: '科目切换额外休息（分钟）' }), switchRest]),
      ]),
    ]),
    errorHost,
    el('div.form-actions', {}, [
      button('保存并生成预览', {
        variant: 'primary',
        onClick: () => {
          const issues = [];
          const next = {};
          for (const [key, input] of Object.entries(inputs)) {
            if (key === 'restAfter' || key === 'restMinutes' || key === 'switchRest') continue;
            const value = Number(input.value);
            if (!Number.isFinite(value)) {
              issues.push({ severity: 'error', code: 'V003', path: key, message: `「${FIELD_LABELS_ZH[key] ?? '这一项'}」必须是数字。` });
              continue;
            }
            next[key] = value;
          }
          const restRule = {
            afterContinuousMinutes: Number(restAfter.value),
            restMinutes: Number(restMinutes.value),
            extraOnSubjectSwitch: Number(switchRest.value),
          };
          if (next.defaultMinChunkMinutes > next.defaultMaxChunkMinutes) {
            issues.push({ severity: 'error', code: 'V010', path: 'defaultMinChunkMinutes', message: '最短时段不能大于最长时段。' });
          }
          if (next.nonSplittableMinMinutes > next.nonSplittableMaxMinutes) {
            issues.push({ severity: 'error', code: 'V010', path: 'nonSplittableMinMinutes', message: '不可拆分任务的最短时长不能大于最长时长。' });
          }
          if (issues.length > 0) {
            showIssues(errorHost, issues);
            return;
          }
          // 设置变更本身也要带上开关的新值；它不参与排程，但必须持久化
          const settingsPatch = { ...next, restRule, autoPreview: autoPreviewInput.checked };
          const result = services.ui.previewWith(
            [{ kind: 'settings.update', settings: settingsPatch }],
            {
              changeSummary: '修改排程参数',
              trigger: 'settings-editor',
              // 设置页自己就是"生成预览"的入口：关闭自动预览时不要再弹一次确认，
              // 否则用户点"保存并生成预览"还要再回答一次"要不要生成预览"。
              skipConfirm: true,
            },
          );
          if (!result.ok) {
            showIssues(errorHost, result.issues?.length ? result.issues : [{ severity: 'error', message: result.message ?? '无法生成预览。' }]);
            return;
          }
          errorHost.replaceChildren();
          toast('已生成候选计划预览：确认后排程参数才会生效。', 'success', 6000);
        },
      }),
    ]),
  ]);

  return el('section.card', {}, [el('div.card__head', {}, [el('h2.card__title', { text: '排程参数' })]), host]);
}

/** 优先级权重编辑区 */
export function renderWeightsEditor({ services, settings }) {
  const inputs = {};
  const errorHost = el('div');
  const fields = [
    ['deadlineUrgency', '截止紧迫度'],
    ['difficulty', '难度'],
    ['importance', '重要程度'],
    ['procrastination', '拖延风险'],
  ];

  const sumHost = el('div', { class: 'card__hint' });
  const updateSum = () => {
    const total = fields.reduce((sum, [key]) => sum + (Number(inputs[key].value) || 0), 0);
    sumHost.textContent =
      Math.abs(total - 1) < 1e-9
        ? '四项权重之和为 1，符合常规设置。'
        : `四项权重之和为 ${Math.round(total * 1000) / 1000}，计算时会按比例换算（结果不受影响）。`;
  };

  const host = el('div', {}, [
    el('div', { class: 'card__hint', text: '优先级由截止紧迫度、难度、重要程度、拖延风险加权求和（只影响排序与安排偏好）' }),
    el(
      'div.grid-2',
      { style: { marginTop: 'var(--space-2)' } },
      fields.map(([key, label]) => {
        const input = el('input', {
          type: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          value: settings.weights[key],
          id: `w-${key}`,
          on: { input: updateSum },
        });
        inputs[key] = input;
        return el('div.form-field', {}, [el('label', { for: `w-${key}`, text: label }), input]);
      }),
    ),
    sumHost,
    errorHost,
    el('div.form-actions', {}, [
      button('恢复默认权重（0.35 / 0.30 / 0.20 / 0.15）', {
        variant: 'ghost',
        onClick: () => {
          inputs.deadlineUrgency.value = 0.35;
          inputs.difficulty.value = 0.3;
          inputs.importance.value = 0.2;
          inputs.procrastination.value = 0.15;
          updateSum();
        },
      }),
      button('保存并生成预览', {
        variant: 'primary',
        onClick: () => {
          const weights = {};
          const issues = [];
          for (const [key] of fields) {
            const value = Number(inputs[key].value);
            if (!Number.isFinite(value) || value < 0) {
              issues.push({ severity: 'error', code: 'V032', path: `weights.${key}`, message: '权重必须是非负数字。' });
              continue;
            }
            weights[key] = value;
          }
          if (issues.length === 0 && fields.every(([key]) => weights[key] === 0)) {
            issues.push({ severity: 'error', code: 'V032', path: 'weights', message: '四项权重不能全为 0。' });
          }
          if (issues.length > 0) {
            showIssues(errorHost, issues);
            return;
          }
          const result = services.ui.previewWith([{ kind: 'settings.update', settings: { weights } }], {
            changeSummary: '修改优先级权重',
            trigger: 'settings-editor',
          });
          if (!result.ok) {
            showIssues(errorHost, result.issues?.length ? result.issues : [{ severity: 'error', message: result.message ?? '无法生成预览。' }]);
            return;
          }
          errorHost.replaceChildren();
          toast('已生成候选计划预览：确认后权重才会生效。', 'success', 6000);
        },
      }),
    ]),
  ]);

  updateSum();
  return el('section.card', {}, [el('div.card__head', {}, [el('h2.card__title', { text: '优先级权重' })]), host]);
}

/** 统一的问题展示 */
export function showIssues(host, issues) {
  const errors = (issues ?? []).filter((issue) => issue.severity === 'error' || !issue.severity);
  if (errors.length === 0) return;
  host.replaceChildren(
    notice({
      level: 'danger',
      title: `有 ${errors.length} 处需要修正`,
      message: errors.map((issue) => (issue.code ? formatIssue(issue) : issue.message)).join('\n'),
    }),
  );
  host.scrollIntoView({ block: 'nearest' });
}

function toMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToHHmm(minutes) {
  const wrapped = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
