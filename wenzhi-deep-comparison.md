# 稳智 AI 深度逆向 × 本仓库全对齐对照

_生成时间：2026-09-23 18:55  ·  逆向材料：`.box-agent-scratch/wenzhi-reverse/js/*`（18 个远程 bundle，共 ~1.4MB）+ 已有 HTML 骨架 + 4 张截图_

## 证据锚点文件

| 文件 | 内容 | 大小 |
|---|---|---|
| `reverse-01-AiMatrixHome.md` | 主 bundle 逆向：菜单/路由/API/事件流/状态键/Agent Loop/错误码/点数系统 | 19KB |
| `reverse-02-visual-debug.md` | flowVisualRegistry + agentStepTimeline + useAiMatrixDebugView + CSS 视觉 | 63KB |
| `.box-agent-scratch/wenzhi-reverse/js/*` | 18 个原始远程 bundle | 1.4MB |

---

## 一、菜单体系对照

### 稳智（9 项，HTML 硬编码）
```
1. 大盘情绪         → 路由由 index 属性给，未见 path
2. 量化因子选股     → 同上
3. 行业
4. 行情
5. 自选
6. LLM分析          ← 注意：稳智有独立 LLM 分析入口
7. 奇门遁甲
8. 稳智AI           ← AI 对话主页（is-active）
9. 订阅账号与点数   ← 钱包/点数系统（商业化）
```

### 本仓库（`src/lib/desk/nav-core.ts` MENU + SYSTEM_ITEMS）
```
1. market 大盘情绪 → key="market"
2. quant 量化选股  → 6 子项：quant / screener / factorlab / pool / radar / problab
3. sectors 行业板块 → 3 子项：sectors / themes / themeoverview
4. quotes 行情     → 6 子项：allstocks / history / profile / risk / board / dashboard
5. watch 自选      → key="tracker"
6. ai AI 对话      → key="copilot"，legacyPages=["aihome","analysis","events","research","agent"]
7. qimen 奇门遁甲  → key="qimen"
+ SYSTEM_ITEMS: settings 设置 / extension 扩展
```

### 差距

| 维度 | 稳智 | 本仓库 | 差距 |
|---|---|---|---|
| 一级菜单数量 | 9 项 | 7 项 + 2 系统项 | ✅ 数量相近 |
| 二级展开 | 无（纯平铺） | 3 项有子项 | ⚠️ 稳智单页内部再分 |
| **LLM 分析入口** | 独立第 6 项 | 无 | ❌ **缺一个独立 LLM 分析入口**（稳智把「LLM 分析」和「稳智 AI」分开） |
| **钱包/点数入口** | 第 9 项 | 无 | ❌ **缺商业化入口** |
| 菜单定义位置 | HTML 硬编码 | TS 常量表 | 都合理 |
| 品牌区 | 无（直接 icon-btn 折叠） | 有 Logo + 名称 | ⚠️ 稳智更轻 |
| 会话历史区 | 侧栏底部「最近」 | 无（收在空态） | ❌ **缺侧栏会话历史** |
| 折叠侧栏按钮 | 有 | 无 | ❌ 缺折叠按钮 |

**建议**：
- **P0**：把「LLM 分析」和「AI 对话」分开——LLM 分析走 `assistant`（当前 AssistantPage），AI 对话走 `copilot`（当前 AiHomePage 的空态大输入框）。两者定位不同：一个是「深度分析」，一个是「快速问答」。
- **P1**：侧栏底部加「最近」会话历史区，从 `useDesk.sessions` 读有消息的会话倒序取 5 条。
- **P2**：加折叠侧栏按钮（`nav-header` 位置）。
- **P3**：加钱包入口占位（即使不做商业化也留个"点数用量"面板）。

---

## 二、AI 对话链路对照

### 2.1 事件流协议

**稳智**（`onMessage` switch 分支，见 reverse-01 §6）：
```
stage           → 宏观阶段（researching / answer_streaming / finished / degraded / incomplete / failed）
step            → Agent Loop 内的一步（step_kind: tool_call / 其他）
agent_started   → 子 Agent 起跑
answer_started  → 回答开始
answer_chunk    → token 流
answer_finished → 回答完成
ping            → SSE 心跳
block_started/finished → 结构化块（table/code/quote/markdown）
channel: flow | reasoning | answer（三种通道）
```

