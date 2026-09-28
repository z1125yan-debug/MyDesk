# 稳智 AI 前端逆向 × 本仓库 UI 对照

_生成时间：2026-09-23 17:59  ·  证据锚点：`.box-agent-scratch/wenzhi.html`（15052 字节，剥了 `data-v-*` scoped attr 后 93 个业务 class）+ `screenshots/01~15-*.png` + `src/components/desk/**`_

## 一、稳智源码扒出的结构信息（Step 1）

### 1.1 技术栈（head 依赖）

| 依赖 | 用途 |
|---|---|
| `rolldown-runtime` + `element-plus-vendor` | Vue 3 + Element Plus（构建器 rolldown） |
| `element-plus-date / form / overlay / select / table` | 组件分包 |
| `router-vendor / http-vendor` | Vue Router + axios 分包 |
| `dayjs-vendor` | 时间 |
| 远程 `AiMatrixHome-*.js` + `useAiMatrixDebugView-*.js` + `flowVisualRegistry-*.js` + `agentStepTimeline-*.js` | AI 对话主页 + 调试视图 + 流可视化 + Agent 步骤时间线（都从 `aiwuchuan.com` 拉） |

**信号**：主 bundle 拆得极碎（13 个 modulepreload），AI 相关代码全部外链到 CDN，说明 AI 对话是**独立产品线**，跟行情/自选等原生业务是两套。

### 1.2 顶部导航（`top-nav-wrapper` / `top-nav`）

```
top-nav-wrapper
  └─ top-nav
      ├─ nav-header            → 单按钮 icon-btn「收起侧边栏」(svg 16x16)
      └─ nav-content
          ├─ nav-scroll-area
          │   └─ el-menu professional-menu
          │       ├─ 大盘情绪 / 量化因子选股 / 行业 / 行情 / 自选 / LLM分析 / 奇门遁甲 / 稳智AI(is-active) / 订阅账号与点数
          │       └─ (每项 = el-menu-item → el-icon.menu-icon(svg 1024) + span.menu-text)
          ├─ nav-history-section
          │   ├─ nav-history-header  → 「最近」+ history-collapse-icon(is-expanded)
          │   └─ nav-history-box > nav-history-list  → empty-text「暂无历史」
          └─ auth-action  → el-button--primary--small「登录」
```

**关键判断**：
- 菜单**完全一级平铺**（9 项），没有二级展开的 `el-submenu`。
- 侧栏底部三件事：菜单本体 → 历史区 → 登录按钮，从上到下三段。
- 历史区默认折叠态（`is-expanded`）显示"暂无历史"占位，说明这是**会话历史**，不是收藏。

### 1.3 AI 对话主区（`ai-matrix-page`）

```
ai-matrix-page.is-empty-state
  └─ layout
      └─ right
          ├─ section-head (apple-fade-in)
          │   └─ right-actions
          │       ├─ el-button is-text top-action「新对话」
          │       └─ el-button is-text top-action「钱包」
          ├─ content-stage.is-empty (apple-slide-in)
          │   └─ chat-stage-stack.empty
          │       └─ composer.is-empty-state
          │           └─ composer-inner
          │               ├─ composer-hero
          │               │   └─ composer-hero-title「向稳智AI提问」
          │               ├─ input-card
          │               │   └─ input-card-body.inline
          │               │       ├─ el-dropdown > button.mode-selector
          │               │       │   ├─ span.mode-selector-icon ⚡
          │               │       │   ├─ span.mode-selector-label「决策模式」
          │               │       │   ├─ span.mode-search-dot (title="实时搜索已开启")
          │               │       │   └─ el-icon.mode-selector-arrow
          │               │       ├─ button.attach-btn (aria-label="上传图片")
          │               │       ├─ input[type=file].hidden-file-input
          │               │       ├─ el-textarea > textarea[data-testid=ai-matrix-question-input]
          │               │       │   placeholder="输入股票代码、板块或您的投资疑问..." rows=2
          │               │       └─ button.send-btn[disabled] (aria-label="发送")
          │               └─ prompt-recommend
          │                   ├─ prompt-recommend-head
          │                   │   ├─ prompt-recommend-title「💡 试试这样问」
          │                   │   └─ prompt-recommend-toggle「展开更多 6 条 ⌄」
          │                   └─ prompt-recommend-grid
          │                       ├─ prompt-recommend-card: 🔎 七维分析一只股票
          │                       └─ prompt-recommend-card: 🧭 按成本制定持仓计划
```

