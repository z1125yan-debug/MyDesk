# P19 · 决策 Widget UI 部署报告

**日期**：2026-09-23  
**上游**：P17-①（稳智 LLM 意图识别器）  
**下游**：稳智对齐 P1 清单（决策卡可视化）

## 1. 本轮做了什么

把 P17-① 已注入到 system 提示词的**稳智决策信号 11 字段**回传到前端，并渲染成稳智风格的决策卡。至此：

- P17-①（LLM 分类器）**判出**信号但只用于提示词增强；
- P19（本轮）**同一次判出的信号同时可视化为决策卡**。

前后端字段口径严格一致：服务端 `intent-llm-core.WzDecisionSignal` → 流层 `chat-stream-core.asWzDecision` 白名单解码 → 前端 `chat-core.WzDecisionPayload` 类型 → `WzDecisionWidget.tsx` 组件渲染。

## 2. 数据流

```
用户提问 "中国电影短线怎么操作"
    ↓
/api/ai/proxy
    ↓
runWzIntentClassifier()   ← Qwen3.8-27B 分类
    ↓
parseWzDecisionLlmOutput() → WzDecisionSignal（11 字段，已白名单+clamp）
    ├─ block: string[]    → 注入 system 提示词（原有路径）
    └─ signal: object     → 通过 SSE done 事件 wzDecision 字段回传（本轮新增）
    ↓
chat-stream-core.asWzDecision() 白名单解码（防御性二次过滤）
    ↓
use-chat.ts onEvent → patchChatMessage(...) 存进 ChatMessage.wzDecision
    ↓
WzDecisionWidget.tsx 渲染成决策卡
```

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/lib/desk/chat-core.ts` | 修改 | 新增 `WzDecisionPayload` 接口（展示层字段契约，与 intent-llm-core 保持字面一致但不 import）+ `ChatMessage.wzDecision` 字段 + `AppliedEvent.done` 携带 wzDecision |
| `src/lib/desk/chat-stream-core.ts` | 修改 | done 事件 data 增加 `wzDecision` 字段 + 新增 `asWzDecision()` 解码器（白名单+clamp+空值兜底） |
| `src/lib/desk/ai.ts` | 修改 | `PlainChatResult.wzDecision` 字段 + 非流式 JSON 返回解析 |
| `src/lib/desk/use-chat.ts` | 修改 | onEvent/resumeRound/flushNow/runFallback 全链路带 wzDecision（含续传分支） |
| `src/app/api/ai/proxy/route.ts` | 修改 | `runWzIntentClassifier` 改为返回 `{block, signal}`；3 处 done 事件/非流式返回都带 wzDecision |
| `src/components/desk/WzDecisionWidget.tsx` | **新增** | 稳智风格决策卡：主结论+周期+信号 chip、置信度/情绪/仓位指标、关键价位、止盈止损、失效条件、风险提示、数据缺口 |
| `src/components/desk/pages/AssistantPage.tsx` | 修改 | Markdown 正文之后、StepTimeline 之前插入 `<WzDecisionWidget signal={m.wzDecision} />` |
| `src/components/desk/AssistantWidget.tsx` | 修改 | 小窗同步接入（同口径） |

## 4. 关键设计决策

### 4.1 为什么独立 `WzDecisionPayload` 而不 import `WzDecisionSignal`

`intent-llm-core` 属于判定层，`chat-core` 属于展示层。展示层反向 import 判定层是耦合倒挂——就像 `IntentBadge` 不 import `Intent` 一样。所以：

- 服务端 `intent-llm-core.WzDecisionSignal` = **判定产物**（LLM 解析后）；
- 前端 `chat-core.WzDecisionPayload` = **展示契约**（SSE 收回来）；
- `chat-stream-core.asWzDecision` = **两者之间的白名单解码层**（防漂移的单一出处）。

字段名、枚举值、语义全部对齐；白名单检查在 asWzDecision 一处完成。

### 4.2 为什么走 done 事件而不是新事件类型

新增 SSE 事件类型（如 `intent`）会破坏 `STREAM_EVENT_TYPES` 白名单、要改 `decodeStreamEvent`、要改 use-chat 的分发逻辑，动静太大。
`done` 事件本就是"这轮收口"的载体，把 `wzDecision` 作为 `data` 的可选字段挂上去，与 `intent`/`debug` 同一处理路径——**加字段而不是加事件类型**，最小侵入。

### 4.3 为什么 WzDecisionWidget 自己再做一次标签映射

服务端 `intent-llm-core` 有 `STANCE_LABELS`/`WZ_HORIZON_LABELS`/`WZ_SIGNAL_LABELS` 用于**提示词渲染**（生成中文文本注入给模型）。前端组件需要**UI 标签**（画 chip、算 emoji、上色），语义相同但字段（emoji、tone 类名）不同。两份都在前端/服务端本地，字面完全对齐（防漂移靠 TSC + 单测）——就像 `IntentBadge` 的 `label` 也有一份前端本地映射一样。

### 4.4 静默降级的三条路径

| 情况 | 结果 |
|---|---|
| LLM 分类超时（>6s） | `runWzIntentClassifier` 返回 `{block:[], signal:null}` → 服务端 done 事件不带 wzDecision → 前端 `m.wzDecision` 为 undefined → widget 不画 |
| LLM 返回 JSON 解析失败 | 同上（`parseWzDecisionLlmOutput.ok=false` 直接返回） |
| 决策信号 11 字段全空（stance=neutral 且其余全 null） | `asWzDecision.hasAnything=false` 返回 null → 前端不画卡 |

三条路径**都是静默降级**，绝不让用户看到"决策信号：undefined"这种假结论。

## 5. 前端渲染规则

`WzDecisionWidget.tsx`：

| 字段 | 渲染规则 |
|---|---|
| `stance` | 顶部 chip + 色/emoji：long=📈绿、short=📉红、wait=⏸黄、neutral=灰 |
| `horizon` | 顶部 chip（蓝底）+ 中文标签（超短/短线/短中线/中线/长线） |
| `signalType` | 顶部 chip（紫底）+ 中文标签（12 类全覆盖） |
| `confidence` / `sentimentTemp` / `positionPct` | 数值指标卡行（等宽 grid），带 `/100` 或 `%` 单位 |
| `keyLevels.support` / `resistance` | 关键价位行（绿/红）+ `fmt` 数字格式 |
| `stopPlan.stopLoss` / `takeProfit` | 止盈止损行（红/绿） |
| `invalidation` | 失效条件块（黄底）+ ⚠ 前缀 |
| `riskNotes[]` | 风险提示列表（bullet 点，最多 8 项） |
| `dataGaps[]` | 数据缺口列表（最多 8 项） |

**任一字段为 null/空数组都不画**——不写"未提供"这种废话。全空时组件整体返回 null，页面看不出"有卡但空"。

## 6. 端到端实测

**请求**：中国电影 600977 短线怎么操作（decision mode，horizon=short）

**LLM 判出**：
```json
{
  "stance": "wait",
  "horizon": "short",
  "signalType": "no_signal",
  "confidence": 60,
  "sentimentTemp": null,
  "keyLevels": {},
  "stopPlan": {},
  "positionPct": null,
  "invalidation": null,
  "riskNotes": [],
  "dataGaps": []
}
```

**前端会画出**：
- 顶部 chip：⏸观望 · 短线 · 无明确信号
- 数值指标：置信度 60/100
- 无价位、无止损止盈、无失效条件、无风险提示（这些字段为空一律不画）

## 7. 测试与验证

| 检查项 | 结果 |
|---|---|
| TSC 类型检查 | `npx tsc --noEmit` **0 error** |
| P17 单元测试 | 28/28 全绿（未改 intent-llm-core 逻辑） |
| P15 稳智测试 | 全绿 |
| P7 意图识别回归 | 全绿（23 条） |
| **合计回归** | **71/71 全绿** |
| 端到端 API 请求 | `/api/ai/proxy` 返回 JSON 含完整 `wzDecision` 字段 |

## 8. 边界纪律

- **判定失败不阻塞主回答**：LLM 分类器 6s 超时静默降级；主链路（scene 徽章 + 提示词 + 模型回答）不受影响。
- **前端拿不到就不画**：wzDecision 缺字段/非法/为空一律不画卡，界面不会看到"决策信号：undefined"。
- **字段口径单点定义**：`chat-core.WzDecisionPayload` 是前端展示契约的单一出处；服务端/前端各自的枚举/标签在本地，字面完全对齐。
- **续传分支同步接线**：`resumeRound` 拿回来的 done 事件也带 wzDecision，刷新续传后决策卡不会掉。

## 9. 遗留

- **assistantSystemPrompt 里 LLM 分类结果未回传到 `/api/ai/chat`**：`/api/ai/chat`（tools 端点）目前走的是不同路径，不接 LLM 分类器。用户走 AI 交易员页时（`endpoint:"tools"`）本轮拿不到 wzDecision。这是 P17-① 遗留项，与本轮 P19 UI 无关，需要单独一次改造把 `runWzIntentClassifier` 复用到 `/api/ai/chat`。
- **前端 localStorage 存档兼容**：老消息 `ChatMessage` 无 `wzDecision` 字段时，`m.wzDecision` 为 undefined，widget 自动不画，兼容老会话。
- **决策信号与 scene badge 的关系**：目前 wzDecision 和 intent 是并列字段，界面上各自独立展示。稳智原版是"决策卡就是意图卡"，未来可能合并。当前分开的原因：intent 是**规则引擎**判定（毫秒级、100% 命中），wzDecision 是**LLM 判定**（秒级、可能超时），两者可信度不同，画在同一块会让用户误判哪份是"权威"。

---

**部署完成时间**：2026-09-23 23:00 前后  
**改动文件数**：8 个（1 新增 + 7 修改）  
**净增代码行**：约 400 行（含 WzDecisionWidget 330 行 + 各处接线 70 行）  
**新增依赖**：无（全部走现有组件/UI 库）
