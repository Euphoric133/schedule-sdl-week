/**
 * 生成 showcase.html（单文件放映演示）。
 *
 * 为什么用脚本生成而不是手写 20 页 HTML：
 * 每页结构一致（标题/副标题/正文/备注），用数据 + 一个页面模板可以保证
 * 排版、动画节奏、页码与备注不会随着改内容而走形。
 *
 * 输出要求：单文件、无外链、file:// 直接可打开、可打印。
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'showcase.html');

/** 线性图标（内联 SVG，自己画；不使用 emoji 或图标库） */
const ICONS = {
  stack: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  compass: '<circle cx="12" cy="12" r="8"/><path d="M15 9l-2.2 5.8L7 17l2.2-5.8z"/>',
  scissors: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><path d="M9 7l11 10M9 17L20 7"/>',
  hourglass: '<path d="M7 4h10M7 20h10M8 4c0 4 8 4 8 8s-8 4-8 8"/>',
  plate: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  todo: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  bot: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/>',
  hand: '<path d="M9 11V6a1.5 1.5 0 013 0v5m0-3a1.5 1.5 0 013 0v4m0-2a1.5 1.5 0 013 0v5a6 6 0 01-6 6H9a5 5 0 01-5-5v-3a1.5 1.5 0 013 0"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9h6v6H9z"/>',
};

function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.app}</svg>`;
}

/** 与产品同源的 Logo（内联，避免外部文件依赖） */
const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="2" y="2" width="20" height="20" rx="6.5" fill="#0e1520"/>
  <circle cx="12" cy="12" r="8.6" stroke="#6ba4f0" stroke-width="1.6" fill="none"/>
  <g stroke="#d6ae4e" stroke-width="1.3" stroke-linecap="round">
    <path d="M12 6.4V5"/><path d="M16.38 8.51l1.09-.87"/><path d="M17.46 13.25l1.36.31"/>
    <path d="M14.43 17.05l.61 1.26"/><path d="M9.57 17.05l-.61 1.26"/>
    <path d="M6.54 13.25l-1.36.31"/><path d="M7.62 8.51l-1.09-.87"/>
  </g>
  <g stroke="#eef2f8" stroke-width="1.9" stroke-linecap="round">
    <path d="M12 12l.52-2.95"/><path d="M12 12l3.64 2.1"/>
  </g>
  <circle cx="12" cy="12" r="1.25" fill="#d6ae4e"/>
</svg>`;

const starfield = Array.from({ length: 46 }, (_, i) => {
  const x = ((i * 137.508) % 100).toFixed(2);
  const y = ((i * 61.803) % 100).toFixed(2);
  const r = (0.5 + ((i * 7) % 10) / 14).toFixed(2);
  const o = (0.18 + ((i * 13) % 40) / 100).toFixed(2);
  return `<circle cx="${x}%" cy="${y}%" r="${r}" opacity="${o}" fill="#cfe0f8"/>`;
}).join('');

