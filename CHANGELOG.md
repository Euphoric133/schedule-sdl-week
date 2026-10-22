# 更新记录（CHANGELOG）

格式约定：每个版本记录**阶段目标、实际改动、实现内容、测试结果、已知问题**。
最新版本在最上方。

---

## [1.23.0] — AI 功能：计划急救与个人时间校准

日期：2026-10-22

### 阶段目标

让 AI **参与产品的决策过程**，而不是做聊天装饰：AI 理解发生了什么、比较方案、说明取舍；
程序负责统计、校验硬性约束；学生确认后才真正改日程。

### 新增：最晚睡觉时间（硬约束，schema v1 → v2）

- 新增 `settings.latestSleepMinutes`（null = 不限制），`CURRENT_SCHEMA_VERSION` 升到 2；
- 迁移只补字段、默认 `null`：凭空给个时刻会改变老用户现有计划（原本能排到 23:30 的任务
  突然排不下），那种体验比"多一个没填的字段"糟糕得多；
- 引擎把它实现为**截断每天窗口的右端**，而不是插一条假的固定活动——
  它是约束、不是占用块，也不该出现在时间轴上被当成睡眠块；
- `simulateEarliestCompletion` 同步传入该约束，避免"风险面板说来得及、计划却排不下"。

### 功能一 · 计划急救（`src/ai/proposals.js`、`services/aiFeatureService.js`）

AI 输出结构化提议，**只允许**两种改动：

| 允许 | 含义 |
|---|---|
| `defer_task` | 减少某任务今天的剩余工作量 |
| `lock_date` | 锁定某天不再排学习 |

**不允许**：改截止时间、删除任务、移动已排时段。截止时间是学生与老师之间的硬约束。

校验是硬边界（不是提示词），以下情况一律拒绝：

- 引用不存在的 `taskId`（否则预览里会凭空多出改动）；
- 推迟量超过任务剩余工作量，或超过 480 分钟上限；
- 锁定过去的日期、超出规划窗口的日期、重复项、条数超限；
- **一条不合法就整体拒绝**，不做"部分采纳"——半懂的方案比明确失败更危险。

流程：提议 → 程序校验 → `requestPreview` 生成候选 → 学生确认。
确认前正式计划零改动（有测试锁定）。

### 功能二 · 个人时间校准（`src/ai/calibration.js`）

**统计全部由程序完成**，AI 只负责解释：

- 实际用时 = 完成任务的实际时长 + 用户手工声明的"已完成"（与 `domain/task.js` 口径一致）；
- 按科目聚合，用「实际总和 ÷ 计划总和」而非比例平均（两者结果不同，前者才是正确口径）；
- 偏差在 ±15% 内视为正常波动，不提示；
- 样本 < 3 条时明确标注"还不足以判断规律"，不硬给建议；
- `getCalibration` / `estimateForNewTask` 不依赖网络，AI 不可用时统计仍然可用。

### UI

- 新增 `#/ai` 页面：AI 的分析用左侧竖线标记，与程序的校验结果**视觉上分开**，
  用户总能分清哪句来自模型、哪个数字来自计算；
- 设置页新增可编辑的「最晚睡觉时间」——这是每天都会用到的现实约束，不该藏在 JSON 编辑器里。

### 途中修掉的真实 bug

`prepareRescuePreview` 把数组直接传给 `validateProposals`（它期望 `{ proposals: [...] }`），
导致所有提议被误判为"没有建议"、**功能静默失效**。测试先失败、后修好。

### 文档修正（重要）

实现 AI 之后，README 与 PROJECT_SPEC 仍写着"不含任何 AI 模型或外部 API"
"任何 AI / LLM 调用明确禁止"——**这些是不成立的陈述**。已改为准确表述：

- 排程引擎仍然完全不使用 AI（纯函数、不读时钟、不访问网络）；
- AI 只做解释与提议，且提议必须经过程序校验与用户确认；
- 如实列出 AI 会外发哪些字段（任务标题、科目、截止时间、剩余时长），以及不会发送什么。

新增三条测试锁定这些表述，防止以后文档再次与实现矛盾。

### 验证

```
node --test "tests/**/*.test.js"   → 762 通过 / 0 失败
```

浏览器实机（headless Chrome）：

- `#/ai` 页面正常渲染，两张卡片与睡觉时间均显示；
- 校准正确识别"数学 实际 140 / 计划 90 → 经常比预计久"，并如实提示样本不足；
- 喂入假 AI 响应后，提议通过校验并出现「生成调整预览」按钮。

### 已知限制

- AI 回复里的提议以 `json` 代码块形式返回再解析；模型若不遵守格式，会被程序判为"无提议"
  并如实提示，而不是猜测意图；
- `focus-garden.html`（独立的 React 打包版）尚未接入 AI 助手；
- 中继函数的限流是进程内计数，真实上限会高于配置值（多实例各自计数）。

---

## [1.22.1] — 版本画廊改为时间线（原始 prompt + 解决了什么）

日期：2026-10-22

### 变更

`versions/index.html` 从"阶段卡片 + 表格"改为**竖向时间线**：

- 26 个时间线节点，覆盖 59 个版本（含画廊自身的提交）；
- 每个节点：标签（地基/重大/修复/体验/工具）+ 标题 + 日期与版本区间 +
  **原始 prompt**（可展开、限高滚动）+ **解决了什么** + 版本号快捷链接；
- 底部保留完整版本表（59 行）。

### 关于 prompt 原文的说明

- 14 段来自用户本轮提供的原文；
- 其中标注"原文为分节规格"的条目保留**全部章节标题与硬性要求**（逐字全文会超出页面可读长度）；
- 第 9 段（开始时间规格）在对话中传递时于 3.3 处中断，页面如实保留已收到部分；
- 其余桥接节点（未在原 prompt 列表中的小步迭代）用要点复述，并注明"原始 prompt 未保留"。

### 验证

```
59/59 产物结构完整（<style>、唯一 </script>、以 </html> 结尾、内联脚本语法可解析）
时间线 26 条 · 表格 59 行 · 链接 59 个，缺失 0、未索引 0
index.html 52 KB
node --test → 687 / 687 通过
```

---

## [1.22.0] — 版本画廊升级：58 个版本 + 原始 prompt + 解决了什么

日期：2026-10-22

### 变更

`versions/` 重新导出，从 37 个补齐到 **58 个**（对应全部提交），索引页改为**阶段视图**：
每个阶段展示

1. **我给你的原始 prompt**（原文；早期两阶段因上下文已压缩，明确标注"未保留，不编造"）；
2. **解决了什么问题**；
3. 对应版本的可点击链接；
4. 完整版本表（58 行，含日期、提交、大小）。

24 个阶段覆盖全部 58 个提交，标签分为 地基 / 扩张 / 重大 / 修复 / 体验 / 工具。

### 验证

```
58/58 构建成功
58/58 产物结构完整（<style>、唯一 </script>、以 </html> 结尾、内联脚本语法可解析）
索引链接 58 个，缺失 0，未覆盖 0
index.html 42 KB
```

### 说明

- 早期「阶段 1–2」的原始 prompt 不在本会话上下文中，页面里如实写"未保留"，没有编造；
- 超长规格类 prompt 为节选（保留标题与硬性要求），语义未改。

---

## [1.21.1] — 收尾：花园面板即时刷新 + 跨午夜记录校验

日期：2026-10-20

### 一、花园面板即时刷新（规格 3.3 的缺口）

之前只有「从花园返回再进入」或「花园计时完成」时才刷新学习任务计时面板，
所以在计划页完成任务 / 应用预览之后，花园里仍显示过期的清单。

现在：

- `applyPreview` 成功后调用 `getShell()?.refreshGardenPanel?.()`；
- `shell` 导出 `refreshGardenPanel()`，内部走 `refreshStudyTimerPanel(getGardenFrame(gardenHost))`；
- 花园未挂载时是空操作，不会抛错。

实测：应用预览后面板刷新次数 `1 → 3`。

### 二、跨午夜记录

补了校验：没有排程时段的计时在 00:20 完成、实际 40 分钟时，
记录归到**前一天**，`endMinutes > 1440`，`endMinutes - startMinutes = 40`，统计按该业务日计入。

### 三、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 687
ℹ pass 687
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1551 KB，内联 76 个模块）
```

`taskCompletion.test.js` 增加 2 个用例（共 8 个）：跨午夜归属、应用预览后刷新花园面板。

### 四、仍未做

- 卡片详情里的「只完成这一段」次级操作（规格说"如果产品需要"，目前没有入口）；
- 计时盘与玻璃材质在真实浏览器里的视觉核对（自动化无法验证）。

---

## [1.21.0] — 统一「完成任务」链路：记录时段 / 标记完成 / 清理依赖

日期：2026-10-20

### 一、三个问题的真实根因

1. **计划页点「完成」只完成了时段**：`completeSession()` 只提交
   `session.complete`，任务状态仍是 `not_started`/`in_progress`。
   于是它继续出现在「前置任务」候选里，花园清单也继续显示
   （剩余 0 被 `Math.max(1, remaining)` 兜成"未排时间 · 1 分钟"）。
2. **花园计时完成不写学习记录**：`completeStudyTask()` 只调用
   `changeTaskStatus(..., 'completed')`，`actualMinutes` 被 `void` 丢弃。
   统计只统计 `state === 'completed'` 的时段，所以花园计时不进统计。
3. **0 剩余的历史脏数据**：状态还是 active，但剩余工作量为 0，
   候选与清单都只用状态过滤，没有看剩余量。

### 二、统一链路

新增 `planService.completeTaskAtomic({ taskId, sessionId, actualMinutes, completedAt })`：

1. 先完成时段（有可用时段就复用；没有就 `session.add` 补一条合法的 completed 记录）；
2. 再 `task.status → completed`（`reconcile` 取消剩余未完成时段，并清理其它任务的 `dependsOn`）；
3. `applyDraftOps` + 一次 `app.commit`，**原子**；任一步失败整体不生效；
4. 已完成的任务直接返回 `{ ok: true, already: true }`（幂等）。

`buildCompletionOps()` 负责组装变更序列，并把实际分钟数钳制在
`[1, min(剩余, SESSION_MAX_MINUTES)]`，跨午夜时用前一天 + `endMinutes > 1440` 表示。

### 三、两条调用路径

| 入口 | 方式 |
|---|---|
| 计划页卡片「完成」 | `previewWith([session.complete, task.status])` —— 仍走预览/确认，顺序是先时段后任务 |
| 花园计时完成/提前完成 | `completeTaskAtomic()` 原子提交（不需二次确认），随后刷新面板与页面 |

`gardenPanel` 现在把 `sessionId`、`actualMinutes`、`completedAt` 一并传给主应用。

### 四、过滤 0 剩余

- `listStudyTasks()`：只列出状态有效**且剩余 > 0** 的任务，返回 `sessionId`（最早可完成时段）；
- `listDependencyCandidates()`：支持传入 `listTaskViews()` 的视图，同时按状态与 `remainingMinutes > 0` 过滤；
- 任务表单改用视图过滤。

### 五、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 685
ℹ pass 685
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1550 KB，内联 76 个模块）
```

新增 `tests/integration/taskCompletion.test.js`（6 个）：一次提交四件事、无排程任务补记录、
幂等、统计可见、花园清单过滤 + `sessionId`、前置候选排除已完成/0 剩余。

端到端实测：

```
计划页完成 → 任务 completed，完成记录 35 分
花园完成   → 任务 completed，完成记录 18 分，当日统计 actual=18，番茄 +1，转盘发放 1 次
重复完成   → 完成记录仍 1 条，番茄仍 1，不再发机会
```

### 六、已知限制

- 跨午夜只在"没有排程时段"时按前一天 + `endMinutes > 1440` 记录；有排程时沿用原时段日期；
- 计划页「完成」的确认文案已改为"完成任务「X」并记录本次学习"，但**没有**单独的"只完成这一段"入口
  （需要的话我可以加到卡片详情里）。

---

## [1.20.0] — 文字安全层：修掉溢出的真正根因

日期：2026-10-20

### 一、先说清楚：本轮的验证边界

我**没有真实浏览器**，跑不了规格里那几段 DevTools 测量脚本。
所以这一轮做的是：**静态排查根因 → 按根因修 → 加静态断言**；
320/375/768/1024/1440 与 200% 缩放的实际测量需要你在浏览器里确认。

### 二、实际定位到的根因（静态排查）

| 位置 | 选择器 | 根因 |
|---|---|---|
| 页面标题区 | `.page-head` / `.page-head__actions` | flex 子项默认 `min-width: auto` 不收缩；右侧按钮 `flex: none` 把标题挤出去 |
| 卡片头 | `.card__head` | 同上，且没有 `flex-wrap`，标题+按钮互挤 |
| 任务行 | `.task-item__head > div:first-child` | 左侧文字块没有 `min-width: 0`，长标题把操作按钮挤走 |
| 顶栏 | `.app-topbar__meta` / `__actions` | 日期+计划文案过长时不收缩，把右侧按钮顶出视口 |
| 按钮 | `.btn` | `white-space: nowrap` + 无 `max-width` → 长文案溢出 |
| 按钮组 | `.form-actions` / `.task-item__actions` | 没有 `flex-wrap`，窄屏多按钮溢出 |
| 输入框 | `input` / `select` / `textarea` | 没有 `min-width: 0`；原生日期/时间控件有固有宽度，会撑破 grid 列 |
| 统计磁贴 | `.metric` | `min-width: 96px` 固定，长数字/长标签撑破 |
| 看板卡片 | `.day-card__title` | 原有 `white-space: nowrap` 让标题单行硬顶，配两行截断时更会顶出卡片 |
| 看板标签 | `.day-tag` / `.pill` / `.chart__label` | `nowrap` 且无 `max-width`/`text-overflow` |
| 弹窗 | `dialog` | 没有 `max-height`/`overflow`，长内容超出视口 |
| Toast | `#toast-host .notice` | 长消息不换行，撑破固定宽度 |

### 三、修复方式（按根因，不做全局掩盖）

1. **收缩**：给 `.page-head` / `.card__head` / `.notice` / `.task-item__head` / `.app-topbar__meta` 的子项补 `min-width: 0`；
2. **换行**：这些容器补 `flex-wrap: wrap`；`.form-actions` 同样；
3. **单行省略**：导航项、卡片标题、任务标题、时间、看板时间 + 按钮，统一 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0`；
4. **多行断词**：提示语、错误、通知、弹窗段落统一 `overflow-wrap: anywhere; word-break: break-word`；
5. **看板标题**：改为两行 `-webkit-line-clamp: 2`，并**显式把继承来的 `nowrap` 改回 `normal`**（否则截断不生效）；
6. **按钮**：`max-width: 100%`；操作区按钮允许 `white-space: normal`；
7. **输入框**：`min-width: 0; max-width: 100%`，日期/时间控件单独声明；
8. **弹窗**：`max-width: min(720px, 100vw - 32px)`、`max-height: calc(100vh - 48px)`、`overflow: auto`；
9. **窄屏（≤720px）**：标题区/卡片头/任务行改为竖排，操作区左对齐、按钮均分。

**刻意没有做**：不给 `body` / `.app` / `.app-main` 加 `overflow: hidden`（会裁掉焦点环与阴影）；不把正文改成省略号。

### 四、可回溯

被省略的文字补 `title`：任务标题、卡片标题（卡片头同时把标题块设为 `min-width: 0`）。
图标按钮本来就有 `aria-label`，未改动。

### 五、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 679
ℹ pass 679
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1542 KB，内联 76 个模块）
```

新增 `tests/integration/textSafety.test.js`（9 个）：收缩声明、单行省略 + title、
多行断词且正文不是 nowrap、看板两行截断并覆盖 nowrap、按钮换行、输入框可收缩、
弹窗不超视口、禁止全局 overflow hidden、表格仍可横向滚动。

### 六、已知限制

- 原生 `<input type="date">`/`<time>` 在 Safari 上仍有较大的固有宽度，只能靠 `min-width: 0` 缓解；
- 极窄（320px）下多个操作按钮仍会换行成两排，这是预期行为（优先不溢出）；
- 玻璃伪元素 `::before` 已确认 `pointer-events: none`，文字在其上层，不会被盖住。

---

## [1.19.0] — 液态玻璃材质：分层玻璃、氛围色场、边缘光与降级

日期：2026-10-20

### 一、设计方向：靠"分层"而不是"到处模糊"做质感

材质分三层，每层职责不同：

| 层级 | 表面 | 做法 | 为什么 |
|---|---|---|---|
| Tier 1 | 品牌区 / 顶栏 / 侧边栏 | 真 `backdrop-filter: blur(20px) saturate(165%)` | 固定的窄条，背后是氛围色，模糊后才像玻璃，且不压正文 |
| Tier 2 | `.card` / `.day-card` / `.task-item` / `.metric` | 高不透明度 tint + 边缘光，**不模糊** | 正文在这里，模糊会搅浑字（本项目曾经"整页发蒙"的根因） |
| Tier 3 | `dialog` / Toast | `blur(26px)` + 大阴影 | 明显悬浮，与内容拉开层次 |

### 二、玻璃的四个层次（每一层都写进样式）

1. 半透明底色（`--glass-bg` / `--glass-bg-card` / `--glass-bg-strong`）；
2. 模糊 + 饱和（同时写 `-webkit-` 前缀）；
3. 边缘光：1px 外描边 + `inset 0 1px 0` 顶部高光 + `inset 0 -1px 0` 底部暗边；
4. 外层柔和投影（`--glass-shadow` / `-hover` / `-float`）。

### 三、氛围色场

新增 `.ambient-field`：三个大尺寸径向光斑（冷蓝 / 青绿 / 暖金），`z-index: -2`、
`pointer-events: none`、`aria-hidden`，36 秒缓慢漂移。
壁纸开启时**自动隐藏**（让壁纸自己当氛围，避免把照片弄脏）。

### 四、交互

- 卡片 hover 上浮 1px + 阴影增强；按压 `scale(0.997)`；
- 导航 active 改为"液态高光胶囊"（顶部渐变高光 + accent-soft 底 + 细边框）；
- 鼠标镜面高光：一个委托 `pointermove` + `requestAnimationFrame` 节流，
  只更新 `[data-glass]` 上的 `--glass-x/--glass-y`；触摸设备与减少动态效果时**不启用**。

### 五、降级

| 场景 | 处理 |
|---|---|
| 不支持 `backdrop-filter` | `@supports not (...)` 回退到实色表面 |
| `prefers-reduced-transparency` | 关闭透明与模糊，氛围层隐藏 |
| `prefers-reduced-motion` | 关闭漂移、上浮、镜面高光 |
| `forced-colors` | 使用系统色，去玻璃与渐变 |
| 打印 | 白底、无阴影、无光斑 |
| ≤720px | 模糊降到 12–14px，外壳改用更实的 tint |

### 六、顺带修复一个**既有严重问题**

`components.css` 里有一段注释的 `/*` 丢失、并多出一个 `}`：

```
.day-tag--cancelled { ... }

}                 ← 多余的右括号

* ================  ← 缺少 /*
   布局与组件样式
```

这会让浏览器把后面的 `.app { display: grid; ... }` 当成无效选择器**整条丢弃**，
应用外壳的网格布局在真实浏览器里是坏的（测试不解析 CSS，所以一直没被发现）。

已修复为正常的注释块，并新增断言：三份样式表的注释必须成对、大括号必须平衡、
不允许出现"没有 `/*` 的注释残片"。

