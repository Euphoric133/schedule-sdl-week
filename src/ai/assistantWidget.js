/**
 * 右下角的日程助手：气泡 + 抽屉式对话面板。
 *
 * 交互决定（与"打开即用、不需要用户操作"的要求对应）：
 * - 页面加载后**自动发起一条"今日建议"**，结果直接显示在气泡的角标上，
 *   用户不点任何东西就能看到 AI 的输出；
 * - 但**不自动弹开面板**：弹出式面板会遮挡首屏内容，也会在移动端挡住导航。
 * - 点气泡才展开完整对话。
 *
 * 数据边界：
 * - 只发给服务端一段**裁剪过的日程摘要**（见 chatClient.buildScheduleContext）；
 * - 对话保存在内存里，刷新即清空，不写入 localStorage、不进备份文件。
 */

import { el, toast } from '../ui/dom.js';
import { buildScheduleContext, sendMessage, stripProposalBlock } from './chatClient.js';

const OPENERS = ['今天的学习安排有没有风险？', '我今天没按计划完成，怎么调整？', '帮我看看先做哪件事。'];

/**
 * 挂载助手组件。
 *
 * @param {object} options
 * @param {HTMLElement} options.root 挂载点（通常是 #app）
 * @param {object} options.app 应用状态容器
 * @param {() => {date: string, minutes: number}} options.now
 * @param {Function} [options.send] 测试注入：替代 sendMessage
 * @returns {{destroy: () => void, open: () => void, close: () => void, isOpen: () => boolean, element: HTMLElement}}
 */
