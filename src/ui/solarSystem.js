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
export const SOLAR_ORBITS = Object.freeze([
  { rx: 23, ry: 27 },
  { rx: 36, ry: 42 },
  { rx: 48, ry: 57 },
]);

/**
 * 7 个核心模块的固定映射。
 *
 * `orbit` 从 0 开始（对应 SOLAR_ORBITS 的下标），`angle` 是放在该椭圆上的角度
 * （0° = 正右方，顺时针增加）。角度刻意错开，避免行星互相遮挡。
 */
export const SOLAR_BODIES = Object.freeze([
  { id: 'tasks', route: 'tasks', name: '学习任务', orbit: 0, angle: 205, size: 'md', planet: 'mercury' },
  { id: 'day', route: 'day', name: '每日视图', orbit: 0, angle: 325, size: 'sm', planet: 'venus' },
  { id: 'week', route: 'week', name: '七天计划', orbit: 1, angle: 160, size: 'lg', planet: 'earth' },
  { id: 'stats', route: 'stats', name: '学习统计', orbit: 1, angle: 250, size: 'md', planet: 'mars' },
  { id: 'garden', route: 'garden', name: '专注花园', orbit: 1, angle: 20, size: 'lg', planet: 'jupiter' },
  { id: 'activities', route: 'activities', name: '固定日程', orbit: 2, angle: 195, size: 'md', planet: 'saturn' },
  { id: 'ai', route: 'ai', name: 'AI 助手', orbit: 2, angle: 340, size: 'sm', planet: 'uranus' },
]);

/** 把 (轨道, 角度) 换算成舞台上的百分比坐标，供 CSS 定位使用 */
export function planetPosition(orbit, angle) {
  const ring = SOLAR_ORBITS[orbit] ?? SOLAR_ORBITS[0];
  const rad = (angle * Math.PI) / 180;
  return {
    x: Number((50 + ring.rx * Math.cos(rad)).toFixed(2)),
    y: Number((50 + ring.ry * Math.sin(rad)).toFixed(2)),
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
      ariaLabel: `${body.name}，${metric.value}${metric.detail ? `，${metric.detail}` : ''}`,
    };
  });

  return { sun, planets };
}

/** 计划状态 → 简短中文（只用于行星上的一行说明） */
const PLAN_STATUS_TEXT = Object.freeze({
  feasible: '完整可行',
  partially_feasible: '部分可行',
  infeasible: '当前不可行',
  invalid_input: '输入有误',
});

export { compactDuration };