### 七、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 670
ℹ pass 670
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1537 KB，内联 76 个模块）
```

新增 `tests/integration/glassTheme.test.js`（13 个）：令牌完整性、整页容器禁模糊、
卡片禁模糊、外壳/浮层确实使用模糊、四层材质齐备、壁纸下更实且隐藏氛围层、
氛围层层级与无障碍、五种降级、移动端降档、无远程资源、样式语法完整性、`data-glass` 结构。

### 八、旧断言调整

| 测试 | 旧断言 | 新断言 | 原因 |
|---|---|---|---|
| `round2` 背景约束 | 全局禁止 `backdrop-filter` | 只禁止 `body` / `.app` / `.app-main` 与 `.card` | 规则变更：玻璃现在**允许**用于外壳与浮层，但整页容器与正文卡片仍然禁止 |

### 九、已知限制

- `backdrop-filter` 在低端设备/部分浏览器上开销较高；已限制同时模糊的表面数量（仅外壳 3 块 + 浮层）；
- 壁纸下玻璃更实（+8%~10%），会略微削弱"透"的感觉，这是可读性的取舍；
- 遮罩层模糊 6px，低端机可感知，但已远低于"整页模糊"的代价。

---

## [1.18.3] — 转盘指针改为阻尼式抖动（幅度随减速衰减）

日期：2026-10-20

### 变更

指针恢复抖动，但不再是"恒定幅度、恒定频率"的高速抖动，而是**阻尼式**：

- 动画改为 `pointer-tick-decay 4.2s linear 1 both`（与转盘旋转同长，一次即止）；
- 关键帧由脚本按物理直觉生成（41 帧）：
  - **幅度**：7° → 约 0.6°，按 `(1−k)²` 衰减；
  - **周期**：0.14s → 约 1.09s，随减速拉长；
  - 最后一帧几乎归零，停稳时不跳变。

实测衰减：前段最大 **6.67°** → 后段最大 **0.71°**（约 11%），末尾角度 `0.2 / -0.16`。

### 没有改动

- 指针仍然**朝下**；
- 旋转圈数、4.2 秒缓出、结果卡片延迟、抽奖概率与奖励权重不变；
- `targetAngle` 随机落点与持久化不变。

### 测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 657
ℹ pass 657
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1519 KB，内联 76 个模块）

$ node scripts/patch-garden-wheel.mjs --check
专注花园转盘：补丁已应用
```

新增断言：关键帧 ≥20 帧、起始幅度 >4°、结束幅度 <起始的 25%、最后一帧 <1°。

---

## [1.18.2] — 转盘指针去掉抽动，保持定住

日期：2026-10-20

### 变更

抽奖旋转期间，指针原本会叠加 `wheel-pointer--spinning` 的 `pointer-tick` 抖动动画
（每 0.14 秒左右摆 ±7°）。现在**去掉抖动**：

- `className:M?"wheel-pointer wheel-pointer--spinning":"wheel-pointer"` → `className:"wheel-pointer"`；
- 删除无用的 `@keyframes pointer-tick`，把 `.wheel-pointer--spinning` 置为 `animation:none`。

指针现在只是**跟着转盘一起转、然后停住**，不再自己抖动。

### 没有改动

- 指针方向仍然是**朝下**；
- 旋转圈数、4.2 秒缓出、结果卡片延迟显示、抽奖概率与奖励权重全部不变；
- 抽奖算法与 `targetAngle` 持久化不变。

### 测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 656
ℹ pass 656
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1517 KB，内联 76 个模块）

$ node scripts/patch-garden-wheel.mjs --check
专注花园转盘：补丁已应用
```

断言更新：不再要求保留抖动类，改为断言 `className:"wheel-pointer"`、无 `wheel-pointer--spinning`、无 `pointer-tick`。

---

## [1.18.1] — 修复「新建任务」点不开（漏导入 listDependencyCandidates）

日期：2026-10-20

### 现象

点击「新建任务」没有任何反应，无法创建任务。

### 根因

1.17.0 把「前置任务」候选改成调用 `listDependencyCandidates()`，
但 `src/ui/forms/taskForm.js` **只用了它、没有 import 它**。

只要已经存在至少一个任务，渲染候选时就会抛
`ReferenceError: listDependencyCandidates is not defined`，
表单构建中断 → 弹窗根本没被插进 DOM，看起来就是"点了没反应"。

（当时的自动化测试没发现，是因为测试夹具里没有其它任务，过滤函数一次都没被调用。）

### 修复

- `src/ui/forms/taskForm.js`：补上 `listDependencyCandidates` 的导入；
- 追加回归测试：**先创建一个任务和一个已完成任务**，再点「新建任务」，
  断言弹窗真的出现、含「前置任务」、且候选里没有已完成任务。

### 顺带修掉一处同类隐患

静态扫描（本仓库导出符号 vs 各文件导入）发现 `src/ui/components.js` 的 `diagList`
调用了 `issueMessage()` 但没导入 —— 任何展示诊断列表的地方都会崩。已补上导入。

### 测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 656
ℹ pass 656
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1517 KB，内联 76 个模块）
```

---

## [1.18.0] — 转盘规则改数字输入；学习任务计时加入背景音与完成提示音

日期：2026-10-20

### 一、抽奖规则改为可输入数字（1–100）

两个入口（成就与奖励页、设置页）的固定选项 `<select>` 都换成了花园自带的数字输入组件 `In`
（支持 `min/max/onCommit` 与错误提示），因此可以直接输入 1–100 的任意整数：

- 非法值（0、101、非数字）由组件拦下并提示，不会写入 `spins.ruleEvery`；
- 两个入口共用同一份 `spins.ruleEvery`；
- 默认值、已获得机会、历史进度都没变（`spin/rule` 分支逻辑未改）。

补丁：`spin-rule-number-input-achievements`、`spin-rule-number-input-settings`；
同时移除了被取代的两条"选项表加 1"补丁（否则 `--check` 会误报未应用）。

### 二、背景音与完成提示音（独立 Web Audio 引擎）

新增 `src/services/audioEngine.js`，**不碰**花园的 `ambientTrack` / `ambientVolume`：

| 能力 | 实现 |
|---|---|
| 音轨 | 关闭 / 雨声 / 溪流 / 风声 / 低频噪声（噪声 + 滤波合成，无音频文件） |
| 切换 | 先淡出旧节点再启动新节点（250ms），不会叠加 |
| 音量 | 只改 master gain，不重建音频图；滑杆实时生效 |
| 暂停/继续 | 暂停淡出、继续淡入 |
| 完成提示音 | 花园钟声 / 清脆铃音 / 柔和提示 / 电子提示（振荡器 + 包络），可开关、可试听 |
| 降级 | `AudioContext` 不可用或被挂起时返回 `{ok:false, reason:'audio-unavailable'}`，计时照常 |

面板里加了「背景音」一排按钮 + 音量滑杆 + 提示音开关/音色/试听；偏好持久化在
`studyPlanner:v1:studyTimerPrefs`，不写入花园设置。

### 三、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 655
ℹ pass 655
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1517 KB，内联 76 个模块）

$ node scripts/patch-garden-wheel.mjs --check
专注花园转盘：补丁已应用
```

新增 `tests/integration/audioEngine.test.js`（8 个）：无 AudioContext 降级、只创建一个上下文、
切轨停止旧节点、音量不重建、关闭回到 off、四种提示音、暂停淡出/继续淡入、提示音降级。

### 四、已知限制

- 背景音首次播放必须由用户点击触发（浏览器自动播放策略）；刷新后不会自动开声；
- 花园原生番茄钟若也在播背景音，两个引擎会**同时出声**（互不知晓，这是设计取舍：不共享状态）；
- 音频合成参数是"可辨识的近似音色"，与花园原生音色不完全一致。

---

## [1.17.0] — 已完成任务保留在时间表；前置任务候选与依赖清理

日期：2026-10-20

### 一、已完成任务为什么之前会"消失"

两个原因叠加：

1. `shouldShowStudyCard()` 对 `status === COMPLETED` 直接返回 `false` —— 卡片被过滤掉；
2. `deriveStatus()` 先看 `session.state`，而完成任务时 `reconcileTaskSessions()` 会把未完成时段取消，
   所以即使显示，状态也会变成"已取消"。

### 二、现在的规则

- **任务状态优先于时段状态**：`deriveStatus({ taskStatus, ... })` 最前面判断
  `COMPLETED → 'completed'`、`CANCELLED/DELETED → 'cancelled'`；
- **已完成任务继续显示**，`shouldShowStudyCard()` 不再过滤它；
- **同一任务只显示一张"已完成"卡片**：新增纯函数
  `selectCompletedDisplayBlockIds({ plan, state })`，按（日期、开始时间）取最早的一块，
  日视图 / 周视图 / 首页共用同一份选择结果（避免一个 2 小时任务被拆成多段后显示成 8 小时）；
- 已取消 / 已删除任务仍然不显示（不回归）；
- 视觉：`day-card--completed`（左侧完成色、降低对比度、标题删除线、hover 恢复），
  紧凑卡片（≤30 分钟）也会显示"已完成"标记；已完成卡片不再有「完成」按钮，保留「详情」「删除任务」。

### 三、前置任务：清除已完成/已取消/已删除

- 新增 `listDependencyCandidates(tasks, currentTaskId)`：只返回 `not_started` / `in_progress`，并排除自己；
- 任务表单改用该函数，候选里不再出现历史任务；
- `taskStatusOp()` 在**同一事务**里把该任务从其它任务的 `dependsOn` 中移除
  （只有 `to === COMPLETED` 时清理；取消/删除不清理），随后照常 `reconcileTaskSessions()`；
  整体校验失败则整体不生效。

### 四、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 647
ℹ pass 647
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1502 KB，内联 75 个模块）
```

新增 `tests/integration/completedTask.test.js`（7 个）：状态优先级、卡片显隐、只保留最早一块、
完成任务后卡片仍在、依赖候选过滤、完成清理依赖（同一事务）、取消不误删依赖。
看板实测：7 张卡片中 1 张标为已完成并含"已完成"文案。

### 五、旧断言调整（逐条说明）

| 测试 | 旧断言 | 新断言 | 原因 |
|---|---|---|---|
| `round2` 「任务完成后从七天计划消失」 | 完成后卡片数 = 0 | 卡片仍存在且 `status === 'completed'` | 规则变更：本轮要求保留并显示"已完成" |

---

## [1.16.0] — 计时盘从 0% 起、页面只占内容区、随机指针、完成发机会

日期：2026-10-20

### 一、计时盘起点：真实根因与修复

**根因**：为了让空闲状态"看起来不空"，之前用 `MIN_PROGRESS = 0.035` 画了一小段进度弧，
再加上根 `<svg>` 上的 CSS `rotate(-90deg)`（`transform-origin` 未显式指定），
两个因素叠加，视觉上就像"从 10% 左右开始"。

**修复**（不做固定角度补偿）：

1. `MIN_PROGRESS` 归零，`drawableProgress(0) === 0`，0% 时**不画进度弧**；
2. 旋转从根 `<svg>` 移到内部 `<g transform="rotate(-90 150 150)">`，圆心显式写进变换里；
3. 12 点钟方向单独放一个 `r=2.5` 的**起点圆点**，且**不放进旋转的 `<g>`**，否则会被转到右边；
4. 进度圆保持 `strokeDasharray = 2π×144`、`strokeDashoffset = C×(1−progress)`。

新增断言：`drawableProgress(0) === 0`、`ringDashOffset(0) === C`、25/50/75/100% 严格线性、
DOM 中必须有 `rotate(-90 150 150)` 的 `<g>`、根 svg 不再被 CSS 旋转、起点圆点在 (150,6)。

### 二、计时页布局：保留侧边栏

`.st-host` 从 `position: fixed; inset: 0` 改为 `top/right/bottom: 0; left: var(--nav-width, 232px)`，
窄屏（≤720px）才铺满；内部 `.st-inner` 限宽 1180px、居中、使用花园的间距 token。

- 打开时给侧边栏入口加 `aria-current="page"`，并清掉花园其它导航项的高亮；
- 点击花园其它导航项、`hashchange`、或「返回花园」都会关闭计时页；
- 样式全部改用 `var(--surface)`、`var(--border)`、`var(--text-muted)`、`var(--accent-soft)` 等 token，
  去掉 `#fff`、`#f7f5f0`、`#4a7c59` 这类硬编码；
- 时间字号提升到 `clamp(38px, 5.4vw, 52px)`、`tabular-nums`、字距略收紧。

### 三、转盘指针：扇区内随机落点

新增 `q1r(n, k, random)`：在中奖扇区的 5%–95% 之间取随机位置，
抽奖时用**同一个随机源** `d` 生成 `targetAngle` 并持久化（刷新后按该角度恢复，不重新随机）。

- 指针方向仍是**朝下**；
- 旋转圈数、4.2 秒缓出、tick 动画、结果卡片延迟都不变；
- 断言：落点永远在 `[start, end)` 内；随机 0 / 0.5 / 0.999 得到不同角度；不再出现 `targetAngle:q1(...)`。

### 四、完成学习任务 → 发放 1 次转盘机会

- 新增补丁 `spin/grant`：只 `grantedCount + 1`，**不碰** `progressCount` / `usedCount` / `pendingSpin`；
- 新增 `grantStudyTaskSpin({ bridge, plannerId })`：用 `studyPlanner:v1:studyTaskSpinGrants`
  记录已发放的任务 id，**同一任务只发一次**；桥不可用时返回 `{ok:false, reason:'no-bridge'}` 且不写记录；
- `completeStudyTask({ ..., grantSpin: true })` 在成功完成时调用它；`already-done` 不会再发。

### 五、测试与构建

```
$ node --test "tests/**/*.test.js"
ℹ tests 640
ℹ pass 640
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1497 KB，内联 75 个模块）

$ node scripts/patch-garden-wheel.mjs --check
专注花园转盘：补丁已应用
```

### 六、还没做

- **转盘规则改成数字输入**（当前仍是固定选项 `[1,2,3,4,5,10]`）；
- **背景音与完成提示音**（花园的是打包内部实现，需要另做一套 Web Audio 引擎）；
- 浏览器视觉核对（深色主题、窄屏、与原生番茄钟并排对比）。

---

## [1.15.0] — 学习任务计时：番茄钟同款圆形计时盘 + 双模式

日期：2026-10-20

### 一、圆形计时盘（对齐花园番茄钟几何）

| 参数 | 值 |
|---|---|
| SVG | `viewBox="0 0 300 300"`，整体 `rotate(-90deg)`（12 点方向起始） |
| 圆环 | `r = 144`、`strokeWidth = 12`、`fill = none` |
| 周长 | `2π × 144 ≈ 904.7787` |
| 进度 | `strokeDasharray = C`、`strokeDashoffset = C × (1 − progress)` |
| 最小弧 | 空闲时按 3.5% 绘制，避免"看起来没渲染" |
| 过渡 | `stroke-dashoffset 220ms linear`，`prefers-reduced-motion` 下关闭 |
| 中心 | 阶段标签、大号等宽时间、状态提示、任务名 chip |
| 下方 | `已完成 25% · 30 / 120 分钟`（正计时超时显示"已超过计划 N 分钟"） |

**圆环表示"已完成进度"，不是"剩余时间倒计时"**：倒计时模式下数字减少，但圆环逐渐填满。

### 二、两种模式

- **倒计时**（默认）：`targetAt = now + 计划秒数 × 1000`，显示 `计划 − 已过`；
- **正计时**：`targetAt = null`，显示 `已过`，超过计划后圆环满格、时间继续走、**不自动完成**；
- **模式切换**保留已专注时间：
  - 倒计时 → 正计时：清空 `targetAt`；
  - 正计时 → 倒计时：`targetAt = now + max(0, 计划 − 已过) × 1000`；已超计划则立即进入"待确认"，不出现负数。

### 三、暂停 / 继续（与番茄钟一致）

暂停记录 `pauseStartedAt`，显示与进度冻结；继续时把暂停时长累加进 `pausedAccumMs`，倒计时同时把 `targetAt` 后移同样毫秒数——剩余时间不跳变，暂停时长不计入专注时长。

### 四、按钮随状态变化

| 状态 | 按钮 |
|---|---|
| 空闲 | `开始专注` |
| 运行中 | `暂停`、`提前结束`（倒计时）/ `完成专注`（正计时）、`放弃本次` |
| 暂停中 | `继续`、同上结束按钮、`放弃本次` |
| 已到时间 | `确认完成`（不再二次确认） |

### 五、测试

新增 `tests/integration/studyTimerRing.test.js`（13 个）：圆环几何、最小弧、倒计时/正计时显示、超时不出负数、
暂停冻结与 `targetAt` 后移、三种模式切换、三种恢复场景；
`studyTimerPanel.test.js` 增加 DOM 断言（300×300、两个 r=144/线宽 12 的圆、`-90deg`、`role=timer`、两个模式按钮）。

```
$ node --test "tests/**/*.test.js"
ℹ tests 633
ℹ pass 633
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1492 KB，内联 75 个模块）
```

### 六、还没做（下一步）

- **背景音**（雨声/溪流/风声/低频噪声）、**完成提示音**：花园里是它自己的打包实现，无法直接搬；
  我会用 Web Audio 合成一套独立引擎（不碰花园的 `ambientTrack`），这是下一轮的事。
- 计时盘在真实浏览器里的视觉核对（灯箱宽度、深色主题、窄屏）。

---

## [1.14.0] — 转盘指针改为朝下 + 抽奖规则支持「每 1 个番茄」

日期：2026-10-20

### 一、指针方向

`focus-garden.html` 里 `wheel-pointer` 的 path 由「顶点在上」改为「底边在上、顶点朝下」：

```text
改前：M ${we} ${we-zt-12} L ${we-9} ${we-zt+10} L ${we+9} ${we-zt+10} Z
改后：M ${we-9} ${we-zt-12} L ${we+9} ${we-zt-12} L ${we} ${we-zt+10} Z
```

`className`、`fill="var(--warm)"`、`stroke`、`strokeWidth` 与 `wheel-pointer--spinning` 的 tick 动画**均未改动**。

### 二、抽奖规则增加「每 1 个番茄」

两个入口的选项表都由 `[2,3,4,5,10]` 扩展为 `[1,2,3,4,5,10]`：

- 成就与奖励页（`map(K=>…`）
- 设置 → 成就与奖励 → 抽奖规则（`map(C=>…`）

数据层本来就允许 1（`Ge(i.ruleEvery,1,100,…)`），因此不需要改算法。默认值未改变。

### 三、补丁机制

两条新补丁都追加在 `scripts/patch-garden-wheel.mjs` 的 `PATCHES` 末尾，
沿用「短标记 + 单处匹配 + 幂等」的机制；现在共 **6 处**补丁，`--check` 退出码 0。

### 四、测试

新增 2 条静态断言（`tests/integration/gardenWheel.test.js`）：

- 指针 path 已改为朝下，旧 path 不再出现，tick 动画与颜色保留；
- 两个入口都包含 `1`，旧选项表 `[2,3,4,5,10]` 出现 0 次，数据层下限仍为 1。

```
$ node --test "tests/**/*.test.js"
ℹ tests 619
ℹ pass 619
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1477 KB，内联 75 个模块）
```

---

## [1.13.0] — 计时器搬进花园侧边栏 + 持久化 / 到点自动开始 / 提前结束确认

日期：2026-10-20

### 形态变化：从右下角浮层 → 侧边栏分区

