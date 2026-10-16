/**
 * ID 生成。
 *
 * 设计原因：
 * - 用户创建的任务/时段 ID 必须稳定且不随时间碰撞，用「前缀 + 时间戳 + 计数 + 随机字节」。
 * - 引擎内部派生的候选时段 ID 必须**确定性**（同输入同输出），因此不使用本模块，
 *   而是由 `engine/versionHash.js` 从 inputHash 派生（见阶段 2）。
 * - 测试需要可预测的 ID，因此序列生成器支持注入固定种子与固定时钟。
 */

export const ID_PREFIXES = Object.freeze({
  task: 'tsk',
  session: 'ses',
  fixedActivity: 'fix',
  plan: 'pln',
  preview: 'pvw',
  block: 'blk',
  event: 'evt',
});

const BASE36 = 36;

/** 简单确定性伪随机数发生器（mulberry32）；仅用于 ID 去重，不用于业务决策。 */
export function createSeededRandom(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 创建一个 ID 生成器。
 * @param {object} [options]
 * @param {() => number} [options.clock] 返回毫秒时间戳的函数，默认 Date.now（测试可注入固定值）
 * @param {() => number} [options.random] 返回 [0,1) 的函数，默认使用种子随机
 * @param {number} [options.seed] 随机种子，保证测试可复现
 */
export function createIdFactory(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const random = typeof options.random === 'function' ? options.random : createSeededRandom(options.seed ?? 20251016);
  const counters = new Map();
  const issued = new Set();

  return {
    /**
     * 生成一个形如 `tsk_lq3k9x_0007` 的 ID，保证同一工厂实例内永不重复。
     * @param {keyof typeof ID_PREFIXES} kind
     */
    next(kind) {
      const prefix = ID_PREFIXES[kind];
      if (!prefix) throw new RangeError(`未知的 ID 类型：${kind}`);
      const count = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, count);
      const stamp = Math.floor(clock()).toString(BASE36);
      const noise = Math.floor(random() * 0xffffff).toString(BASE36).padStart(5, '0');
      let id = `${prefix}_${stamp}${noise}_${String(count).padStart(4, '0')}`;
      while (issued.has(id)) {
        const again = Math.floor(random() * 0xffffff).toString(BASE36).padStart(5, '0');
        id = `${prefix}_${stamp}${again}_${String(count).padStart(4, '0')}`;
      }
      issued.add(id);
      return id;
    },

    /** 判断一个 ID 是否由本工厂签发 */
    has(id) {
      return issued.has(id);
    },

    /** 已签发数量（测试用） */
    size() {
      return issued.size;
    },
  };
}

/** 全项目共用的默认工厂（UI / services 层使用；引擎层禁止使用） */
export const defaultIdFactory = createIdFactory();

/** 判断字符串是否形如某个已知前缀的 ID */
export function idKindOf(id) {
  if (typeof id !== 'string') return null;
  const prefix = id.split('_')[0];
  const entry = Object.entries(ID_PREFIXES).find(([, p]) => p === prefix);
  return entry ? entry[0] : null;
}
