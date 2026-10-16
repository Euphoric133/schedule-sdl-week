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

### 2.2 `src/engine/`（阶段 2 实现）

计划中的模块划分：

| 模块 | 职责 |
|---|---|
| `policy.js` | 全部可调参数与默认值（权重、缓冲比例、休息规则、时长限制） |
| `priority.js` | 优先级评分 `P = 0.35·紧迫 + 0.30·难度 + 0.20·重要 + 0.15·拖延` |
| `capacity.js` | 可用区间计算与缓冲预留 |
| `splitter.js` | 任务 → 学习片段（可拆分 / 不可拆分、尾差处理） |
| `placer.js` | 片段 → 时间槽（偏好时段、同科目连续、确定性平局裁决） |
| `constraints.js` | 硬约束校验器（H1–H10），含负向测试 |
| `diff.js` | 计划差异（新增/移动/缩短/拆分/取消/不变/锁定影响/每日指标） |
| `risk.js` | 逾期风险与 30 天风险评估 |
| `scheduler.js` | 编排十步流程，返回 `{ plan, status, unscheduled, diagnostics }` |
| `versionHash.js` | 输入指纹（用于预览过期检测）与确定性派生 ID |

**引擎契约（必须遵守）**

```js
/**
 * @param {SchedulerInput} input { tasks, sessions, fixedActivities, settings, existingPlan, now, engineVersion }
 * @returns {SchedulerResult}    { ok, status, plan?, diagnostics, unscheduled, stats, inputHash }
 * 约束：不读系统时钟、不读随机数、不访问 DOM / localStorage / 网络。
 * 同一 input + 同一 engineVersion ⇒ 逐字段相同的输出。
 */
export function run(input) {}
```

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
| `planService.js` | 计划应用、版本链、撤销、预览过期检测 | 版本不匹配或输入指纹变化时拒绝应用 |
| `focusService.js` | 开始/结束学习、记录实际时长 | 同一天只允许一段进行中；结束只记录事实，不自动改未来安排 |

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

### 4.3 写入（计划，阶段 2/3 完整形态）

```
用户操作 ──> planService.requestPreview(intent)
                │ 1. 记录 baseVersion 与 baseInputHash
                │ 2. 在内存 draft 上应用变更（不写状态）
                │ 3. engine.run(draft)               ← 纯函数
                │ 4. 硬约束校验失败 → 保留现有正式计划，报告原因
                │ 5. engine.diff(officialPlan, candidate)
                ▼
          pendingPreview（候选计划 + 差异）
                │
   用户确认 ────┤ 过期检查（版本 + 输入指纹）→ 二次校验 → 原子写入 + 快照入历史
   用户放弃 ────┴ 丢弃 pendingPreview，正式计划零改动
```

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

## 8. 已知架构限制（阶段 1）

1. `src/engine/` 尚未创建，`planService` 目前只能接收"已经算好的"计划。
2. 任务的新增/修改目前直接落盘，还未接入"候选计划 → 差异预览 → 确认"闭环（阶段 3 完成）。
3. 界面层没有 DOM 自动化测试（未安装 jsdom 等依赖）；DOM 级验证由 `docs/ACCEPTANCE.md` 的人工步骤覆盖。
4. `pendingPreview` 的数据结构已在 `domain/plan.js` 与 `planService` 中定型，但生成逻辑待阶段 2 填充。