**本仓库**（`chat-stream-core.ts` StreamEventBody）：
```
step    → StreamStep（含 step_name / args / summary / duration_ms）
delta   → 内容分片
warning → 警告文案
done    → 完成帧（含 fullText / steps / warning / intent / debug）
```

**差距**：
- 稳智有 `stage`（宏观阶段）、`agent_started`（子 Agent）、`answer_started/finished`（回答包裹）、`block_started/finished`（结构化块）——**5 种我们完全没有的事件**。
- 稳智有 `channel` 区分 `flow | reasoning | answer` 三条通道，本仓库只有单条流。
- 稳智有 `ping` 心跳，本仓库没有 SSE 保活。

**建议**：**P1** 加 `stage` 事件（宏观阶段，对应 `answer_state: researching → answer_streaming → finished`），前端渲染成顶部进度条。**P2** 加 `block_started/finished` 支持结构化块（`📊 表格` / `📈 代码` / `🔍 引用`）。**P3** 加 `ping` 心跳（SSE 每 15s 一次）。

---

### 2.2 Prompt 结构

**稳智**（12 个模板，全部服务端拼装）：
- 前端只提交 `{message, sessionId, llmMode, llmModelVariant, searchEnabled, tradingHorizon, selectedStockName, selectedStockSymbol, candidatePoolId, images}`
- 后端在 Agent Loop step 1（intent）识别意图后，从 12 个模板中选 1 个渲染
- 12 个模板（从消费点推断）：
  1. `stock_seven_dimension_input` —— 七维分析
  2. `stock_cost_input` —— 按成本持仓计划
  3. `can_buy_now_input` —— 能不能买
  4. `compare_multi_stock_input` —— 多股对比
  5. `sector_stage_input` —— 板块阶段
  6. `position_strategy_input` —— 仓位策略
  7. `sector_inflow_input` —— 板块资金筛选
  8. `trading_plan_input` —— 交易计划
  9-12. （其余 4 个未在 bundle 中）

**本仓库**：
- `MODE_NOTES` 4 种（decision / judge / deep / search），P17 已把 decision 升级为结构化 10 字段模板（680 字符）
- `HORIZON_NOTES` 3 种（short / mid / long）
- `renderAnalysisFrames()` 全局下发 50 个研究框架，让模型自己挑

**差距**：
- 稳智是「12 模板 × 5 周期 = 60 种组合」，按意图选 1 个
- 本仓库是「4 风格 × 3 周期 = 12 种组合」+ 50 框架全塞
- 稳智的「按意图选模板」是**后端智能路由**，本仓库是**用户显式选风格 + 模型自由发挥**

**建议**：
- **P0**：`MODE_NOTES.decision` 已经是结构化模板，这一步做完了 ✅
- **P1**：加后端意图识别器（在 `chat/route.ts` 开头），把用户输入分类到 8 个意图（个股分析 / 持仓计划 / 板块阶段 / 交易计划 / 对比 / 大盘情绪 / 事件驱动 / 通用问答），注入对应模板而非 50 框架全塞。参考稳智 `step:1 key:"intent"` 的做法。
- **P2**：交易周期从 3 档扩到 5 档（超短/短/短中/中/长）。

---

### 2.3 Agent Loop 编排

**稳智**（`agentStepTimeline` 6 阶段，见 reverse-02 §2.5）：
```
step_kind:   label
intent       → 理解问题
skills       → 选择分析方法
local_data   → 获取行情与市场数据
external_data → 核查新闻与公开信息
research     → 综合分析
answer       → 生成结论
```

**本仓库**（`StepTimeline` 组件，事件流 `step` 类型）：
```
step_name 动态（无固定 6 阶段）
```

**差距**：
- 稳智有**明确的 6 阶段固定顺序**，用户看得到"AI 走到哪一步了"
- 本仓库的步骤是**动态的**（工具调用名），没有阶段化
- 稳智有 `agent_started`（子 Agent 起跑）、`parentStepId`（子步骤挂父步骤）——**层次化步骤**
- 本仓库步骤是扁平的

**建议**：
- **P0**：把本仓库的 `step_name` 映射到 6 阶段 label（`intent/skills/local_data/external_data/research/answer`），在 `StepTimeline.tsx` 里加阶段分组渲染。
- **P1**：SSE 加 `agent_started` 事件，前端渲染子 Agent 起跑提示。
- **P2**：加 `parentStepId` 支持嵌套步骤。

