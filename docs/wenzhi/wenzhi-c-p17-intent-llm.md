# 稳智对齐 · P17-① 意图识别器 LLM 引擎

**日期**：2026-09-23
**目标**：LLM 驱动的分类与决策信号抽取（对齐稳智 AI 决策 widget）
**状态**：✅ 已上线，28/28 单测通过，端到端实测通过

---

## 一、架构：双引擎分工

```
用户提问
  │
  ├─ intent-core.ts (规则引擎)  ── 关键词+代码形状，3ms 判 scene+symbol
  │                                  8 场景（sentiment/sector/screener/...）
  │
  └─ intent-llm-core.ts (LLM 引擎，本次新增)
                                12 秒内跑一次分类器，产出 11 字段决策信号
                                注入 system 提示词作为"参考口径"，模型最终仍自由发挥
```

**关键设计**：
- 规则引擎 3ms 完成，主链路照旧；LLM 分类器 6 秒超时静默降级
- 稳智的 5 档周期 → Kairo 3 档周期做映射（`wzHorizonToKairoH`），兼容现有 horizon 提示词层
- LLM 判 general 场景时规则引擎不抢，让 LLM 出来的 signalType/stance 作为参考

## 二、新增文件

| 文件 | 用途 |
|---|---|
| `src/lib/desk/intent-llm-core.ts` | 纯函数核：5 档周期、12 类信号、11 字段决策信号、LLM 输出解析器、提示词渲染器 |
| `tests/quant/p17-wz-intent-llm.test.ts` | 28 条单元测试，覆盖解析、渲染、映射、边界 |

## 三、修改文件

| 文件 | 修改 |
|---|---|
| `src/app/api/ai/proxy/route.ts` | 引入 `WZ_INTENT_PROMPT` + `parseWzDecisionLlmOutput` + `renderWzDecisionBlock`；新增 `runWzIntentClassifier` 函数；`withSceneRaw` 注入决策信号块 |

## 四、决策信号 11 字段（对齐稳智 widget）

| 字段 | 类型 | 说明 |
|---|---|---|
| `stance` | long/short/wait/neutral | 结论倾向 |
| `horizon` | 5 档周期 | 超短/短/短中/中/长 |
| `signalType` | 12 类信号 | 趋势突破/回调反弹/放量启动/背离风险/... |
| `confidence` | 0-100 | 置信度 |
| `sentimentTemp` | 0-100 | 情绪温度（大盘场景才填） |
| `keyLevels.support` | number[] | 支撑位 |
| `keyLevels.resistance` | number[] | 阻力位 |
| `stopPlan.stopLoss` | number \| null | 止损 |
| `stopPlan.takeProfit` | number \| null | 止盈 |
| `positionPct` | 0-100 | 建议仓位 |
| `invalidation` | string | 失效条件 |
| `riskNotes` | string[] | 风险提示（≤5 条） |
| `dataGaps` | string[] | 未取到数据维度（≤5 条） |

## 五、实测结果

### 8 个分类用例（Qwen3.8-27B 直接分类）

| 提问 | scene | horizon | signalType | stance | conf |
|---|---|---|---|---|---|
| 今天大盘情绪怎么样，能不能抄底？ | sentiment | ultra_short | no_signal | wait | 60 |
| 600519 现在适合买吗？短线怎么操作？ | stock_analysis | short | no_signal | wait | 60 |
| 帮我找成交额大于 5 亿、站上 20 日线的股票 | screener | - | trend_breakout | long | 85 |
| 我的自选股今天表现如何 | watchlist | ultra_short | no_signal | neutral | 90 |
| 中国电影卖的怎么样 | quote | - | no_signal | neutral | - |
| 现在什么板块领涨，有资金流入吗 | sector | ultra_short | capital_inflow | neutral | 85 |
| 帮我分析下贵州茅台的趋势 | stock_analysis | mid | no_signal | neutral | - |

**全部识别正确**，包括 "中国电影" 自动匹配到 `600977.SH`。

### 端到端对话（带决策信号块注入）

**提问**：今天大盘情绪怎么样，能不能抄底？
**返回**（1256 字符）：
> **结论：不建议现在抄底，建议观望。**
> 当前市场处于「中性偏弱、局部过热」的震荡环境...
> 情绪温度 **48.8/100**，判定为「中性」的震荡行情
> 失效条件：跌破 3800 减仓

决策信号块的 5 项都在正文里体现：**情绪温度、立场、失效条件、风险提示、数据缺口**。

**耗时**：6.1 秒（LLM 分类 3-4s + 主回答 2-3s）

## 六、边界纪律

- **静默降级**：LLM 分类器超时/失败不阻塞主回答
- **JSON 解析容错**：剥 markdown code block、单字段失败不影响其他
- **数值 clamp**：0-100 越界自动收敛
- **字符串截断**：invalidation 200 字、riskNotes 100 字、dataGaps 60 字、reason 100 字
- **不猜**：LLM 不填的字段一律 null，不写"未提供"这种废话
- **用户显式选择优先**：horizon 手选了就不用 LLM 的

## 七、遗留（P1 项，非本轮）

- **决策 widget UI**：把 11 字段渲染成卡（Markdown 9 类 emoji 卡片化已完成，但决策 widget 是独立组件）
- **前端 intent 字段回传**：目前 LLM 分类结果只注入到提示词，没回传到前端 `intent` 字段供 UI 消费
- **6 阶段 StepTimeline**：Agent Loop 6 阶段（intent/skills/local_data/external_data/research/answer）
- **错误码映射**：稳智错误类型 → 友好文案
- **侧栏会话历史**：稳智的会话列表

## 八、参考

- 稳智决策 widget 11 字段来源：`wenzhi-deep-comparison.md` §决策信号
- 现有规则引擎：`src/lib/desk/intent-core.ts`
- Kairo 后端接入点：`src/app/api/ai/proxy/route.ts`（runWzIntentClassifier）
