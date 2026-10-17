# 架构说明（ARCHITECTURE）

> 本文件说明代码怎么分层、数据怎么流动、每个模块负责什么。
> 修改目录结构或引入新层之前，请先更新本文件并说明原因。

---

## 1. 分层与依赖方向

```
                    ┌──────────────────────────────┐
                    │  ui/  （页面、组件、样式）      │
                    └──────────────┬───────────────┘
                                   │ 只调用 services
                    ┌──────────────▼───────────────┐
                    │  services/ （业务流程、写入收口）│
                    └───────┬──────────────┬───────┘
                            │              │
        ┌───────────────────▼───┐   ┌──────▼─────────────────┐
        │  engine/ （排程算法）   │   │  storage/ （持久化）     │
        │  ← 阶段 2 实现          │   └──────┬─────────────────┘
        └───────────┬───────────┘          │
                    │                      │
                ┌───▼──────────────────────▼───┐
                │  domain/ （数据模型与纯规则）   │
                └──────────────────────────────┘
```

### 依赖规则

1. **`domain/` 不依赖任何其它层**：没有 DOM、没有 `localStorage`、没有 `Date.now()`、没有随机数、没有网络。
2. **`engine/` 只依赖 `domain/`**：必须是纯函数库，同样的输入必然得到逐字节相同的输出（阶段 2 落地）。
   引擎不得 import `ui/`、`storage/`、`services/`。
3. **`storage/` 只依赖 `domain/`**：不认识业务概念，只负责"把状态存进去、读出来、迁移、校验"。
4. **`services/` 依赖 `domain/` 与 `storage/`**：所有写入都必须经过服务层，界面不得直接改状态。
5. **`ui/` 依赖 `services/`（并读取 `domain/` 的纯数据模型与格式化函数）**：
   界面不做业务判断，不直接访问存储，不自己实现排程规则。

> **关于 `ui/ → domain/` 的直接引用**：这是**有意的例外**，仅限两类内容：
> ① 纯数据常量与状态枚举（如 `TASK_STATUS`、`SESSION_STATE`、`PLAN_STATUS`）；
> ② 纯格式化函数（如 `formatDuration`、`formatMinutes`、`weekday`）。
> 这些内容没有副作用、不需要持久化协调，包一层服务反而增加噪音。
> **禁止**界面直接调用会改变数据的领域函数（状态迁移、校验器等）——那些必须经过 `services/`。
> 该例外由 `tests/unit/docs.test.js` 与代码评审共同守护。

---

## 2. 目录与模块职责

### 2.1 `src/domain/` —— 数据模型与纯规则

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `time.js` | **唯一**允许做日期/时刻运算的模块：日期字符串、分钟数、跨午夜切分、业务日边界、时长格式化 | 禁止在其它模块写 `new Date('YYYY-MM-DD')`（会被当作 UTC 解析，东八区偏移一天） |
| `ids.js` | ID 生成（前缀 + 时间戳 + 计数 + 种子随机） | 支持注入时钟与随机数，保证测试可复现 |
| `validation.js` | 校验问题结构（`severity/code/path/message/details`）、`V0xx` 错误码、基础断言工具 | 不使用异常做常规控制流；问题必须结构化 |
| `task.js` | 任务模型、剩余工作量推导、状态机、字段白名单修改 | `remainingMinutes` 是**推导值**，不单独存储 |
| `session.js` | 学习时段模型、`locked` 语义、生命周期状态机、重叠判定 | 已完成是终态；进行中自动锁定 |
| `fixedActivity.js` | 固定活动模型与规则校验、展开为具体日期的时间块、区间合并 | 跨夜活动切分后，按**片段自身日期**归属 |
| `calendarBlock.js` | 统一时间轴视图模型（学习/固定/休息/缓冲四类）与每日统计 | 每日视图与七天视图共享同一份块集合 |
| `plan.js` | 计划结构、每日容量与缓冲计算、空闲区间、计划指标、版本快照 | 缓冲与休息分开统计，逐日 10% 不跨日挪用 |
| `graph.js` | 任务依赖图：环检测（三色标记）、拓扑序（Kahn + 确定性排序） | 界面选择前置任务时复用同一实现 |
| `schemas.js` | 默认设置、空状态、整体数据校验、状态摘要 | 数据契约的集中位置；版本号在此定义 |