**关键判断**：
- Composer **只有空态**这一种画法（`is-empty-state` 三处），说明有数据/有对话时 UI 会整个换掉——源码没给我看对话中态。
- Mode selector 是**内嵌在输入框左上角**的下拉按钮（不是 chip 条，也不是顶栏）。
- 右侧 `mode-search-dot` 是**状态指示灯**（title="实时搜索已开启"），不是按钮。
- Prompt-recommend 是 2 卡展开态 + "展开更多 6 条" 收起 6 条，共 8 条推荐。
- 有 `attach-btn`（上传图片）+ `hidden-file-input`（accept 4 种图片格式）——**支持多模态**，我们的输入框没有。

### 1.4 模式选择器 dropdown（4 项 + 2 分隔线）

```
ai-mode-dropdown > el-dropdown-menu (id=el-id-6205-1)
  ├─ ⚡ 决策模式       ← dropdown-mode-check 图标（选中）
  ├─ ◈ 研判模式
  ├─ <li role=separator>
  ├─ 🧠 深度思考
  ├─ <li role=separator>
  └─ [search-icon] 实时搜索  ← dropdown-mode-check 图标（选中，跟搜索 dot 对应）
```

**关键判断**：
- 4 项里**「决策/研判」是二选一，「深度思考」是附加开关，「实时搜索」是附加开关**——不是简单的单选 4。
- 分隔线是**语义分组**（前两项互斥 / 中项独立 / 后项独立），不是纯视觉分隔。
- `dropdown-mode-check` 图标同时出现在「决策模式」和「实时搜索」上，说明**多选模式**（互斥组 + 开关组）。

### 1.5 主题与状态

- `<html data-theme="light">` + localStorage 键 `theme` + `prefers-color-scheme` fallback，`dark` 类挂在 `documentElement`。
- **CSS 变量只出现 1 处**：`var(--text-muted)`——真正样式在 CSS 文件里，HTML 源码里看不到设计 token。

### 1.6 6 个 Vue 组件边界（`data-v-*` 计数）

| Scoped ID | 出现次数 | 推断组件 |
|---|---|---|
| `101a5e96` | 57 | Sidebar（`top-nav`） |
| `2be8d124` | 6 | 根容器（`app-container`） |
| `796a2a19` | 9 | `ai-matrix-page` 主组件 |
| `9eda867c` | 2 | `error-boundary` |
| `6562e700` | 2 | `chat-stage-stack` |
| `c1f5612b` | 43 | `composer` + dropdown（最内层、最密） |

**信号**：稳智的 Composer 组件最重（43 处 scoped），Sidebar 次之（57 处），根容器最轻（6 处）——**对话交互是重心**。

---

## 二、4 张截图交叉验证（Step 2）

| 截图 | 内容 | 源码没渲染但截图有的 |
|---|---|---|
| 图 1 AI 分析报告（深色） | 长文回答 + Agent 步骤时间线 | `agentStepTimeline` 远程组件 |
| 图 2 行业主题（浅色） | 主题血缘卡片 + 资金流图 | 血缘可视化（`flowVisualRegistry`） |
| 图 3 概念主题（浅色） | 同上，概念维度 | 同上 |
| 图 4 AI 分析详情（深色） | 报告分节 + 图表 | `useAiMatrixDebugView` |

**结论**：源码只给了**空态**，截图里那些"血缘卡 / Agent 步骤 / 调试视图"都是运行时动态渲染，源码扒不出来——这解释了为什么源码里只有 4 个 modulepreload 但截图内容丰富。

---

## 三、横向对照本仓库（Step 3）

### 3.1 侧栏

| 维度 | 稳智 | 本仓库 (`Sidebar.tsx` + `nav-core.ts`) | 差距 |
|---|---|---|---|
| 一级菜单数 | 9 项 | 7 项 + 2 系统项 | ✅ 顺序、命名基本对齐 |
| 二级展开 | 无（纯平铺） | 3 项有二级（quant/sectors/quotes） | ⚠️ 稳智是"平铺后单点进入"，我们是"平铺后展开子项" |
| 品牌区 | 无（直接是 icon-btn 收起按钮） | 有 Logo + 名称 + 副标题 | ❌ 我们多了 60px 品牌区 |
| 历史区 | 有「最近」+ 会话历史列表 | 无 | ❌ **缺对话历史入口** |
| 底部 | `auth-action`「登录」按钮 | 状态灯 + 设置齿轮 | ⚠️ 语义不同（登录 vs 状态） |
| 收起侧栏按钮 | 有 `icon-btn` | 无（`menuOpen` 只是开关系统弹层） | ❌ 不能折叠侧栏 |