---

### 2.4 结论结构化契约

**稳智**（`final_conclusion_contract`，见 reverse-01 §10）：
```
后端 markdown 段落名固定：
  核心判断 → judgement
  板块/概念焦点 → themes
  最终关注清单 → watchlist
前端正则切成 JSON 对象 {judgement, themes, watchlist[]}
watchlist 项格式：name(symbol|tag|tag)
```

**本仓库**：
- 无结构化契约，回答就是纯 markdown

**差距**：
- 稳智有**后端 markdown → 前端 JSON**的转换契约
- 本仓库完全依赖模型输出格式，没有解析层

**建议**：
- **P1**：定义「结论契约」（比如 markdown 用 `### 🎯 核心判断` / `### 🔍 关注清单` 前缀，前端识别后渲染成卡片）
- **P2**：`watchlist` 项格式规范化（`name(symbol|tag|tag)`）

---

### 2.5 交易周期检测

**稳智**：
- 前端调用 `resolveTradingHorizonForInput(E)` 检测用户输入
- 命中 → 直接进 payload
- 未命中 → 返回 `null`，前端弹 `ai-matrix-stock-horizon-prompt` dialog 让用户手选
- 5 档：`ultra_short` / `short_term` / `short_mid_term` / `mid_term` / `long_term`
- 每个候选（`activeCandidateTradingHorizon`）绑定周期，跨会话记忆

**本仓库**：
- `HorizonPicker` 是纯前端分段控件（`short / mid / long` 3 档）
- 用户手动选，不做自动检测
- 没有"未选就拦截"的机制

**差距**：
- 稳智有**自动检测 + 未命中拦截**，本仓库是纯手动
- 稳智 5 档，本仓库 3 档
- 稳智周期跨会话记忆，本仓库只在 store 里

**建议**：
- **P2**：加 `resolveTradingHorizonForInput`（正则匹配 "短线" / "1-3 天" / "长期" / "波段" 等）
- **P3**：从 3 档扩到 5 档

---

### 2.6 多模态输入

**稳智**：
- HTML 侧栏 `<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>`
- payload `images: []`（数组）
- 前端不压缩、不缩放、直接上传原图
- 服务端决定用哪个多模态 LLM

**本仓库**：
- 完全无多模态

**差距**：纯缺。**建议**：**P3** 加图片上传按钮 + 后端接 vision LLM（`doubao-pro` 是否支持 vision 需要验证）。

---

### 2.7 状态持久化

**稳智**（`sessionStorage` + `localStorage`）：
```
ai_matrix_active_task_v1         → 当前正在流式的 task_id（刷新后恢复）
ai_matrix_current_session_v1     → 当前对话 session_id
ai_matrix_active_task_view_v1    → 当前 flow snapshot（切路由再回来不丢）
__pending__                      → sentinel
9e5 (15min)                      → 任务过期时间
presentation.v2                  → 协议版本号
所有 key 加 :storageScope 后缀（多环境隔离）
```

**本仓库**（`zustand persist` 到 `localStorage`）：
- `page / ai / assistantMode / assistantHorizon / sessions / activeSessionId` 等
- 有会话列表持久化，但没有 active_task 概念

**差距**：
- 稳智有 **active_task 恢复**（刷新页面后继续接收流式回答）
- 稳智有 **task_id 过期时间**（15 分钟）
- 稳智有 **多环境隔离**（`:storageScope` 后缀）
- 本仓库会话持久化，但**流式回答刷新即丢**

**建议**：
- **P2**：加 `active_task_id` 状态（当前正在跑的 task），刷新后重新连 SSE
- **P3**：加任务过期时间机制

---

### 2.8 错误人话化

**稳智**（8 条错误码 → 用户文案映射，见 reverse-01 §11）：
| 后端错误码 | 用户文案 |
|---|---|
| `task_in_progress` | "上一条消息仍在分析中，请稍候再发送" |
| `ai_matrix_points_insufficient` | "点数不足，请先充值" |
| `ai_matrix_wallet_unavailable` | "钱包当前不可用，请稍后重试或联系管理员。" |
| `billing_freeze_failed` | "发送前校验点数失败，请稍后重试" |
| `login_failed` | 跳登录页 |