### 2.2 `src/engine/` —— 排程引擎（阶段 2 已实现）

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `policy.js` | 全部可调参数与默认值（权重、缓冲比例、休息规则、时长限制、每日上限）、原因码与诊断码枚举 | 阈值只在这里定义；非法值被夹到安全范围 |
| `versionHash.js` | FNV-1a 稳定哈希、输入指纹、策略指纹、确定性派生时段/块 ID | 指纹只包含"会影响排程结果"的字段；不包含实体 ID（避免循环依赖） |
| `priority.js` | 截止紧迫度（0–100）、1–5 评分映射、加权优先级、复合排序键 | 评分**只影响排序与放位偏好**，不参与硬约束判定 |
| `capacity.js` | 允许窗口规范化（含跨午夜）、区间相减、逐日净容量与 10% 缓冲、空闲槽位工具 | 重叠占用只扣一次；缓冲逐日计算、不跨日挪用 |
| `splitter.js` | 可拆分任务均匀切分与尾差处理、不可拆分任务保护、片段数上界 | 绝不产生非法片段；尾差排不下就如实报告 |
| `placer.js` | 槽位评分（偏好时段 / 同科目连续 / 槽位贴合 / 紧凑）、确定性平局裁决、休息插入、依赖门控 | 每次放置后重算空闲区间；前置未放完则后继不进候选 |
| `constraints.js` | 硬约束校验器 **H1–H10**、受保护时段保留检查、可读违规说明 | 与算法分离；有负向测试防止校验器失效 |
| `diff.js` | 计划差异（新增 / 移动 / 时长变化 / 拆分 / 取消 / 保持不变 / 锁定影响 / 每日指标变化） | 受保护时段绝不出现在"取消"里；结果稳定可断言 |
| `risk.js` | 只读模拟"最早完成时刻"、30 天窗口风险等级 | 模拟口径与主排程一致（同样扣除缓冲） |
| `scheduler.js` | 十步流程编排、可行性状态、未安排原因与建议、有界局部优化 | 纯函数；约束违规即拒绝出计划；不宣称全局最优 |

**引擎契约（必须遵守）**

```js
/**
 * @param {object} input
 * @param {object} input.state 完整应用状态（tasks / sessions / fixedActivities / settings）
 * @param {{date: string, minutes: number}} input.now 当前本地墙上时间（显式传入）
 * @param {string} [input.windowStart] 窗口起始日（默认 = now.date）
 * @param {number} [input.windowDays] 窗口天数（默认 7）
 * @param {object|null} [input.existingPlan] 当前正式计划（仅用于计算差异）
 * @returns {object} { ok, status, plan, diagnostics, unscheduled, risks, diff, inputHash, policyHash, … }
 * 约束：不读系统时钟、不读随机数、不访问 DOM / localStorage / 网络。
 *       同一 input + 同一 engineVersion ⇒ 逐字段相同的输出（派生 ID 也相同）。
 */
export function run(input) {}
```

**十步流程与产物**

