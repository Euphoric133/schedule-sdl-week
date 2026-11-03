/**
 * 「AI 助手」页：计划急救 + 时间校准。
 *
 * 页面只做三件事，且都必须让用户**看得懂发生了什么**：
 * 1. 展示程序算出来的事实（统计数字、冲突、可不可行）；
 * 2. 展示 AI 说了什么（理解与建议）；
 * 3. 给用户一个明确的「生成调整预览」按钮 —— 预览之后还要再确认一次，才会真正改计划。
 *
 * 设计原则：
 * - AI 的内容与程序的内容**视觉上分开**，用户总能分清哪句来自模型、哪个数字来自计算；
 * - 任何失败都说明原因与下一步，不显示"出错了"三个字了事；
 * - 没有 AI 时，时间校准的统计部分依然可用（纯程序）。
 */

import { button, card, emptyState, notice, pill } from '../components.js';
import { el, toast } from '../dom.js';
import { formatDuration, formatMinutes } from '../../domain/time.js';
import { FLAG_TEXT } from '../../ai/proposals.js';

const TENDENCY_LABEL = Object.freeze({
  underestimated: '经常比预计久',
  overestimated: '经常比预计快',
  stable: '基本准确',
});

const TENDENCY_KIND = Object.freeze({
  underestimated: 'warning',
  overestimated: 'info',
  stable: 'success',
});