在花园侧边栏（`ul.nav-list`，与「专注」「任务」并列）追加了一个入口 **「学习任务计时」**，
点开是**整页**计时界面（左侧任务清单 + 右侧大计时器），不再是右下角的小浮层。

仍然**零改动**花园的 React 树与路由：只在它的导航列表里追加一个按钮，再叠一层自己的页面
（`position: fixed`，`z-index: 9000`）。入口右侧会实时显示剩余时间（如 `1:23:45`）。

### 新增能力

| 需求 | 实现 |
|---|---|
| 计时持久化 | `studyPlanner:v1:studyTimer`，存**绝对结束时刻** `targetAt`；刷新/重进花园按真实时间恢复，不归零 |
| 到点待确认 | 时间走完进入 `expired`，显示「已到时间，请确认完成」，**不自动**改任何数据 |
| 到点自动开始 | 页面前台每 15 秒检查；有任务开始时间 == 当前分钟且无进行中计时 → 自动开始；同一任务同一分钟只触发一次 |
| 提前结束二次确认 | 第一次点变成「再点一次确认结束」（4 秒内有效），确认后才结算 |
| 放弃本次 | 清空计时，不改任何数据 |
| 暂停/继续 | 暂停期间不消耗时间，恢复时把暂停时长补回 `targetAt` |

### 新增文件

- `src/services/studyTimer.js`：计时状态机（纯函数 + 持久化），可注入 `now`，测试不等待
- `tests/integration/studyTimerState.test.js`：6 个测试（B-11/B-12/B-13 + 暂停/已用时长 + 损坏数据）

### 测试结果

```
$ node --test "tests/**/*.test.js"
ℹ tests 617
ℹ pass 617
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1477 KB，内联 75 个模块）
```

### 旧断言调整（逐条说明）

| 测试 | 旧断言 | 新断言 | 原因 |
|---|---|---|---|
| `studyTimerPanel` 到点判定 | `startMinutes: null` → `upcoming` | → `unscheduled` | 没有排程的任务不属于任何时段，`upcoming` 会误导用户"马上要开始" |
| `studyTimerPanel` 时长 | 取第一个片段长度（60/30） | 任务剩余工作量（90/25） | 规格 B 明确要求，旧断言基于已废弃口径 |

### 仍需浏览器确认

- 侧边栏入口在真实花园里的位置与样式（是否被花园的 CSS 影响）；
- 到点自动开始的实际触发（需要把任务开始时间设到当前分钟附近）；
- 刷新后恢复与"已到时间待确认"的交互。

---

## [1.12.0] — 任务开始时间严格生效 + 计时口径改为"任务剩余工作量"

日期：2026-10-20

### 需求 A：开始时间严格生效

**根因**：未手动设置规划起点时，`resolveSearchStart` 无条件取"下一个整点"（22:05 → 23:00），
任何早于整点的任务开始时间都会被整点顶掉。

**修复**：

1. 默认整点**让位于**任务指定的更早开始时间（只对今天、且不早于现在）；
2. 新增诊断 `planned_start_delayed`：告诉用户"计划 22:23，实际 23:00，原因是什么"；
3. 未安排原因更准确：不可拆分任务按**任务开始时间之后**的最长空档判定，
   放不下时报 `non_splittable_no_slot`（而不是笼统的"截止时间太近"）；
4. `ENGINE_VERSION` → `engine@1.1.0`。

覆盖 12 条用例（`tests/integration/startTimeAcceptance.test.js`）：
A-01 精确 22:23、A-02 默认整点不变、A-03 高优先级先占、A-04 固定日程顺延+诊断、
A-05 不可拆分放不下如实报告、A-06 过去时间、A-07 优化不回填、A-08 短任务、
A-09 手动起点优先、A-10 双任务各自生效、A-11 可拆分总时长、A-12 确定性。

### 需求 B：计时口径与完成回写

| 项目 | 改动 |
|---|---|
| 计时时长 | **任务剩余工作量** = `plannedMinutes − priorCompletedMinutes − 已完成时段分钟`（未完成的片段不扣） |
| 排序 | 有开始时间的按时间升序，无的排最后；同时间按重要度降序，再按标题、id |
| 完成回写 | 新增 `completeStudyTask()`：主应用标记完成 + 花园任务 `done` + 番茄 +1，**幂等** |
| 桥不可用 | 返回 `{ ok: false, reason: 'no-bridge' }`，但主应用仍然完成，不丢用户操作 |

覆盖 14 条用例（`tests/integration/studyTimerAcceptance.test.js`）：B-01~B-08、B-15~B-19、B-21。

### 修复过程中发现并回滚的两次问题（如实记录）

1. 为满足"22:23 + 70 分钟"做过"允许越界"的实验，优化器会把时段重新压缩并产生**重复时段**，
   已整体回滚（该场景按规格 A-05 如实报告未安排）。
2. 新增测试辅助时**误覆盖**了已有的 `tests/helpers/engine.js`，导致 8 个引擎测试报
   `does not provide an export named 'overlaps'`。已从 git 恢复原文件，并以**追加**方式加入新夹具。

### 测试结果

```
$ node --test "tests/**/*.test.js"
ℹ tests 610
ℹ pass 610
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1466 KB，内联 74 个模块）

$ node scripts/patch-garden-wheel.mjs --check
专注花园转盘：补丁已应用（退出码 0）
```

### 未完成（明确说明）

- **计时器状态持久化**（规格 B-11/B-12/B-13）：刷新后恢复、超时后进入"待确认"状态尚未实现；
  当前刷新会丢失进行中的计时。
- **到点自动开始**：尚未实现（需页面前台常驻检查）。
- **提前结束的二次确认**：面板上尚无确认弹窗。

---

## [1.11.0] — 花园内新增「学习任务计时」分区（独立计时器 + 提前结束）

日期：2026-10-20

### 是什么

在**花园里**多了一块独立区域（右下角按钮「⏱ 学习任务计时」）：

- 列出全部学习任务，并显示每项的**计划开始时间**与**时长**；
- 点某一项的「专注」→ 进入**这个大计时器**，时长 = 该任务的计划时长（70 分钟任务就是 70 分钟）；
- 有「**提前结束**」：提前结束也算完成一个番茄；
- 结束时 → 主应用对应任务**自动标记完成**；
- 另有一个「放弃本次」，不计入完成。

### 为什么是浮层而不是花园的一个导航页

花园的界面由它自己的 React 树 + 路由管理。做成导航页必须改它的组件与路由（属于改它的功能）。
现在这块面板是**同一文档里的独立浮层**（`#root` 之外），对花园零侵入：

| 项目 | 做法 |
|---|---|
| 注入位置 | 花园 iframe 的 `document.body`，`position: fixed` |
| 数据 | 通过同源 `window.parent.__plannerGardenApi` 向主应用索取 |
| 完成回写 | 调用主应用 `taskService.changeTaskStatus(id, 'completed')` |
| 花园数据 | 不改；番茄计数仍由花园自己的机制维护 |

### 新增/修改

| 文件 | 变更 |
|---|---|
| `src/ui/gardenPanel.js` | **新增**：面板注入、任务清单、倒计时、提前结束/放弃 |
| `src/services/gardenSync.js` | 新增 `listStudyTasks()`：清单含开始时间与时长 |
| `src/ui/shell.js` | 注入面板、暴露 `__plannerGardenApi`、完成回写 |
| `tests/integration/studyTimerPanel.test.js` | **新增 6 个测试** |

### 测试结果

```
$ node --test "tests/**/*.test.js"
ℹ tests 584
ℹ pass 584
ℹ fail 0
```

覆盖：清单取最早时段的开始时间与长度、未排计划时按剩余时长兜底、
已完成任务不进清单、`mm:ss` 与 `h:mm:ss` 格式化、到点判定、注入失败安静返回。

### 说明：关于"22:23 开始"的排程

用户提到的「22:23 + 70 分钟 = 22:23–23:33」只是举例。当前排程规则是：
**在可用时间内放得下时，就精确按 22:23 开始**（已验证 10–35 分钟）；
超出可用时间时如实报告"容量不足"，不会擅自越界或拆成跨天重复时段。

### 仍未做

- 到点**自动**开始（现在是用户点「专注」或从任务行进入；自动开始需要页面前台常驻检查）；
- 花园内面板与主应用任务的双向编辑（目前是单向：主应用 → 花园 + 完成回写）。

---

## [1.10.0] — 计划开始时间精确生效（含短任务）

日期：2026-10-20

### 根因

"希望从这个时间之后开始安排"这个设置本身是生效的：只要 22:23 之后放得下，
时段就**正好**从 22:23 开始（已验证 10/15/20/25/30/35 分钟都排在 22:23）。

真正的问题在**短任务**上：

- `defaultMinChunkMinutes` 默认 30 分钟，H6 校验要求每个学习时段不短于它；
- 一个 20 分钟的任务，任何时段都必然短于 30 分钟 → H6 判为冲突 →
  `requestPreview` 直接失败，候选计划为空。

用户看到的现象就是"我填了 22:23，结果什么都没排出来"。

### 修复

`src/engine/constraints.js` 的 H6：任务**自身总工作量**就短于下限时放行，
判定依据从"片段是否收尾"扩展为"任务本来就到不了这个下限"：

```js
const taskTotalMinutes = plannedMinutes - priorCompletedMinutes;
const taskShorterThanFloor = taskTotalMinutes > 0 && taskTotalMinutes < lower;
```

### 验证

```
22:23 + 10 分钟 → 22:23–22:33
22:23 + 15 分钟 → 22:23–22:38
22:23 + 20 分钟 → 22:23–22:43
22:23 + 25 分钟 → 22:23–22:48
22:23 + 30 分钟 → 22:23–22:53
22:23 + 35 分钟 → 22:23–22:58
22:23 + 40 分钟 → 未安排（22:23 到 23:00 只剩 37 分钟，确实放不下，如实报告）
```

新增 `tests/integration/round10.test.js`（4 个）：精确开始、短任务可排、放不下要报原因、
不填开始时间的任务不受影响。全部 576 个测试通过。

### 仍未解决

- 任务时长超过"开始时间到当天可用时间结束"的剩余量时（如 22:23 + 60 分钟），
  目前如实报告"容量不足"，**没有**自动跨天拆分或延伸到 23:00 之后。

---

## [1.9.0] — 专注花园全屏化 + 与学习任务联动

日期：2026-10-20

### 一、花园改成真正的全屏（修掉"侧边栏还在"）

`#/garden` 时给外壳加 `data-mode="garden"`，CSS 隐藏品牌区 / 顶栏 / 侧边栏，
网格改为单列单行，iframe 占满整个窗口。返回靠**左上角浮动的「← 返回应用」**按钮
（这是我们自己的元素，覆盖在 iframe 之上，**没有改动花园的任何 DOM**）。

### 二、数据联动（主应用 ⇄ 花园）

| 方向 | 做法 | 是否改动花园 |
|---|---|---|
| 主应用 → 花园（写） | 走花园自己的 `dispatch`：`task/create`、`task/update`、`timer/reset → select-task → start` | 需要一个小桥（见下） |
| 花园 → 主应用（读） | 只读：花园在专注完成时**自己就会** `completedPomodoros + 1` 并写 session，主应用读 `focus-garden/tasks` 显示 🍅 数量 | **不需要**任何改动 |

花园本身没有对外 API、也不监听 `storage`/`message` 事件，所以"写"必须有桥。
补丁只加一行、不包裹任何现有逻辑：

```js
y.current=o;                                    // 原有
globalThis.__focusGardenBridge={getState:()=>y.current,dispatch:f};   // 新增
```

（`y` 是花园里指向最新 state 的 ref，`f` 是它的 dispatch；两者都是原有变量。）

### 三、行为

1. 进入花园 → 自动把**未删除**的学习任务同步过去（新建/更新/已完成的标为 done，不删除以保住番茄记录）。
2. 任务行新增「专注」按钮 → 打开花园并**自动开始**该任务的番茄钟：
   `timer/reset → timer/select-task → timer/start`。
3. **不抢**用户已经开着的计时：正在跑别的任务时不打断（`busy`）。
4. 一个番茄转完 → 花园自己 `+1` 番茄并写 session；主应用任务行显示 `🍅 N`。
5. 任务映射持久化在独立的 `studyPlanner:v1:gardenMap`，避免重复创建。

### 四、文件

| 文件 | 变更 |
|---|---|
| `scripts/patch-garden-wheel.mjs` | 增加 `bridge-for-planner-sync` 补丁（现共 4 处，逐条幂等） |
| `src/services/gardenSync.js` | **新增**：只读快照、番茄数、任务映射、同步任务、自动开始、等桥 |
| `src/ui/shell.js` | 全屏模式、返回按钮、进入花园时联动 |
| `src/ui/components.js` | 任务行支持 🍅 计数与「专注」按钮 |
| `src/ui/pages/tasks.js` | 接入番茄数显示与「专注」入口 |
| `src/ui/styles/components.css` | 全屏网格、返回按钮样式 |
| `src/main.js` | 注册 `services.gardenSync` |
| `tests/integration/gardenSync.test.js` | **新增 13 个测试** |

### 五、测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 572
ℹ pass 572
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1443 KB，内联 73 个模块）
```

联动测试用假桥验证了：字段映射、首次创建、重复同步只更新不重建、完成标 done、桥不可用降级、
`reset→select→start` 顺序、不抢占正在跑的计时、同一任务不重复启动、番茄数读取、损坏数据降级、等桥超时。

### 六、需要真机确认的部分

- 花园内部计时在浏览器里的实际表现（自动开始是否立刻进入专注、转完是否 `+1`）；
- iOS/Safari 下 iframe 的定时器节流表现；
- 这三点自动化只能验证协议，不能替代真人操作。

---

## [1.8.0] — 专注花园改为**内嵌常驻**（同源 iframe），计时器不中断

日期：2026-10-20

### 变更

| 项目 | 之前（v1.7.1） | 现在 |
|---|---|---|
| 打开方式 | 点击侧边栏 → 弹出**独立窗口** | 点击侧边栏 → **在页面内直接显示**（`#/garden`） |
| 侧边栏项 | `<button>`（开窗口） | 普通 `<a href="#/garden">` |
| 「在新窗口打开」 | 有 | **已移除** |
| 花园代码 | 未改（转盘补丁除外） | **仍未改**（同源 iframe，零修改） |

### 为什么用 iframe 而不是"把 HTML 拼进页面"

对两个应用做了实测比对，直接拼接会同时弄坏两边：

| 冲突项 | 数量 |
|---|---|
| 花园内联 CSS | 44 KB，含 7 条 `body{}`、3 条 `input{}`、`::selection`、滚动条规则 |
| 重名 CSS 变量 | **16 个**（`--space-1…6`、`--radius-*`、`--shadow-*`、`--font-*`、`--primary`、`--danger`、`--ghost`） |
| 重名类名 | **66 个**（`.card`、`.btn`、`.btn--primary`、`.chart`、`.app-nav`、`.app-main`…） |
| 全局快捷键 | 花园监听 `1/2/3` 切专注阶段，与本应用 `1–9` 切页冲突 |

iframe（同源、不加 sandbox）让它保持 **0 修改**，同时外观上无缝铺满内容区。

### 计时器为什么不会被打断（本次的重点）

1. **iframe 只创建一次**：引用挂在宿主元素 `host.__gardenFrame` 上（不是模块级变量，
   避免多实例/测试互相污染），之后的进入/离开只切换 `hidden`。
2. **从不重写 `srcdoc`**：重写等于刷新页面，计时会归零。测试里专门断言了这一点。
3. **离开页面时 iframe 仍留在 DOM 里**：花园的 `setInterval` 与计时状态继续运行。
4. **花园自身用绝对时间戳**：状态里有 `targetAt`（结束时刻）与 `pausedAccumMs`，
   剩余时间按 `targetAt - Date.now()` 计算 → 后台标签页被降频也不会累积误差；
   刷新时从 `focus-garden/timer` 恢复。

### 新增/修改文件

| 文件 | 变更 |
|---|---|
| `src/ui/gardenFrame.js` | **新增**：常驻 iframe 的创建/显示/隐藏，含"只创建一次"的不变量 |
| `src/ui/shell.js` | 新增 `#garden-host`（与 `main` 共用网格区域）；路由切换时只切 `hidden` |
| `src/ui/pages/garden.js` | 改为空实现（内容由 iframe 提供），删除启动器页与新窗口逻辑 |
| `src/main.js` | 删除 `openGardenWindow` |
| `src/ui/styles/components.css` | 新增 `.garden-host` / `.garden-frame`；删除窗口式导航样式 |
| `tests/integration/garden.test.js` | 改为内嵌语义（8 个测试） |
| `tests/integration/endToEnd.test.js` | 花园路由改为断言"宿主可见且 iframe 已挂载" |

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 559
ℹ pass 559
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1427 KB，内联 72 个模块）
```

端到端验证（打桩 DOM）：

```
导航: A #/garden | 无"在新窗口打开"按钮
宿主可见: true | main 隐藏: true | iframe: 1
srcdoc: 459,952 字符 | sandbox: null（保证花园存储可用）
切页 10 次后 → iframe 数 1 | 同一节点 true | srcdoc 未变 true
离开花园 → 宿主隐藏 true | iframe 仍在 DOM true
规划器：建任务 / 生成计划 / 应用计划 全部正常
```

### 留意

花园代码里有一处演示入口（`?seed=<base64>` 或 `window.__seedFocusGarden`）会执行
`localStorage.clear()`。同源下它会清掉本应用的数据（`studyPlanner:v1:*`）。
当前入口由本应用控制、**从不传 `?seed=`**，所以不会触发；不要手动带该参数打开花园。
按"零修改"的要求，这次没有改它。

---

## [1.7.2] — 修复专注花园奖励转盘的旋转动画

日期：2026-10-20

### 转盘为什么"不转，直接出结果"

转盘在**已构建的单文件应用**里（`focus-garden.html`，React 已打包）。反查打包代码后确认，
根因是三个叠加的缺陷，全在 `Tb`（转盘组件）的旋转逻辑里：

1. **首次抽奖时长被算成 0**
   ```js
   const Y = f ? 260 : (w ? 4200 : 0)   // w = "本会话是否抽过奖"，首次为 false
   ```
   于是走 `if (Y === 0) { setAngle(终点); setSpinning(false); return }`：
   角度**一次性跳到终点**，同时把 `spinning` 关掉 → CSS 过渡根本没机会开始。
   这就是"点击后直接显示中奖礼物、转盘不动"的直接原因。

2. **首次只转 1 圈**：`px(u.targetAngle, w ? 6 : 1)`。
   即使时长为正，第一把也只转一圈，观感不对。

3. **中奖卡片条件写的是 `pending ? 卡片 : ...`**，
   而 `pending` 在点击的瞬间就已写入 → 礼物与动画同时出现，甚至早于动画。

另外发现一个隐藏问题：

4. **重复抽奖几乎不转**：`px()` 返回的是**绝对角度**（每次都是 ≈2160°），
   第二把的目标角与第一把相差只有几十度，过渡就成了"在原地慢慢挪几度"。

### 怎么修的

对打包产物做**精确、可重复、幂等**的文本补丁（`scripts/patch-garden-wheel.mjs`）：

| 补丁 | 改动 |
|---|---|
| `ref-for-restored-pending` | 新增 `g0` ref，在 effect 顶部消费：区分"挂载时恢复的待领取结果"与"用户刚点击产生的结果" |
| `angle-continues-from-current` | 角度改为**从当前值继续累加**：`z = x + 2160`，再补到能对准扇区的角度 → 每次都至少 6 圈 |
| `result-after-spin` | 中奖卡片条件改为 `pending && !spinning`，动画结束后才出现 |

补丁后的决策：

```
首屏挂载      → 不动
第一次点击    → K=false, Y=4200ms, 6 圈  ← 真正播放动画
后续每次点击  → K=false, Y=4200ms, 至少 6 圈（从当前角度累加）
刷新后恢复    → K=true,  Y=0       → 直接落到已确定的结果（不重播、不重新随机）
```

**抽奖算法、权重、机会规则一行都没改**：结果在点击时由 `hx()` 确定（`segmentIndex` + `targetAngle`），
动画只负责把转盘转到那个角度；`px/q1` 的数学关系未变，指针始终停在扇区中心。

### 一致性如何保证（数值验证）

从**实际产物**里抽出真实的 `px` / `q1` / 角度表达式求值（不是重写一份算法）：

- 扇区数 1/2/3/…/16 全覆盖，每个扇区索引：指针都精确落在该扇区**内部**（不是边界、不是邻区）；
- 连续抽奖 8 次：每次 `next - current ≥ 2160°`（≥6 圈），且最终角度都对准中奖扇区；
- 刷新恢复：给出绝对角（0~360），不累加、不重新随机。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 559
ℹ pass 559
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1398 KB，内联 71 个模块）

补丁后的花园内联脚本     node --check 通过（414,967 字符）
单文件版 bundle 语法     node --check 通过（1,220,994 字符）
```