| 步骤 | 做什么 | 产物 |
|---|---|---|
| 1 | 校验输入（区分"数据不合法"与"排不下"） | `invalid_input` + 字段级问题；依赖环单独拦截 |
| 2 | 展开固定活动，建立锁定/进行中/已完成保留集合 | `fixedSpans`、`reservedSpans`（重叠冲突如实报告） |
| 3 | 计算剩余工作量（含减去保留时段已占用的部分） | `remainingByTask` |
| 4 | 生成可用区间与逐日 10% 缓冲 | `capacityDays`（含 `freeWindows`、`schedulableMinutes`） |
| 5 | 拆分任务（可拆分 / 不可拆分 / 尾差） | `fragmentsByTask` + 拆分失败原因 |
| 6 | 按截止时间与评分放位，插入计划休息 | `placements`（带原因码） |
| 7 | 有界局部优化（向前压缩，违反依赖/占用即回退） | 优化后的 `placements` |
| 8 | 组装时间轴块（学习 / 固定 / 休息 / 缓冲） | `blocks` |
| 9 | 硬约束校验 H1–H10 | 违规则返回 `invalid_input`，不交付计划 |
| 10 | 可行性状态、未安排原因、风险评估、差异 | `plan` / `unscheduled` / `risks` / `diff` |

**确定性保证**：所有排序都有唯一全序（末位用 ID 兜底）；迭代次数有固定上界；
派生 ID 由输入指纹推导；引擎不读时钟与随机数。

### 2.3 `src/storage/`

| 模块 | 职责 |
|---|---|
| `storagePort.js` | 存储接口约定（`load/save/clear/readRaw/writeRaw/readBackup/lastSavedAt`）与错误码映射 |
| `localStorageAdapter.js` | 浏览器持久化：写入前先轮转备份；配额/不可用等异常映射为稳定错误码 |
| `memoryAdapter.js` | 内存实现 + 共享的加载逻辑（主数据 → 迁移 → 失败回退备份） |
| `migrations.js` | 结构版本迁移链与"缺字段补默认值"，缺失迁移步骤时拒绝加载 |
| `backup.js` | 导出对象构造、文件名、导入解析与严格校验、备份提醒 |

### 2.4 `src/services/`

| 模块 | 职责 | 关键保证 |
|---|---|---|
| `appState.js` | 唯一数据根、发布订阅、原子持久化 | 保存失败时**回滚内存状态**，内存与磁盘不会不一致 |
| `taskService.js` | 任务 CRUD、状态迁移、影响面评估、软删除 | 非法输入不写库；删除必须报告影响面 |
| `fixedActivityService.js` | 固定活动列表、影响面评估、按日展开、重复规则说明 | 删除前必须能回答"释放了多少可用时间" |
| `planService.js` | 预览生成、计划应用、版本链、撤销、过期检测、会话同步 | 未确认前不写业务数据；确认时数据与计划一次提交 |
| `focusService.js` | 开始/结束学习、记录实际时长 | 同一天只允许一段进行中；结束只记录事实，不自动改未来安排 |

### 2.5 产品化新增的模块（v1.0.0）

| 模块 | 层 | 职责 | 关键约束 |
|---|---|---|---|
| `services/preferences.js` | services | 设备级偏好（外观/通知/专注/奖励） | 只存小体积 JSON；读取失败回退默认值 |
| `services/appearanceService.js` | services | 主题与壁纸的应用 | 主题只改 `<html>` 属性，**不触发整页重绘** |
| `storage/wallpaperStore.js` | storage | 壁纸二进制存取（IndexedDB） | 只存一张；失败安全降级；绝不上传 |
| `services/notificationService.js` | services | 权限、调度、去重 | 按**真实时间戳**比较；持久化去重；页面关闭后不承诺 |
| ~~pomodoro / reward~~ | — | v1.1.0 已移除（番茄钟由独立页面承担；转盘功能不再需要） | — |
| `domain/reconcile.js` | domain | 把"时段"对齐到"剩余工作量"的纯函数 | 只取消未完成时段；已完成的学习记录永不触碰 |
| `domain/restPeriod.js` | domain | 休息时间实体 + 按午夜拆分的纯函数 | 一条完整安排 → 若干当日片段；时长守恒、无重叠 |
| `services/restService.js` | services | 休息的查询与冲突检查 | 冲突只报告不修改，绝不静默覆盖别人的安排 |
| `ui/board.js` | ui | 七天/每日/首页共用的看板渲染 | 排序与状态只有一处实现；网格基准 5 分钟 = 1 标准格 |
| `domain/subject.js` | domain | 科目字典与名称归一化 | 任务仍存科目名；改名时任务与字典在同一事务里同步 |
| `services/subjectService.js` | services | 科目读取与引用统计 | 只读；写操作走 `subject.*` 变更 |
| `engine/capacity.js` → `resolveSearchStart` | engine | 规划起点解析 | 默认"严格的下一个整点"；过去的时间不会被当成未来 |
| `services/statsService.js` | services | 全部统计与成就 | 只读真实记录；无数据时返回"未知"而不是 0 |
| `ui/labels.js` | ui | 内部枚举 → 用户文案 | 界面**不得**直接渲染内部码 |

