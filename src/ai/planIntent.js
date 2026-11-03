/**
 * 「用户这句话是不是在要求改计划？」——纯函数。
 *
 * 为什么需要它：右下角的 AI 气泡用的是**普通聊天通道**（纯文本，不产生结构化提议），
 * 而真正能改计划的是 #/ai 页的「帮我改计划」（结构化通道 + 程序校验 + 预览确认）。
 *
 * 于是出现一个体验断点：用户在气泡里说"帮我加个任务"，模型只能回答"我无法直接添加"，
 * 用户会以为功能没做。实际上功能在另一个页面。
 *
 * 这里把"识别意图"抽成纯函数，气泡据此显示一个跳转按钮，
 * 把用户带到真正能做这件事的地方——而不是让他在两个入口之间猜。
 *
 * 注意：这**不是**要替用户执行任何操作，只是决定要不要显示一个按钮。
 * 误判的代价很低（多显示一个按钮），漏判的代价是用户找不到功能。
 */

/** 新建：动词 + 宾语（容忍几个字的间隔，例如"给我添加一个数学作业"） */
const CREATE_RE = /(加|添加|新建|创建|建|安排)[^。！？\n]{0,8}(任务|作业|练习|报告|论文|背诵|复习)/;

/** 删除：动词 + 任务，或"彻底删除" */
const DELETE_RE = /(删掉|删除|删了|移除|清掉|彻底删)/;

/**
 * 修改：动词与字段**两种顺序都算**。
 *
 * "把数学作业改到周六截止" 是 动词 → 字段；
 * "把化学实验的截止日期改到上个月" 是 字段 → 动词。
 * 只写一种顺序会漏掉一半说法（实测漏过后者）。
 */
const UPDATE_FIELDS = '(截止|日期|时间|用时|时长|分钟|重要|难度|科目|名字|标题|拆分|开始)';
const UPDATE_VERBS = '(改|换|调整|调成|改成|修改)';
const UPDATE_RE = new RegExp(
  `${UPDATE_VERBS}[^。！？\\n]{0,10}${UPDATE_FIELDS}|${UPDATE_FIELDS}[^。！？\\n]{0,10}${UPDATE_VERBS}`,
);

/** 状态：完成 / 取消 */
const STATUS_RE = /(做完|写完|完成了|已经完成|做完了|取消|不做了|不用做了)/;

/**
 * @param {string} text 用户输入
 * @returns {boolean} 是否像"要求改计划"
 */
export function looksLikePlanChange(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value) return false;
  return CREATE_RE.test(value) || DELETE_RE.test(value) || UPDATE_RE.test(value) || STATUS_RE.test(value);
}

/** 气泡里那句话对应的按钮文案（与 AI 页的卡片标题保持一致） */
export const PLAN_CHANGE_CTA = '去「AI 助手」页改计划';