export function renderAi({ app, services, now, renderPage }) {
  const state = app.getState();
  const nodes = [];
  const assistant = services.aiAssistant;

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: 'AI 助手' }),
        el('p.page-head__sub', {
          text: 'AI 负责理解与解释，程序负责计算与校验。AI 提出的任何日程调整，都要经过程序检查，再由你确认后才会生效。',
        }),
      ]),
    ]),
  );

  /* ------------------------------------------------------------------ *
   * 计划急救
   * ------------------------------------------------------------------ */
  const rescueBody = [];
  const sleepMinutes = state.settings?.latestSleepMinutes;

  rescueBody.push(
    notice({
      level: 'accent',
      title: '它是怎么工作的',
      message: '用大白话告诉我你要改什么：新建任务、改截止日期、标记完成、取消或删除。我会把它整理成结构化操作，程序逐条校验（日期、科目、时长、冲突），你在下面勾选要保留的，再点「生成调整预览」确认后才会真正写入。',
    }),
  );

  rescueBody.push(
    el('div.ai-fact-row', {}, [
      el('span.ai-fact__label', { text: '最晚睡觉时间' }),
      el('span.ai-fact__value', {
        text: Number.isInteger(sleepMinutes) ? formatMinutes(sleepMinutes) : '未设置（可在偏好设置里填写）',
      }),
    ]),
  );

  const report = el('textarea.ai-report', {
    rows: 4,
    placeholder: '例如：帮我加一个任务：生物实验报告，90 分钟，11 月 7 日截止，重要。',
    'aria-label': '描述你要改什么',
  });

  /**
   * 快捷示例：点击只**填入输入框**，不自动提交。
   *
   * 为什么不自动提交：这些例句里有具体数值，用户往往要先改一改
   * （换个日期、改个时长）。自动发送会浪费一次配额，也容易误改数据。
   */
  const EXAMPLES = [
    '帮我加一个任务：生物实验报告，90 分钟，11 月 7 日截止，重要',
    '把数学作业改到周六截止',
    '英语作文我已经写完了',
    '把化学实验的截止日期改到上个月',
    '帮我删掉数学作业',
    '彻底删除数学作业',
  ];
  const exampleRow = el('div.ai-examples', {}, [
    el('span.ai-examples__label', { text: '试试：' }),
    ...EXAMPLES.map((text) =>
      el('button.btn.btn--sm.ai-example', {
        type: 'button',
        text,
        onClick: () => {
          report.value = text;
          report.focus();
        },
      }),
    ),
  ]);
  const resultBox = el('div.ai-result');

  /**
   * 恢复上一次的结果。
   *
   * 没有这段的话，requestPreview 触发的重渲染会把刚显示的分析结果抹掉
   * （实测发现的缺陷）。恢复时连输入框的文字一起还原，
   * 用户不会看到"结果还在、但我写的情况没了"。
   */
  const savedState = services.aiFeatureService.getRescueState?.();
  if (savedState) {
    report.value = savedState.reportText ?? '';
    if (savedState.preparing) {
      resultBox.appendChild(el('div.ai-loading', { text: 'AI 正在分析……' }));
    } else if (savedState.prepared) {
      resultBox.appendChild(renderRescueResult(savedState.prepared));
    } else if (savedState.error) {
      resultBox.appendChild(notice({ level: 'error', title: 'AI 没有返回结果', message: savedState.error }));
    }
  }
  const askButton = button('让 AI 帮我改', { variant: 'primary', onClick: () => runRescue() });

  rescueBody.push(exampleRow, report, el('div.btn-row', {}, [askButton]), resultBox);
  nodes.push(card({ title: '功能一 · 帮我改计划', hint: 'AI 理解 + 程序校验 + 你确认', body: rescueBody }));

  async function runRescue() {
    const text = report.value.trim();
    if (!text) {
      toast('先描述一下今天发生了什么。', 'error');
      return;
    }
    const store = services.aiFeatureService;
    store.setRescueState({ reportText: text, preparing: true });
    resultBox.replaceChildren(el('div.ai-loading', { text: 'AI 正在分析……' }));
    askButton.disabled = true;

    try {
      const input = store.buildRescueInput();
      /**
       * 走结构化通道：服务端用 responseSchema 把 taskId 限定为合法 ref 枚举，
       * 从生成阶段就杜绝"引用了不存在的任务"（实测该故障会以两种形态出现：
       * 抄错字符串 id、凭空发明编号）。
       */
      const ai = await services.aiClient.sendStructuredRescue({
        message: text,
        context: input.context,
        taskRefs: input.context.validTaskRefs ?? input.context.tasks.map((task) => task.ref),
      });

      if (!ai.ok) {
        store.setRescueState({ reportText: text, error: ai.message });
        resultBox.replaceChildren(notice({ level: 'error', title: 'AI 没有返回结果', message: ai.message }));
        return;
      }

      /**
       * 追问优先：信息不全时**不生成预览**。
       *
       * 实测模型在缺少截止日期时会自己编一个——那比直接问用户危险得多。
       * 这里把问题显示出来、输入框保留原文，用户补充后再提交。
       */
      if (ai.needsMoreInfo && ai.question) {
        const pending = { ok: false, stage: 'needs_more_info', reply: ai.reply, question: ai.question };
        store.setRescueState({ reportText: text, prepared: pending });
        resultBox.replaceChildren(renderRescueResult(pending));
        if (typeof renderPage === 'function') renderPage();
        return;
      }

      const prepared = store.prepareRescuePreview({
        ok: true,
        reply: ai.reply,
        proposals: ai.proposals,
      });

      /**
       * 先落盘到服务层，再重新渲染整页。
       *
       * 顺序很重要：prepareRescuePreview 内部可能已经 commit 过状态并触发过
       * 一次重渲染（那次渲染时结果还没存进来），所以这里必须再主动刷一次，
       * 否则用户看到的会是空的结果区。
       */
      store.setRescueState({ reportText: text, prepared });
      resultBox.replaceChildren(renderRescueResult(prepared));
      if (typeof renderPage === 'function') renderPage();
    } catch (err) {
      store.setRescueState({ reportText: text, error: err?.message ?? String(err) });
      resultBox.replaceChildren(notice({ level: 'error', title: '处理失败', message: err?.message ?? String(err) }));
    } finally {
      askButton.disabled = false;
    }
  }

  function renderRescueResult(prepared) {
    const fragments = [];

    fragments.push(
      el('div.ai-reply', {}, [
        el('span.ai-reply__label', { text: 'AI 的分析' }),
        el('p.ai-reply__text', { text: prepared.reply ?? '（没有文字说明）' }),
      ]),
    );

    /* ---------------- 需要追问 ---------------- */
    if (prepared.stage === 'needs_more_info') {
      fragments.push(
        notice({
          level: 'info',
          title: '还需要一点信息',
          message: prepared.question,
        }),
      );
      fragments.push(
        el('p.ai-hint', { text: '补充上面的信息后再点一次「让 AI 帮我改」，你刚才写的内容还在输入框里。' }),
      );
      return el('div.stack', {}, fragments);
    }

    /* ---------------- 校验通过：可勾选 ---------------- */
    if (prepared.ok) {
      fragments.push(
        notice({
          level: 'success',
          title: `程序校验通过（${prepared.proposals.length} 项调整）`,
          message: '下面每一条都可以单独取消勾选。只有勾选的调整会进入预览，确认前计划与任务数据不会改变。',
        }),
      );

      // 顶部风险提示（截止日期在过去、会删除已完成记录等）
      for (const text of prepared.flagMessages ?? []) {
        fragments.push(notice({ level: 'warning', title: '注意', message: text }));
      }

      /** 勾选状态：默认全选 */
      const selected = prepared.proposals.map(() => true);

      const list = el('ul.ai-proposals.ai-proposals--selectable');
      prepared.proposals.forEach((item, index) => {
        const checkbox = el('input', {
          type: 'checkbox',
          id: `ai-proposal-${index}`,
          checked: true,
          on: {
            change: () => {
              selected[index] = checkbox.checked;
              refreshButton();
            },
          },
        });
        const riskTags = (item.flags ?? [])
          .map((name) => FLAG_TEXT[name])
          .filter(Boolean)
          .map((text) => el('span.ai-risk', { text }));

        list.appendChild(
          el('li.ai-proposal', {}, [
            el('label.ai-proposal__main', { for: `ai-proposal-${index}` }, [
              checkbox,
              el('span', { text: describeProposal(item) }),
            ]),
            ...riskTags,
          ]),
        );
      });
      fragments.push(list);

      const actionBox = el('div.btn-row');
      const primary = button('生成调整预览', {
        variant: 'primary',
        onClick: () => {
          const chosen = prepared.proposals.filter((_, index) => selected[index]);
          if (chosen.length === 0) {
            toast('至少勾选一条调整。', 'error');
            return;
          }
          /**
           * 彻底删除需要二次确认。
           *
           * 这里只做"确认意图"，真正的删除仍然发生在预览页点确认时：
           * 生成预览本身不写数据。
           */
          if (chosen.some((item) => item.kind === 'delete_task' && item.hard)) {
            showHardDeleteConfirm(chosen);
            return;
          }
          goPreview(chosen);
        },
      });
      actionBox.appendChild(primary);
      fragments.push(actionBox);

      function refreshButton() {
        const count = selected.filter(Boolean).length;
        primary.textContent = count > 0 ? `生成调整预览（已选 ${count} 项）` : '生成调整预览';
        primary.disabled = count === 0;
      }
      refreshButton();

      function showHardDeleteConfirm(chosen) {
        const hardTargets = chosen.filter((item) => item.kind === 'delete_task' && item.hard);
        const recordCount = hardTargets.reduce((sum, item) => sum + (item.completedSessionCount ?? 0), 0);
        const confirmBox = el('div.stack', {}, [
          notice({
            level: 'error',
            title: '确认要彻底删除吗',
            message: `将永久删除：${hardTargets.map((item) => `「${item.taskTitle}」`).join('、')}。${
              recordCount > 0
                ? `其中包含 ${recordCount} 条已完成学习记录，删除后统计数据也会一并减少，且无法恢复。`
                : '删除后无法恢复。'
            }`,
          }),
          el('div.btn-row', {}, [
            button('我已了解，继续生成预览', {
              variant: 'danger',
              onClick: () => goPreview(chosen),
            }),
            button('返回修改', { onClick: () => confirmBox.remove() }),
          ]),
        ]);
        fragments.push(confirmBox);
        actionBox.replaceWith(confirmBox);
      }

      function goPreview(chosen) {
        const result = services.aiFeatureService.previewSelected(chosen);
        if (!result.ok) {
          resultBox.replaceChildren(
            el('div.stack', {}, [
              ...fragments,
              notice({
                level: result.stage === 'infeasible' ? 'warning' : 'error',
                title: result.stage === 'infeasible' ? '排程后仍然行不通' : '无法生成预览',
                message: (result.issues ?? []).join(' '),
              }),
            ]),
          );
          return;
        }
        services.aiFeatureService.setRescueState({ prepared: { ...result, reply: prepared.reply } });
        globalThis.location.hash = '#/preview';
      }

      return el('div.stack', {}, fragments);
    }

    /* ---------------- 校验失败 ---------------- */
    const title =
      prepared.stage === 'proposal_rejected'
        ? 'AI 的提议没有通过程序校验'
        : prepared.stage === 'infeasible'
          ? '排程后仍然行不通'
          : prepared.stage === 'no_proposal'
            ? 'AI 认为暂时不需要调整'
            : 'AI 返回的内容无法处理';

    fragments.push(
      notice({
        level: prepared.stage === 'no_proposal' ? 'info' : 'error',
        title,
        message: (prepared.issues ?? []).join(' '),
      }),
    );
    if (prepared.stage === 'infeasible') {
      fragments.push(
        el('p.ai-hint', {
          text: '这通常意味着"减少今天的工作量"与"按时完成"冲突了：剩下的内容在截止前放不下。可以放宽截止日期、减少任务量，或允许今天多学一会儿。',
        }),
      );
    }
    return el('div.stack', {}, fragments);
  }

  /* ------------------------------------------------------------------ *
   * 时间校准
   * ------------------------------------------------------------------ */
  const calibration = services.aiFeatureService.getCalibration();
  const calBody = [];

  if (calibration.samples.length === 0) {
    calBody.push(
      emptyState({
        title: '还没有可校准的数据',
        message: '完成几个任务之后，这里会把"实际用时"和"预计用时"做对比，找出你经常低估（或高估）的科目。',
      }),
    );
  } else {
    calBody.push(
      el('p.ai-hint', {
        text: `统计来自 ${calibration.samples.length} 个已完成任务。下面的数字全部由程序计算，AI 只负责解释。`,
      }),
    );
    for (const item of calibration.subjects) {
      calBody.push(
        el('div.ai-cal-row', {}, [
          el('div.ai-cal-main', {}, [
            el('div.ai-cal-title', {}, [
              el('strong', { text: item.subject }),
              pill(TENDENCY_LABEL[item.tendency] ?? item.tendency, TENDENCY_KIND[item.tendency] ?? 'neutral'),
            ]),
            el('div.ai-cal-meta', {
              text: `共 ${item.sampleCount} 次　·　平均预计 ${formatDuration(item.meanPlannedMinutes)}　·　平均实际 ${formatDuration(item.meanActualMinutes)}`,
            }),
          ]),
          el('div.ai-cal-delta', {
            text: item.meanDiffMinutes === 0 ? '持平' : item.meanDiffMinutes > 0 ? `+${item.meanDiffMinutes} 分钟` : `${item.meanDiffMinutes} 分钟`,
          }),
        ]),
      );
      if (!item.reliable) {
        calBody.push(el('p.ai-hint', { text: `「${item.subject}」只有 ${item.sampleCount} 次记录，还不足以判断规律。` }));
      }
    }
  }

  nodes.push(
    card({
      title: '功能二 · 个人时间校准',
      hint: '历史数据 + AI 解释',
      body: calBody,
    }),
  );

  /* ------------------------------------------------------------------ */
  const out = el('div.stack', {}, nodes);
  void assistant;
  return out;
}