**为什么"历史记录"与"有效占位"必须分开（`constraints.js` + `scheduler.js`）**：
一条已完成的学习时段有两种身份：它是**历史事实**（统计要用），但它**不再是**日程占位。
把两者混在一起就会出现"任务已经做完了，却永远占着那段时间"的怪现象。
因此：
- 容量层仍把它算作已占用的墙钟时间（避免排程器把新内容排到同一时刻）；
- 冲突/校验层把它排除（不参与 H1/H2/H3，也不参与"保留时段 vs 固定活动"的冲突检测）。

**为什么"看板"要单独成一层（`ui/board.js`）**：
七天计划、每日视图、首页的"今天"都显示同一种卡片。如果各自实现排序与状态判断，
同一天在三个地方的顺序或状态就可能不一致（这也是"随机重排"的常见来源）。
把"数据 → 卡片"与"卡片 → DOM"收敛到一个模块后，三处必然一致，尺寸基准也只有一处定义。

**为什么数据一致性修复单独成一层（`domain/reconcile.js`）**：
"剩余工作量 ≥ 未完成时段合计"这个不变量被多个入口影响（完成、取消、删除、改工作量、改已完成时长）。
把这些场景的对齐逻辑收敛到一个纯函数里，任何入口只要在**同一次提交**中调用它，
就不会再出现"只改了任务、忘了改时段"的半更新数据；同时也让"加载旧数据时的安全修复"复用同一段逻辑。

**草稿变更层（`src/domain/mutations.js`）**

阶段 3 起，界面的每一次修改都描述成一个**变更操作**（op）：

```
{ kind: 'task.add',    input }
{ kind: 'task.update', taskId, patch }
{ kind: 'session.lock', sessionId, locked }
{ kind: 'session.move', sessionId, date, startMinutes, endMinutes, lock?, force? }
{ kind: 'fixedActivity.add' | 'update' | 'remove', … }
{ kind: 'settings.update', settings }
{ kind: 'window.shift', windowStart, windowDays }
```

`applyDraftOps(state, ops, ctx)` 是**纯函数**：输入状态与操作，输出新状态或结构化错误。
它被用在同一流程的两端：

1. `requestPreview` 时把 ops 应用到内存草稿上，交给引擎求解并生成差异预览；
2. `applyPreview` 时在同一事务里重放同一批 ops，再写入计划与会话。

这样"预览看到的"与"确认后写入的"必然是同一套逻辑，不会出现两者不一致。

### 2.5 `src/ui/`

| 模块 | 职责 |
|---|---|
| `main.js`（`src/main.js`） | 启动装配：选择存储适配器、注入时钟与 ID 工厂、注册路由 |
| `shell.js` | 顶栏、侧边导航、全局横幅、页面渲染与变更订阅 |
| `router.js` | hash 路由（兼容 `file://` 与静态服务器） |
| `dom.js` | 极简 DOM 构建原语、下载、提示条 |
| `components.js` | 通用组件：卡片、按钮、状态标签、时间轴、空状态、诊断列表 |
| `modal.js` | 危险操作确认对话框（原生 `<dialog>`，含焦点管理） |
| `pages/*.js` | 六个页面与任务表单 |
| `styles/*.css` | `tokens.css`（设计令牌）→ `base.css`（重置与排版）→ `components.css`（组件与布局） |

