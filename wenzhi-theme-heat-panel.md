# 稳智「主题热点」面板逆向

> 目标：用户截图中那个「一屏看全」的深色面板——顶部 5 个 Tab（主题热点 / 研究池 / 板块全景看板 / 个股评估矩阵 / 产业链研报分析）+ 左侧主题列表 + 右侧详情（市场环境 / 主题卡 / 主题市场数据 / 理由 / 新闻证据 / 分层与策略）——扒清它到底是怎么做出来的，并给出对齐本仓库的可执行清单。
>
> 证据范围：`.box-agent-scratch/wenzhi-reverse/js/AiMatrixHome-BG9SZzpj.js`（唯一主 bundle，43 行压缩）+ `css/AiMatrixHome-D20s36eF.css`。
> 未取到：稳智后端 API 契约、`theme_heat_all_in_one` 数据 schema 全字段。

---

## 1. 结论先说：这不是一个"页"

用户截图里那个看起来像 dashboard 的东西，**在稳智前端里不是一个 Vue 路由页、不是一个 Vue 组件**。

主 bundle 里只有 10 个组件名（`name:"..."`）：

```
AiMatrixHome
AiMatrixChatTimeline
AiMatrixChatMessageItem
AiMatrixChatStage
AiMatrixAssistantStreamBlock
AiMatrixAssistantSourceStrip
AiMatrixExecutionStrip
AiMatrixComposer
AgentMarkdown
aiMatrix (route)
```

没有 `ThemeHotPage`、`SectorBoard`、`ThemePanel` 之类的名字。CSS 里也没有 `theme-*`、`sector-*`、`research-pool-*` 这种页面级前缀。

那截图里的东西是什么？是**AI 对话回答里的一整块 Markdown + `presentation_meta` 结构化卡片**：

- 顶部那 5 个 "Tab"（主题热点 / 研究池 / 板块全景看板 / 个股评估矩阵 / 产业链研报分析）其实是模型回答里的**追问快捷按钮**——由前端解析出 `suggested_queries` 数组后渲染成胶囊（见 `landingSuggestedPrompts` + `handleLandingSuggestedPrompt`，主 bundle line 41 附近 `Qr = be(() => { const t = (le.value || {})?.suggested_queries; ... })`）。
- 中间的"卡片墙"是 `presentation_meta.sections` 数组里的一段一段 `stream-section`，每段有 `icon / title / tone / status / content` 五个字段。
- 底部那张"最终关注清单"是可点击的股票卡——CSS 类前缀 `run-report-stock-card`、`run-report-theme-chip`。

**证据锚点**：
- `AiMatrixHome-BG9SZzpj.js:41` 附近 `Ln(t)` 函数：`return Array.isArray(o.data_debug?.loaded_blocks) ? o.data_debug.loaded_blocks : [] … includes("theme_heat_all_in_one")`——`theme_heat_all_in_one` 是**后端喂给 LLM 的一个数据块名**，不是前端组件。
- 同段 `_r(t)` 函数：`for(const H of n.split("\n")){ … oe==="核心判断" ? b="judgement" : oe==="板块/概念焦点" ? b="themes" : oe==="最终关注清单" ? b="watchlist"`——前端**只是把 LLM 回答按行拆到三栏**，然后当"追问输入建议"用。
- `run-report-panel` / `run-report-themes` / `run-report-watchlist-grid` / `run-report-stock-card` / `run-report-theme-chip` 全在 `AiMatrixHome-D20s36eF.css`，全部挂在一个 `<script setup>` 作用域 `data-v-796a2a19` 下。

**一句话**：稳智没有"页"，只有"AI 输出的一段回答被前端渲染得像个 dashboard"。

---

## 2. 前端渲染管线：3 层壳

从外到内一共三层容器，每层都有自己的边框、padding、gap，叠出来就是那个"信息密度极高"的效果。