/** 把 AI 的文字回复拆成"提议 + 说明"；结构不合法时返回空提议，交给程序拒绝 */
function parseProposalsFromReply(reply) {
  if (typeof reply !== 'string') return { reply: '', proposals: [] };
  const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!match) return { reply, proposals: [] };
  try {
    const parsed = JSON.parse(match[1]);
    return {
      reply: typeof parsed.reply === 'string' ? parsed.reply : reply.replace(match[0], '').trim(),
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    };
  } catch {
    return { reply, proposals: [] };
  }
}

function describeProposal(item) {
  if (item.kind === 'defer_task') {
    return `「${item.taskTitle}」今天少做 ${item.minutes} 分钟${item.reason ? `：${item.reason}` : ''}`;
  }
  if (item.kind === 'lock_date') {
    return `锁定 ${item.date} 当天不再安排学习${item.reason ? `：${item.reason}` : ''}`;
  }
  if (item.kind === 'create_task') {
    const deadline = `${item.deadlineDate} ${item.deadlineTime}`;
    return `新建任务「${item.title}」/ ${item.subject} / ${formatDuration(item.plannedMinutes)} / 截止 ${deadline} / 重要度 ${item.importance}${item.reason ? `：${item.reason}` : ''}`;
  }
  if (item.kind === 'update_task') {
    const parts = describePatch(item.patch);
    return `修改「${item.taskTitle}」：${parts}${item.reason ? `（${item.reason}）` : ''}`;
  }
  if (item.kind === 'complete_task') {
    return `把「${item.taskTitle}」标记为已完成${item.reason ? `：${item.reason}` : ''}`;
  }
  if (item.kind === 'cancel_task') {
    return `取消「${item.taskTitle}」${item.reason ? `：${item.reason}` : ''}`;
  }
  if (item.kind === 'delete_task') {
    const mode = item.hard ? '彻底删除（不可恢复）' : '删除（可在已删除历史中恢复）';
    const records = item.completedSessionCount > 0 ? `，含 ${item.completedSessionCount} 条已完成记录` : '';
    return `${mode}「${item.taskTitle}」${records}${item.reason ? `：${item.reason}` : ''}`;
  }
  return `未知的操作类型：${String(item.kind)}`;
}

/** 把 patch 字段翻译成中文，避免在界面上直接暴露英文字段名 */
function describePatch(patch = {}) {
  const labels = {
    title: '名称',
    subject: '科目',
    plannedMinutes: '预计用时',
    deadlineDate: '截止日期',
    deadlineTime: '截止时刻',
    importance: '重要度',
    difficulty: '难度',
    procrastination: '拖延倾向',
    splittable: '可拆分',
    plannedStartMinutes: '计划开始时间',
  };
  const parts = [];
  for (const [key, value] of Object.entries(patch)) {
    const label = labels[key] ?? key;
    let shown = value;
    if (key === 'plannedMinutes' && Number.isInteger(value)) shown = formatDuration(value);
    else if (key === 'splittable') shown = value ? '可以拆分' : '不拆分';
    else if (key === 'plannedStartMinutes' && Number.isInteger(value)) shown = formatMinutes(value);
    else if (key === 'plannedStartMinutes' && value === null) shown = '不限';
    parts.push(`${label} → ${shown}`);
  }
  return parts.join('，');
}