新增 `tests/integration/gardenWheel.test.js`（12 个）：指针与扇区一致性、6 圈、首次不再 0 秒、
4.2s 缓出过渡生效、结果延后显示、刷新恢复不重播、连续抽奖累加、抽奖守卫（不重复扣次数/写记录）、
按钮禁用、空奖励不启动、补丁幂等、内联副本同步。

### 更新花园时注意

`focus-garden.html` 现在是"**打完补丁的产物**"。如果以后用花园自己的工程重新构建并覆盖它，
**必须重新运行**：

```bash
node scripts/patch-garden-wheel.mjs    # 重新打补丁（幂等，锚点不匹配会报错而不是静默跳过）
node scripts/build-garden-embed.mjs
node scripts/build-standalone.mjs
```

`--check` 可以随时确认补丁是否还在。

### 无法自动验证的部分

动画的**实际观感**（帧率、缓出手感、移动端表现）需要真实浏览器确认；
自动化只能验证状态机决策、角度数学与产物语法。

---

## [1.7.1] — 专注花园改为独立窗口打开（可全屏使用）

日期：2026-10-17

### 变更原因

上一版把花园用 `<iframe srcdoc>` 嵌在内容区里。实际使用中存在两个问题：

- 嵌在规划器的布局里只剩一小块区域，**没法真正全屏使用**；
- 切换规划器页面会重建 iframe，正在跑的计时被打断。

### 现在的行为

| 位置 | 行为 |
|---|---|
| 侧边栏「专注花园」 | 用 **button** 承载，点击**直接打开独立窗口**（不切换页面，URL 不变） |
| 快捷键 `7`（对应导航序号） | 与侧边栏一致，直接开窗口 |
| 地址栏 `#/garden` | 打开一个**启动器页**：不内嵌任何内容，只提供「打开专注花园窗口」按钮与说明 |

窗口尺寸按可用屏幕大小计算（约 98% × 96%），打开即铺满整块屏幕；
需要系统级全屏时按 macOS 的 ⌃⌘F（Windows / Linux 为 F11）。

### 实现要点

- **必须由点击直接触发 `window.open`**：如果先跳到 `#/garden` 再在渲染时开窗，
  就已经脱离用户手势上下文，会被浏览器当成弹窗拦截。
- **固定窗口名 `focus-garden-window`**：重复点击复用同一个窗口，不会开出一堆。
- **Blob URL 而不是相对路径**：单文件版（`dist/standalone.html`）旁边没有
  `focus-garden.html`，相对路径会 404；Blob URL 两种版本都可用。
- **不 revoke Blob URL**：这个窗口是长期使用的工具，用户随时可能刷新它（460 KB 占用可忽略）。
- 被拦截时给出可执行提示（"允许本站弹出窗口后重试"），启动器页上还有备用按钮。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 547
ℹ pass 547
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1398 KB，内联 71 个模块）
```

`tests/integration/garden.test.js` 相应改写（8 个）：导航项是 button 且不带 href、
点击调用 `window.open` 且不改变当前页面、重复点击复用同一窗口名、
启动器页不再内嵌 iframe、被拦截时有提示、内联模块与源文件一致、单文件版脚本结构完整。

---

## [1.7.0] — 把「专注花园」内嵌进应用（侧边栏入口）

日期：2026-10-17

### 做了什么

在侧边栏「学习统计」之后新增 **专注花园** 入口，点进去就是完整的专注花园应用，
另外提供「在新窗口打开」。两种版本（多文件版与单文件版 `dist/standalone.html`）都能用。

### 为什么用 iframe + srcdoc，而不是把它的代码并进来

花园是一个**独立的单文件应用**（React 已打包、样式内联、挂载到它自己的 `#root`、有自己的 localStorage 键）。
它和本应用是两套运行时：

- 用 iframe 承载 → 它的全局样式、`#root`、快捷键、存储键都不会污染规划器；
- 用 `srcdoc` 内联而不是引用外部文件 → 单文件版也能打开（相对路径的 iframe 在单文件版里会失效）。

### 新增文件

| 文件 | 用途 |
|---|---|
| `focus-garden.html` | 花园的源文件（ASCII 文件名，供重新生成内联模块用） |
| `scripts/build-garden-embed.mjs` | 把 HTML 转成 ES 模块（含 `</script>` 转义） |
| `src/embed/focusGardenHtml.js` | 生成的内联模块（约 479 KB，由脚本产出，请勿手改） |
| `src/ui/pages/garden.js` | 花园页面：iframe + 新窗口按钮 + 数据独立性说明 |

### 关键实现细节

1. **`</script>` 必须转义**：单文件版把所有模块塞进一个 `<script>` 标签，
   花园 HTML 里自带的 `</script>` 会提前截断脚本、导致白屏。生成时写成 `<\/script`。
2. **去掉依赖相对路径的外链**（`manifest.webmanifest`、`icons/icon.svg` 等）：
   `srcdoc` 里的相对地址按父页面解析，只会 404；它们只用于安装/标签页图标，内嵌场景无意义。
   源文件保持原样，只改内联副本。
3. **sandbox 必须放行脚本与同源**：否则页面空白，且 localStorage 不可用（花园无法保存专注记录）。
4. **数据是分开的**：花园存自己的键，规划器的任务不会同步进去，反之亦然；两边都会在刷新后保留。
5. **数据一致性有测试兜底**：如果 `focus-garden.html` 更新了却忘记重新生成内联模块，测试会失败并提示命令。

### 更新花园版本的方法

```bash
# 1) 用新的「专注花园」HTML 覆盖 focus-garden.html
# 2) 重新生成内联模块
node scripts/build-garden-embed.mjs
# 3) 重新构建单文件版
node scripts/build-standalone.mjs
```

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 545
ℹ pass 545
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（1393 KB，内联 71 个模块）
```

新增 `tests/integration/garden.test.js`（6 个）：入口位置、iframe/srcdoc 内容完整性、
sandbox 放行、新窗口按钮与拦截提示、内联模块与源文件一致、单文件版的脚本结构完整。

### 注意

- 单文件版体积从 909 KB 增加到约 1.2 MB（花园本身 460 KB），这是"内联而不是外链"的代价。
- 内嵌时花园的安装图标/manifest 不可用（浏览器只在顶层文档读取它们）；
  需要"添加到桌面"时请用「在新窗口打开」。

---

## [1.6.0] — 收尾：真正的「恢复出厂设置」与通知使用限制说明

日期：2026-10-17

### 一、恢复出厂设置失效的根因

**根因不是按钮坏了，而是"没有真正的出厂重置"**：

1. 危险操作区里只有一个 `resetSystem()`，它按设计**保留设置与外观偏好**，
   只清业务数据。用户改过主题、调过设置后点它，看起来"什么都没变"，自然判断为失效。
2. 附带的真实缺陷：`resetFactory` 的雏形把 `await clearWallpaper()`（IndexedDB）放在关键路径上。
   一旦 IndexedDB 不响应（隐私模式/权限被拦/存储异常），
   后面的**备份槽同步、重新渲染、成功提示全部不会执行**——表现同样是"点了没反应"。

**修复**

- 新增 `services.ui.resetFactory()`：数据 + 设置 + 个性化一起恢复出厂；
- **关键步骤全部同步**，异步的壁纸清理挪到最后且 `不 await`，失败只提示、不阻塞；
- 备份槽同步（否则重开时"从备份恢复"会把旧数据装回来）。

### 二、恢复出厂设置清理的数据与持久化位置

| 存储位置 | 内容 | 出厂重置 |
|---|---|---|
| `studyPlanner:v1:state` | 任务（含已删除历史）、学习时段、固定日程、休息、科目、正式计划、候选计划、版本历史、**设置** | 重写为全新空状态（含默认设置） |
| `studyPlanner:v1:backup` | 自动恢复备份 | 同步为出厂状态 |
| `studyPlanner:v1:meta` | `lastSavedAt` / `bytes` 运行状态 | 保留（下次保存自动更新） |
| `studyPlanner:v1:preferences` | 主题、壁纸元信息、通知开关 | 主题回到默认浅色；壁纸与通知恢复默认 |
| `studyPlanner:v1:notified` | 通知去重台账 | 清空 |
| IndexedDB 壁纸图片 | 用户上传的壁纸 | 异步删除（失败给可执行提示） |

保留：程序代码、内置样式与默认配置、初始化逻辑。

### 三、通知使用限制说明

通知页顶部新增「通知使用限制」卡片，分三段：

- **当前环境检测结果**：来自真实能力检查（安全上下文 / 通知 API / 能否直接创建通知 / 当前是否可发送）；
- **需要满足的条件**：浏览器授权 + 系统允许该浏览器发通知 + 页面保持打开 + `http://127.0.0.1` 或 HTTPS + Chromium 内核浏览器；
- **不受支持或无法保证**：
  - iPhone / iPad（iOS/iPadOS）：本版本不支持（需"添加到主屏幕"+ Service Worker）；
  - Safari（macOS）：不支持直接创建通知（需 Service Worker 通道），本版本未实现；
  - `file://` 双击打开、`http://局域网IP`：非安全上下文，通知被拒绝；
  - 关闭页面/浏览器、系统休眠后不会提醒（**没有** Service Worker 与后台推送）；
  - 后台标签页定时器被降频，提醒可能晚几十秒（用真实时间戳比较，不会漏）；
  - 系统「勿扰/专注模式」或通知中心静音时不弹出；
  - 清理站点数据会清掉权限记录。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 539
ℹ pass 539
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（909 KB，内联 69 个模块）
```

新增 7 个测试：出厂重置（数据+设置+主题）、取消不动数据、备份槽同步防复活、
重置后仍可建任务与生成计划、不使用 `localStorage.clear()`/`deleteDatabase`、
通知限制说明覆盖 iOS/Safari/本地文件/后台推送、不可用环境不只显示"已开启"。

### 保留的两级操作

- **恢复出厂设置**：数据 + 个性化设置全部回到初始；
- **仅清空数据（保留设置）**：原来的 `resetSystem` 行为，未修改；
- **恢复默认设置**：只重置排程设置（走预览确认），未修改。

---

## [1.5.0] — 重置系统、彻底删除任务历史、计划开始时间真正生效、通知可用性判断

日期：2026-10-17

### 一、偏好设置：新增真正可用的「重置系统」

**原来的问题**：设置里只有一个「恢复默认设置」，它只重置**设置**（走预览确认），
并不清理业务数据；界面上没有任何"清空数据"的入口。

**实现**：新增 `services.ui.resetSystem()`，做的是**有范围的重置**：

| 清空 | 保留 |
|---|---|
| 任务（含已删除历史）、学习时段 | 设置（可学习时间/拆分规则/休息规则/权重） |
| 固定日程、休息安排、科目字典 | 外观偏好（主题/壁纸）与通知偏好 |
| 正式计划、候选计划、版本历史 | `schemaVersion`、上次导出备份时间 |

- **二次确认**：弹窗逐项列出将被删除的数量与保留的内容；
- **原子写入**：走 `app.commit`，失败会回滚内存并保留磁盘原数据，绝不"清一半"；
- **不用 `localStorage.clear()`**：同一个源下还有偏好/主题等键，全清会连带破坏外观；
- 失败时明确报错（含原因），不会显示成功提示；
- **同步"自动恢复备份"槽**：保存时会把上一份状态轮转进 backup 槽，
  如果不处理，重置后一旦主数据读取失败，"从备份恢复"会把已清空的数据装回来。
  重置成功后会把空状态写进该槽（只动这一个键）；
- 成功后立即重渲染当前页并提示。

### 二、七日计划：只删除「重新规划」

只移除了 `src/ui/pages/week.js` 里的那一个按钮。
`services.ui.openPlanForm` / `planService.requestPreview`（生成与重新规划的真实能力）、
首页与每日视图的生成入口**全部保留**，页面布局、日期列、翻周、添加休息都不变。

### 三、学习任务：已删除历史可以彻底删除

**原来的问题**：`deleteTaskOp` 只要发现该任务有学习记录，就**强制降级为软删除**，
于是"已删除历史"里的任务永远无法真正清除。

**实现**：新增 `task.purge` 变更 + `taskService.purgeTask()`：

- 从 `tasks` 中真正移除任务；
- 一并移除它的**全部学习时段**（含已完成——用户明确要求彻底删除）；
- 移除正式计划里属于它的块；
- 解除其它任务对它的 `dependsOn` 引用（否则依赖校验会失败、应用无法保存）；
- 丢弃已失效的候选计划；
- 不动其它任务、固定日程、休息安排、设置。

任务页「已删除历史」里每条记录新增「彻底删除」按钮（与「恢复」并列），
带二次确认（需勾选确认项）。软删除仍保留原语义。

### 四、计划开始时间：从"软过滤"改为真实下界

**原来的问题**：`chooseSlot` 里有一段"如果没有候选就退回未过滤的候选"，
于是**用户填了 15:30，系统照样排到 14:00 且不作任何提示**。
这就是"填了计划开始时间却仍按默认整点安排"的真实原因。

**实现**：

- 计划开始时间成为该任务的**时间下界**：不允许排在该时间之前；
- 它只约束这个任务，**不改变任务之间的优先级顺序**（评分逻辑完全不看它）；
- 下界之后没有可用时间时：不安排，并给出具体原因
  `planned_start_unreachable`（"你设置的计划开始时间之后没有足够的可用时间"）；
- 与截止时间冲突时同样如实报告，不会违反任一约束；
- 填的时间早于本次规划起点时，按起点执行并给出 `planned_start_clamped` 提示（不静默）；
- 优化阶段（向前压缩）同样尊重这个下界，避免"放对了又被压回去"。

顺带修掉一个连带缺陷：第三轮把 `subject.*` 的处理**误插进了 `describeDraftOps`**，
导致"带新科目新增任务且未提供 changeSummary"时会抛 `ReferenceError: state is not defined`。

### 五、通知：修复可用性判断与失败原因

**原来的问题**：`supported()` 只判断 `typeof Notification === 'function'`，于是两类假阳性：

1. **非安全上下文**（`file://` 双击、`http://局域网IP`）：有 API 但发送会被拒绝；
2. **Safari（macOS/iOS）**：有 `Notification`、权限也能是 granted，但 `new Notification()` 抛错
   ——Safari 只支持 Service Worker 的 `registration.showNotification()`。
   结果就是"权限已开、一条也收不到"。

**实现**：

- 新增 `capabilities()`：区分 `api` / `secure` / `constructorUsable` / `serviceWorkerChannel`；
- `deliver()` 返回精确原因：`insecure-context` / `unsupported` / `no-permission` / `no-channel`（带原始错误）；
- 构造器失败会被**记住**，之后 `describeEnvironment()` 如实变成"不支持"，不再显示"支持"；
- 若环境提供 Service Worker 注册，则回退到 `showNotification`（当前未内置 SW，故实际为不可用）；
- 通知页顶部显示环境说明（来自真实能力检查），测试通知失败时按原因给出具体指引。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 532
ℹ pass 532
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（约 880 KB，内联 69 个模块）
```

新增 `tests/integration/round5.test.js`（21 个）：重置系统（清空/保留/取消/失败不谎报/不使用 clear）、
七日计划按钮删除与其它入口保留、彻底删除（持久化移除/不影响他人/解除依赖/UI 二次确认）、
计划开始时间四条规则、通知五种环境场景。

### 通知支持范围（如实说明）

| 环境 | 是否可发系统通知 | 说明 |
|---|---|---|
| Chrome / Edge（macOS），通过 `http://127.0.0.1` 或 HTTPS | ✅ | 需在 macOS「系统设置 → 通知」允许浏览器通知 |
| Chrome，`file://` 双击打开单文件版 | ❌ | 非安全上下文，浏览器直接拒绝；页面会明确说明 |
| Safari（macOS） | ❌ | 不支持 `new Notification()`；需 Service Worker 通道，本应用未内置 |
| iOS / iPadOS 任何浏览器 | ❌ | 需"添加到主屏幕"+Service Worker，本应用未内置 |
| 局域网 IP 上的 HTTP | ❌ | 非安全上下文 |

应用内的页面提示（"即将开始"横幅）在所有环境都可用，不受上述限制。

### 已知限制

1. Safari 与 iOS 无法发送系统通知（需内置 Service Worker，属于架构变更，本轮未做）。
2. 彻底删除会连同该任务已完成的学习记录一起删除（这是"彻底"的代价，已有二次确认说明）。
3. 重置系统保留设置：如需连设置一起恢复默认，请再用「恢复默认设置」。

---

## [1.4.0] — 修复计划延迟到 16:00、任务列表残留、可选属性；新增计划开始时间与自动预览开关

日期：2025-10-16

### 一、学习计划总是从 16:00 开始的真实原因

**根因（两个，一个隐藏了另一个）**

1. `defaultSettings()` 里默认可学习时间是写死的 **`16:00 – 23:00`**：
   ```js
   const everyDay = () => [{ startMinutes: 16 * 60, endMinutes: 23 * 60 }];
   ```
   这正好是**每天 7 小时 = 每周 49 小时**——就是早期被废弃的那个限制。
   界面虽然删了，**默认值没删**，于是排程器永远只能从 16:00 之后找空档。
2. 第三轮删除"可学习时间（按星期）"**界面区块**之后，用户已经**没有任何入口**能改掉它，
   所以这个限制变成了"看不见、也改不动"的死约束。

**修复**

- 默认窗口改为 **07:00–23:00**（正常作息范围）；睡眠/上课请用固定日程表达（会从窗口里扣掉）；
- 新增迁移 `upgradeLegacyStudyWindows`：**仅当七天都恰好还是 16:00–23:00** 时升级为新默认，
  并在界面明确告知改了什么。任何一天被用户改过就完全不动；
- 已确认代码里**没有** 420 分钟 / 49 小时的硬编码残留（`dailyStudyCapMinutes` 保持 `null`）。

### 二、截止时间以前根本没参与排程

**根因**：放置阶段只按"空档 + 评分"选位置，从不看 `deadlineDate/deadlineTime`。
于是截止 13:00 的任务会被排到 16:00，而计划仍被判为"成功"。

**修复**