**本仓库**：
- `onNotConfigured: () => go("settings")` 是唯一错误分支
- 其他错误通过 catch + `String(err.message)` 直出

**差距**：
- 稳智有**结构化错误码**（下划线蛇形）+ **人话映射表**
- 本仓库错误处理是**兜底式**的

**建议**：
- **P1**：加错误码表（`task_in_progress` / `ai_not_configured` / `model_timeout` / `rate_limit_exceeded` 等）+ 映射到用户文案。

---

### 2.9 点数/钱包系统

**稳智**：完整预冻结机制
```
提交前 → loadBalance({llmModelVariant, searchEnabled}) → 返回 required_freeze_points
       → 前端本地比对 balance_points >= required_freeze_points
       → 通过后提交 → 后端真正预冻结 → 分析完成后消耗或释放
两种加价参数：llmModelVariant（pro 加价）、searchEnabled（搜索加价）
```

**本仓库**：完全没有商业化概念。

**差距**：纯缺。**建议**：**P4** 除非做商业化，否则不做。如果做了，参考稳智的「预冻结 → 消耗 → 释放」三段式。

---

## 三、UI 组件对照

### 3.1 决策卡（11 字段）

**稳智**（`flowVisualRegistry.a` 常量表，见 reverse-02 §1.4）：
```
decision_signal  → 🎯 研究结论
core_judgement   → 📌 核心结论
data_basis       → 📌 依据
signals          → 📈 关键信号
capital_flow     → 📊 强弱/量价
falsification    → 🧪 反证状态
trigger          → 🗓️ 触发条件
invalidation     → 🛑 失效条件
position_plan    → 📦 仓位节奏
risk             → ⚠️ 风险提示
action           → 🧭 操作参考
```

**本仓库**：
- `MODE_NOTES.decision` P17 已升级成 10 字段结构化模板（缺 `data_basis` 依据 vs 我们没这个字段——我们叫"依据"）
- 但**前端 Markdown 渲染器没有识别这些 emoji 前缀渲染成独立卡片**——回答仍是纯段落

**差距**：
- 稳智 11 字段，我们 P17 版 10 字段（少 `core_judgement` 核心结论，我们把"核心结论"合并到第一个 bullet 里）
- **关键差距**：前端不识别 emoji 前缀 → 卡片化

**建议**：
- **P1**：改 `Markdown.tsx`，识别 `- 📌 xxx：yyy` 这类 bullet，把每个 bullet 渲染成独立卡片（`LineageCard` 变体）。工作量 1 天。

---

### 3.2 Agent 步骤时间线

**稳智**（`agentStepTimeline`，见 reverse-02 §2）：
- 状态图标：`✓` 已完成 / `●` 进行中 / `○` 等待中 / `⚠` 失败
- 状态文案：「已完成 / 进行中 / 等待中 / 失败」
- 6 阶段 label 精确映射（见 §2.2）
- 耗时格式化：`<1s→N.Nms`、`<1min→N.Ns`、`>=1min→N分M秒`（中文单位）
- 状态合并规则 `{done:1, pending:2, active:3, error:4}`——**只升级不降级**
- 运行态标题 `✨ AI 正在分析`，结束态 `✨ AI 已完成分析`
- 折叠/展开逻辑：`process已收起，点击可重新展开` / `正在补充本轮判断所需的依据。`

**本仓库**（`StepTimeline.tsx`）：
- 状态图标、耗时格式化、6 阶段 label、折叠展开——这些都需要看具体实现

**建议**：跑一下 `StepTimeline.tsx` 对比，确认哪些已有、哪些要加。

---

### 3.3 数据可视化

**稳智**（`AiMatrixAssistantSourceStrip` 组件）：
- 可折叠引用源面板
- 按类型过滤：公告 / 新闻 / 实时行情 / 其他
- 按来源分组 + 展开/折叠
- 每条来源带外链（新 tab 打开）
- `quant_factors_diagnostic` 面板：`close_ok / ma20_ok / ma60_ok / rsi_ok`

**本仓库**：
- `SourceBadge.tsx` 有来源徽章（REAL/DERIVED/DERIVED_ON_DEMO/MISSING）
- 无量化因子诊断面板
- 无按类型分组的来源面板