### 2.1 外层：`.ai-execution-strip` (Agent Loop 顶栏)
- CSS：`.ai-execution-strip[data-v-f04f1d5c]`
- 作用：Agent Loop 6 阶段（intent / skills / local_data / external_data / research / answer）的**横向状态条**，可折叠 `is-collapsed`。
- 这就是用户截图中最上面那条"主题热点 | 研究池 | 板块全景看板 | 个股评估矩阵 | 产业链研报分析"——**其实不是 Tab 栏，是 Agent Loop 步骤条**，或者更准确地说是 `suggested_queries` 胶囊条。

### 2.2 中层：`.stream-section`（分区卡）
CSS 定义（`AiMatrixHome-D20s36eF.css`）：

```css
.stream-section {
  background: #ffffff08;                    /* 深色 5% 白 */
  border-left-color: #ffffff24;             /* 左边一条 15% 白细边 */
  /* 结构 */
  display: flex;                            /* 有 icon / main 两栏 */
}
.stream-sections {
  display: grid;
  grid-template-columns: 1fr;               /* 单列纵排 */
  gap: 12px;
  margin-bottom: 14px;
}
.stream-section-header { align-items: center; gap: 8px; margin-bottom: 8px; }
.stream-section-icon { font-size: 18px; line-height: 1; }     /* 就是 emoji */
.stream-section-title { font-size: 15px; font-weight: 600; }
.stream-section-content { font-size: 13px; line-height: 1.6; color: text-secondary; }
.stream-section-status {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  background: #ffffff0f; color: text-muted;
}
/* 状态色（左侧边条） */
.is-active  → border-color: #0a84ff47;  status color #0a84ff (蓝)
.is-running → 同 is-active
.is-loading → 同 is-active
.is-done    → border-color: #34c75938;  status color #34c759 (绿)
.is-ready   → 同 is-done
.is-linked-active → border-color: #0a84ff73; box-shadow 0 0 0 2px #0a84ff1a
```

`.stream-section-content` 里的行内标签还有三个魔法类：
```css
.stream-section-content .num-highlight { color: text-primary; font-weight: 600; }
.stream-section-content .stock-code {
  color: text-primary; font-family: Monaco, Menlo, monospace; font-weight: 500;
}
.stream-section-content strong { color: text-primary; font-weight: 600; }
```
→ 模型只要把数字/代码包在这三个标签里，就能自动高亮。**这就是那个"3 日资金 658.30"能一眼看到的原因**。

### 2.3 内层：`.run-report-panel`（最终关注清单）

CSS（`data-v-796a2a19` 同一 scope）：
```css
.run-report-panel { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
.run-report-panel-title { font-size: 13px; font-weight: 700; }

/* 板块/概念焦点：3 列 grid */
.run-report-themes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.run-report-theme-chip {
  border: 1px solid var(--border);
  background: #ffffff0a;
  border-radius: 14px;
  padding: 12px 14px;
}
.run-report-theme-label { font-size: 11px; color: text-muted; margin-bottom: 6px; }
.run-report-theme-text { font-size: 13px; line-height: 1.7; }

/* 最终关注清单：2 列 grid */
.run-report-watchlist-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.run-report-stock-card {
  text-align: left;
  border: 1px solid var(--border);
  background: #ffffff0a;
  border-radius: 16px;
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  transition: transform .16s, border-color .16s, background .16s;
  cursor: pointer;
}
.run-report-stock-card:hover {
  background: #5f81ff14;
  border-color: #5f81ff66;
  transform: translateY(-1px);
}
.run-report-stock-head { justify-content: space-between; align-items: center; gap: 10px; }
.run-report-stock-name { font-size: 15px; font-weight: 700; }
.run-report-stock-code { font-size: 12px; color: text-muted; }
.run-report-stock-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.run-report-stock-tag {
  background: #ffffff0f; border: 1px solid #ffffff14;
  border-radius: 999px; padding: 4px 8px;
  font-size: 11px; line-height: 1.3;
}
.run-report-stock-cta { color: #7ea4ff; font-size: 12px; }   /* "分析 XX 能不能买" */
.run-report-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* 响应式：窄屏全部 1 列 */
@media /* responsive */ {
  .run-report-themes,
  .run-report-watchlist-grid { grid-template-columns: 1fr; }
}
```