- `placer` 新增 `constrainByDeadline`：任何片段都不得晚于截止时间结束；
- 排不下时新增原因码 `deadline_too_close`，明确说明"截止前剩余时间不够"，
  而不是笼统报"七天容量不足"；
- 仍然不会为了提前而忽略固定日程、休息或有效占位，也没有关闭任何冲突检测。

### 三、完成/删除的任务不再残留在普通任务列表

**根因**：`statusFilter === 'all'` 分支**不做任何过滤**，且 `includeDeleted` 在"全部"时也打开，
于是已完成 / 已取消 / 已删除的任务全都混在普通列表里。

**修复**：每个筛选都给出明确定义

| 筛选 | 含义 |
|---|---|
| 待安排 | 未开始 + 进行中 |
| 全部有效任务 | 所有仍有效、未完成/未取消/未删除的任务（**不含任何历史状态**） |
| 已完成 / 已取消 / 已删除 | 各自独立的历史入口 |

时间表与统计**继续显示**已完成任务的历史安排（标记为"已完成"），
所以"从待办列表消失"与"历史可查"是两件事，互不影响。

### 四、任务属性：计划开始时间 + 三个可选字段

- **新增「计划开始时间（可选）」**：表示"希望任务从这个时间之后被考虑"。
  - 它是**软偏好**：只缩小该任务可落的区间，完全不改变任务之间的优先级排序；
  - 如果偏好时间之前没有空档，会退回不限制（宁可晚一点，也不因此排不上）；
  - 明确区分三者：计划开始时间（偏好）、截止时间（最晚）、固定日程（不可移动）。
- **「已经完成（分钟）」改为可选**：留空保存为 `null`（= 还没开始做），
  与显式 `0` 在存储上可区分、在计算上一致（都按 0 分钟扣减）；仍受"不能超过总用时"约束。
- **「最短 / 最长学习时段」改为可选**：留空 = 由排程器使用系统默认值与可用时间决定，
  不会变成 0 分钟限制；只在用户填了值时才校验（≥5、min ≤ max）。
- 新建与编辑共用同一套规则（`createTask` / `applyTaskPatch` / `validateTask`），
  表单里的空字符串统一转换为 `null`，不会出现 `NaN` 或 `0` 分钟任务。

### 五、删除「跟随系统」主题

- `THEME` 只剩 `light` / `dark`，默认改为 `light`；
- 旧偏好里的 `system` 在**读取时**映射为等价显式主题（系统深色就落 dark），
  既不会崩，也不会突兀换主题；未知值一律回落到 `light`；
- 外观页不再渲染该选项，写入 DOM 的 `data-theme` 只可能是 light/dark。

### 六、新增「自动生成计划预览」设置

设置位置：偏好设置 → 排程参数 → 预览与确认。

| 状态 | 行为 |
|---|---|
| 开启（默认，保持原行为） | 任务/固定日程改动后**直接生成候选预览**，不再重复询问 |
| 关闭 | 先询问「要现在更新学习计划吗？」；选「暂不生成」→ **只保存数据，正式计划原样不动** |

两种情况都**不会**在用户确认前把候选计划变成正式计划；"自动生成预览"不等于"自动应用计划"。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 510
ℹ pass 510
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（878 KB，内联 69 个模块）
```

新增 `tests/integration/round4.test.js`（21 个）：16:00 根因与迁移、截止约束与原因、可选字段三条规则、
计划开始时间的软偏好与优先级保护、任务列表筛选、主题兼容、自动预览两种模式。

### 数据兼容

- 只升级"七天都还是旧默认窗口"的设置；用户自定义的窗口一个字都不动；
- 任务的三个字段：旧数据里的数字原样保留，空值存 `null`，无需重写历史数据；
- 主题：旧 `system` 读取时映射，不改写用户偏好文件；
- 未清空任何数据、未关闭任何校验。

### 已知限制

1. 「计划开始时间」是软偏好：若该时间之前有空档、用户又没填偏好，任务仍可能被排在更早的位置。
2. 关闭自动预览时，数据会直接保存但**计划不会重算**，需要用户自己到「调整预览」页生成。
3. 界面自动化仍基于打桩 DOM，真实浏览器视觉需人工确认。

---

## [1.3.0] — 修复休息保存无响应、历史残留锁定时间；规划开始时间、科目管理与统计图表

日期：2025-10-16

### 一、添加休息时间"点了完全没反应"（真实根因）

`services.ui.saveRest / deleteRest` 里引用了 `app`、`idFactory`、`nowIso` 三个变量，
而它们所在的 `createUiService({ services })` 作用域里**没有**这些名字。

于是点击"添加"时，`submit()` 一进到保存那一步就抛出 `ReferenceError`，
异常在事件回调里被吞掉 → 弹窗不动、没有 toast、没有错误提示，表现就是"完全没反应"。
（数据层本身是好的：直接调用 `mutations` 能正常保存，所以问题只出现在界面链路上。）

**修复**：改用 `services.app / services.idFactory / services.clockIso()`；
两个表单（休息、生成计划）都加了 `try/catch`，任何异常都会变成用户看得见的红色错误提示。

**顺带修掉了测试盲区**：打桩 DOM 的 `click()` 以前只派发 `click`，
而真实浏览器点表单里的提交按钮会触发 `form` 的 `submit`。
现在打桩 DOM 也模拟这一行为——"按钮有没有接上提交"终于能被测出来（新增测试覆盖）。

### 二、「设置休息」：一个入口，两种明确含义

每日视图右上角新增「设置休息」：

| 模式 | 语义 | 保存为什么 |
|---|---|---|
| 仅设置今晚休息 | **一次性**安排（今晚 22:00 → 明天 08:00） | `restPeriods` 里的一条休息 |
| 固定睡觉时间 | **长期重复规则**（可选周几） | `type='sleep'` 的固定任务（带星期重复） |

- 模式 A 保存后立刻出现在日期列里；今晚已有安排时**替换**而不是重复创建；
  开始时间已过去、起止时间相同、结束早于开始都会给出明确提示。
- 模式 B 走既有"候选计划预览 → 确认"流程，因此重复规则真正写入固定任务表，
  下一周继续生效，跨午夜自动拆成 22:00–24:00 / 00:00–08:00。
- 两者不会互相转化：一次性休息不会被写成重复规则，重复规则也不会只存成某一天。

### 三、已完成 / 已删除任务的历史残留不再锁定时间（最高优先级）

**真实根因**：已完成时段的计划块被当成"仍然有效的日程占位"参与校验。
复现：13:00–14:00 写作业并标记完成，15:00 想在同一时段加一门课，
引擎报 `V051 学习时段与固定活动重叠 60 分钟`，并且还报"超出允许学习时间"。
时段本身没有错，错的是**把历史当成了当前占位**。

**修复（区分两层）**：

1. **容量层**：已完成时段仍然占住它的墙钟时间，避免排程器把新学习排到同一时刻；
2. **冲突层**：历史块（已完成 / 已取消）不再参与 H1（与固定活动重叠）、
   H2（时段互相重叠）、H3（是否落在允许学习时间）这些**排程校验**；
   `detectReservedConflicts` 只看锁定 / 进行中的时段。

**已删除任务的残留**：`reconcile` 早就会取消"指向不存在任务的未完成时段"，
但 `migrateState` 的修复白名单里没有这个错误码，所以旧数据加载时会**拒绝读取**而不是修复。
现在：

- 白名单加入 `V021`（时段引用了不存在的任务）；
- 悬空引用对**已完成/已取消**的历史记录降级为提示（历史事实不该让应用打不开），
  只有仍占用时间的时段才是错误；
- 修复结果必须重新通过完整校验才采用，原始数据轮转到备份槽。

### 四、规划开始时间 + 自动避让固定日程

- 引擎新增 `startAt`；不传时按**严格的下一个整点**推导：
  20:24 / 20:00 / 20:59 → 21:00，21:00 → 22:00（有测试逐条锁定）；
- 用户指定开始时间时从该时间开始找空档；指定了一个**已经过去**的时间，
  会如实提示"已改为从 HH:mm 开始"，不会悄悄把过去当成未来；
- 过去日期一律不产生可用容量 → 不会生成过去的学习时段；
- 局部优化器以前用**未裁剪**的按星期窗口做"向前压缩"，
  会把片段挪回规划起点之前（这正是"生成过去时段"的最后一条漏网路径），
  现在改用按日期裁剪后的窗口；
- 固定日程沿用容量扣除的方式避让：冲突不会让整个规划失败，
  任务会被安排到其它可用时段；放不下则在"未安排任务"里给出具体原因。

### 五、科目管理

科目以前是每个任务各自的自由文本，打错一个字就会永久多出一个选项。
现在是一份字典（`state.subjects`），任务仍保存科目名（保持旧数据与统计兼容）：

- 任务表单的科目改成**下拉选择**（数据来自科目管理）+「＋ 新增科目…」，
  新增会在**同一次草稿链**里先 `subject.ensure` 再写任务；
- 科目管理放在「偏好设置 → 科目管理」：查看、新增、改名、删除；
  名称按 Unicode 计数、去首尾空白、连续空白压成一个空格，因此"数学"与"  数学 "不会变成两项；
- **改名会同步更新所有引用它的任务**（同一次提交内完成）；
- **删除仍被引用的科目会被拒绝**，并提示引用数量；也可以选择一个替换科目后一起迁移，
  绝不留下无法识别的引用；
- 旧任务里用到但未登记的科目会作为"历史科目"列出，可一键收编；
- 旧数据加载时会把任务里的科目整理进字典（只新增，不改任何任务）。

### 六、统计柱状图

原来的图表每天画**两根柱子**（计划 / 实际），14 天就是 28 根，宽度极小、
只有一半柱子有标签，看起来"一高一低、参差不齐"。

现在：**一天一根柱子**，柱高 = 当天实际学习时长，计划时长用同列背后的浅色轨道表示
（同一纵轴、不并列）；纵轴按真实数据取整到 15/30/60/120 分钟的刻度并标出上限；
0 分钟显示基线短划、完全没有数据的日期不画柱子（两者区分开）；
图例说明每个元素代表什么；标签按密度抽稀，避免重叠。**统计数值一个都没改。**

### 七、删除「可学习时间（按星期）」

界面上的标题、说明文字与只读表格整块删除，同时清理了只服务该区块的编辑器与辅助函数。
**底层数据 `settings.studyWindows` 保留**——排程器与容量计算仍然依赖它，
删的只是这个只读总览区块（可用下方的 JSON 编辑区调整）。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 489
ℹ pass 489
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（852 KB，内联 69 个模块）
```

新增 `tests/integration/round3.test.js`（26 个）：休息表单真实提交（含异常兜底）、
两种休息模式、历史不锁定时间、孤立时段清理、开始时间三条规则、固定日程避让、
可拆分/不可拆分、科目增删改与孤儿科目、柱状图口径与 0/无数据区分、
偏好设置区块删除。

### 数据兼容

- 新增 `state.subjects`，旧数据加载时从任务推导（只新增）；
- `restPeriods` 沿用上一轮的结构，无迁移；
- 历史时段悬空引用降级为提示，**不删除任何已完成记录**；
- 所有修复都要求"修复后必须重新通过完整校验"，失败会回退到原始数据。

### 已知限制

1. 界面自动化测试仍基于手写打桩 DOM，真实浏览器视觉需人工确认。
2. 休息时间（一次性）没有重复规则；重复睡眠请用「固定睡觉时间」。
3. 科目删除时的"替换"目前默认选列表里的第一个科目，不能自由选择（可先改名再删）。
4. 局部优化只保证不早于规划起点、不与固定/休息重叠；不做全局最优。

---

## [1.2.0] — 修复背景遮挡、任务删除与完成隐藏、跨周重复、网格尺寸；新增休息时间

日期：2025-10-16

### 一、整体界面"发蒙"与区块被遮挡

**根因（两个，叠加在一起）**

1. `#app-wallpaper` 写的是 `position: fixed; z-index: 0`。
   按 CSS 绘制顺序，**定位元素 z-index:0 会画在普通流内容之上**，
   于是整页被"壁纸 + 55% 遮罩"盖住：文字发蒙、部分区块看不见。
2. 上一轮删除模糊设置时只删了变量，卡片上仍留着
   `backdrop-filter: blur(10px)` 与 88% 半透明底色——模糊作用在**承载文字的容器**上。

**修复**

- 壁纸层改为 `z-index: -1`（内容之下、页面背景之上），不再需要给任何业务元素加 z-index；
- 删除全部 `backdrop-filter` 与卡片半透明底色，前景一律不透明；
- 遮罩固定 62%，保证任何照片下文字可读；壁纸层 `pointer-events: none`，不挡点击。

### 二、7 日计划中的任务无法删除 / 完成后仍占格子

- 计划卡片原本只能打开时段详情，**没有删除入口**；删除要走预览，一旦数据不一致就被校验拦死。
- 现在卡片上直接提供「详情 / 完成 / 删除任务」，删除使用与任务列表**同一个**服务方法
  （`taskService.deleteTask` → `mutations.task.delete` → `reconcile` 同步取消未完成时段），
  因此既不会留下孤立时段，也不会因为数量不一致被拒绝。
- 已完成/已取消/已删除的任务**不再出现在任何日期列**（跨多天的任务一次性全部消失），
  已完成的学习记录仍然保留在数据与统计里。

### 三、彻底删除时间列与时间刻度

- `#/week` 不再使用时间轴，改为「日期为列、任务为内容」的看板；
- **删除**了 `timeline()` 组件、`.timeline*` 全部样式、`--timeline-*` 尺寸变量与相关测试；
- 首页的"今天的时间轴"也一并改为看板卡片，项目中不再有任何时间刻度结构；
- 时间只作为卡片内部的小字（`22:00–22:45`），没有具体时间的卡片显示"全天"，不伪造时间。

### 四、每周固定任务跨周消失

**根因**：`occursOn` 的重复规则本身是对的，但 `#/week` 只渲染 `plan.blocks`，
而计划窗口只有 7 天，翻到下一周就没有任何块可渲染。

**修复**：看板改为按**重复规则实时展开**固定任务（`fixedActivityService.forDate`），
所以任何日期都能算出来。同时：

- 修正了 `forDate` 不拆分跨午夜固定任务的问题（22:00→次日 06:00 以前显示成 22:00–06:00）；
  现在按日期拆成 22:00–24:00 / 00:00–06:00，并且会从"前一天的发生"里取尾部，避免漏显示；
- 七天计划支持"上一周 / 下一周"，跨周后重复规则依然生效且不会重复生成。

### 五、任务名称统一限制 10 个字符

- `validation.js` 新增 `TASK_NAME_MAX_LENGTH = 10` 与 `checkName()`，
  按 **Unicode 码点**计数（中文、emoji 各算 1 个），错误码统一为 `V005`；
- 学习任务、固定任务、休息时间共用同一套规则与文案；
- 表单 `maxlength` 与保存前校验使用同一个常量，不会出现"界面能输、保存报错"；
- **已有超长名称不会被截断**：整体校验（加载/导入）把它降级为提示，
  用户仍能打开应用并编辑修正；保存时才强制拒绝。

### 六、卡片尺寸与网格基准

- 定义唯一基准：`--day-grid-step`（8px）代表 **5 分钟**；
  卡片高度 = `ceil(时长 / 5) × 标准格`，非 5 分钟倍数向上取整（不丢时长）；
- 60 分钟恰好是 30 分钟的两倍高，120 分钟是 60 分钟的两倍高（有测试断言倍数关系）；
- 极短时段（≤30 分钟）使用 3 格（24px）作为可点击下限，并切换为紧凑排版
  （只显示时间与名称），文字用 ellipsis 兜底，绝不溢出卡片；
- 卡片尺寸只用于对齐，**不绘制任何刻度文字**，因此没有恢复旧时间轴。

### 七、新增休息时间

- 新增独立实体 `restPeriods`（`domain/restPeriod.js`），**不是**学习任务也不是固定任务：
  不参与剩余工作量、不参与排程、不计入学习统计；
- 视觉独立：绿色系、`休息` 标签、跨夜片段还会标注"前半/后半"；
- 按**午夜边界**拆分显示：一条 `10-16 22:00 → 10-17 08:00` 的休息会显示为
  `10-16 22:00–24:00` 与 `10-17 00:00–08:00` 两个片段，时长守恒、无重叠；
- 支持多天（最长 31 天），中间日整天；
- 保存前检查与固定任务/学习时段/其它休息的重叠，**如实提示并让用户确认**，不静默覆盖；
- 修改/删除一条休息会同时影响它的所有日期片段；
- 入口：七天计划页「添加休息」、每日视图、固定日程页的「休息时间」区块（含编辑与删除）。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 463
ℹ pass 463
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（796 KB，内联 64 个模块）
```

新增 `tests/integration/round2.test.js`（22 个）：背景层级与无 backdrop-filter、
任务删除（已排程/未排程/坏数据）、完成后从所有日期列消失、固定任务跨周与跨午夜、
名称长度（严格/宽松/备注不受影响/不静默截断）、网格倍数关系、
休息拆分（跨夜/多天/时长守恒/非法输入/冲突/不影响工作量与统计）、排序稳定性、
以及"22:00–24:00"的界面文案。

### 数据兼容

- 无破坏性迁移：`restPeriods` 是新字段，旧数据加载时补空数组；
- 旧数据里的超长名称只提示、不修改；
- 旧计划里的 `kind='buffer'` 仍在读取时被清理（上一轮已处理）。

### 已知限制

1. 界面自动化测试仍基于手写打桩 DOM，真实浏览器视觉需人工确认。
2. 休息只支持"一次具体时段"，暂不做复杂的重复休息规则（本轮未要求）。
3. 看板列宽最小 180px，窄屏横向滚动。
4. 业务数据仍在 localStorage（约 5 MB），壁纸在 IndexedDB。

---

## [1.1.0] — 修复数据一致性、修复壁纸、按需精简功能、重设每日视图

日期：2025-10-16

### 目标

在第一版现有代码基础上修复影响正常使用的缺陷，并按需求删除明确不再需要的功能。
**没有重写项目，没有迁移架构**；保留任务、固定日程、计划、设置与壁纸数据。

### 一、修复：任务与计划时段的数据一致性（最高优先级）

**用户可复现的三条报错/现象**

1. 把「预计总用时」从 120 分钟改小到 60，报
   `"m" 未完成时段合计 120 分钟，但剩余工作量只有 60 分钟。`
2. 把任务标记完成后，报
   `"o" 未完成时段合计 120 分钟，但剩余工作量只有 0 分钟。`
3. 之后任务删不掉；重新打开应用时任务"消失"（显示空白）。

**真实根因（已用脚本复现，不是猜测）**

- 校验不变量是 `剩余工作量 ≥ 未完成时段合计`。
- 但"让剩余工作量变小"的操作**只改任务、没有同步时段**：
  - `task → completed/cancelled/deleted`：剩余量直接变 0，未完成时段仍在；
  - `task.plannedMinutes` 改小：剩余量变小，已排时段不变；
  - `priorCompletedMinutes` 增加：同上。
- 不一致的数据会让整体校验 `V016` 失败，于是：
  - 预览被拒绝 → **任务删不掉**（删除也要走预览）；
  - 最严重时 `migrateState` 判定"数据无法读取"→ 应用以**空白数据**启动（磁盘数据还在，但用户看不到），
    这正是"任务已经保存却找不到"的原因。

**修复方式**

- 新增 `src/domain/reconcile.js`：把"时段与剩余工作量对齐"收敛成一处**纯函数**。
- `mutations` 在任务状态迁移与任务编辑后**同一次提交里**调用它：
  - 任务完成/取消/删除 → 取消它的全部未完成时段（**已完成的学习记录保留**）；
  - 未完成时段超过剩余工作量 → 按确定顺序（先取消最晚的）取消超出部分。
- 加载旧数据时：只有当错误**全部**属于"可自动修复的数量不一致"才修复，
  修复后必须重新通过完整校验；结构损坏等其它错误仍然如实拒绝。
  修复内容会作为警告告知用户，且原始数据在写入时被轮转到备份槽。
- **导入**外部备份时**不做**自动修复（导入会整体替换数据，宁可拒绝并列出问题）。

### 二、修复：壁纸上传后不显示

**根因**：样式里定义了 `#app-wallpaper`，但页面从未创建这个节点，
`applyWallpaperToDocument` 查不到节点就直接返回——图片保存成功、永远不渲染。

