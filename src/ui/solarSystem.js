/**
 * 首页「七天太阳系」的数据模型（纯函数，不碰 DOM）。
 *
 * 为什么单独一个模块：
 * - 太阳系是**导航 + 状态总览**，不是装饰。每个天体的名称、数值、去向
 *   都必须可独立测试，不能散落在 CSS 或模板字符串里；
 * - 数据口径必须与页面内其它统计一致，所以这里只做"取值 + 格式化"，
 *   不重新计算任何业务指标（全部来自 statsService / planService / state）。
 *
 * 设计取舍：只承载 **7 个核心模块**。设置、外观、通知、版本历史、调整预览
 * 仍然留在侧边栏——太阳系一旦塞满就变成第二个导航栏，反而更难用。
 */

/** 天体几何：三条轨道，越靠外半径越大。数值是相对舞台的百分比半径。 */
/**
 * 三条轨道的**半轴**（相对面板宽/高的百分比）。
 *
 * 约束（改动前请先读懂）：
 * 1. 外圈宽度 = rx*2 ≤ 92%，高度 = ry*2 ≤ 88%——否则轨道会被面板的
 *    `overflow: hidden` 裁掉（早期版本 ry=57 即 114%，上下明显被切）；
 * 2. 行星坐标 = 50 ± rx/ry，必须落在 12–88 的安全区，
 *    给球体半径、chip 与 hover 光晕留出空间。
 *    因此 rx 上限约 38、ry 上限约 31。
 * 3. CSS 里的轨道尺寸**由这份数据驱动**（宽度 2rx%、高度 2ry%），
 *    不再在样式表里手写第二套百分比——两套数值必然错位。
 */
export const SOLAR_ORBITS = Object.freeze([
  { rx: 21, ry: 19 },
  { rx: 30, ry: 27 },
  { rx: 38, ry: 34 },
]);

/**
 * 7 个核心模块的固定映射。
 *
 * `orbit` 从 0 开始（对应 SOLAR_ORBITS 的下标），`angle` 是放在该椭圆上的角度
 * （0° = 正右方，顺时针增加）。角度刻意错开，避免行星互相遮挡。
 */
export const SOLAR_BODIES = Object.freeze([
  /**
   * 角度经过实测调整：早期取值会让相邻轨道的 chip 压住下一颗行星
   * （实测「每日视图」的 chip 压住「专注花园」、「固定日程」的 chip 压住「七天计划」）。
   * 调整原则：同一侧的行星尽量上下错开，且相邻轨道之间留出一个 chip 的高度。
   */
  { id: 'tasks', route: 'tasks', name: '学习任务', orbit: 0, angle: 191, size: 'md', planet: 'mercury' },
  { id: 'day', route: 'day', name: '每日视图', orbit: 0, angle: 346, size: 'sm', planet: 'venus' },
  { id: 'week', route: 'week', name: '七天计划', orbit: 1, angle: 135, size: 'lg', planet: 'earth' },
  { id: 'stats', route: 'stats', name: '学习统计', orbit: 1, angle: 243, size: 'md', planet: 'mars' },
  { id: 'garden', route: 'garden', name: '专注花园', orbit: 1, angle: 36, size: 'lg', planet: 'jupiter' },
  { id: 'activities', route: 'activities', name: '固定日程', orbit: 2, angle: 162, size: 'md', planet: 'saturn' },
  { id: 'ai', route: 'ai', name: 'AI 助手', orbit: 2, angle: 334, size: 'sm', planet: 'uranus' },
]);

/** 把 (轨道, 角度) 换算成舞台上的百分比坐标，供 CSS 定位使用 */
export function planetPosition(orbit, angle) {
  const ring = SOLAR_ORBITS[orbit] ?? SOLAR_ORBITS[0];
  const rad = (angle * Math.PI) / 180;
  /**
   * 不做四舍五入：调用方（几何测试）要验证点严格落在椭圆上。
   * 保留完整精度后，(x-50)/rx 与 (y-50)/ry 的平方和精确等于 1；
   * 截断到 2 位小数会引入约 1e-4 的偏差，看起来"贴线"了但测试通不过。
   */
  return {
    x: 50 + ring.rx * Math.cos(rad),
    y: 50 + ring.ry * Math.sin(rad),
  };
}