### 2.4 `decision-card`（决策结论卡）
```css
.decision-card {
  border: 1px solid var(--border);
  background: #ffffff08;
  border-radius: 14px;
  width: 100%;
  margin: 0 auto 12px;
  overflow: hidden;
}
```
截图里"市场环境卡（橙色边框，退潮反抽 / 震荡 / 置信度 0.62 / as_of 2026-09-18）"用的就是这个壳。

---

## 3. 数据结构：`presentation_meta` schema

主 bundle 里 `Lt(t)` 和 `createDefaultV2Flow()` 暴露了稳智前端期望的完整 schema（`AiMatrixHome-BG9SZzpj.js:41`）：

```ts
type FrontendFlow = {
  version: string;                 // schema_version
  scenario: string;                // 场景（如 "theme_heat"）
  sub_type: string;                // 子类型
  answer_content: string;          // canonical markdown
  canonical_markdown: string;      // 同 answer_content，双写
  streaming_markdown: string;      // 流式过程稿
  answer_state: "idle" | "researching" | "answer_streaming"
             | "finished" | "degraded" | "incomplete" | "failed";
  presentation_meta: {
    schema_version: string;
    density: "compact" | ...;       // 密度策略
    divider: { style, intent, weight, spacing };  // 分隔条
    emphasis: { title, section, body, disclaimer }; // 强调等级
    sections: [
      // 每个 section = 一个 .stream-section
      {
        icon: string;         // emoji，直接 font-size:18px 渲染
        title: string;        // 15px 600 粗
        tone: "primary" | "info" | "success" | "warning"
            | "danger" | "default";  // 左边框色
        status: "active" | "running" | "loading"
              | "done" | "ready";   // 状态胶囊色
        linked_active: boolean;      // 点击时高亮
        content: string;     // markdown-lite，含 .num-highlight / .stock-code
      }
    ],
    dividers: []
  };
  live_status: {
    started_at_ms: number;
    last_event_at_ms: number;
    last_stage_at_ms: number;
  };
  steps: [                        // Agent Loop 6 步
    {
      key, step, sort_index,
      label,             // 如 "Agent Loop" / "技能选择" / "本地插件数据"
      step_kind,         // "tool_call" 等特殊标记
      status: "pending" | "active" | "done",
      detail: string,    // 最长截 80 字
      duration_ms: number
    }
  ];
  warnings: string[];         // 最多 12 条，超出截尾
  data_debug: {
    loaded_blocks: string[];   // 后端注入的数据块名，例如
                               //   "theme_heat_all_in_one", "run_report_context"
    ...
  };
}
```

---

## 4. 数据流：`theme_heat_all_in_one` 是什么

`theme_heat_all_in_one` 是**后端注入给 LLM 的一个大数据块**——用户截图里那 6 个主题的完整字段（热度、趋势标签、3 日资金、理由、新闻证据、分层决策、评分、置信度、as_of）就是这一块。

前端的检测函数 `Ln(t)`：
```js
function Ln(t) {
  if (!t || t.role !== "assistant") return false;
  const text = assistantDisplayContent(t);
  if (text.includes("已调取昨日 run 报告") || text.includes("最终关注清单")) return true;
  const flow = getMessageFrontendFlow(t);
  return (flow.data_debug?.loaded_blocks || [])
    .some(b => ["run_report_context", "theme_heat_all_in_one"].includes(b));
}
```
→ 前端**完全不消费这个块的字段**，它只是被 LLM 当输入材料喂，然后 LLM 用自然语言写回答案，前端再按行解析成 `judgement / themes / watchlist` 三分类。

这个设计意味着：
- **字段变化不影响前端**——只要 LLM 输出结构不变，前端 CSS 不用动。
- **前端不做数据可视化**——没有柱图、没有折线、没有 K 线。全是文字 + `.num-highlight` 强调。
- **"看得到"的信息密度靠的是排版**：3 列主题 grid、2 列股票 grid、6 步 Agent Loop 状态条。

---

## 5. 视觉风格清单（可直接抄）