const slides = [
  {
    kind: 'cover',
    eyebrow: 'MYP AI SDL WEEK · 行动方案展示',
    title: 'AI 学习规划与执行助手',
    sub: '告诉它作业和空闲时间，它帮你安排好未来七天',
    meta: '9 年级 4 班　·　陈家晋 · 宋建宇　·　2026.10.30',
    chips: ['确定性排程', 'AI 辅助建议', '本地优先', '0 运行时依赖'],
    notes: '开场 30 秒：我们做一个"排得进去"的计划工具。强调它不是聊天机器人，核心是确定性排程。',
  },
  {
    kind: 'statement',
    big: '计划不是写在纸上，<br>是排得进去。',
    sub: '输入相同 → 计划相同；每一处改动都先给你看，你点确认才生效。',
    proof: [
      ['853', '自动化测试全通过'],
      ['0', '运行时依赖'],
      ['59', '可运行历史版本'],
    ],
    notes: '这一页定调：我们的价值不是"生成计划"，而是"排得进去并且可控"。',
  },
  {
    kind: 'agenda',
    items: [
      ['01', '产品介绍', '我们做什么、为谁做、解决什么问题'],
      ['02', '现场演示', '输入作业，看系统排出七天计划'],
      ['03', '开发过程', '用 AI 工具辅助完成规则与界面'],
      ['04', '测试与反思', '发现问题、修复问题与收获'],
    ],
    notes: '四步走完，约 8 分钟；演示环节会现场打开网页。',
  },
  {
    kind: 'grid-list',
    eyebrow: '用户痛点',
    title: '知道该学，却总在截止前赶工',
    sub: '同时上多门课，时间被课程、吃饭、社团切得很碎',
    icons: true,
    items: [
      ['stack', '任务堆在一起', '数学、英语、生物三份作业同时压过来'],
      ['compass', '不知道先做哪个', '哪天真该花多少时间，全靠猜'],
      ['scissors', '大作业不会拆', '100 分钟的论文想分几天写，却不知怎么分'],
      ['hourglass', '排计划太费时间', '手排一次半小时，一改就全乱'],
      ['plate', '整块时间被切碎', '上课、吃饭、社团，凑不出连续两小时'],
    ],
    notes: '这五条来自我自己和同学的真实处境；不是调研报告，是我们每天的状态。',
  },
  {
    kind: 'compare',
    eyebrow: '需求分析',
    title: '现有工具排不出真正能执行的计划',
    rows: [
      ['通用日历', '只记时间，不懂任务难度和截止优先级', 'cross'],
      ['待办清单', '列了一堆事，不会告诉你排到哪天几点', 'cross'],
      ['AI 排程', '结果不可控，可能排出根本做不完的计划', 'cross'],
      ['手动排表', '每次重排要半小时，改一处全乱', 'cross'],
      ['本产品', '确定性排程 + 硬约束校验 + 改前预览', 'check'],
    ],
    notes: '关键差异在"可控"：AI 排程不可复现，我们的排程同输入同输出，可检查可撤销。',
  },
  {
    kind: 'four',
    eyebrow: '我们的答案',
    title: '把"排不出来"变成"排得清楚"',
    items: [
      ['自动排期', '综合截止日、难度、重要性与空闲时间，排出未来七天'],
      ['任务拆分', '100 分钟的大作业分到三天，总量守恒，可跟踪进度'],
      ['冲突检测', '时间不够就明说原因，不硬塞、不造假可行'],
      ['改前确认', '新增作业先看逐项改动预览，确认后才写入'],
    ],
    notes: '四件事对应四个技术点，后面各用一页展开。',
  },
  {
    kind: 'who',
    eyebrow: '目标人群',
    title: '为被多门课压着的中学生而做',
    tags: ['12–15 岁', '初中 / IB MYP', '每周都有作业与小测', '知道要学，但总在截止前赶工'],
    quote: '"我不是不想学，是每次坐下来都不知道该先做哪一个。"',
    notes: '人群画像是具体的：初中 IB MYP 阶段，多门课并行，作业与小测密集。',
  },
  {
    kind: 'feature',
    tag: '亮点 A',
    title: '确定性排程：同样的输入，永远同样的结果',
    bullets: [
      '排程是纯函数：不看时钟、不联网、不掷骰子',
      '10 条硬约束（H1–H10）逐条校验，违反就不交付',
      '排不下时如实报告原因，绝不偷偷压缩或取消',
      '每个未安排任务都有原因码 + 中文说明 + 建议',
    ],
    visual: 'determinism',
    notes: '这一页是最硬的技术点：可复现、可检查。测试里同一输入跑两次结果必须一致。',
  },
  {
    kind: 'feature',
    tag: '亮点 B',
    title: '任务拆分与依赖：大作业不再靠意志力',
    bullets: [
      '可拆分任务切成合规片段，跨天铺开',
      '所有片段总时长 = 任务剩余工作量（总量守恒）',
      '不可拆分任务必须一次排进连续时段，绝不切碎',
      '前置任务未完成，后续任务不会被排到前面',
    ],
    visual: 'split',
    notes: '用一条 100 分钟的长条变三条示意；这是学生最容易"手排失败"的地方。',
  },
  {
    kind: 'feature',
    tag: '亮点 C',
    title: '预览确认与撤销：改动永远可控',
    bullets: [
      '候选计划与正式计划严格分开，绝不偷偷替换',
      '差异逐条列出：新增 / 移动 / 拆分 / 缩短 / 取消 + 原因',
      '确认才写入；放弃则零改动；每次应用都留版本可回滚',
      '"本次无需调整"会直说，不拿一堆 0 糊弄你',
    ],
    visual: 'diff',
    notes: '强调"零静默改动"：任何变更都要经过预览这一步。',
  },
  {
    kind: 'feature',
    tag: '亮点 D',
    title: '专注执行闭环：计划接着计时跑',
    bullets: [
      '任务清单直接进专注页，点「专注」按任务时长开始',
      '倒计时 / 正计时双模式，暂停不丢时间，刷新不归零',
      '完成即回写：记录实际学习时段、任务完成、取消剩余时段',
      '番茄数与奖励转盘挂钩，完成一个任务额外发一次机会',
    ],
    visual: 'ring',
    notes: '演示时这里切到真实页面；这一页只是示意环形进度。',
  },
  {
    kind: 'feature',
    tag: '亮点 E',
    title: '体验：13 个页面，一套设计语言',
    bullets: [
      '深色为默认，冷蓝 + 暖金；液态玻璃分层，不牺牲可读性',
      '首页太阳系概念、七天看板、每日视图、调整预览统一风格',
      '浅色 / 深色 / 自定义壁纸；壁纸下自动提高不透明度',
      '键盘可操作、焦点可见、减少动态效果时关闭动画',
    ],
    visual: 'pages',
    notes: '13 个页面列表：首页、七天计划、每日视图、学习任务、固定日程、AI 助手、统计、专注花园、预览、版本历史、外观、通知、设置。',
  },
  {
    kind: 'ai',
    eyebrow: 'AI 的边界',
    title: 'AI 只提议，永不改数据',
    flow: ['你描述情况', 'AI 给方案', '程序校验', '生成预览', '你点确认'],
    rules: [
      ['只发必要数据', '任务标题、时长、截止与评分；备注与姓名不发送'],
      ['提议必须过校验', '任务必须存在、字段在白名单内、数值在范围内'],
      ['核心排程不用 AI', 'AI 从不决定"排到几点"，它只建议参数'],
      ['失败如实说明', '超时、限流、格式错误都给出原因与下一步'],
    ],
    notes: '这是产品原则：可解释、可回退。AI 失败也不影响排程与数据。',
  },
  {
    kind: 'metrics',
    eyebrow: '质量证据',
    title: '不是"能跑"，是"可验证"',
    items: [
      ['853', '自动化测试全通过', '单元 / 集成 / 端到端'],
      ['20', '验收场景逐条覆盖', 'docs/ACCEPTANCE.md'],
      ['0', '运行时依赖', '零第三方库、无 CDN'],
      ['93', '次提交 · 15 天', '2026-10-16 → 10-30'],
      ['59', '可运行历史版本', '每个提交都能打开'],
    ],
    footnote: '数据截至 2026-10-30　·　可现场复核：node --test "tests/**/*.test.js"　·　git rev-list --count HEAD',
    notes: '数字都在页脚注了截止日期，可现场复核：node --test、git rev-list --count HEAD。',
  },
  {
    kind: 'link',
    eyebrow: '第 2 步 · 现场演示',
    title: '现在打开，现场输入一份作业',
    url: 'https://powerschedule-bfq.pages.dev/',
    hint: '进入后点「学习任务」新建，再点「生成计划」看预览',
    notes: '现场演示 2 分钟：新建任务 → 生成计划 → 看预览差异 → 确认应用。',
  },
  {
    kind: 'link',
    eyebrow: '第 3 步 · 过程展示',
    title: '59 个版本，26 段原始 prompt',
    url: 'versions/index.html',
    hint: '每一段都写着"我当时的 prompt"与"它解决了什么"',
    notes: '这是我们的开发证据链：每个版本都能打开，每段 prompt 都有产出。',
  },
  {
    kind: 'tools',
    eyebrow: '开发过程 · AI 工具选型',
    title: '四个工具，各司其职',
    items: [
      ['ChatGPT', '灵感与早期 prompt', ['项目初期找方向', '写了部分初始 prompt', '对话变长后上下文受限'], '探索'],
      ['DeepSeek Harness', '主力开发', ['直接读取项目文件', '按仓库现状生成 prompt', '几轮后成为主力'], '主力'],
      ['Codex', '内嵌 AI 接入', ['作为接入平台使用', '验证提议结构'], '辅助'],
      ['Netlify / Cloudflare', '中继与部署', ['先 Netlify 跑通', '后迁 Cloudflare Pages'], '平台'],
    ],
    notes: '老实说：ChatGPT 帮我们起步，DeepSeek Harness 是主力，Codex 做接入验证。',
  },
  {
    kind: 'story',
    eyebrow: '第 4 步 · 最大困难',
    title: '最难的是"让 AI 真的能改计划"',
    steps: [
      ['跑通', 'Netlify 函数两小时跑通，AI 能回话了'],
      ['卡住', '但编辑受限、额度不够，改一次要等很久'],
      ['迁移', '换到 Cloudflare Worker 中继，跨域与重试自己处理'],
      ['收敛', '提议改成结构化 JSON：任务 id 必须来自枚举，校验不过就不展示'],
    ],
    notes: '这段是全项目最折腾的地方，也是学到最多的地方：不是"接上模型"就完了，是"让它可控"。',
  },
  {
    kind: 'learn',
    eyebrow: '第 5 步 · 反思',
    title: '我从这个项目里带走了什么',
    items: [
      ['01', '把大目标拆成可交付的小步', '需求、开发、测试、文档并行，学会排优先级而不是被事情推着走。'],
      ['02', 'AI 的效果取决于环境', '让它看见项目文件，比反复聊天更有效；上下文比措辞更重要。'],
      ['03', '判断力才是核心能力', '不是照单全收 AI 的输出，而是能看出哪里不对、怎么验证。'],
    ],
    footnote: '特别鸣谢：刘衍辰',
    notes: '三条收获对应 MYP 的三个学习成果：接受挑战、发展技能、协作与自主规划。',
  },
  {
    kind: 'end',
    big: 'THANK YOU',
    notes: '收尾留 30 秒提问时间；如果被问"AI 会不会乱改"，直接翻回第 13 页。',
  },
];