export function mountAiAssistant({ root, app, now, send = sendMessage }) {
  const messages = [];
  let open = false;
  let busy = false;
  let greeted = false;

  // hidden 一律创建后再设置：element 的 hidden 属性的语义要显式打开/关闭，
  // 依赖属性字符串容易在不同实现里失效。
  const badge = el('span.ai-assistant__badge');
  badge.hidden = true;
  const panel = el('section.ai-assistant__panel', { 'aria-label': '日程助手对话' });
  panel.hidden = true;
  const bubble = el('button.ai-assistant__bubble', {
    type: 'button',
    'aria-label': '打开日程助手',
    'aria-expanded': 'false',
    on: { click: toggle },
  }, [el('span.ai-assistant__icon', { text: '🤖', 'aria-hidden': 'true' }), badge]);

  const list = el('div.ai-assistant__messages', { role: 'log', 'aria-live': 'polite' });
  const input = el('textarea.ai-assistant__input', {
    rows: 2,
    placeholder: '说说你现在的情况，例如：数学作业多花了 40 分钟…',
    'aria-label': '输入问题',
    on: {
      keydown: (event) => {
        // Enter 发送，Shift+Enter 换行（输入法组合期间不发送）
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          submit(input.value);
        }
      },
    },
  });
  const sendButton = el('button.ai-assistant__send', { type: 'button', text: '发送', on: { click: () => submit(input.value) } });
  const status = el('p.ai-assistant__status', { text: '' });
  status.hidden = true;

  panel.append(
    el('header.ai-assistant__head', {}, [
      el('strong', { text: '日程助手' }),
      el('button.ai-assistant__close', {
        type: 'button',
        text: '×',
        'aria-label': '关闭日程助手',
        on: { click: close },
      }),
    ]),
    list,
    status,
    el('div.ai-assistant__composer', {}, [input, sendButton]),
    el('p.ai-assistant__hint', {
      // 数据流向必须说清楚：会话摘要（任务标题、截止时间、剩余时长）会离开浏览器
      text: '助手只能给建议，日程调整需要你在预览页确认。你输入的对话，以及最多 8 个进行中任务的标题、科目、截止时间与剩余时长，会发送给 Google Gemini 用于生成回答；其余数据仍只保存在浏览器里。',
    }),
  );

  const wrap = el('div.ai-assistant', { 'data-glass': '' }, [panel, bubble]);
  root.appendChild(wrap);

  function toggle() {
    if (open) close();
    else openPanel();
  }

  function openPanel() {
    open = true;
    panel.hidden = false;
    bubble.setAttribute('aria-expanded', 'true');
    badge.hidden = true;
    badge.textContent = '';
    if (!greeted) {
      greeted = true;
      renderMessages();
      runOpener();
    }
    input.focus();
  }

  function close() {
    open = false;
    panel.hidden = true;
    bubble.setAttribute('aria-expanded', 'false');
  }

  function setBusy(next) {
    busy = next;
    sendButton.disabled = next;
    input.disabled = next;
    status.hidden = !next;
    status.textContent = next ? '助手正在思考…' : '';
    renderMessages();
  }

  function renderMessages() {
    list.replaceChildren();
    for (const message of messages) {
      list.appendChild(
        el(`div.ai-assistant__msg.ai-assistant__msg--${message.role}`, {}, [
          el('span.ai-assistant__who', { text: message.role === 'user' ? '你' : '助手' }),
          // 一律用 textContent（el 的 text 属性），绝不把模型输出当 HTML 插入
          el('p.ai-assistant__text', { text: message.content }),
        ]),
      );
    }
    if (messages.length === 0 && !busy) {
      list.appendChild(
        el('div.ai-assistant__empty', {}, [
          el('p', { text: '直接说你现在的情况就行，比如：' }),
          ...OPENERS.map((text) =>
            el('button.ai-assistant__chip', { type: 'button', text, on: { click: () => submit(text) } }),
          ),
        ]),
      );
    }
    list.scrollTop = list.scrollHeight;
  }

  function context() {
    try {
      return buildScheduleContext(app.getState(), now());
    } catch {
      return '';
    }
  }

  async function ask(text) {
    const clean = String(text ?? '').trim();
    if (!clean || busy) return;

    messages.push({ role: 'user', content: clean });
    setBusy(true);

    const result = await send({ messages, context: context() });

    if (result.ok) {
      // 只显示给人看的文字；提议块由 #/ai 页面解析，不进对话气泡
      messages.push({ role: 'assistant', content: stripProposalBlock(result.reply) });
      setBusy(false);
      if (!open) {
        // 没打开面板时把结论放到气泡角标上：这就是"打开页面即可看到 AI 结果"
        badge.hidden = false;
        badge.textContent = '1';
      }
      return { ok: true, reply: result.reply };
    }

    // 失败不写进对话历史（避免下一次把它当成上下文再发一遍）
    messages.pop();
    setBusy(false);
    if (!open) {
      toast(result.message, 'error');
    } else {
      list.appendChild(el('div.ai-assistant__msg.ai-assistant__msg--error', {}, [el('p.ai-assistant__text', { text: result.message })]));
    }
    return { ok: false, ...result };
  }

  function submit(text) {
    input.value = '';
    return ask(text);
  }

  /**
   * 页面加载后的自动问候：不等用户点任何东西，先把"今日建议"拿到。
   * 失败时静默（用户可能根本不想用助手，不该在首屏弹错误）；
   * 只有用户主动打开面板时才看得到失败原因。
   */
  /**
   * 自动问候的缓存。
   *
   * 为什么必须缓存：问候是**页面加载时自动发起的请求**，每次刷新都会消耗一次
   * AI 额度。免费额度下反复刷新测试很容易把每日限额用光
   * （实测就这样踩过：界面一直提示"额度用完，请几分钟后再试"）。
   *
   * 策略：同一天内、同一份任务摘要（任务增删改会改变摘要）就复用上次结果，
   * 不再发请求。这样刷新页面、切页面回来都不会重复消耗额度。
   */
  function greetingCacheKey() {
    try {
      const ctx = context();
      const raw = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
      // 简单哈希，避免把整段上下文塞进 localStorage 的键里
      let hash = 0;
      for (let i = 0; i < raw.length; i += 1) {
        hash = (hash * 31 + raw.charCodeAt(i)) | 0;
      }
      const today = new Date().toISOString().slice(0, 10);
      return `studyPlanner:ai:greeting:${today}:${hash}`;
    } catch {
      return null;
    }
  }

  function readGreetingCache() {
    const key = greetingCacheKey();
    if (!key) return null;
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return typeof raw === 'string' && raw.trim() ? raw : null;
    } catch {
      return null;
    }
  }

  function writeGreetingCache(text) {
    const key = greetingCacheKey();
    if (!key) return;
    try {
      globalThis.localStorage?.setItem(key, text);
    } catch {
      // 隐私模式 / 配额满：写不进去就算了，不影响功能
    }
  }

  async function runOpener() {
    const prompt = '用两三句话告诉我，根据我今天的任务和截止时间，最需要注意什么。不要列清单，不要复述我的任务。';

    const cached = readGreetingCache();
    if (cached) {
      messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: cached });
      if (!open) {
        badge.hidden = false;
        badge.textContent = '1';
      }
      renderMessages();
      return { ok: true, reply: cached, fromCache: true };
    }

    const result = await send({ messages: [{ role: 'user', content: prompt }], context: context() });
    if (result.ok) {
      const shown = stripProposalBlock(result.reply);
      messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: shown });
      writeGreetingCache(shown);
      if (!open) {
        badge.hidden = false;
        badge.textContent = '1';
      }
      renderMessages();
    } else {
      messages.length = 0;
      renderMessages();
      status.hidden = false;
      status.textContent = result.message;
    }
    return result;
  }

  renderMessages();
  // 首屏之后再生效，避免和主应用的首次渲染抢时间
  const schedule = globalThis.requestIdleCallback ?? ((cb) => setTimeout(cb, 600));
  schedule(() => {
    runOpener();
  });

  return {
    element: wrap,
    open: openPanel,
    close,
    isOpen: () => open,
    destroy: () => wrap.remove(),
  };
}