**修复**：需要时由代码自动补建背景层（因此单文件版本同样可用）；
启用壁纸时如果内存里没有图片 URL 会先从 IndexedDB 读回；图片丢失时安全回退为无壁纸。

**同时按需求删除**：背景设置里的「显示方式与文字可读性」整块（填充/适应/居中/平铺、模糊、遮罩）
与「恢复推荐（无模糊、55% 遮罩）」操作。壁纸固定为"填充窗口 + 固定遮罩"，
遮罩是文字可读性的底线，因此写死在样式里、不再开放调节。
偏好里对应字段一并移除（旧数据里残留的字段读取时被忽略）。

### 三、移除：缓冲时间

- 引擎不再预留也不生成缓冲：`bufferRatio` 恒为 0，`buildBufferBlocks` 不再产出任何块。
- 设置里的「机动缓冲比例」、总览行、周视图统计列、预览页缓冲列、版本页缓冲指标、
  每日/今日视图缓冲卡片全部移除。
- **休息（计划休息）不是缓冲**，完整保留；H8 约束改为"休息与学习不重叠"。
- 旧计划里的缓冲块在读取时被移除（纯派生数据，丢弃不影响任务与学习记录），
  每日缓冲统计归零；有专门测试覆盖"旧数据不会崩"。
- 调色板 `--color-buffer` 更名为 `--color-accent`，避免与已移除功能混淆。

### 四、移除：番茄钟

删除：`services/pomodoroTimer.js`、`services/pomodoroService.js`、`ui/pages/focus.js`、
导航与路由入口、固定专注栏、番茄钟设置、计时状态、`focusRecords` 状态容器、
"专注计时结束"通知类型、依赖番茄数据的统计与成就、相关样式与测试。

**保留**：普通学习记录（`sessions`）、任务完成记录、科目分布、每日/每周学习时长、
任务完成率与逾期、连续学习天数、成就（改为基于已完成的学习时段推导）。

### 五、移除：奖励转盘

删除：`services/rewardService.js`、`ui/pages/rewards.js`、路由与导航入口、
转盘逻辑与状态、`rewardHistory` / `rewardLedger` 字段、奖励相关统计与成就、样式与测试。

旧数据里的 `rewardHistory` / `rewardLedger` / `focusRecords` **不会被清除**（只是不再读写），
因此不会因为精简功能而丢用户数据。

### 六、重新设计每日视图

改为「日期为列、任务为内容」的概览：

- 7 个日期列（沿用当前计划窗口，不擅自扩大）；
- 每列显示当天的学习任务与固定任务，用不同颜色标签区分；
- 卡片显示时间、时长、科目/固定标记与状态（待进行/进行中/已完成/已过期/已锁定）；
- 没有具体时间的任务排在同列末尾，**不会隐藏**；
- 排序确定：开始时间 → 学习优先 → 标题 → id，重复渲染顺序不变；
- 不再有整点刻度与时间网格；窄屏横向滚动，卡片不会重叠；
- 点击学习任务打开时段详情；"这七天没有安排到的任务"单列一张卡，附带原因。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 439
ℹ pass 439
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（757 KB，内联 60 个模块）
```

新增测试：

- `tests/integration/consistency.test.js`（11）：用户报告的两条报错、删除已排程/未排程/过期任务、
  改工作量、标记完成、增加已完成时长、多次重排无重复时段、旧数据修复、结构损坏仍拒绝。
- `tests/integration/dayBoard.test.js`（9）：日期列、学习/固定任务、无时间任务、状态区分、
  排序稳定性、隔离已移除功能、真实页面渲染。

### 已知限制

1. 界面自动化测试基于手写打桩 DOM；真实浏览器里的视觉与点击需人工确认（见 `docs/ACCEPTANCE.md`）。
2. 「过度完成」（已完成时长大于预计总用时）在加载旧数据时会把预计总用时**上调**以保留学习记录，
   并在通知中说明；这不是静默修改。
3. 每日视图与七天时间轴是两个视图：前者看"哪天有事"，后者看"几点到几点"，数据同源。
4. 业务数据仍在 localStorage（约 5 MB），接近上限时会提醒导出与清理；壁纸在 IndexedDB。

---

## [1.0.0] — 产品化升级：修复规划主流程、统一设计语言、新增专注/奖励/通知/统计/外观

日期：2025-10-16

### 目标

把项目从"功能可用"升级为**可以日常使用的正式产品**：修好规划主流程与调整预览的实际缺陷、
清掉全部开发痕迹、建立统一设计语言，并补上专注番茄钟、奖励转盘、通知提醒、
学习统计与自定义外观壁纸。

### 一、优先修复：规划主流程与调整预览（最高优先级）

| 缺陷 | 用户看到的现象 | 修复 |
|---|---|---|
| **重新规划被误报为"全部重排"** | 什么都没改，点一次生成计划就看到"取消 2 段 + 新增 2 段"，以为计划被推翻 | 会话身份改为按"任务 + 日期 + 起止时间"匹配：没变化的时段**沿用原 ID 与原记录**，只取消真正被取代的。现在无改动重排显示"2 个时段保持原样" |
| **没有任务时谎报"完整可行"** | 一个任务都没有，却显示"完整可行 + 全部 0"，用户无法理解这一页有什么用 | 引擎明确返回"输入不合法"并提示去新建任务；任务全部完成/取消（合法状态）仍可生成"没有学习安排"的计划 |
| **调整预览没有"无需调整"状态** | 面对一堆 0 值，不知道页面在说什么 | 差异为零时显示「本次无需调整」，并解释"为什么你可能期待看到变化" |
| **"确认应用"是死路** | 点击后只弹对话框，无法理解后续行为 | 对话框改为逐条说明"将新增/移动/取消多少段、哪些记录受保护、有无逾期风险"，失败时明确告知"数据没有被改动" |
| **「确认应用」「放弃修改」按钮调用不存在的方法** | 点击后页面报错，按钮完全无效 | 改为通过 `services.ui.applyPreview()` / `discardPreview()` 调用（新增端到端点击测试专门覆盖这一类问题） |
| **内部枚举与开发文案直接上屏** | 界面上出现 `阶段 1：预览框架已就绪…`、`insufficient_capacity`、`engine@1.0.0`、`输入指纹` | 新增 `src/ui/labels.js` 集中翻译；`formatIssue` 只返回中文消息；删除全部阶段说明 |
| 预览页不是"唯一的确认入口" | 排程入口藏在偏好设置里 | 首页新增"当前计划 / 生成七天计划"卡片（主要入口）、七天计划页、每日视图都能触发 |

### 二、清理开发痕迹

- 删除全部"阶段 N"说明（界面 4 处、注释 19 处）。
- 删除"待接入 / 尚未实现 / 框架已就绪 / 预留位置"等未完成说明。
- 内部标识不再上屏：原因码 → 中文标签；触发来源 → 中文；`引擎版本/输入指纹/快照` → 删除或改为用户语言；
  `formatIssue` 不再输出 `[V001]（字段名）`。
- 校验仍有内部代码信息，但只通过 `formatIssueDebug` 提供给日志与测试。

### 三、统一视觉设计系统

- 新增主题令牌层：浅色 / 深色 / 跟随系统，**全部组件通过语义色变访问**，不只是背景变色。
- 新增组件：统计磁贴、进度条、占比条、柱状图、成就卡、空状态、主题选择卡、专注计时环、奖励转盘。
- 新增页面骨架：首页主视觉 + 两列网格、13 项侧边导航（带图标与快捷键提示）。
- 微动画：卡片悬浮、进度条过渡、转盘旋转，全部在 `prefers-reduced-motion` 下降级为瞬时。
- **响应式**：桌面为"侧栏 + 主区"两列；窄屏（≤900px）改为单列堆叠，导航变成可横向滚动的标签条，
  表格允许横向滚动，操作按钮换行显示。
- 按钮状态：悬停 / 焦点环（`:focus-visible`）/ 禁用 / 加载（重规划时）/ 成功与错误提示。

### 四、新增功能

1. **首页**：今日任务、真实进度、下一项、一键专注、未来七天概览、**规划主入口**。
2. **外观主题**：三种主题 + 自定义壁纸（本地选择、预览、应用、更换、移除、填充/适应/居中/平铺、
   模糊与遮罩调节）。壁纸存 **IndexedDB**（图片经 canvas 压缩到最长边 2560 再存，避免撑爆 localStorage），
   读取失败安全降级；图片**不上传任何服务器**。
3. **通知提醒**：浏览器权限与应用开关分开显示；拒绝/不支持时给出可执行指引；
   4 种提醒类型、提前时间、跨午夜静音时段；**按真实时间戳调度**、持久化去重（刷新不重发）；
   如实说明"页面关闭后无法提醒"。
4. **专注番茄钟 + 固定功能栏**：计时中底部常驻功能栏（暂停/继续/放弃/回到专注页），
   切换页面不必中断；专注/短休息/长休息、开始/暂停/继续/结束/放弃、自定义时长、
   可选自动进入下一阶段、当前任务与进度、本地合成的环境音（不联网）。
   **计时完全基于真实时间戳**：刷新、切标签页、电脑休眠都不会漂移；暂停期间不计入；
   只有真实走完的番茄才计入完成；**一轮番茄不会把任务标记为完成**。
5. **奖励转盘**：自定义奖项（增删改、启用禁用、权重）、四种触发规则（专注分钟/番茄数/时段数/任务数）、
   机会由**真实进度推导并按"已发放次数"扣减**（刷新与重复提交都不会多发）、
   先定结果再算角度（动画必然停在真实结果上）、中奖历史与"确认领取"。
6. **学习统计**：今日/本周/近 14 天、科目分布、任务完成率与逾期、专注轮数（区分完成与提前结束）、
   奖励记录、连续学习天数、**成就（7 项，全部由真实记录推导，未达成也显示当前进度）**。
   存储接近浏览器上限时主动提醒导出与清理。
7. **任务"剩余时长"**：新增"已经完成（分钟）"字段，剩余时长 = 预计总用时 −（手工声明 + 应用内完成记录），
   仍是派生值；表单实时显示剩余；排程只安排剩余部分。
8. **数据维护**：存储占用与浏览器配额显示、接近上限主动提醒、导入两步校验、历史清理入口。

### 五、测试

```
$ node --test "tests/**/*.test.js"
ℹ tests 458
ℹ pass 458
ℹ fail 0

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（824 KB，内联 64 个模块）
```

本阶段新增 76 个测试，覆盖：

- `tests/unit/pomodoroTimer.test.js`（14）：真实时间戳计时、标签页节流、电脑休眠、暂停恢复、
  多轮暂停、刷新恢复、损坏数据降级。
- `tests/integration/productFeatures.test.js`（50）：偏好默认值与损坏回退、主题与壁纸参数保护、
  通知权限三态、去重（含刷新后不重发）、静音时段、开关关闭时不发送、
  番茄钟与任务联动、奖励资格幂等与防重复发奖、统计口径（含"没有数据如实为 0"）、
  剩余时长声明、成就推导、导入导出往返。
- `tests/integration/endToEnd.test.js`（10）：**通过真实点击按钮**走完整流程
  （生成计划→预览→应用→放弃→专注→统计→抽奖→切换主题→专注栏操作），
  导航全入口可达，并审计"每个按钮都绑定了真实行为"。
- `tests/integration/ui-smoke.test.js`：扩展到 13 个页面 + 可访问性 + 键盘操作 + 提示条自动消失。
- `tests/unit/docs.test.js`：新增"主题必须覆盖语义色而不只是背景""必须有窄屏断点""必须有焦点可见性与 sr-only"等断言，
  防止视觉系统在后续改动中退化。

另外新增两个**接口审计**（作为开发工具运行，不属于测试套件）：
扫描界面里调用的服务方法是否真实存在（正是这一步发现了"确认应用"按钮的缺陷），
以及渲染级别的开发文案扫描。

### 六、本阶段修复的缺陷（全部由测试或审计发现）

| 问题 | 影响 | 修复 |
|---|---|---|
| 「确认应用」「放弃修改」调用不存在的服务方法 | 按钮完全无效 | 改为 `services.ui.*`；新增端到端点击测试 |
| 打包器不处理 `export { X as Y }` | 单文件版本启动即报错 | 记录"导出名 → 本地名"并补本地别名 |
| 主题变更触发整页重绘 | 输入内容丢失、动画被打断、异步重绘落到已卸载环境 | 主题只改 DOM 属性，不再重建 DOM |
| `setEnabled` 内部启动 30 秒调度定时器 | 调用方（含测试）被定时器拖住 | 调度只由应用入口管理 |
| 同一时段收到"即将开始"与"计划开始"两条重复提醒 | 提醒噪音 | "计划开始"改为每天一次的今日简报 |
| 异步回调在页面卸载后写 DOM | 未处理的 Promise 拒绝 | 新增 `isNodeLive()` 判断 |
| 测试打桩 DOM `textContent` 不聚合子节点 | 按文案找不到按钮，无法验证点击 | 改为与真实 DOM 一致 |

### 七、已知限制（如实说明）

1. **页面完全关闭后不会发送通知**：需要 Service Worker + HTTPS + 推送服务器，本项目不假装支持。
2. **界面测试基于手写打桩 DOM**：真实浏览器里的 CSS 布局与视觉效果需人工确认
   （`docs/ACCEPTANCE.md` 有逐条步骤）；引入 jsdom 需项目所有者批准，当前保持**零依赖**。
3. 业务数据仍存 localStorage（通常约 5 MB）；接近上限时会主动提醒导出与清理。
   壁纸走 IndexedDB，不受此限制。
4. 时段移动使用表单，不支持拖拽绘制时间块。
5. 固定活动只能按规则编辑，没有"临时调整某一天"的入口。
6. 撤销之后没有"重做"。
7. 环境音为本地合成的噪音，不是真实音频文件。

---

## [0.5.0] — 阶段 5：重复逻辑合并、实时计时、可访问性、交付文档

日期：2025-10-16

### 阶段目标

收尾交付：消除重复实现、让计时真正每秒更新、做一轮可访问性与键盘操作检查、
把文档定稿，并保持全量测试全绿。

### 实际改动

**1. 合并重复逻辑（`services/taskService.js`）**

- 任务服务不再自己拼接新状态：新增 / 编辑 / 状态迁移 / 删除 / 恢复全部改为
  构造 `op` 交给 `domain/mutations.js` 的 `applyDraftOp`，再提交持久化。
- 删除了本层重复的依赖校验与字段白名单逻辑（统一由 mutations 承担）。
- 结果：**"预览草稿"与"直接写入"现在真的走同一段代码**，
  原先 CHANGELOG 里记录的"两处重复逻辑可能漂移"这一风险被消除。

**2. 计时每秒实时更新**

- `src/ui/dom.js`：新增最小心跳调度器（`startTicker` / `stopTicker` / `isTickerRunning`）。
  只允许一个心跳存在；页面切换时自动停止，不会泄漏定时器。
- `src/ui/shell.js`：渲染时先停掉上一个页面的心跳；页面通过 `requestTick()` 声明需要每秒刷新。
- `src/ui/pages/focus.js`：计时进行中注册心跳，倒计时每秒更新；
  暂停或未开始时不注册（避免无意义的整页重绘）。
- 用 `setInterval` 而不是 `requestAnimationFrame`：后者在后台标签页会暂停，倒计时会停住。

**3. 可访问性与键盘操作**

- 时间轴：容器可聚焦（`tabindex="0"`，键盘可滚动），无障碍名称说明天数与刻度；
  每个时段块都是 `<button>` 并带完整无障碍名称（类型｜任务｜时间｜时长｜是否锁定）。
- 计时器：进行中带 `role="timer"` 与 `aria-live="polite"`，屏幕阅读器能听到变化。
- 预览页：加入屏幕阅读器专用的状态提示（"已生成候选计划，等待确认"）。
- 设置页：存储占用的加载状态使用 `aria-live` 播报。
- CSS：新增 `:focus-visible` 焦点环（时段块与时间轴）与 `.sr-only` 工具类。
- **全局键盘快捷键**：`1`–`9` 按导航顺序跳转页面、`g` 生成/重新规划、`?` 显示帮助；
  在输入框 / 下拉框 / 文本域或可编辑元素中一律不拦截。侧边导航项右侧显示对应数字，
  功能可被发现而不是"隐藏彩蛋"。

**4. 交付文档**

- README 增加"常见问题与故障排查"：数据存在哪里、刷新后会不会丢、计时为什么没跳动、
  预览为什么被拒绝、导入被拒怎么办、如何彻底清空数据。
- 文档中的测试数量、文件树与阶段状态全部同步。

**测试（新增 3 个，共 379 个）**

- `tests/integration/ui-smoke.test.js`：
  可访问性测试（时间轴可聚焦、时段块无障碍名称、`role=timer` + `aria-live`、离开页面无残留心跳）、
  键盘操作测试（数字键跳转、输入框内不拦截、`g` 与 `?` 不抛异常）、
  提示条自动消失测试（假定时器 + 到期移除）。
- 打桩 DOM 补齐：`setInterval` / `clearInterval` / `setTimeout` / `clearTimeout` 全部接管，
  并实现了 `#id` / `.class` 的 `querySelector`；同时移除了打桩里重复创建的 `#toast-host`。

### 实现内容（关键行为）

1. **写入路径唯一**：`domain/mutations.js` 是状态变更的唯一实现；
   `taskService`、`planService`（预览与确认）、清理都复用它。
2. **心跳不泄漏**：同一时刻最多一个定时器；离开需要心跳的页面立即停止；
   有自动化测试断言"离开计时页面后定时器数量为 0"。
3. **键盘可用**：不用鼠标也能切换页面、生成计划、浏览时间轴、打开时段详情。
4. **可被发现**：快捷键写在导航项上，并有 `?` 帮助与无障碍名称。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 379
ℹ pass 379
ℹ fail 0
ℹ duration_ms 668

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（605 KB，内联 50 个模块）
```

### 阶段 5 修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 提示条的 9 秒 `setTimeout` 未在测试中接管 | `ui-smoke` 测试跑完后 Node 进程被拖住 9 秒才退出（单文件耗时 9.1 秒） | 测试打桩接管 `setTimeout` / `clearTimeout`，并提供 `flushTimeouts()`；耗时降到 0.15 秒 |
| 测试打桩里重复创建 `#toast-host` | 树里有两个同名元素，"提示条落在哪个容器"的断言测的不是真实位置 | 移除自建容器，统一查询应用真实创建的容器 |
| 打桩 `querySelector` 恒返回 null | 任何依赖选择器查询的行为都无法测试 | 实现 `#id` / `.class` 查询 |
| 测试用 `byClass('timeline__block')` 匹配不到块 | 实际类名带类型修饰（`timeline__block--study`） | 测试改为断言具体类型，类名约定补充到文档 |

