# P25 LLM 分析/AI 对话分离（稳智对齐 P1 #3）

## 对齐目标

稳智逆向扒出的菜单是 9 项：大盘情绪 / 量化因子选股 / 行业 / 行情 / 自选 / **LLM分析** / 奇门遁甲 / **稳智AI** / 订阅账号与点数。其中「LLM 分析」和「稳智 AI（AI 对话）」是两个独立的一级菜单项。

本仓库原来是合并成一个"AI 对话"菜单项（key: copilot，legacyPages: ["aihome", "analysis", "research", "agent"]）。P25 拆成两个菜单项：
- **"LLM 分析"**（key: copilot，指向 AssistantPage，深度分析，带 Agent Loop、工具调用、步骤时间线）
- **"AI 对话"**（key: aihome，指向 AiHomePage，快速问答，空态大输入框，无工具调用）

## 改动分两块

### 1. `src/lib/desk/nav-core.ts`

把原来的 `{ id: "ai", label: "AI 对话", key: "copilot", legacyPages: ["aihome", "analysis", "research", "agent"] }` 拆成：
- `{ id: "assistant", label: "LLM 分析", key: "copilot", legacyPages: ["analysis", "research", "agent"] }`
- `{ id: "ai", label: "AI 对话", key: "aihome" }`

菜单顺序变成：大盘情绪·量化选股·行业板块·行情·自选·全球事件雷达·**LLM 分析**·**AI 对话**·奇门遁甲（9 项）。

### 2. `src/components/desk/Sidebar.tsx`

- 加 `Brain` 图标（LLM 分析用，深度分析）
- GROUP_ICONS 加 `assistant: Brain`
- AI 对话继续用 `Bot` 图标（快速问答）

## 不动地基

- **不改 AppShell.tsx**：页面路由分支不动（`page === "copilot"` 还是渲染 AssistantPage，`page === "aihome"` 还是渲染 AiHomePage）
- **不改 types.ts**：PageKey 类型不动（aihome/copilot 都是合法值）
- **不改 store.ts**：会话管理不动
- **不改后端路由**：API 路由不动
- **不改组件内部**：AssistantPage 和 AiHomePage 内部逻辑不动

## 钉测（更新现有测试）

- `p7-ui-nav.test.ts`：更新 MENU 顺序断言（8 项 → 9 项）；更新 legacyPages 断言（aihome 不再是 legacy）
- `p10-pick-pool.test.ts`：更新 nav-core 断言（AI 对话 → LLM 分析 + AI 对话）
- `p15-r18-news-window.test.ts`：更新 MENU 顺序断言（8 项 → 9 项）

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p7-ui-nav.test.ts` → 12/12 pass
- `npx tsx --test tests/quant/*.test.ts` → 1203 tests / 1193 pass / 1 fail（p2-archive-db 是 tsx 老问题）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **用户看到的变化**：侧栏菜单从 8 项变 9 项，"AI 对话"拆成"LLM 分析"（Brain 图标）和"AI 对话"（Bot 图标）
- **路由行为**：点"LLM 分析"进 AssistantPage（深度分析），点"AI 对话"进 AiHomePage（快速问答）
- **legacy 横幅**：analysis/research/agent 三个旧页的横幅出口从"AI 对话"改为"LLM 分析"（指回 copilot 页）
- **向后兼容**：hash 直达 `#/aihome`、`#/copilot`、`#/analysis` 等旧路由全部照常工作（AppShell 分支不动）