---

## 3. 核心数据模型与关系

```
AppState
├── schemaVersion / createdAt / updatedAt / timeZone
├── settings : Settings                 （可用时间、拆分规则、休息、缓冲、权重）
├── tasks    : Task[]                   （含软删除项）
├── sessions : StudySession[]           （全部历史 + 当前，taskId 强关联 Task）
├── fixedActivities : FixedActivity[]   （课程/睡眠/用餐/社团）
├── officialPlan : SchedulePlan | null  （唯一生效的计划）
├── planHistory  : PlanSnapshot[]       （撤销链，最多 planHistoryLimit 个）
├── pendingPreview : PlanPreview | null （未确认的候选计划）
└── meta : { lastBackupAt, migrationLog, lastPlanMutation, … }
```

### 3.1 实体关系

```
Task 1 ──── 0..N StudySession ──── 映射为 ──── CalendarBlock(kind='study')
Task 0..N ── dependsOn ──> Task（有向图，禁止环）
FixedActivity 0..N ── 展开 ──> CalendarBlock(kind='fixed')
SchedulePlan 1 ──── 0..N CalendarBlock（学习/固定/休息/缓冲四类，时间轴唯一数据源）
```

### 3.2 关键不变量

1. `Σ session[task].plannedMinutes（未完成） ≤ remainingMinutes(task)`
2. `completedMinutes(task) ≤ task.plannedMinutes`
3. 同一任务的所有时段都指向存在的 `taskId`（悬空引用即数据错误）
4. 任何两个"学习/休息/缓冲"块在同一业务日内不重叠（固定活动之间允许重叠）
5. `state='completed'` 的时段是终态，只能由用户显式"撤销完成"
6. `locked=true` / `state='in_progress'` / `state='completed'` 的时段参与容量计算，且不得被自动改动
7. `days.length` 等于窗口天数（默认 7），每日统计与块集合必须自洽

---

## 4. 数据流

### 4.1 读取（渲染）

```
localStorage ── load ──> migrations（迁移 + 语义校验）──> AppState
                                                          │
                              shell.render(route) ────────┤ 订阅变更
                                                          ▼
                        pages/* 读取 services 提供的只读视图（listTaskViews / getOfficialPlan / listVersions）
```

- 页面组件**不缓存业务数据**，每次渲染都从 `app.getState()` 与 service 派生函数重新取。
- 数据变化 → `app.commit` → 通知订阅者 → `requestAnimationFrame` 合帧后重绘当前页面。

### 4.2 写入（任务）

```
界面表单 ──> services.taskService.addTask/updateTask
                        │ 1. createTask + validateTask（结构校验）
                        │ 2. checkTaskDependencies（悬空/自引用/环）
                        │ 3. app.commit（持久化 + 失败回滚）
                        ▼
                  AppState + localStorage
```

### 4.3 写入（计划）

```
用户操作 ──> planService.requestPreview({ now, draft?, changeSummary })
                │ 1. 记录 baseVersion 与「当前状态的实时输入指纹」
                │ 2. engine.run(state)                ← 纯函数，读草稿状态
                │ 3. 失败（invalid_input / 硬约束违规）→ 不产生候选计划，返回原因
                │ 4. 成功 → 生成 pendingPreview（候选计划 + 差异 + 风险 + 会话快照）
                ▼
          pendingPreview（持久化，刷新后仍可确认；**正式计划零改动**）
                │
   用户确认 ────┤ ① 过期检查：baseVersion + 实时输入指纹
                │ ② 结构校验 + 受保护时段保留检查（H9 / H10）
                │ ③ 原子写入：sessions（保留/取消/新建）+ officialPlan + 历史快照
                ▼
   用户放弃 ────┴ 只清空 pendingPreview（业务数据零改动）
```

**会话同步规则**（`buildSessionPlan`）：