**差距**：
- 稳智的「数据源面板」是**答案末尾独立区块**，按类型过滤
- 本仓库来源是**行内徽章**，不是面板

**建议**：
- **P2**：加"已核验的信息来源"面板（可折叠），把本轮 `StepTimeline.steps` 里的工具调用按类型分组展示。

---

### 3.4 调试视图

**稳智**（`useAiMatrixDebugView`，见 reverse-02 §3）：
- 抽屉 `el-drawer size="56%"`，两大区块：`flow-cards` + `debug-cards`
- 6 个 perf-block：后端路由判定 / 契约摘要 / 后端耗时拆解 / 后端 LLM 详情 / 前端里程碑 / 前端原始指标
- 5 项 prompt-debug 元数据
- 契约快照：`explicit_route` vs `agentic_route`（两种路由方案对比）
- LLM 三元组 `requested_*` vs `effective_*`：mode=`deep|standard|fallback`，variant=`pro|flash|direct_reply`
- 前端 SSE 计数：progress/answer/thinking/reasoning/done 五类

**本仓库**：
- `debugPanel` 开关（默认关）
- 调试视图只展示 `StepTimeline` 的详细数据 + `intent` 徽章

**差距**：
- 稳智调试视图是**开发者级**（6 个 perf-block + prompt 调试 + 契约快照）
- 本仓库调试视图是**用户级**（步骤明细 + 意图）

**建议**：
- **P3**：调试视图补 3 个 perf-block：后端耗时拆解（`request_ack → first_token → first_answer → stream_done`）、LLM 详情（`mode/variant`）、SSE 事件统计（`count by type`）。工作量 2 天。

---

### 3.5 CSS 主题与动画

**稳智**（`AiMatrixHome-D20s36eF.css`，见 reverse-02 §4-5）：
- 深色主题 23 条 `.dark` 规则
- 关键动画（全部带 `--ease-cubic` 缓动曲线）：
  - `ai-fade-in` 0.22s
  - `ai-slide-up` 0.26s
  - `ai-slide-right` 0.24s
  - `ai-slide-in-up` 弹性过冲 `cubic-bezier(.34,1.56,.64,1)`
  - `ai-shimmer` 1.8s
  - `ai-pulse` 1.6s
- 布局 token：`--chat-sidebar-width:136px` / `--mode-selector-w:240px` / `--text-body:15px` / `--ai-card-gap:8px`
- Element Plus 主题覆盖 18 项（`--el-fill-color-light` 系列）

**本仓库**：
- Tailwind 4 + shadcn/ui
- 已有 `apple-fade-in` / `apple-slide-up` / `apple-slide-in` 类
- 无 CSS 变量（用 Tailwind 内联）

**差距**：
- 稳智的 CSS 是**变量驱动的**，本仓库是 **Tailwind 类驱动的**——都合理
- 稳智有 `ai-slide-in-up` 弹性过冲动画，本仓库的 `apple-slide-up` 是标准 ease-out

**建议**：**P4** 可选，本仓库视觉已经足够好，不建议为动画细节大改。

---

## 四、差距总结与优先级

### 🔴 P0（当天可做，改动小、收益大）

| # | 项 | 工作量 | 修改文件 |
|---|---|---|---|
| 1 | **加意图识别器**：`chat/route.ts` 开头识别 8 个意图，注入对应模板（不再全塞 50 框架） | 1 天 | `src/app/api/ai/chat/route.ts`、`src/lib/desk/intent-core.ts` |
| 2 | **前端 Markdown 识别 emoji 前缀 → 卡片化**：`- 📌 xxx：yyy` 渲染成 `LineageCard` 变体 | 1 天 | `src/components/desk/Markdown.tsx` |

### 🟡 P1（1-3 天，改动中等）

| # | 项 | 工作量 | 修改文件 |
|---|---|---|---|
| 3 | **LLM 分析和 AI 对话分开**：`LLM 分析` 走 assistant，`AI 对话` 走 copilot | 0.5 天 | `nav-core.ts`、`Sidebar.tsx` |
| 4 | **SSE 加 `stage` 事件**：宏观阶段进度条 | 1 天 | `chat-stream-core.ts`、`AssistantPage.tsx` |
| 5 | **StepTimeline 阶段分组**：把 step_name 映射到 6 阶段 label | 0.5 天 | `StepTimeline.tsx` |
| 6 | **错误码 → 用户文案映射**：结构化错误码 + 人话化 | 1 天 | 新文件 `error-codes.ts` |
| 7 | **侧栏会话历史区**：从 `useDesk.sessions` 读最近 5 条 | 0.5 天 | `Sidebar.tsx` |
| 8 | **结论契约**：markdown 用固定前缀，前端识别切卡片 | 1 天 | `chat/route.ts` + `Markdown.tsx` |

