/**
 * 每日视图：同样使用"日期为列、任务为内容"的看板，但聚焦到某一天。
 *
 * 与七天计划页的关系：
 * - 两者共用 `ui/board.js` 的渲染与排序规则，因此同一天在两个页面里的顺序、状态、尺寸完全一致；
 * - 本页只显示**一天**（可用 ?date= 指定），方便逐日检查与操作；
 * - 没有任何时间列或时间刻度：时间是卡片自身的属性。
 */

import { button, card, legend, notice } from '../components.js';
import { el, toast } from '../dom.js';
import { addDays, formatDateWithWeekday } from '../../domain/time.js';
import { buildBoardColumns, renderBoard } from '../board.js';

export function renderDay({ app, services, route, now }) {
  const state = app.getState();
  const today = now().date;
  const plan = services.planService.getOfficialPlan();
  const requested = route.params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested ?? '') ? requested : today;

  const columns = buildBoardColumns({ dates: [date], state, plan, services, today, nowMinutes: now().minutes });
  const cards = columns[0].cards;

  const nodes = [];

  nodes.push(
    el('header.page-head', {}, [
      el('div', {}, [
        el('h1', { text: '每日视图' }),
        el('p.page-head__sub', {
          text: `${formatDateWithWeekday(date)}${date === today ? '（今天）' : ''}　·　共 ${cards.length} 项安排`,
        }),
      ]),
      el('div.page-head__actions', {}, [
        button('← 前一天', { size: 'sm', onClick: () => gotoDate(addDays(date, -1)) }),
        button('今天', { size: 'sm', disabled: date === today, onClick: () => gotoDate(today) }),
        button('后一天 →', { size: 'sm', onClick: () => gotoDate(addDays(date, 1)) }),
        button('查看整周', { size: 'sm', onClick: () => { globalThis.location.hash = '#/week'; } }),
        // 休息的主入口：一个按钮，两种含义（一次性 / 每周重复）
        button('设置休息', { size: 'sm', variant: 'primary', onClick: () => services.ui.openRestSettings() }),
      ]),
    ]),
  );

  if (!plan || plan.version === 0) {
    nodes.push(
      notice({
        level: 'info',
        title: '还没有正式计划',
        message: '固定任务与休息不需要计划也会显示；学习任务需要先生成计划。',
        actions: [
          button('生成计划', {
            variant: 'primary',
            size: 'sm',
            onClick: () => {
              services.ui.openPlanForm({ changeSummary: '生成第一份计划', trigger: 'day-page' });
            },
          }),
        ],
      }),
    );
  }

  nodes.push(
    card({
      title: '当天的安排',
      hint: '学习任务可以标记完成或删除；固定任务与休息是背景安排',
      actions: [legend()],
      flush: true,
      // 同样保留日期列结构：空的一天显示"这一天没有安排"，而不是把整个视图换成一句话
      body: renderBoard({ columns, today, services }),
    }),
  );

  return nodes;
}

function gotoDate(date) {
  globalThis.location.hash = `#/day?date=${date}`;
}
