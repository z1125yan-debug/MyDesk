# P19-② · AI 交易员页接入 LLM 意图分类器

**日期**：2026-09-23  
**上游**：P19-①（决策 widget UI）、P17-①（LLM 意图识别器）  
**范围**：把 `/api/ai/chat`（tools 端点，AI 交易员页）也接上 LLM 意图分类器，让决策卡三个入口统一出现

## 1. 为什么这一步必要

P19-① 让**助手页**和**右下角小窗**能拿到决策卡（都走 `/api/ai/proxy`）。但**AI 交易员页**（走 `/api/ai/chat`）拿不到——两个端点各自实现了一套场景识别，之前只在 `/api/ai/proxy` 那边接了 LLM 分类器。

结果：用户在不同页问同一句"中国电影短线怎么看"，一个页有决策卡、一个页没有。体验割裂。

## 2. 本轮改动

### 2.1 抽共享分类器（单一出处）

P17-① 时代把分类器的网络调用逻辑写在 `/api/ai/proxy` route 里，是内联实现。这次抽出为独立模块：

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/lib/desk/intent-llm-fetch.ts` | **新增** | 分类器网络层：`runWzIntentClassifier` 函数、`WZ_CLASSIFIER_TIMEOUT_MS` 常量、`WzClassifierArgs/Result` 类型 |

分工纪律（在文件头写死）：

```
intent-llm-core.ts = 纯核（prompt 模板、JSON 解析、决策块渲染）
intent-llm-fetch.ts = 网络调用层（undici fetch + 6s 超时 + 静默降级）
```

### 2.2 `/api/ai/proxy` 切到共享分类器

- 删除 route 里内联的 `runWzIntentClassifier` 定义（-64 行）
- 改用共享模块的 import
- 调用参数去掉 `mode`（分类器不需要 mode，只是历史参数）

### 2.3 `/api/ai/chat` 接入分类器

- 引入 `runWzIntentClassifier`
- 在 `buildMessages` 之前跑分类器，生成 `wzBlock`（中文提示词块）
- 新增 `baseMessagesWithWz` 和 `buildMessagesWz`（把决策块放进 system 消息序列）
- 非流式 JSON 返回、流式 SSE done 事件都带上 `wzDecision`

**启用条件**：AI 交易员页永远是对话轮（不像 `/api/ai/proxy` 还要区分是否带 scene），所以这里直接 `enabled: true`。

### 2.4 更新既有测试正则

`p8-mode-anywhere.test.ts` 用正则匹配 `route.ts` 的 withSceneRaw 拼装式，加了 `...wzNote` 后需要同步正则。

## 3. 三个入口的决策卡覆盖矩阵

| 入口 | 端点 | 决策卡来源 | 备注 |
|---|---|---|---|
| 助手页 | `/api/ai/proxy`（endpoint=auto） | P17-① + P19-① + P19-② | ✅ |
| 右下角小窗 | `/api/ai/proxy`（endpoint=auto） | 同上 | ✅ |
| AI 交易员页 | `/api/ai/chat`（endpoint=tools） | P19-② | ✅ |

三个入口用同一份分类器函数、同一份 prompt、同一份解析——**用户在不同页问同一句，看到的决策信号必须一致**。

## 4. 关键设计

### 4.1 为什么放在 `/api/ai/chat` 的 buildMessages 之前

`buildMessages` 是最终拼给模型的数组（含场景提示词 + 预取数据）。决策信号块是"参考口径"，需要跟场景提示词并列，让模型一眼看到。放在 `baseMessages` 阶段拼进去：

```
baseMessages = [system_prompt, ...history]
baseMessagesWithWz = [system_prompt, wzBlock, ...history]
buildMessagesWz(turn) = injectSceneContext(baseMessagesWithWz, turn, ...)
```

### 4.2 为什么 AI 交易员页直接 enabled=true

`/api/ai/proxy` 有多个调用方（研究页、事件理解、自检），只对话轮才接分类器（`enabled: !!body?.scene`）。
`/api/ai/chat` 只有一个调用方（AI 交易员页），永远是对话轮——直接 `enabled: true`。

### 4.3 静默降级三路径（保持不变）

- 6 秒超时 → 空
- LLM 返回非 200 / 空 content / 坏 JSON → 空
- 客户端断开 → 立即取消

任何环节失败都不阻塞主回答。工具调用环照常跑，只是少一个决策卡。

## 5. 边界

### 5.1 `/api/ai/chat` 的既有网关闸门

`/api/ai/chat` 要求 OpenAI 兼容的 tools 能力（function call），本地 Bifrost 网关不支持。所以在当前环境（Bifrost + Groq）下，AI 交易员页会**在前置校验阶段直接返回错误**——连不到分类器，也拿不到 wzDecision。

这不是本轮 bug，是既有约束。要真正在 AI 交易员页看到决策卡，需要：

1. 配置一条支持 tools 的 OpenAI 兼容上游（如 OpenRouter、官方 API），或
2. 走浏览器侧凭据（设置页填写），或
3. 未来把文本协议工具环（R14）从 `/api/ai/proxy` 复用到 `/api/ai/chat`（P17 遗留项）

### 5.2 分类器耗时

6 秒超时是**上限**，正常情况 2-4 秒返回。这 2-4 秒与主工具调用环并行不冲突：分类器跑在 `buildMessages` 之前，跑完才交给工具环。

**注意**：AI 交易员页因为多了这 2-4 秒，整体响应会比改造前慢 2-4 秒。这个代价换取的是决策卡一致性——如果用户在意速度，可以后续加个开关。

## 6. 测试与验证

| 检查项 | 结果 |
|---|---|
| TSC 类型检查 | `npx tsc --noEmit` **0 error** |
| **新增 P19-② 单测** `p19-wz-classifier-fetch.test.ts` | 5/5 全绿（enabled=false 短路 / 空 user 短路 / signal aborted 短路 / 网络失败降级 / 超时常量） |
| P8 全量回归 | **1136/1136 全绿**（9 skipped 为既有 skip） |
| 端到端 `/api/ai/proxy` | ✅ 返回完整 wzDecision（stance=neutral, sentimentTemp=50, signalType=no_signal） |
| 端到端 `/api/ai/chat` | ❌ 前置闸门拦截（本地网关不支持 tools 能力，既有约束） |

## 7. 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/lib/desk/intent-llm-fetch.ts` | **新增** | 共享分类器网络层（140 行） |
| `src/app/api/ai/proxy/route.ts` | 修改 | 删除内联分类器（-64 行），改用共享 import |
| `src/app/api/ai/chat/route.ts` | 修改 | 接入共享分类器 + 注入决策块 + done/JSON 带回 wzDecision |
| `tests/quant/p19-wz-classifier-fetch.test.ts` | **新增** | 5 条短路/降级单测 |
| `tests/quant/p8-mode-anywhere.test.ts` | 修改 | 正则同步更新（`...wzNote` 加了） |

## 8. 遗留

- `/api/ai/chat` 在本地网关（Bifrost）下仍不可用——需要真实 OpenAI 兼容上游
- 分类器 2-4 秒延迟未做开关（AI 交易员页整体响应变慢）
- 决策卡与场景徽章（intent）仍并列展示（P19-① 遗留）
