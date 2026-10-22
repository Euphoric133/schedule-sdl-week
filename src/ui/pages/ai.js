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

export function renderAi({ app, services, now }) {
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
      message: '你描述发生了什么（例如某个作业比预期多花了 40 分钟），AI 会分析冲突并给出方案；程序随后检查时间冲突、截止日期与睡觉时间等硬性约束。通过检查的方案才会变成「可应用的调整」给你预览。',
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
    placeholder: '例如：数学作业比预期多花了 40 分钟，我还要写英语作文，明天早上有考试，今晚 10:30 必须睡觉。',
    'aria-label': '描述今天的情况',
  });
  const resultBox = el('div.ai-result');
  const askButton = button('让 AI 分析并给出方案', { variant: 'primary', onClick: () => runRescue() });

  rescueBody.push(report, el('div.btn-row', {}, [askButton]), resultBox);
  nodes.push(card({ title: '功能一 · 计划急救', hint: 'AI 分析 + 程序校验', body: rescueBody }));

  async function runRescue() {
    const text = report.value.trim();
    if (!text) {
      toast('先描述一下今天发生了什么。', 'error');
      return;
    }
    resultBox.replaceChildren(el('div.ai-loading', { text: 'AI 正在分析……' }));
    askButton.disabled = true;

    try {
      const input = services.aiFeatureService.buildRescueInput();
      const ai = await services.aiClient.sendMessage({
        messages: [{ role: 'user', content: text }],
        context: input.context,
      });

      if (!ai.ok) {
        resultBox.replaceChildren(notice({ level: 'error', title: 'AI 没有返回结果', message: ai.message }));
        return;
      }

      const parsedProposals = parseProposalsFromReply(ai.reply);
      const prepared = services.aiFeatureService.prepareRescuePreview({
        ok: true,
        reply: parsedProposals.reply,
        proposals: parsedProposals.proposals,
      });

      resultBox.replaceChildren(renderRescueResult(prepared));
    } catch (err) {
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

    if (prepared.ok) {
      fragments.push(
        notice({
          level: 'success',
          title: `程序校验通过（${prepared.proposals.length} 项调整）`,
          message: '下面这次调整不违反任何硬性约束。点按钮可以查看它会带来的具体变化，确认前计划不会改变。',
        }),
      );
      fragments.push(
        el('ul.ai-proposals', {}, prepared.proposals.map((item) => el('li', { text: describeProposal(item) }))),
      );
      fragments.push(
        el('div.btn-row', {}, [
          button('生成调整预览', {
            variant: 'primary',
            onClick: () => {
              globalThis.location.hash = '#/preview';
            },
          }),
        ]),
      );
      return el('div.stack', {}, fragments);
    }

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
  return `锁定 ${item.date} 当天不再安排学习${item.reason ? `：${item.reason}` : ''}`;
}