- 受保护时段（已完成 / 锁定 / 进行中）**原样保留**，不重建、不移动；
- 窗口内被新安排取代的旧 `flexible` 时段标记为 `cancelled`（保留记录，不物理删除）；
- 候选计划中的新学习块创建为 `state='flexible'`、`source='engine'` 的 `StudySession`，
  带 `reasonCodes`（放位原因，用于界面解释）。

---

## 5. 存储与版本策略

- 键名：`studyPlanner:v1:state` / `studyPlanner:v1:backup` / `studyPlanner:v1:meta`。
- 写入顺序：**先备份旧数据 → 再写新数据**。这样任何一步失败都不会同时丢掉新旧数据。
- 读取顺序：主数据 → 迁移 → 校验；失败则回退备份并在界面提示"已从备份恢复"。
- 结构版本：`CURRENT_SCHEMA_VERSION`；破坏性变更必须递增并添加迁移步骤。
- 读取到更高版本的数据时**拒绝加载**，避免旧程序写坏新数据。
- 导入外部文件时的检查比迁移更严格：缺必需字段直接拒绝（见 `storage/backup.js`）。

---

## 6. 时间处理约定（最容易出错的部分）

项目只处理**用户本地墙上时间**（单一时区），内部统一使用两种表示：

- `WallDate`：`'YYYY-MM-DD'` 日历日
- `WallTime`：`'HH:mm'` 墙上时刻
- 时段：`{ date, startMinutes, endMinutes }`，`endMinutes > 1440` 表示跨午夜

规则：

1. **禁止**在 `time.js` 之外解析日期字符串（`new Date('2025-10-16')` 会按 UTC 解析）。
2. 跨午夜时段一律用 `splitOvernightSpan` 切成"每天一段"，且每段的分钟数是**该段自己日期内**的
   （`0 ≤ start < end ≤ 1440`），不保留跨日累加偏移。
3. 业务日边界默认 04:00：凌晨 4 点之前的时段归属前一天（`businessDateFor`）。
4. 与时间戳的换算只在需要与浏览器交互时使用，并显式传入 UTC 偏移（`wallTimeToUtcOffsetMs`）。
5. 引擎内部**不读系统时钟**：`now` 必须由调用方作为参数传入。

---

## 7. 测试结构

```
tests/
├── helpers/       固定时钟、ID 工厂、样本实体、集成装配（createTestApp）
├── unit/          领域层：time / ids / validation / task / session / fixedActivity /
│                  calendarBlock / graph / plan / schemas / storage / docs
└── integration/   服务层与端到端：appState / taskService / planService / lifecycle / scripts
```

测试原则：

- 单元测试只测纯函数，禁止依赖真实系统时间与网络。
- 集成测试通过 `createTestApp()` 装配真实的服务与存储（内存适配器），覆盖"操作 → 落盘 → 重新加载"链路。
- 每个硬约束都要有**负向测试**：构造违反约束的数据，断言校验器报错。
- 文档一致性由 `tests/unit/docs.test.js` 守护（必需文件、零依赖、README 命令与实际一致）。

---

## 8. 已知架构限制（阶段 2 结束时）

1. **任务表单仍是"直接保存"**：引擎与预览闭环已经可用，但表单内的"先预览再保存"流程、
   时段锁定/移动按钮、固定活动管理页面在阶段 3 接线。
2. **局部优化是局部改进**：只做确定性的"向前压缩"，有迭代上界、可回退，不宣称全局最优。
3. **界面层没有真实 DOM 自动化测试**（未安装 jsdom 等依赖）：用最小 DOM 打桩验证
   "渲染不抛异常 + 关键内容存在 + 单文件产物可执行"，CSS 布局与真实点击由
   `docs/ACCEPTANCE.md` 的人工步骤覆盖。
4. **窗口滚动未接线**：引擎支持任意窗口与天数，界面按钮在阶段 3 提供。
5. **内联打包器是极简实现**：支持静态 import / 命名空间导入 / 别名 / 再导出 / async 导出；
   遇到动态 import、`export *`、外部依赖会明确报错而不是产出错误的包。