| 维度 | 值 |
|---|---|
| 底色 | `var(--bg-card)` 或 `#00000005` (dark) / `#ffffff05` (light) |
| 卡片边框 | `1px solid var(--border)` |
| 圆角 | chip 14px / stock-card 16px / tag 999px（全圆）|
| 主字号 | 13px 正文、15px 标题、11px 标签、12px 副标、10.5px 说明 |
| 数字强调 | `color: var(--text-primary); font-weight: 600;`（无背景色）|
| 股票代码 | `Monaco, Menlo, monospace; font-weight: 500;` |
| 主色 | `#0a84ff` 蓝（active）/ `#34c759` 绿（done）/ `#5f81ff` hover 主蓝 |
| 间距 | section 之间 12px、section 内部 8–14px、tag 内 4×8px |
| 阴影 | `.is-linked-active { box-shadow: 0 0 0 2px #0a84ff1a; }` |
| 过渡 | `transform .16s, border-color .16s, background .16s` |
| hover 上移 | `translateY(-1px)` |
| 状态徽章 | `padding: 2px 8px; border-radius: 10px; background: #ffffff0f;` |

---

## 6. 本仓库差距清单（P0 → P2）

### P0 — 缺失关键能力（1–2 天）
1. **没有 `presentation_meta.sections` 结构化卡片**  
   本仓库 AssistantPage 的 Markdown 渲染是纯 `AgentMarkdown` 直出，没有"icon + title + tone + status + content"的分节容器。  
   → 新组件 `src/components/desk/StreamSection.tsx`：`<StreamSection icon="🔥" title="市场环境" tone="warning" status="done">内容 markdown-lite</StreamSection>`，样式照抄上面 CSS。
2. **没有 `.num-highlight` / `.stock-code` 行内魔法标签**  
   数字和股票代码没有区分开，读者要自己扫。  
   → 在 `AgentMarkdown` 的渲染管线加两个 `<span class>` 拦截规则，或改成 markdown 插件。
3. **没有 `run-report-watchlist` 股票卡组件**  
   截图右下角那个"最终关注清单"网格目前本仓库完全没有对应物。  
   → 新组件 `src/components/desk/RunReportPanel.tsx`，含 `RunReportThemeChip`（3 列）+ `RunReportStockCard`（2 列，可点击跳画像）。

### P1 — 提升信息密度（3–5 天）
4. **Agent Loop 状态条 `.ai-execution-strip`**  
   本仓库有 StepTimeline，但样式是竖排、无折叠、无 `is-collapsed` 切换。  
   → 改 `StepTimeline` 支持横向 6 段 pill + 折叠 + `duration_ms` 显示。
5. **追问建议条 `landingSuggestedPrompts`**  
   稳智在回答末自动算 3 条追问："分析 XX 能不能买"、"分析 XX 这个方向还能不能做"，前端解析后当胶囊按钮。  
   → 在 `use-chat.ts` 完成流时扫 `suggested_queries` 或从 answer 里正则出 `themes.slice(0,3)` + `watchlist[0]`，末尾追加胶囊。
6. **`decision-card` 决策卡**  
   现在本仓库只有 SourceStrip（来源卡）+ StepTimeline（步骤卡），没有决策卡。  
   → 新组件 `DecisionCard.tsx`：置信度 + as_of + 结论 tag + 主文，橙色/蓝色 border-left。

### P2 — 视觉打磨（可选）
7. `stream-section-content .num-highlight` 高亮数字的自动化 markdown 转换器（把 `+7.26%`、`658.30 亿` 自动加 span）。
8. `linked_active` 状态——点击某个 section 时高亮边框 + 阴影。
9. `stream-section-skeleton` / `stream-section-placeholder` 骨架屏——流式加载时占位。

---

## 7. 一句话总结

稳智这个"一屏看全"的面板，**本质是"后端把结构化数据块（`theme_heat_all_in_one`）喂给 LLM，LLM 用自然语言写回答，前端再按 `presentation_meta.sections` 把回答切成一片片 `.stream-section` 卡片，最后用 CSS 的 grid + border-left + 状态色 + 数字高亮把密度拉满"**。

它没有"页"、没有"图表组件"、没有"独立数据 API"——它靠的是**一段精心编排的 Markdown + 一套紧凑的 CSS 卡片系统**。

要复刻，别新建 `/sectors` `/themes` 路由；在 AI 回答里长出新组件就行。