### 已知问题与限制

1. **仍然没有真实浏览器/真实 DOM 的自动化测试**：界面测试都基于手写的打桩 DOM，
   CSS 布局、真实点击与滚动行为由 `docs/ACCEPTANCE.md` 的人工步骤覆盖。
   如需引入 jsdom/happy-dom，须先经项目所有者批准（当前保持零依赖）。
2. **`ui-smoke` 的打桩 DOM 是测试资产而非生产代码**：它只实现本项目用到的 DOM 子集，
   新增界面能力时可能需要同步扩展打桩。
3. **不需要（也不打算）引入构建工具**：源码即产物；`dist/standalone.html` 由自写脚本打包。
4. **"重做"（redo）仍然不做**：撤销后可重新生成预览。
5. **固定活动没有"临时调整某一天"的入口**。
6. **清理已取消时段需要用户手动触发**：不做自动清理（历史属于用户数据）。

### 数据格式版本

`schemaVersion = 1`（从阶段 1 到阶段 5 未发生破坏性变更，迁移表为空）。

### 交付状态

阶段 0–5 全部完成。交付物：可在桌面浏览器直接运行的多页面应用、
双击可用的单文件版本、379 个自动化测试、以及完整文档
（`README.md` / `PROJECT_SPEC.md` / `ARCHITECTURE.md` / `CHANGELOG.md` / `docs/ACCEPTANCE.md`）。

---

## [0.4.0] — 阶段 4：学习执行界面、持久化完善、异常处理与清理入口

日期：2025-10-16

### 阶段目标

把"学习执行"做成真正可用的计时循环，把存储异常、导入导出与历史数据清理补完，
并守住一条底线：**记录学习事实**与**改动未来安排**必须是两件事——
前者立即写入，后者一律先生成候选计划预览。

### 实际改动

**变更层（`src/domain/mutations.js`）**

- 新增操作：`session.pause`（暂停/继续，带累计分钟数）、`session.extend`（延长本段）、
  `session.delete`（单条历史清理，已完成记录拒绝删除）、
  `cleanup.cancelledSessions`（清理已取消且从未开始过的时段）、
  `cleanup.planHistory`（只保留最近 N 个版本快照）
- 新增 `evaluateCleanupImpact(state)`：只读计算"能清理什么、能释放多少、哪些受保护"
- `applyDraftOps` 现在会汇总每个操作的统计字段（`removedCount` / `removedMinutes` / `createdIds`），
  服务层因此能向用户报告真实数字

**业务层**

- `src/services/focusService.js`：新增 `pause` / `resume` / `evaluateFinish` / `remainingMinutes`；
  `evaluateFinish` 会算出提前/超时/剩余工作量，并给出**可选处理方式清单**（每条都带说明）
- `src/services/planService.js`：新增 `applyCleanup` 与 `cleanupImpact`（破坏性操作走显式确认）
- `src/services/appState.js`：新增 `previewImport`（校验但不写入）与 `storageUsage`（占用与配额估算）

**界面**

- `src/ui/pages/focus.js`：重写为完整计时工作台 —— 开始 / 暂停 / 继续 / 结束；
  显示剩余时间、已专注时长、任务剩余、锁定状态；结束时弹窗列出分支选项
  （记录实际时长 / 重新规划剩余工作 / 标记任务完成 / 延长本段），
  **只有"只记录实际时长"是立即写入，其余全部先生成预览**
- `src/ui/pages/settings.js`：新增"数据与备份"卡片（存储占用、浏览器配额、上次导出、备份提醒）、
  "清理历史记录"卡片（影响面表格 + 二次确认 + 必须勾选确认）、
  导入改为**先预览摘要与问题、再确认导入**（需勾选"我了解导入会覆盖当前数据"）
- 计时状态持久化：暂停时写入 `elapsedMinutes`，刷新页面后从累计分钟数继续，不会归零

**测试（新增 20 个，共 376 个）**

- `tests/integration/focusAndCleanup.test.js`（19 个）：计时循环与持久化、结束分支、
  清理影响面与受保护记录、导入预览、保存失败不写内存、空数据边界
- `tests/integration/ui-smoke.test.js`：新增工作台计时渲染测试与设置页清理面板断言

### 实现内容（关键行为）

1. **计时只记录事实**：`focusService.start/pause/resume/finish` 都不触碰正式计划；
   测试断言"记录学习后计划版本与任务预计用时都不变"。
2. **结束时的分支可解释**：`evaluateFinish` 返回计划时长、实际时长、差值、任务剩余量，
   以及每个选项的说明；界面把选择权交给用户，不替他决定。
3. **计时可恢复**：暂停写入累计分钟数并持久化；"开始时间 → 现在"只作为推算兜底，
   因此忘记暂停不会少算，刷新也不会归零。
4. **清理安全**：只清理"已取消且从未开始过"的记录与超限快照；
   已完成的学习记录与当前正式计划永远不在清理范围（有测试断言）。
5. **导入两步走**：`previewImport` 只校验与摘要，`importBackup` 才写入；
   校验失败会逐条列出错误，且现有数据一个字节都不变。
6. **异常可读**：保存失败时内存回滚 + 用户可见通知；存储占用与配额在设置页可见。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 376
ℹ pass 376
ℹ fail 0
ℹ duration_ms 432

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（601 KB，内联 50 个模块）
```

**端到端演练（真实执行）**：两个任务 → 应用计划 v2 → 开始计时 → 暂停 12 分钟 → 继续 →
评估结束（计划 60 分钟）→ 记录实际 60 分钟（计划仍为 v2，未被自动改动）→
重新规划并应用 → 清理影响面 7 条 / 390 分钟（已完成 1 条受保护）→ 清理成功 →
导出 → 在空白应用里预览导入（任务 2 / 时段 5，目标仍为空）→ 实际导入成功。

### 阶段 4 修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| `applyDraftOps` 只返回新状态，丢弃每个操作的统计字段 | 清理后界面上显示"已清理 0 条"，与事实不符 | 改为汇总 `removedCount` / `removedMinutes` / `createdIds` |

### 已知问题与限制

1. **计时刷新依赖数据变化重绘**：倒计时不是每秒自动跳动，而是在数据变化或页面切换时更新。
   原因是本项目刻意不引入前端框架，实时每秒重绘需要额外的调度器（见下方"下一步"）。
2. **`domain/mutations.js` 与 `services/taskService.js` 仍有部分重复逻辑**：
   两者校验规则都取自 `domain`，不会不一致，但计划在阶段 5 合并。
3. **重复规划会累积已取消的时段**：现在有了清理入口，但不会自动清理（有意为之）。
4. **固定活动没有"临时调整某一天"的入口**。
5. **界面无真实 DOM 自动化测试**：仍用最小 DOM 打桩。
6. **"重做"（redo）仍不做**：撤销后可重新生成预览。

### 数据格式版本

`schemaVersion = 1`（未发生破坏性变更，迁移表仍为空）。

### 下一步（阶段 5，等待批准后开始）

1. 全量测试与修复：跑通 376 个测试，清理重复逻辑（`taskService` 基于 `mutations` 实现）。
2. 视觉与可访问性检查：对比度、键盘导航、窄屏与空状态逐页过一遍。
3. 计时器的实时刷新：在不引入框架的前提下加一个最小重绘调度器。
4. 交付文档完善：使用说明、故障排查、验收清单定稿。
5. 更新 CHANGELOG 并做最终交付汇报。

---

## [0.3.0] — 阶段 3：界面完善与预览交互闭环

日期：2025-10-16

### 阶段目标

把阶段 2 的引擎与预览闭环**接进完整的界面**：所有数据修改都先变成草稿并生成候选计划预览，
用户确认后才事务式写入；补齐时段交互、固定活动管理、每日视图、图形化偏好设置与窗口滚动。

### 实际改动

**新增：草稿变更层（关键基础设施）**

- `src/domain/mutations.js`：纯函数式状态变更（任务增删改/状态、时段锁定/移动/取消/完成、
  固定活动增删改、设置修改、窗口滚动），返回 `{ ok, state, issues }`。
  同一套逻辑同时服务"预览时的草稿"与"确认时的写入"，避免两条路径行为不一致。

**业务层**

- `src/services/planService.js`：`requestPreview` 支持 `ops`（变更描述）；
  预览携带 `ops` 与变更摘要；`applyPreview` **先重放 ops 再写计划与会话**（同一次提交，失败整体回滚）
- `src/services/fixedActivityService.js`（新增）：固定活动列表、影响面评估（删除能释放多少时间）、
  按日展开、重复规则说明、类型统计

**界面：所有修改改为"先生成预览"**

- `src/ui/forms/taskForm.js`：新建/编辑任务 → `task.add` / `task.update` 预览
- `src/ui/pages/tasks.js`：完成 / 取消 / 恢复 / 删除任务 → `task.status` / `task.delete` 预览
- `src/ui/forms/sessionDetail.js`（新增）：时段详情抽屉 —— 锁定 / 解锁 / 移动（可保持锁定）/
  取消 / 标记完成，全部走预览；锁定时段移动被明确拒绝并解释原因
- `src/ui/forms/fixedActivityForm.js`（新增）：固定活动表单（类型、每周重复或一次性、生效区间）
- `src/ui/pages/activities.js`（新增）：固定活动管理页（按类型筛选、影响面确认、全周占用概览）
- `src/ui/forms/settingsEditors.js`（新增）：图形化偏好设置（可学习时间逐日编辑、排程参数、
  优先级权重、休息规则），保存即生成预览；JSON 编辑降级为"高级"入口
- `src/ui/pages/day.js`（新增）：每日视图（单日时间轴 + 当日容量 + 时段清单 + 当天固定活动）
- `src/ui/pages/versions.js`（新增）：版本历史页（当前版本指标、历史列表、撤销、清空、受保护记录统计）
- `src/ui/pages/week.js`：点击时段打开详情抽屉；新增"计划窗口前移/后移一天"
- `src/ui/router.js`：路由扩到 9 个页面，新增 `currentParams` / `updateParams`
- `src/main.js`：`services.ui` 统一暴露 `previewWith` / `applyPreview` / `discardPreview` /
  `undoLastPlan` / `shiftWindow` / 各表单入口

**引擎修正**

- 窗口之外的已完成/锁定时段现在也会进入候选计划（否则"窗口向后滚动"会让已完成记录从计划中消失）

**打包脚本修正**

- 动态 import 检测改为**先剥离注释**：JSDoc 里的 `{import('./x.js').T}` 是类型注解，不该被拒绝

**测试（新增 20 个，共 356 个）**

- `tests/integration/uiFlow.test.js`（18 个）：草稿事务性（未确认前数据不变 / 确认后任务与计划一起生效）、
  任务增删改与依赖校验、时段锁定/移动/取消/完成与"已完成不可篡改"、固定活动增删与容量影响、
  设置修改、窗口滚动（含已完成记录保留）
- `tests/integration/ui-smoke.test.js`：扩展到 9 个页面、每日视图刻度、设置图形化编辑区、
  预览页差异渲染

### 实现内容（关键行为）

1. **单一路径写入**：界面不再有"直接改数据"的入口。任何修改都是
   `ops → 草稿 → 引擎求解 → 差异预览 → 用户确认 → 一次提交（数据 + 计划）`。
2. **确认即原子**：`applyPreview` 先重放 ops 得到新状态，再在同一 `commit` 里写入
   `sessions`、`officialPlan`、版本快照与 `meta`；任一步失败整体回滚，不留半应用状态。
3. **放弃零副作用**：只清空 `pendingPreview`，业务数据逐字段不变（有测试断言）。
4. **已完成记录不可篡改**：不能取消、不能移动；窗口滚动后仍保留在计划中。
5. **锁定时段是硬约束**：界面移动前会解释原因；引擎侧锁定块进入保留集合，不被移动/缩短/拆分。
6. **每日视图与七天视图同源**：都读 `officialPlan.blocks`，不会出现两份互相矛盾的日程。
7. **窗口滚动**：改变的是"在哪个七天窗口上求解"，已完成历史保留，新窗口重新规划。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 356
ℹ pass 356
ℹ fail 0
ℹ duration_ms 420

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（567 KB，内联 50 个模块）

$ node scripts/serve.mjs 4205   # 逐个模块通过 HTTP 加载校验（已停止）
通过 HTTP 校验的模块数: 50
所有模块与样式均可通过服务器加载 ✓
```

### 阶段 3 修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 窗口之外的已完成时段不进入候选计划 | 窗口滚动会让已完成的学习记录从计划中消失（H9） | 引擎把窗口外的已完成/锁定时段也放入候选计划（不参与容量计算） |
| 已被取代/取消的时段在应用后被丢弃 | 历史记录丢失 | `buildSessionPlan` 明确保留已取消的时段记录 |
| 测试装配缺少 `fixedActivityService` | 界面业务流测试无法运行 | 补齐服务装配 |
| 打包脚本把 JSDoc 类型注解当成动态 import | 单文件构建直接失败 | 检测前先剥离注释 |
| 会话快照在重放变更**之前**构造 | 确认"新增任务"的预览后，写入的时段引用了草稿里的临时任务 ID，下一次预览被"时段引用了不存在的任务"拦下 | 改为在重放变更之后构造会话快照，并把候选计划里的草稿任务 ID 按顺序改写为真实 ID（含回归测试） |

### 已知问题与限制

1. **重复规划会累积"已取消"的时段记录**：每次重排都把被替代的时段标记为 `cancelled` 并保留历史
   （这是有意的——不静默丢弃记录）。反复重排会让时段数量持续增长，长期使用需要清理入口（阶段 4 处理）。
2. **`domain/mutations.js` 与 `services/taskService.js` 存在部分重复逻辑**：
   前者服务"预览草稿"，后者服务"直接写入"（测试与内部调用仍在使用）。
   两者的校验规则都取自 `domain`，因此不会出现规则不一致；但为避免长期漂移，
   计划在阶段 4 把 `taskService` 改为在 `mutations` 之上实现。
3. **时段移动使用表单而不是拖拽**：拖拽绘制时间块仍在"第一版不做"清单里（`PROJECT_SPEC.md` 第 5 节）。
4. **固定活动没有"临时调整某一天"的入口**：只能编辑整条规则；单日临时变动可用"取消该时段 + 重新规划"绕过。
5. **界面无真实 DOM 自动化测试**：仍用最小 DOM 打桩验证"渲染不抛异常 + 关键内容存在"，
   CSS 布局与真实点击由 `docs/ACCEPTANCE.md` 的人工步骤覆盖。
6. **专注工作台计时循环**仍是最小实现（阶段 4 完善暂停/继续与超时分支）。

### 数据格式版本

`schemaVersion = 1`（未发生破坏性变更，迁移表仍为空）。

### 下一步（阶段 4，等待批准后开始）

1. 数据持久化完善：存储容量提示、历史清理、导入导出体验、迁移演练。
2. 学习执行工作台：开始/暂停/继续/结束的完整计时循环、实际时长记录、提前完成与超时分支。
3. 异常处理：存储失败、数据损坏、引擎失败的用户可理解提示与恢复路径。
4. 撤销与版本控制的界面完善（撤销后重做？当前明确不做）。
5. 全量回归（356 个测试保持全绿），更新文档与 CHANGELOG。

---

## [0.2.0] — 阶段 2：无 AI 排程引擎、跨日任务、锁定机制、冲突检测与自动化测试

日期：2025-10-16

### 阶段目标

实现 `src/engine/`：可测试、可重复运行的确定性排程引擎（十步流程），
把"任务 + 固定活动 + 可用时间 + 偏好"变成未来七天的学习计划；
并把"候选计划 → 差异预览 → 用户确认 → 事务式写入"的完整闭环接到业务层与界面上。

### 实际改动

**新增 `src/engine/`（10 个模块）**

- `versionHash.js`：FNV-1a 稳定哈希、稳定序列化、输入指纹、策略指纹、确定性派生时段/块 ID
- `policy.js`：策略参数集中管理（权重、缓冲、休息、时长限制、每日上限）、原因码与诊断码枚举
- `priority.js`：截止紧迫度（0–100）、1–5 评分映射、加权优先级、复合排序键（截止 → 评分 → ID）
- `capacity.js`：允许窗口规范化（含跨午夜）、区间相减、逐日净容量与 10% 缓冲、空闲槽位工具
- `splitter.js`：可拆分任务的均匀切分与尾差处理、不可拆分任务保护、片段数安全上界
- `placer.js`：候选槽评分（偏好时段 / 同科目连续 / 槽位贴合 / 紧凑）、确定性平局裁决、休息插入、依赖门控
- `constraints.js`：硬约束校验器 **H1–H10**，含受保护时段保留检查与可读违规说明
- `diff.js`：计划差异（新增 / 移动 / 时长变化 / 拆分 / 取消 / 保持不变 / 锁定影响 / 每日指标变化）
- `risk.js`：只读模拟"最早完成时刻"，30 天窗口内的风险等级（on_time / tight / at_risk / impossible）
- `scheduler.js`：十步流程编排、可行性状态判定、未安排原因与建议、局部优化（有界、可回退）

**业务层**

- `services/planService.js`：新增 `requestPreview` / `applyPreview` / `discardPreview` / `currentRisks`；
  应用时执行"版本 + 实时输入指纹"双重过期检测，并事务式同步 `sessions`（受保护时段原样保留，
  被替代的旧时段标记为 `cancelled` 而不是物理删除）；新增 `computeLiveInputHash`（复用引擎的指纹实现）
- `src/main.js`：`services.ui.requestPreview` / `undoLastPlan` 入口

**界面（阶段 2 的必要接线，完整交互仍在阶段 3）**

- 今日总览与七天计划页新增"生成计划 / 重新规划"按钮，直接调用引擎并跳到预览页
- 调整预览页渲染完整差异：新增 / 移动 / 时长调整 / 拆分 / 取消 / 锁定影响 / 每日指标变化表 / 风险清单
- 任务表单：不可拆分任务的时长字段自动对齐（阶段 1 已有，本阶段验证）

**测试（新增 8 个文件，共 338 个测试）**

- `tests/helpers/engine.js`：引擎测试装配（共享 ID 工厂保证"同一输入"可复现）
- `tests/engine/scheduler.test.js`：验收场景 1–10、17、18（29 个用例）
- `tests/engine/priority.test.js`：评分公式与权重归一化（8 个）
- `tests/engine/splitter.test.js`：拆分与尾差（13 个）
- `tests/engine/constraints.test.js`：H1–H10 负向测试（17 个）
- `tests/engine/diff.test.js`：差异分类完整性（12 个）
- `tests/engine/risk.test.js`：风险评估（12 个）
- `tests/engine/capacity.test.js`：容量、跨午夜窗口与输入指纹（20 个）
- `tests/integration/previewFlow.test.js`：预览闭环（13 个）
- `tests/integration/standaloneRun.test.js`：真正执行单文件构建产物（1 个）

### 实现内容（关键行为）

1. **确定性**：引擎不读系统时钟、不读随机数、不访问 DOM/存储；所有派生 ID 由输入指纹推导。
   相同输入连续运行三次，计划逐字节相同（验收场景 17）。
2. **硬约束优先**：任何排程结果在交付前都必须通过 H1–H10 校验；违规时返回
   `invalid_input` + 具体违规说明，绝不把违反约束的计划当成可用结果。