/** 分钟数 → 紧凑中文（避免首页出现 "0 分钟" 这类噪音） */
function compactDuration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value <= 0) return '0 分钟';
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  if (hours === 0) return `${mins} 分钟`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分`;
}

/**
 * 构建太阳系模型。
 *
 * 所有输入都是**已经算好的真实数据**（由调用方从服务层取），
 * 这里不做统计口径的二次推导，避免与页面其它地方出现两套数字。
 *
 * @param {object} input
 * @param {object} input.state 应用状态（只读，用于取任务、固定日程、时段）
 * @param {object} input.todayStats statsService.today()
 * @param {object} input.weekStats statsService.weekly()
 * @param {object} input.streak statsService 的连续学习统计
 * @param {object|null} input.plan 当前正式计划
 * @param {string} input.today 今天的日期
 * @param {number} input.gardenFocusMinutes 今日专注分钟（来自花园真实记录，取不到则 0）
 * @returns {{sun: object, planets: object[]}}
 */
export function buildSolarSystemModel({
  state,
  todayStats,
  weekStats,
  streak,
  plan,
  today,
  gardenFocusMinutes = 0,
}) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const fixedActivities = Array.isArray(state?.fixedActivities) ? state.fixedActivities : [];

  const activeTasks = tasks.filter((task) => task.status === 'not_started' || task.status === 'in_progress');
  const todaySessions = sessions.filter((session) => session.date === today && session.state !== 'cancelled');

  // —— 太阳：今日总览 ——
  const plannedToday = Number(todayStats?.scheduledMinutes ?? todayStats?.plannedMinutes ?? 0);
  const doneToday = Number(todayStats?.actualMinutes ?? 0);
  const percent = plannedToday > 0 ? Math.min(100, Math.round((doneToday / plannedToday) * 100)) : 0;

  const sun = {
    id: 'home',
    route: 'home',
    name: '今日总览',
    value: plannedToday > 0 ? `${percent}%` : '未安排',
    detail: plannedToday > 0 ? `已完成 ${compactDuration(doneToday)}` : '今天还没有学习安排',
    percent,
    ariaLabel:
      plannedToday > 0
        ? `今日总览，完成 ${percent}%，已学习 ${compactDuration(doneToday)}，返回首页`
        : '今日总览，今天还没有学习安排，返回首页',
  };

  // —— 每个行星的真实数据 ——
  const remainingMinutes = activeTasks.reduce((sum, task) => {
    const done = sessions
      .filter((session) => session.taskId === task.id && session.state === 'completed')
      .reduce((acc, session) => acc + (session.actualMinutes ?? session.plannedMinutes ?? 0), 0);
    return sum + Math.max(0, (task.plannedMinutes ?? 0) - done);
  }, 0);

  const planDays = Array.isArray(plan?.days) ? plan.days.filter((day) => (day.studyMinutes ?? 0) > 0).length : 0;
  const planStatus = plan?.status ? PLAN_STATUS_TEXT[plan.status] ?? plan.status : '尚未生成';

  const metricByBody = {
    tasks: {
      value: `${activeTasks.length} 个待办`,
      detail: remainingMinutes > 0 ? `剩余 ${compactDuration(remainingMinutes)}` : '没有待完成的工作量',
    },
    day: {
      value: `${todaySessions.length} 个时段`,
      detail:
        todaySessions.length > 0
          ? `${todaySessions.filter((session) => session.state === 'completed').length} 段已完成`
          : '今天还没有安排时段',
    },
    week: {
      value: plan ? `${planDays} 天有安排` : '尚未生成',
      // 没有计划时不要再把"尚未生成"重复一遍，而是给出下一步动作
      detail: plan ? planStatus : '去生成七天计划',
    },
    stats: {
      value: compactDuration(weekStats?.thisWeek?.actualMinutes ?? 0),
      detail: streak?.current > 0 ? `连续 ${streak.current} 天` : '本周实际学习',
    },
    garden: {
      value: gardenFocusMinutes > 0 ? compactDuration(gardenFocusMinutes) : '查看记录',
      detail: gardenFocusMinutes > 0 ? '今日专注' : '还没有今日专注记录',
    },
    activities: {
      value: `${fixedActivities.length} 条`,
      detail: fixedActivities.length > 0 ? '固定日程' : '还没有固定日程',
    },
    ai: {
      value: '随时提问',
      detail: '可以问日程与取舍',
    },
  };

  /**
   * chip 需要翻到球体上方的阈值。
   *
   * 面板高度约 480–560px，chip 高约 46px（含间距）。y 超过 62% 时，
   * 球体下方已放不下 chip，必须翻到上方——否则会被 .solar 的 overflow 裁掉。
   * 这个判断放在模型里（而不是 CSS），因为它是**几何事实**，可以测试。
   */
  /**
   * chip 放置方向：**朝远离太阳的一侧**。
   *
   * 早期版本一律把 chip 放在球体下方，结果是外圈下方行星的 chip 顶到面板边缘，
   * 内圈行星的 chip 又压住下一圈的行星——无论怎么调角度都会有一两处重叠。
   * 改成"上半区的行星 chip 朝上、下半区朝下"之后，chip 总是往空旷处伸展，
   * 同时也避开了中间的太阳。
   *
   * 这个判断是几何事实，放在模型里可以直接被测到。
   */
  const UPPER_HALF_Y = 50;

  const planets = SOLAR_BODIES.map((body) => {
    const metric = metricByBody[body.id] ?? { value: '', detail: '' };
    const position = planetPosition(body.orbit, body.angle);
    return {
      ...body,
      href: `#/${body.route}`,
      value: metric.value,
      detail: metric.detail,
      x: position.x,
      y: position.y,
      flip: position.y < UPPER_HALF_Y,
      ariaLabel: `${body.name}，${metric.value}${metric.detail ? `，${metric.detail}` : ''}`,
    };
  });

  /**
   * 同时返回轨道定义：组件据此设置每条轨道的宽度/高度。
   * 这样"轨道画多大"与"行星放在哪"共用同一份数据，不会出现两套数值。
   */
  return { sun, planets, orbits: SOLAR_ORBITS };
}

/** 计划状态 → 简短中文（只用于行星上的一行说明） */
const PLAN_STATUS_TEXT = Object.freeze({
  feasible: '完整可行',
  partially_feasible: '部分可行',
  infeasible: '当前不可行',
  invalid_input: '输入有误',
});

export { compactDuration };