### 3.2 AI 对话页

| 维度 | 稳智 (`AiHomePage.tsx` 对应位置) | 本仓库 (`AiHomePage.tsx`) | 差距 |
|---|---|---|---|
| 空态 Hero 标题 | `composer-hero-title`「向稳智AI提问」 | `h1`「有什么想问问市场？」 | ⚠️ 文案口径不同 |
| 输入框形态 | `apple-card` + `input-card-body.inline` 圆角胶囊 | `apple-card` 圆角卡片 | ✅ 视觉一致 |
| 模式选择器位置 | 输入框内左上角，`mode-selector` 按钮 | 输入框**外**左侧，`ChatModeMenu` 按钮 | ⚠️ **在框外，稳智是嵌在框内** |
| 模式选择器形态 | 4 项 + 2 分隔线，图标用 emoji + SVG | 单选列表 + label/desc 两行 | ❌ **稳智是多选（互斥+开关），我们是单选** |
| 搜索状态指示 | `mode-search-dot`（title="实时搜索已开启"） | 无 | ❌ 缺"实时搜索开关"状态灯 |
| 上传附件 | `attach-btn` + `hidden-file-input`（4 种图片） | 无 | ❌ **缺多模态入口** |
| 发送按钮 | `send-btn`（禁用态） | 蓝色方形按钮 | ✅ 视觉一致 |
| 推荐问题 | `prompt-recommend-grid` 2 卡 + "展开更多 6 条" 共 8 条 | 7 个 chip 平铺（`flex-wrap`） | ⚠️ 稳智是**卡片式 + 可折叠**，我们是**平铺 chip** |
| 顶部动作 | `new对话` + `钱包` | 顶部搜索框 + 主题切换 + AI 就绪胶囊 | ❌ **稳智有"钱包"入口，我们没做付费/点数** |
| 欢迎文案 | `composer-hero-title` | 大 h1 + 副标题 | ⚠️ 我们更重，稳智更轻 |
| 底部信息 | 无（源码空态） | 「今日市场」速览卡 | ✅ 我们多一个实时概览 |

### 3.3 视觉走查 15 页里的关键问题（已截图确认）

- **`02-board.png`**：表格「所属行业」列 9 行全部显示"—"，是数据缺口；右侧气泡图占位提示"点击左侧榜单…"，弱空态。
- **`13-radar-nolineage.png`**：资金类卡片「连续流入 暂无 日」反复出现——字段级缺数据。
- **10/26 页已收拢 LineageCard**，16 页未收拢（含 RadarPage/ProbabilityPage/EventsPage 等）。

---

## 四、差异清单（Step 4）

### 🔴 缺失功能（4 条）

1. **对话历史入口** —— 稳智侧栏有 `nav-history-section`「最近」+ 可折叠会话列表；我们没有。→ **加在 Sidebar 底部、状态灯上方**，接 `useDesk.assistantSessions`。
2. **多模态输入（图片上传）** —— 稳智有 `attach-btn` + `hidden-file-input`（jpeg/png/gif/webp）；我们只有纯文本 textarea。→ 若不做多模态，至少留个 attach 位占位，未来接入视觉问答。
3. **实时搜索开关** —— 稳智 `mode-search-dot` 状态灯 + dropdown 里的「实时搜索」开关；我们没这个概念。→ 接在 `ChatModeMenu` 里，让 AI 能主动查网络。
4. **钱包 / 点数入口** —— 稳智 `right-actions` 有「钱包」按钮；我们在 AI 对话页无付费/点数面板。→ 若暂不做商业化，可在设置页补一个"点数用量"占位。

### 🟡 组件差异（4 条）

1. **模式选择器是单选而非多选** —— 稳智 4 项 = 互斥组（决策/研判）+ 独立开关（深度思考/实时搜索），我们 `CHAT_MODES` 是纯单选。→ 建议改成 **1 组互斥 + 2 个开关** 的复合选择器。
2. **推荐问题是平铺 chip 而非卡片** —— 稳智 `prompt-recommend-card` 是 2 列网格 + 「展开更多 N 条」折叠；我们是 5 个 chip 一次性平铺。→ 改成 2 列网格 + 折叠，能承载更多推荐问。
3. **模式选择器位置在框外** —— 稳智嵌在 `input-card-body.inline` 内左上角，视觉一体；我们 `ChatModeMenu` 和输入框是并排 sibling。→ 移到输入框**内左侧**，做成 `input-card-body` 的一部分。
4. **无"收起侧边栏"按钮** —— 稳智 `nav-header` 有 `icon-btn` 折叠按钮，我们可以加同款（Sidebar 收到 60px 窄栏）。