3. **不生成假计划**：容量不足时如实报告 `partially_feasible` / `infeasible`，
   每个未安排任务都带原因码、中文说明与可选处理建议；不通过取消缓冲来掩盖超载。
4. **跨日与锁定**：跨午夜窗口被正确拆到两天；锁定/已完成时段进入保留集合，
   参与容量计算且不会被移动、缩短或拆分；它们占用的工作量会从"剩余工作量"中扣除，不会重复安排。
5. **依赖门控**：前置任务未完成时后继任务不参与排位；依赖链按深度优先排序，
   保证同一天内也满足"前置先做、后继后做"。
6. **休息与缓冲分离**：机动缓冲是按 `floor(净容量 × 10%)` 计算的额度（逐日、不跨日挪用），
   计划休息是实际插入时间轴的块；两者统计分开、区间不重叠（H8）。
7. **预览事务性**：预览只是草稿（`pendingPreview`），不碰正式计划；
   应用时校验"基础版本 + 实时输入指纹"，过期即拒绝；放弃时业务数据零改动。
8. **风险可解释**：每个未完成任务给出风险等级、计划/最早完成时刻与富余时间，
   模拟口径与主排程完全一致（同一套容量与缓冲计算），不会出现"面板说来得及、计划却排不下"。

### 测试结果（真实执行）

```
$ node --test "tests/**/*.test.js"
ℹ tests 338
ℹ pass 338
ℹ fail 0
ℹ duration_ms 690

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（475 KB，内联 42 个模块）

$ node scripts/serve.mjs 4201   # 实测（已停止）
GET /                          → HTTP 200 1567B
GET /src/engine/scheduler.js   → HTTP 200 43121B
GET /src/services/planService.js → HTTP 200 26480B
```

新增覆盖：确定性（同输入三次逐字节一致）、容量不足的部分可行与原因码、大任务跨天拆分守恒、
不可拆分任务拒绝拆分、固定活动不被侵占、锁定/已完成不受影响、休息与缓冲不重叠、
依赖顺序与不可达依赖、已完成工作不重复安排、差异分类完整、预览过期拒绝应用、
受保护时段保留、单文件产物真正可执行。

### 阶段 2 修复的问题（由测试发现）

| 问题 | 影响 | 修复 |
|---|---|---|
| 片段队列未消耗 | 同一个片段在七天里被反复排入，计划严重重复 | 放置后出队，并在每次放置后重算候选集合 |
| 休息块被当成学习块 | 学习时长翻倍、触发 H2 误报 | 组装块时过滤 `kind`，休息块原样保留 |
| 学习片段 ID 用数组长度作序号 | 同一任务的多个片段拿到相同 ID，被判定为"两个重叠时段" | 改为按任务独立计数 |
| 局部优化未把休息块算作占用 | 向前压缩会把学习片段挪到休息上（休息 17:00–17:10 与学习 17:00–17:45 重叠），应用预览被拒绝 | 占用集合加入同日休息块，并新增"重叠消解"收尾步骤（休息可顺延/省略，学习块保留原位置交给校验器报告） |
| 局部优化只把保留时段当作占用 | 会把片段挪进上课时间，产生 H1 违规 | 占用集合改为"保留时段 + 固定活动" |
| 依赖顺序只在排序里体现 | 同一天内可能出现后继任务排在前置任务之前 | 增加依赖门控：前置未放完则后继不进候选 |
| 依赖检查只看已遍历片段 | 前置任务片段排在遍历后面时漏检 | 依赖检查针对全部学习片段 |
| 保留时段的已占用工作量未扣除 | 会把同一份工作排两遍（总时长超出任务预计用时） | 从剩余工作量中减去保留（锁定/进行中）时段的分钟数 |
| 输入指纹包含 `session.id` | 形成循环依赖：新增锁定时段会让所有派生 ID 变化 | 指纹改用位置与状态标识时段，不包含 ID |
| 风险模拟未扣除缓冲 | 风险面板比实际计划乐观 | 模拟只使用 `schedulableMinutes`（与主排程同口径） |
| 过期检测只比较 `officialPlan.inputHash` | 用户在预览后改了任务但没重新生成计划时，旧预览仍可应用 | 增加"实时输入指纹"校验（复用引擎的指纹函数） |
| 内联打包脚本用 `^` 未带 `m` 标志收集导出名 | 单文件版本所有模块导出为空，双击打开即报错 | 修正为逐行匹配，并新增"真正执行构建产物"的测试 |
| 内联打包脚本不支持 `import * as` / `export async function` | 前者直接报错，后者把导出名解析成 `function` | 显式支持命名空间导入与 async 导出；不支持的语法改为明确报错 |
| 单文件构建把源码拼在一个作用域 | 同名顶层声明（如 `computeDayCapacity`）冲突 | 改为模块注册表 + 每模块 IIFE，隔离作用域 |
| `graph.js` 使用命名空间导入规避循环依赖 | 属于不必要的绕路，打包器也被迫支持额外语法 | 改为直接静态导入 |

### 已知问题与限制

1. **界面交互仍是阶段 2 的最小接线**：预览页能显示完整差异并确认/放弃，但
   新增任务表单内的"先预览再保存"、时段拖拽/锁定按钮、偏好设置图形化编辑在阶段 3 完成。
2. **固定活动没有界面入口**：模型、校验、展开与排程已完整支持；管理页面在阶段 3 补齐。
3. **局部优化是局部改进**：只做"向前压缩"一类确定性移动，有上界、可回退，
   **不宣称全局最优**（文档与界面文案都保持这一表述）。
4. **窗口滚动（每日向未来推移）尚未接线**：引擎支持任意窗口，界面按钮在阶段 3 提供。
5. **专注工作台的计时循环**仍是阶段 1 的最小实现（阶段 4 完善暂停/继续与超时分支）。
6. **界面无 DOM 自动化测试**：使用最小 DOM 打桩验证"渲染不抛异常 + 关键内容存在"，
   CSS 布局与真实点击由 `docs/ACCEPTANCE.md` 的人工步骤覆盖。

### 数据格式版本

`schemaVersion = 1`（未发生破坏性变更，迁移表仍为空）。

### 下一步（阶段 3，等待批准后开始）

1. 任务表单与偏好设置改为"先生成候选计划预览、确认后再写入"。
2. 时段的锁定/解锁/移动交互，以及固定活动管理页面。
3. 每日视图（单日时间轴）与七天视图共用同一份计划数据。
4. 窗口滚动（保留历史 + 重新规划未来七天）。
5. 运行全量回归（338 个测试必须保持全绿），更新文档与 CHANGELOG。

---

## [0.1.0] — 阶段 1：基础项目、核心数据模型、基础校验逻辑与项目文档

日期：2025-10-16

### 阶段目标

搭好可长期维护的地基：目录分层、数据模型、校验规则、本地持久化接口、可运行界面骨架与测试体系。
**本阶段不实现排程引擎**，也不生成任何自动安排。

### 实际改动（新增文件）

**配置与入口**

- `package.json`（零依赖，仅脚本定义）
- `.gitignore`
- `index.html`（语义化骨架 + 无脚本提示）

**领域层 `src/domain/`（10 个模块）**

- `time.js`：日期/时刻运算唯一入口；跨午夜切分、业务日边界（默认 04:00）、时长格式化、
  墙钟 ↔ 时间戳换算（显式偏移）
- `ids.js`：可注入时钟与随机数的 ID 工厂（前缀 + 时间戳 + 计数 + 种子随机）
- `validation.js`：校验问题结构、`V0xx` 错误码、基础断言工具
- `task.js`：任务模型、剩余工作量推导、状态机、字段白名单修改、依赖候选检测
- `session.js`：学习时段模型、`locked` 语义、生命周期状态机、重叠判定、业务日归属
- `fixedActivity.js`：固定活动模型与校验、按日期展开、区间合并（重叠只扣一次）
- `calendarBlock.js`：统一时间轴视图模型与每日统计、重叠检测
- `plan.js`：计划结构、每日容量与缓冲计算、空闲区间、计划指标、版本快照
- `graph.js`：依赖图环检测（三色标记）与拓扑序（Kahn + 确定性排序）
- `schemas.js`：默认设置、空状态、整体数据校验、状态摘要

**存储层 `src/storage/`（5 个模块）**

- `storagePort.js`：存储接口约定与错误码（配额/不可用/损坏等）
- `localStorageAdapter.js`：写入前轮转备份、异常映射、已用空间估算
- `memoryAdapter.js`：内存实现 + 共享加载逻辑（损坏回退备份）
- `migrations.js`：迁移链骨架、缺字段补默认值、拒绝更高版本
- `backup.js`：导出对象、导入严格校验（必需字段 + 结构 + 语义）、备份提醒

**服务层 `src/services/`（4 个模块）**

- `appState.js`：唯一数据根、发布订阅、原子持久化（失败回滚）
- `taskService.js`：任务 CRUD、影响面评估、软删除与恢复
- `planService.js`：计划应用、版本链、撤销、预览过期检测（版本 + 输入指纹）
- `focusService.js`：开始/结束学习、实际时长记录、单段进行中约束

**界面层 `src/ui/`**

- `shell.js`、`router.js`、`dom.js`、`components.js`、`modal.js`
- `pages/`：`today.js`、`week.js`、`tasks.js`、`preview.js`、`settings.js`、`focus.js`、`taskForm.js`
- `styles/`：`tokens.css`、`base.css`、`components.css`

**脚本 `scripts/`**

- `serve.mjs`：零依赖本地静态服务器（仅监听 127.0.0.1，含路径穿越防护）
- `build-standalone.mjs`：拓扑排序 + 内联，生成可双击打开的 `dist/standalone.html`

**文档**

- `README.md`、`PROJECT_SPEC.md`、`ARCHITECTURE.md`、`CHANGELOG.md`、`docs/ACCEPTANCE.md`

**测试 `tests/`（20 个测试文件）**

- `helpers/`：`clock.js`（固定时钟与 ID 工厂）、`fixtures.js`（样本实体）、`app.js`（完整应用装配）
- `unit/`：`time`、`ids`、`validation`、`task`、`session`、`fixedActivity`、`calendarBlock`、`graph`、
  `plan`、`schemas`、`storage`、`docs`
- `integration/`：`appState`、`taskService`、`planService`、`lifecycle`、`ui-smoke`、`scripts``

### 实现内容（已具备的行为）

1. **数据模型完整**：任务、学习时段、固定活动、日历块、计划、版本快照、预览结构均已定型，
   并通过运行时校验（结构 + 语义 + 跨实体引用 + 依赖图）。
2. **剩余工作量唯一口径**：`plannedMinutes − 已完成（优先实际时长）`，不单独存储剩余字段，
   从结构上消除"计划一改数字就漂移"的问题。
3. **硬约束的数据基础**：已完成/锁定/进行中时段进入保留集合；容量计算扣除固定活动与保留时段并做区间合并，
   保证不会被重复扣减；缓冲（逐日 10%）与计划休息分属不同 `kind`，统计分开、区间不重叠。
4. **时间处理正确**：跨午夜时段切分到天（23:30–07:00 → 两段）、业务日边界 04:00、日期运算绕开 UTC 陷阱。
5. **持久化安全**：写入前备份；主数据损坏时从备份恢复；保存失败回滚内存；
   结构版本迁移骨架；导入严格校验且失败时零改动。
6. **计划版本与撤销**：版本号单调递增（撤销也递增，不复用旧号），历史快照上限可配；
   撤销会导致新的已完成记录消失时被拒绝。
7. **预览过期检测**：应用候选计划时校验基础版本与输入指纹，不匹配即拒绝并提示重新生成。
8. **界面可运行**：六个页面路由、小时刻度时间轴、任务新建/编辑表单、危险操作二次确认
   （含真实影响面数字）、空状态/错误状态/无可行计划状态、键盘可达（跳转链接、焦点样式、`<dialog>` 焦点管理）。
9. **单文件交付**：`node scripts/build-standalone.mjs` 生成 287 KB 的 `dist/standalone.html`，
   可双击直接用，且构建脚本会在残留动态导入或外部依赖时明确报错。
10. **界面启动有自动化冒烟测试**：`tests/integration/ui-smoke.test.js` 用最小 DOM 打桩让
    `src/main.js` 的浏览器分支真正跑起来，验证外壳渲染、六条路由逐一渲染不抛异常、
    未知路由给出明确提示、时间轴 7 个日期表头与 18 个整点刻度、空数据时各页有空状态。
    这个测试在本阶段抓出了三个真实缺陷（见下方"阶段 1 修复的问题"）。

### 测试结果（真实执行）

命令与结果（Node v24.21.0）：

```
$ node --test "tests/**/*.test.js"
ℹ tests 210
ℹ pass 210
ℹ fail 0
ℹ duration_ms 429

$ node scripts/build-standalone.mjs
已生成 dist/standalone.html（287 KB，内联 32 个模块）
```

测试覆盖的要点：

- 时间：日期合法性（含闰年）、星期 ISO 约定、跨午夜切分、业务日边界、墙钟 ↔ 时间戳可逆
- 任务：必填/范围/枚举校验、不可拆分任务的时长对齐、依赖自引用与重复、剩余工作量推导、状态机
- 时段：时长与起止一致性、进行中自动锁定、已完成终态、锁定/已完成不可移动、跨夜重叠判定
- 固定活动：每周/一次性重复、跨午夜展开（含窗口首日取到前一日凌晨段）、重叠合并只扣一次
- 容量：净容量与 10% 缓冲、重叠固定活动只扣一次、锁定/已完成单独记账、空窗口为 0
- 计划：七天窗口、每日统计、指标累加、结构与天数校验、版本快照
- 图：环检测、拓扑序确定性、悬空/自引用/环的错误码
- 存储：保存/加载/备份轮转、损坏回退备份、迁移拒绝更高版本、配额失败时旧数据完好、
  导入 5 类错误数据全部被拒绝且现有数据不变
- 服务：非法输入不写库、删除影响面、软删除保留历史、取消任务保留已完成记录、
  预览过期拒绝应用、撤销版本号递增、撤销保护新完成记录
- 端到端：新用户 → 创建任务 → 刷新仍在；完成一段学习后剩余量正确；同一时间只允许一段进行中；
  导出 → 导入往返；空数据下所有服务可安全调用；9 类破坏性输入全部被拒绝且无残留数据
- 界面冒烟：外壳与六条路由渲染、未知路由提示、时间轴刻度数量、空状态存在性
- 文档：必需文件齐备、零依赖（源码出现外部导入即失败）、README 命令与实际一致

### 阶段 1 修复的问题（开发过程中由测试发现）

| 问题 | 影响 | 修复 |
|---|---|---|
| 星期计算偏移错误（`(ordinal + 3) % 7`） | 所有"按星期配置"的可学习时间与固定活动都会错位一天 | 改为 `(ordinal + 4) % 7`（1970-01-01 是周四），并加测试锁定 |
| `splitOvernightSpan` 返回跨日累加偏移 | 跨午夜时段在"下一天"的分钟数会变成 1440+，按天渲染与统计全部错位 | 每段统一换算为**该段自己日期内**的分钟数（0–1440） |
| `expandFixedActivities` 过滤条件用错日期 | 窗口首日取不到"前一晚延续来的凌晨时段"，可用容量被高估 | 改为按**片段自身日期**过滤，并补测试 |
| `sessionsOverlap` 两个时段分别以对方日期为基准 | 跨午夜时段与次日时段的判断自相矛盾（23:30–00:30 与次日 00:00–01:00 被判为不重叠） | 统一到同一基准日坐标比较，并按整体平移（含时长）计算 |
| `spanToMinutes` 不识别 `{startMinutes, endMinutes}` 形式 | 数值形式的时段解析直接抛异常 | 增加数值分支 |
| 页面渲染上下文缺少 `services` 注入 | 六个页面全部无法渲染（外壳渲染失败） | `shell.js` 接收并下发 `services` / `now`，页面改成从上下文取 |
| 未知路由被静默当作首页 | 用户访问错误地址时看不到任何提示，以为自己点错 | 路由返回 `unknownPath`，外壳显示"页面不存在"并提供回到首页按钮 |
| `components.js` 相对路径多了一级（`../../domain/...`） | 单文件构建报"找不到模块"；浏览器里同样会 404 | 修正为 `../domain/...` |
| 内联打包脚本变量作用域错误（`specifier` 未定义） | 单文件构建直接崩溃 | 修正；并改用 `dirname(fileURLToPath(...))` 计算项目根目录 |
| `ui/dom.js` 的 `import('./dom.js')` 动态导入 | 单文件内联无法支持动态导入 | 改为静态导入 |
| 依赖 JSDoc 里的 `import('...')` 类型写法 | 被内联脚本的动态导入检测误判 | 改为普通 `object` 注释，避免类型注解影响打包 |
| 计划历史条目的变更说明错位 | 版本历史会显示"后一次操作"的说明 | 快照改用产生该计划的那次变更摘要（`meta.lastPlanMutation`） |
| 任务校验不做真实日历校验 | `2025-02-30`、`25:99` 这类输入会被写入数据 | `validateTask` 增加 `isValidDateString` / `isValidTimeString` 检查 |
| 服务层对非对象输入抛异常 | 界面误传 `null` 会导致页面报错 | `addTask` / `updateTask` 增加防御性类型检查，返回结构化错误 |
| 测试 ID 工厂每次返回相同 ID | 同一测试文件内不同应用实例产生 ID 碰撞，出现假故障 | 递增种子，保证实例间 ID 唯一 |

### 已知问题与限制

1. **排程引擎尚未实现**（阶段 2）：不会自动生成七天安排；`planService` 目前只接受"已经算好的"计划。
2. **预览闭环未接入界面**（阶段 3）：任务的新增/修改目前**立即生效**，尚未走"候选计划 → 差异预览 → 确认应用"。
   界面上已有明确提示，避免用户误以为已经过确认。
3. **界面无 DOM 级自动化测试**：未安装 jsdom 等依赖（依赖政策）。DOM 行为由 `docs/ACCEPTANCE.md`
   的人工验收步骤覆盖，自动化测试覆盖的是服务层与端到端链路。
4. **专注工作台是最小实现**：可以开始/结束并记录实际时长，但暂停/继续、实时倒计时、
   提前完成/超时的分支处理在阶段 4 完善。
5. **偏好设置暂用 JSON 编辑区**：已做校验与失败保护，逐项图形化控件在阶段 3 提供。
6. **固定活动暂无界面管理入口**：模型、校验与展开逻辑已完成，页面入口在阶段 3 补齐。
7. **未实现"重做"（redo）**：撤销后如需重排，重新生成预览即可（见 `PROJECT_SPEC.md` 第 5 节）。
8. **未实现跨窗口自动顺延**：窗口滚动需要用户确认候选计划（阶段 3），不会自动改动未完成时段。

### 数据格式版本

`schemaVersion = 1`（与阶段 0 方案一致，未发生破坏性变更，因此迁移表为空）。

### 下一步（阶段 2，等待批准后开始）

1. 新增 `src/engine/`：`policy`、`priority`、`capacity`、`splitter`、`placer`、`constraints`、
   `diff`、`risk`、`scheduler`、`versionHash`。
2. 实现十步排程流程与硬约束校验器 H1–H10，配套**负向测试**（含"构造违反约束的计划，断言校验器报错"）。
3. 实现差异计算与未安排原因码（含建议处理方式）。
4. 为验收用例 1–10、17、18 补齐引擎级自动化测试。
5. 运行全量回归（现有 210 个测试必须保持全绿），更新文档与 CHANGELOG。