/* ------------------------------------------------------------------ *
 * 页面渲染
 * ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(inner, cls = '') {
  return `<div class="slide__inner ${cls}">${inner}</div>`;
}

function head(slide) {
  const tag = slide.tag ? `<span class="tag">${esc(slide.tag)}</span>` : '';
  const eyebrow = slide.eyebrow ? `<div class="eyebrow anim" style="--i:0">${esc(slide.eyebrow)}</div>` : '';
  const title = slide.title ? `<h2 class="title anim" style="--i:1">${esc(slide.title)}</h2>` : '';
  const sub = slide.sub ? `<p class="sub anim" style="--i:2">${slide.sub}</p>` : '';
  return `${eyebrow}${title ? `<div class="title-row">${tag}${title}</div>` : ''}${sub}`;
}

function renderSlide(slide, index) {
  const notes = slide.notes ? `<aside class="notes">${esc(slide.notes)}</aside>` : '';
  let body = '';

  switch (slide.kind) {
    case 'cover':
      body = wrap(`
        <div class="cover__stars">${starfield}</div>
        <div class="cover">${LOGO}
          <div class="eyebrow anim" style="--i:0">${esc(slide.eyebrow)}</div>
          <h1 class="display anim" style="--i:1">${esc(slide.title)}</h1>
          <p class="sub anim" style="--i:2">${esc(slide.sub)}</p>
          <div class="chips anim" style="--i:3">${slide.chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
          <div class="meta anim" style="--i:4">${esc(slide.meta)}</div>
        </div>`);
      break;

    case 'statement':
      body = wrap(`
        <div class="statement">
          <h2 class="statement__big anim" style="--i:0">${slide.big}</h2>
          <p class="sub anim" style="--i:1">${esc(slide.sub)}</p>
          <div class="proof anim" style="--i:2">${slide.proof
            .map(([n, label]) => `<div class="proof__item"><strong class="count" data-count="${esc(n)}">0</strong><span>${esc(label)}</span></div>`)
            .join('')}</div>
        </div>`);
      break;

    case 'agenda':
      body = wrap(`
        ${head(slide)}
        <ol class="agenda">${slide.items
          .map(([n, t, d], i) => `<li class="agenda__item anim" style="--i:${i + 2}"><span class="agenda__n">${esc(n)}</span><div><h3>${esc(t)}</h3><p>${esc(d)}</p></div></li>`)
          .join('')}</ol>`);
      break;

    case 'grid-list':
      body = wrap(`
        ${head(slide)}
        <ul class="pain">${slide.items
          .map(([ic, t, d], i) => `<li class="pain__item anim" style="--i:${i + 3}"><span class="pain__icon">${icon(ic)}</span><div><h3>${esc(t)}</h3><p>${esc(d)}</p></div></li>`)
          .join('')}</ul>`);
      break;

    case 'compare':
      body = wrap(`
        ${head(slide)}
        <ul class="compare">${slide.rows
          .map(([name, why, mark], i) => `<li class="compare__row anim ${mark === 'check' ? 'is-ours glow' : ''}" style="--i:${i + 3}">
            <span class="compare__name">${esc(name)}</span><span class="compare__why">${esc(why)}</span>
            <span class="compare__mark ${mark === 'check' ? 'is-ok' : 'is-no'}">${icon(mark, 'icon icon--mark')}</span></li>`)
          .join('')}</ul>`);
      break;

    case 'four':
      body = wrap(`
        ${head(slide)}
        <div class="four">${slide.items
          .map(([t, d], i) => `<div class="four__card anim" style="--i:${i + 3}"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`)
          .join('')}</div>`);
      break;

    case 'who':
      body = wrap(`
        ${head(slide)}
        <div class="who">
          <div class="who__tags anim" style="--i:3">${slide.tags.map((t) => `<span class="chip chip--lg">${esc(t)}</span>`).join('')}</div>
          <blockquote class="anim" style="--i:4">${esc(slide.quote)}</blockquote>
        </div>`);
      break;

    case 'feature':
      body = wrap(`
        ${head(slide)}
        <div class="feature">
          <ul class="feature__list">${slide.bullets
            .map((b, i) => `<li class="anim" style="--i:${i + 3}">${esc(b)}</li>`)
            .join('')}</ul>
          <div class="feature__visual anim" style="--i:3">${visual(slide.visual)}</div>
        </div>`);
      break;

    case 'ai':
      body = wrap(`
        ${head(slide)}
        <div class="flow">${slide.flow
          .map((f, i) => `<span class="flow__step anim" style="--i:${i + 3}">${esc(f)}</span>${i < slide.flow.length - 1 ? '<span class="flow__arrow anim" style="--i:' + (i + 3) + '">→</span>' : ''}`)
          .join('')}</div>
        <ul class="rules">${slide.rules
          .map(([t, d], i) => `<li class="anim" style="--i:${i + 4}"><strong>${esc(t)}</strong><span>${esc(d)}</span></li>`)
          .join('')}</ul>`);
      break;

    case 'metrics':
      body = wrap(`
        ${head(slide)}
        <div class="metrics">${slide.items
          .map(([n, label, hint], i) => `<div class="metrics__card anim ${i === 0 ? 'glow' : ''}" style="--i:${i + 3}">
            <strong class="count" data-count="${esc(n)}">0</strong>
            <span class="metrics__label">${esc(label)}</span>
            <span class="metrics__hint">${esc(hint)}</span></div>`)
          .join('')}</div>
        ${slide.footnote ? `<p class="footnote anim" style="--i:8">${esc(slide.footnote)}</p>` : ''}`);
      break;

    case 'link':
      body = wrap(`
        ${head(slide)}
        <a class="linkcard anim glow" style="--i:3" href="${esc(slide.url)}" target="_blank" rel="noopener">
          <span class="linkcard__label">打开</span>
          <span class="linkcard__url">${esc(slide.url)}</span>
        </a>
        <p class="hint anim" style="--i:4">${esc(slide.hint)}</p>`);
      break;

    case 'tools':
      body = wrap(`
        ${head(slide)}
        <div class="tools">${slide.items
          .map(([name, role, points, badge], i) => `<div class="tools__card anim ${i === 1 ? 'glow' : ''}" style="--i:${i + 3}">
            <span class="tools__badge">${esc(badge)}</span>
            <h3>${esc(name)}</h3><p class="tools__role">${esc(role)}</p>
            <ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`)
          .join('')}</div>`);
      break;

    case 'story':
      body = wrap(`
        ${head(slide)}
        <ol class="story">${slide.steps
          .map(([t, d], i) => `<li class="story__step anim ${i === 3 ? 'glow' : ''}" style="--i:${i + 3}"><span class="story__dot"></span><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`)
          .join('')}</ol>`);
      break;

    case 'learn':
      body = wrap(`
        ${head(slide)}
        <div class="learn">${slide.items
          .map(([n, t, d], i) => `<div class="learn__card anim" style="--i:${i + 3}"><span class="learn__n">${esc(n)}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`)
          .join('')}</div>
        ${slide.footnote ? `<p class="footnote anim" style="--i:7">${esc(slide.footnote)}</p>` : ''}`);
      break;

    case 'end':
      // 尾页只保留一句 THANK YOU（其余内容按需求移除）
      body = wrap(`
        <div class="end">
          <h2 class="display anim" style="--i:0">${esc(slide.big)}</h2>
        </div>`);
      break;

    default:
      body = wrap(head(slide));
  }

  const TRANS = ['fade', 'push', 'zoom', 'lift'];
  const SETS = ['a', 'b', 'c', 'd', 'e'];
  const trans = slide.trans ?? TRANS[index % TRANS.length];
  const animSet = slide.animSet ?? SETS[index % SETS.length];
  return `<section class="slide" id="slide-${index + 1}" data-index="${index}" data-kind="${slide.kind}" data-trans="${trans}" data-anim-set="${animSet}" aria-label="第 ${index + 1} 页">${body}${notes}</section>`;
}

/** 每个亮点页的示意图（纯 SVG / CSS） */
function visual(kind) {
  if (kind === 'determinism') {
    return `<div class="viz viz--same">
      <div class="viz__col"><span class="viz__cap">输入</span><span class="viz__bar"></span><span class="viz__bar"></span><span class="viz__bar viz__bar--short"></span></div>
      <span class="viz__eq">＝</span>
      <div class="viz__col"><span class="viz__cap">输出 A</span><span class="viz__blk"></span><span class="viz__blk"></span></div>
      <span class="viz__eq">＝</span>
      <div class="viz__col"><span class="viz__cap">输出 B</span><span class="viz__blk"></span><span class="viz__blk"></span></div>
    </div>`;
  }
  if (kind === 'split') {
    return `<div class="viz viz--split">
      <span class="viz__cap">100 分钟的大作业</span>
      <span class="longbar"></span>
      <span class="viz__arrow">↓ 自动拆分</span>
      <div class="splitbar"><i></i><i></i><i></i></div>
      <span class="viz__note">40 + 40 + 20 分钟　·　总量不变</span>
    </div>`;
  }
  if (kind === 'diff') {
    return `<div class="viz viz--diff">
      <div class="viz__col"><span class="viz__cap">旧计划</span><span class="blk" style="--w:82%"></span><span class="blk" style="--w:52%"></span><span class="blk" style="--w:64%"></span></div>
      <span class="viz__eq">→</span>
      <div class="viz__col"><span class="viz__cap">新计划</span><span class="blk blk--new" style="--w:64%"></span><span class="blk blk--new" style="--w:82%"></span><span class="blk blk--new" style="--w:52%"></span></div>
    </div>`;
  }
  if (kind === 'ring') {
    const C = 2 * Math.PI * 54;
    return `<div class="viz viz--ring">
      <svg viewBox="0 0 140 140" class="ring">
        <circle cx="70" cy="70" r="54" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="9"/>
        <circle class="ring__progress" cx="70" cy="70" r="54" fill="none" stroke="#6ba4f0" stroke-width="9"
          stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"
          transform="rotate(-90 70 70)"/>
        <circle cx="70" cy="6" r="2" fill="#6ba4f0"/>
      </svg>
      <span class="viz__cap">专注 68% · 41 / 60 分钟</span>
    </div>`;
  }
  return `<div class="viz viz--pages">
    <div class="pages">${['首页', '七天计划', '每日视图', '学习任务', '固定日程', 'AI 助手', '学习统计', '专注花园']
      .map((p) => `<span class="pages__chip">${p}</span>`)
      .join('')}<span class="pages__chip pages__chip--more">+5</span></div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * 页面骨架
 * ------------------------------------------------------------------ */

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI 学习规划与执行助手 · 行动方案展示</title>
<style>
  :root {
    --bg: #070b12;
    --bg-2: #0b1220;
    --panel: rgba(18, 26, 40, 0.72);
    --line: rgba(150, 180, 220, 0.16);
    --text: #eef2f8;
    --muted: #9fb0c6;
    --faint: #6b7d94;
    --blue: #6ba4f0;
    --blue-soft: rgba(107, 164, 240, 0.14);
    --gold: #d6ae4e;
    --radius: 18px;
    --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: radial-gradient(120% 90% at 50% -20%, #10203a 0%, var(--bg) 55%, #04060a 100%);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }

  /* —— 舞台：1920×1080 设计稿，等比缩放 —— */
  .viewport { position: fixed; inset: 0; overflow: hidden; }
  .stage {
    width: 1920px; height: 1080px;
    position: absolute;
    left: 50%; top: 50%;
    /* 先把自己中心对到视口中心，再围绕自身中心等比缩放：
       不再依赖 grid 居中（元素大于容器时 grid 会让它溢到右下角）。 */
    transform: translate(-50%, -50%) scale(var(--scale, 1));
    transform-origin: center center;
    background:
      radial-gradient(60% 50% at 12% 6%, rgba(107, 164, 240, 0.10), transparent 70%),
      radial-gradient(50% 46% at 88% 18%, rgba(214, 174, 78, 0.07), transparent 72%),
      radial-gradient(60% 60% at 60% 100%, rgba(80, 140, 220, 0.08), transparent 70%),
      linear-gradient(160deg, #0a111d, #060a11 60%);
    overflow: hidden;
  }
  .stage::after {
    content: '';
    position: absolute; inset: 0;
    background-image: radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px);
    background-size: 64px 64px;
    opacity: .5;
    pointer-events: none;
  }

  /* —— 幻灯片 —— */
  .slide {
    position: absolute; inset: 0;
    display: grid;
    padding: 96px 120px 120px;
    opacity: 0;
    visibility: hidden;
    transition: opacity 380ms var(--ease), transform 420ms var(--ease), visibility 0s linear 420ms;
  }
  /* 翻页过渡四种，按页分配，避免每次都是同一种"淡入" */
  .slide[data-trans="fade"] { transform: none; }
  .slide[data-trans="push"] { transform: translate3d(64px, 0, 0); }
  .slide[data-trans="zoom"] { transform: scale(.968); }
  .slide[data-trans="lift"] { transform: translate3d(0, 46px, 0); }
  .slide.is-active {
    opacity: 1; visibility: visible;
    transform: none;
    transition: opacity 380ms var(--ease), transform 460ms var(--ease), visibility 0s;
  }
  .slide__inner { position: relative; display: flex; flex-direction: column; justify-content: center; min-height: 0; }
  .slide[data-kind="cover"] { padding: 0; }
  .slide[data-kind="cover"] .slide__inner { height: 100%; justify-content: center; padding: 0 140px; }

  /* ==================================================================
     动画系统
     ------------------------------------------------------------------
     一页一种主入场 + 列表逐项错位，避免"整场只有一个上浮"。
     变体按 data-kind 分配，同一页内部再按 nth-child 交替左右。
     ================================================================== */

  .anim { opacity: 0; will-change: opacity, transform; }
  .slide.is-active .anim {
    animation-duration: 640ms;
    animation-timing-function: var(--ease);
    animation-fill-mode: both;
    animation-delay: calc(var(--i, 0) * 70ms + 140ms);
    animation-name: rise;
  }

  @keyframes rise   { from { opacity:0; transform: translate3d(0, 24px, 0); }  to { opacity:1; transform:none; } }
  @keyframes sink   { from { opacity:0; transform: translate3d(0,-18px, 0); }  to { opacity:1; transform:none; } }
  @keyframes leftIn { from { opacity:0; transform: translate3d(-48px, 0, 0); } to { opacity:1; transform:none; } }
  @keyframes rightIn{ from { opacity:0; transform: translate3d(48px, 0, 0); }  to { opacity:1; transform:none; } }
  @keyframes zoomIn { from { opacity:0; transform: scale(.90); }               to { opacity:1; transform: scale(1); } }
  @keyframes blurIn { from { opacity:0; filter: blur(14px); }                 to { opacity:1; filter: blur(0); } }
  @keyframes clipUp { from { opacity:0; clip-path: inset(0 0 100% 0); }       to { opacity:1; clip-path: inset(0 0 0 0); } }
  @keyframes popIn  {
    0%   { opacity:0; transform: scale(.82); }
    62%  { opacity:1; transform: scale(1.045); }
    100% { opacity:1; transform: scale(1); }
  }
  @keyframes flipIn {
    from { opacity:0; transform: perspective(1100px) rotateX(-14deg) translateY(20px); }
    to   { opacity:1; transform: perspective(1100px) rotateX(0) translateY(0); }
  }

  /* 按页面类型分配主入场 */
  .slide[data-kind="statement"] .statement__big     { animation-name: clipUp; }
  .slide[data-kind="statement"] .proof__item        { animation-name: flipIn; }
  .slide[data-kind="cover"] .logo                   { animation-name: zoomIn; }
  .slide[data-kind="cover"] .eyebrow                { animation-name: sink; }
  .slide[data-kind="cover"] .display                { animation-name: clipUp; }
  .slide[data-kind="agenda"] .agenda__item:nth-child(odd)  { animation-name: leftIn; }
  .slide[data-kind="agenda"] .agenda__item:nth-child(even) { animation-name: rightIn; }
  .slide[data-kind="grid-list"] .pain__item         { animation-name: blurIn; animation-duration: 720ms; }
  .slide[data-kind="compare"] .compare__row         { animation-name: leftIn; }
  .slide[data-kind="four"] .four__card              { animation-name: flipIn; }
  .slide[data-kind="who"] .chip                     { animation-name: popIn; animation-duration: 520ms; }
  .slide[data-kind="who"] blockquote                { animation-name: blurIn; }
  /* 五个亮点页连续出现，各用一套入场，避免"五页一个样" */
  .slide[data-kind="feature"][data-anim-set="a"] .feature__list li:nth-child(odd)  { animation-name: leftIn; }
  .slide[data-kind="feature"][data-anim-set="a"] .feature__list li:nth-child(even) { animation-name: rightIn; }
  .slide[data-kind="feature"][data-anim-set="a"] .feature__visual { animation-name: zoomIn; animation-duration: 760ms; }

  .slide[data-kind="feature"][data-anim-set="b"] .feature__list li:nth-child(odd)  { animation-name: sink; }
  .slide[data-kind="feature"][data-anim-set="b"] .feature__list li:nth-child(even) { animation-name: rise; }
  .slide[data-kind="feature"][data-anim-set="b"] .feature__visual { animation-name: flipIn; animation-duration: 820ms; }

  .slide[data-kind="feature"][data-anim-set="c"] .feature__list li { animation-name: blurIn; animation-duration: 700ms; }
  .slide[data-kind="feature"][data-anim-set="c"] .feature__visual { animation-name: clipUp; animation-duration: 820ms; }

  .slide[data-kind="feature"][data-anim-set="d"] .feature__list li:nth-child(odd)  { animation-name: rightIn; }
  .slide[data-kind="feature"][data-anim-set="d"] .feature__list li:nth-child(even) { animation-name: leftIn; }
  .slide[data-kind="feature"][data-anim-set="d"] .feature__visual { animation-name: popIn; animation-duration: 700ms; }

  .slide[data-kind="feature"][data-anim-set="e"] .feature__list li { animation-name: zoomIn; animation-duration: 620ms; }
  .slide[data-kind="feature"][data-anim-set="e"] .feature__visual { animation-name: rightIn; animation-duration: 800ms; }
  .slide[data-kind="ai"] .flow__step                { animation-name: popIn; animation-duration: 560ms; }
  .slide[data-kind="ai"] .rules li                  { animation-name: sink; }
  .slide[data-kind="metrics"] .metrics__card        { animation-name: popIn; animation-duration: 580ms; }
  .slide[data-kind="link"] .linkcard                { animation-name: clipUp; animation-duration: 720ms; }
  .slide[data-kind="tools"] .tools__card            { animation-name: flipIn; }
  .slide[data-kind="tools"] .tools__badge           { animation-name: popIn; animation-delay: .5s; }
  .slide[data-kind="story"] .story__step            { animation-name: rightIn; }
  .slide[data-kind="learn"] .learn__card            { animation-name: zoomIn; }
  .slide[data-kind="end"] .display                  { animation-name: clipUp; animation-duration: 900ms; }

  /* 逐个错位：列表/网格内部的元素按序号递增 */
  .slide[data-kind="grid-list"] .pain__item:nth-child(2),
  .slide[data-kind="metrics"] .metrics__card:nth-child(2),
  .slide[data-kind="tools"] .tools__card:nth-child(2),
  .slide[data-kind="story"] .story__step:nth-child(2),
  .slide[data-kind="learn"] .learn__card:nth-child(2) { animation-delay: .26s; }
  .slide[data-kind="grid-list"] .pain__item:nth-child(3),
  .slide[data-kind="metrics"] .metrics__card:nth-child(3),
  .slide[data-kind="tools"] .tools__card:nth-child(3),
  .slide[data-kind="story"] .story__step:nth-child(3),
  .slide[data-kind="learn"] .learn__card:nth-child(3) { animation-delay: .38s; }
  .slide[data-kind="grid-list"] .pain__item:nth-child(4),
  .slide[data-kind="metrics"] .metrics__card:nth-child(4),
  .slide[data-kind="tools"] .tools__card:nth-child(4),
  .slide[data-kind="story"] .story__step:nth-child(4) { animation-delay: .50s; }
  .slide[data-kind="grid-list"] .pain__item:nth-child(5),
  .slide[data-kind="metrics"] .metrics__card:nth-child(5) { animation-delay: .62s; }
  .slide[data-kind="who"] .chip:nth-child(2) { animation-delay: .26s; }
  .slide[data-kind="who"] .chip:nth-child(3) { animation-delay: .34s; }
  .slide[data-kind="who"] .chip:nth-child(4) { animation-delay: .42s; }

  /* ==================================================================
     明暗突出
     ------------------------------------------------------------------
     每页有一道缓慢扫过的"主光"，重点元素再叠一层辉光。
     不用 filter: brightness 压暗整页（会糊字），只用局部透明度与描边。
     ================================================================== */
  .slide::before {
    content: '';
    position: absolute; inset: -10% -6%;
    background:
      radial-gradient(38% 34% at 26% 14%, rgba(107,164,240,.20), transparent 72%),
      radial-gradient(30% 28% at 78% 78%, rgba(214,174,78,.10), transparent 74%);
    opacity: 0;
    pointer-events: none;
    z-index: 0;
  }
  .slide.is-active::before { animation: keyLight 2200ms var(--ease) both; }
  @keyframes keyLight {
    0%   { opacity: 0; transform: translate3d(-3%, -2%, 0) scale(1.04); }
    45%  { opacity: .85; }
    100% { opacity: .38; transform: none; }
  }

  /* 重点元素：描边辉光（用伪元素，避免和入场动画抢 box-shadow） */
  .glow { position: relative; }
  .glow::after {
    content: '';
    position: absolute; inset: -1px; border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    box-shadow: 0 0 0 1px rgba(107,164,240,.55), 0 0 34px rgba(107,164,240,.30);
  }
  .slide.is-active .glow::after { animation: glowIn 2600ms var(--ease) 900ms both; }
  @keyframes glowIn {
    0%   { opacity: 0; }
    35%  { opacity: 1; }
    100% { opacity: .45; }
  }

  /* 非重点元素压暗，制造"主次"。
     必须用 filter 而不是 opacity：入场动画结束在 opacity:1 且 fill: both，
     会把静态的 opacity 覆盖掉（试过，视觉上等于没压暗）。 */
  .slide[data-kind="compare"] .compare__row:not(.is-ours) { filter: brightness(.66) saturate(.8); }
  .slide[data-kind="tools"] .tools__card:not(.glow) { filter: brightness(.64) saturate(.8); }
  .slide[data-kind="story"] .story__step:not(.glow) { filter: brightness(.7); }
  .slide[data-kind="metrics"] .metrics__card:not(.glow) { filter: brightness(.78); }

  /* 重点元素额外描边（静态，不参与动画） */
  .slide[data-kind="compare"] .is-ours,
  .slide[data-kind="link"] .linkcard { border-color: rgba(107,164,240,.55); }

  /* 故事页的节点圆点：弹一下，强调"时间在推进" */
  .slide[data-kind="story"] .story__dot { animation: dotPop 520ms var(--ease) both; }
  .slide[data-kind="story"] .story__step:nth-child(2) .story__dot { animation-delay: .26s; }
  .slide[data-kind="story"] .story__step:nth-child(3) .story__dot { animation-delay: .38s; }
  .slide[data-kind="story"] .story__step:nth-child(4) .story__dot { animation-delay: .50s; }
  @keyframes dotPop {
    0%   { transform: translateY(-50%) scale(0); opacity: 0; }
    70%  { transform: translateY(-50%) scale(1.5); opacity: 1; }
    100% { transform: translateY(-50%) scale(1); opacity: 1; }
  }

  /* 尾页与主张页：文字自带一点光晕 */
  .slide[data-kind="end"] .display,
  .slide[data-kind="statement"] .statement__big {
    text-shadow: 0 0 46px rgba(107,164,240,.28);
  }

  /* 图标线条描边动画 */
  .slide.is-active .icon path,
  .slide.is-active .icon circle { animation: draw 900ms var(--ease) .3s both; }
  @keyframes draw { from { stroke-dasharray: 60; stroke-dashoffset: 60; } to { stroke-dasharray: 60; stroke-dashoffset: 0; } }

  /* —— 排版 —— */
  .eyebrow {
    font-size: 20px; letter-spacing: .22em; text-transform: uppercase;
    color: var(--blue); font-weight: 600; margin-bottom: 18px;
  }
  .title-row { display: flex; align-items: center; gap: 20px; }
  .tag {
    flex: none; font-size: 18px; font-weight: 700; padding: 6px 16px; border-radius: 999px;
    background: var(--blue-soft); color: var(--blue); border: 1px solid rgba(107,164,240,.34);
  }
  .title { margin: 0 0 18px; font-size: 58px; line-height: 1.2; letter-spacing: -.01em; font-weight: 650; }
  .sub { margin: 0; font-size: 24px; line-height: 1.6; color: var(--muted); max-width: 1180px; }
  .display { font-size: 92px; line-height: 1.14; font-weight: 700; letter-spacing: -.02em; margin: 0 0 22px; }

  /* —— 封面 —— */
  .cover { position: relative; z-index: 1; max-width: 1180px; }
  .cover__stars { position: absolute; inset: 0; }
  .logo { width: 88px; height: 88px; display: block; margin-bottom: 34px; border-radius: 22px; box-shadow: 0 18px 44px rgba(0,0,0,.45); }
  .chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 34px; }
  .chip {
    font-size: 18px; padding: 8px 18px; border-radius: 999px;
    background: rgba(255,255,255,.04); border: 1px solid var(--line); color: var(--muted);
  }
  .chip--lg { font-size: 22px; padding: 12px 24px; color: var(--text); text-decoration: none; }
  .chip--lg:hover { border-color: var(--blue); color: var(--blue); }
  .meta { margin-top: 30px; font-size: 19px; color: var(--faint); letter-spacing: .02em; }

  /* —— 主张页 —— */
  .statement { max-width: 1300px; }
  .statement__big { font-size: 84px; line-height: 1.24; margin: 0 0 26px; font-weight: 700; letter-spacing: -.02em; }
  .proof { display: flex; gap: 18px; margin-top: 52px; }
  .proof__item {
    flex: 1; padding: 26px 28px; border-radius: var(--radius);
    background: var(--panel); border: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 6px;
    backdrop-filter: blur(14px);
  }
  .proof__item strong { font-size: 52px; color: var(--blue); font-variant-numeric: tabular-nums; }
  .proof__item span { font-size: 18px; color: var(--muted); }

  /* —— 议程 —— */
  .agenda { list-style: none; margin: 40px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
  .agenda__item {
    display: flex; gap: 22px; padding: 26px 28px; border-radius: var(--radius);
    background: var(--panel); border: 1px solid var(--line);
  }
  .agenda__n { font-size: 34px; font-weight: 700; color: var(--gold); font-variant-numeric: tabular-nums; }
  .agenda h3 { margin: 0 0 6px; font-size: 26px; }
  .agenda p { margin: 0; font-size: 18px; color: var(--muted); }

  /* —— 痛点 —— */
  .pain { list-style: none; margin: 34px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .pain__item {
    display: flex; gap: 16px; padding: 22px 24px; border-radius: var(--radius);
    background: var(--panel); border: 1px solid var(--line);
  }
  .pain__icon { flex: none; width: 34px; height: 34px; color: var(--blue); }
  .pain__icon .icon { width: 100%; height: 100%; }
  .icon { width: 22px; height: 22px; }
  .icon--mark { width: 22px; height: 22px; }
  .compare__mark { display: grid; place-items: center; }
  .compare__mark.is-ok { color: #6fd0a2; }
  .compare__mark.is-no { color: var(--faint); opacity: .7; }
  .pain h3 { margin: 0 0 6px; font-size: 21px; }
  .pain p { margin: 0; font-size: 17px; color: var(--muted); line-height: 1.5; }

  /* —— 对比 —— */
  .compare { list-style: none; margin: 32px 0 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .compare__row {
    display: grid; grid-template-columns: 220px 1fr 48px; align-items: center; gap: 20px;
    padding: 18px 24px; border-radius: 14px; background: rgba(255,255,255,.03);
    border: 1px solid var(--line); font-size: 20px;
  }
  .compare__row.is-ours { background: var(--blue-soft); border-color: rgba(107,164,240,.4); }
  .compare__name { font-weight: 600; }
  .compare__why { color: var(--muted); font-size: 19px; }
  .compare__mark { font-size: 20px; text-align: right; }

  /* —— 四件事 —— */
  .four { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 38px; }
  .four__card { padding: 30px 32px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); }
  .four__card h3 { margin: 0 0 10px; font-size: 28px; color: var(--blue); }
  .four__card p { margin: 0; font-size: 19px; color: var(--muted); line-height: 1.6; }

  /* —— 人群 —— */
  .who { margin-top: 36px; }
  .who__tags { display: flex; flex-wrap: wrap; gap: 14px; }
  .who blockquote {
    margin: 46px 0 0; padding: 28px 34px; border-left: 4px solid var(--gold);
    font-size: 30px; line-height: 1.6; color: #dbe6f5; background: rgba(214,174,78,.06);
    border-radius: 0 var(--radius) var(--radius) 0; max-width: 1200px;
  }

  /* —— 亮点页 —— */
  .feature { display: grid; grid-template-columns: 1.25fr 1fr; gap: 48px; margin-top: 40px; align-items: center; }
  .feature__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
  .feature__list li {
    position: relative; padding-left: 30px; font-size: 21px; line-height: 1.6; color: #d8e3f2;
  }
  .feature__list li::before {
    content: ''; position: absolute; left: 4px; top: 12px; width: 8px; height: 8px;
    border-radius: 50%; background: var(--blue);
  }
  .feature__visual { display: grid; place-items: center; min-height: 340px; }

  /* 示意图通用 */
  .viz { width: 100%; display: grid; gap: 14px; }
  .viz__cap { font-size: 15px; color: var(--faint); letter-spacing: .08em; }
  .viz__col { display: grid; gap: 10px; }
  .viz--same { grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 14px; }
  .viz__eq { font-size: 26px; color: var(--gold); }
  .viz__bar { height: 12px; border-radius: 6px; background: rgba(255,255,255,.14); }
  .viz__bar--short { width: 60%; }
  .viz__blk { height: 40px; border-radius: 8px; background: rgba(107,164,240,.22); border: 1px solid rgba(107,164,240,.4); }
  .viz__note { font-size: 16px; color: var(--faint); }
  .viz__arrow { font-size: 16px; color: var(--gold); }

  .viz--split { place-items: stretch; }
  .longbar { display: block; height: 34px; border-radius: 8px; background: linear-gradient(90deg, #3b6fb8, #2a4f86); }
  .splitbar { display: flex; gap: 10px; }
  .splitbar i { display: block; height: 34px; border-radius: 8px; background: rgba(107,164,240,.3); border: 1px solid rgba(107,164,240,.55); }
  .splitbar i:nth-child(1) { flex: 40; }
  .splitbar i:nth-child(2) { flex: 40; }
  .splitbar i:nth-child(3) { flex: 20; }
  .slide.is-active .splitbar i { animation: grow 700ms var(--ease) both; transform-origin: left center; }
  .slide.is-active .splitbar i:nth-child(2) { animation-delay: 90ms; }
  .slide.is-active .splitbar i:nth-child(3) { animation-delay: 180ms; }
  @keyframes grow { from { transform: scaleX(.08); opacity: .2; } to { transform: none; opacity: 1; } }

  .viz--diff { grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
  .blk { display: block; height: 26px; width: var(--w, 60%); border-radius: 6px; background: rgba(255,255,255,.12); }
  .blk--new { background: rgba(107,164,240,.3); border: 1px solid rgba(107,164,240,.5); }

  .viz--ring { place-items: center; }
  .ring { width: 280px; height: 280px; }
  .slide.is-active .ring__progress { animation: fill 1200ms var(--ease) 260ms both; }
  @keyframes fill { from { stroke-dashoffset: 339.29; } to { stroke-dashoffset: 108.57; } }

  .pages { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; max-width: 460px; }
  .pages__chip {
    font-size: 16px; padding: 8px 14px; border-radius: 10px;
    border: 1px solid var(--line); background: rgba(255,255,255,.03); color: var(--muted);
  }
  .pages__chip--more { color: var(--gold); border-color: rgba(214,174,78,.4); }

  /* —— AI 流程 —— */
  .flow { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 36px 0 34px; }
  .flow__step {
    font-size: 19px; padding: 12px 20px; border-radius: 12px;
    background: var(--panel); border: 1px solid var(--line);
  }
  .flow__step:last-child { border-color: rgba(214,174,78,.5); color: var(--gold); }
  .flow__arrow { color: var(--faint); font-size: 20px; }
  .rules { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; }
  .rules li { padding: 22px 24px; border-radius: 14px; background: rgba(255,255,255,.03); border: 1px solid var(--line); }
  .rules strong { display: block; font-size: 20px; margin-bottom: 8px; color: var(--blue); }
  .rules span { font-size: 17px; color: var(--muted); line-height: 1.6; }

  /* —— 数字 —— */
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 36px; }
  .metrics__card {
    padding: 26px 28px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 6px;
  }
  .metrics__card strong { font-size: 58px; color: var(--blue); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .metrics__label { font-size: 19px; }
  .metrics__hint { font-size: 15px; color: var(--faint); }
  .footnote { margin: 22px 0 0; font-size: 15px; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* —— 链接卡 —— */
  .linkcard {
    margin-top: 40px; display: flex; align-items: center; gap: 20px;
    padding: 34px 38px; border-radius: var(--radius);
    background: linear-gradient(120deg, rgba(107,164,240,.14), rgba(214,174,78,.08));
    border: 1px solid rgba(107,164,240,.4); text-decoration: none; color: var(--text);
    transition: transform 180ms var(--ease), border-color 180ms var(--ease);
  }
  .linkcard:hover { transform: translateY(-2px); border-color: var(--blue); }
  .linkcard__label { font-size: 17px; padding: 4px 12px; border-radius: 999px; background: var(--blue); color: #08111c; font-weight: 700; }
  .linkcard__url { font-size: 30px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hint { margin-top: 20px; font-size: 18px; color: var(--faint); }

  /* —— 工具 —— */
  .tools { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 36px; }
  .tools__card { position: relative; padding: 26px 24px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); }
  .tools__badge {
    position: absolute; top: 18px; right: 18px; font-size: 13px; padding: 3px 10px; border-radius: 999px;
    background: var(--blue-soft); color: var(--blue); border: 1px solid rgba(107,164,240,.35);
  }
  .tools__card h3 { margin: 0 0 6px; font-size: 24px; }
  .tools__role { margin: 0 0 14px; font-size: 16px; color: var(--gold); }
  .tools__card ul { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
  .tools__card li { font-size: 16px; color: var(--muted); line-height: 1.5; }

  /* —— 故事 —— */
  .story { list-style: none; margin: 36px 0 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
  .story__step { position: relative; padding: 24px 22px 24px 26px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); }
  .story__dot { position: absolute; top: 0; left: 26px; width: 10px; height: 10px; border-radius: 50%; background: var(--gold); transform: translateY(-50%); }
  .story__step h3 { margin: 6px 0 10px; font-size: 24px; }
  .story__step p { margin: 0; font-size: 17px; color: var(--muted); line-height: 1.6; }

  /* —— 反思 —— */
  .learn { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 40px; }
  .learn__card { padding: 30px 28px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); }
  .learn__n { font-size: 15px; letter-spacing: .12em; color: var(--gold); }
  .learn__card h3 { margin: 12px 0 10px; font-size: 25px; }
  .learn__card p { margin: 0; font-size: 17px; color: var(--muted); line-height: 1.65; }

  /* —— 结尾 —— */
  .end { text-align: center; display: grid; place-items: center; }
  .end .display { margin-bottom: 12px; }
  .end__links { display: flex; gap: 14px; margin-top: 34px; }
  .end .meta { margin-top: 40px; }

  /* —— 演讲备注 —— */
  .notes { display: none; }
  body.notes-on .notes {
    display: block; position: absolute; left: 120px; right: 120px; bottom: 96px;
    padding: 18px 24px; border-radius: 12px; font-size: 17px; line-height: 1.6;
    background: rgba(214, 174, 78, .12); border: 1px solid rgba(214, 174, 78, .35); color: #f0dfb6;
  }
  body.notes-on .notes::before { content: '演讲备注　'; color: var(--gold); font-weight: 700; }

  /* —— 控制条 —— */
  .hud {
    position: fixed; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.06); z-index: 20;
  }
  .hud__bar { height: 100%; width: 0; background: linear-gradient(90deg, var(--blue), var(--gold)); transition: width 320ms var(--ease); }
  .pager {
    position: fixed; right: 26px; bottom: 18px; z-index: 21;
    font: 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--faint);
    letter-spacing: .08em; user-select: none;
  }
  .pager b { color: var(--text); font-weight: 600; }
  body.hide-hud .pager { opacity: 0; }
  .navbtn {
    position: fixed; top: 50%; transform: translateY(-50%); z-index: 21;
    width: 44px; height: 80px; border: 0; border-radius: 10px; cursor: pointer;
    background: rgba(255,255,255,.04); color: var(--muted); font-size: 20px;
    opacity: 0; transition: opacity 200ms ease;
  }
  .navbtn:hover { opacity: 1; background: rgba(107,164,240,.12); }
  .navbtn--prev { left: 8px; } .navbtn--next { right: 8px; }
  .viewport:hover .navbtn { opacity: .35; }

  /* —— 总览 —— */
  .overview {
    position: fixed; inset: 0; z-index: 30; display: none; padding: 40px;
    background: rgba(5, 8, 13, .94); overflow: auto;
  }
  .overview.is-open { display: block; }
  .overview h2 { font-size: 20px; color: var(--muted); margin: 0 0 20px; font-weight: 500; letter-spacing: .1em; }
  .overview__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .overview__item {
    text-align: left; padding: 14px 16px; border-radius: 10px; cursor: pointer;
    background: rgba(255,255,255,.04); border: 1px solid var(--line); color: var(--text); font: inherit;
  }
  .overview__item:hover { border-color: var(--blue); }
  .overview__n { display: block; font-size: 12px; color: var(--faint); margin-bottom: 4px; }

  /* —— 竖屏提示 —— */
  .rotate { display: none; }
  @media (orientation: portrait) and (max-width: 900px) {
    .rotate {
      display: grid; place-items: center; position: fixed; inset: 0; z-index: 40;
      background: var(--bg); color: var(--muted); font-size: 16px; text-align: center; padding: 32px;
    }
  }

  /* —— 减少动态 —— */
  @media (prefers-reduced-motion: reduce) {
    .slide, .anim, .splitbar i, .ring__progress, .hud__bar,
    .slide::before, .glow::after, .story__dot, .icon path, .icon circle {
      animation: none !important; transition: none !important;
    }
    .slide::before { opacity: .3; }
    .glow::after { opacity: .4; }
    .slide [class]:not(.glow) { filter: none !important; }
    .slide { opacity: 1; transform: none; }
    .slide:not(.is-active) { display: none; }
  }

  /* —— 打印：每页一张 A4 横向 —— */
  @page { size: A4 landscape; margin: 0; }
  @media print {
    html, body { overflow: visible; background: #0a111d; }
    .viewport { position: static; display: block; }
    .stage {
      transform: none !important; width: auto; height: auto;
      background: #0a111d; overflow: visible;
    }
    .stage::after { display: none; }
    /* 1920×1080 设计稿按 0.5854 缩放到 A4 横向（297mm ≈ 1122px），一页一张不裁切 */
    .slide {
      position: relative; inset: auto; display: block;
      opacity: 1 !important; visibility: visible !important; transform: none !important;
      page-break-after: always; break-after: page;
      width: 297mm; height: 210mm; padding: 0; margin: 0;
      background: #0a111d; color: var(--text);
      overflow: hidden;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .slide:last-child { page-break-after: auto; }
    .slide__inner, .slide[data-kind="cover"] .slide__inner {
      zoom: 0.585;
      width: 1920px; height: 1080px;
      padding: 96px 120px 120px;
    }
    .slide[data-kind="cover"] .slide__inner { padding: 0 140px; }
    .anim { opacity: 1 !important; transform: none !important; animation: none !important; }
    .hud, .pager, .navbtn, .overview, .rotate { display: none !important; }
    .notes { display: none !important; }
  }
</style>
</head>
<body>
<div class="rotate">请把设备横过来观看（或使用电脑全屏放映）</div>
<div class="viewport" id="viewport">
  <div class="stage" id="stage">
${slides.map(renderSlide).join('\n')}
  </div>
</div>

<div class="hud"><div class="hud__bar" id="bar"></div></div>
<div class="pager" id="pager"><b>1</b> / ${slides.length}</div>
<button class="navbtn navbtn--prev" id="prev" aria-label="上一页">‹</button>
<button class="navbtn navbtn--next" id="next" aria-label="下一页">›</button>

<div class="overview" id="overview" aria-hidden="true">
  <h2>总览 · 点击跳转</h2>
  <div class="overview__grid">
${slides
  .map((s, i) => `<button class="overview__item" data-goto="${i}"><span class="overview__n">${String(i + 1).padStart(2, '0')}</span>${esc(s.title || s.big || s.eyebrow || '')}</button>`)
  .join('\n')}
  </div>
</div>

<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var stage = document.getElementById('stage');
  var bar = document.getElementById('bar');
  var pager = document.getElementById('pager');
  var overview = document.getElementById('overview');
  var total = slides.length;
  var current = 0;

  /* —— 等比缩放：1920×1080 设计稿适配任意窗口 —— */
  function fit() {
    var pad = 0;
    var scale = Math.min((window.innerWidth - pad) / 1920, (window.innerHeight - pad) / 1080);
    stage.style.setProperty('--scale', String(scale));
  }
  window.addEventListener('resize', fit);
  fit();

  /* —— 数字滚动 —— */
  function countUp(el) {
    var target = Number(el.getAttribute('data-count'));
    if (!isFinite(target)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = String(target);
      return;
    }
    var start = performance.now();
    var dur = 900;
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = String(target);
    }
    el.textContent = '0';
    requestAnimationFrame(step);
  }

  function go(index, opts) {
    var next = Math.max(0, Math.min(total - 1, index));
    slides.forEach(function (s, i) {
      s.classList.toggle('is-active', i === next);
      s.setAttribute('aria-hidden', i === next ? 'false' : 'true');
    });
    current = next;
    bar.style.width = ((next + 1) / total * 100) + '%';
    pager.innerHTML = '<b>' + (next + 1) + '</b> / ' + total;
    if (!opts || opts.hash !== false) {
      history.replaceState(null, '', '#slide-' + (next + 1));
    }
    var active = slides[next];
    active.querySelectorAll('[data-count]').forEach(countUp);
    // 重新触发一次性动画（跳出再进入同一页时也能重播）
    active.querySelectorAll('.anim').forEach(function (el) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    });
  }

  function fromHash() {
    var m = /#slide-(\\d+)/.exec(location.hash || '');
    if (m) return Math.max(0, Math.min(total - 1, Number(m[1]) - 1));
    return 0;
  }

  function toggleOverview(force) {
    var open = typeof force === 'boolean' ? force : !overview.classList.contains('is-open');
    overview.classList.toggle('is-open', open);
    overview.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      var el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key;
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Enter') {
      e.preventDefault(); toggleOverview(false); go(current + 1);
    } else if (key === 'ArrowLeft' || key === 'PageUp' || key === 'Backspace') {
      e.preventDefault(); toggleOverview(false); go(current - 1);
    } else if (key === 'Home') { e.preventDefault(); go(0); }
    else if (key === 'End') { e.preventDefault(); go(total - 1); }
    else if (key === 'f' || key === 'F') { e.preventDefault(); toggleFullscreen(); }
    else if (key === 'n' || key === 'N') { e.preventDefault(); document.body.classList.toggle('notes-on'); }
    else if (key === 'g' || key === 'G') { e.preventDefault(); toggleOverview(); }
    else if (key === 'Escape') { toggleOverview(false); }
  });

  document.getElementById('next').addEventListener('click', function () { go(current + 1); });
  document.getElementById('prev').addEventListener('click', function () { go(current - 1); });

  overview.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-goto]');
    if (!btn) return;
    toggleOverview(false);
    go(Number(btn.getAttribute('data-goto')));
  });

  window.addEventListener('hashchange', function () { go(fromHash(), { hash: false }); });

  // 触屏左右滑
  var touchX = null;
  document.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) go(current + (dx < 0 ? 1 : -1));
    touchX = null;
  }, { passive: true });

  // 空闲自动隐藏提示
  var idleTimer = null;
  function wake() {
    document.body.classList.remove('hide-hud');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('hide-hud'); }, 3200);
  }
  ['mousemove', 'keydown', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, wake, { passive: true });
  });
  wake();

  go(fromHash(), { hash: false });
})();
</script>
</body>
</html>
`;

await writeFile(OUT, html, 'utf8');
process.stdout.write(`已生成 showcase.html（${slides.length} 页，${Math.round(Buffer.byteLength(html, 'utf8') / 1024)} KB）\n`);