### 🟠 交互习惯差异（3 条）

1. **一级菜单语义** —— 稳智「量化因子选股」是**单页进入后内部再分**（选股器/因子/池），我们直接展开成 6 个子项。**稳智的做法更适合"一件事一页"的用户**，我们的做法适合"扫一眼知道有几件事"的用户。这是取向选择，不是 bug——但要在 worklog 里明确记录口径。
2. **AI 就绪状态显示位置** —— 稳智把「钱包」放右上角作为常驻入口；我们「AI 就绪」胶囊放顶部搜索框右侧，跟"搜索/主题切换"混在一起。**建议把 AI 就绪改造成右上角独立胶囊**，跟钱包位对齐。
3. **底部状态 vs 底部登录** —— 稳智底部是「登录」主按钮，我们是「已连接实时行情」状态灯。**稳智的登录是转化漏斗，我们的状态灯是产品自信——两种取向都成立**，但要确认我们的定位。

### 🟢 视觉细节差异（3 条）

1. **菜单图标** —— 稳智用 1024 viewBox 的 SVG（`el-icon.menu-icon`），我们用 `lucide-react`（24 viewBox）+ emoji。**lucide 更清爽**，不建议换回 1024 viewBox。
2. **推荐问前缀** —— 稳智用 emoji（🔎 / 🧭 / 💡），我们用 lucide 图标。emoji 更亲和，图标更专业，**保持现状**。
3. **Hero 标题** —— 稳智「向稳智AI提问」4 字，我们「有什么想问问市场？」8 字 + 副标题。**我们更啰嗦**，建议精简到 6 字以内，副标题可保留。

### 🔵 技术栈差异（1 条）

- 稳智：Vue 3 + Element Plus + rolldown，AI 部分外链 CDN（`aiwuchuan.com/assets/AiMatrixHome-*`）。
- 我们：Next.js 16 + React 19 + Tailwind 4 + shadcn/ui + Radix，全本地。
- **结论**：技术栈差异不影响 UI 决策，但稳智 AI 组件的"独立 CDN"策略暗示他们把 AI 视为**可独立发版的产品线**——如果我们要把 AI 对话拆成微前端/独立子应用，可以借鉴这个边界。

---

## 五、可执行建议（按性价比排序）

| 优先级 | 项 | 工作量 | 用户价值 |
|---|---|---|---|
| P0 | 模式选择器改「互斥 + 开关」复合选择 | 1 天 | ⭐⭐⭐ |
| P0 | 模式选择器移到输入框内左侧 | 0.5 天 | ⭐⭐⭐ |
| P1 | 加对话历史入口（Sidebar 底部） | 1 天 | ⭐⭐⭐ |
| P1 | 推荐问题改 2 列网格 + 折叠 | 0.5 天 | ⭐⭐ |
| P2 | 实时搜索开关 + 状态灯 | 1.5 天 | ⭐⭐ |
| P2 | 收起侧栏按钮 | 0.5 天 | ⭐ |
| P3 | 上传附件按钮占位 | 1 天（无后端） | ⭐ |
| P3 | 钱包/点数面板占位 | 1 天 | ⭐ |
| P4 | 16 页 LineageCard 收拢 | 5 天 | ⭐⭐ |
| P4 | 修 3 个已知 bug（`absolute_index===0` / 9 位截断 / `BubbleFlow unitLabel`） | 0.5 天 | ⭐⭐⭐ |

---

## 六、口径记录（补进 worklog.md）

- 2026-09-23 17:59：完成稳智 AI 前端 HTML 逆向（15052 字节，93 个业务 class，6 个 Vue 组件边界），并与本仓库 26 页 UI 做了五类差异对照。源码只覆盖 AI 对话空态，对话中态与血缘可视化需靠运行时（`agentStepTimeline` / `flowVisualRegistry` / `useAiMatrixDebugView` 远程组件）才能看到——本次没扒。
- 稳智的 Composer 是重心（scoped `c1f5612b` 出现 43 次），Sidebar 次之（57 次）；本仓库重心应保持一致。
- 侧栏一级菜单数量：稳智 9 项 vs 我们 7+2 项；差异来自"LLM分析/稳智AI"被拆开且我们做了子项展开——语义等价。