### 🟠 P2（3-7 天，改动较大）

| # | 项 | 工作量 | 修改文件 |
|---|---|---|---|
| 9 | **SSE 加 `block_started/finished`**：支持结构化块（table/code/quote/markdown） | 2 天 | `chat-stream-core.ts`、`Markdown.tsx` |
| 10 | **Agent Loop 6 阶段固定顺序**：意图→技能→本地数据→外部数据→研究→结论 | 2 天 | `chat/route.ts`、`StepTimeline.tsx` |
| 11 | **交易周期从 3 档扩到 5 档** + 自动检测 | 1 天 | `modes.ts`、`HorizonPicker.tsx` |
| 12 | **`parentStepId` 嵌套步骤**：子 Agent 步骤挂父步骤 | 2 天 | `chat-stream-core.ts`、`StepTimeline.tsx` |
| 13 | **数据源面板**：答案末尾按类型分组（公告/新闻/行情/其他） | 1 天 | 新组件 `SourceStrip.tsx` |
| 14 | **`active_task_id` 状态**：刷新后重新连 SSE | 1 天 | `use-chat.ts`、`store.ts` |

### 🔵 P3（可选，锦上添花）

| # | 项 | 工作量 |
|---|---|---|
| 15 | 图片上传（多模态） | 2 天 |
| 16 | 调试视图 3 个 perf-block | 2 天 |
| 17 | 折叠侧栏按钮 | 0.5 天 |
| 18 | 钱包入口占位 | 1 天 |
| 19 | 任务过期时间机制 | 1 天 |

### ⚪ P4（除非商业化，否则不做）

| # | 项 | 工作量 |
|---|---|---|
| 20 | 完整点数系统（预冻结/消耗/释放） | 5+ 天 |

---

## 五、按批次执行的建议

### 批次 1：2 天（P0 优先，收益最大）
1. 意图识别器（1 天）
2. Markdown emoji 卡片化（1 天）

**做完这两条，AI 回答的结构感和可读性立刻上一个档次**——比换模型效果更直接。

### 批次 2：1 周（P1，把基础功能补全）
3-8 全做，累计 5 天。做完菜单体系、错误处理、SSE stage、Agent Loop 阶段化都到位。

### 批次 3：2 周（P2，深度对齐稳智）
9-14 全做，累计 9 天。做完 SSE block、嵌套步骤、数据源面板都到位。

### 批次 4：P3 可选（按兴趣）

---

## 六、一句话总结

**稳智的核心秘密是「结构化模板 + 后端意图路由 + Agent Loop 6 阶段 + 前端结构化渲染」四层配合。你现在缺的不是模型能力，而是这四层的对齐。批次 1 的 2 条改动做完，AI 回答从"段落式"变"卡片式"，观感立刻接近稳智。**

---

## 七、遗留证据缺口

以下信息**扒不到**（不编造，明确标注）：

1. 稳智 12 个 Prompt 模板的**完整正文**——100% 在服务端，前端只弹 `ai-matrix-stock-horizon-prompt` dialog 收集字段
2. 5 个 horizon 枚举值的 **regex 检测规则**——在 `resolveTradingHorizonForInput` 实现里，位置未知
3. 完整 API 路径字面量——被 minified 成别名符号，需分析 `index-CIqKZD8S.js`（本次未纳入）
4. 完整路由表——在 `wenzhi-app.js`（未下载）
5. `AiMatrixHome-D20s36eF.css` 128KB 未逐条穷举，只提取了关键 token
6. 稳智 4 张截图的**原图**——用户消息里贴的是压缩版本，我这里读不到原分辨率
7. 图片上传的具体 endpoint——不在主 bundle 里
8. `yr` 数组（action 选项，含 buy/sell/absorb/trade_t）——只在 L4 dialog 消费，未找到定义
